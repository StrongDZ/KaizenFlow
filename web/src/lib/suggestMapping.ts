import type { Binding, SourceSnap, SubjectView, Transform } from '../api/types'
import { leafPaths } from './livePath'

/** Từ trạng thái thường gặp của PLC về trạng thái chuẩn của hệ thống. */
export const STATE_ENUM: Record<string, string> = {
  RUN: 'RUNNING', RUNNING: 'RUNNING', ON: 'RUNNING',
  IDLE: 'IDLE', STANDBY: 'IDLE',
  WAIT_IN: 'STARVED', STARVED: 'STARVED',
  WAIT_OUT: 'BLOCKED', BLOCKED: 'BLOCKED',
  ALARM: 'DOWN', FAULT: 'DOWN', ERROR: 'DOWN', STOP: 'DOWN', DOWN: 'DOWN',
}

export type Suggestion = {
  subject: string
  signal: string
  source: string
  json_path: string
  transform?: Transform
  confidence: number
  reason: string
}

const MIN_CONFIDENCE = 0.6

export function norm(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

const isId = (t: string) => /^\d+$/.test(t) || t.length === 1

/** Độ giống của hai tên (0..1). Số hiệu và ký hiệu một chữ (2, A, B) phải khớp hoàn toàn: "Máy dập 1" không phải "Máy dập 2". */
export function nameScore(a: string, b: string): number {
  const na = norm(a)
  const nb = norm(b)
  if (na === '' || nb === '') return 0
  if (na === nb) return 1
  const key = (t: string) => (/^\d+$/.test(t) ? String(Number(t)) : t)
  const ta = na.split(' ').map(key)
  const tb = nb.split(' ').map(key)
  const ida = new Set(ta.filter(isId))
  const idb = new Set(tb.filter(isId))
  if (ida.size !== idb.size || [...ida].some((t) => !idb.has(t))) return 0
  const inter = ta.filter((t) => tb.includes(t)).length
  const union = new Set([...ta, ...tb]).size
  return (inter / union) * 0.9
}

type Rule = { re: RegExp; signal: (m: RegExpMatchArray) => string; text?: boolean }

const RULES: Rule[] = [
  { re: /^(st|state|status|mode)$/i, signal: () => 'state', text: true },
  { re: /(^|\.)(cnt|count)\.in$|^count_in$/i, signal: () => 'count_in' },
  { re: /(^|\.)(cnt|count)\.(ok|good)$|^count_ok$/i, signal: () => 'count_ok' },
  { re: /(^|\.)(cnt|count)\.(ng|bad|reject)$|^count_ng$/i, signal: () => 'count_ng' },
  { re: /^(vib|vibration)$/i, signal: () => 'vibration' },
  { re: /^\w+\[(?:sku|material|item)=(.+)\]\.(?:qty|quantity|level)$/i, signal: (m) => `level:${m[1]}` },
  { re: /^arrived$/i, signal: () => 'arrived' },
  { re: /^demand$/i, signal: () => 'demand' },
  { re: /^(shipped|fulfilled)$/i, signal: () => 'fulfilled' },
  { re: /^(backlog|backorder)$/i, signal: () => 'backorder' },
  { re: /^busy$/i, signal: () => 'busy' },
  { re: /^(queue|queue_len)$/i, signal: () => 'queue_len' },
  { re: /^moved$/i, signal: () => 'moved' },
  { re: /^(in_transit|transit)$/i, signal: () => 'in_transit' },
  { re: /^(dur|trip_s|duration)$/i, signal: () => 'trip_s' },
]

/** Phần tên trong mô tả nguồn: bỏ tiền tố "Chuyến xe:", đuôi "(vật tư)" và hậu tố " — xe 1". */
function describe(desc: string): { name: string; material?: string; isEdge: boolean } {
  let d = desc.replace(/^chuyến xe:\s*/i, '').trim()
  const mat = d.match(/\(([^)]+)\)\s*$/)
  if (mat) d = d.slice(0, mat.index).trim()
  d = d.split(' — ')[0].trim()
  return { name: d, material: mat?.[1], isEdge: d.includes('→') }
}

/** Mẫu nguồn cho cả đội xe: `agv/tug-a/01/pos` → `agv/tug-a/+/pos`. */
function fleetPattern(source: string): string {
  return source.split('/').map((seg) => (/^\d+$/.test(seg) ? '+' : seg)).join('/')
}

function isFleetPayload(v: unknown): boolean {
  return !!v && typeof v === 'object' && 'id' in v && 'x' in v && 'y' in v
}

/**
 * Gợi ý ghép tự động: nguồn nào hợp với node/edge nào (theo tên mô tả), trường nào ứng với tín hiệu chuẩn nào.
 * Chỉ dùng được khi thiết bị mô tả mình đủ rõ; thiết bị thật thì người dùng ghép tay. Bỏ qua cái đã ghép.
 */
export function suggestMapping(sources: SourceSnap[], subjects: SubjectView[], existing: Binding[]): { suggestions: Suggestion[]; unmatched: string[] } {
  const taken = new Set(existing.map((b) => `${b.subject}|${b.signal}`))
  const seen = new Set<string>()
  const suggestions: Suggestion[] = []
  const unmatched: string[] = []
  for (const so of sources) {
    const d = describe(so.desc)
    const pool = subjects.filter((s) => (d.isEdge ? s.kind === 'edge' : s.kind === 'node'))
    let best = 0
    let winners: SubjectView[] = []
    for (const sub of pool) {
      if (d.isEdge && d.material && sub.material && sub.material !== d.material) continue
      const score = nameScore(d.name, sub.name)
      if (score > best + 1e-9) { best = score; winners = [sub] } else if (Math.abs(score - best) < 1e-9 && score > 0) winners.push(sub)
    }
    let produced = false
    if (best >= MIN_CONFIDENCE) {
      for (const sub of winners) {
        const has = (name: string) => sub.signals.some((x) => x.name === name)
        const add = (signal: string, json_path: string, source: string, transform?: Transform) => {
          produced = true
          const k = `${sub.subject}|${signal}`
          if (taken.has(k) || seen.has(k)) return
          seen.add(k)
          suggestions.push({ subject: sub.subject, signal, source, json_path, transform, confidence: best,
            reason: best === 1 ? `Tên khớp hoàn toàn với "${sub.name}"` : `Tên gần giống "${sub.name}"` })
        }
        if (isFleetPayload(so.last) && has('fleet')) add('fleet', '', fleetPattern(so.source))
        for (const leaf of leafPaths(so.last)) {
          for (const rule of RULES) {
            const m = leaf.path.match(rule.re)
            if (!m) continue
            const signal = rule.signal(m)
            if (rule.text ? typeof leaf.value !== 'string' : typeof leaf.value !== 'number') break
            if (has(signal)) add(signal, leaf.path, so.source, rule.text ? { enum: { ...STATE_ENUM } } : undefined)
            break
          }
        }
      }
    }
    if (!produced) unmatched.push(so.source)
  }
  return { suggestions, unmatched }
}
