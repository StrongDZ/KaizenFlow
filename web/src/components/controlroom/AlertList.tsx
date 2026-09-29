import { describeInsight, insightDetail } from '../../lib/insights'
import type { Pin } from '../../lib/pins'
import { PinDot } from '../PinDot'

export function AlertList({ pins, onPick }: { pins: Pin[]; onPick: (p: Pin) => void }) {
  if (pins.length === 0) return <p className="text-xs text-muted">Không có cảnh báo.</p>
  return (
    <ul>
      {pins.map((p) => (
        <li key={p.n} className="border-t border-line first:border-0">
          <button className="flex w-full gap-2 py-2 text-left" onClick={() => onPick(p)}>
            <span className="mt-px"><PinDot n={p.n} tone={p.tone} /></span>
            <span>
              <span className="block text-xs text-text">{describeInsight(p.insight)}</span>
              <span className="block text-[11px] text-muted">{insightDetail(p.insight)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
