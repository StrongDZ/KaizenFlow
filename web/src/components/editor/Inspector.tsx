import Form from '@rjsf/core'
import type { RJSFSchema } from '@rjsf/utils'
import validator from '@rjsf/validator-ajv8'
import { Copy, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, type ComponentProps } from 'react'
import type { Json, NodeType } from '../../api/types'
import { edgeSchema, edgeToForm, type EdgeForm } from '../../lib/edgeForm'
import type { FlowEdge, FlowNode } from '../../lib/graph'
import { poolKind } from '../../lib/model'
import { placeholderUi } from '../../lib/paramDefaults'
import { labelSchema } from '../../lib/paramLabels'
import { FloatingPanel } from '../FloatingPanel'
import { NodeIcon } from '../nodeIcons'
import { rjsfFields, rjsfTemplates } from '../rjsfTemplates'
import { btn, btnDangerOutline } from '../ui'

const noSubmit = { 'ui:submitButtonOptions': { norender: true } }

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

const iconBtn = 'flex h-7 w-7 flex-none items-center justify-center rounded-md text-bad-text hover:bg-bad-bg disabled:opacity-40'

type Props = {
  node?: FlowNode; edge?: FlowEdge; selNodes: FlowNode[]; selEdgeCount: number
  nodes: FlowNode[]; types: Record<string, NodeType>; materials: string[]
  canEdit: boolean
  onNodeData: (id: string, patch: Partial<FlowNode['data']>) => void
  onEdgeForm: (id: string, form: EdgeForm) => void
  onDelete: () => void; onDuplicate: () => void; onClose: () => void
}

/** Panel thuộc tính bên phải, có ba dạng: một node, một đường nối, hoặc nhiều mục được chọn cùng lúc. */
export function Inspector(p: Props) {
  const title = p.node ? 'Thuộc tính node' : p.edge ? 'Thuộc tính đường nối (edge)' : 'Đã chọn nhiều mục'
  return (
    <FloatingPanel side="right" width={320} top={12} bottom={64} fit title={title} onClose={p.onClose}>
      {p.node ? <NodeInspector {...p} node={p.node} /> : p.edge ? <EdgeInspector {...p} edge={p.edge} /> : <MultiInspector {...p} />}
    </FloatingPanel>
  )
}

function NodeInspector({ node, types, canEdit, onNodeData, onDelete }: Props & { node: FlowNode }) {
  const type = types[node.data.nodeType]
  const defaults = type?.default_params
  const schema = useMemo(() => labelSchema(type?.param_schema) as RJSFSchema, [type])
  const ui = useMemo(() => ({ ...noSubmit, ...placeholderUi(defaults) }), [defaults])
  const params = node.data.params
  const ctx = useMemo(() => ({ defaults, params }), [defaults, params])
  return (
    <div>
      <header className="sticky top-0 z-10 border-b border-line bg-panel px-3 pb-2.5 pt-3">
        <div className="flex items-start gap-2">
          <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-panel-2 text-text-2">
            <NodeIcon name={node.data.icon} archetype={node.data.archetype} size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <input
              aria-label="Tên hiển thị" title="Tên hiển thị của node trên sơ đồ" value={node.data.name} disabled={!canEdit} placeholder={type?.name}
              onChange={(e) => onNodeData(node.id, { name: e.target.value })}
              className="w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold text-text hover:border-line-2 focus:border-line-2 focus:outline-none disabled:opacity-100"
            />
            <div className="px-1 text-[11px] text-muted">{type?.name ?? node.data.nodeType} ({node.data.key})</div>
          </div>
          {canEdit && (
            <button type="button" className={iconBtn} aria-label="Xoá node" title="Xoá node này và các đường nối của nó (Delete)" onClick={onDelete}><Trash2 size={14} /></button>
          )}
        </div>
      </header>
      <div className="rjsf px-3 pb-3 pt-2">
        <UserForm
          key={node.id}
          schema={schema} formData={node.data.params}
          validator={validator} disabled={!canEdit} uiSchema={ui} formContext={ctx}
          onChange={(e) => onNodeData(node.id, { params: (e.formData ?? {}) as Json })}
        />
        <details className="mt-3 text-[11px]">
          <summary className="cursor-pointer text-muted">Xem giá trị mặc định của loại node (JSON, số liệu giả định)</summary>
          <pre className="mt-1 overflow-x-auto rounded-lg bg-panel-2 p-2 text-text-2">{JSON.stringify(defaults, null, 2)}</pre>
        </details>
      </div>
    </div>
  )
}

function EdgeInspector({ edge, nodes, types, materials, canEdit, onEdgeForm, onDelete }: Props & { edge: FlowEdge }) {
  const names = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n.data.name])), [nodes])
  const nameOf = (id: string) => (names[id] ? `${names[id]} (${id})` : id)
  const pools = nodes.filter((n) => n.data.archetype === 'RESOURCE_POOL')
  const operators = pools.filter((n) => poolKind({ node_type: n.data.nodeType, params: n.data.params }, types) === 'OPERATOR')
  const mode = (edge.data?.params.mode as string | undefined) ?? 'NONE'
  return (
    <div className="rjsf p-3">
      <div className="mb-3 flex items-start justify-between gap-2">
        <p className="text-[11px] leading-snug text-muted">
          Hàng chảy từ <b className="font-semibold text-text-2">{nameOf(edge.source)}</b> sang <b className="font-semibold text-text-2">{nameOf(edge.target)}</b>.
        </p>
        {canEdit && <button type="button" className={iconBtn} aria-label="Xoá đường nối" title="Xoá đường nối này (Delete)" onClick={onDelete}><Trash2 size={14} /></button>}
      </div>
      <UserForm
        key={edge.id}
        schema={edgeSchema(materials, pools.map((x) => x.id), operators.map((x) => x.id), { mode, names })}
        formData={edgeToForm(edge.data?.material ?? '', edge.data?.params ?? {})}
        validator={validator} disabled={!canEdit} uiSchema={noSubmit}
        onChange={(e) => onEdgeForm(edge.id, e.formData as EdgeForm)}
      />
    </div>
  )
}

function MultiInspector({ selNodes, selEdgeCount, canEdit, onDelete, onDuplicate }: Props) {
  const counts = selNodes.reduce<Record<string, number>>((m, n) => ({ ...m, [n.data.name]: (m[n.data.name] ?? 0) + 1 }), {})
  return (
    <div className="space-y-3 p-3 text-xs text-text-2">
      <p className="text-sm font-semibold text-text">{selNodes.length > 0 ? `${selNodes.length} node` : `${selEdgeCount} đường nối`}</p>
      {selNodes.length > 0 && (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto text-muted">
          {Object.entries(counts).map(([name, n]) => <li key={name}>{name}{n > 1 ? ` ×${n}` : ''}</li>)}
        </ul>
      )}
      <p className="text-[11px] text-muted">{canEdit ? 'Kéo một node để di chuyển cả nhóm. Muốn sửa thông số thì chọn từng node một.' : 'Sơ đồ đang ở chế độ chỉ xem. Chọn từng node một để xem thông số.'}</p>
      {canEdit && (
        <div className="flex gap-2">
          {selNodes.length > 0 && <button className={`${btn} inline-flex items-center gap-1`} onClick={onDuplicate}><Copy size={12} />Nhân đôi</button>}
          <button className={btnDangerOutline} onClick={onDelete}><Trash2 size={12} />Xoá</button>
        </div>
      )}
    </div>
  )
}
