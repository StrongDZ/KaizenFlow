import type { RunStatus } from '../api/types'

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
}

const RUN_STATUS: Record<RunStatus, string> = { QUEUED: 'Chờ chạy', RUNNING: 'Đang chạy', DONE: 'Đã xong', FAILED: 'Lỗi' }
export function statusLabel(s: RunStatus): string {
  return RUN_STATUS[s]
}

const VERSION_STATUS: Record<string, string> = { DRAFT: 'Nháp', PUBLISHED: 'Đã Publish', ARCHIVED: 'Lưu trữ' }
export function versionStatusLabel(s: string): string {
  return VERSION_STATUS[s] ?? s
}

/** +12,3 / −4,0 / 0,0 (dùng dấu trừ thật U+2212, dấu phẩy thập phân). */
export function fmtDelta(d: number): string {
  if (Math.abs(d) < 0.05) return '0,0'
  return (d > 0 ? '+' : '−') + Math.abs(d).toFixed(1).replace('.', ',')
}

export function fmtStep(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} phút mỗi bước`
  return `${Math.max(1, Math.round(ms / 1000))} giây mỗi bước`
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  return new Date(t).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function fmtDuration(startIso: string, endIso: string | null): string {
  if (!endIso) return '—'
  const s = Math.round((Date.parse(endIso) - Date.parse(startIso)) / 1000)
  if (!Number.isFinite(s) || s < 0) return '—'
  if (s < 60) return `${s} giây`
  if (s < 3600) return `${Math.floor(s / 60)} phút`
  const m = Math.floor((s % 3600) / 60)
  return m ? `${Math.floor(s / 3600)} giờ ${m} phút` : `${Math.floor(s / 3600)} giờ`
}

export function usedIn(n: number | undefined): string {
  if (n === undefined) return '—'
  return n === 0 ? 'chưa dùng' : `${n} version`
}
