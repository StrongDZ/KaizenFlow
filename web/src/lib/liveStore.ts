import type { LiveMsg } from '../api/types'
import type { Stamped } from './liveMerge'

/** Kho nhỏ giữ bản tin WebSocket mới nhất của từng mô hình; component đọc qua useSyncExternalStore. */
const latest = new Map<string, Stamped<LiveMsg>>()
const listeners = new Set<() => void>()

export function pushLive(msg: LiveMsg, at = Date.now()): void {
  latest.set(msg.model, { data: msg, at })
  listeners.forEach((l) => l())
}

export function getLive(model: string): Stamped<LiveMsg> | undefined {
  return latest.get(model)
}

export function forgetLive(model: string): void {
  latest.delete(model)
  listeners.forEach((l) => l())
}

export function subscribeLive(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
