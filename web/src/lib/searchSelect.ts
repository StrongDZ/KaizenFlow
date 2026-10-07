/** Lọc và xếp hạng danh sách cho ô chọn có tìm kiếm (SearchSelect). Thuần, để test được. */

export type Option = { value: string; label: string; hint?: string }

/** Chữ thường, bỏ dấu tiếng Việt (đ thành d). */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase()
}

const compact = (s: string) => s.replace(/[^a-z0-9]/g, '')

/** 0: đầu một từ hoặc đầu mã; 1: nằm giữa chuỗi; bỏ: không khớp. Mã gõ liền ("raw01") khớp mã có gạch ("RAW-01"). */
function score(key: string, q: string, qc: string): number | null {
  if (key === '') return null
  const words = key.split(/[^a-z0-9]+/).filter(Boolean)
  if (words.some((w) => w.startsWith(q))) return 0
  const kc = compact(key)
  if (qc !== '' && kc.startsWith(qc)) return 0
  if (key.includes(q) || (qc !== '' && kc.includes(qc))) return 1
  return null
}

export function rankOptions(options: Option[], query: string): Option[] {
  const q = fold(query.trim())
  if (q === '') return options
  const qc = compact(q)
  const scored: { o: Option; s: number; i: number }[] = []
  options.forEach((o, i) => {
    const direct = [fold(o.label), fold(o.value)].map((k) => score(k, q, qc)).filter((s): s is number => s !== null)
    const viaHint = score(fold(o.hint ?? ''), q, qc)
    const best = Math.min(...direct, viaHint === null ? Infinity : viaHint + 0.5)
    if (Number.isFinite(best)) scored.push({ o, s: best, i })
  })
  return scored.sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.o)
}
