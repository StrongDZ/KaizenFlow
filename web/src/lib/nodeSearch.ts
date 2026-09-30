import type { NodeType } from '../api/types'
import { norm } from './table'

const FLOW_ORDER = ['SOURCE', 'STORAGE', 'PROCESS', 'SINK', 'RESOURCE_POOL']
const flowRank = (t: NodeType) => {
  const i = FLOW_ORDER.indexOf(t.archetype)
  return i === -1 ? FLOW_ORDER.length : i
}
const byFlow = (a: NodeType, b: NodeType) => flowRank(a) - flowRank(b) || a.name.localeCompare(b.name, 'vi')

/**
 * Tìm loại node theo tên (gõ không dấu cũng được) hoặc mã. Ô trống trả tất cả theo thứ tự dòng chảy (nguồn, kho, trạm, đích, đội xe).
 * Có chữ thì tên bắt đầu bằng chữ đó xếp trước, rồi tên có từ bắt đầu bằng chữ đó, rồi tên hoặc mã chứa chữ đó.
 */
export function searchTypes(types: NodeType[], q: string, opts: { allow?: (t: NodeType) => boolean } = {}): NodeType[] {
  const pool = opts.allow ? types.filter(opts.allow) : types
  const needle = norm(q.trim())
  if (!needle) return [...pool].sort(byFlow)
  const scored: [number, NodeType][] = []
  for (const t of pool) {
    const name = norm(t.name)
    const code = norm(t.code)
    let rank: number
    if (name.startsWith(needle)) rank = 0
    else if (name.split(/[\s(]+/).some((w) => w.startsWith(needle))) rank = 1
    else if (name.includes(needle) || code.includes(needle)) rank = 2
    else continue
    scored.push([rank, t])
  }
  return scored.sort(([ra, a], [rb, b]) => ra - rb || byFlow(a, b)).map(([, t]) => t)
}
