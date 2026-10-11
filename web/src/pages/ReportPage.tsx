import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, GitCompare, TriangleAlert } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { useEffect } from 'react'
import { api } from '../api/client'
import type { Run, Scenario } from '../api/types'
import { BandChart } from '../components/Charts'
import { ScenarioTimeline } from '../components/scenario/ScenarioTimeline'
import { EmptyState, ErrorBox, Loading, Notice, PageBody, PageHeader, btn, btnPrimary } from '../components/ui'
import { candidatesOf, describeAction, describeInsight, evidenceRows, kpiBand, kpiP50, tradeOffRows, type Action, type Candidate } from '../lib/insights'
import { byCode, thresholdsFor } from '../lib/model'
import { clip, indexBands, series } from '../lib/replay'
import { appliedVerdict, failureImpactsOf, pickParentBaseline, reportMetricText, type FailureImpact } from '../lib/report'
import { FULL_DETAIL_MAX_HORIZON_S, describeInjection, describeOverride, formatScenarioDuration, scenarioWarmupSeconds, startStateLabel } from '../lib/scenarioView'

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
        <div className="text-xs text-muted">Hành động đã áp dụng</div>
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
          <Link className={`${btn} print:hidden`} to={`/runs/${current.id}/compare`}>
            <GitCompare size={14} /> Mở so sánh chi tiết
          </Link>
        </>
      )}
    </div>
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
            <h1 className="text-xl font-semibold">Báo cáo mô phỏng và dự báo logistics</h1>
            <div className="text-sm text-muted">
              {graph.data.model_key} v{graph.data.version} · {scenario.data.name} · Run #{r.id} · bắt đầu {new Date(r.sim_start).toLocaleString('vi-VN')}
            </div>
            <div className="text-xs text-faint">{scenario.data.replications} lần lặp Monte Carlo · horizon {formatScenarioDuration(scenario.data.horizon_s)} · engine {r.engine_version}</div>
          </div>
          <button className={`${btnPrimary} print:hidden`} onClick={() => window.print()}>In / Lưu PDF</button>
        </div>

        <section className={`break-inside-avoid rounded-xl border p-4 ${executive.tone === 'good' ? 'border-ok/50 bg-ok/5' : executive.tone === 'warn' ? 'border-warn/50 bg-warn/5' : 'border-line bg-panel'}`}>
          <div className="flex items-start gap-3">
            <span className={`flex h-10 w-10 flex-none items-center justify-center rounded-xl ${executive.tone === 'good' ? 'bg-ok/15 text-ok' : executive.tone === 'warn' ? 'bg-warn/15 text-warn' : 'bg-panel-2 text-muted'}`}>
              {executive.tone === 'good' ? <CheckCircle2 size={21} /> : <TriangleAlert size={21} />}
            </span>
            <div>
              <div className="text-[11px] text-muted">Tóm tắt điều hành</div>
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

export default RunReportPage
