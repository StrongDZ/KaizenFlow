import { describe, expect, it } from 'vitest'
import type { Binding, SourceSnap, SubjectView } from '../api/types'
import { STATE_ENUM, suggestMapping } from './suggestMapping'

const src = (source: string, desc: string, last: unknown): SourceSnap =>
  ({ source, desc, last, last_ts: '2026-10-01T08:00:00Z', age_ms: 10, count: 5, bound: false })

const sig = (name: string, kind: 'number' | 'text' | 'fleet' = 'number') => ({ name, label: name, kind })
const PROCESS = [sig('state', 'text'), sig('count_in'), sig('count_ok'), sig('count_ng'), sig('vibration')]

const subjects: SubjectView[] = [
  { subject: 'STAMP_1', kind: 'node', name: 'Máy dập 1', archetype: 'PROCESS', signals: PROCESS },
  { subject: 'STAMP_2', kind: 'node', name: 'Máy dập 2', archetype: 'PROCESS', signals: PROCESS },
  { subject: 'KHO_A', kind: 'node', name: 'Kho NVL A', archetype: 'STORAGE', signals: [sig('level:RAW-01')] },
  { subject: 'KHO_B', kind: 'node', name: 'Kho NVL B', archetype: 'STORAGE', signals: [sig('level:RAW-01'), sig('level:RAW-02')] },
  { subject: 'SHIP_1', kind: 'node', name: 'Cửa xuất 1', archetype: 'SINK', signals: [sig('demand'), sig('fulfilled'), sig('backorder')] },
  { subject: 'TUG_A', kind: 'node', name: 'Xe kéo A', archetype: 'RESOURCE_POOL', signals: [sig('busy'), sig('queue_len'), sig('fleet', 'fleet')] },
  { subject: 'KHO_A>STAMP_1', kind: 'edge', name: 'Kho NVL A → Máy dập 1', material: 'RAW-01', mode: 'POOL', src: 'KHO_A', dst: 'STAMP_1',
    signals: [sig('in_transit'), sig('moved'), sig('trip_s')] },
  { subject: 'KHO_B>STAMP_2', kind: 'edge', name: 'Kho NVL B → Máy dập 2', material: 'RAW-01', mode: 'POOL', src: 'KHO_B', dst: 'STAMP_2',
    signals: [sig('in_transit'), sig('moved'), sig('trip_s')] },
  { subject: 'KHO_B>STAMP_2#2', kind: 'edge', name: 'Kho NVL B → Máy dập 2', material: 'RAW-02', mode: 'POOL', src: 'KHO_B', dst: 'STAMP_2',
    signals: [sig('in_transit'), sig('moved'), sig('trip_s')] },
]

const sources: SourceSnap[] = [
  src('plc/prs-02/status', 'Máy dập 2', { st: 'RUN', cnt: { in: 5, ok: 4, ng: 0 }, vib: 0.3 }),
  src('wms/wh-a/stock', 'Kho NVL A', { items: [{ sku: 'RAW-01', qty: 230 }] }),
  src('wms/wh-b/stock', 'Kho NVL B', { items: [{ sku: 'RAW-01', qty: 100 }, { sku: 'RAW-02', qty: 200 }] }),
  src('dock/dock-out-01/count', 'Cửa xuất 1', { demand: 9, shipped: 8, backlog: 1 }),
  src('fleet/tug-a/summary', 'Xe kéo A', { busy: 1, queue: 0, total: 2 }),
  src('belt/wh-a~prs-01/flow', 'Kho NVL A → Máy dập 1 (RAW-01)', { moved: 12, in_transit: 0 }),
  src('belt/wh-b~prs-02.2/flow', 'Kho NVL B → Máy dập 2 (RAW-02)', { moved: 3, in_transit: 1 }),
  src('agv/trip/wh-a~prs-01', 'Chuyến xe: Kho NVL A → Máy dập 1 (RAW-01)', { dur: 45, wait: 0, ideal: 44 }),
  src('agv/tug-a/01/pos', 'Xe kéo A — xe 1', { id: 'TUG-A-01', x: 5, y: 10, st: 'IDLE', seg: '', load: 0 }),
  src('agv/tug-a/02/pos', 'Xe kéo A — xe 2', { id: 'TUG-A-02', x: 5, y: 10, st: 'IDLE', seg: '', load: 0 }),
  src('misc/weather', 'Trạm thời tiết', { temp: 31 }),
]

const find = (list: ReturnType<typeof suggestMapping>['suggestions'], subject: string, signal: string) =>
  list.find((s) => s.subject === subject && s.signal === signal)

describe('suggestMapping', () => {
  const { suggestions, unmatched } = suggestMapping(sources, subjects, [])

  it('máy: trạng thái kèm bảng đổi từ ngữ, bộ đếm, độ rung', () => {
    const st = find(suggestions, 'STAMP_2', 'state')!
    expect(st).toMatchObject({ source: 'plc/prs-02/status', json_path: 'st' })
    expect(st.transform?.enum).toMatchObject({ RUN: 'RUNNING', ALARM: 'DOWN', WAIT_IN: 'STARVED', WAIT_OUT: 'BLOCKED' })
    expect(find(suggestions, 'STAMP_2', 'count_ok')?.json_path).toBe('cnt.ok')
    expect(find(suggestions, 'STAMP_2', 'count_ng')?.json_path).toBe('cnt.ng')
    expect(find(suggestions, 'STAMP_2', 'vibration')?.json_path).toBe('vib')
  })

  it('không ghép nhầm sang máy khác (Máy dập 1 khác Máy dập 2)', () => {
    expect(suggestions.filter((s) => s.subject === 'STAMP_1' && s.source === 'plc/prs-02/status')).toEqual([])
  })

  it('kho: mỗi vật tư một tín hiệu level, phân biệt kho A và kho B', () => {
    expect(find(suggestions, 'KHO_A', 'level:RAW-01')).toMatchObject({ source: 'wms/wh-a/stock', json_path: 'items[sku=RAW-01].qty' })
    expect(find(suggestions, 'KHO_B', 'level:RAW-02')).toMatchObject({ source: 'wms/wh-b/stock', json_path: 'items[sku=RAW-02].qty' })
    expect(suggestions.some((s) => s.subject === 'KHO_A' && s.source === 'wms/wh-b/stock')).toBe(false)
  })

  it('đích xuất: shipped → fulfilled, backlog → backorder', () => {
    expect(find(suggestions, 'SHIP_1', 'fulfilled')?.json_path).toBe('shipped')
    expect(find(suggestions, 'SHIP_1', 'backorder')?.json_path).toBe('backlog')
  })

  it('đội xe: tóm tắt và vị trí (mẫu nguồn dùng + cho số xe)', () => {
    expect(find(suggestions, 'TUG_A', 'busy')?.json_path).toBe('busy')
    expect(find(suggestions, 'TUG_A', 'queue_len')?.json_path).toBe('queue')
    const fleet = find(suggestions, 'TUG_A', 'fleet')!
    expect(fleet).toMatchObject({ source: 'agv/tug-a/+/pos', json_path: '' })
    expect(suggestions.filter((s) => s.subject === 'TUG_A' && s.signal === 'fleet')).toHaveLength(1)
  })

  it('edge: khớp theo hai đầu và vật tư; chuyến xe → trip_s', () => {
    expect(find(suggestions, 'KHO_A>STAMP_1', 'moved')).toMatchObject({ source: 'belt/wh-a~prs-01/flow', json_path: 'moved' })
    expect(find(suggestions, 'KHO_A>STAMP_1', 'trip_s')).toMatchObject({ source: 'agv/trip/wh-a~prs-01', json_path: 'dur' })
    expect(find(suggestions, 'KHO_B>STAMP_2#2', 'moved')?.source).toBe('belt/wh-b~prs-02.2/flow')
    expect(find(suggestions, 'KHO_B>STAMP_2', 'moved')).toBeUndefined()   // đúng cặp nhưng khác vật tư
  })

  it('nguồn không ai nhận được báo là chưa khớp', () => {
    expect(unmatched).toContain('misc/weather')
    expect(unmatched).not.toContain('plc/prs-02/status')
  })

  it('bỏ qua tín hiệu đã ghép và trả độ tin cậy giải thích được', () => {
    const existing = [{ id: 1, model_key: 'm', subject: 'STAMP_2', signal: 'state', source: 'x', json_path: 'y', transform: {}, enabled: true }] as Binding[]
    const again = suggestMapping(sources, subjects, existing).suggestions
    expect(find(again, 'STAMP_2', 'state')).toBeUndefined()
    expect(find(again, 'STAMP_2', 'count_ok')).toBeDefined()
    for (const s of suggestions) {
      expect(s.confidence).toBeGreaterThan(0.6)
      expect(s.confidence).toBeLessThanOrEqual(1)
      expect(s.reason).not.toBe('')
    }
  })

  it('không đề xuất tín hiệu mà đối tượng không có', () => {
    expect(suggestions.some((s) => s.subject === 'KHO_A' && s.signal === 'state')).toBe(false)
    expect(suggestions.some((s) => s.subject === 'SHIP_1' && s.signal === 'vibration')).toBe(false)
  })
})

describe('STATE_ENUM', () => {
  it('đổi các từ trạng thái thường gặp của PLC về trạng thái chuẩn', () => {
    expect(STATE_ENUM).toMatchObject({ RUN: 'RUNNING', IDLE: 'IDLE', WAIT_IN: 'STARVED', WAIT_OUT: 'BLOCKED', ALARM: 'DOWN', FAULT: 'DOWN' })
  })
})
