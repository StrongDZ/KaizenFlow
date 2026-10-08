import type { AgvMap, GraphEdge } from '../api/types'
import type { MapProblem } from './zones'

export type RouteStatus = 'ok' | 'no_station' | 'no_path' | 'no_return'

/**
 * Đường nối do xe chở từ node `src` tới `dst` có chạy được trên bản đồ không: cần trạm ở cả hai đầu và có đường đi lẫn đường về giữa
 * một cặp trạm (xe luôn quay lại trạm nguồn sau mỗi chuyến). Cùng luật với server (`AgvMap.Route`), dùng để báo ngay khi đang vẽ.
 */
export function routeStatus(m: AgvMap, src: string, dst: string): RouteStatus {
  const a = m.points.filter((p) => p.kind === 'station' && p.node_key === src).map((p) => p.id)
  const b = m.points.filter((p) => p.kind === 'station' && p.node_key === dst).map((p) => p.id)
  if (a.length === 0 || b.length === 0) return 'no_station'
  const out = new Map<string, string[]>()
  for (const l of m.lanes) out.set(l.from, [...(out.get(l.from) ?? []), l.to])
  const reach = (from: string): Set<string> => {
    const seen = new Set([from])
    const stack = [from]
    while (stack.length > 0) {
      const u = stack.pop()!
      for (const v of out.get(u) ?? []) if (!seen.has(v)) { seen.add(v); stack.push(v) }
    }
    return seen
  }
  let forward = false
  for (const s of a) {
    const fromS = reach(s)
    for (const d of b) {
      if (!fromS.has(d)) continue
      forward = true
      if (reach(d).has(s)) return 'ok'
    }
  }
  return forward ? 'no_return' : 'no_path'
}

/** Cảnh báo cho từng đường nối do xe chở (POOL) mà bản đồ không cho chạy. Bản đồ chưa có điểm nào thì chưa có gì để cảnh báo. */
export function connectivityProblems(m: AgvMap, edges: GraphEdge[], names: Record<string, string>): MapProblem[] {
  if (m.points.length === 0) return []
  const out: MapProblem[] = []
  for (const e of edges) {
    if (e.params?.mode !== 'POOL') continue
    const src = names[e.src] ?? e.src
    const dst = names[e.dst] ?? e.dst
    switch (routeStatus(m, e.src, e.dst)) {
      case 'no_station':
        out.push({ key: e.key, warn: true, message: `${src} hoặc ${dst} chưa có trạm trên bản đồ: xe chạy theo thời gian ước tính, không theo bản đồ` })
        break
      case 'no_path':
        out.push({ key: e.key, warn: true, message: `không có đường đi từ ${src} tới ${dst}, xe sẽ chờ mãi` })
        break
      case 'no_return':
        out.push({ key: e.key, warn: true, message: `xe tới được ${dst} nhưng không có đường về ${src}, xe sẽ kẹt sau chuyến đầu` })
        break
    }
  }
  return out
}
