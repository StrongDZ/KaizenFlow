import { describe, expect, it } from 'vitest'
import {
  buildGauge, calibPoint, calibToFrame, draftFromGauge, dragToRoi, emptyDraft, gaugesOnCamera, mergeGauge, removeGauge, toFrame, upsertGauge,
  type StationDoc,
} from './gaugeCommission'

const shown = { width: 960, height: 540 }
const frame = { width: 1920, height: 1080 }

describe('pointer to frame', () => {
  it('scales a point of the shown image to frame pixels', () => {
    expect(toFrame({ x: 480, y: 270 }, shown, frame)).toEqual({ x: 960, y: 540 })
  })

  it('keeps a point inside the frame', () => {
    expect(toFrame({ x: -5, y: 9999 }, shown, frame)).toEqual({ x: 0, y: 1080 })
  })

  it('turns a drag in any direction into an integer roi', () => {
    expect(dragToRoi({ x: 100, y: 50 }, { x: 200, y: 150 }, shown, frame)).toEqual([200, 100, 200, 200])
    expect(dragToRoi({ x: 200, y: 150 }, { x: 100, y: 50 }, shown, frame)).toEqual([200, 100, 200, 200])
  })

  it('ignores a drag too small to be a gauge', () => {
    expect(dragToRoi({ x: 100, y: 50 }, { x: 103, y: 52 }, shown, frame)).toBeNull()
  })
})

describe('calibPoint', () => {
  it('expresses a frame point in the 256 square the roi is stretched to', () => {
    expect(calibPoint({ x: 300, y: 200 }, [200, 100, 200, 200])).toEqual([128, 128])
    expect(calibPoint({ x: 200, y: 300 }, [200, 100, 400, 200])).toEqual([0, 256])
  })
})

describe('buildGauge', () => {
  const dial = () => ({
    ...emptyDraft('analog_dial'), gauge_id: 'OIL_TEMP', unit: 'degC', roi: [200, 100, 200, 200],
    center: [128, 128] as [number, number], min_pt: [40, 200] as [number, number], max_pt: [216, 200] as [number, number],
    min_val: '0', max_val: '200', rule_max: '170',
  })

  it('builds a dial on a camera', () => {
    expect(buildGauge(dial(), 'cam-a')).toEqual({
      problems: [],
      gauge: {
        gauge_id: 'OIL_TEMP', type: 'analog_dial', unit: 'degC', roi: [200, 100, 200, 200], camera_id: 'cam-a',
        calib: { center: [128, 128], min_pt: [40, 200], max_pt: [216, 200], min_val: 0, max_val: 200, sweep: 'cw', scale: 'linear' },
        rules: { max: 170 },
      },
    })
  })

  it('says what a dial still needs', () => {
    const d = { ...dial(), roi: null, center: null, max_val: '0', gauge_id: 'oil temp' }
    expect(buildGauge(d, 'cam-a').problems).toEqual([
      'Mã đồng hồ chỉ gồm chữ, số, dấu _ . - (tối đa 64 ký tự).',
      'Chưa khoanh vùng đồng hồ trên ảnh.',
      'Chưa chấm đủ ba điểm: tâm, vạch min, vạch max.',
      'Giá trị min phải nhỏ hơn giá trị max.',
    ])
    expect(buildGauge(d, 'cam-a').gauge).toBeUndefined()
  })

  it('builds the three digit displays', () => {
    const base = { gauge_id: 'G', unit: '', roi: [10, 20, 180, 64] }
    expect(buildGauge({ ...emptyDraft('seg7'), ...base, digits: '4', decimal_pos: '3', color: 'red_led' }, 'c').gauge?.calib)
      .toEqual({ digits: 4, decimal_pos: 3, color: 'red_led' })
    expect(buildGauge({ ...emptyDraft('timer_mmss'), ...base }, 'c').gauge?.calib).toEqual({ digits: 4, colon_after: 2 })
    const counter = buildGauge({ ...emptyDraft('rolling_counter'), ...base, digits: '6', decimal_digits: '1' }, 'c').gauge
    expect(counter?.calib).toEqual({ digits: 6, decimal_digits: 1 })
    expect(counter?.rules).toEqual({ monotonic: true })
  })

  it('checks the digit counts and the range', () => {
    const base = { gauge_id: 'G', unit: '', roi: [10, 20, 180, 64] }
    expect(buildGauge({ ...emptyDraft('seg7'), ...base, digits: '9', decimal_pos: '0' }, 'c').problems).toEqual(['Số chữ số phải từ 1 đến 8.'])
    expect(buildGauge({ ...emptyDraft('seg7'), ...base, digits: '3', decimal_pos: '4' }, 'c').problems).toEqual(['Vị trí dấu chấm phải từ 0 đến số chữ số.'])
    expect(buildGauge({ ...emptyDraft('rolling_counter'), ...base, digits: '4', decimal_digits: '4' }, 'c').problems).toEqual(['Số chữ số thập phân phải nhỏ hơn số chữ số.'])
    expect(buildGauge({ ...emptyDraft('timer_mmss'), ...base, rule_min: '5', rule_max: '5' }, 'c').problems).toEqual(['Ngưỡng dưới phải nhỏ hơn ngưỡng trên.'])
  })
})

describe('station config edits', () => {
  const gauge = { gauge_id: 'A', type: 'seg7', unit: 'V', roi: [1, 2, 3, 4], camera_id: 'cam-a', calib: {} }
  const machine = { machine_id: 'PRESS_01', plant: 'DENSO_HN', line: 'L03' }

  it('starts a config for a new machine', () => {
    expect(upsertGauge(null, machine, gauge)).toEqual({ ...machine, window_sec: 1, gauges: [gauge] })
  })

  it('adds a gauge, or replaces the one with the same ID, without touching the rest', () => {
    const config = { ...machine, window_sec: 2, config_version: 7, camera: { url: 'rtsp://x', sample_fps: 2 }, gauges: [{ ...gauge, unit: 'old' }, { ...gauge, gauge_id: 'B' }] }
    const out = upsertGauge(config, machine, gauge)
    expect(out.gauges.map((g) => [g.gauge_id, g.unit])).toEqual([['A', 'V'], ['B', 'V']])
    expect(out.window_sec).toBe(2)
    expect(out.camera).toEqual({ url: 'rtsp://x', sample_fps: 2 })
    expect(config.gauges[0].unit).toBe('old')
    expect(upsertGauge(config, machine, { ...gauge, gauge_id: 'C' }).gauges.map((g) => g.gauge_id)).toEqual(['A', 'B', 'C'])
  })

  it('removes a gauge', () => {
    const config = { ...machine, window_sec: 1, gauges: [gauge, { ...gauge, gauge_id: 'B' }] }
    expect(removeGauge(config, 'A').gauges.map((g) => g.gauge_id)).toEqual(['B'])
  })

  it('lists the gauges of every machine on one camera', () => {
    const stations: StationDoc[] = [
      { machine_id: 'M2', config: { ...machine, machine_id: 'M2', window_sec: 1, gauges: [{ ...gauge, gauge_id: 'X' }, { ...gauge, gauge_id: 'Y', camera_id: 'cam-b' }] } },
      { machine_id: 'M1', config: { ...machine, machine_id: 'M1', window_sec: 1, gauges: [gauge] } },
      { machine_id: 'M3', config: { ...machine, machine_id: 'M3', window_sec: 1, gauges: [{ ...gauge, camera_id: undefined }] } },
    ]
    expect(gaugesOnCamera(stations, 'cam-a').map((e) => `${e.machine_id}/${e.gauge.gauge_id}`)).toEqual(['M1/A', 'M2/X'])
    expect(gaugesOnCamera(stations, 'cam-c')).toEqual([])
  })
})

describe('editing a stored gauge', () => {
  const stored = {
    gauge_id: 'OIL_TEMP', type: 'analog_dial', unit: 'degC', roi: [200, 100, 200, 200], camera_id: 'cam-a',
    quad: [{ x: 201, y: 101 }], rect_size: 256,
    calib: { center: [128, 128], min_pt: [40, 200], max_pt: [216, 200], min_val: 0, max_val: 200, sweep: 'cw', scale: 'linear' },
    rules: { max: 170, deadband: 0.6 },
  }

  it('loads into the form and builds back to the same gauge', () => {
    const draft = draftFromGauge(stored)
    expect(draft.center).toEqual([128, 128])
    expect([draft.min_val, draft.max_val, draft.rule_min, draft.rule_max]).toEqual(['0', '200', '', '170'])
    const built = buildGauge(draft, 'cam-a').gauge!
    expect(mergeGauge(stored, built)).toEqual(stored)
  })

  it('drops the old quad once the region is redrawn', () => {
    const built = buildGauge({ ...draftFromGauge(stored), roi: [10, 10, 300, 300] }, 'cam-a').gauge!
    const merged = mergeGauge(stored, built)
    expect(merged.quad).toBeUndefined()
    expect(merged.roi).toEqual([10, 10, 300, 300])
  })

  it('maps a calib point back onto the frame', () => {
    expect(calibToFrame([128, 128], [200, 100, 200, 200])).toEqual({ x: 300, y: 200 })
    expect(calibToFrame(calibPoint({ x: 250, y: 130 }, [200, 100, 400, 200]), [200, 100, 400, 200])).toEqual({ x: 250, y: 130 })
  })
})
