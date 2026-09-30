import dagre from '@dagrejs/dagre'

export type Dir = 'LR' | 'TB'
export type Pos = { x: number; y: number }
export type LayoutNode = { id: string; w: number; h: number; pool: boolean }
export type LayoutEdge = { source: string; target: string }

const NODE_GAP = 44
const RANK_GAP = 120
const POOL_GAP = 56

/**
 * Xếp sơ đồ theo tầng (dagre): nguồn ở đầu, đích ở cuối, hướng ngang (LR) hoặc dọc (TB). Trả về góc trên-trái
 * của từng node, bắt đầu từ gốc (0, 0). Vòng lặp làm lại bị dagre tự cắt một cạnh khi xếp tầng.
 * Đội xe/người (pool) không nối bằng edge nên không có tầng: đặt thành một hàng riêng bên dưới (LR) hoặc một cột bên phải (TB).
 */
export function autoLayout(nodes: LayoutNode[], edges: LayoutEdge[], dir: Dir): Record<string, Pos> {
  const flowNodes = nodes.filter((n) => !n.pool)
  const pools = nodes.filter((n) => n.pool)
  const ids = new Set(flowNodes.map((n) => n.id))

  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: dir, nodesep: NODE_GAP, ranksep: RANK_GAP, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of flowNodes) g.setNode(n.id, { width: n.w, height: n.h })
  const seen = new Set<string>()
  for (const e of edges) {
    const key = `${e.source}\u0000${e.target}`
    if (e.source === e.target || !ids.has(e.source) || !ids.has(e.target) || seen.has(key)) continue
    seen.add(key)
    g.setEdge(e.source, e.target)
  }
  dagre.layout(g)

  const out: Record<string, Pos> = {}
  for (const n of flowNodes) {
    const c = g.node(n.id)
    out[n.id] = { x: c.x - n.w / 2, y: c.y - n.h / 2 }
  }

  const right = flowNodes.length ? Math.max(...flowNodes.map((n) => out[n.id].x + n.w)) : 0
  const bottom = flowNodes.length ? Math.max(...flowNodes.map((n) => out[n.id].y + n.h)) : 0
  let cursor = 0
  for (const n of pools) {
    if (dir === 'LR') {
      out[n.id] = { x: cursor, y: flowNodes.length ? bottom + POOL_GAP : 0 }
      cursor += n.w + NODE_GAP
    } else {
      out[n.id] = { x: flowNodes.length ? right + POOL_GAP : 0, y: cursor }
      cursor += n.h + NODE_GAP
    }
  }

  const all = Object.values(out)
  const minX = Math.min(...all.map((p) => p.x))
  const minY = Math.min(...all.map((p) => p.y))
  for (const id of Object.keys(out)) out[id] = { x: Math.round(out[id].x - minX), y: Math.round(out[id].y - minY) }
  return out
}

/** Hướng hiện tại của sơ đồ: theo tổng độ lệch dọc và ngang của các edge. Không đủ dữ kiện thì coi là ngang. */
export function inferDir(pos: Record<string, Pos>, edges: LayoutEdge[]): Dir {
  let dx = 0
  let dy = 0
  for (const e of edges) {
    const a = pos[e.source]
    const b = pos[e.target]
    if (!a || !b) continue
    dx += Math.abs(b.x - a.x)
    dy += Math.abs(b.y - a.y)
  }
  return dy > dx ? 'TB' : 'LR'
}
