import type { GaugeState } from '../../api/gauge'
import type { StationKind } from '../../lib/gaugeView'

/**
 * Màu của một trạng thái: đỏ cho vượt ngưỡng, vàng cho ảnh kém, xám cho mất hay chậm tín hiệu. `tag` là nhãn nhẹ trên nền panel,
 * `solid` là nhãn đặc để đọc được khi đè lên ảnh camera.
 */
export type Tone = { text: string; border: string; tag: string; solid: string; dot: string; stroke: string }

const TONES: Record<'ok' | 'alarm' | 'poor' | 'silent', Tone> = {
  ok: { text: 'text-text', border: 'border-line', tag: 'border-line-2 text-text-2', solid: 'bg-bg/85 text-text', dot: 'bg-ok', stroke: 'var(--color-accent)' },
  alarm: { text: 'text-bad-text', border: 'border-bad/70', tag: 'border-bad/40 bg-bad/10 text-bad-text', solid: 'bg-bad text-white', dot: 'bg-bad', stroke: 'var(--color-bad)' },
  poor: { text: 'text-warn', border: 'border-warn/60', tag: 'border-warn/40 bg-warn/10 text-warn', solid: 'bg-warn text-on-warn', dot: 'bg-warn', stroke: 'var(--color-warn)' },
  silent: { text: 'text-muted', border: 'border-line', tag: 'border-line-2 text-muted', solid: 'bg-bg/85 text-muted', dot: 'bg-faint', stroke: 'var(--color-faint)' },
}

export function toneOf(state: GaugeState | StationKind): Tone {
  if (state === 'ok' || state === 'alarm' || state === 'poor') return TONES[state]
  return TONES.silent
}
