import type { Json } from '../api/types'

export type ParsedArray = { ok: true; value: Json[] } | { ok: false; error: string }

/** Đọc một mảng object từ ô văn bản JSON. Ô trống là mảng rỗng. */
export function parseJsonArray(text: string): ParsedArray {
  if (text.trim() === '') return { ok: true, value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `JSON không hợp lệ: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'Cần một mảng JSON, ví dụ [ { … } ].' }
  if (parsed.some((x) => x === null || typeof x !== 'object' || Array.isArray(x))) {
    return { ok: false, error: 'Mỗi phần tử của mảng phải là một object.' }
  }
  return { ok: true, value: parsed as Json[] }
}
