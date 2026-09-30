import { describe, expect, it } from 'vitest'
import { EMPTY_FORM, formProblems, formToScenarioBody, scenarioToForm } from './scenarioForm'

const sc = {
  name: 'Ca sáng', horizon_s: 14400, replications: 20, start_state: 'WARMUP',
  injections: [{ target: 'STAMP_3', failure: 'bearing_wear', at_s: 7200 }],
  overrides: [{ target: 'TUG', path: '/count', value: 3 }, { target: 'SM', path: '/replenish/rop', value: 40 }],
}

describe('scenario form', () => {
  it('turns a scenario into form rows, keeping unsupported overrides aside', () => {
    const f = scenarioToForm(sc)
    expect(f).toMatchObject({ name: 'Ca sáng', hours: 4, reps: 20, start: 'WARMUP' })
    expect(f.inj).toEqual([{ target: 'STAMP_3', failure: 'bearing_wear', at_min: 120 }])
    expect(f.ovr).toEqual([{ target: 'TUG', count: 3 }])
    expect(f.extra).toEqual([{ target: 'SM', path: '/replenish/rop', value: 40 }])
  })

  it('round-trips without losing anything', () => {
    expect(formToScenarioBody(scenarioToForm(sc))).toEqual({
      name: 'Ca sáng', horizon_s: 14400, replications: 20, start_state: 'WARMUP',
      injections: [{ target: 'STAMP_3', failure: 'bearing_wear', at_s: 7200 }],
      overrides: [{ target: 'TUG', path: '/count', value: 3 }, { target: 'SM', path: '/replenish/rop', value: 40 }],
    })
  })

  it('converts hours and minutes to seconds and trims the name', () => {
    const body = formToScenarioBody({ ...EMPTY_FORM, name: '  Ca tối ', hours: 0.25, inj: [{ target: 'A', failure: 'x', at_min: 1.5 }] })
    expect(body.name).toBe('Ca tối')
    expect(body.horizon_s).toBe(900)
    expect(body.injections).toEqual([{ target: 'A', failure: 'x', at_s: 90 }])
    expect(body.overrides).toEqual([])
  })

  it('handles empty lists and a non-numeric override value', () => {
    const f = scenarioToForm({ ...sc, injections: [], overrides: [{ target: 'TUG', path: '/count', value: 'ba' }] })
    expect(f.inj).toEqual([])
    expect(f.ovr).toEqual([])
    expect(f.extra).toHaveLength(1)
  })
})

describe('formProblems', () => {
  const ok = { ...EMPTY_FORM, name: 'Kịch bản 1', hours: 4, inj: [{ target: 'A', failure: 'x', at_min: 60 }] }
  it('hợp lệ thì không có vấn đề', () => {
    expect(formProblems(ok)).toEqual([])
  })
  it('lỗi tiêm sau khi scenario đã kết thúc hoặc trước khi bắt đầu', () => {
    const late = formProblems({ ...ok, hours: 1, inj: [{ target: 'A', failure: 'x', at_min: 90 }] })
    expect(late).toHaveLength(1)
    expect(late[0]).toContain('60 phút')
    expect(formProblems({ ...ok, inj: [{ target: 'A', failure: 'x', at_min: -5 }] })[0]).toContain('âm')
  })
  it('thiếu loại lỗi', () => {
    expect(formProblems({ ...ok, inj: [{ target: 'A', failure: '', at_min: 10 }] })[0]).toContain('loại lỗi')
  })
  it('số lượng đội xe phải từ 1; số lần lặp trong khoảng', () => {
    expect(formProblems({ ...ok, ovr: [{ target: 'TUG', count: 0 }] })[0]).toContain('ít nhất 1')
    expect(formProblems({ ...ok, reps: 0 })[0]).toContain('lần lặp')
    expect(formProblems({ ...ok, reps: 500 })[0]).toContain('200')
  })
  it('thiếu tên hoặc thời lượng', () => {
    expect(formProblems({ ...ok, name: '  ' })[0]).toContain('một tên')
    expect(formProblems({ ...ok, hours: 0 })[0]).toContain('Thời lượng')
  })
})
