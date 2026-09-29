import type { GraphNode, NodeType } from '../api/types'
import { poolCount, thresholdsFor } from './model'
import { colorFor, series, valueAt, type BandIndex } from './replay'

export type PoolChip = { key: string; name: string; busy: number; count: number }
export type AtCursor = { red: number; yellow: number; pools: PoolChip[] }
export const MAX_POOL_CHIPS = 3

/** Số liệu tại thời điểm t, tính từ p50 của bands (không phải KPI tổng hợp cả run). */
export function atCursor(idx: BandIndex, nodes: GraphNode[], types: Record<string, NodeType>, t: number): AtCursor {
  let red = 0
  let yellow = 0
  const pools: PoolChip[] = []
  for (const n of nodes) {
    const ref = { node_type: n.node_type, params: n.params ?? {} }
    if (n.archetype === 'STORAGE') {
      const cov = valueAt(series(idx, n.key, 'coverage_h'), t)?.p50
      const color = colorFor(cov, thresholdsFor(ref, types))
      if (color === 'RED') red++
      else if (color === 'YELLOW') yellow++
    } else if (n.archetype === 'RESOURCE_POOL' && pools.length < MAX_POOL_CHIPS) {
      const busy = valueAt(series(idx, n.key, 'busy'), t)?.p50
      if (busy !== undefined) {
        pools.push({ key: n.key, name: n.name || types[n.node_type]?.name || n.key, busy: Math.round(busy), count: poolCount(ref, types) })
      }
    }
  }
  return { red, yellow, pools }
}
