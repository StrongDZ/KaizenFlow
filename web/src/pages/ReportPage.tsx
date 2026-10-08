import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, FileText, GitCompare, TriangleAlert } from 'lucide-react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Link, useParams } from 'react-router-dom'
import { useEffect } from 'react'
import { api } from '../api/client'
import type { Run, Scenario } from '../api/types'
import { BandChart, axisLine, axisTick, tooltipProps } from '../components/Charts'
import { ScenarioTimeline } from '../components/scenario/ScenarioTimeline'
import { DecisionJourney } from '../components/scenario/DecisionJourney'
import { DataTable, type Column } from '../components/table/DataTable'
import { Card, EmptyState, ErrorBox, Loading, Notice, PageBody, PageHeader, Tag, btn, btnPrimary } from '../components/ui'
import { candidatesOf, describeAction, describeInsight, evidenceRows, kpiBand, kpiP50, tradeOffRows, type Action, type Candidate } from '../lib/insights'
import { fmtDelta } from '../lib/format'
import { byCode, thresholdsFor } from '../lib/model'
import { clip, indexBands, series } from '../lib/replay'
import { appliedVerdict, failureImpactsOf, pickParentBaseline, reportMetricText, type FailureImpact } from '../lib/report'
import { FULL_DETAIL_MAX_HORIZON_S, describeInjection, describeOverride, formatScenarioDuration, scenarioWarmupSeconds, startStateLabel } from '../lib/scenarioView'

type ReportMode = 'run' | 'benchmarks'

type GlobalSummaryRow = {
  rank: number
  method: string
  vw_smape_pct: number
  vw_accuracy_pct: number
  delta_smape_vs_base: number
  delta_acc_vs_base: number
}

type ValidationRow = {
  sku_id: number
  category: string
  weight_usd: number
  base_smape: number
  custom_smape: number
  ml_smape: number
  hybrid_smape: number
  best_method: string
  base_acc: number
  custom_acc: number
  ml_acc: number
  hybrid_acc: number
}

type TunerRow = {
  rank_vw_smape: number
  cfg_id: string
  n_wins_best_per_sku: number
  value_weighted_SMAPE_pct: number
  value_weighted_Accuracy_pct: number
  backtest_avg_SMAPE_pct: number
  cfg_label: string
}

type ParetoRow = {
  alpha: number
  downtime_min_mean: number
  agv_km_mean: number
  throughput_cases_mean: number
  red_alert_mean: number
  downtime_pct_vs_alpha0: number
  agv_km_pct_vs_alpha0: number
}

type PerSkuRow = {
  sku_id: number
  sku_name: string
  category: string
  weight_value_usd: number
  baseline_old_HW_smape: number
  hybrid_final_smape: number
  delta_smape_vs_baseline: number
  baseline_old_HW_acc: number
  hybrid_final_acc: number
  best_method: string
}

const CANDIDATE_METRICS = [
  { key: 'throughput', label: 'Sản lượng', scale: 1, suffix: '', higherBetter: true },
  { key: 'red_minutes', label: 'Phút Đỏ', scale: 1, suffix: ' phút', higherBetter: false },
  { key: 'backorder', label: 'Đơn thiếu', scale: 1, suffix: '', higherBetter: false },
  { key: 'blocked_s', label: 'Blocked', scale: 1 / 60, suffix: ' phút', higherBetter: false },
  { key: 'starved_s', label: 'Starved', scale: 1 / 60, suffix: ' phút', higherBetter: false },
  { key: 'wip_peak', label: 'Đỉnh WIP', scale: 1, suffix: '', higherBetter: false },
]

const metricNumber = (value: unknown, scale = 1) => typeof value === 'number' && Number.isFinite(value) ? value * scale : undefined

function CandidateReport({ candidate }: { candidate: Candidate }) {
  const baseline = candidate.expected_impact?.baseline ?? {}
  const changed = candidate.expected_impact?.candidate ?? {}
  const delta = candidate.expected_impact?.delta ?? {}
  const metrics = CANDIDATE_METRICS.map((metric) => ({
    ...metric,
    baseline: metricNumber(baseline[metric.key], metric.scale),
    candidate: metricNumber(changed[metric.key], metric.scale),
    delta: metricNumber(delta[metric.key], metric.scale),
  })).filter((metric) => metric.baseline !== undefined || metric.candidate !== undefined || metric.delta !== undefined)
  const evidence = evidenceRows(candidate.evidence)
  const tradeOffs = tradeOffRows(candidate)
  return (
    <div className="break-inside-avoid rounded border p-3">
      <div className="flex items-start gap-3">
        <b className="text-sm">#{candidate.rank} · {describeAction(candidate.action)}</b>
        {candidate.score_v2 !== undefined && <span className="ml-auto text-xs text-muted">Điểm xếp hạng {candidate.score_v2.toFixed(3)}</span>}
      </div>
      {candidate.reason && <p className="mt-1 text-xs text-muted"><b>Vì sao:</b> {candidate.reason}</p>}
      {evidence.length > 0 && (
        <div className="mt-2 text-xs">
          <b>Bằng chứng:</b> {evidence.map((row) => `${row.label}: ${row.value}`).join(' · ')}
        </div>
      )}
      {metrics.length > 0 && (
        <table className="mt-2 w-full text-xs">
          <thead className="text-muted"><tr><th className="text-left">KPI trung bình</th><th className="text-right">Baseline</th><th className="text-right">Candidate</th><th className="text-right">Delta</th></tr></thead>
          <tbody>
            {metrics.map((metric) => (
              <tr key={metric.key} className="border-t">
                <td className="py-1">{metric.label}</td>
                <td className="text-right">{reportMetricText(metric.baseline, metric.suffix, false, 2)}</td>
                <td className="text-right">{reportMetricText(metric.candidate, metric.suffix, false, 2)}</td>
                <td className={`text-right font-medium ${metric.delta === undefined || metric.delta === 0 ? '' : (metric.higherBetter ? metric.delta > 0 : metric.delta < 0) ? 'text-ok' : 'text-bad-text'}`}>
                  {reportMetricText(metric.delta, metric.suffix, true)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mt-2 text-xs">
        <b>Đánh đổi:</b> {tradeOffs.length > 0 ? tradeOffs.map((row) => `${row.label}: ${row.value}`).join(' · ') : 'Không phát hiện KPI bảo vệ nào xấu đi trong kết quả mô phỏng.'}
      </div>
    </div>
  )
}

function ReportDocumentTitle({ runId, scenarioName }: { runId: number; scenarioName: string }) {
  useEffect(() => {
    const previous = document.title
    document.title = `Báo cáo Run #${runId} · ${scenarioName}`
    return () => { document.title = previous }
  }, [runId, scenarioName])
  return null
}

function FailureImpactReport({ impact }: { impact: FailureImpact }) {
  const hasReference = impact.reference_upstream_blocked_s !== undefined
    || impact.reference_downstream_starved_s !== undefined
  const commonRows = [
    ['Thời điểm xảy ra sự cố', metricNumber(impact.failure_at, 1 / 60), ' phút'],
    ['Downtime quan sát', metricNumber(impact.downtime_s, 1 / 60), ' phút'],
    ['Máy phía trước bắt đầu bị chặn sau', metricNumber(impact.time_to_first_upstream_block, 1 / 60), ' phút'],
    ['Máy phía sau bắt đầu thiếu đầu vào sau', metricNumber(impact.time_to_first_downstream_starve, 1 / 60), ' phút'],
  ] as const
  const referenceRows = [
    ['Sản lượng mất do sự cố', metricNumber(impact.throughput_loss), ''],
    ['Tỷ lệ sản lượng mất do sự cố', metricNumber(impact.throughput_loss_pct, 100), '%'],
    ['Đơn thiếu tăng do sự cố', metricNumber(impact.backorder_delta), ''],
    ['Thời gian phía trước bị chặn tăng', metricNumber(impact.additional_upstream_blocked_s, 1 / 60), ' phút'],
    ['Thời gian phía sau thiếu đầu vào tăng', metricNumber(impact.additional_downstream_starved_s, 1 / 60), ' phút'],
    ['Đỉnh WIP thay đổi', metricNumber(impact.WIP_peak_delta), ''],
  ] as const
  const observedRows = [
    ['Phía trước bị chặn (quan sát)', metricNumber(impact.failed_upstream_blocked_s, 1 / 60), ' phút'],
    ['Phía sau thiếu đầu vào (quan sát)', metricNumber(impact.failed_downstream_starved_s, 1 / 60), ' phút'],
  ] as const
  const recoveryRows = [
    ['Thời điểm phục hồi sau mốc kết thúc dự kiến', metricNumber(impact.recovery_delay_s, 1 / 60), ' phút'],
  ] as const
  const rows = [...commonRows, ...(hasReference ? referenceRows : observedRows), ...recoveryRows]
  const visible = rows.filter(([, value]) => value !== undefined)
  return (
    <div className="break-inside-avoid rounded border border-warn/40 bg-warn/5 p-3">
      <div className="flex items-center gap-2">
        <TriangleAlert size={15} className="text-warn" />
        <b className="text-sm">Ảnh hưởng sự cố tại {impact.failed_machine}</b>
      </div>
      <p className="mt-1 text-xs text-muted">
        {hasReference
          ? 'Mức ảnh hưởng tăng thêm được tính so với run tham chiếu cùng seed và không có sự cố.'
          : 'Chỉ hiển thị tổng thời gian quan sát trong run; chưa có run tham chiếu cùng seed để quy kết phần tăng thêm do sự cố.'}
      </p>
      <div className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        {visible.map(([label, value, suffix]) => (
          <div key={label} className="flex justify-between gap-3 border-b border-line/60 py-1">
            <span className="text-muted">{label}</span>
            <b className="text-right tabular-nums">{reportMetricText(value, suffix, false, 2)}</b>
          </div>
        ))}
      </div>
    </div>
  )
}

const APPLIED_METRICS = [
  { key: 'throughput', label: 'Sản lượng xuất', higherBetter: true, percent: false },
  { key: 'red_minutes', label: 'Tổng phút Đỏ', higherBetter: false, percent: false },
  { key: 'backorder_end', label: 'Nợ đơn cuối kỳ', higherBetter: false, percent: false },
  { key: 'service_level', label: 'Mức phục vụ', higherBetter: true, percent: true },
] as const

function AppliedResultReport({ current, scenario, parentScenario, baseline, parentError, parentPending }: {
  current: Run
  scenario: Scenario
  parentScenario: Scenario | undefined
  baseline: Run | undefined
  parentError: unknown
  parentPending: boolean
}) {
  const action = scenario.action as unknown as Action | null
  const comparable = baseline && parentScenario
    && parentScenario.model_version_id === scenario.model_version_id
    && parentScenario.horizon_s === scenario.horizon_s
    && parentScenario.replications === scenario.replications
    && parentScenario.start_state === scenario.start_state
    && baseline.sim_start === current.sim_start
    && (parentScenario.seed ?? baseline.id) === (scenario.seed ?? current.id)
  const verdict = baseline && comparable ? appliedVerdict(baseline, current) : undefined
  const verdictStyle = verdict?.tone === 'good'
    ? 'border-ok/45 bg-ok/5 text-ok'
    : verdict?.tone === 'warn'
      ? 'border-warn/45 bg-warn/5 text-text'
      : 'border-line-2 bg-panel-2 text-text-2'
  return (
    <div className="report-section-lead break-inside-avoid space-y-3">
      <h2 className="font-semibold">4. Kết quả sau khi áp dụng đề xuất</h2>
      <div className="rounded border border-accent/35 bg-panel-2 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Action đã áp dụng</div>
        <div className="mt-1 text-sm font-semibold text-text">{action ? describeAction(action) : 'Scenario không lưu action chi tiết'}</div>
        <div className="mt-1 text-xs text-muted">Action được áp dụng vào scenario con; mô hình đã publish không bị thay đổi.</div>
      </div>
      {Boolean(parentError) && <ErrorBox error={parentError} />}
      {parentPending && <Notice>Đang xác định run baseline để tính chênh lệch KPI thực tế…</Notice>}
      {!parentPending && !parentError && !baseline && (
        <Notice tone="lock">Không xác định được run baseline từ scenario cha, nên chưa thể kết luận hiệu quả actual before/after.</Notice>
      )}
      {baseline && (
        <>
          {comparable ? (
            <Notice>Run #{baseline.id} và run #{current.id} dùng cùng phiên bản mô hình, seed, mốc bắt đầu, horizon, số lần lặp và trạng thái khởi đầu. Chênh lệch phù hợp để quy cho action.</Notice>
          ) : (
            <Notice tone="lock">Điều kiện baseline và run sau áp dụng không hoàn toàn giống nhau; chênh lệch KPI có thể không chỉ đến từ action.</Notice>
          )}
          <table className="w-full text-sm">
            <thead className="text-xs text-muted">
              <tr><th className="py-1 text-left">KPI P50 thực tế</th><th className="text-right">Baseline #{baseline.id}</th><th className="text-right">Sau áp dụng #{current.id}</th><th className="text-right">Chênh lệch</th></tr>
            </thead>
            <tbody>
              {APPLIED_METRICS.map((metric) => {
                const beforeRaw = kpiP50(baseline.kpis, metric.key)
                const afterRaw = kpiP50(current.kpis, metric.key)
                const scale = metric.percent ? 100 : 1
                const before = beforeRaw === undefined ? undefined : beforeRaw * scale
                const after = afterRaw === undefined ? undefined : afterRaw * scale
                const delta = before === undefined || after === undefined ? undefined : after - before
                const good = delta !== undefined && delta !== 0 && (metric.higherBetter ? delta > 0 : delta < 0)
                const suffix = metric.percent ? '%' : metric.key === 'red_minutes' ? ' phút' : ''
                return (
                  <tr key={metric.key} className="border-t">
                    <td className="py-1.5">{metric.label}</td>
                    <td className="text-right tabular-nums">{reportMetricText(before, suffix)}</td>
                    <td className="text-right font-medium tabular-nums">{reportMetricText(after, suffix)}</td>
                    <td className={`text-right font-semibold tabular-nums ${delta === undefined || delta === 0 ? 'text-muted' : good ? 'text-ok' : 'text-bad-text'}`}>
                      {reportMetricText(delta, metric.percent ? ' điểm %' : suffix, true)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {verdict && (
            <div className={`rounded border px-3 py-2 ${verdictStyle}`}>
              <div className="flex items-center gap-2 text-sm font-semibold">
                {verdict.tone === 'good' ? <CheckCircle2 size={15} /> : verdict.tone === 'warn' ? <TriangleAlert size={15} /> : null}
                {verdict.title}
              </div>
              <div className="mt-0.5 text-xs text-text-2">{verdict.detail}</div>
            </div>
          )}
          <Link className={`${btn} print:hidden`} to={`/compare?a=${baseline.id}&b=${current.id}`}>
            <GitCompare size={14} /> Mở so sánh chi tiết
          </Link>
        </>
      )}
    </div>
  )
}

async function loadJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`Không đọc được dữ liệu benchmark: ${path}`)
  return res.json() as Promise<T>
}

function pct(v: number | null | undefined, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return `${v.toFixed(digits).replace('.', ',')}%`
}

function num(v: number | null | undefined, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return v.toFixed(digits).replace('.', ',')
}

function usd(v: number | null | undefined) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(v)
}

function DeltaChip({ value, goodWhenNegative = false }: { value: number; goodWhenNegative?: boolean }) {
  const good = goodWhenNegative ? value < 0 : value > 0
  return <span className={`font-semibold ${good ? 'text-ok' : value === 0 ? 'text-muted' : 'text-bad-text'}`}>{fmtDelta(value)}</span>
}

function BenchmarkPage() {
  const global = useQuery({
    queryKey: ['benchmarks', 'global'],
    queryFn: () => loadJson<GlobalSummaryRow[]>('/benchmarks/bimbo_booster_global_summary.json'),
  })
  const validation = useQuery({
    queryKey: ['benchmarks', 'validation'],
    queryFn: () => loadJson<ValidationRow[]>('/benchmarks/phase4_validation_real_bimbo_catA_50sku.json'),
  })
  const tuner = useQuery({
    queryKey: ['benchmarks', 'tuner'],
    queryFn: () => loadJson<TunerRow[]>('/benchmarks/tuner_global_config_ranking.json'),
  })
  const pareto = useQuery({
    queryKey: ['benchmarks', 'pareto'],
    queryFn: () => loadJson<ParetoRow[]>('/benchmarks/pareto_sweep_10_alpha_results.json'),
  })
  const perSku = useQuery({
    queryKey: ['benchmarks', 'per-sku'],
    queryFn: () => loadJson<PerSkuRow[]>('/benchmarks/bimbo_booster_per_sku_results.json'),
  })

  if ([global, validation, tuner, pareto, perSku].some((q) => q.isLoading)) return <Loading />
  const err = global.error ?? validation.error ?? tuner.error ?? pareto.error ?? perSku.error
  if (err) return <PageBody wide><PageHeader icon={FileText} title="Benchmark FMCG" subtitle="Grupo Bimbo + policy tuning" /><ErrorBox error={err} /></PageBody>

  const globalRows = (global.data ?? []).filter((r) => r.rank < 90)
  const baseline = globalRows.find((r) => r.method.includes('Baseline')) ?? globalRows[0]
  const hybrid = globalRows.find((r) => r.method.includes('HYBRID_FINAL')) ?? globalRows.at(-1)
  const realRows = [...(validation.data ?? [])].sort((a, b) => b.weight_usd - a.weight_usd)
  const topSku = [...(perSku.data ?? [])].sort((a, b) => a.delta_smape_vs_baseline - b.delta_smape_vs_baseline).slice(0, 10)
  const tunedTop = [...(tuner.data ?? [])].slice(0, 8)
  const paretoRows = pareto.data ?? []

  const globalCols: Column<GlobalSummaryRow>[] = [
    { key: 'rank', header: '#', cell: (r) => r.rank, sort: (r) => r.rank, align: 'right' },
    { key: 'method', header: 'Phương pháp', cell: (r) => r.method, sort: (r) => r.method },
    { key: 'smape', header: 'SMAPE', cell: (r) => pct(r.vw_smape_pct), sort: (r) => r.vw_smape_pct, align: 'right' },
    { key: 'acc', header: 'Accuracy', cell: (r) => pct(r.vw_accuracy_pct), sort: (r) => r.vw_accuracy_pct, align: 'right' },
    { key: 'dsmape', header: 'Δ SMAPE', cell: (r) => <DeltaChip value={r.delta_smape_vs_base} goodWhenNegative />, sort: (r) => r.delta_smape_vs_base, align: 'right' },
    { key: 'dacc', header: 'Δ Accuracy', cell: (r) => <DeltaChip value={r.delta_acc_vs_base} />, sort: (r) => r.delta_acc_vs_base, align: 'right' },
  ]

  const validationCols: Column<ValidationRow>[] = [
    { key: 'sku', header: 'SKU', cell: (r) => r.sku_id, sort: (r) => r.sku_id, align: 'right' },
    { key: 'cat', header: 'Nhóm', cell: (r) => r.category, sort: (r) => r.category },
    { key: 'value', header: 'Giá trị USD', cell: (r) => usd(r.weight_usd), sort: (r) => r.weight_usd, align: 'right' },
    { key: 'base', header: 'Base Acc', cell: (r) => pct(r.base_acc), sort: (r) => r.base_acc, align: 'right' },
    { key: 'hybrid', header: 'Hybrid Acc', cell: (r) => pct(r.hybrid_acc), sort: (r) => r.hybrid_acc, align: 'right' },
    { key: 'best', header: 'Best', cell: (r) => r.best_method, sort: (r) => r.best_method },
  ]

  const tunerCols: Column<TunerRow>[] = [
    { key: 'rank', header: '#', cell: (r) => r.rank_vw_smape, sort: (r) => r.rank_vw_smape, align: 'right' },
    { key: 'cfg', header: 'Config', cell: (r) => r.cfg_id, sort: (r) => r.cfg_id },
    { key: 'wins', header: 'SKU thắng', cell: (r) => r.n_wins_best_per_sku, sort: (r) => r.n_wins_best_per_sku, align: 'right' },
    { key: 'smape', header: 'VW SMAPE', cell: (r) => pct(r.value_weighted_SMAPE_pct), sort: (r) => r.value_weighted_SMAPE_pct, align: 'right' },
    { key: 'acc', header: 'VW Accuracy', cell: (r) => pct(r.value_weighted_Accuracy_pct), sort: (r) => r.value_weighted_Accuracy_pct, align: 'right' },
    { key: 'label', header: 'Mô tả', cell: (r) => r.cfg_label, sort: (r) => r.cfg_label },
  ]

  const perSkuCols: Column<PerSkuRow>[] = [
    { key: 'sku', header: 'SKU', cell: (r) => r.sku_id, sort: (r) => r.sku_id, align: 'right' },
    { key: 'name', header: 'Tên sản phẩm', cell: (r) => r.sku_name, sort: (r) => r.sku_name },
    { key: 'value', header: 'Giá trị USD', cell: (r) => usd(r.weight_value_usd), sort: (r) => r.weight_value_usd, align: 'right' },
    { key: 'before', header: 'Base Acc', cell: (r) => pct(r.baseline_old_HW_acc), sort: (r) => r.baseline_old_HW_acc, align: 'right' },
    { key: 'after', header: 'Hybrid Acc', cell: (r) => pct(r.hybrid_final_acc), sort: (r) => r.hybrid_final_acc, align: 'right' },
    { key: 'delta', header: 'Δ SMAPE', cell: (r) => <DeltaChip value={r.delta_smape_vs_baseline} goodWhenNegative />, sort: (r) => r.delta_smape_vs_baseline, align: 'right' },
  ]

  return (
    <PageBody wide>
      <PageHeader icon={FileText}
        title="Benchmark FMCG"
        subtitle="Nhúng benchmark Grupo Bimbo/Store-Item từ project M vào KaizenFlow"
        actions={
          <>
            <Link className={btn} to="/models">Xem mô hình</Link>
            <Link className={btnPrimary} to="/models">Mở workspace</Link>
          </>
        }
      />
      <Notice>
        Tầng 1 chỉ nhúng benchmark đã kiểm chứng vào giao diện doanh nghiệp hiện tại. Chưa thay core engine KaizenFlow; phần forecast/optimizer của project M đang được dùng như bằng chứng benchmark và làm cơ sở seed mô hình FMCG demo.
      </Notice>

      {!baseline || !hybrid ? (
        <EmptyState title="Chưa có dữ liệu benchmark">Thiếu file JSON trong thư mục public/benchmarks.</EmptyState>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <Card title="Baseline Accuracy">
              <div className="text-2xl font-semibold text-text">{pct(baseline.vw_accuracy_pct, 1)}</div>
              <div className="mt-1 text-xs text-muted">Weekly Add+Mul8 làm mốc so sánh</div>
            </Card>
            <Card title="Hybrid Accuracy">
              <div className="text-2xl font-semibold text-text">{pct(hybrid.vw_accuracy_pct, 1)}</div>
              <div className="mt-1 text-xs text-muted">Auto-pick best giữa HW tune, blend và ML</div>
            </Card>
            <Card title="Cải thiện Accuracy">
              <div className="text-2xl font-semibold text-ok">{fmtDelta(hybrid.delta_acc_vs_base)}</div>
              <div className="mt-1 text-xs text-muted">Điểm phần trăm so với baseline</div>
            </Card>
            <Card title="Giảm SMAPE">
              <div className="text-2xl font-semibold text-ok">{fmtDelta(hybrid.delta_smape_vs_base)}</div>
              <div className="mt-1 text-xs text-muted">Âm là tốt hơn baseline</div>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <Card title="Xếp hạng phương pháp forecast toàn cục">
              <DataTable rows={globalRows} columns={globalCols} rowKey={(r) => `${r.rank}-${r.method}`} flat />
            </Card>
            <Card title="Pareto trade-off điều phối">
              <div className="mb-2 flex flex-wrap gap-2 text-[11px] text-muted">
                <Tag>{paretoRows.length} điểm alpha</Tag>
                <Tag>Trục X: alpha</Tag>
                <Tag>Giảm downtime nhưng tăng km AGV</Tag>
              </div>
              <div className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={paretoRows}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                    <XAxis dataKey="alpha" tick={axisTick} axisLine={axisLine} tickLine={false} />
                    <YAxis yAxisId="left" tick={axisTick} axisLine={axisLine} tickLine={false} />
                    <YAxis yAxisId="right" orientation="right" tick={axisTick} axisLine={axisLine} tickLine={false} />
                    <Tooltip
                      {...tooltipProps}
                      formatter={(v, name) => [num(typeof v === 'number' ? v : Number(v), 2), String(name)]}
                      labelFormatter={(v) => `alpha = ${v}`}
                    />
                    <Legend />
                    <Line yAxisId="left" type="monotone" dataKey="downtime_min_mean" name="Downtime (phút)" stroke="var(--color-bad)" strokeWidth={2} dot={false} />
                    <Line yAxisId="left" type="monotone" dataKey="red_alert_mean" name="Red alerts" stroke="var(--color-warn)" strokeWidth={2} dot={false} />
                    <Line yAxisId="right" type="monotone" dataKey="agv_km_mean" name="AGV km" stroke="var(--color-text)" strokeWidth={2} dot={false} />
                    <Line yAxisId="right" type="monotone" dataKey="throughput_cases_mean" name="Throughput cases" stroke="var(--color-ok)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <Card title="Validation thật trên 50 SKU nhóm A">
              <div className="mb-2 text-xs text-muted">
                Dùng file validation thật từ Grupo Bimbo, sắp theo giá trị SKU giảm dần để giữ trọng tâm kinh doanh.
              </div>
              <DataTable rows={realRows.slice(0, 10)} columns={validationCols} rowKey={(r) => r.sku_id} flat />
            </Card>
            <Card title="Top cấu hình Holt-Winters đã tune">
              <div className="mb-2 text-xs text-muted">
                Bảng này là cầu nối dễ nhất để sau này đưa tuner của project M vào flow tạo scenario hoặc forecast service của KaizenFlow.
              </div>
              <DataTable rows={tunedTop} columns={tunerCols} rowKey={(r) => r.cfg_id} flat />
            </Card>
          </div>

          <Card title="SKU cải thiện mạnh nhất so với baseline">
            <DataTable rows={topSku} columns={perSkuCols} rowKey={(r) => r.sku_id} flat />
          </Card>

          <Card title="Cách dùng với KaizenFlow hiện tại">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-text-2">
              <li>Seed thêm mô hình FMCG bằng script benchmark để có graph kho, line đóng gói và tugger giống depot FMCG.</li>
              <li>Trình diễn benchmark tại trang này để chứng minh forecast policy đã được kiểm chứng trên dữ liệu Grupo Bimbo thực.</li>
              <li>Sau đó mở mô hình FMCG trong workspace KaizenFlow để chạy scenario logistics và báo cáo vận hành trên cùng một UI doanh nghiệp.</li>
            </ol>
          </Card>
        </>
      )}
    </PageBody>
  )
}

function RunReportPage() {
  const runId = Number(useParams().id)
  const run = useQuery({ queryKey: ['run', runId], queryFn: () => api.run(runId) })
  const scenario = useQuery({ queryKey: ['scenario', run.data?.scenario_id], queryFn: () => api.scenario(run.data!.scenario_id), enabled: !!run.data })
  const graph = useQuery({ queryKey: ['graph', scenario.data?.model_version_id], queryFn: () => api.graph(scenario.data!.model_version_id), enabled: !!scenario.data })
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  const bands = useQuery({ queryKey: ['bands', runId, 'coverage_h'], queryFn: () => api.bands(runId, { metric: 'coverage_h' }), enabled: run.data?.status === 'DONE' })
  const applied = scenario.data?.origin === 'RECOMMENDER' && scenario.data.parent_id !== null
  const parentScenario = useQuery({
    queryKey: ['scenario', scenario.data?.parent_id],
    queryFn: () => api.scenario(scenario.data!.parent_id!),
    enabled: applied,
  })
  const parentRuns = useQuery({
    queryKey: ['runs', scenario.data?.parent_id],
    queryFn: () => api.runs(scenario.data!.parent_id!),
    enabled: applied,
  })
  if (run.error) return <div className="p-6"><ErrorBox error={run.error} /></div>
  if (!run.data) return <Loading />
  if (run.data.status === 'FAILED') return <PageBody><PageHeader title={`Báo cáo Run #${runId}`} /><ErrorBox error={new Error(run.data.error ?? 'Lần chạy mô phỏng thất bại')} /></PageBody>
  if (run.data.status !== 'DONE') return <EmptyState title="Báo cáo đang được chuẩn bị">Lần chạy chưa hoàn tất. Trang sẽ cập nhật khi mô phỏng xong.</EmptyState>
  const dependencyError = scenario.error ?? graph.error ?? types.error ?? bands.error
  if (dependencyError) return <PageBody><PageHeader title={`Báo cáo Run #${runId}`} /><ErrorBox error={dependencyError} /></PageBody>
  if (!scenario.data || !graph.data || !types.data || !bands.data) return <Loading />
  const r = run.data
  const typeMap = byCode(types.data)
  const idx = indexBands(bands.data)
  const operationalInsights = r.insights.filter((i) => i.kind !== 'RECOMMENDATION')
  const risky = operationalInsights.filter((i) => i.kind === 'RED_RISK').map((i) => i.subject_key ?? '')
  const storages = graph.data.nodes.filter((n) => risky.includes(n.key))
  const candidateEntries = r.insights.filter((i) => i.kind === 'RECOMMENDATION').flatMap((insight) =>
    candidatesOf(insight).map((candidate) => ({ key: `${insight.id}:${candidate.rank}`, candidate })),
  )
  const failureImpacts = failureImpactsOf(r.insights)
  const baseline = applied && parentScenario.data
    ? pickParentBaseline(parentRuns.data ?? [], r, scenario.data.seed, parentScenario.data.seed)
    : undefined
  const parentError = applied ? parentScenario.error ?? parentRuns.error : undefined
  const assumedNodeTypes = [...new Set(graph.data.nodes
    .filter((node) => typeMap[node.node_type]?.default_params?.assumed === true)
    .map((node) => typeMap[node.node_type]?.name ?? node.node_type))]
  const kpiRows = [
    { key: 'throughput', label: 'Sản lượng xuất', percent: false },
    { key: 'red_minutes', label: 'Tổng phút Đỏ', percent: false },
    { key: 'backorder_end', label: 'Nợ đơn cuối kỳ', percent: false },
    { key: 'service_level', label: 'Mức phục vụ', percent: true },
  ].map((row) => ({ ...row, band: kpiBand(r.kpis, row.key) }))
  const fullDetail = scenario.data.horizon_s <= FULL_DETAIL_MAX_HORIZON_S
  const warmupS = scenarioWarmupSeconds(scenario.data.start_state, graph.data.settings)
  const totalPerReplicationS = scenario.data.horizon_s + warmupS
  const effectiveSeed = scenario.data.seed ?? r.id
  const bandText = (value: number | undefined, percent: boolean) => value === undefined
    ? '—'
    : percent ? `${(value * 100).toFixed(1)}%` : value.toLocaleString('vi-VN', { maximumFractionDigits: 1 })
  const actualVerdict = applied && baseline ? appliedVerdict(baseline, r) : undefined
  const bestCandidate = candidateEntries[0]?.candidate
  const executive = actualVerdict
    ? {
        tone: actualVerdict.tone,
        title: actualVerdict.title,
        detail: actualVerdict.detail,
        action: scenario.data.action ? describeAction(scenario.data.action as unknown as Action) : 'Action đã áp dụng',
      }
    : bestCandidate
      ? {
          tone: tradeOffRows(bestCandidate).length > 0 ? 'warn' as const : 'good' as const,
          title: tradeOffRows(bestCandidate).length > 0 ? 'Có phương án khả thi nhưng cần xác nhận đánh đổi' : 'Có phương án ưu tiên đã được mô phỏng',
          detail: bestCandidate.reason || 'Candidate xếp hạng cao nhất theo cải thiện KPI và các guardrail.',
          action: describeAction(bestCandidate.action),
        }
      : { tone: 'neutral' as const, title: 'Chưa có hành động đủ bằng chứng để khuyến nghị', detail: 'Xem các phát hiện vận hành bên dưới và bổ sung dữ liệu nếu cần.', action: 'Chưa đề xuất action' }
  return (
    <div className="report-page min-h-full bg-bg text-text">
      <ReportDocumentTitle runId={r.id} scenarioName={scenario.data.name} />
      <div className="mx-auto max-w-4xl space-y-5 p-8 print:p-0">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold">Báo cáo mô phỏng &amp; dự báo logistics</h1>
            <div className="text-sm text-muted">
              {graph.data.model_key} v{graph.data.version} · {scenario.data.name} · Run #{r.id} · bắt đầu {new Date(r.sim_start).toLocaleString('vi-VN')}
            </div>
            <div className="text-xs text-faint">{scenario.data.replications} lần lặp Monte Carlo · horizon {formatScenarioDuration(scenario.data.horizon_s)} · engine {r.engine_version}</div>
          </div>
          <button className={`${btnPrimary} print:hidden`} onClick={() => window.print()}>In / Lưu PDF</button>
        </div>

        <DecisionJourney
          active="report"
          links={{ observe: `/runs/${r.id}`, decide: `/runs/${r.id}/recommendations`, validate: baseline ? `/compare?a=${baseline.id}&b=${r.id}` : undefined }}
        />

        <section className={`break-inside-avoid rounded-xl border p-4 ${executive.tone === 'good' ? 'border-ok/50 bg-ok/5' : executive.tone === 'warn' ? 'border-warn/50 bg-warn/5' : 'border-line bg-panel'}`}>
          <div className="flex items-start gap-3">
            <span className={`flex h-10 w-10 flex-none items-center justify-center rounded-xl ${executive.tone === 'good' ? 'bg-ok/15 text-ok' : executive.tone === 'warn' ? 'bg-warn/15 text-warn' : 'bg-panel-2 text-muted'}`}>
              {executive.tone === 'good' ? <CheckCircle2 size={21} /> : <TriangleAlert size={21} />}
            </span>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Tóm tắt điều hành</div>
              <h2 className="mt-0.5 text-base font-semibold text-text">{executive.title}</h2>
              <p className="mt-1 text-xs leading-5 text-text-2">{executive.detail}</p>
              <div className="mt-2 rounded-lg border border-line bg-panel/70 px-3 py-2 text-xs"><span className="text-muted">Hành động:</span> <b className="text-text">{executive.action}</b></div>
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-2 font-semibold">1. Thiết lập scenario</h2>
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
            <div className="rounded border p-2"><div className="text-xs text-muted">Horizon tính KPI</div><b>{formatScenarioDuration(scenario.data.horizon_s)}</b></div>
            <div className="rounded border p-2"><div className="text-xs text-muted">Warm-up ngoài KPI</div><b>{warmupS > 0 ? formatScenarioDuration(warmupS) : 'Không dùng'}</b></div>
            <div className="rounded border p-2"><div className="text-xs text-muted">Tổng mỗi lần chạy</div><b>{formatScenarioDuration(totalPerReplicationS)}</b></div>
            <div className="rounded border p-2"><div className="text-xs text-muted">Lần lặp</div><b>{scenario.data.replications}</b></div>
            <div className="rounded border p-2"><div className="text-xs text-muted">Khởi đầu</div><b>{startStateLabel(scenario.data.start_state)}</b></div>
            <div className="rounded border p-2"><div className="text-xs text-muted">Seed hiệu lực</div><b>{effectiveSeed}</b></div>
          </div>
          <div className="mt-3 break-inside-avoid rounded border p-3">
            <ScenarioTimeline
              horizonS={scenario.data.horizon_s}
              events={scenario.data.injections.map((i) => describeInjection(i))}
              startLabel={startStateLabel(scenario.data.start_state)}
            />
          </div>
          {scenario.data.overrides.length > 0 && (
            <div className="mt-3 text-sm">
              <div className="font-medium">Thay đổi so với cấu hình nền</div>
              <ul className="mt-1 list-disc pl-5">
                {scenario.data.overrides.map((override, index) => {
                  const d = describeOverride(override)
                  return <li key={index}>{d.label}: {d.lines.join('; ')}</li>
                })}
              </ul>
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-2 font-semibold">2. Chỉ số chính và độ bất định Monte Carlo</h2>
          <table className="w-full text-sm">
            <thead className="text-xs text-muted"><tr><th className="py-1 text-left">KPI</th><th className="text-right">P10</th><th className="text-right">P50 · trung vị</th><th className="text-right">P90</th></tr></thead>
            <tbody>
              {kpiRows.map((row) => (
                <tr key={row.key} className="border-t">
                  <td className="py-1">{row.label}</td>
                  <td className="text-right">{bandText(row.band?.p10, row.percent)}</td>
                  <td className="text-right font-medium">{bandText(row.band?.p50, row.percent)}</td>
                  <td className="text-right">{bandText(row.band?.p90, row.percent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 space-y-1 text-xs text-muted">
            <p>P10–P90 thể hiện độ phân tán giữa các lần lặp; không nên ra quyết định chỉ từ P50.</p>
            <p><b>Phút Đỏ</b> là tổng số phút dưới ngưỡng Đỏ cộng trên tất cả kho. Các kho Đỏ cùng lúc vẫn được cộng riêng, nên chỉ số có thể lớn hơn horizon.</p>
          </div>
        </section>

        <section>
          <h2 className="mb-2 font-semibold">3. Dự báo &amp; điểm nghẽn</h2>
          {operationalInsights.length > 0 ? (
            <ul className="list-disc pl-5 text-sm">
              {operationalInsights.map((i) => <li key={i.id}>{describeInsight(i)}</li>)}
            </ul>
          ) : (
            <p className="text-sm text-muted">Không phát hiện RED_RISK, bottleneck hoặc fault risk trong lần chạy này.</p>
          )}
          {storages.map((n) => (
            <div key={n.key} className="mt-3 break-inside-avoid">
              <div className="text-sm font-medium">{n.name || n.key} — số giờ tồn kho còn đủ dùng</div>
              <BandChart points={clip(series(idx, n.key, 'coverage_h'), 24)} redH={thresholdsFor(n, typeMap).red_h} height={180} />
            </div>
          ))}
          {risky.length > 0 && storages.length === 0 && (
            <Notice>Run có RED_RISK nhưng không tìm thấy storage tương ứng trong phiên bản mô hình hiện tại.</Notice>
          )}
          {failureImpacts.length > 0 && (
            <div className="mt-4 space-y-3">
              <div className="report-section-lead break-inside-avoid space-y-3">
                <h3 className="text-sm font-semibold">Ảnh hưởng của sự cố</h3>
                <FailureImpactReport impact={failureImpacts[0]} />
              </div>
              {failureImpacts.slice(1).map((impact, index) => <FailureImpactReport key={`${impact.failed_machine}-${impact.failure_at ?? index}`} impact={impact} />)}
            </div>
          )}
        </section>

        <section>
          {applied ? (
            <AppliedResultReport
              current={r} scenario={scenario.data} parentScenario={parentScenario.data}
              baseline={baseline} parentError={parentError}
              parentPending={parentScenario.isLoading || parentRuns.isLoading}
            />
          ) : !fullDetail ? (
            <div className="report-section-lead break-inside-avoid space-y-2">
              <h2 className="font-semibold">4. Hành động đề xuất được đánh giá bằng mô phỏng</h2>
              <Notice>Recommendation không được chạy vì scenario dài hơn 12 giờ. Đây không có nghĩa là hệ thống đã đánh giá và không tìm thấy hành động phù hợp.</Notice>
            </div>
          ) : candidateEntries.length === 0 ? (
            <div className="report-section-lead break-inside-avoid space-y-2">
              <h2 className="font-semibold">4. Hành động đề xuất được đánh giá bằng mô phỏng</h2>
              <Notice>Engine đã chạy bước Recommend nhưng không có candidate nào vượt qua các guardrail về cải thiện tối thiểu, rủi ro và đánh đổi. Đây không phải lỗi mô phỏng.</Notice>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="report-section-lead break-inside-avoid space-y-3">
                <h2 className="font-semibold">4. Hành động đề xuất được đánh giá bằng mô phỏng</h2>
                <CandidateReport candidate={candidateEntries[0].candidate} />
              </div>
              {candidateEntries.slice(1).map(({ key, candidate }) => <CandidateReport key={key} candidate={candidate} />)}
            </div>
          )}
        </section>

        <section className="text-xs text-faint">
          {assumedNodeTypes.length > 0
            ? `Các loại node dùng mặc định catalog có cờ “assumed”: ${assumedNodeTypes.join(', ')}. Hãy hiệu chỉnh bằng dữ liệu thực trước khi triển khai vận hành. `
            : 'Báo cáo dùng tham số đã lưu trong phiên bản mô hình. '}
          Kết quả là phân phối từ nhiều lần mô phỏng, không phải một kịch bản duy nhất.
        </section>
      </div>
    </div>
  )
}

export default function ReportPage({ mode = 'run' }: { mode?: ReportMode }) {
  return mode === 'benchmarks' ? <BenchmarkPage /> : <RunReportPage />
}
