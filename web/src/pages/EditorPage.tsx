import Form from '@rjsf/core'
import type { RJSFSchema } from '@rjsf/utils'
import validator from '@rjsf/validator-ajv8'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Background, Controls, ReactFlow, ReactFlowProvider, applyEdgeChanges, applyNodeChanges, useReactFlow,
  type Connection, type EdgeChange, type NodeChange,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type DragEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { Graph, Issue, Json, NodeType } from '../api/types'
import { FloatingPanel } from '../components/FloatingPanel'
import { ARCHETYPE_LABEL, kfNodeTypes } from '../components/KfNode'
import { HeaderActions, useShell } from '../components/shell/ShellContext'
import { ErrorBox, Loading, btn, btnPrimary, input, issuesOf } from '../components/ui'
import { edgeSchema, edgeToForm, formToEdge, type EdgeForm } from '../lib/edgeForm'
import { versionStatusLabel } from '../lib/format'
import { defaultMaterial, edgeKey, edgeLabel, fromFlow, isEdit, newNodeKey, toFlow, type FlowEdge, type FlowNode } from '../lib/graph'
import { byCode, poolKind } from '../lib/model'
import { isTypingTarget } from '../lib/playback'

const DRAG_TYPE = 'application/kf-node-type'
const noSubmit = { 'ui:submitButtonOptions': { norender: true } }

/**
 * @rjsf gọi onChange ngay trong componentDidMount để điền giá trị mặc định, trước mọi thao tác của người dùng
 * (và không phân biệt được bằng tham số id, vì thao tác mảng cũng không có id). Bỏ qua các lần gọi đó bằng cờ
 * `ready`, bật ở effect của chính component này (effect của cha chạy sau componentDidMount của con).
 */
function UserForm({ onChange, ...rest }: ComponentProps<typeof Form>) {
  const ready = useRef(false)
  useEffect(() => { ready.current = true }, [])
  return <Form {...rest} onChange={(e, id) => { if (ready.current) onChange?.(e, id) }} />
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
  const [selected, setSelected] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null)
  const [issues, setIssues] = useState<Issue[]>([])
  const [dirty, setDirty] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(true)
  const readOnly = graph.status !== 'DRAFT'
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { screenToFlowPosition } = useReactFlow()
  const { focus, setFocus } = useShell()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target as HTMLElement | null) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'f' || e.key === 'F') setFocus((f) => !f)
      else if (e.key === 'Escape') setFocus(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setFocus])

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
    const material = defaultMaterial(src, materials)
    setEdges((es) => [...es, {
      id: edgeKey(c.source, c.target, es.map((e) => e.id)), source: c.source, target: c.target,
      data: { material, params: {} }, label: edgeLabel(material, {}),
    }])
    setDirty(true)
  }, [nodes, materials])

  const onDrop = (ev: DragEvent) => {
    ev.preventDefault()
    const t = types[ev.dataTransfer.getData(DRAG_TYPE)]
    if (!t || readOnly) return
    const position = screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
    setNodes((ns) => {
      const key = newNodeKey(ns.map((n) => n.id), t.code)
      return [...ns, { id: key, type: 'kf', position, data: { key, nodeType: t.code, archetype: t.archetype, name: t.name, params: {} } }]
    })
    setDirty(true)
  }

  const decorated = useMemo(() => nodes.map((n) => {
    const issue = issues.find((i) => i.key === n.id)?.message
    return issue === n.data.issue ? n : { ...n, data: { ...n.data, issue } }
  }), [nodes, issues])
  const decoratedEdges = useMemo(() => edges.map((e) => {
    const bad = issues.some((i) => i.key === e.id)
    return { ...e, style: bad ? { stroke: 'var(--color-bad)', strokeWidth: 2 } : undefined }
  }), [edges, issues])

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
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)))
    setDirty(true)
  }
  const setEdgeForm = (id: string, form: EdgeForm) => {
    if (readOnly) return
    const cur = edges.find((e) => e.id === id)
    if (cur && JSON.stringify(formToEdge(form, cur.data?.params ?? {})) === JSON.stringify(cur.data)) return
    setEdges((es) => es.map((e) => {
      if (e.id !== id) return e
      const next = formToEdge(form, e.data?.params ?? {})
      return { ...e, data: next, label: edgeLabel(next.material, next.params) }
    }))
    setDirty(true)
  }
  const remove = () => {
    if (!selected) return
    if (selected.kind === 'node') {
      setNodes((ns) => ns.filter((n) => n.id !== selected.id))
      setEdges((es) => es.filter((e) => e.source !== selected.id && e.target !== selected.id))
    } else setEdges((es) => es.filter((e) => e.id !== selected.id))
    setSelected(null)
    setDirty(true)
  }

  const pools = nodes.filter((n) => n.data.archetype === 'RESOURCE_POOL')
  const operators = pools.filter((n) => poolKind({ node_type: n.data.nodeType, params: n.data.params }, types) === 'OPERATOR')
  const selNode = selected?.kind === 'node' ? nodes.find((n) => n.id === selected.id) : undefined
  const selEdge = selected?.kind === 'edge' ? edges.find((e) => e.id === selected.id) : undefined
  const error = save.error ?? publish.error

  return (
    <div className="relative h-full min-h-[480px]" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }} onDrop={onDrop}>
      <HeaderActions>
        <span className="text-[11px] text-muted">{versionStatusLabel(graph.status)}{dirty ? ', chưa lưu' : ''}</span>
        {readOnly ? (
          <button className={btnPrimary} disabled={clone.isPending} onClick={() => clone.mutate()}>Tạo bản sửa (v{graph.version + 1})</button>
        ) : (
          <>
            <button className={btn} disabled={save.isPending} onClick={() => save.mutate()}>Lưu</button>
            <button className={btnPrimary} disabled={publish.isPending} onClick={() => publish.mutate()}>Publish</button>
          </>
        )}
      </HeaderActions>

      <ReactFlow
        nodes={decorated} edges={decoratedEdges} nodeTypes={kfNodeTypes} colorMode="dark"
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={readOnly ? undefined : onConnect}
        nodesDraggable={!readOnly} nodesConnectable={!readOnly}
        onNodeClick={(_, n) => setSelected({ kind: 'node', id: n.id })}
        onEdgeClick={(_, e) => setSelected({ kind: 'edge', id: e.id })}
        onPaneClick={() => setSelected(null)} fitView
      >
        <Background gap={18} size={1} color="var(--color-line)" />
        <Controls position="bottom-center" />
      </ReactFlow>

      {error && <div className="absolute left-1/2 top-3 z-20 w-[420px] -translate-x-1/2"><ErrorBox error={error} /></div>}

      {!focus && paletteOpen && (
        <FloatingPanel side="left" width={220} title="Loại node" onClose={() => setPaletteOpen(false)}>
          <div className="p-3">
            <div className="mb-2 text-[11px] text-muted">{readOnly ? 'Phiên bản đã Publish, chỉ xem.' : 'Kéo một loại vào sơ đồ.'}</div>
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

      {!focus && selected && (
        <FloatingPanel side="right" width={320} title={selNode ? 'Thuộc tính node' : 'Thuộc tính edge'} onClose={() => setSelected(null)}>
          <div className="rjsf p-3">
            {selNode && (
              <>
                <div className="mb-2 flex items-end gap-2">
                  <div className="flex-1">
                    <div className="text-[11px] text-muted">{types[selNode.data.nodeType]?.name}, {selNode.data.key}</div>
                    <input className={`${input} mt-1 w-full`} aria-label="Tên node" value={selNode.data.name} disabled={readOnly}
                      onChange={(e) => setNodeData(selNode.id, { name: e.target.value })} />
                  </div>
                  {!readOnly && <button className={btn} onClick={remove}>Xoá</button>}
                </div>
                <UserForm
                  key={selNode.id}
                  schema={types[selNode.data.nodeType]?.param_schema as RJSFSchema} formData={selNode.data.params}
                  validator={validator} disabled={readOnly} uiSchema={noSubmit}
                  onChange={(e) => setNodeData(selNode.id, { params: (e.formData ?? {}) as Json })}
                />
                <details className="mt-3 text-[11px]">
                  <summary className="cursor-pointer text-muted">Tham số mặc định của loại node (giả định)</summary>
                  <pre className="mt-1 overflow-x-auto rounded-lg bg-panel-2 p-2 text-text-2">{JSON.stringify(types[selNode.data.nodeType]?.default_params, null, 2)}</pre>
                </details>
              </>
            )}
            {selEdge && (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs font-medium text-text">{selEdge.id}</div>
                  {!readOnly && <button className={btn} onClick={remove}>Xoá</button>}
                </div>
                <UserForm
                  key={selEdge.id}
                  schema={edgeSchema(materials, pools.map((p) => p.id), operators.map((p) => p.id))}
                  formData={edgeToForm(selEdge.data?.material ?? '', selEdge.data?.params ?? {})}
                  validator={validator} disabled={readOnly} uiSchema={noSubmit}
                  onChange={(e) => setEdgeForm(selEdge.id, e.formData as EdgeForm)}
                />
              </>
            )}
          </div>
        </FloatingPanel>
      )}
    </div>
  )
}
