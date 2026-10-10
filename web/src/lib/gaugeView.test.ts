import { describe, expect, it } from 'vitest'
import type { GaugeStation } from '../api/gauge'
import {
  attentionHint,
  ageLabel, cameraLabel, countKinds, defaultLine, filterStations, fmtValue, gaugeStateLabel, gaugesOn, lineKey, linesOf, needsAttention,
  roiBox, roiCrop, sortStations, splitTiles, sparkPoints, stationKind, unitLabel,
} from './gaugeView'

function station(id: string, state: GaugeStation['state'], opts: { edge?: boolean; line?: string } = {}): GaugeStation {
  return {
    machine_id: id, plant: 'SIM', line: opts.line ?? 'L01', config_version: 1, state,
    edge: opts.edge === false ? null : { edge_id: 'edge-1', status: 'online', last_seen: null },
    cameras: [], gauges: [],
  }
}

describe('stationKind', () => {
  it('keeps the state of a station that reports', () => {
    expect(stationKind(station('a', 'alarm'))).toBe('alarm')
    expect(stationKind(station('a', 'poor'))).toBe('poor')
    expect(stationKind(station('a', 'stale'))).toBe('stale')
    expect(stationKind(station('a', 'ok'))).toBe('ok')
  })

  it('tells a station that went silent from one that never reported', () => {
    expect(stationKind(station('a', 'offline'))).toBe('lost')
    expect(stationKind(station('a', 'offline', { edge: false }))).toBe('idle')
  })

  it('asks for attention on everything but ok and idle', () => {
    expect((['alarm', 'poor', 'stale', 'lost'] as const).every(needsAttention)).toBe(true)
    expect(needsAttention('ok')).toBe(false)
    expect(needsAttention('idle')).toBe(false)
  })
})

describe('sortStations', () => {
  it('puts what needs attention first, then by machine ID', () => {
    const sorted = sortStations([
      station('m5', 'ok'), station('m4', 'offline', { edge: false }), station('m3', 'offline'),
      station('m2', 'poor'), station('m1', 'alarm'), station('m0', 'ok'), station('m6', 'stale'),
    ])
    expect(sorted.map((s) => s.machine_id)).toEqual(['m1', 'm2', 'm6', 'm3', 'm0', 'm5', 'm4'])
  })

  it('does not change its input', () => {
    const input = [station('b', 'ok'), station('a', 'alarm')]
    sortStations(input)
    expect(input.map((s) => s.machine_id)).toEqual(['b', 'a'])
  })
})

describe('countKinds', () => {
  it('counts every kind, zero included', () => {
    expect(countKinds([station('a', 'alarm'), station('b', 'alarm'), station('c', 'offline', { edge: false })]))
      .toEqual({ alarm: 2, poor: 0, stale: 0, lost: 0, ok: 0, idle: 1 })
  })
})

describe('lines', () => {
  const stations = [
    station('a', 'offline', { edge: false, line: 'L01' }), station('b', 'offline', { edge: false, line: 'L01' }),
    station('c', 'ok', { line: 'L02' }), station('d', 'ok', { line: 'L01' }), station('e', 'alarm', { line: 'L02' }),
  ]

  it('lists the lines once, sorted', () => {
    expect(lineKey(stations[0])).toBe('SIM / L01')
    expect(linesOf(stations)).toEqual(['SIM / L01', 'SIM / L02'])
  })

  it('opens on the line with the most reporting stations', () => {
    expect(defaultLine(stations)).toBe('SIM / L02')
    expect(defaultLine([])).toBe('')
    expect(defaultLine([stations[0]])).toBe('SIM / L01')
  })

  it('prefers a line that reports now over one that only went silent', () => {
    const silent = [station('x', 'offline', { line: 'L03' }), station('y', 'offline', { line: 'L03' }), station('z', 'offline', { line: 'L03' })]
    expect(defaultLine([...silent, station('live', 'ok', { line: 'L04' })])).toBe('SIM / L04')
    expect(defaultLine([...silent, station('one', 'offline', { line: 'L04' })])).toBe('SIM / L03')
  })

  it('filters by line and by kind', () => {
    expect(filterStations(stations, 'SIM / L02', 'all').map((s) => s.machine_id)).toEqual(['c', 'e'])
    expect(filterStations(stations, '', 'ok').map((s) => s.machine_id)).toEqual(['c', 'd'])
    expect(filterStations(stations, 'SIM / L01', 'idle').map((s) => s.machine_id)).toEqual(['a', 'b'])
  })
})

describe('fmtValue', () => {
  it('shows a dial with one decimal and a comma', () => {
    expect(fmtValue(122.19116, 'analog_dial')).toBe('122,2')
    expect(fmtValue(5, 'analog_dial')).toBe('5,0')
  })

  it('shows a digit display as read, without a trailing zero', () => {
    expect(fmtValue(36, 'timer_mmss')).toBe('36')
    expect(fmtValue(29.8, 'seg7')).toBe('29,8')
    expect(fmtValue(4812, 'counter')).toBe('4812')
    expect(fmtValue(54.46, 'seg7')).toBe('54,46')
    expect(fmtValue(144060.8, 'rolling_counter')).toBe('144060,8')
  })

  it('shows a dash without a value', () => {
    expect(fmtValue(null, 'seg7')).toBe('—')
  })
})

describe('labels', () => {
  it('writes units the way people read them', () => {
    expect(unitLabel('degC')).toBe('°C')
    expect(unitLabel('bar')).toBe('bar')
    expect(unitLabel('rpm')).toBe('vòng/phút')
    expect(unitLabel('')).toBe('')
  })

  it('names the reason of a state from its flags', () => {
    expect(gaugeStateLabel('ok', [])).toBe('Bình thường')
    expect(gaugeStateLabel('alarm', ['FLAG_OUT_OF_RANGE'])).toBe('Vượt ngưỡng')
    expect(gaugeStateLabel('alarm', ['FLAG_RATE_LIMIT'])).toBe('Đổi quá nhanh')
    expect(gaugeStateLabel('alarm', ['FLAG_NON_MONOTONIC'])).toBe('Số đếm bị lùi')
    expect(gaugeStateLabel('poor', ['FLAG_BLUR'])).toBe('Ảnh mờ')
    expect(gaugeStateLabel('poor', ['FLAG_GLARE'])).toBe('Bị lóa')
    expect(gaugeStateLabel('poor', ['FLAG_OCCLUDED'])).toBe('Bị che')
    expect(gaugeStateLabel('poor', ['FLAG_FORMAT_INVALID'])).toBe('Không đọc được')
    expect(gaugeStateLabel('poor', ['FLAG_ROI_DRIFT'])).toBe('Lệch vùng đọc')
    expect(gaugeStateLabel('poor', [])).toBe('Độ tin cậy thấp')
    expect(gaugeStateLabel('stale', [])).toBe('Mất tín hiệu')
  })
})

describe('roiBox', () => {
  it('turns frame pixels into percentages', () => {
    expect(roiBox([960, 540, 192, 108], 1920, 1080)).toEqual({ left: 50, top: 50, width: 10, height: 10 })
  })

  it('keeps a box that leaves the frame inside it', () => {
    expect(roiBox([1900, -20, 100, 100], 1920, 1080)).toEqual({ left: 190000 / 1920, top: 0, width: 2000 / 1920, height: 8000 / 1080 })
  })

  it('gives nothing for a malformed ROI', () => {
    expect(roiBox([1, 2, 3], 1920, 1080)).toBeNull()
    expect(roiBox([0, 0, 0, 10], 1920, 1080)).toBeNull()
  })
})

describe('roiCrop', () => {
  it('shows exactly the ROI: the frame is scaled and shifted inside the window', () => {
    // A quarter of the frame, at its bottom right, in a square tile.
    expect(roiCrop([500, 500, 500, 500], 1000, 1000, 1)).toEqual({
      window: { width: 100, height: 100 },
      image: { width: 200, height: 200, left: -100, top: -100 },
    })
  })

  it('keeps the shape of a wide display in a wide tile', () => {
    // 400 x 100 px: four times as wide as high, so half the height of a 2:1 tile.
    expect(roiCrop([0, 0, 400, 100], 800, 800, 2)?.window).toEqual({ width: 100, height: 50 })
  })

  it('keeps the shape of a tall ROI', () => {
    expect(roiCrop([0, 0, 100, 400], 800, 800, 1)?.window).toEqual({ width: 25, height: 100 })
  })

  it('gives nothing for a malformed ROI', () => {
    expect(roiCrop([1, 2, 3], 800, 800, 1)).toBeNull()
  })
})

describe('sparkPoints', () => {
  it('spreads the points over the box, highest value at the top', () => {
    expect(sparkPoints([{ value: 0 }, { value: 5 }, { value: 10 }], 100, 20)).toBe('0,20 50,10 100,0')
  })

  it('draws a constant series through the middle', () => {
    expect(sparkPoints([{ value: 3 }, { value: 3 }], 100, 20)).toBe('0,10 100,10')
  })

  it('skips missing values and needs two points', () => {
    expect(sparkPoints([{ value: 0 }, { value: null }, { value: 10 }], 100, 20)).toBe('0,20 100,0')
    expect(sparkPoints([{ value: 1 }], 100, 20)).toBe('')
    expect(sparkPoints([], 100, 20)).toBe('')
  })
})

describe('ageLabel', () => {
  const now = Date.parse('2026-10-06T03:00:00Z')
  it('says how long ago a reading arrived', () => {
    expect(ageLabel('2026-10-06T02:59:58Z', now)).toBe('vừa xong')
    expect(ageLabel('2026-10-06T02:59:30Z', now)).toBe('30 giây trước')
    expect(ageLabel('2026-10-06T02:55:00Z', now)).toBe('5 phút trước')
    expect(ageLabel('2026-10-06T00:00:00Z', now)).toBe('3 giờ trước')
    expect(ageLabel(null, now)).toBe('chưa có dữ liệu')
  })
})

describe('cameras of a machine', () => {
  it('names the default camera and the others', () => {
    expect(cameraLabel('')).toBe('Camera chính')
    expect(cameraLabel('side')).toBe('Camera side')
  })

  it('keeps the gauges of one camera', () => {
    const gauges = [{ id: 'a', camera_id: '' }, { id: 'b', camera_id: 'side' }, { id: 'c', camera_id: '' }]
    expect(gaugesOn(gauges, '').map((g) => g.id)).toEqual(['a', 'c'])
    expect(gaugesOn(gauges, 'side').map((g) => g.id)).toEqual(['b'])
    expect(gaugesOn(gauges, 'back')).toEqual([])
  })
})

describe('splitTiles', () => {
  const g = (id: string, state: string) => ({ id, state })

  it('shows every gauge as a tile when they fit', () => {
    const gauges = [g('a', 'ok'), g('b', 'alarm')]
    expect(splitTiles(gauges)).toEqual([gauges, []])
  })

  it('gives the tiles to the gauges that need a look, in declared order', () => {
    const gauges = [g('a', 'ok'), g('b', 'ok'), g('c', 'alarm'), g('d', 'ok'), g('e', 'poor'), g('f', 'ok')]
    const [tiles, rest] = splitTiles(gauges)
    expect(tiles.map((x) => x.id)).toEqual(['a', 'b', 'c', 'e'])
    expect(rest.map((x) => x.id)).toEqual(['d', 'f'])
  })
})

describe('attentionHint', () => {
  const now = Date.parse('2026-10-09T10:00:00Z')
  const gauge = (state: string, flags: string[] = []) => ({
    gauge_id: 'P_HYD', type: 'analog_dial', unit: 'bar', roi: [], camera_id: '', min: 0, max: 10, state, ts: null, value: 11.4,
    v_min: null, v_max: null, n_frames: null, quality: null, flags,
  }) as unknown as GaugeStation['gauges'][number]
  it('nói rõ đồng hồ nào, giá trị bao nhiêu và nên kiểm tra gì', () => {
    expect(attentionHint({ ...station('m1', 'alarm'), gauges: [gauge('alarm')] }, now)).toBe('P_HYD 11,4 bar ngoài ngưỡng 0–10')
    expect(attentionHint({ ...station('m1', 'poor'), gauges: [gauge('poor', ['FLAG_GLARE'])] }, now)).toBe('P_HYD bị lóa')
    expect(attentionHint(station('m1', 'stale'), now)).toMatch(/edge/)
  })
  it('mất tín hiệu nói lần cuối edge báo về; trạm bình thường hay chưa có dữ liệu thì không có gì', () => {
    const lost = { ...station('m1', 'offline', { edge: true }), edge: { edge_id: 'e', status: 'offline', last_seen: '2026-10-09T09:55:00Z' } }
    expect(attentionHint(lost, now)).toBe('Edge im lặng, lần cuối 5 phút trước: kiểm tra nguồn và mạng của edge')
    expect(attentionHint(station('m1', 'ok'), now)).toBeUndefined()
    expect(attentionHint(station('m1', 'offline', { edge: false }), now)).toBeUndefined()
  })
})
