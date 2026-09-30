import type { LiveMsg, LiveSnapshot, SubjectSnap, Vehicle } from '../api/types'

/** Dữ liệu kèm lúc nhận (Date.now()), để cộng thời gian đã trôi vào tuổi dữ liệu. */
export type Stamped<T> = { data: T; at: number }

function aged<T extends { age_ms: number }>(x: T, extra: number): T {
  return { ...x, age_ms: x.age_ms + extra }
}

/**
 * Ghép bản chụp (GET, mỗi vài giây, có nguồn và lỗi ghép) với bản đẩy WebSocket (mỗi 0,4 giây, chỉ trạng thái và xe).
 * Trạng thái và xe lấy từ bản nào nhận sau. Tuổi dữ liệu (age_ms) được cộng thêm thời gian đã trôi từ lúc nhận: nếu feed
 * ngừng, máy chủ ngừng đẩy nên chỉ cách này client mới thấy dữ liệu đã cũ.
 */
export function mergeLive(base: Stamped<LiveSnapshot> | undefined, push: Stamped<LiveMsg> | undefined, nowMs: number): LiveSnapshot | undefined {
  if (!base && !push) return undefined
  const useBase = base !== undefined && (push === undefined || base.at >= push.at)
  const src = useBase ? base : push
  if (!src) return undefined
  const extra = Math.max(0, nowMs - src.at)
  const state = src.data
  const subjects: Record<string, SubjectSnap> = {}
  for (const [k, v] of Object.entries(state.subjects)) subjects[k] = aged(v, extra)
  const fleet: Record<string, Vehicle[]> = {}
  for (const [k, list] of Object.entries(state.fleet)) fleet[k] = list.map((v) => aged(v, extra))
  return {
    model: state.model,
    now: state.now,
    subjects,
    fleet,
    sources: base?.data.sources ?? [],
    errors: base?.data.errors ?? [],
    bindings: base?.data.bindings ?? 0,
  }
}
