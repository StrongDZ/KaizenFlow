import { useMutation } from '@tanstack/react-query'
import { ArrowRight, CheckCircle2, Clock3, FlaskConical, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { Insight } from '../api/types'
import { RunGate } from '../components/controlroom/RunGate'
import { EmptyState, ErrorBox, Notice, PageBody, btnPrimary, input } from '../components/ui'
import {
  candidatesOf, describeAction, describeInsight, evidenceRows, expectedImpactRows, tradeOffRows,
  type Candidate,
} from '../lib/insights'

type Recommendation = { insight: Insight; candidate: Candidate; key: string }
type Adjustment = { to_slots?: number; to_rate?: number }

const formatNumber = (value: number, digits = 1) => value.toLocaleString('vi-VN', { maximumFractionDigits: digits })

function metricValue(metric: string, value: number): string {
  if (metric === 'blocked_s' || metric === 'starved_s') return `${formatNumber(value / 60)} phút`
  if (metric === 'red_minutes') return `${formatNumber(value)} phút`
  return formatNumber(value)
}

function KpiComparison({ candidate }: { candidate: Candidate }) {
  const baseline = candidate.expected_impact?.baseline
  const after = candidate.expected_impact?.candidate
  const metrics = [
    ['throughput', 'Sản lượng'],
    ['red_minutes', 'Phút Đỏ'],
    ['backorder', 'Đơn thiếu'],
    ['blocked_s', 'Blocked'],
    ['starved_s', 'Starved'],
    ['wip_peak', 'Đỉnh WIP'],
  ] as const
  const rows = metrics.filter(([key]) => typeof baseline?.[key] === 'number' && typeof after?.[key] === 'number')
  if (rows.length === 0) return null
  return (
    <div className="overflow-hidden rounded-lg border border-line-2">
      <div className="grid grid-cols-[1fr_90px_20px_90px] bg-panel-2 px-3 py-1.5 text-[11px] text-muted">
        <span>KPI</span><span className="text-right">Hiện tại</span><span /><span className="text-right">Sau áp dụng</span>
      </div>
      {rows.map(([key, label]) => (
        <div key={key} className="grid grid-cols-[1fr_90px_20px_90px] items-center border-t border-line px-3 py-2 text-[11px]">
          <span className="text-text-2">{label}</span>
          <span className="text-right tabular-nums text-muted">{metricValue(key, baseline![key] as number)}</span>
          <ArrowRight size={12} className="mx-auto text-faint" />
          <span className="text-right font-semibold tabular-nums text-text">{metricValue(key, after![key] as number)}</span>
        </div>
      ))}
    </div>
  )
}

function DetailRows({ title, rows, danger = false }: { title: string; rows: { label: string; value: string }[]; danger?: boolean }) {
  if (rows.length === 0) return null
  return (
    <div>
      <h3 className="mb-1.5 text-[11px] font-semibold text-text">{title}</h3>
      <div className="space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between gap-4 text-[11px] text-muted">
            <span>{row.label}</span><span className={`text-right tabular-nums ${danger ? 'text-bad-text' : 'text-text'}`}>{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ActionEditor({ candidate, onAdjustment }: { candidate: Candidate; onAdjustment: (value: Adjustment | undefined, edited: boolean, valid: boolean) => void }) {
  const action = candidate.action
  const [slots, setSlots] = useState(action.to_slots ?? 1)
  const [rate, setRate] = useState(action.to_rate ?? 0)

  useEffect(() => {
    setSlots(action.to_slots ?? 1)
    setRate(action.to_rate ?? 0)
  }, [action])

  const slotAction = action.type === 'INCREASE_PROCESS_CAPACITY' && typeof action.from_slots === 'number' && typeof action.to_slots === 'number'
  const rateAction = action.type === 'REDUCE_MACHINE_RATE' && typeof action.from_rate === 'number' && typeof action.to_rate === 'number'
  const edited = slotAction ? slots !== action.to_slots : rateAction ? Math.abs(rate - (action.to_rate ?? 0)) > 0.001 : false
  const valid = slotAction
    ? Number.isInteger(slots) && slots > (action.from_slots ?? 0) && slots <= 8
    : rateAction
      ? Number.isFinite(rate) && rate >= (action.from_rate ?? 0) * 0.5 && rate < (action.from_rate ?? 0)
      : true
  const adjustment = edited
    ? slotAction ? { to_slots: slots } : rateAction ? { to_rate: rate } : undefined
    : undefined

  useEffect(() => onAdjustment(adjustment, edited, valid), [adjustment?.to_rate, adjustment?.to_slots, edited, valid, onAdjustment])

  if (!slotAction && !rateAction) {
    return (
      <div className="rounded-lg border border-line-2 bg-panel-2 p-3">
        <div className="text-[11px] font-semibold text-text">Thao tác sẽ được áp dụng</div>
        <div className="mt-1 text-xs text-text-2">{describeAction(action)}</div>
        <div className="mt-1 text-[10.5px] text-muted">Loại action này dùng đúng cấu hình đã được mô phỏng, chưa hỗ trợ chỉnh trực tiếp.</div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-accent/35 bg-panel-2 p-3">
      <div className="mb-3 flex items-center gap-2">
        <SlidersHorizontal size={14} className="text-accent" />
        <div>
          <div className="text-[11px] font-semibold text-text">Tinh chỉnh trước khi chạy thử</div>
          <div className="text-[10px] text-muted">Chỉ thay tham số của đúng action đã chọn; mô hình gốc không bị sửa.</div>
        </div>
      </div>
      {slotAction && (
        <label className="grid grid-cols-[1fr_120px] items-center gap-4 text-[11px]">
          <span>
            <b className="block text-text">Số slot xử lý song song của {action.target}</b>
            <span className="text-muted">Hiện tại {action.from_slots} · gợi ý đã kiểm chứng {action.to_slots} · tối đa 8</span>
          </span>
          <input
            className={`${input} w-full text-right tabular-nums`} type="number" min={(action.from_slots ?? 0) + 1} max={8} step={1}
            value={slots} onChange={(event) => setSlots(Number(event.target.value))}
          />
        </label>
      )}
      {rateAction && (
        <label className="grid grid-cols-[1fr_140px] items-center gap-4 text-[11px]">
          <span>
            <b className="block text-text">Nhịp mục tiêu của {action.target}</b>
            <span className="text-muted">Hiện tại {formatNumber(action.from_rate ?? 0)} u/h · gợi ý {formatNumber(action.to_rate ?? 0)} u/h</span>
          </span>
          <span className="flex items-center gap-1">
            <input
              className={`${input} w-full text-right tabular-nums`} type="number" min={(action.from_rate ?? 0) * 0.5}
              max={(action.from_rate ?? 0) - 0.1} step={0.1} value={rate} onChange={(event) => setRate(Number(event.target.value))}
            />
            <span className="text-muted">u/h</span>
          </span>
        </label>
      )}
      {!valid && <p className="mt-2 text-[10.5px] text-bad-text">Giá trị nằm ngoài phạm vi an toàn của action này.</p>}
    </div>
  )
}

function Body({ runId, insights, replications }: { runId: number; insights: Insight[]; replications: number }) {
  const navigate = useNavigate()
  const recommendations = useMemo<Recommendation[]>(() => insights.flatMap((insight) =>
    candidatesOf(insight).map((candidate) => ({ insight, candidate, key: `${insight.id}:${candidate.rank}` })),
  ), [insights])
  const [selectedKey, setSelectedKey] = useState(() => recommendations[0]?.key ?? '')
  const selected = recommendations.find((item) => item.key === selectedKey) ?? recommendations[0]
  const [adjustment, setAdjustment] = useState<Adjustment | undefined>()
  const [edited, setEdited] = useState(false)
  const [valid, setValid] = useState(true)

  useEffect(() => {
    if (!recommendations.some((item) => item.key === selectedKey)) setSelectedKey(recommendations[0]?.key ?? '')
  }, [recommendations, selectedKey])

  useEffect(() => {
    setAdjustment(undefined)
    setEdited(false)
    setValid(true)
  }, [selectedKey])

  const handleAdjustment = useCallback((value: Adjustment | undefined, isEdited: boolean, isValid: boolean) => {
    setAdjustment(value)
    setEdited(isEdited)
    setValid(isValid)
  }, [])

  const apply = useMutation({
    mutationFn: ({ id, rank, tuning }: { id: number; rank: number; tuning?: Adjustment }) => api.applyInsight(id, rank, tuning),
    onSuccess: (result) => navigate(`/runs/${result.run_id}?baseline=${runId}&story=1`),
  })

  if (!selected) {
    return (
      <EmptyState title="Chưa có đề xuất cho lần chạy này">
        Engine đã thử các thay đổi khả thi (thêm vị trí ở trạm nghẽn, hạ nhịp máy có nguy cơ hỏng…) nhưng không thay đổi nào cải thiện KPI rõ rệt qua {replications} lần lặp.
        Xem diễn biến ở <Link className="text-accent underline" to={`/runs/${runId}`}>Control Room</Link>, hoặc tạo scenario có tình huống bất lợi hơn để engine có việc để đề xuất.
      </EmptyState>
    )
  }

  const evidence = evidenceRows(selected.candidate.evidence)
  const impact = expectedImpactRows(selected.candidate)
  const tradeOffs = tradeOffRows(selected.candidate)
  const best = selected.candidate.rank === 1

  return (
    <PageBody wide>
      <p className="text-xs text-muted">
        {recommendations.length} phương án engine đã chạy thử qua {replications} lần lặp, xếp theo hiệu quả tổng thể. Chọn một phương án để xem lý do, bằng chứng và tác động,
        chỉnh tham số nếu cần, rồi chạy lại để kiểm chứng.
      </p>

      <div className="grid gap-4 lg:grid-cols-[330px_minmax(0,1fr)]">
        <section className="self-start rounded-xl border border-line bg-panel p-2">
          <h2 className="px-2 py-1.5 text-[11px] text-muted">Phương án</h2>
          <div className="space-y-1.5">
            {recommendations.map((item) => {
              const active = item.key === selected.key
              return (
                <button
                  key={item.key} onClick={() => setSelectedKey(item.key)}
                  className={`w-full rounded-lg border p-3 text-left transition ${active ? 'border-accent bg-panel-2 ring-1 ring-accent/20' : 'border-transparent hover:border-line-2 hover:bg-panel-2'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted">Hạng {item.candidate.rank}</span>
                    {item.candidate.rank === 1 && <span className="rounded-[5px] border border-ok/40 px-1.5 text-[10.5px] text-ok">Tốt nhất</span>}
                  </div>
                  <div className="mt-1 text-xs font-semibold leading-5 text-text">{describeAction(item.candidate.action)}</div>
                  <div className="mt-1 line-clamp-2 text-[10.5px] leading-4 text-muted">{describeInsight(item.insight)}</div>
                </button>
              )
            })}
          </div>
        </section>

        <section className={`overflow-hidden rounded-xl border bg-panel ${best ? 'border-ok/55' : 'border-line'}`}>
          <header className="border-b border-line bg-panel-2 px-5 py-4">
            <div className="flex flex-wrap items-start gap-3">
              <span className={`flex h-9 w-9 flex-none items-center justify-center rounded-lg ${best ? 'bg-ok/12 text-ok' : 'bg-accent/12 text-accent'}`}>
                {best ? <CheckCircle2 size={19} /> : <FlaskConical size={18} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-text">{describeAction(selected.candidate.action)}</h2>
                  {best && <span className="rounded-[5px] border border-ok/40 px-1.5 text-[10.5px] text-ok">Hiệu quả tổng thể cao nhất</span>}
                </div>
                <p className="mt-1 text-[11px] text-muted">Xếp hạng #{selected.candidate.rank}{typeof selected.candidate.score_v2 === 'number' ? ` · điểm ${selected.candidate.score_v2.toFixed(3)}` : ''}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded-full border border-line-2 px-2 py-0.5 text-[9.5px] text-text-2"><ShieldCheck size={10} className="text-ok" /> Đã kiểm chứng qua {replications} lần lặp</span>
                  {selected.insight.eta && <span className="inline-flex items-center gap-1 rounded-full border border-warn/40 px-2 py-0.5 text-[9.5px] text-warn"><Clock3 size={10} /> Cần xử lý trước {new Date(selected.insight.eta).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span>}
                </div>
              </div>
            </div>
          </header>

          <div className="space-y-5 p-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h3 className="mb-1 text-[11px] font-semibold text-text">Vấn đề</h3>
                <p className="text-xs leading-5 text-text-2">{describeInsight(selected.insight)}</p>
              </div>
              <div>
                <h3 className="mb-1 text-[11px] font-semibold text-text">Vì sao đề xuất action này</h3>
                <p className="text-xs leading-5 text-text-2">{selected.candidate.reason || 'Action này tạo kết quả tốt hơn baseline trong mô phỏng.'}</p>
              </div>
            </div>

            <div className="grid gap-5 md:grid-cols-3">
              <DetailRows title="Bằng chứng" rows={evidence} />
              <DetailRows title="Tác động dự kiến" rows={impact} />
              <DetailRows title="Đánh đổi" rows={tradeOffs} danger />
            </div>

            <div>
              <h3 className="mb-2 text-[11px] font-semibold text-text">KPI baseline và phương án đã mô phỏng</h3>
              <KpiComparison candidate={selected.candidate} />
            </div>

            <ActionEditor
              key={selected.key}
              candidate={selected.candidate}
              onAdjustment={handleAdjustment}
            />

            {edited && (
              <Notice>
                Bạn đã đổi tham số. KPI và thứ hạng phía trên thuộc giá trị gợi ý ban đầu; cấu hình mới chưa được kiểm chứng cho tới khi lần chạy mới hoàn tất.
              </Notice>
            )}
            <ErrorBox error={apply.error} />
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <p className="max-w-xl text-[10.5px] leading-4 text-muted">
                Thao tác này tạo scenario con cùng seed với baseline để so sánh công bằng; không thay đổi mô hình đã publish.
              </p>
              <button
                className={btnPrimary} disabled={apply.isPending || !valid}
                onClick={() => apply.mutate({ id: selected.insight.id, rank: selected.candidate.rank, tuning: adjustment })}
              >
                <FlaskConical size={14} />
                {apply.isPending ? 'Đang tạo lần chạy…' : edited ? 'Chạy thử cấu hình đã chỉnh' : 'Áp dụng và chạy lại'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </PageBody>
  )
}

export default function RunRecommendationsPage() {
  const runId = Number(useParams().id)
  return (
    <RunGate runId={runId}>
      {({ run, scenario }) => <Body runId={runId} replications={scenario.replications} insights={run.insights.filter((insight) => insight.kind === 'RECOMMENDATION')} />}
    </RunGate>
  )
}
