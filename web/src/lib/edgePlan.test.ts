import { describe, expect, it } from 'vitest'
import type { Binding, PlannedEdge } from '../api/types'
import { estimatedEdges, planBindings } from './edgePlan'

const base = { id: 1, model_key: 'm', source: '', json_path: '', transform: {}, enabled: true }
const derived = (subject: string, signal: string, estimate: boolean | undefined, enabled = true): Binding => ({
  ...base, subject, signal, enabled, mode: 'derived', derive: { kind: 'sum', terms: [{ subject: 'P', signal: 'count_in', sign: 1 }], ...(estimate === undefined ? {} : { estimate }) },
})

describe('estimatedEdges', () => {
  it('chỉ lấy đường nối có moved tự tính được đánh dấu ước lượng và đang bật', () => {
    const got = estimatedEdges([
      derived('A>P', 'moved', true),
      derived('B>P', 'moved', false),
      derived('C>P', 'moved', undefined),
      derived('D>P', 'moved', true, false), // đang tắt: không hiện là ước lượng
      derived('E>P', 'in_transit', true), // chỉ moved làm hạt chảy
      { ...base, subject: 'F>P', signal: 'moved', mode: 'source', source: 'belt/f', json_path: 'moved' }, // đo thật
    ])
    expect([...got]).toEqual(['A>P'])
  })
})

describe('planBindings', () => {
  it('đổi kế hoạch thành ghép nối tự tính bật sẵn, giữ cờ ước lượng', () => {
    const items: PlannedEdge[] = [
      { subject: 'A>P', signal: 'moved', note: 'n', estimate: true, derive: { kind: 'sum', terms: [{ subject: 'P', signal: 'count_in', sign: 1, factor: 0.5 }], estimate: true } },
    ]
    expect(planBindings(items)).toEqual([
      { subject: 'A>P', signal: 'moved', mode: 'derived', enabled: true, derive: items[0].derive },
    ])
  })
})
