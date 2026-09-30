import type { DataSourceRow } from '../api/types'

/** "vừa xong", "12 giây trước", "3 phút trước"… từ số mili giây đã trôi qua. */
export function ageText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 2) return 'vừa xong'
  if (s < 60) return `${s} giây trước`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} phút trước`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} giờ trước`
  return `${Math.floor(h / 24)} ngày trước`
}

/** Tốc độ phát: "240 bản tin/phút", hoặc "1 bản tin/2 phút" khi thưa. */
export function rateText(perMin: number): string {
  if (!(perMin > 0)) return '—'
  if (perMin >= 1) return `${Math.round(perMin)} bản tin/phút`
  return `1 bản tin/${Math.round(1 / perMin)} phút`
}

export function summarizeSources(rows: DataSourceRow[]): { total: number; live: number; unbound: number } {
  return { total: rows.length, live: rows.filter((r) => r.live).length, unbound: rows.filter((r) => r.bindings.length === 0).length }
}

/** Lỗi của tên nguồn khi khai báo tay (null là hợp lệ). Cùng luật với server. */
export function validSourceName(name: string): string | null {
  const n = name.trim()
  if (n === '') return 'Nguồn cần một tên, ví dụ plc/prs-02/status.'
  if (/\s/.test(n)) return 'Tên nguồn không có khoảng trắng.'
  if (n.length > 200) return 'Tên nguồn dài tối đa 200 ký tự.'
  return null
}

export type SampleParse = { ok: true; value: unknown } | { ok: false; error: string }

/** Đọc bản tin mẫu người dùng dán. Để trống là không có mẫu. */
export function parseSample(text: string): SampleParse {
  if (text.trim() === '') return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, error: 'Bản tin mẫu không phải JSON hợp lệ. Kiểm tra dấu ngoặc, dấu phẩy và dấu nháy kép quanh tên trường.' }
  }
}
