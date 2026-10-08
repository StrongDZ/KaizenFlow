import type { Json, SubjectSnap } from '../api/types'
import { nodeBadge, stateLabel, STALE_MS } from './liveFrame'
import type { Thresholds } from './replay'

export type Tone = 'ok' | 'warn' | 'bad' | 'muted'
/** Dòng chữ ngắn hiện dưới node trên bản đồ. */
export type MapLine = { text: string; tone: Tone }
/** Một thông số của node: `live` là số đo từ thiết bị, `config` là thiết lập trong sơ đồ. */
export type NodeFact = { label: string; value: string; section: 'live' | 'config'; tone?: Tone }

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const comma = (x: number) => String(Math.round(x * 10) / 10).replace('.', ',')
const val = (s: SubjectSnap | undefined, name: string): number | undefined => s?.signals[name]?.v
const count = (x: number) => String(Math.round(x))

/** Giá trị trung bình (giây) của một phân phối thời gian trong tham số node; không hiểu dạng phân phối thì undefined. */
export function distMean(d: unknown): number | undefined {
  if (d === null || typeof d !== 'object') return undefined
  const o = d as Record<string, unknown>
  switch (o.dist) {
    case 'const': return num(o.value)
    case 'uniform': { const a = num(o.min), b = num(o.max); return a !== undefined && b !== undefined ? (a + b) / 2 : undefined }
    case 'tri': { const a = num(o.min), m = num(o.mode), b = num(o.max); return a !== undefined && m !== undefined && b !== undefined ? (a + m + b) / 3 : undefined }
    default: return o.dist === undefined ? undefined : num(o.mean)
  }
}

/** 45 → "45 giây", 90 → "1,5 phút", 7200 → "2 giờ". */
export function formatSeconds(s: number): string {
  if (s < 60) return `${comma(s)} giây`
  if (s < 3600) return `${comma(s / 60)} phút`
  return `${comma(s / 3600)} giờ`
}

const TONE: Record<string, Tone> = { GREEN: 'ok', YELLOW: 'warn', RED: 'bad', INFO: 'muted' }
const BAD_STATE = new Set(['DOWN'])
const WARN_STATE = new Set(['STARVED', 'BLOCKED'])

type Stock = { material: string; initial?: number; max?: number }
const stockOf = (params: Json): Stock[] => (Array.isArray(params.stock) ? (params.stock as Json[]).map((x) => ({ material: String(x.material), initial: num(x.initial), max: num(x.max) })) : [])
const levelsOf = (s: SubjectSnap | undefined): [string, number][] =>
  Object.entries(s?.signals ?? {}).filter(([k]) => k.startsWith('level:')).map(([k, x]) => [k.slice('level:'.length), x.v])

/** Gom danh sách "tên giá trị" thành một dòng, tối đa `max` mục, phần còn lại thành "+N vật tư". */
function joinMaterials(items: string[], max = 2): string {
  return items.length <= max ? items.join(' · ') : [...items.slice(0, max), `+${items.length - max} vật tư`].join(' · ')
}

/**
 * Tối đa hai dòng chữ ngắn để hiện dưới node trên bản đồ. Có dữ liệu live thì hiện trạng thái và số đo quan trọng (cùng màu với trang Trực tiếp);
 * chưa có thì hiện thông số cấu hình để node vẫn có thông tin; không có gì để nói thì mảng rỗng.
 */
export function mapLines(archetype: string, snap: SubjectSnap | undefined, params: Json, th: Thresholds, poolTotal?: number): MapLine[] {
  const badge = nodeBadge(archetype, snap, th, poolTotal)
  if (badge && snap) {
    const first: MapLine = { text: badge.text, tone: TONE[badge.color] ?? 'muted' }
    if (snap.age_ms > STALE_MS) return [first]
    const second: string[] = []
    switch (archetype) {
      case 'PROCESS': {
        const ng = val(snap, 'count_ng')
        const cycle = distMean(params.cycle)
        if (ng !== undefined) second.push(`lỗi ${count(ng)}`)
        if (cycle !== undefined) second.push(`chu kỳ ${formatSeconds(cycle)}`)
        break
      }
      case 'STORAGE': {
        const lv = levelsOf(snap)
        if (lv.length > 0) second.push(joinMaterials(lv.map(([m, v]) => `${m} ${count(v)}`)))
        break
      }
      case 'SINK': {
        const done = val(snap, 'fulfilled'), demand = val(snap, 'demand')
        if (done !== undefined) second.push(demand !== undefined ? `giao ${count(done)} / nhu cầu ${count(demand)}` : `giao ${count(done)}`)
        break
      }
    }
    const state = archetype === 'PROCESS' && snap.state ? snap.state : ''
    if (BAD_STATE.has(state)) first.tone = 'bad'
    else if (WARN_STATE.has(state)) first.tone = 'warn'
    return second.length > 0 ? [first, { text: second.join(' · '), tone: 'muted' }] : [first]
  }
  // chưa có dữ liệu live: thông số cấu hình
  switch (archetype) {
    case 'PROCESS': {
      const parts: string[] = []
      const cycle = distMean(params.cycle), slots = num(params.slots)
      if (cycle !== undefined) parts.push(`chu kỳ ${formatSeconds(cycle)}`)
      if (slots !== undefined) parts.push(`${count(slots)} vị trí`)
      return parts.length > 0 ? [{ text: parts.join(' · '), tone: 'muted' }] : []
    }
    case 'STORAGE': {
      const st = stockOf(params)
      if (st.length === 0) return []
      const one = (s: Stock) => `${s.material} tồn đầu ${s.initial !== undefined ? count(s.initial) : '?'}${s.max !== undefined ? ` / ${count(s.max)}` : ''}`
      return [{ text: st.length === 1 ? one(st[0]) : joinMaterials(st.map((s) => `${s.material} ${s.initial !== undefined ? count(s.initial) : '?'}`)), tone: 'muted' }]
    }
  }
  return []
}

/** Bảng thông số đầy đủ của node: số đo trực tiếp (nếu có tín hiệu) rồi thiết lập trong sơ đồ. */
export function nodeFacts(archetype: string, snap: SubjectSnap | undefined, params: Json, th: Thresholds, poolTotal?: number): NodeFact[] {
  const out: NodeFact[] = []
  const live = (label: string, value: string | undefined, tone?: Tone) => { if (value !== undefined) out.push({ label, value, section: 'live', tone }) }
  const config = (label: string, value: string | undefined) => { if (value !== undefined) out.push({ label, value, section: 'config' }) }
  const fresh = snap !== undefined && snap.age_ms <= STALE_MS
  const n = (name: string) => { const v = fresh ? val(snap, name) : undefined; return v === undefined ? undefined : count(v) }
  switch (archetype) {
    case 'PROCESS': {
      if (fresh && snap.state) live('Trạng thái', stateLabel(snap.state), BAD_STATE.has(snap.state) ? 'bad' : WARN_STATE.has(snap.state) ? 'warn' : 'ok')
      live('Đầu vào', n('count_in'))
      live('Đạt', n('count_ok'))
      live('Lỗi', n('count_ng'))
      const cycle = distMean(params.cycle), slots = num(params.slots)
      config('Chu kỳ', cycle !== undefined ? formatSeconds(cycle) : undefined)
      config('Số vị trí chạy song song', slots !== undefined ? count(slots) : undefined)
      break
    }
    case 'STORAGE': {
      const badge = nodeBadge(archetype, snap, th)
      const cov = fresh ? val(snap, 'coverage_h') : undefined
      if (cov !== undefined && badge) live('Còn dùng', badge.text.replace(/^còn /, ''), TONE[badge.color])
      const stock = stockOf(params)
      for (const [m, v] of fresh ? levelsOf(snap) : []) {
        const max = stock.find((s) => s.material === m)?.max
        live(`Tồn ${m}`, `${count(v)}${max !== undefined ? ` / ${count(max)}` : ''}`)
      }
      const cap = num(params.capacity)
      config('Sức chứa tổng', cap !== undefined ? count(cap) : undefined)
      for (const s of stock) if (!fresh || levelsOf(snap).every(([m]) => m !== s.material)) config(`Tồn đầu ${s.material}`, `${s.initial !== undefined ? count(s.initial) : '?'}${s.max !== undefined ? ` / ${count(s.max)}` : ''}`)
      break
    }
    case 'SINK': {
      const bo = fresh ? val(snap, 'backorder') : undefined
      live('Đã giao', n('fulfilled'))
      live('Nhu cầu tích luỹ', n('demand'))
      live('Nợ đơn', n('backorder'), bo !== undefined && bo > 0 ? 'warn' : 'ok')
      break
    }
    case 'SOURCE':
      live('Đã nhập', n('arrived'))
      break
    case 'RESOURCE_POOL':
      live('Đang bận', n('busy'))
      live('Lượt đang chờ', n('queue_len'))
      config('Số xe', poolTotal !== undefined ? count(poolTotal) : undefined)
      break
  }
  return out
}
