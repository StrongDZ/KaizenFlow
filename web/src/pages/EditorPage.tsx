import Form from '@rjsf/core'
import type { RJSFSchema } from '@rjsf/utils'
import validator from '@rjsf/validator-ajv8'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, applyEdgeChanges, applyNodeChanges,
  useReactFlow, type Connection, type EdgeChange, type NodeChange,
} from '@xyflow/react'
import { useCallback, useMemo, useState, type DragEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { Graph, Issue, Json, NodeType } from '../api/types'
import { ARCHETYPE_LABEL, kfNodeTypes } from '../components/KfNode'
import { ErrorBox, Loading, btn, btnPrimary, issuesOf } from '../components/ui'
import { edgeSchema, edgeToForm, formToEdge, type EdgeForm } from '../lib/edgeForm'
import { defaultMaterial, edgeKey, edgeLabel, fromFlow, newNodeKey, toFlow, type FlowEdge, type FlowNode } from '../lib/graph'
import { byCode, poolKind } from '../lib/model'

const DRAG_TYPE = 'application/kf-node-type'
const noSubmit = { 'ui:submitButtonOptions': { norender: true } }

export default function EditorPage() {
  const vid = Number(useParams().id)
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  const mats = useQuery({ queryKey: ['materials'], queryFn: api.materials })
  const graph = useQuery({ queryKey: ['graph', vid], queryFn: () => api.graph(vid) })
  if (graph.error) return <div className="p-6"><ErrorBox error={graph.error} /></div>
  if (!graph.data || !types.data || !mats.data) return <Loading />
  return (
    <ReactFlowProvider>
      <Editor key={`${vid}-${graph.data.status}`} graph={graph.data} typeList={types.data}
        materials={mats.data.map((m) => m.code)} />
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
  const readOnly = graph.status !== 'DRAFT'
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { screenToFlowPosition } = useReactFlow()

  const onNodesChange = useCallback((c: NodeChange<FlowNode>[]) => {
    setNodes((ns) => applyNodeChanges(c, ns))
    if (c.some((x) => x.type !== 'select' && x.type !== 'dimensions')) setDirty(true)
  }, [])
  const onEdgesChange = useCallback((c: EdgeChange<FlowEdge>[]) => {
    setEdges((es) => applyEdgeChanges(c, es))
    if (c.some((x) => x.type !== 'select')) setDirty(true)
  }, [])
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
      return [...ns, { id: key, type: 'kf', position,
        data: { key, nodeType: t.code, archetype: t.archetype, name: t.name, params: {}, color: (t.ui.color as string | undefined) ?? '#64748b' } }]
    })
    setDirty(true)
  }

  const decorated = useMemo(() => nodes.map((n) => {
    const issue = issues.find((i) => i.key === n.id)?.message
    return issue === n.data.issue ? n : { ...n, data: { ...n.data, issue } }
  }), [nodes, issues])
  const decoratedEdges = useMemo(() => edges.map((e) => {
    const bad = issues.some((i) => i.key === e.id)
    return { ...e, style: bad ? { stroke: '#dc2626', strokeWidth: 2 } : undefined }
  }), [edges, issues])

  const body = () => fromFlow(nodes, edges)
  const done = () => { setIssues([]); setDirty(false); void qc.invalidateQueries({ queryKey: ['graph', graph.version_id] }); void qc.invalidateQueries({ queryKey: ['models'] }) }
  const save = useMutation({ mutationFn: () => api.saveGraph(graph.version_id, body()), onSuccess: done, onError: (e) => setIssues(issuesOf(e)) })
  const publish = useMutation({
    mutationFn: async () => { await api.saveGraph(graph.version_id, body()); return api.publish(graph.version_id) },
    onSuccess: done, onError: (e) => setIssues(issuesOf(e)),
  })
  const clone = useMutation({ mutationFn: () => api.clone(graph.version_id), onSuccess: (r) => navigate(`/versions/${r.version_id}`) })

  const setNodeData = (id: string, patch: Partial<FlowNode['data']>) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)))
    setDirty(true)
  }
  const setEdgeForm = (id: string, form: EdgeForm) => {
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

  return (
    <div className="flex h-[calc(100vh-49px)]">
      <aside className="w-56 overflow-y-auto border-r border-slate-200 bg-white p-3">
        <div className="mb-2 text-xs text-slate-500">Kéo loại node vào canvas</div>
        {Object.keys(ARCHETYPE_LABEL).map((arch) => (
          <div key={arch} className="mb-3">
            <div className="mb-1 text-[11px] font-semibold uppercase text-slate-400">{ARCHETYPE_LABEL[arch]}</div>
            {typeList.filter((t) => t.archetype === arch).map((t) => (
              <div key={t.code} draggable={!readOnly}
                onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, t.code); e.dataTransfer.effectAllowed = 'move' }}
                className="mb-1 cursor-grab rounded border-l-4 bg-slate-50 px-2 py-1 text-sm hover:bg-slate-100"
                style={{ borderColor: (t.ui.color as string | undefined) ?? '#64748b' }}>
                {t.name}
              </div>
            ))}
          </div>
        ))}
      </aside>

      <div className="flex flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
          <span className="font-semibold">{graph.model_key}</span>
          <span className="text-sm text-slate-500">v{graph.version} · {graph.status}{dirty ? ' · chưa lưu' : ''}</span>
          <div className="flex-1" />
          <Link className={btn} to={`/versions/${graph.version_id}/scenarios`}>Scenario &amp; chạy</Link>
          {readOnly ? (
            <button className={btnPrimary} onClick={() => clone.mutate()}>Tạo bản sửa (v{graph.version + 1})</button>
          ) : (
            <>
              <button className={btn} disabled={save.isPending} onClick={() => save.mutate()}>Lưu</button>
              <button className={btnPrimary} disabled={publish.isPending} onClick={() => publish.mutate()}>Publish</button>
            </>
          )}
        </div>
        {(save.error || publish.error) && <div className="p-2"><ErrorBox error={save.error ?? publish.error} /></div>}
        <div className="flex-1" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }} onDrop={onDrop}>
          <ReactFlow nodes={decorated} edges={decoratedEdges} nodeTypes={kfNodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={readOnly ? undefined : onConnect}
            nodesDraggable={!readOnly} nodesConnectable={!readOnly}
            onNodeClick={(_, n) => setSelected({ kind: 'node', id: n.id })}
            onEdgeClick={(_, e) => setSelected({ kind: 'edge', id: e.id })}
            onPaneClick={() => setSelected(null)} fitView>
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
      </div>

      <aside className="w-96 overflow-y-auto border-l border-slate-200 bg-white p-3">
        {!selected && <div className="text-sm text-slate-500">Chọn một node hoặc edge để sửa tham số.</div>}
        {selNode && (
          <div className="rjsf">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex-1">
                <div className="text-xs text-slate-500">{types[selNode.data.nodeType]?.name} · {selNode.data.key}</div>
                <input className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm" value={selNode.data.name}
                  disabled={readOnly} onChange={(e) => setNodeData(selNode.id, { name: e.target.value })} />
              </div>
              {!readOnly && <button className={btn} onClick={remove}>Xoá</button>}
            </div>
            <Form schema={types[selNode.data.nodeType]?.param_schema as RJSFSchema} formData={selNode.data.params}
              validator={validator} disabled={readOnly} uiSchema={noSubmit}
              onChange={(e) => setNodeData(selNode.id, { params: (e.formData ?? {}) as Json })} />
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-slate-500">Tham số mặc định của loại node (giả định)</summary>
              <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2">{JSON.stringify(types[selNode.data.nodeType]?.default_params, null, 2)}</pre>
            </details>
          </div>
        )}
        {selEdge && (
          <div className="rjsf">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-medium">{selEdge.id}</div>
              {!readOnly && <button className={btn} onClick={remove}>Xoá</button>}
            </div>
            <Form schema={edgeSchema(materials, pools.map((p) => p.id), operators.map((p) => p.id))}
              formData={edgeToForm(selEdge.data?.material ?? '', selEdge.data?.params ?? {})}
              validator={validator} disabled={readOnly} uiSchema={noSubmit}
              onChange={(e) => setEdgeForm(selEdge.id, e.formData as EdgeForm)} />
          </div>
        )}
      </aside>
    </div>
  )
}
