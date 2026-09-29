import type { Edge, EdgeChange, Node, NodeChange } from '@xyflow/react'
import type { ReactNode } from 'react'
import type { Graph, GraphEdge, GraphNode, Json, NodeType } from '../api/types'
import type { PinTone } from './pins'

export type Color = 'GREEN' | 'YELLOW' | 'RED' | 'NONE'
export type Badge = { color: Color | 'INFO'; text: string }

export type PinView = { n: number; tone: PinTone; content: ReactNode }

export type FlowData = {
  key: string
  nodeType: string
  archetype: string
  name: string
  params: Json
  issue?: string
  badge?: Badge
  pins?: PinView[]
  pinState?: { open: number | null; setOpen: (n: number | null) => void }
}
export type EdgeData = { material: string; params: Json }
export type FlowNode = Node<FlowData, 'kf'>
export type FlowEdge = Edge<EdgeData>

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
      },
    }
  })
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

export function edgeKey(src: string, dst: string, existing: string[]): string {
  let key = `${src}>${dst}`
  let i = 2
  while (existing.includes(key)) key = `${src}>${dst}#${i++}`
  return key
}

type Line = { material: string }

export function defaultMaterial(src: FlowNode | undefined, materials: string[]): string {
  if (src?.data.archetype === 'PROCESS') {
    const recipes = src.data.params.recipes as { outputs?: Line[] }[] | undefined
    const out = recipes?.[0]?.outputs ?? []
    if (out.length) return out[0].material
  }
  if (src?.data.archetype === 'SOURCE') {
    const lots = (src.data.params.lots as Line[] | undefined) ?? []
    if (lots.length) return lots[0].material
  }
  return materials[0] ?? ''
}

/** Thay đổi của React Flow có phải chỉnh sửa thật không (chọn, đo kích thước, click không kéo thì không). */
export function isEdit(c: NodeChange | EdgeChange): boolean {
  if (c.type === 'select' || c.type === 'dimensions') return false
  if (c.type === 'position') return c.dragging === true
  return true
}
