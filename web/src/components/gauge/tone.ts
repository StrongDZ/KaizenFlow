import type { GaugeState } from '../../api/gauge'
import type { StationKind } from '../../lib/gaugeView'

/** Màu của một trạng thái. Đỏ cam cho vượt ngưỡng, vàng cam cho ảnh kém, xám cho mất tín hiệu: ba màu khác cả độ sáng. */
export type Tone = { text: string; border: string; bg: string; dot: string; stroke: string }

const TONES: Record<'ok' | 'alarm' | 'poor' | 'silent', Tone> = {
  ok: { text: 'text-ok', border: 'border-ok', bg: 'bg-ok text-on-accent', dot: 'bg-ok', stroke: 'var(--color-ok)' },
  alarm: { text: 'text-bad', border: 'border-bad', bg: 'bg-bad text-on-accent', dot: 'bg-bad', stroke: 'var(--color-bad)' },
  poor: { text: 'text-warn', border: 'border-warn', bg: 'bg-warn text-on-accent', dot: 'bg-warn', stroke: 'var(--color-warn)' },
  silent: { text: 'text-muted', border: 'border-line-2', bg: 'bg-line-2 text-text', dot: 'bg-faint', stroke: 'var(--color-faint)' },
}

export function toneOf(state: GaugeState | StationKind): Tone {
  if (state === 'ok' || state === 'alarm' || state === 'poor') return TONES[state]
  return TONES.silent
}
