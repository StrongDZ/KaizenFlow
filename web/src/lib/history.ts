/**
 * Lịch sử hoàn tác/làm lại. Không phụ thuộc React: giữ các trạng thái trước mỗi lần sửa; trạng thái nào cũng là dữ liệu
 * bất biến nên chỉ cần giữ tham chiếu, không sao chép.
 */
export type History<T> = { past: T[]; future: T[]; key: string | null; at: number }

export const emptyHistory = <T>(): History<T> => ({ past: [], future: [], key: null, at: 0 })
export const canUndo = <T>(h: History<T>): boolean => h.past.length > 0
export const canRedo = <T>(h: History<T>): boolean => h.future.length > 0

type RecordOpts = { key?: string; now?: number; window?: number; limit?: number }

/**
 * Ghi lại trạng thái TRƯỚC khi sửa. Các lần sửa liền nhau của cùng một `key` (gõ một con số, kéo một ô trượt) trong
 * `window` ms tính là một bước, để một lần hoàn tác trả về trạng thái trước khi bắt đầu gõ.
 */
export function record<T>(h: History<T>, before: T, { key, now = Date.now(), window = 1000, limit = 100 }: RecordOpts = {}): History<T> {
  if (key !== undefined && h.key === key && now - h.at < window) return { ...h, at: now }
  const past = [...h.past, before]
  return { past: past.length > limit ? past.slice(past.length - limit) : past, future: [], key: key ?? null, at: now }
}

export function undo<T>(h: History<T>, current: T): { history: History<T>; state: T } | null {
  if (h.past.length === 0) return null
  return { state: h.past[h.past.length - 1], history: { past: h.past.slice(0, -1), future: [current, ...h.future], key: null, at: 0 } }
}

export function redo<T>(h: History<T>, current: T): { history: History<T>; state: T } | null {
  if (h.future.length === 0) return null
  return { state: h.future[0], history: { past: [...h.past, current], future: h.future.slice(1), key: null, at: 0 } }
}
