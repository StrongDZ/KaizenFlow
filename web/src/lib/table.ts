export type SortDir = 'asc' | 'desc'
export type Sort = { key: string; dir: SortDir }

/** Bỏ dấu tiếng Việt, hạ chữ thường: để tìm "may dap" ra "Máy dập". */
export function norm(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase()
}

export function filterRows<T>(rows: T[], q: string, fields: (r: T) => (string | undefined | null)[]): T[] {
  const needle = norm(q.trim())
  if (!needle) return rows
  return rows.filter((r) => fields(r).some((f) => f && norm(f).includes(needle)))
}

/** Giá trị null luôn xếp cuối, bất kể chiều. */
export function sortRows<T>(rows: T[], get: ((r: T) => string | number | null) | undefined, dir: SortDir): T[] {
  if (!get) return rows
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = get(a)
    const y = get(b)
    if (x === null && y === null) return 0
    if (x === null) return 1
    if (y === null) return -1
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign
    return String(x).localeCompare(String(y), 'vi') * sign
  })
}

export function nextSort(cur: Sort | null, key: string): Sort {
  if (cur?.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: 'asc' }
}

/** Chọn tối đa hai run để so sánh; chọn thêm thì bỏ lần chọn cũ nhất. */
export function toggleCompare(sel: number[], id: number): number[] {
  if (sel.includes(id)) return sel.filter((x) => x !== id)
  return sel.length >= 2 ? [sel[1], id] : [...sel, id]
}

/** Run cũ hơn (id nhỏ hơn) là "gốc". */
export function comparePath(sel: number[]): string | null {
  if (sel.length !== 2) return null
  const [a, b] = [...sel].sort((x, y) => x - y)
  return `/compare?a=${a}&b=${b}`
}
