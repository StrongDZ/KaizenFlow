import type { Insight } from '../api/types'

export type PinTone = 'bad' | 'warn'
export type Pin = { n: number; insight: Insight; node: string; tone: PinTone }

const WARNING_KINDS = new Set(['RED_RISK', 'BOTTLENECK', 'FAULT_RISK'])

const etaMs = (i: Insight): number => (i.eta ? Date.parse(i.eta) : Number.POSITIVE_INFINITY)

export function assignPins(insights: Insight[]): Pin[] {
  const list = insights.filter((i) => WARNING_KINDS.has(i.kind) && i.subject_key)
  list.sort((a, b) => {
    const sev = (b.severity ?? 0) - (a.severity ?? 0)
    if (sev !== 0) return sev
    const ea = etaMs(a)
    const eb = etaMs(b)
    if (ea !== eb) return ea < eb ? -1 : 1
    return a.id - b.id
  })
  return list.map((insight, i) => ({
    n: i + 1,
    insight,
    node: insight.subject_key as string,
    tone: insight.kind === 'RED_RISK' ? 'bad' : 'warn',
  }))
}

export function pinsByNode(pins: Pin[]): Map<string, Pin[]> {
  const out = new Map<string, Pin[]>()
  for (const p of pins) {
    const list = out.get(p.node)
    if (list) list.push(p)
    else out.set(p.node, [p])
  }
  return out
}
