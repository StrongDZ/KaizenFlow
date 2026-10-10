import { describe, expect, it } from 'vitest'
import type { GaugeCandidate, GaugeSight } from '../api/gaugeConfig'
import type { StationDoc } from './gaugeCommission'
import { countStates, draftFromCandidate, inventory, moveCorner, pendingByCamera } from './gaugeDiscovery'

function candidate(id: number, over: Partial<GaugeCandidate> = {}): GaugeCandidate {
  return {
    candidate_id: id, camera_id: 'cam-1', roi: [100, 50, 200, 200], type: 'analog_dial', score: 0.4, hint: {}, crop_jpeg: null,
    seen: 3, first_seen: '2026-10-10T08:00:00Z', last_seen: '2026-10-10T08:10:00Z', status: 'pending', machine_id: null, gauge_id: null, ...over,
  }
}

describe('draftFromCandidate', () => {
  it('fills a dial with the points the AI found, and leaves the scale values to the person', () => {
    const d = draftFromCandidate(candidate(7, { hint: { center: [128, 128], min_pt: [60, 200], max_pt: [196, 200] } }))
    expect(d).toMatchObject({ type: 'analog_dial', gauge_id: 'DONG_HO_KIM_7', roi: [100, 50, 200, 200], center: [128, 128], min_pt: [60, 200], max_pt: [196, 200], max_val: '' })
  })

  it('fills a display with its digit count and colour', () => {
    const d = draftFromCandidate(candidate(9, { type: 'seg7', hint: { digits: 5, color: 'lcd' } }))
    expect(d).toMatchObject({ type: 'seg7', gauge_id: 'MAN_SO_9', digits: '5', color: 'lcd' })
  })

  it('does not share the region array with the candidate', () => {
    const c = candidate(1)
    draftFromCandidate(c).roi![0] = 0
    expect(c.roi[0]).toBe(100)
  })
})

describe('inventory', () => {
  const stations: StationDoc[] = [
    { machine_id: 'M2', config: { machine_id: 'M2', plant: 'P', line: 'L', window_sec: 1, gauges: [{ gauge_id: 'B', type: 'seg7', roi: [0, 0, 9, 9], camera_id: 'cam-1' }] } },
    { machine_id: 'M1', config: { machine_id: 'M1', plant: 'P', line: 'L', window_sec: 1, camera: { camera_id: 'cam-0' }, gauges: [{ gauge_id: 'A', type: 'analog_dial', roi: [0, 0, 9, 9] }] } },
  ]
  const sights: GaugeSight[] = [{ machine_id: 'M2', gauge_id: 'B', camera_id: 'cam-1', state: 'lost', last_seen: null, scanned_at: null }]

  it('lists the pending first, then the declared gauges by machine, then the ignored', () => {
    const rows = inventory(stations, sights, [candidate(1)], [candidate(2, { status: 'ignored' })])
    expect(rows.map((r) => r.state)).toEqual(['pending', 'reading', 'lost', 'ignored'])
    const declared = rows.filter((r) => r.kind === 'declared')
    expect(declared.map((r) => r.kind === 'declared' && `${r.machine_id}/${r.gauge.gauge_id}@${r.camera_id}`)).toEqual(['M1/A@cam-0', 'M2/B@cam-1'])
    expect(countStates(rows)).toEqual({ pending: 1, reading: 1, lost: 1, ignored: 1 })
  })
})

describe('pendingByCamera', () => {
  it('counts the candidates of each camera', () => {
    expect([...pendingByCamera([candidate(1), candidate(2), candidate(3, { camera_id: 'cam-2' })])]).toEqual([['cam-1', 2], ['cam-2', 1]])
  })
})

describe('moveCorner', () => {
  it('moves the dragged corner and keeps the opposite one', () => {
    expect(moveCorner([100, 100, 200, 100], 'se', { x: 350, y: 260 })).toEqual([100, 100, 250, 160])
    expect(moveCorner([100, 100, 200, 100], 'nw', { x: 90, y: 80 })).toEqual([90, 80, 210, 120])
  })

  it('flips when the corner crosses the opposite one', () => {
    expect(moveCorner([100, 100, 200, 100], 'se', { x: 50, y: 50 })).toEqual([50, 50, 50, 50])
  })

  it('keeps the region when it would become too small', () => {
    expect(moveCorner([100, 100, 200, 100], 'ne', { x: 105, y: 195 })).toEqual([100, 100, 200, 100])
  })
})
