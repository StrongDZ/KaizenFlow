import { describe, expect, it } from 'vitest'
import type { AgvMap, Pt } from '../api/types'
import { roadsOf } from './roads'
import { grayFromRGBA, otsu, simplify, traceFree, traceToMap, type Gray, type TraceOptions } from './traceMap'
import { keepoutProblems, segmentEntersPolygon } from './zones'

// --- ảnh tổng hợp: 255 = sáng, 0 = tối -----------------------------------------------------------
const blank = (w: number, h: number): Gray => ({ w, h, data: new Uint8Array(w * h).fill(255) })
const rect = (g: Gray, x0: number, y0: number, x1: number, y1: number, v: number) => {
  for (let y = Math.max(0, y0); y < Math.min(g.h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(g.w, x1); x++) g.data[y * g.w + x] = v
}
/** Ảnh toàn tường (tối) với các hành lang sáng khoét ra; viền ngoài luôn là tường. */
const walled = (w: number, h: number, corridors: [number, number, number, number][]): Gray => {
  const g = blank(w, h)
  rect(g, 0, 0, w, h, 0)
  for (const [x0, y0, x1, y1] of corridors) rect(g, x0, y0, x1, y1, 255)
  return g
}
const opts = (over: Partial<TraceOptions> = {}): TraceOptions => ({
  mPerPx: 0.1, origin: { x: 0, y: 0 }, freeIs: 'light', minWidthM: 1, spurM: 3, simplifyM: 0.3, excludeOutside: true, ...over,
})
const edgePts = (t: ReturnType<typeof traceFree>, i: number): Pt[] => {
  const e = t.edges[i]
  const a = t.nodes.find((n) => n.id === e.a)!
  const b = t.nodes.find((n) => n.id === e.b)!
  return [{ x: a.x, y: a.y }, ...e.via, { x: b.x, y: b.y }]
}

describe('ngưỡng sáng/tối (Otsu)', () => {
  it('ảnh hai mức xám thì ngưỡng nằm giữa hai mức', () => {
    const g = blank(20, 10)
    rect(g, 0, 0, 10, 10, 40)
    rect(g, 10, 0, 20, 10, 210)
    const t = otsu(g)
    expect(t).toBeGreaterThanOrEqual(40)
    expect(t).toBeLessThan(210)
  })
  it('đổi từ RGBA sang xám theo độ sáng cảm nhận', () => {
    const px = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255])
    const g = grayFromRGBA(px, 4, 1)
    expect(g.data[0]).toBe(255)
    expect(g.data[1]).toBe(0)
    expect(g.data[2]).toBeLessThan(g.data[3])  // đỏ tối hơn xanh lá
  })
})

describe('đơn giản hoá đường gấp khúc', () => {
  it('bỏ các điểm nằm trong sai số, giữ điểm gãy thật', () => {
    const line: Pt[] = [{ x: 0, y: 0 }, { x: 5, y: 0.05 }, { x: 10, y: 0 }, { x: 10, y: 10 }]
    expect(simplify(line, 0.2)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])
    expect(simplify(line, 0)).toHaveLength(4)
    expect(simplify([{ x: 1, y: 1 }], 1)).toEqual([{ x: 1, y: 1 }])
  })
})

describe('dò đường từ ảnh', () => {
  it('một hành lang thẳng thành một đường, dài đúng, nằm giữa hành lang, không có điểm uốn thừa', () => {
    const g = walled(200, 60, [[3, 20, 197, 40]])  // rộng 2 m, dài 19,4 m
    const t = traceFree(g, opts())
    expect(t.edges).toHaveLength(1)
    expect(t.nodes).toHaveLength(2)
    const pts = edgePts(t, 0)
    expect(pts.every((p) => Math.abs(p.y - 3) < 0.25)).toBe(true)
    const len = Math.abs(pts[pts.length - 1].x - pts[0].x)
    expect(len).toBeGreaterThan(17)
    expect(len).toBeLessThan(19.5)
    expect(t.edges[0].via).toEqual([])
    expect(t.edges[0].widthM).toBeGreaterThan(1.6)
    expect(t.edges[0].widthM).toBeLessThan(2.4)
  })

  it('toạ độ ra mét theo gốc và tỉ lệ của ảnh', () => {
    const g = walled(200, 60, [[3, 20, 197, 40]])
    const t = traceFree(g, opts({ origin: { x: 10, y: 20 }, mPerPx: 0.2 }))
    const pts = edgePts(t, 0)
    expect(pts.every((p) => Math.abs(p.y - (20 + 6)) < 0.5)).toBe(true)   // giữa hành lang: 30 px × 0,2
    expect(Math.min(...pts.map((p) => p.x))).toBeGreaterThan(10 + 3 * 0.2)
    expect(Math.max(...pts.map((p) => p.x))).toBeLessThan(10 + 197 * 0.2)
  })

  it('hai hành lang cắt nhau thành một ngã tư và bốn đường cụt dài', () => {
    const g = walled(240, 240, [[3, 110, 237, 130], [110, 3, 130, 237]])
    const t = traceFree(g, opts())
    expect(t.nodes).toHaveLength(5)
    expect(t.edges).toHaveLength(4)
    const deg = new Map<number, number>()
    for (const e of t.edges) { deg.set(e.a, (deg.get(e.a) ?? 0) + 1); deg.set(e.b, (deg.get(e.b) ?? 0) + 1) }
    expect([...deg.values()].sort()).toEqual([1, 1, 1, 1, 4])
    const hub = t.nodes.find((n) => deg.get(n.id) === 4)!
    expect(hub.x).toBeCloseTo(12, 0)
    expect(hub.y).toBeCloseTo(12, 0)
  })

  it('hành lang gãy khúc: mọi cạnh tách đúng ở chỗ rẽ, không để điểm uốn lạc ra ngoài hành lang', () => {
    const g = walled(200, 200, [[3, 20, 100, 40], [80, 20, 100, 180]])  // chữ L
    const t = traceFree(g, opts())
    expect(t.edges).toHaveLength(1)
    const pts = edgePts(t, 0)
    expect(pts.length).toBeGreaterThanOrEqual(3)           // có ít nhất một điểm gãy ở chỗ rẽ
    for (const p of pts) {
      const px = p.x / 0.1, py = p.y / 0.1
      const inH = px >= 3 && px < 100 && py >= 20 && py < 40
      const inV = px >= 80 && px < 100 && py >= 20 && py < 180
      expect(inH || inV).toBe(true)
    }
  })

  it('vòng khép kín không có ngã rẽ vẫn ra đường hợp lệ: không có cạnh nối một điểm với chính nó', () => {
    const g = walled(200, 200, [[10, 10, 190, 40], [10, 160, 190, 190], [10, 10, 40, 190], [160, 10, 190, 190]])
    const t = traceFree(g, opts())
    expect(t.edges.length).toBeGreaterThanOrEqual(2)
    for (const e of t.edges) expect(e.a).not.toBe(e.b)
    const total = t.edges.reduce((a, e) => a + e.lengthM, 0)
    expect(total).toBeGreaterThan(50)    // chu vi đường giữa ≈ 4 × 15 m = 60 m
    expect(total).toBeLessThan(70)
  })

  it('cắt nhánh cụt ngắn (một ngách 2 m), đặt 0 thì giữ lại', () => {
    const g = walled(200, 100, [[3, 40, 197, 60], [90, 20, 110, 40]])  // hành lang chính có một ngách ngắn đi lên
    const pruned = traceFree(g, opts({ spurM: 3 }))
    const kept = traceFree(g, opts({ spurM: 0 }))
    expect(pruned.edges).toHaveLength(1)
    expect(pruned.nodes).toHaveLength(2)
    expect(kept.edges).toHaveLength(3)
  })

  it('bỏ lối đi hẹp hơn bề rộng tối thiểu của xe', () => {
    const g = walled(200, 100, [[3, 20, 197, 30], [3, 60, 197, 90]])  // 1 m và 3 m
    const t = traceFree(g, opts({ minWidthM: 1.5 }))
    expect(t.edges).toHaveLength(1)
    expect(edgePts(t, 0).every((p) => p.y > 5)).toBe(true)  // chỉ còn lối rộng 3 m (y ≈ 7,5 m)
  })

  it('vùng cấm được loại khỏi vùng đi được: không đường nào đi vào, hành lang bị chia đôi', () => {
    const g = walled(300, 60, [[3, 20, 297, 40]])
    const keepout = { id: 'K01', poly: [{ x: 13, y: 0 }, { x: 17, y: 0 }, { x: 17, y: 6 }, { x: 13, y: 6 }] }
    const t = traceFree(g, opts({ keepouts: [keepout] }))
    expect(t.edges).toHaveLength(2)
    for (let i = 0; i < t.edges.length; i++) {
      const pts = edgePts(t, i)
      for (let k = 1; k < pts.length; k++) expect(segmentEntersPolygon(pts[k - 1], pts[k], keepout.poly)).toBe(false)
    }
  })

  it('bỏ các mảnh rời ngắn (cụm đường tổng dài dưới ngưỡng), giữ cụm dài', () => {
    // hành lang dài 19 m và một hành lang rời hẳn dài khoảng 7 m (dài hơn ngưỡng cắt nhánh cụt nhưng ngắn hơn 10 m)
    const g = walled(300, 60, [[3, 20, 197, 40], [215, 20, 297, 40]])
    expect(traceFree(g, opts()).edges).toHaveLength(2)
    const t = traceFree(g, opts({ minComponentM: 10 }))
    expect(t.edges).toHaveLength(1)
    expect(t.edges[0].lengthM).toBeGreaterThan(15)
  })

  it('chữ và nét nhỏ trong hành lang không làm đứt đường', () => {
    const g = walled(200, 60, [[3, 20, 197, 40]])
    for (const x of [50, 90, 130]) rect(g, x, 28, x + 3, 32, 0)  // ba chấm tối 3×4 px giữa hành lang
    const t = traceFree(g, opts({ minSpeckPx: 30 }))
    expect(t.edges).toHaveLength(1)
  })

  it('phần ngoài tường ngoài bị bỏ khi bật, giữ khi tắt', () => {
    const g = blank(260, 100)  // nền sáng
    rect(g, 30, 10, 230, 90, 0)            // toà nhà
    rect(g, 33, 40, 227, 60, 255)          // hành lang bên trong
    const on = traceFree(g, opts({ excludeOutside: true }))
    expect(on.edges).toHaveLength(1)
    const off = traceFree(g, opts({ excludeOutside: false }))
    expect(off.edges.length).toBeGreaterThan(1)
  })

  it('ảnh đảo màu (đường tối, vật cản sáng) cho cùng kết quả khi chọn freeIs = dark', () => {
    const g = walled(200, 60, [[3, 20, 197, 40]])
    const inv: Gray = { w: g.w, h: g.h, data: g.data.map((v) => 255 - v) }
    const a = traceFree(g, opts())
    const b = traceFree(inv, opts({ freeIs: 'dark' }))
    expect(b.edges).toHaveLength(a.edges.length)
    expect(b.edges[0].lengthM).toBeCloseTo(a.edges[0].lengthM, 1)
  })

  it('ảnh không có chỗ nào đi được thì ra kết quả rỗng kèm lời giải thích, không lỗi', () => {
    const t = traceFree(walled(80, 80, []), opts())
    expect(t.edges).toEqual([])
    expect(t.note).toMatch(/không tìm thấy/)
  })
})

describe('mặt bằng thật hơn: lưới dãy máy', () => {
  // 1200×800 px (120×80 m): tường bao, 4 cột × 3 hàng khối máy, hành lang 2 m giữa các khối, một dòng chữ nằm trong hành lang
  const plan = (): Gray => {
    const g = blank(1200, 800)
    rect(g, 0, 0, 1200, 14, 0); rect(g, 0, 786, 1200, 800, 0); rect(g, 0, 0, 14, 800, 0); rect(g, 1186, 0, 1200, 800, 0)
    for (const [x, w] of [[80, 300], [380, 300], [680, 260], [1000, 160]]) for (const [y, h] of [[80, 200], [340, 160], [560, 170]]) rect(g, x + 10, y + 10, x + w - 10, y + h - 10, 0)
    rect(g, 560, 322, 640, 336, 0)
    return g
  }

  it('ra một đồ thị liền, không có làn tự nối chính nó, mọi điểm của đường nằm trong hành lang', () => {
    const g = plan()
    const t = traceFree(g, opts({ minWidthM: 1.5, minSpeckPx: 400 }))
    expect(t.edges.length).toBeGreaterThan(10)
    const parent = t.nodes.map((n) => n.id)
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])))
    for (const e of t.edges) { expect(e.a).not.toBe(e.b); parent[find(e.a)] = find(e.b) }
    expect(new Set(t.nodes.map((n) => find(n.id))).size).toBe(1)
    for (let i = 0; i < t.edges.length; i++) {
      const pts = edgePts(t, i)
      for (let k = 1; k < pts.length; k++) {
        for (let s = 0; s <= 10; s++) {
          const x = Math.floor((pts[k - 1].x + (pts[k].x - pts[k - 1].x) * (s / 10)) / 0.1)
          const y = Math.floor((pts[k - 1].y + (pts[k].y - pts[k - 1].y) * (s / 10)) / 0.1)
          expect(g.data[y * g.w + x]).toBe(255)
        }
      }
    }
  })

  it('dò xong đưa vào bản đồ: không lỗi vùng cấm, mỗi đường hai chiều, đồ thị vẫn liền theo chiều làn', () => {
    const t = traceFree(plan(), opts({ minWidthM: 1.5, minSpeckPx: 400 }))
    const { map, added, dropped } = traceToMap({ v: 2, speed_mps: 1.2, points: [], lanes: [] }, t)
    expect(dropped).toBe(0)
    expect(added).toBe(t.edges.length)
    expect(map.lanes).toHaveLength(t.edges.length * 2)
    expect(roadsOf(map).every((r) => r.b !== undefined)).toBe(true)
    const seen = new Set([map.points[0].id])
    for (let again = true; again;) {
      again = false
      for (const l of map.lanes) if (seen.has(l.from) && !seen.has(l.to)) { seen.add(l.to); again = true }
    }
    expect(seen.size).toBe(map.points.length)
  })
})

describe('đưa kết quả dò vào bản đồ', () => {
  const corridor = () => traceFree(walled(200, 60, [[3, 20, 197, 40]]), opts())
  const empty = (): AgvMap => ({ v: 2, speed_mps: 1.2, points: [], lanes: [] })

  it('mỗi cạnh thành một đường hai chiều giữa hai ngã tư, id không đụng id có sẵn', () => {
    const base: AgvMap = { ...empty(), points: [{ id: 'J01', x: 500, y: 500, kind: 'junction' }], lanes: [{ id: 'L01', from: 'J01', to: 'J01', capacity: 1 }] }
    const { map, added, dropped } = traceToMap(base, corridor())
    expect(added).toBe(1)
    expect(dropped).toBe(0)
    expect(map.points).toHaveLength(3)
    expect(new Set(map.points.map((p) => p.id)).size).toBe(3)
    expect(new Set(map.lanes.map((l) => l.id)).size).toBe(map.lanes.length)
    expect(map.lanes).toHaveLength(3)
    const roads = roadsOf({ ...map, lanes: map.lanes.slice(1) })
    expect(roads).toHaveLength(1)
    expect(roads[0].b).toBeDefined()
  })

  it('sức chứa theo bề rộng: lối rộng 2 làn, lối hẹp 1 làn', () => {
    const wide = traceToMap(empty(), corridor()).map
    expect(wide.lanes.every((l) => l.capacity === 2)).toBe(true)
    const narrowT = traceFree(walled(200, 40, [[3, 12, 197, 28]]), opts({ minWidthM: 1 }))  // rộng 1,6 m
    expect(traceToMap(empty(), narrowT).map.lanes.every((l) => l.capacity === 1)).toBe(true)
  })

  it('bỏ đường cắt vùng cấm có sẵn trong bản đồ và đếm số bị bỏ, bản đồ ra không có lỗi vùng cấm', () => {
    const base: AgvMap = { ...empty(), keepouts: [{ id: 'K01', poly: [{ x: 8, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 6 }, { x: 8, y: 6 }] }] }
    const { map, added, dropped } = traceToMap(base, corridor())
    expect(dropped).toBe(1)
    expect(added).toBe(0)
    expect(map.lanes).toHaveLength(0)
    expect(keepoutProblems(map)).toEqual([])
  })

  it('kết quả rỗng thì bản đồ giữ nguyên', () => {
    const t = traceFree(walled(80, 80, []), opts())
    const m = empty()
    expect(traceToMap(m, t).map).toBe(m)
  })
})

describe('dò đường trên ảnh nền đã xoay', () => {
  it('ảnh xoay 90° quanh tâm: hành lang ngang trong ảnh thành đường dọc trên bản đồ, ở đúng chỗ', () => {
    const g = walled(200, 60, [[3, 20, 197, 40]])  // ảnh 20×6 m, tâm (10, 3)
    const t = traceFree(g, opts({ rotDeg: 90 }))
    expect(t.edges).toHaveLength(1)
    const pts = edgePts(t, 0)
    for (const p of pts) expect(p.x).toBeCloseTo(10, 0) // hành lang ở giữa ảnh theo chiều dọc ảnh → x = tâm
    const ys = pts.map((p) => p.y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(15)
    expect(Math.min(...ys)).toBeGreaterThan(-7.5)
    expect(Math.max(...ys)).toBeLessThan(13.5)
  })
  it('vùng cấm (toạ độ bản đồ) chặn đúng chỗ trên ảnh đã xoay', () => {
    const g = walled(200, 60, [[3, 20, 197, 40]])
    // vùng cấm che nửa trên của đường dọc (y < 3) sau khi xoay 90°
    const keep = { id: 'K', poly: [{ x: 5, y: -10 }, { x: 15, y: -10 }, { x: 15, y: 2 }, { x: 5, y: 2 }] }
    const t = traceFree(g, opts({ rotDeg: 90, keepouts: [keep] }))
    for (let i = 0; i < t.edges.length; i++) for (const p of edgePts(t, i)) expect(p.y).toBeGreaterThan(1.5)
  })
})
