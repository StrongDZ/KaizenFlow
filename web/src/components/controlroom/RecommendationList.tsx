import type { Insight } from '../../api/types'
import { candidatesOf, describeAction, describeInsight, evidenceRows, expectedImpactRows } from '../../lib/insights'
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
          {candidatesOf(i).map((c) => {
            const evidence = evidenceRows(c.evidence)
            const impact = expectedImpactRows(c)
            const enhanced = Boolean(c.reason) || evidence.length > 0 || impact.length > 0
            return (
            <div key={c.rank} className="rounded-lg border border-line-2 p-2">
              {enhanced && <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Đề xuất #{c.rank}</div>}
              <div className="text-xs font-semibold text-text">{describeAction(c.action)}</div>
              <div className="mb-1.5 text-[11px] text-muted">
                giảm {c.delta_kpi.red_minutes.toFixed(1).replace('.', ',')} phút Đỏ, sản lượng {fmtDelta(c.delta_kpi.throughput)}
              </div>
              {c.reason && (
                <div className="mb-2 text-[11px] text-text">
                  <div className="font-semibold">Vì sao</div>
                  <div>{c.reason}</div>
                </div>
              )}
              {evidence.length > 0 && (
                <div className="mb-2 text-[11px]">
                  <div className="font-semibold text-text">Bằng chứng</div>
                  {evidence.map((row) => (
                    <div key={row.label} className="flex justify-between gap-3 text-muted">
                      <span>{row.label}</span><span className="text-right text-text">{row.value}</span>
                    </div>
                  ))}
                </div>
              )}
              {impact.length > 0 && (
                <div className="mb-2 text-[11px]">
                  <div className="font-semibold text-text">Tác động dự kiến</div>
                  {impact.map((row) => (
                    <div key={row.label} className="flex justify-between gap-3 text-muted">
                      <span>{row.label}</span><span className="text-right text-text">{row.value}</span>
                    </div>
                  ))}
                </div>
              )}
              <button className={`${btnPrimary} w-full justify-center`} disabled={pending} onClick={() => onApply(i.id, c.rank)}>
                Áp dụng và chạy lại
              </button>
            </div>
          )})}
        </div>
      ))}
    </div>
  )
}
