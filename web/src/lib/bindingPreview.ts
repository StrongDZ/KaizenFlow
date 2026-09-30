import type { Transform } from '../api/types'
import { extractPath } from './livePath'

export type Preview = { ok: true; text: string } | { ok: false; reason: string }

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}
const fmt = (x: number) => String(Number(x.toFixed(3))).replace('.', ',')

/** Xem trước giá trị chuẩn hoá của một ghép nối từ bản tin mới nhất; cùng luật với Go `live.Normalize`. */
export function previewBinding(last: unknown, path: string, kind: 'number' | 'text' | 'fleet', t: Transform): Preview {
  if (kind === 'fleet') {
    const f = (name: string, dflt: string) => extractPath(last, t.fields?.[name] || dflt)
    const id = f('id', 'id')
    const x = num(f('x', 'x').value)
    const y = num(f('y', 'y').value)
    if (!id.ok || x === undefined || y === undefined) return { ok: false, reason: 'Bản tin xe cần có id và toạ độ x, y' }
    return { ok: true, text: `xe ${String(id.value)} tại (${fmt(x).replace(',', '.')}, ${fmt(y).replace(',', '.')})` }
  }
  const got = extractPath(last, path)
  if (!got.ok) return { ok: false, reason: `Không thấy trường "${path}" trong bản tin` }
  if (kind === 'text') {
    const raw = String(got.value)
    const enumMap = t.enum ?? {}
    if (Object.keys(enumMap).length === 0) return { ok: true, text: raw.toUpperCase() }
    const mapped = enumMap[raw] ?? enumMap[raw.toUpperCase()]
    return mapped === undefined ? { ok: false, reason: `Giá trị "${raw}" chưa có trong bảng đổi trạng thái` } : { ok: true, text: mapped }
  }
  const n = num(got.value)
  if (n === undefined) return { ok: false, reason: `Giá trị "${String(got.value)}" không phải số` }
  return { ok: true, text: fmt(n * (t.scale ?? 1) + (t.offset ?? 0)) }
}
