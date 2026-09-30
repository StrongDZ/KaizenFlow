import { describe, expect, it } from 'vitest'
import css from '../index.css?raw'
import { contrast, luminance, parseTokens } from './contrast'

describe('contrast', () => {
  it('đen trên trắng là 21, cùng màu là 1', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#336699', '#336699')).toBeCloseTo(1, 5)
  })
  it('không phụ thuộc thứ tự', () => {
    expect(contrast('#ffffff', '#1d5fd1')).toBeCloseTo(contrast('#1d5fd1', '#ffffff'), 10)
  })
  it('từ chối màu sai cú pháp', () => {
    expect(() => luminance('xanh')).toThrow()
  })
})

describe('parseTokens', () => {
  it('sáng kế thừa tối ở token không ghi đè', () => {
    const { dark, light } = parseTokens(`@theme static { --color-a: #111111; --color-b: #222222; }\n[data-theme='light'] { --color-a: #eeeeee; }`)
    expect(dark).toEqual({ a: '#111111', b: '#222222' })
    expect(light).toEqual({ a: '#eeeeee', b: '#222222' })
  })
})

/** Mỗi cặp (chữ, nền) của nút trong ui.tsx. Nền "bề mặt" là nơi nút viền có thể nằm. */
const SURFACES = ['bg', 'panel', 'panel-2', 'raised']
const SOLID: [string, string][] = [
  ['on-accent', 'accent'],
  ['on-ok', 'ok-solid'],
  ['on-warn', 'warn'],
  ['bg', 'bad'],
]
const OUTLINE_TEXT = ['accent', 'ok-solid', 'bad-text']

describe.each(['dark', 'light'] as const)('độ tương phản của nút, giao diện %s', (theme) => {
  const t = parseTokens(css)[theme]
  it.each(SOLID)('nút đặc: chữ %s trên nền %s đạt 4,5:1', (fg, bg) => {
    expect(t[fg], `thiếu token ${fg}`).toBeDefined()
    expect(t[bg], `thiếu token ${bg}`).toBeDefined()
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5)
  })
  it.each(OUTLINE_TEXT.flatMap((fg) => SURFACES.map((s) => [fg, s] as const)))('nút viền: chữ %s trên bề mặt %s đạt 4,5:1', (fg, surface) => {
    expect(t[fg], `thiếu token ${fg}`).toBeDefined()
    expect(contrast(t[fg], t[surface])).toBeGreaterThanOrEqual(4.5)
  })
})

import ui from '../components/ui.tsx?raw'

describe('hàm style nút trong ui.tsx', () => {
  it('chỉ dùng token màu có thật (gõ sai tên thì Tailwind lặng lẽ bỏ class)', () => {
    const known = new Set(Object.keys(parseTokens(css).dark))
    const lines = ui.split('\n').filter((l) => /^export const btn\w* =/.test(l) || /^export const btn\w* = `/.test(l))
    expect(lines.length).toBeGreaterThanOrEqual(9)
    const colour = /(?:bg|text|border)-((?:accent|on-accent|ok-solid|on-ok|warn|on-warn|bad-text|bad-bg|bad|bg|text-2|text|muted|line-2|line|panel-2|panel|raised|faint|ok)\b)/g
    const used = lines.flatMap((l) => [...l.matchAll(colour)].map((m) => m[1]))
    expect(used.length).toBeGreaterThan(10)
    for (const name of used) expect(known.has(name), `token --color-${name} không có trong index.css`).toBe(true)
  })
})
