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
