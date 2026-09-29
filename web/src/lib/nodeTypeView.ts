import type { Json, NodeType } from '../api/types'

/** 45 → "45", 1.5 → "1,5", 0.10 → "0,1". */
function nf(n: number): string {
  if (Number.isInteger(n)) return String(n)
  return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',')
}

export function fmtSeconds(s: number): string {
  if (s < 120) return `${nf(s)} giây`
  if (s < 3600) return `${nf(Math.round(s / 60))} phút`
  return `${nf(Math.round((s / 3600) * 10) / 10)} giờ`
}

export function describeDist(d: unknown, unit = 'giây'): string {
  const val = (n: number) => (unit === 'giây' ? fmtSeconds(n) : `${nf(n)} ${unit}`)
  if (typeof d === 'number') return val(d)
  if (!d || typeof d !== 'object') return '—'
  const o = d as Record<string, unknown>
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) if (typeof o[k] === 'number') return o[k] as number
    return undefined
  }
  const or0 = (n: number | undefined) => n ?? 0
  switch (o.dist) {
    case 'const':
      return val(or0(num('value')))
    case 'lognorm':
      return `log-normal, trung bình ${val(or0(num('mean', 'mean_s')))}, cv ${nf(or0(num('cv')))}`
    case 'norm':
    case 'normal':
      return `chuẩn, trung bình ${val(or0(num('mean', 'mean_s')))}, độ lệch ${nf(or0(num('sd')))}`
    case 'exp':
      return `mũ, trung bình ${val(or0(num('mean', 'mean_s')))}`
    case 'tri':
      return `tam giác ${val(or0(num('min', 'min_s')))}, ${val(or0(num('mode', 'mode_s')))}, ${val(or0(num('max', 'max_s')))}`
    case 'uniform':
      return `đều từ ${val(or0(num('min', 'min_s')))} đến ${val(or0(num('max', 'max_s')))}`
    case 'weibull':
      return `Weibull, shape ${nf(or0(num('shape')))}, scale ${val(or0(num('scale', 'scale_s')))}`
    default:
      return typeof o.dist === 'string' ? o.dist : '—'
  }
}

export type ParamRow = { label: string; value: string }
export type ParamGroup = { title: string; rows: ParamRow[] }

const MARKERS = new Set(['assumed', 'recipes', 'signals', 'failure_modes'])

type Spec = { key: string; label: string; fmt: (v: unknown) => string }
const plain = (v: unknown) => (typeof v === 'number' ? nf(v) : String(v))
const dist = (v: unknown) => describeDist(v)
const percent = (v: unknown) => (typeof v === 'number' ? `${nf(Math.round(v * 1000) / 10)}%` : String(v))
const yesNo = (v: unknown) => (v ? 'Có' : 'Không')

const thresholds = (v: unknown): string => {
  const t = (v ?? {}) as Record<string, number>
  return `Đỏ dưới ${nf(t.red_h ?? 0)} giờ, Vàng dưới ${nf(t.yellow_low_h ?? 0)} giờ hoặc trên ${nf(t.yellow_high_h ?? 0)} giờ`
}
const replenish = (v: unknown): string => {
  const r = (v ?? {}) as Record<string, unknown>
  return r.policy === 'REORDER_POINT' ? `điểm đặt hàng ${plain(r.rop ?? 0)}, mỗi lần ${plain(r.qty ?? 0)}` : 'không bổ sung'
}
const lots = (v: unknown): string =>
  Array.isArray(v) ? v.map((l) => `${String((l as Json).material)} × ${describeDist((l as Json).qty, 'đơn vị')}`).join('; ') : '—'
const demand = (v: unknown): string =>
  Array.isArray(v) ? v.map((d) => `${String((d as Json).material)} (${String((d as Json).kind)})`).join('; ') : '—'

const PROCESS_GROUPS: { title: string; specs: Spec[] }[] = [
  { title: 'Hiệu suất', specs: [
    { key: 'cycle', label: 'Thời gian chu kỳ', fmt: dist }, { key: 'slots', label: 'Số vị trí', fmt: plain },
    { key: 'in_buffer', label: 'Bộ đệm vào', fmt: plain }, { key: 'out_buffer', label: 'Bộ đệm ra', fmt: plain },
  ] },
  { title: 'Chất lượng', specs: [{ key: 'ng_rate', label: 'Tỉ lệ NG', fmt: percent }] },
  { title: 'Khả dụng', specs: [{ key: 'mtbf', label: 'MTBF', fmt: dist }, { key: 'mttr', label: 'MTTR', fmt: dist }] },
]

const OTHER_SPECS: Record<string, Spec[]> = {
  STORAGE: [
    { key: 'capacity', label: 'Dung lượng', fmt: plain }, { key: 'coverage_thresholds', label: 'Ngưỡng tồn kho', fmt: thresholds },
    { key: 'replenish', label: 'Bổ sung', fmt: replenish }, { key: 'coverage_window_s', label: 'Cửa sổ tính số giờ còn đủ dùng', fmt: (v) => fmtSeconds(Number(v)) },
  ],
  SOURCE: [
    { key: 'arrivals', label: 'Khoảng cách giữa các lô', fmt: (v) => describeDist((v as Json | undefined)?.interarrival) },
    { key: 'lots', label: 'Lô hàng', fmt: lots },
  ],
  SINK: [
    { key: 'buffer', label: 'Bộ đệm', fmt: plain }, { key: 'throughput', label: 'Tính vào sản lượng', fmt: yesNo },
    { key: 'demand', label: 'Nhu cầu', fmt: demand },
  ],
  RESOURCE_POOL: [
    { key: 'kind', label: 'Loại', fmt: plain }, { key: 'count', label: 'Số lượng', fmt: plain }, { key: 'service', label: 'Thời gian phục vụ', fmt: dist },
  ],
}

export function paramGroups(t: Pick<NodeType, 'archetype' | 'default_params'>): ParamGroup[] {
  const p = t.default_params ?? {}
  const consumed = new Set<string>()
  const build = (title: string, specs: Spec[]): ParamGroup => {
    const rows: ParamRow[] = []
    for (const s of specs) {
      if (p[s.key] === undefined) continue
      consumed.add(s.key)
      rows.push({ label: s.label, value: s.fmt(p[s.key]) })
    }
    return { title, rows }
  }
  const groups =
    t.archetype === 'PROCESS'
      ? PROCESS_GROUPS.map((g) => build(g.title, g.specs))
      : [build('Tham số', OTHER_SPECS[t.archetype] ?? [])]
  const rest = Object.keys(p).filter((k) => !consumed.has(k) && !MARKERS.has(k))
  if (rest.length) groups.push({ title: 'Khác', rows: rest.map((k) => ({ label: k, value: JSON.stringify(p[k]) })) })
  return groups.filter((g) => g.rows.length > 0)
}

export const isAssumed = (t: Pick<NodeType, 'default_params'>): boolean => t.default_params?.assumed === true

export type RecipeLine = { material: string; qty: number }
export type Recipe = { inputs: RecipeLine[]; outputs: (RecipeLine & { port: 'OK' | 'NG' })[] }

export function recipeOf(t: Pick<NodeType, 'default_params'>): Recipe | null {
  const first = (t.default_params?.recipes as Recipe[] | undefined)?.[0]
  return first ? { inputs: first.inputs ?? [], outputs: first.outputs ?? [] } : null
}

export type FailureRow = { code: string; onset: string; pf: string; repair: string; effects: string[] }

export function failureModeRows(t: Pick<NodeType, 'failure_modes'>): FailureRow[] {
  return (t.failure_modes ?? []).map((raw) => {
    const f = raw as Record<string, unknown>
    const pf = f.p_to_f as Record<string, unknown> | undefined
    const failState = f.on_fail as Record<string, unknown> | undefined
    const range =
      pf?.dist === 'tri' ? `từ ${fmtSeconds(Number(pf.min_s))} đến ${fmtSeconds(Number(pf.max_s))}` : describeDist(pf)
    return {
      code: String(f.code),
      onset: describeDist(f.onset),
      pf: range,
      repair: describeDist(failState?.mttr),
      effects: ((f.effects as Json[] | undefined) ?? []).map((e) => `${String(e.signal)}: ${String(e.kind)}`),
    }
  })
}

export type SignalDefRow = { name: string; unit: string; rate: string; base: string }

export function signalDefRows(t: Pick<NodeType, 'signals'>): SignalDefRow[] {
  return (t.signals ?? []).map((raw) => {
    const s = raw as Record<string, unknown>
    const unit = typeof s.unit === 'string' ? s.unit : ''
    return {
      name: String(s.name),
      unit,
      rate: typeof s.hz === 'number' ? `${nf(s.hz)} Hz` : '—',
      base: s.base === undefined ? '—' : describeDist(s.base, unit),
    }
  })
}
