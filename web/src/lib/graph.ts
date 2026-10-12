import { MarkerType, type Edge, type EdgeChange, type Node, type NodeChange } from '@xyflow/react'
import type { ReactNode } from 'react'
import type { Graph, GraphEdge, GraphNode, Json, NodeType } from '../api/types'
import { inferDir, type Dir } from './layout'
import type { NodeRow } from './nodeSummary'
import type { PinTone } from './pins'

export type Color = 'GREEN' | 'YELLOW' | 'RED' | 'NONE'
export type Badge = { color: Color | 'INFO'; text: string; hint?: string; kind?: 'MAINTENANCE' }

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
  /** Số đo hiện trong thân thẻ node khi xem lần chạy; vắng mặt thì thẻ tự tóm tắt thông số thiết lập. */
  rows?: NodeRow[]
  pins?: PinView[]
  pinState?: { open: number | null; setOpen: (n: number | null) => void }
  /** Hướng sơ đồ: quyết định cổng nối nằm hai bên (LR) hay trên/dưới (TB). */
  dir?: Dir
  /** Tên biểu tượng lucide của loại node (ui.icon), để thẻ node và danh sách loại có cùng hình. */
  icon?: string
  /** Màu ui.color của loại node. Thẻ node trên sơ đồ không dùng nó (đỏ/xanh lá dễ đọc nhầm thành trạng thái); màu nhận diện lấy theo vai trò. */
  accent?: string
}
/** dots/cycleS/running chỉ có ở Control Room (hạt chạy trên edge); không bao giờ được lưu vào sơ đồ. */
export type EdgeData = {
  material: string
  params: Json
  dots?: number
  cycleS?: number
  running?: boolean
  blocked?: boolean
  statusText?: string
  /** Lưu lượng của đường nối là số ước lượng, không phải số đo: vẽ nét đứt. */
  estimated?: boolean
}
export type FlowNode = Node<FlowData, 'kf'>
export type FlowEdge = Edge<EdgeData>

export const FLOW_MARKER = { type: MarkerType.ArrowClosed, width: 15, height: 15, color: 'var(--color-faint)' } as const

export function iconOfType(t: NodeType | undefined): string | undefined {
  const icon = t?.ui?.icon
  return typeof icon === 'string' && icon !== '' ? icon : undefined
}

export function colorOfType(t: NodeType | undefined): string | undefined {
  const color = t?.ui?.color
  return typeof color === 'string' && color.trim() !== '' ? color : undefined
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
        accent: colorOfType(t),
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
    markerEnd: FLOW_MARKER,
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
/**
 * Dựng node trên sơ đồ cho một thiết bị đã khai trong danh mục Thiết bị: mã node LÀ mã thiết bị,
 * nên cùng một máy ở nhiều mô hình vẫn là một. `asset` bắt buộc — sơ đồ chỉ đặt thiết bị, không
 * khai sinh thiết bị. `name` lấy tên thiết bị, không có thì lấy tên loại.
 */
export function makeNode(t: NodeType, asset: { key: string; name?: string }, position: { x: number; y: number }): FlowNode {
  const key = asset.key
  return {
    id: key,
    type: 'kf',
    position,
    data: { key, nodeType: t.code, archetype: t.archetype, name: asset.name || t.name, params: {}, icon: iconOfType(t), accent: colorOfType(t) },
  }
}

export function edgeKey(src: string, dst: string, existing: string[]): string {
  let key = `${src}>${dst}`
  let i = 2
  while (existing.includes(key)) key = `${src}>${dst}#${i++}`
  return key
}

type Line = { material: string; qty?: number; port?: string; [key: string]: unknown }
type Recipe = { inputs?: Line[]; outputs?: Line[]; [key: string]: unknown }

const mats = (list: Line[] | undefined): string[] => (list ?? []).map((l) => l.material).filter((m): m is string => typeof m === 'string' && m !== '')
const lines = (value: unknown): Line[] => Array.isArray(value)
  ? value.filter((line): line is Line => typeof line === 'object' && line !== null && !Array.isArray(line))
  : []
const positiveQty = (value: unknown, fallback = 1): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

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

/** Vật tư node nhận vào. Process đọc BOM; Sink đọc nhu cầu; Storage đọc danh sách tồn theo dõi. */
export function inputMaterials(dst: FlowNode | undefined, types: Record<string, NodeType> = {}): string[] {
  if (!dst) return []
  switch (dst.data.archetype) {
    case 'PROCESS': {
      const recipes = effective(dst, types, 'recipes') as Recipe[] | undefined
      return mats(recipes?.[0]?.inputs)
    }
    case 'SINK': return mats(effective(dst, types, 'demand') as Line[] | undefined)
    case 'STORAGE': return mats(effective(dst, types, 'stock') as Line[] | undefined)
    default: return []
  }
}

function qtyFor(node: FlowNode, side: 'inputs' | 'outputs', material: string, types: Record<string, NodeType>): number | undefined {
  if (node.data.archetype === 'PROCESS') {
    const recipes = effective(node, types, 'recipes') as Recipe[] | undefined
    const found = recipes?.[0]?.[side]?.find((line) => line.material === material)
    return found ? positiveQty(found.qty) : undefined
  }
  if (side === 'outputs' && node.data.archetype === 'SOURCE') {
    const found = lines(effective(node, types, 'lots')).find((line) => line.material === material)
    return found ? positiveQty(found.qty) : undefined
  }
  return undefined
}

function withProcessLine(node: FlowNode, side: 'inputs' | 'outputs', material: string, types: Record<string, NodeType>): FlowNode {
  const raw = effective(node, types, 'recipes')
  const recipes: Recipe[] = Array.isArray(raw)
    ? raw.map((recipe) => {
      const r = typeof recipe === 'object' && recipe !== null && !Array.isArray(recipe) ? recipe as Recipe : {}
      return { ...r, inputs: lines(r.inputs).map((line) => ({ ...line })), outputs: lines(r.outputs).map((line) => ({ ...line })) }
    })
    : []
  if (recipes.length === 0) recipes.push({ inputs: [], outputs: [] })
  const first = recipes[0]
  const current = lines(first[side])
  if (current.some((line) => line.material === material)) return node
  first[side] = [...current, side === 'outputs' ? { material, qty: 1, port: 'OK' } : { material, qty: 1 }]
  return { ...node, data: { ...node.data, params: { ...node.data.params, recipes } } }
}

function withListLine(node: FlowNode, key: 'lots' | 'stock', material: string, types: Record<string, NodeType>): FlowNode {
  const current = lines(effective(node, types, key)).map((line) => ({ ...line }))
  if (current.some((line) => line.material === material)) return node
  const line = key === 'lots' ? { material, qty: 1 } : { material, initial: 0 }
  return { ...node, data: { ...node.data, params: { ...node.data.params, [key]: [...current, line] } } }
}

export type ConnectionSetup = {
  nodes: FlowNode[]
  material: string
  params: Json
  note: string
  needsReview: boolean
}

/**
 * Chuẩn bị một đường nối thân thiện với người dùng.
 * - ưu tiên vật tư mà cả hai đầu đã khai báo;
 * - tự bổ sung phần cấu hình đang trống, nhưng không ghi đè BOM đã tồn tại;
 * - lot theo số lượng input của đích (nếu có), sau đó mới theo output của nguồn.
 */
export function prepareConnection(
  nodes: FlowNode[], edges: FlowEdge[], source: string, target: string,
  library: string[], types: Record<string, NodeType> = {},
): ConnectionSetup {
  const src = nodes.find((node) => node.id === source)
  const dst = nodes.find((node) => node.id === target)
  if (!src || !dst) return { nodes, material: '', params: {}, note: 'Không tìm thấy đủ hai node để thiết lập đường nối.', needsReview: true }

  const avoid = edges.filter((edge) => edge.source === source && edge.target === target).map((edge) => edge.data?.material ?? '')
  const srcMaterials = outputMaterials(src, types)
  const dstMaterials = inputMaterials(dst, types)
  const available = (values: string[]) => values.find((material) => !avoid.includes(material))
  const shared = srcMaterials.filter((material) => dstMaterials.includes(material))
  const material = available(shared) ?? available(srcMaterials) ?? available(dstMaterials)
    ?? available(library) ?? shared[0] ?? srcMaterials[0] ?? dstMaterials[0] ?? library[0] ?? ''

  const changes: string[] = []
  const guidance: string[] = []
  let nextSrc = src
  let nextDst = dst

  if (material) {
    if (src.data.archetype === 'PROCESS' && srcMaterials.length === 0) {
      nextSrc = withProcessLine(src, 'outputs', material, types)
      changes.push(`thêm đầu ra ${material} ×1 mặc định cho ${src.data.name}`)
    } else if (src.data.archetype === 'SOURCE' && srcMaterials.length === 0) {
      nextSrc = withListLine(src, 'lots', material, types)
      changes.push(`thêm lô ${material} ×1 mặc định cho ${src.data.name}`)
    } else if (src.data.archetype === 'STORAGE' && srcMaterials.length === 0) {
      nextSrc = withListLine(src, 'stock', material, types)
      changes.push(`thêm ${material} vào danh sách tồn của ${src.data.name}`)
    }

    if (dst.data.archetype === 'PROCESS' && dstMaterials.length === 0) {
      nextDst = withProcessLine(dst, 'inputs', material, types)
      changes.push(`thêm đầu vào ${material} ×1 mặc định cho ${dst.data.name}`)
    } else if (dst.data.archetype === 'PROCESS' && !dstMaterials.includes(material)) {
      guidance.push(`${dst.data.name} đang nhận ${dstMaterials.join(', ')}, không nhận ${material}; hãy sửa Công thức hoặc vật tư của đường nối`)
    } else if (dst.data.archetype === 'STORAGE' && !dstMaterials.includes(material)) {
      nextDst = withListLine(dst, 'stock', material, types)
      changes.push(`thêm ${material} vào danh sách tồn của ${dst.data.name}`)
    } else if (dst.data.archetype === 'SINK' && effective(dst, types, 'throughput') !== false && !dstMaterials.includes(material)) {
      guidance.push(`${dst.data.name} chưa có nhu cầu cho ${material}; hãy khai báo nhu cầu nếu muốn đo giao hàng`)
    }
    if (avoid.includes(material)) {
      guidance.push(`đã có một đường ${source} → ${target} chở ${material}; hãy chọn vật tư khác hoặc xoá đường nối trùng`)
    }
  } else {
    guidance.push('Thư viện chưa có vật tư để chọn; hãy tạo vật tư rồi mở thuộc tính đường nối')
  }

  const lot = material
    ? qtyFor(dst, 'inputs', material, types) ?? qtyFor(nextDst, 'inputs', material, types)
      ?? qtyFor(src, 'outputs', material, types) ?? qtyFor(nextSrc, 'outputs', material, types) ?? 1
    : 1
  const params: Json = lot === 1 ? {} : { lot }
  const nextNodes = nodes.map((node) => node.id === source ? nextSrc : node.id === target ? nextDst : node)
  const lead = material ? `Đã nối ${material}${lot !== 1 ? ` ×${lot}/chuyến` : ''}.` : 'Đã tạo đường nối.'
  const detail = [changes.length > 0 ? `Tự thiết lập: ${changes.join('; ')}.` : '', ...guidance.map((item) => `Cần kiểm tra: ${item}.`)].filter(Boolean).join(' ')
  return {
    nodes: nextNodes, material, params,
    note: `${lead}${detail ? ` ${detail}` : ' Tham số hai đầu đã khớp.'}`,
    needsReview: guidance.length > 0,
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
