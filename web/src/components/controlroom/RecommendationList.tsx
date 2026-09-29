import type { Insight } from '../../api/types'
import { candidatesOf, describeAction, describeInsight } from '../../lib/insights'
import { fmtDelta } from '../../lib/format'
import { ErrorBox, btnPrimary } from '../ui'

export function RecommendationList({ insights, pending, error, onApply }: {
  insights: Insight[]; pending: boolean; error: unknown; onApply: (insightId: number, rank: number) => void
}) {
  const withCandidates = insights.filter((i) => candidatesOf(i).length > 0)
  if (withCandidates.length === 0) {
    return <p className="text-xs text-muted">Không có hành động nào cải thiện được kết quả.</p>
  }
  return (
    <div className="space-y-3">
      <ErrorBox error={error} />
      {withCandidates.map((i) => (
        <div key={i.id} className="space-y-2">
          <div className="text-[11px] text-muted">{describeInsight(i)}</div>
          {candidatesOf(i).map((c) => (
            <div key={c.rank} className="rounded-lg border border-line-2 p-2">
              <div className="text-xs font-semibold text-text">{describeAction(c.action)}</div>
              <div className="mb-1.5 text-[11px] text-muted">
                giảm {c.delta_kpi.red_minutes.toFixed(1).replace('.', ',')} phút Đỏ, sản lượng {fmtDelta(c.delta_kpi.throughput)}
              </div>
              <button className={`${btnPrimary} w-full justify-center`} disabled={pending} onClick={() => onApply(i.id, c.rank)}>
                Áp dụng và chạy lại
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
