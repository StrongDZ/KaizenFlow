import { describe, expect, it } from 'vitest'
import { extractPath, leafPaths } from './livePath'

const payload = {
  st: 'RUN',
  cnt: { ok: 12, ng: 1 },
  items: [{ sku: 'RAW-01', qty: 320 }, { sku: 'RAW-02', qty: 45 }],
  pos: [1.5, 2.5],
}

describe('extractPath (cùng cú pháp với Go live.Extract)', () => {
  it.each([
    ['st', 'RUN'], ['cnt.ok', 12], ['items[sku=RAW-02].qty', 45], ['items[0].sku', 'RAW-01'], ['pos[1]', 2.5],
  ])('%s', (path, want) => {
    expect(extractPath(payload, path)).toEqual({ ok: true, value: want })
  })
  it.each(['cnt.zzz', 'items[sku=NOPE].qty', 'items[9].qty', 'st.x', 'a..b', 'a[', 'a[x', '[', 'cnt.[0]'])('lỗi: %s', (path) => {
    expect(extractPath(payload, path).ok).toBe(false)
  })
  it('đường dẫn rỗng trả cả payload; mảng gốc có selector', () => {
    expect(extractPath(payload, '')).toEqual({ ok: true, value: payload })
    expect(extractPath([{ id: 'a', v: 1 }], '[id=a].v')).toEqual({ ok: true, value: 1 })
  })
})

describe('leafPaths', () => {
  it('liệt kê trường nguyên thuỷ, mảng đối tượng dùng khoá nhận dạng', () => {
    const got = leafPaths(payload)
    expect(got.map((l) => l.path)).toEqual([
      'st', 'cnt.ok', 'cnt.ng', 'items[sku=RAW-01].qty', 'items[sku=RAW-02].qty', 'pos[0]', 'pos[1]',
    ])
    expect(got.find((l) => l.path === 'items[sku=RAW-02].qty')?.value).toBe(45)
  })
  it('mọi đường dẫn trả ra đều extract lại được đúng giá trị', () => {
    for (const l of leafPaths(payload)) expect(extractPath(payload, l.path)).toEqual({ ok: true, value: l.value })
  })
  it('giới hạn số trường và bỏ qua null', () => {
    const big = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]))
    expect(leafPaths({ ...big, z: null }, 10)).toHaveLength(10)
    expect(leafPaths(null)).toEqual([])
    expect(leafPaths('x')).toEqual([{ path: '', value: 'x' }])
  })
})

import { matchSource } from './livePath'

describe('matchSource (cùng luật với Go)', () => {
  it.each([
    ['plc/prs-02/status', 'plc/prs-02/status', true], ['plc/prs-02/status', 'plc/prs-03/status', false],
    ['plc/+/status', 'plc/prs-02/status', true], ['plc/+/status', 'plc/prs-02/x/status', false],
    ['plc/#', 'plc/prs-02/status', true], ['plc/#', 'plc', true], ['#', 'a/b/c', true],
    ['agv/tug-a/+/pos', 'agv/tug-a/01/pos', true], ['agv/tug-a/+/pos', 'agv/tug-b/01/pos', false],
    ['', 'x', false], ['a/#/b', 'a/x/b', false],
  ])('%s vs %s', (pattern, source, want) => {
    expect(matchSource(pattern, source)).toBe(want)
  })
})
