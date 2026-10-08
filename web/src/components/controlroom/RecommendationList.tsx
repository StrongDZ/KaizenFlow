import type { Insight } from '../../api/types'
import { candidatesOf, describeAction, describeInsight, evidenceRows, expectedImpactRows, tradeOffRows } from '../../lib/insights'
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
            const tradeOffs = tradeOffRows(c)
            const enhanced = Boolean(c.reason) || evidence.length > 0 || impact.length > 0
            const best = c.rank === 1
            return (
            <div key={c.rank} className={`rounded-lg border p-2 ${best ? 'border-ok/70 bg-panel-2 ring-1 ring-ok/20' : 'border-line-2'}`}>
              <div className="mb-1 flex items-center justify-between gap-2">
                {enhanced && <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Đề xuất #{c.rank}</div>}
                {best && <span className="rounded-full bg-ok-solid px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-on-ok">Hiệu quả nhất</span>}
              </div>
              <div className="text-xs font-semibold text-text">{describeAction(c.action)}</div>
              {best && (
                <div className="my-1.5 rounded-md border border-ok/30 bg-panel px-2 py-1.5 text-[10.5px] text-text-2">
                  Điểm hiệu quả tổng thể cao nhất sau mô phỏng, đã cân đối tác động KPI, đánh đổi và chi phí hành động.
                  {typeof c.score_v2 === 'number' && <b className="ml-1 tabular-nums text-text">Điểm {c.score_v2.toFixed(3)}</b>}
                </div>
              )}
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
              {tradeOffs.length > 0 && (
                <div className="mb-2 text-[11px]">
                  <div className="font-semibold text-text">Đánh đổi</div>
                  {tradeOffs.map((row) => (
                    <div key={row.label} className="flex justify-between gap-3 text-muted">
                      <span>{row.label}</span><span className="text-right text-bad-text">{row.value}</span>
                    </div>
                  ))}
                </div>
              )}
              <button className={`${btnPrimary} w-full justify-center`} disabled={pending} onClick={() => onApply(i.id, c.rank)}>
                {best ? 'Áp dụng phương án tốt nhất và chạy lại' : 'Áp dụng và chạy lại'}
              </button>
            </div>
          )})}
        </div>
      ))}
    </div>
  )
}
