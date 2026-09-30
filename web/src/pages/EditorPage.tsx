import Form from '@rjsf/core'
import type { RJSFSchema } from '@rjsf/utils'
import validator from '@rjsf/validator-ajv8'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Background, ReactFlow, ReactFlowProvider, SelectionMode, applyEdgeChanges, applyNodeChanges, useReactFlow, useStore,
  type Connection, type EdgeChange, type NodeChange,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type DragEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { Graph, Issue, Json, NodeType } from '../api/types'
import { CanvasToolbar, type Tool } from '../components/editor/CanvasToolbar'
import { ShortcutsDialog } from '../components/editor/ShortcutsDialog'
import { FloatingPanel } from '../components/FloatingPanel'
import { rjsfFields, rjsfTemplates } from '../components/rjsfTemplates'
import { ARCHETYPE_LABEL, kfNodeTypes } from '../components/KfNode'
import { HeaderActions, useShell } from '../components/shell/ShellContext'
import { useTheme } from '../hooks/useTheme'
import { ErrorBox, Loading, btn, btnPrimary, input, issuesOf } from '../components/ui'
import { edgeSchema, edgeToForm, formToEdge, type EdgeForm } from '../lib/edgeForm'
import { versionStatusLabel } from '../lib/format'
import { clipboard, copyOf, pasteOf } from '../lib/clipboard'
import { defaultMaterial, edgeKey, edgeLabel, fromFlow, isEdit, makeNode, toFlow, type FlowEdge, type FlowNode } from '../lib/graph'
import { canRedo, canUndo, emptyHistory, record, redo, undo, type History } from '../lib/history'
import { autoLayout, type Dir } from '../lib/layout'
import { placeholderUi } from '../lib/paramDefaults'
import { labelSchema } from '../lib/paramLabels'
import { byCode, poolKind } from '../lib/model'
import { isTypingTarget } from '../lib/playback'
import { shortcutFor } from '../lib/shortcuts'

const DRAG_TYPE = 'application/kf-node-type'
const noSubmit = { 'ui:submitButtonOptions': { norender: true } }
/** Trạng thái để hoàn tác: vị trí và nội dung mọi node/edge, cùng hướng sơ đồ. */
type Snap = { nodes: FlowNode[]; edges: FlowEdge[]; dir: Dir }

/**
 * @rjsf gọi onChange ngay trong componentDidMount để điền giá trị mặc định, trước mọi thao tác của người dùng
 * (và không phân biệt được bằng tham số id, vì thao tác mảng cũng không có id). Bỏ qua các lần gọi đó bằng cờ
 * `ready`, bật ở effect của chính component này (effect của cha chạy sau componentDidMount của con).
 */
function UserForm({ onChange, ...rest }: ComponentProps<typeof Form>) {
  const ready = useRef(false)
  useEffect(() => { ready.current = true }, [])
  return <Form templates={rjsfTemplates} fields={rjsfFields} {...rest} onChange={(e, id) => { if (ready.current) onChange?.(e, id) }} />
}

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
  const [paletteOpen, setPaletteOpen] = useState(true)
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

  const onNodesChange = useCallback((c: NodeChange<FlowNode>[]) => {
    setNodes((ns) => applyNodeChanges(c, ns))
    if (!readOnly && c.some(isEdit)) setDirty(true)
  }, [readOnly])
  const onEdgesChange = useCallback((c: EdgeChange<FlowEdge>[]) => {
    setEdges((es) => applyEdgeChanges(c, es))
    if (!readOnly && c.some(isEdit)) setDirty(true)
  }, [readOnly])
  const onConnect = useCallback((c: Connection) => {
    const src = nodes.find((n) => n.id === c.source)
    const dst = nodes.find((n) => n.id === c.target)
    if (!src || !dst || src.data.archetype === 'RESOURCE_POOL' || dst.data.archetype === 'RESOURCE_POOL') return
    remember()
    const material = defaultMaterial(src, materials)
    setEdges((es) => [...es, {
      id: edgeKey(c.source, c.target, es.map((e) => e.id)), source: c.source, target: c.target,
      data: { material, params: {} }, label: edgeLabel(material, {}),
    }])
    setDirty(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, materials, readOnly])

  const deselectAll = () => {
    setNodes((ns) => (ns.some((n) => n.selected) ? ns.map((n) => ({ ...n, selected: false })) : ns))
    setEdges((es) => (es.some((e) => e.selected) ? es.map((e) => ({ ...e, selected: false })) : es))
  }
  const addNode = (t: NodeType, position: { x: number; y: number }) => {
    if (readOnly) return
    remember()
    const n = makeNode(t, live.current.nodes.map((x) => x.id), position)
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), { ...n, selected: true }])
    setEdges((es) => es.map((e) => ({ ...e, selected: false })))
    setDirty(true)
  }
  const onDrop = (ev: DragEvent) => {
    ev.preventDefault()
    const t = types[ev.dataTransfer.getData(DRAG_TYPE)]
    if (!t || readOnly) return
    addNode(t, screenToFlowPosition({ x: ev.clientX, y: ev.clientY }))
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

  const decorated = useMemo(() => nodes.map((n) => {
    const issue = issues.find((i) => i.key === n.id)?.message
    return issue === n.data.issue && dir === n.data.dir ? n : { ...n, data: { ...n.data, issue, dir } }
  }), [nodes, issues, dir])
  const decoratedEdges = useMemo(() => edges.map((e) => {
    const bad = issues.some((i) => i.key === e.id)
    return { ...e, style: bad ? { stroke: 'var(--color-bad)', strokeWidth: 2 } : undefined }
  }), [edges, issues])

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
    save: () => { if (!published && dirty && !save.isPending) save.mutate() },
    toolSelect: () => setTool('select'), toolHand: () => setTool('hand'),
    focus: () => setFocus((f) => !f), help: () => setHelpOpen(true),
    escape: () => { if (focus) setFocus(false); else deselectAll() },
    fit: () => void fitView({ padding: padding(), duration: 300 }),
    zoom100: () => void zoomTo(1, { duration: 200 }),
    fitSelection: () => { if (selNodes.length) void fitView({ nodes: selNodes, padding: padding(), duration: 300, maxZoom: 1.2 }) },
    add: () => setPaletteOpen(true),
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

  const pools = nodes.filter((n) => n.data.archetype === 'RESOURCE_POOL')
  const operators = pools.filter((n) => poolKind({ node_type: n.data.nodeType, params: n.data.params }, types) === 'OPERATOR')
  const selType = selNode?.data.nodeType
  const nodeNames = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n.data.name])), [nodes])
  const nodeName = (id: string) => (nodeNames[id] ? `${nodeNames[id]} (${id})` : id)
  const nodeDefaults = selType ? types[selType]?.default_params : undefined
  const nodeUi = useMemo(() => ({ ...noSubmit, ...placeholderUi(nodeDefaults) }), [nodeDefaults])
  const nodeCtx = useMemo(() => ({ defaults: nodeDefaults }), [nodeDefaults])
  const nodeSchema = useMemo(() => (selType ? (labelSchema(types[selType]?.param_schema) as RJSFSchema) : undefined), [selType, types])
  const error = save.error ?? publish.error

  return (
    <div className="relative h-full min-h-[480px]" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }} onDrop={onDrop}>
      <HeaderActions>
        <span className="text-[11px] text-muted">{versionStatusLabel(graph.status)}{dirty ? ', chưa lưu' : ''}</span>
        {published ? (
          <button className={btnPrimary} disabled={clone.isPending} onClick={() => clone.mutate()} title="Bản đã Publish không sửa được. Tạo bản sửa để có một bản nháp mới sao từ bản này.">Tạo bản sửa (v{graph.version + 1})</button>
        ) : (
          <>
            <button className={btn} disabled={save.isPending} onClick={() => save.mutate()} title="Lưu thay đổi vào bản nháp (Ctrl/⌘ S). Chưa khoá phiên bản.">Lưu</button>
            <button className={btnPrimary} disabled={publish.isPending} onClick={() => publish.mutate()} title="Lưu rồi khoá phiên bản này để chạy mô phỏng. Muốn sửa tiếp thì tạo bản sửa mới.">Publish</button>
          </>
        )}
      </HeaderActions>

      <ReactFlow
        nodes={decorated} edges={decoratedEdges} nodeTypes={kfNodeTypes} colorMode={theme}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={readOnly ? undefined : onConnect}
        onNodeDragStart={() => remember()} onSelectionDragStart={() => remember()}
        onBeforeDelete={async () => { remember(); return true }}
        nodesDraggable={!readOnly} nodesConnectable={!readOnly}
        selectionOnDrag={tool === 'select'} panOnDrag={tool === 'hand' ? true : [1]} selectionMode={SelectionMode.Partial}
        panActivationKeyCode="Space" multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']} zoomOnDoubleClick={false}
        fitView fitViewOptions={{ padding: padding() }}
      >
        <Background gap={18} size={1} color="var(--color-line)" />
      </ReactFlow>

      {!focus && (
        <CanvasToolbar
          tool={tool} onTool={setTool}
          zoom={zoom} onZoomBy={(d) => void (d > 0 ? zoomIn({ duration: 150 }) : zoomOut({ duration: 150 }))} onZoomTo={(z) => void zoomTo(z, { duration: 200 })}
          onFit={() => keys.current.fit()} onFitSelection={() => keys.current.fitSelection()} hasSelection={selNodes.length > 0}
          published={published} locked={locked} onLock={() => setLocked((l) => !l)}
          canEdit={!readOnly} onArrange={arrange}
          canUndo={!readOnly && canUndo(history)} canRedo={!readOnly && canRedo(history)} onUndo={undoStep} onRedo={redoStep}
          onAdd={() => setPaletteOpen(true)} onHelp={() => setHelpOpen(true)}
        />
      )}
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />

      {error && <div className="absolute left-1/2 top-3 z-20 w-[420px] -translate-x-1/2"><ErrorBox error={error} /></div>}

      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center">
          <div className="max-w-xs text-center text-xs leading-relaxed text-muted">
            <p className="text-sm font-semibold text-text-2">Sơ đồ đang trống</p>
            <p className="mt-1">{published ? 'Phiên bản này chưa có node nào.' : 'Kéo một loại node từ danh sách bên trái vào đây, rồi nối các node bằng chấm đầu ra và chấm đầu vào.'}</p>
          </div>
        </div>
      )}
      {!focus && paletteOpen && (
        <FloatingPanel side="left" width={220} title="Loại node" onClose={() => setPaletteOpen(false)}>
          <div className="p-3">
            <div className="mb-3 space-y-1 text-[11px] leading-snug text-muted">
              {readOnly ? (
                <p>Phiên bản đã Publish, chỉ xem. Muốn sửa, bấm "Tạo bản sửa" ở góc trên bên phải.</p>
              ) : (
                <>
                  <p><b className="font-semibold text-text-2">Thêm node:</b> kéo một loại vào sơ đồ.</p>
                  <p><b className="font-semibold text-text-2">Nối hai node:</b> kéo từ chấm đầu ra của node này sang chấm đầu vào của node kia.</p>
                  <p><b className="font-semibold text-text-2">Sửa:</b> bấm vào node hoặc đường nối để xem thuộc tính.</p>
                </>
              )}
            </div>
            {Object.keys(ARCHETYPE_LABEL).map((arch) => (
              <div key={arch} className="mb-3">
                <div className="mb-1 text-[11px] font-semibold text-faint">{ARCHETYPE_LABEL[arch]}</div>
                {typeList.filter((t) => t.archetype === arch).map((t) => (
                  <div
                    key={t.code} draggable={!readOnly}
                    onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, t.code); e.dataTransfer.effectAllowed = 'move' }}
                    className={`mb-1 rounded-lg border border-line-2 bg-panel-2 px-2.5 py-1.5 ${readOnly ? 'opacity-60' : 'cursor-grab hover:bg-raised'}`}
                  >
                    <div className="text-xs font-medium text-text">{t.name}</div>
                    <div className="text-[10.5px] text-faint">{t.code}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </FloatingPanel>
      )}
      {!focus && !paletteOpen && (
        <button className={`${btn} absolute left-3 top-3 z-10 bg-panel`} onClick={() => setPaletteOpen(true)}>Loại node</button>
      )}

      {!focus && (selNode || selEdge || selNodes.length + selEdges.length > 1) && (
        <FloatingPanel side="right" width={320} title={selNode ? 'Thuộc tính node' : selEdge ? 'Thuộc tính đường nối (edge)' : 'Đã chọn nhiều mục'} onClose={deselectAll}>
          <div className="rjsf p-3">
            {selNode && (
              <>
                <div className="mb-3">
                  <div className="text-[11px] text-muted">{types[selNode.data.nodeType]?.name} ({selNode.data.key})</div>
                  <label htmlFor="node-name" className="mt-2 block text-[11px] text-muted">Tên hiển thị</label>
                  <div className="mt-0.5 flex gap-2">
                    <input id="node-name" className={`${input} w-full`} value={selNode.data.name} disabled={readOnly}
                      onChange={(e) => setNodeData(selNode.id, { name: e.target.value })} />
                    {!readOnly && <button className={`${btn} flex-none whitespace-nowrap`} onClick={deleteSelected} title="Xoá node này và các đường nối của nó (Delete)">Xoá node</button>}
                  </div>
                </div>
                <UserForm
                  key={selNode.id}
                  schema={nodeSchema as RJSFSchema} formData={selNode.data.params}
                  validator={validator} disabled={readOnly} uiSchema={nodeUi} formContext={nodeCtx}
                  onChange={(e) => setNodeData(selNode.id, { params: (e.formData ?? {}) as Json })}
                />
                <details className="mt-3 text-[11px]">
                  <summary className="cursor-pointer text-muted">Xem giá trị mặc định của loại node (JSON, số liệu giả định)</summary>
                  <pre className="mt-1 overflow-x-auto rounded-lg bg-panel-2 p-2 text-text-2">{JSON.stringify(types[selNode.data.nodeType]?.default_params, null, 2)}</pre>
                </details>
              </>
            )}
            {selEdge && (
              <>
                <div className="mb-3 flex items-start justify-between gap-2">
                  <p className="text-[11px] leading-snug text-muted">
                    Hàng chảy từ <b className="font-semibold text-text-2">{nodeName(selEdge.source)}</b> sang <b className="font-semibold text-text-2">{nodeName(selEdge.target)}</b>.
                  </p>
                  {!readOnly && <button className={`${btn} flex-none whitespace-nowrap`} onClick={deleteSelected} title="Xoá đường nối này (Delete)">Xoá đường nối</button>}
                </div>
                <UserForm
                  key={selEdge.id}
                  schema={edgeSchema(materials, pools.map((p) => p.id), operators.map((p) => p.id), { mode: selEdge.data?.params.mode as string | undefined ?? 'NONE', names: nodeNames })}
                  formData={edgeToForm(selEdge.data?.material ?? '', selEdge.data?.params ?? {})}
                  validator={validator} disabled={readOnly} uiSchema={noSubmit}
                  onChange={(e) => setEdgeForm(selEdge.id, e.formData as EdgeForm)}
                />
              </>
            )}
            {!selNode && !selEdge && (
              <div className="space-y-2 text-xs text-text-2">
                <p>{selNodes.length > 0 ? `Đã chọn ${selNodes.length} node.` : `Đã chọn ${selEdges.length} đường nối.`}</p>
                {!readOnly && (
                  <div className="flex gap-2">
                    <button className={btn} onClick={duplicate}>Nhân đôi</button>
                    <button className={btn} onClick={deleteSelected}>Xoá</button>
                  </div>
                )}
              </div>
            )}
          </div>
        </FloatingPanel>
      )}
    </div>
  )
}
