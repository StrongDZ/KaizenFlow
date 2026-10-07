import { describe, expect, it } from 'vitest'
import { applyFrame, frameHeading, IDENTITY_FRAME, isIdentityFrame, solveFrame, withFrame } from './frame'

// Các ca này lấy nguyên từ frame_test.go (Frame.Apply của Go): hai bên phải cho cùng kết quả.
describe('applyFrame khớp Go', () => {
  const cases: [string, Partial<typeof IDENTITY_FRAME>, [number, number], [number, number]][] = [
    ['đồng nhất', {}, [3, 4], [3, 4]],
    ['mm sang mét', { scale: 0.001 }, [2000, 500], [2, 0.5]],
    ['xoay 90°', { rot_deg: 90 }, [1, 0], [0, 1]],
    ['dịch', { dx: 10, dy: -5 }, [1, 2], [11, -3]],
    ['lật Y rồi dịch', { flip_y: true, dy: 100 }, [5, 20], [5, 80]],
    ['scale, xoay, dịch', { scale: 2, rot_deg: 90, dx: 1, dy: 1 }, [1, 0], [1, 3]],
  ]
  for (const [name, f, raw, want] of cases) {
    it(name, () => {
      const [x, y] = applyFrame({ ...IDENTITY_FRAME, ...f }, raw[0], raw[1])
      expect(x).toBeCloseTo(want[0], 9)
      expect(y).toBeCloseTo(want[1], 9)
    })
  }
  it('scale 0 hoặc thiếu được coi là 1', () => {
    expect(applyFrame({ ...IDENTITY_FRAME, scale: 0 }, 3, 4)).toEqual([3, 4])
  })
  it('hướng: xoay, lật Y đảo dấu, chuẩn hoá về [0,360)', () => {
    expect(frameHeading({ ...IDENTITY_FRAME, rot_deg: 90 }, 10)).toBeCloseTo(100, 9)
    expect(frameHeading({ ...IDENTITY_FRAME, flip_y: true }, 30)).toBeCloseTo(330, 9)
    expect(frameHeading({ ...IDENTITY_FRAME, rot_deg: 90 }, 350)).toBeCloseTo(80, 9)
  })
})

describe('solveFrame (căn chỉnh bằng các cặp điểm)', () => {
  const truth = { dx: -4, dy: 52, rot_deg: 90, scale: 0.001, flip_y: false }
  const pairs = (frame: typeof truth, raws: [number, number][]) => raws.map(([x, y]) => {
    const [mx, my] = applyFrame(frame, x, y)
    return { raw: { x, y }, map: { x: mx, y: my } }
  })

  it('hai cặp điểm khôi phục đúng khung đã biết', () => {
    const r = solveFrame(pairs(truth, [[1000, 2000], [30000, 5000]]), false)!
    expect(r.frame.scale).toBeCloseTo(0.001, 9)
    expect(r.frame.rot_deg).toBeCloseTo(90, 6)
    expect(r.frame.dx).toBeCloseTo(-4, 6)
    expect(r.frame.dy).toBeCloseTo(52, 6)
    expect(r.rmsM).toBeCloseTo(0, 9)
  })
  it('khôi phục cả khi trục Y bị lật', () => {
    const flipped = { ...truth, flip_y: true, rot_deg: -30 }
    const r = solveFrame(pairs(flipped, [[10, 20], [400, -90], [200, 300]]), true)!
    expect(r.frame).toMatchObject({ flip_y: true })
    expect(r.frame.rot_deg).toBeCloseTo(-30, 6)
    expect(r.frame.scale).toBeCloseTo(0.001, 9)
    expect(r.rmsM).toBeCloseTo(0, 9)
  })
  it('từ ba cặp trở lên có sai số dư: báo rms khi các cặp không khớp phép đồng dạng', () => {
    const p = pairs(truth, [[1000, 2000], [30000, 5000], [9000, 9000]])
    p[2].map.x += 0.9 // một cặp sai lệch gần 1 m
    const r = solveFrame(p, false)!
    expect(r.rmsM).toBeGreaterThan(0.2)
    expect(r.rmsM).toBeLessThan(1)
  })
  it('không đủ dữ kiện thì null: dưới hai cặp hoặc hai điểm gốc trùng nhau', () => {
    expect(solveFrame([], false)).toBeNull()
    expect(solveFrame(pairs(truth, [[1, 1]]), false)).toBeNull()
    expect(solveFrame(pairs(truth, [[5, 5], [5, 5]]), false)).toBeNull()
  })
})

describe('withFrame / isIdentityFrame', () => {
  const b = { id: 1, model_key: 'm', subject: 'TUG', signal: 'fleet', source: 'agv/+/pos', json_path: '', transform: { fields: { state: 'mode' } }, enabled: true, mode: 'source' as const }
  it('đồng nhất khi chưa chỉnh gì (kể cả scale 0)', () => {
    expect(isIdentityFrame(IDENTITY_FRAME)).toBe(true)
    expect(isIdentityFrame({ ...IDENTITY_FRAME, scale: 0 })).toBe(true)
    expect(isIdentityFrame({ ...IDENTITY_FRAME, rot_deg: 90 })).toBe(false)
    expect(isIdentityFrame({ ...IDENTITY_FRAME, flip_y: true })).toBe(false)
  })
  it('ghi khung vào transform, giữ nguyên các phần khác của ghép nối', () => {
    const f = { ...IDENTITY_FRAME, scale: 0.001, rot_deg: 90 }
    expect(withFrame(b, f)).toEqual({
      subject: 'TUG', signal: 'fleet', mode: 'source', source: 'agv/+/pos', json_path: '', enabled: true,
      transform: { fields: { state: 'mode' }, frame: f },
    })
  })
  it('khung đồng nhất thì bỏ trường frame thay vì lưu số 0', () => {
    const withOld = { ...b, transform: { fields: { state: 'mode' }, frame: { ...IDENTITY_FRAME, rot_deg: 90 } } }
    expect(withFrame(withOld, IDENTITY_FRAME).transform).toEqual({ fields: { state: 'mode' } })
  })
})
