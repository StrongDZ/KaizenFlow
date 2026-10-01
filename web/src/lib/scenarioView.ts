import type { Json } from '../api/types'

const PATH_LABEL: Record<string, string> = { '/count': 'số lượng', '/stock': 'tồn kho đầu kỳ' }

const num = (v: number) => String(v).replace('.', ',')

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
