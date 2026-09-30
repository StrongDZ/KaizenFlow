import { describe, expect, it } from 'vitest'
import { HORIZONS, buildForecastRows, levelMetrics } from './forecastSeries'

const bands = [
  { t: 1000, p10: 90, p50: 100, p90: 110 },
  { t: 2000, p10: 80, p50: 95, p90: 108 },
]

describe('buildForecastRows', () => {
  it('ghép chuỗi thực tế và dải dự báo theo thời gian, dải tách thành nền và bề rộng để vẽ chồng', () => {
    const rows = buildForecastRows([{ t: 500, v: 101 }, { t: 1500, v: 97 }], bands)
    expect(rows.map((r) => r.t)).toEqual([500, 1000, 1500, 2000])
    expect(rows[0]).toEqual({ t: 500, actual: 101 })
    expect(rows[1]).toEqual({ t: 1000, p50: 100, low: 90, range: 20 })
    expect(rows[3]).toEqual({ t: 2000, p50: 95, low: 80, range: 28 })
  })
  it('điểm thực tế và điểm dự báo trùng thời điểm thì nằm chung một dòng', () => {
    const rows = buildForecastRows([{ t: 1000, v: 99 }], bands)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ t: 1000, actual: 99, p50: 100, low: 90, range: 20 })
  })
  it('cắt phần thực tế cũ hơn mốc bắt đầu, giữ nguyên dự báo', () => {
    const rows = buildForecastRows([{ t: 100, v: 1 }, { t: 900, v: 2 }], bands, 500)
    expect(rows.filter((r) => r.actual !== undefined).map((r) => r.t)).toEqual([900])
    expect(rows.filter((r) => r.p50 !== undefined)).toHaveLength(2)
  })
  it('không có dữ liệu thì rỗng; bề rộng không âm dù p90 < p10 do làm tròn', () => {
    expect(buildForecastRows([], [])).toEqual([])
    expect(buildForecastRows([], [{ t: 1, p10: 5, p50: 5, p90: 4.9999 }])[0].range).toBe(0)
  })
  it('không sửa đầu vào', () => {
    const a = [{ t: 2, v: 1 }, { t: 1, v: 1 }]
    buildForecastRows(a, bands)
    expect(a[0].t).toBe(2)
  })
})

describe('levelMetrics', () => {
  it('liệt kê các (kho, vật tư) có tồn live, kho theo tên', () => {
    const snap = {
      KHO_B: { signals: { 'level:RAW-01': { v: 1, ts: '' }, 'level:RAW-02': { v: 2, ts: '' }, coverage_h: { v: 3, ts: '' } }, age_ms: 0 },
      KHO_A: { signals: { 'level:RAW-01': { v: 1, ts: '' } }, age_ms: 0 },
      STAMP_1: { signals: { count_ok: { v: 1, ts: '' } }, age_ms: 0 },
    }
    const out = levelMetrics(snap, { KHO_A: 'Kho NVL A', KHO_B: 'Kho NVL B' })
    expect(out.map((m) => m.id)).toEqual(['KHO_A|level:RAW-01', 'KHO_B|level:RAW-01', 'KHO_B|level:RAW-02'])
    expect(out[0]).toMatchObject({ subject: 'KHO_A', metric: 'level:RAW-01', label: 'Kho NVL A · RAW-01' })
  })
})

describe('HORIZONS', () => {
  it('từ 30 phút đến 1 tuần, tăng dần', () => {
    expect(HORIZONS[0].s).toBe(1800)
    expect(HORIZONS[HORIZONS.length - 1].s).toBe(7 * 86400)
    expect([...HORIZONS].map((h) => h.s)).toEqual([...HORIZONS].map((h) => h.s).sort((a, b) => a - b))
  })
})
