import type { Json } from '../api/types'

const PATH_LABEL: Record<string, string> = { '/count': 'số lượng', '/stock': 'tồn kho đầu kỳ' }

const num = (v: number) => String(v).replace('.', ',')

/** Thời lượng scenario đủ gọn cho bảng nhưng không làm mất phần phút như phép chia `/ 3600`. */
export function formatScenarioDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} phút`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} giờ` : `${hours} giờ ${rest} phút`
}

/** Nhãn ngắn cho một injection, dùng thống nhất ở timeline setup và trang chi tiết. */
export function describeInjection(i: Json): { atS: number; label: string; detail: string } {
  const target = String(i.target ?? 'Không rõ máy')
  const failure = typeof i.failure === 'string' && i.failure ? i.failure : null
  const kind = typeof i.kind === 'string' ? i.kind : null
  const atS = Number(i.at_s)
  const durationS = Number(i.duration_s)
  const detail = failure
    ? `Lỗi ${failure}`
    : kind === 'planned_stop'
      ? `Dừng có kế hoạch${Number.isFinite(durationS) ? ` trong ${formatScenarioDuration(durationS)}` : ''}`
      : kind ?? 'Sự kiện'
  return { atS: Number.isFinite(atS) ? Math.max(0, atS) : 0, label: target, detail }
}

/** Một giá trị thay đổi nguồn lực thành chữ đọc được; đối tượng không rõ dạng thì in JSON gọn, không bao giờ để lộ "[object Object]". */
function valueLines(path: string, value: unknown): string[] {
  if (typeof value === 'number') return [num(value)]
  if (path === '/stock' && Array.isArray(value)) {
    return value.map((r) => {
      const row = r as Record<string, unknown>
      const max = typeof row.max === 'number' ? ` (tối đa ${num(row.max)})` : ''
      return `${String(row.material)}: ${num(Number(row.initial))}${max}`
    })
  }
  if (typeof value === 'string') return [value]
  return [JSON.stringify(value)]
}

/** Dòng "thay đổi nguồn lực" của scenario: nhãn (đối tượng + thứ bị đổi) và các dòng giá trị. */
export function describeOverride(o: Json): { label: string; lines: string[] } {
  const target = String(o.target)
  const path = String(o.path)
  const known = PATH_LABEL[path]
  return { label: known ? `${target} · ${known}` : `${target}${path}`, lines: valueLines(path, o.value) }
}
