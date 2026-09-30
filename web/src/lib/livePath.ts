/**
 * Trích một giá trị trong payload theo đường dẫn: `a.b`, `a[0]`, `a[sku=RAW-01].qty`.
 * Cùng cú pháp với Go `live.Extract` (nơi chuẩn hoá thật); bản này chỉ để xem trước trên giao diện.
 */
export type Extracted = { ok: boolean; value?: unknown }

const FAIL: Extracted = { ok: false }

function pick(arr: unknown[], sel: string): Extracted {
  const eq = sel.indexOf('=')
  if (eq >= 0) {
    const key = sel.slice(0, eq)
    const val = sel.slice(eq + 1)
    for (const el of arr) {
      if (el && typeof el === 'object' && !Array.isArray(el) && String((el as Record<string, unknown>)[key]) === val) return { ok: true, value: el }
    }
    return FAIL
  }
  if (!/^\d+$/.test(sel)) return FAIL
  const i = Number(sel)
  return i < arr.length ? { ok: true, value: arr[i] } : FAIL
}

export function extractPath(payload: unknown, path: string): Extracted {
  if (path === '') return { ok: true, value: payload }
  let cur: unknown = payload
  const n = path.length
  let first = true
  for (let i = 0; i < n; ) {
    let j = i
    while (j < n && path[j] !== '.' && path[j] !== '[') j++
    const name = path.slice(i, j)
    if (name === '' && !(first && j < n && path[j] === '[')) return FAIL
    if (name !== '') {
      if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !(name in (cur as object))) return FAIL
      cur = (cur as Record<string, unknown>)[name]
    }
    while (j < n && path[j] === '[') {
      const k = path.indexOf(']', j)
      if (k < 0) return FAIL
      const sel = path.slice(j + 1, k)
      j = k + 1
      if (!Array.isArray(cur)) return FAIL
      const got = pick(cur, sel)
      if (!got.ok) return FAIL
      cur = got.value
    }
    first = false
    if (j < n) {
      if (path[j] !== '.') return FAIL
      j++
      if (j >= n) return FAIL
    }
    i = j
  }
  return { ok: true, value: cur }
}

export type Leaf = { path: string; value: string | number | boolean }

/** Khoá dùng để nhận dạng phần tử trong mảng đối tượng (vd. `items[sku=RAW-01]`). */
const IDENTITY_KEYS = ['sku', 'material', 'id', 'code', 'key', 'name']

function identityKey(arr: unknown[]): string | undefined {
  const objs = arr.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
  if (objs.length !== arr.length || objs.length === 0) return undefined
  return IDENTITY_KEYS.find((k) => objs.every((o) => typeof o[k] === 'string'))
}

/** Liệt kê mọi trường nguyên thuỷ của payload kèm đường dẫn trích được, để người dùng bấm chọn thay vì gõ. */
export function leafPaths(payload: unknown, max = 40): Leaf[] {
  const out: Leaf[] = []
  const walk = (v: unknown, path: string, skip?: string) => {
    if (out.length >= max || v === null || v === undefined) return
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out.push({ path, value: v })
    } else if (Array.isArray(v)) {
      const key = identityKey(v)
      v.forEach((el, i) => walk(el, key ? `${path}[${key}=${(el as Record<string, string>)[key]}]` : `${path}[${i}]`, key))
    } else if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === skip) continue
        walk(x, path === '' ? k : `${path}.${k}`)
      }
    }
  }
  walk(payload, '')
  return out
}

/** Mẫu nguồn kiểu MQTT: `+` một cấp, `#` phần còn lại (chỉ ở cuối). Cùng luật với Go `live.MatchSource`. */
export function matchSource(pattern: string, source: string): boolean {
  if (pattern === '') return false
  const p = pattern.split('/')
  const s = source.split('/')
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return i === p.length - 1
    if (i >= s.length) return false
    if (p[i] !== '+' && p[i] !== s[i]) return false
  }
  return p.length === s.length
}
