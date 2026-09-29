import type { Pin } from '../../lib/pins'
import { describeInsight, insightDetail } from '../../lib/insights'
import { NO_USE_COVERAGE, type Point } from '../../lib/replay'
import { PinDot } from '../PinDot'
import { Sparkline } from './Sparkline'

export function PinCard({ pin, points, redH, now, cursor, recCount, onShowRecs }: {
  pin: Pin; points?: Point[]; redH?: number; now?: number; cursor?: number; recCount: number; onShowRecs: () => void
}) {
  const showChart = pin.insight.kind === 'RED_RISK' && points && points.length > 1
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <PinDot n={pin.n} tone={pin.tone} />
        <div>
          <div className="font-semibold text-text">{describeInsight(pin.insight)}</div>
          <div className="text-muted">{insightDetail(pin.insight)}</div>
          {pin.insight.kind === 'RED_RISK' && now !== undefined && now < NO_USE_COVERAGE && (
            <div className="text-muted">Lúc này còn {now.toFixed(1).replace('.', ',')} giờ</div>
          )}
        </div>
      </div>
      {showChart && (
        <div>
          <Sparkline points={points} redH={redH} cursor={cursor} />
          <div className="text-[10.5px] text-muted">Số giờ tồn kho còn đủ dùng, dải p10 đến p90</div>
        </div>
      )}
      {recCount > 0 && (
        <button onClick={onShowRecs} className="border-b border-faint font-semibold text-text hover:border-text">
          Xem {recCount} đề xuất cho kho này
        </button>
      )}
    </div>
  )
}
