import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Background, ReactFlow, ReactFlowProvider, SelectionMode, applyEdgeChanges, applyNodeChanges, useReactFlow, useStore,
  type Connection, type EdgeChange, type NodeChange,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { CheckReport, Graph, Issue, NodeType } from '../api/types'
import { CanvasToolbar, type Tool } from '../components/editor/CanvasToolbar'
import { Inspector } from '../components/editor/Inspector'
import { DRAG_TYPE, NodePalette } from '../components/editor/NodePalette'
import { QuickAdd } from '../components/editor/QuickAdd'
import { ShortcutsDialog } from '../components/editor/ShortcutsDialog'
import { kfNodeTypes } from '../components/KfNode'
import { CheckControl } from '../components/editor/CheckControl'
import { SaveGuard } from '../components/editor/SaveGuard'
import { WarehousePopover, type WarehouseSkuRow } from '../components/WarehousePopover'
import { HeaderActions, useShell } from '../components/shell/ShellContext'
import { useGraphCheck } from '../hooks/useGraphCheck'
import { useTheme } from '../hooks/useTheme'
import { ErrorBox, Loading, btnOk, btnPrimary, issuesOf } from '../components/ui'
import { groupIssues, mergeServerIssues, nodeSummary, toneOf } from '../lib/checkView'
import { canConnect } from '../lib/connect'
import { formToEdge, type EdgeForm } from '../lib/edgeForm'
import { versionStatusLabel } from '../lib/format'
import { clipboard, copyOf, pasteOf } from '../lib/clipboard'
import { defaultMaterial, edgeKey, edgeLabel, fromFlow, isEdit, makeNode, toFlow, type FlowEdge, type FlowNode } from '../lib/graph'
import { canRedo, canUndo, emptyHistory, record, redo, undo, type History } from '../lib/history'
import { autoLayout, type Dir } from '../lib/layout'
import { byCode, thresholdsFor } from '../lib/model'
import { isTypingTarget } from '../lib/playback'
import { shortcutFor } from '../lib/shortcuts'

/** Trạng thái để hoàn tác: vị trí và nội dung mọi node/edge, cùng hướng sơ đồ. */
type Snap = { nodes: FlowNode[]; edges: FlowEdge[]; dir: Dir }

export default function EditorPage() {
  const vid = Number(useParams().id)
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  const mats = useQuery({ queryKey: ['materials'], queryFn: api.materials })
  const graph = useQuery({ queryKey: ['graph', vid], queryFn: () => api.graph(vid) })
  if (graph.error) return <div className="p-6"><ErrorBox error={graph.error} /></div>
  if (!graph.data || !types.data || !mats.data) return <Loading />
  return (
    <ReactFlowProvider>
      <Editor key={`${vid}-${graph.data.status}`} graph={graph.data} typeList={types.data} materials={mats.data.map((m) => m.code)} />
    </ReactFlowProvider>
  )
}

function Editor({ graph, typeList, materials }: { graph: Graph; typeList: NodeType[]; materials: string[] }) {
  const types = useMemo(() => byCode(typeList), [typeList])
  const initial = useMemo(() => toFlow(graph, types), [graph, types])
  const [nodes, setNodes] = useState<FlowNode[]>(initial.nodes)
  const [edges, setEdges] = useState<FlowEdge[]>(initial.edges)
  const [issues, setIssues] = useState<Issue[]>([])
  const [dirty, setDirty] = useState(false)
  const [dir, setDir] = useState<Dir>(initial.nodes[0]?.data.dir ?? 'LR')
  const [history, setHistory] = useState<History<Snap>>(emptyHistory)
  const [tool, setTool] = useState<Tool>('select')
  const [locked, setLocked] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(initial.nodes.length === 0)
  const [quick, setQuick] = useState<{ x: number; y: number; client: { x: number; y: number }; from?: { nodeId: string; type: 'source' | 'target' } } | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const mouse = useRef({ x: 0, y: 0 })
  const published = graph.status !== 'DRAFT'
  const readOnly = published || locked
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { screenToFlowPosition, fitView, zoomIn, zoomOut, zoomTo } = useReactFlow()
  const zoom = useStore((s) => s.transform[2])
  const { focus, setFocus } = useShell()
  const { theme } = useTheme()

  // Bản mới nhất của trạng thái, cho các hàm xử lý sự kiện gọi ngay trước khi React kịp vẽ lại.
  const live = useRef<Snap>({ nodes, edges, dir })
  live.current = { nodes, edges, dir }
  /** Ghi trạng thái hiện tại vào lịch sử, gọi ngay trước mỗi thao tác sửa. `key` gộp các lần sửa liền nhau của cùng một thứ. */
  const remember = (key?: string) => { if (!readOnly) setHistory((h) => record(h, live.current, { key })) }
  const restore = (s: Snap) => { setNodes(s.nodes); setEdges(s.edges); setDir(s.dir); setDirty(true) }
  const undoStep = () => { const r = undo(history, live.current); if (r && !readOnly) { setHistory(r.history); restore(r.state) } }
  const redoStep = () => { const r = redo(history, live.current); if (r && !readOnly) { setHistory(r.history); restore(r.state) } }

  const selNodes = nodes.filter((n) => n.selected)
  const selEdges = edges.filter((e) => e.selected)
  const selNode = selNodes.length === 1 ? selNodes[0] : undefined
  const selEdge = selNodes.length === 0 && selEdges.length === 1 ? selEdges[0] : undefined
  const hasSelection = selNodes.length + selEdges.length > 0
  const inspectorOpen = hasSelection && !focus
  const padding = () => ({ top: '24px', bottom: '84px', right: inspectorOpen ? '344px' : '24px', left: paletteOpen && !focus ? '252px' : '24px' }) as const
  const refit = () => requestAnimationFrame(() => void fitView({ padding: padding(), duration: 300 }))

  const [popover, setPopover] = useState<{ nodeId: string; x: number; y: number } | null>(null)
  const popoverNode = popover ? nodes.find((n) => n.id === popover.nodeId) : undefined
  const popoverRows = useMemo<WarehouseSkuRow[]>(() => {
    if (!popoverNode) return []
    const stock = (popoverNode.data.params?.stock ?? []) as unknown[]
    const out: WarehouseSkuRow[] = []
    for (const x of stock) {
      if (x && typeof x === 'object') {
        const o = x as { material?: unknown; initial?: unknown; max?: unknown }
        const sku = typeof o.material === 'string' ? o.material : ''
        const initial = typeof o.initial === 'number' ? o.initial : Number(o.initial) || 0
        const max = typeof o.max === 'number' ? o.max : Number(o.max) || 0
        if (sku) {
          out.push({
            sku,
            current: initial,
            max,
            thresholds: thresholdsFor({ node_type: popoverNode.data.nodeType, params: popoverNode.data.params }, types),
          })
        }
      }
    }
    return out
  }, [popoverNode, types])
  const onNodeClick = (_e: ReactMouseEvent, node: FlowNode) => {
    if (node.data.archetype !== 'STORAGE') { setPopover(null); return }
    const r = wrap.current?.getBoundingClientRect()
    setPopover({
      nodeId: node.id,
      x: _e.clientX - (r?.left ?? 0) + 12,
      y: _e.clientY - (r?.top ?? 0),
    })
  }

  const onNodesChange = useCallback((c: NodeChange<FlowNode>[]) => {
    setNodes((ns) => applyNodeChanges(c, ns))
    if (!readOnly && c.some(isEdit)) setDirty(true)
  }, [readOnly])
  const onEdgesChange = useCallback((c: EdgeChange<FlowEdge>[]) => {
    setEdges((es) => applyEdgeChanges(c, es))
    if (!readOnly && c.some(isEdit)) setDirty(true)
  }, [readOnly])
  // Một dòng báo ngắn cạnh thanh công cụ khi một thao tác bị từ chối (vd. nối node với chính nó), để không im lặng không làm gì.
  const [note, setNote] = useState<string | null>(null)
  const noteTimer = useRef<number>(undefined)
  const flash = (m: string) => {
    setNote(m)
    window.clearTimeout(noteTimer.current)
    noteTimer.current = window.setTimeout(() => setNote(null), 4000)
  }
  useEffect(() => () => window.clearTimeout(noteTimer.current), [])
  const archetypeOf = useCallback((id: string) => nodes.find((n) => n.id === id)?.data.archetype, [nodes])
  const onConnect = useCallback((c: Connection) => {
    const verdict = canConnect(c, archetypeOf)
    if (!verdict.ok) { flash(verdict.reason); return }
    const src = nodes.find((n) => n.id === c.source)
    const dst = nodes.find((n) => n.id === c.target)
    if (!src || !dst) return
    remember()
    // Cặp node này đã có đường nối chở vật tư nào thì điền sẵn vật tư khác, để không tự tạo ra đường nối trùng.
    const avoid = edges.filter((e) => e.source === c.source && e.target === c.target).map((e) => e.data?.material ?? '')
    const material = defaultMaterial(src, materials, types, avoid)
    setEdges((es) => [...es, {
      id: edgeKey(c.source, c.target, es.map((e) => e.id)), source: c.source, target: c.target,
      data: { material, params: {} }, label: edgeLabel(material, {}),
    }])
    setDirty(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, materials, types, readOnly, archetypeOf])

  const deselectAll = () => {
    setNodes((ns) => (ns.some((n) => n.selected) ? ns.map((n) => ({ ...n, selected: false })) : ns))
    setEdges((es) => (es.some((e) => e.selected) ? es.map((e) => ({ ...e, selected: false })) : es))
  }
  /** Thêm một node; `from` là chấm đã kéo dây ra chỗ trống, thì nối luôn node mới vào đó theo đúng chiều. */
  const addNode = (t: NodeType, position: { x: number; y: number }, from?: { nodeId: string; type: 'source' | 'target' }) => {
    if (readOnly) return
    remember()
    const n = makeNode(t, live.current.nodes.map((x) => x.id), position)
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), { ...n, selected: true }])
    setEdges((es) => {
      const cleared = es.map((e) => ({ ...e, selected: false }))
      if (!from) return cleared
      const [src, dst] = from.type === 'source' ? [from.nodeId, n.id] : [n.id, from.nodeId]
      const srcNode = src === n.id ? n : live.current.nodes.find((x) => x.id === src)
      const material = defaultMaterial(srcNode, materials, types)
      return [...cleared, { id: edgeKey(src, dst, es.map((e) => e.id)), source: src, target: dst, data: { material, params: {} }, label: edgeLabel(material, {}) }]
    })
    setDirty(true)
  }
  /** Góc trên-trái để đặt một node sao cho tâm nằm ở điểm cho trước (kích thước thẻ node ~140 x 64). */
  const centred = (p: { x: number; y: number }) => ({ x: p.x - 70, y: p.y - 32 })
  /** Giữa khung nhìn hiện tại, dịch dần nếu đã có node nằm đúng chỗ đó để các lần thêm liên tiếp không chồng lên nhau. */
  const viewCentre = () => {
    const r = wrap.current?.getBoundingClientRect()
    let p = centred(screenToFlowPosition({ x: (r?.left ?? 0) + (r?.width ?? 800) / 2, y: (r?.top ?? 0) + (r?.height ?? 600) / 2 }))
    while (live.current.nodes.some((n) => Math.abs(n.position.x - p.x) < 24 && Math.abs(n.position.y - p.y) < 24)) p = { x: p.x + 32, y: p.y + 32 }
    return p
  }
  const openQuick = (client: { x: number; y: number }, from?: { nodeId: string; type: 'source' | 'target' }) => {
    if (readOnly) return
    const r = wrap.current?.getBoundingClientRect()
    setQuick({ x: client.x - (r?.left ?? 0), y: client.y - (r?.top ?? 0), client, from })
  }
  const pickQuick = (t: NodeType) => {
    if (!quick) return
    addNode(t, centred(screenToFlowPosition(quick.client)), quick.from)
    setQuick(null)
  }
  // Loại nào hợp lệ để đặt vào chỗ vừa thả dây: đích không thể là nguồn hay đội xe; nguồn không thể là đích hay đội xe.
  const quickAllow = useMemo(() => {
    const no = quick?.from?.type === 'target' ? ['SINK', 'RESOURCE_POOL'] : quick?.from ? ['SOURCE', 'RESOURCE_POOL'] : []
    return (t: NodeType) => !no.includes(t.archetype)
  }, [quick?.from])
  const onDrop = (ev: DragEvent) => {
    ev.preventDefault()
    const t = types[ev.dataTransfer.getData(DRAG_TYPE)]
    if (!t || readOnly) return
    addNode(t, centred(screenToFlowPosition({ x: ev.clientX, y: ev.clientY })))
  }

  const deleteSelected = () => {
    if (readOnly || !hasSelection) return
    remember()
    const gone = new Set(selNodes.map((n) => n.id))
    setNodes((ns) => ns.filter((n) => !gone.has(n.id)))
    setEdges((es) => es.filter((e) => !e.selected && !gone.has(e.source) && !gone.has(e.target)))
    setDirty(true)
  }
  const copySelected = () => {
    const c = copyOf(nodes, edges)
    if (!c) return
    clipboard.clip = c
    clipboard.pastes = 0
  }
  const pasteClip = (clip: NonNullable<typeof clipboard.clip>, offset: number) => {
    if (readOnly) return
    remember()
    const out = pasteOf(clip, { nodeKeys: nodes.map((n) => n.id), edgeKeys: edges.map((e) => e.id), offset })
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), ...out.nodes])
    setEdges((es) => [...es.map((e) => ({ ...e, selected: false })), ...out.edges])
    setDirty(true)
  }
  const paste = () => { if (clipboard.clip) pasteClip(clipboard.clip, 40 * ++clipboard.pastes) }
  const duplicate = () => { const c = copyOf(nodes, edges); if (c) pasteClip(c, 40) }

  // Kiểm tra trên server sau mỗi lần sửa (vị trí node không tính, để kéo thả không gọi lại).
  const checkBody = useMemo(() => {
    const b = fromFlow(nodes, edges)
    return { nodes: b.nodes.map(({ canvas_pos: _pos, ...n }) => n), edges: b.edges }
  }, [nodes, edges])
  const check = useGraphCheck(graph.version_id, checkBody)
  // Lỗi server trả khi Lưu/Publish thất bại hiện cùng báo cáo; báo cáo mới thì thay chúng.
  useEffect(() => { setIssues([]) }, [check.report])
  const view = useMemo(() => mergeServerIssues(check.report, issues), [check.report, issues])

  const decorated = useMemo(() => nodes.map((n) => {
    const issue = nodeSummary(n.id, view)
    const issueTone = toneOf(n.id, view)
    const issueTitle = view?.issues.find((i) => i.key === n.id)?.message
    return issue === n.data.issue && issueTone === n.data.issueTone && dir === n.data.dir ? n : { ...n, data: { ...n.data, issue, issueTone, issueTitle, dir } }
  }), [nodes, view, dir])
  const decoratedEdges = useMemo(() => edges.map((e) => {
    const tone = toneOf(e.id, view)
    return { ...e, style: tone ? { stroke: tone === 'error' ? 'var(--color-bad)' : 'var(--color-warn)', strokeWidth: 2 } : undefined }
  }), [edges, view])

  /** Chọn một node hoặc đường nối theo khoá và đưa vào giữa khung nhìn (bấm một dòng trong panel Kiểm tra). */
  const focusKey = (key: string) => {
    const isNode = nodes.some((n) => n.id === key)
    const edge = edges.find((e) => e.id === key)
    if (!isNode && !edge) return
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === key })))
    setEdges((es) => es.map((e) => ({ ...e, selected: e.id === key })))
    const ids = isNode ? [key] : [edge!.source, edge!.target]
    requestAnimationFrame(() => void fitView({ nodes: ids.map((id) => ({ id })), padding: padding(), duration: 300, maxZoom: 1.2 }))
  }

  const arrange = (d: Dir) => {
    if (readOnly || nodes.length === 0) return
    remember()
    const pos = autoLayout(
      nodes.map((n) => ({ id: n.id, w: n.measured?.width ?? 160, h: n.measured?.height ?? 72, pool: n.data.archetype === 'RESOURCE_POOL' })),
      edges.map((e) => ({ source: e.source, target: e.target })),
      d,
    )
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos[n.id] ?? n.position })))
    setDir(d)
    setDirty(true)
    refit()
  }

  const body = () => fromFlow(nodes, edges)
  const done = () => {
    setIssues([]); setDirty(false)
    void qc.invalidateQueries({ queryKey: ['graph', graph.version_id] })
    void qc.invalidateQueries({ queryKey: ['models'] })
  }
  const save = useMutation({ mutationFn: () => api.saveGraph(graph.version_id, body()), onSuccess: done, onError: (e) => setIssues(issuesOf(e)) })
  const publish = useMutation({
    mutationFn: async () => { await api.saveGraph(graph.version_id, body()); return api.publish(graph.version_id) },
    onSuccess: done, onError: (e) => setIssues(issuesOf(e)),
  })
  // Lưu và Publish đều kiểm tra sâu trước. Có lỗi: Lưu cho "Vẫn lưu nháp", Publish chặn cứng.
  const [guard, setGuard] = useState<{ report: CheckReport; mode: 'save' | 'publish' } | null>(null)
  const [gating, setGating] = useState(false)
  const guarded = async (mode: 'save' | 'publish') => {
    setGating(true)
    try {
      const r = await check.run(true)
      if (groupIssues(r).errors.length > 0) { setGuard({ report: r, mode }); return }
    } catch {
      // Không kiểm tra được (mất kết nối, server lỗi): để chính thao tác lưu báo lỗi nếu có.
    } finally {
      setGating(false)
    }
    if (mode === 'save') save.mutate(); else publish.mutate()
  }
  const clone = useMutation({ mutationFn: () => api.clone(graph.version_id), onSuccess: (r) => navigate(`/versions/${r.version_id}`) })

  const setNodeData = (id: string, patch: Partial<FlowNode['data']>) => {
    if (readOnly) return
    const cur = nodes.find((n) => n.id === id)
    const keys = Object.keys(patch) as (keyof FlowNode['data'])[]
    // @rjsf gọi onChange ngay khi mount với đúng dữ liệu cũ: không tính là chỉnh sửa
    if (cur && keys.every((k) => JSON.stringify(cur.data[k]) === JSON.stringify(patch[k]))) return
    remember(`node:${id}`)
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)))
    setDirty(true)
  }
  const setEdgeForm = (id: string, form: EdgeForm) => {
    if (readOnly) return
    const cur = edges.find((e) => e.id === id)
    if (cur && JSON.stringify(formToEdge(form, cur.data?.params ?? {})) === JSON.stringify(cur.data)) return
    remember(`edge:${id}`)
    setEdges((es) => es.map((e) => {
      if (e.id !== id) return e
      const next = formToEdge(form, e.data?.params ?? {})
      return { ...e, data: next, label: edgeLabel(next.material, next.params) }
    }))
    setDirty(true)
  }

  // Phím tắt: một trình nghe duy nhất, luôn gọi bản mới nhất của các hàm.
  const keys = useRef<Record<string, () => void>>({})
  keys.current = {
    undo: undoStep, redo: redoStep, copy: copySelected, paste, duplicate,
    selectAll: () => setNodes((ns) => ns.map((n) => ({ ...n, selected: true }))),
    save: () => { if (!published && dirty && !save.isPending && !gating) void guarded('save') },
    toolSelect: () => setTool('select'), toolHand: () => setTool('hand'),
    focus: () => setFocus((f) => !f), help: () => setHelpOpen(true),
    escape: () => { if (focus) setFocus(false); else deselectAll() },
    fit: () => void fitView({ padding: padding(), duration: 300 }),
    zoom100: () => void zoomTo(1, { duration: 200 }),
    fitSelection: () => { if (selNodes.length) void fitView({ nodes: selNodes, padding: padding(), duration: 300, maxZoom: 1.2 }) },
    add: () => {
      const r = wrap.current?.getBoundingClientRect()
      const m = mouse.current
      openQuick(m.x ? m : { x: (r?.left ?? 0) + (r?.width ?? 800) / 2, y: (r?.top ?? 0) + (r?.height ?? 600) / 3 })
    },
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null
      if (isTypingTarget(el) || el?.closest('[role=dialog], [role=menu]')) return
      const action = shortcutFor(e)
      if (!action) return
      // Tab chỉ mở ô thêm node khi đang đứng trên canvas; ở chỗ khác Tab vẫn để chuyển tiêu điểm như thường.
      if (action === 'add' && e.key === 'Tab' && el !== document.body && !el?.closest('.react-flow__pane, .react-flow__viewport')) return
      // Đang bôi đen chữ trên trang thì Ctrl+C là sao chép chữ.
      if (action === 'copy' && window.getSelection()?.toString()) return
      e.preventDefault()
      keys.current[action]?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // Rời trang khi còn thay đổi chưa lưu thì trình duyệt hỏi lại.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const error = save.error ?? publish.error

  return (
    <div
      ref={wrap} className="relative h-full min-h-[480px]"
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }} onDrop={onDrop}
      onMouseMove={(e) => { mouse.current = { x: e.clientX, y: e.clientY } }}
      onDoubleClick={(e) => { if ((e.target as HTMLElement).classList.contains('react-flow__pane')) openQuick({ x: e.clientX, y: e.clientY }) }}
    >
      <HeaderActions>
        <span className="text-[11px] text-muted">{versionStatusLabel(graph.status)}{dirty ? ', chưa lưu' : ''}</span>
        <CheckControl report={view} checking={check.checking} onRun={() => void check.run(true).catch(() => undefined)} onSelect={focusKey} />
        {published ? (
          <button className={btnPrimary} disabled={clone.isPending} onClick={() => clone.mutate()} title="Bản đã Publish không sửa được. Tạo bản sửa để có một bản nháp mới sao từ bản này.">Tạo bản sửa (v{graph.version + 1})</button>
        ) : (
          <>
            <button className={btnPrimary} disabled={save.isPending || gating} onClick={() => void guarded('save')} title="Lưu thay đổi vào bản nháp (Ctrl/⌘ S). Chưa khoá phiên bản.">Lưu</button>
            <button className={btnOk} disabled={publish.isPending || gating} onClick={() => void guarded('publish')} title="Lưu rồi khoá phiên bản này để chạy mô phỏng. Muốn sửa tiếp thì tạo bản sửa mới.">Publish</button>
          </>
        )}
      </HeaderActions>

      <ReactFlow
        nodes={decorated} edges={decoratedEdges} nodeTypes={kfNodeTypes} colorMode={theme}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={readOnly ? undefined : onConnect} isValidConnection={(c) => canConnect(c, archetypeOf).ok}
        onNodeDragStart={() => remember()} onSelectionDragStart={() => remember()}
        onConnectEnd={(ev, state) => {
          // Thả dây lên một cổng không nối được: nói lý do thay vì im lặng.
          if (state.isValid === false && state.fromNode && state.toNode) {
            const v = canConnect({ source: state.fromNode.id, target: state.toNode.id }, archetypeOf)
            if (!v.ok) flash(v.reason)
            return
          }
          // Thả dây ra chỗ trống (không trúng node nào): mở ô tìm loại node, chọn xong tự nối.
          if (state.isValid || state.toNode || !state.fromNode || !state.fromHandle) return
          const pt = 'changedTouches' in ev ? ev.changedTouches[0] : ev
          openQuick({ x: pt.clientX, y: pt.clientY }, { nodeId: state.fromNode.id, type: state.fromHandle.type })
        }}
        onBeforeDelete={async () => { remember(); return true }}
        onNodeClick={onNodeClick}
        onPaneClick={() => setPopover(null)}
        nodesDraggable={!readOnly} nodesConnectable={!readOnly}
        selectionOnDrag={tool === 'select'} panOnDrag={tool === 'hand' ? true : [1]} selectionMode={SelectionMode.Partial}
        panActivationKeyCode="Space" multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']} zoomOnDoubleClick={false}
        fitView fitViewOptions={{ padding: padding() }}
      >
        <Background gap={18} size={1} color="var(--color-line)" />
      </ReactFlow>

      {popover && popoverNode && (
        <WarehousePopover
          open
          onOpenChange={(o) => { if (!o) setPopover(null) }}
          anchorX={popover.x}
          anchorY={popover.y}
          title={`${popoverNode.data.name} (${popoverNode.data.key})`}
          rows={popoverRows}
          container={wrap.current}
        />
      )}

      {!focus && (
        <CanvasToolbar
          tool={tool} onTool={setTool}
          zoom={zoom} onZoomBy={(d) => void (d > 0 ? zoomIn({ duration: 150 }) : zoomOut({ duration: 150 }))} onZoomTo={(z) => void zoomTo(z, { duration: 200 })}
          onFit={() => keys.current.fit()} onFitSelection={() => keys.current.fitSelection()} hasSelection={selNodes.length > 0}
          published={published} locked={locked} onLock={() => setLocked((l) => !l)}
          canEdit={!readOnly} onArrange={arrange}
          canUndo={!readOnly && canUndo(history)} canRedo={!readOnly && canRedo(history)} onUndo={undoStep} onRedo={redoStep}
          onAdd={() => setPaletteOpen((o) => !o)} onHelp={() => setHelpOpen(true)}
        />
      )}
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />

      {error && <div className="absolute left-1/2 top-3 z-20 w-[420px] -translate-x-1/2"><ErrorBox error={error} /></div>}
      {note && <div role="status" className="absolute bottom-16 left-1/2 z-20 max-w-[460px] -translate-x-1/2 rounded-lg border border-lock-line bg-lock-bg px-3 py-2 text-xs text-lock-text shadow-lg">{note}</div>}
      {guard && <SaveGuard report={guard.report} mode={guard.mode} onBack={() => setGuard(null)} onSaveAnyway={() => { setGuard(null); save.mutate() }} />}

      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center">
          <div className="max-w-xs text-center text-xs leading-relaxed text-muted">
            <p className="text-sm font-semibold text-text-2">Sơ đồ đang trống</p>
            <p className="mt-1">{published ? 'Phiên bản này chưa có node nào.' : 'Kéo một loại node từ danh sách bên trái vào đây, hoặc bấm đúp vào chỗ trống, hoặc nhấn Tab để tìm. Rồi nối các node bằng chấm đầu ra và chấm đầu vào.'}</p>
          </div>
        </div>
      )}
      {!focus && paletteOpen && (
        <NodePalette
          types={typeList} canEdit={!readOnly} published={published} onClose={() => setPaletteOpen(false)}
          onAdd={(t) => addNode(t, viewCentre())}
        />
      )}

      {!focus && (selNode || selEdge || selNodes.length + selEdges.length > 1) && (
        <Inspector
          node={selNode} edge={selEdge} selNodes={selNodes} selEdgeCount={selEdges.length}
          nodes={nodes} types={types} materials={materials} canEdit={!readOnly}
          onNodeData={setNodeData} onEdgeForm={setEdgeForm} onDelete={deleteSelected} onDuplicate={duplicate} onClose={deselectAll}
        />
      )}

      {quick && (
        <QuickAdd
          x={quick.x} y={quick.y} bounds={{ w: wrap.current?.clientWidth ?? 900, h: wrap.current?.clientHeight ?? 600 }}
          types={typeList} allow={quickAllow} hint={quick.from ? 'Node mới sẽ được nối vào dây vừa kéo.' : undefined}
          onPick={pickQuick} onClose={() => setQuick(null)}
        />
      )}
    </div>
  )
}
