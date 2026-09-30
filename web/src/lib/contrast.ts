/** Đo độ tương phản chữ/nền theo WCAG 2.x, và đọc các token màu từ index.css để test không lệch với giao diện thật. */

export type Tokens = Record<string, string>

function channel(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`màu không hợp lệ: ${hex}`)
  const n = parseInt(m[1], 16)
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}

/** Tỉ số tương phản từ 1 đến 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const BLOCK = /(@theme static|\[data-theme='light'\])\s*\{([^}]*)\}/g
const TOKEN = /--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g

/** Token hiệu lực của từng giao diện: sáng kế thừa tối ở những token nó không ghi đè. */
export function parseTokens(css: string): { dark: Tokens; light: Tokens } {
  const dark: Tokens = {}
  const lightOverrides: Tokens = {}
  for (const block of css.matchAll(BLOCK)) {
    const target = block[1].startsWith('@theme') ? dark : lightOverrides
    for (const t of block[2].matchAll(TOKEN)) target[t[1]] = t[2]
  }
  return { dark, light: { ...dark, ...lightOverrides } }
}
