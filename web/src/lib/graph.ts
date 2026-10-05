import type { Edge, EdgeChange, Node, NodeChange } from '@xyflow/react'
import type { ReactNode } from 'react'
import type { Graph, GraphEdge, GraphNode, Json, NodeType } from '../api/types'
import { inferDir, type Dir } from './layout'
import type { PinTone } from './pins'

export type Color = 'GREEN' | 'YELLOW' | 'RED' | 'NONE'
export type Badge = { color: Color | 'INFO'; text: string; hint?: string }

export type PinView = { n: number; tone: PinTone; content: ReactNode }

export type FlowData = {
  key: string
  nodeType: string
  archetype: string
  name: string
  params: Json
  /** Tóm tắt phát hiện của bước Kiểm tra trên thẻ node ("1 lỗi, 1 cảnh báo"), kèm mức và thông điệp đầu tiên. */
  issue?: string
  issueTone?: 'error' | 'warning'
  issueTitle?: string
  badge?: Badge
  pins?: PinView[]
  pinState?: { open: number | null; setOpen: (n: number | null) => void }
  /** Hướng sơ đồ: quyết định cổng nối nằm hai bên (LR) hay trên/dưới (TB). */
  dir?: Dir
  /** Tên biểu tượng lucide của loại node (ui.icon), để thẻ node và danh sách loại có cùng hình. */
  icon?: string
}
/** dots/cycleS/running chỉ có ở Control Room (hạt chạy trên edge); không bao giờ được lưu vào sơ đồ. */
export type EdgeData = { material: string; params: Json; dots?: number; cycleS?: number; running?: boolean; /** Lưu lượng của đường nối là số ước lượng, không phải số đo: vẽ nét đứt. */ estimated?: boolean }
export type FlowNode = Node<FlowData, 'kf'>
export type FlowEdge = Edge<EdgeData>

export function iconOfType(t: NodeType | undefined): string | undefined {
  const icon = t?.ui?.icon
  return typeof icon === 'string' && icon !== '' ? icon : undefined
}

export function edgeLabel(material: string, params: Json): string {
  return params.mode === 'POOL' ? `${material} · ${String(params.pool ?? '?')}` : material
}

export function toFlow(g: Graph, types: Record<string, NodeType>): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = g.nodes.map((n, i) => {
    const t = types[n.node_type]
    return {
      id: n.key,
      type: 'kf',
      position: n.canvas_pos ?? { x: 80 + (i % 5) * 230, y: 80 + Math.floor(i / 5) * 170 },
      data: {
        key: n.key,
        nodeType: n.node_type,
        archetype: n.archetype || t?.archetype || '',
        name: n.name || t?.name || n.node_type,
        params: n.params ?? {},
        icon: iconOfType(t),
      },
    }
  })
  const dir = inferDir(Object.fromEntries(nodes.map((n) => [n.id, n.position])), g.edges.map((e) => ({ source: e.src, target: e.dst })))
  for (const n of nodes) n.data.dir = dir
  const edges: FlowEdge[] = g.edges.map((e) => ({
    id: e.key,
    source: e.src,
    target: e.dst,
    data: { material: e.material, params: e.params ?? {} },
    label: edgeLabel(e.material, e.params ?? {}),
  }))
  return { nodes, edges }
}

export function fromFlow(nodes: FlowNode[], edges: FlowEdge[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return {
    nodes: nodes.map((n) => ({
      key: n.data.key,
      node_type: n.data.nodeType,
      archetype: n.data.archetype,
      name: n.data.name,
      params: n.data.params,
      canvas_pos: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    })),
    edges: edges.map((e) => ({
      key: e.id,
      src: e.source,
      dst: e.target,
      material: e.data?.material ?? '',
      params: e.data?.params ?? {},
    })),
  }
}

export function newNodeKey(existing: string[], code: string): string {
  const base = code.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  let i = 1
  while (existing.includes(`${base}_${i}`)) i++
  return `${base}_${i}`
}

/** Node mới của một loại, đặt ở vị trí cho trước, với khoá chưa node nào dùng. */
export function makeNode(t: NodeType, existing: string[], position: { x: number; y: number }): FlowNode {
  const key = newNodeKey(existing, t.code)
  return { id: key, type: 'kf', position, data: { key, nodeType: t.code, archetype: t.archetype, name: t.name, params: {}, icon: iconOfType(t) } }
}

export function edgeKey(src: string, dst: string, existing: string[]): string {
  let key = `${src}>${dst}`
  let i = 2
  while (existing.includes(key)) key = `${src}>${dst}#${i++}`
  return key
}

type Line = { material: string }

const mats = (list: Line[] | undefined): string[] => (list ?? []).map((l) => l.material).filter((m): m is string => typeof m === 'string' && m !== '')

/** Tham số hiệu lực của node ở mức đọc: tham số riêng, không có thì mặc định của loại node. */
function effective(src: FlowNode, types: Record<string, NodeType>, key: string): unknown {
  return src.data.params[key] ?? types[src.data.nodeType]?.default_params?.[key]
}

/** Các vật tư mà node này phát ra, theo thứ tự ưu tiên: đầu ra của công thức (Trạm), lô hàng (Nguồn), tồn khai báo (Kho). */
export function outputMaterials(src: FlowNode | undefined, types: Record<string, NodeType> = {}): string[] {
  if (!src) return []
  switch (src.data.archetype) {
    case 'PROCESS': {
      const recipes = effective(src, types, 'recipes') as { outputs?: (Line & { port?: string })[] }[] | undefined
      const out = recipes?.[0]?.outputs ?? []
      return mats([...out.filter((o) => o.port !== 'NG'), ...out.filter((o) => o.port === 'NG')])
    }
    case 'SOURCE': return mats(effective(src, types, 'lots') as Line[] | undefined)
    case 'STORAGE': return mats(effective(src, types, 'stock') as Line[] | undefined)
    default: return []
  }
}

/**
 * Vật tư điền sẵn cho đường nối mới từ `src`: vật tư node này phát ra mà cặp node chưa dùng (`avoid`),
 * rồi vật tư bất kỳ trong Thư viện chưa dùng; hết lựa chọn thì lấy vật tư đầu tiên và để bước Kiểm tra báo trùng.
 */
export function defaultMaterial(src: FlowNode | undefined, library: string[], types: Record<string, NodeType> = {}, avoid: string[] = []): string {
  const own = outputMaterials(src, types)
  return own.find((m) => !avoid.includes(m)) ?? library.find((m) => !avoid.includes(m)) ?? own[0] ?? library[0] ?? ''
}

/** Thay đổi của React Flow có phải chỉnh sửa thật không (chọn, đo kích thước, click không kéo thì không). */
export function isEdit(c: NodeChange | EdgeChange): boolean {
  if (c.type === 'select' || c.type === 'dimensions') return false
  if (c.type === 'position') return c.dragging === true
  return true
}
