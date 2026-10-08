import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Gauge } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { Insight, ModelSummary, RunRow, Scenario } from '../api/types'
import { axisLine, axisTick, tooltipProps } from '../components/Charts'
import BenchmarkPanel from '../components/dashboard/BenchmarkPanel'
import { Card, ErrorBox, Loading, Notice, PageBody, PageHeader, StatusChip, Tag, btn, btnPrimary, input } from '../components/ui'
import { fmtDateTime, fmtDelta, fmtDuration } from '../lib/format'
import { candidatesOf, describeAction, kpiP50 } from '../lib/insights'

const DEFAULT_MODEL = 'bimbo-fmcg'
const STALE_MS = 2 * 60 * 1000

type Candidate = {
  rank?: number
  action?: { target?: string; qty?: number; material?: string; type?: string }
  score?: number
}

type ReplenishmentRow = {
  subject: string
  label?: string
  material?: string
  priority?: string
  priority_score?: number
  source?: string
  stock?: number
  target_stock?: number
  recommended_replenish?: number
  pre_coverage_hours?: number
  projected_coverage_h?: number
  coverage_pressure?: number
  backorder_per_hour?: number
  live_basis?: string
  upstream_sources?: string[]
  upstream_label?: string
  estimated_recovery_h?: number
  reason?: string
  candidates?: Candidate[]
}

type ForecastMeta = {
  label?: string
  method?: string
  notes?: string[]
  replenishment?: ReplenishmentRow[]
  series?: Array<{ subject: string; source?: string; blend_per_hour?: number; coverage_hours?: number }>
}

type RecommenderRun = { run: RunRow; scenario: Scenario }
type RecommendationOption = {
  key: string
  insightId: number
  rank: number
  subject: string
  title: string
  redDelta: number
  throughputDelta: number
  score: number
}

function forecastMetaOf(scenario: Scenario | undefined): ForecastMeta | null {
  return ((scenario?.action as { live_snapshot?: { forecast?: ForecastMeta } } | null | undefined)?.live_snapshot?.forecast) ?? null
}

function num(v: number | null | undefined, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return v.toFixed(digits).replace('.', ',')
}

function originTone(origin: RunRow['scenario_origin']) {
  if (origin === 'NOWCAST') return 'var(--color-text)'
  if (origin === 'RECOMMENDER') return 'var(--color-ok)'
  return 'var(--color-muted)'
}

function PriorityTag({ priority }: { priority?: string }) {
  const tone =
    priority === 'CRITICAL' ? 'border-bad/50 bg-bad-bg text-bad-text'
      : priority === 'HIGH' ? 'border-warn/50 bg-warn-bg text-warn-text'
        : priority === 'MEDIUM' ? 'border-line-2 bg-panel-2 text-text'
          : 'border-line-2 bg-panel text-muted'
  return <span className={`rounded-full border px-2 py-0.5 text-[10.5px] font-semibold ${tone}`}>{priority ?? 'LOW'}</span>
}

function StatCard({ title, value, hint, accent = 'text-text' }: { title: string; value: string; hint: string; accent?: string }) {
  return (
    <Card title={title}>
      <div className={`text-2xl font-semibold ${accent}`}>{value}</div>
      <div className="mt-1 text-xs text-muted">{hint}</div>
    </Card>
  )
}

function EffectDelta({ label, before, after, goodWhenLower = false }: { label: string; before?: number; after?: number; goodWhenLower?: boolean }) {
  if (before === undefined || after === undefined) {
    return <div className="text-xs text-muted">{label}: chưa đủ dữ liệu so sánh</div>
  }
  const delta = after - before
  const good = goodWhenLower ? delta < 0 : delta > 0
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-1 flex items-center gap-2 text-sm font-semibold text-text">
        <span>{num(before, 1)}</span>
        <span className="text-muted">→</span>
        <span>{num(after, 1)}</span>
        <span className={good ? 'text-ok' : delta === 0 ? 'text-muted' : 'text-bad-text'}>{fmtDelta(delta)}</span>
      </div>
    </div>
  )
}

function HeadlineMetric({ label, value, hint, accent = 'text-text' }: { label: string; value: string; hint: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel/80 p-4">
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className={`mt-2 text-3xl font-semibold ${accent}`}>{value}</div>
      <div className="mt-2 text-xs text-muted">{hint}</div>
    </div>
  )
}

function Explainer({ title, children }: { title: string; children: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{title}</div>
      <div className="mt-1 text-xs text-text-2">{children}</div>
    </div>
  )
}

export default function OperationsDashboardPage() {
  const qc = useQueryClient()
  const models = useQuery({ queryKey: ['models'], queryFn: api.models })
  const [modelKey, setModelKey] = useState(DEFAULT_MODEL)
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([])
  const [selectedCompareRuns, setSelectedCompareRuns] = useState<number[]>([])
  const [lastBatchRunIds, setLastBatchRunIds] = useState<number[]>([])
  const [batchApplyIssue, setBatchApplyIssue] = useState<Error | null>(null)

  useEffect(() => {
    if (!models.data || models.data.length === 0) return
    if (models.data.some((m) => m.model_key === modelKey)) return
    const fallback = models.data.find((m) => m.model_key === DEFAULT_MODEL)?.model_key ?? models.data[0].model_key
    setModelKey(fallback)
  }, [models.data, modelKey])

  const currentModel = useMemo(
    () => models.data?.find((m) => m.model_key === modelKey) ?? models.data?.find((m) => m.model_key === DEFAULT_MODEL) ?? models.data?.[0] ?? null,
    [models.data, modelKey],
  )

  const feed = useQuery({ queryKey: ['feed-status', modelKey], queryFn: () => api.feed.status(modelKey), enabled: !!currentModel, retry: false })
  const live = useQuery({ queryKey: ['live', modelKey], queryFn: () => api.live(modelKey), enabled: !!currentModel })
  const active = useQuery({
    queryKey: ['runs', modelKey, 'active'],
    queryFn: () => api.allRuns({ model: modelKey, status: 'QUEUED,RUNNING', limit: 20 }),
    enabled: !!currentModel,
  })
  const nowcasts = useQuery({ queryKey: ['runs', modelKey, 'nowcast'], queryFn: () => api.allRuns({ model: modelKey, origin: 'NOWCAST', limit: 8 }), enabled: !!currentModel })
  const recentRuns = useQuery({ queryKey: ['runs', modelKey, 'recent'], queryFn: () => api.allRuns({ model: modelKey, limit: 12 }), enabled: !!currentModel })
  const recommenderRuns = useQuery({
    queryKey: ['runs', modelKey, 'recommender'],
    enabled: !!currentModel,
    queryFn: async (): Promise<RecommenderRun[]> => {
      const rows = await api.allRuns({ model: modelKey, origin: 'RECOMMENDER', limit: 12 })
      const scenarios = await Promise.all(rows.map((r) => api.scenario(r.scenario_id)))
      return rows.map((run, i) => ({ run, scenario: scenarios[i] }))
    },
  })

  const latestNowcast = nowcasts.data?.[0]
  const latestNowcastScenario = useQuery({
    queryKey: ['scenario', latestNowcast?.scenario_id],
    queryFn: () => api.scenario(latestNowcast!.scenario_id),
    enabled: !!latestNowcast,
  })
  const latestNowcastRun = useQuery({
    queryKey: ['run', latestNowcast?.id],
    queryFn: () => api.run(latestNowcast!.id),
    enabled: !!latestNowcast,
  })

  const descendentRuns = useMemo(
    () => recommenderRuns.data?.filter((item) => item.scenario.parent_id === latestNowcast?.scenario_id) ?? [],
    [recommenderRuns.data, latestNowcast?.scenario_id],
  )

  const appliedCandidate = useMemo(
    () => descendentRuns.find((item) => item.run.status === 'DONE') ?? descendentRuns[0] ?? null,
    [descendentRuns],
  )

  const appliedRun = useQuery({
    queryKey: ['run', appliedCandidate?.run.id],
    queryFn: () => api.run(appliedCandidate!.run.id),
    enabled: !!appliedCandidate,
  })

  const forecastMeta = forecastMetaOf(latestNowcastScenario.data)
  const replenishment = forecastMeta?.replenishment ?? []
  const latestRecommendations = latestNowcastRun.data?.insights.filter((i) => i.kind === 'RECOMMENDATION') ?? []
  const recommendationOptions = useMemo<RecommendationOption[]>(() => latestRecommendations.flatMap((ins: Insight) =>
    candidatesOf(ins).map((c) => ({
      key: `${ins.id}:${c.rank}`,
      insightId: ins.id,
      rank: c.rank,
      subject: ins.subject_key ?? '—',
      title: describeAction(c.action),
      redDelta: c.delta_kpi.red_minutes,
      throughputDelta: c.delta_kpi.throughput,
      score: c.score,
    }))), [latestRecommendations])
  const totalCandidates = latestRecommendations.reduce((sum, ins) => sum + (((ins.payload?.candidates as unknown[]) ?? []).length), 0)
  const criticalCount = replenishment.filter((r) => r.priority === 'CRITICAL').length
  const activeForModel = active.data ?? []
  const liveSubjectCount = Object.keys(live.data?.subjects ?? {}).length
  const liveSourceCount = live.data?.sources.length ?? 0
  const staleSources = (live.data?.sources ?? []).filter((s) => s.age_ms > STALE_MS).length
  const boundSources = (live.data?.sources ?? []).filter((s) => s.bound).length
  const hasLiveClock = !!live.data?.now && live.data.now > '0002'
  const hasLiveEvidence = hasLiveClock && (liveSubjectCount > 0 || liveSourceCount > 0)
  const nowcastRed = latestNowcastRun.data ? kpiP50(latestNowcastRun.data.kpis, 'red_minutes') : undefined
  const nowcastTp = latestNowcastRun.data ? kpiP50(latestNowcastRun.data.kpis, 'throughput') : undefined
  const appliedRed = appliedRun.data ? kpiP50(appliedRun.data.kpis, 'red_minutes') : undefined
  const appliedTp = appliedRun.data ? kpiP50(appliedRun.data.kpis, 'throughput') : undefined
  const chartRows = (recentRuns.data ?? [])
    .filter((r) => r.red_minutes_p50 !== null)
    .slice(0, 8)
    .reverse()
    .map((r) => ({
      id: `#${r.id}`,
      runId: r.id,
      origin: r.scenario_origin,
      scenario: r.scenario_name,
      red: r.red_minutes_p50 ?? 0,
      fill: originTone(r.scenario_origin),
    }))
  const topRecommendation = replenishment[0] ?? null
  const redDelta = nowcastRed !== undefined && appliedRed !== undefined ? appliedRed - nowcastRed : undefined
  const tpDelta = nowcastTp !== undefined && appliedTp !== undefined ? appliedTp - nowcastTp : undefined
  const liveReady = hasLiveEvidence && staleSources === 0 && boundSources > 0
  const systemVerdict = !live.data || !hasLiveClock
    ? 'Chưa có live snapshot'
    : liveSourceCount === 0 && liveSubjectCount === 0
      ? live.data.bindings > 0
        ? 'Đã cấu hình live nhưng chưa có dữ liệu đổ về'
        : 'Mô hình chưa có binding hoặc nguồn live hoạt động'
    : staleSources > 0
      ? `Live đang chạy nhưng có ${staleSources} nguồn trễ`
      : feed.data?.state === 'running'
        ? 'Live feed ổn định, dữ liệu đang đổ realtime'
        : 'Có snapshot live, feed hiện không chạy liên tục'
  const recommendationVerdict = !topRecommendation
    ? 'Chưa có recommendation khẩn cấp ở NOWCAST mới nhất'
    : `${topRecommendation.label ?? topRecommendation.subject} cần bù ${num(topRecommendation.recommended_replenish, 1)} ${topRecommendation.material ?? ''}`
  const effectVerdict = redDelta === undefined || tpDelta === undefined
    ? 'Chưa đủ dữ liệu before/after'
    : redDelta < 0 && tpDelta >= 0
      ? 'Recommendation gần nhất đang cải thiện cả rủi ro và throughput'
      : redDelta < 0
        ? 'Recommendation gần nhất đang giảm rủi ro'
        : tpDelta > 0
          ? 'Recommendation gần nhất đang tăng throughput'
          : 'Hiệu quả chưa rõ, cần thêm lần áp dụng để so sánh'
  const heroTone = criticalCount > 0 ? 'border-bad/40 bg-bad-bg/40' : liveReady ? 'border-ok/40 bg-panel-2' : 'border-line-2 bg-panel-2'
  const compareHref = latestNowcast && selectedCompareRuns.length > 0
    ? `/compare?ids=${[latestNowcast.id, ...selectedCompareRuns].join(',')}`
    : null

  useEffect(() => {
    setSelectedCandidates([])
    setSelectedCompareRuns([])
    setLastBatchRunIds([])
    setBatchApplyIssue(null)
  }, [latestNowcast?.id])

  useEffect(() => {
    if (recommendationOptions.length === 0) return
    setSelectedCandidates((cur) => cur.filter((k) => recommendationOptions.some((o) => o.key === k)))
  }, [recommendationOptions])

  useEffect(() => {
    if (descendentRuns.length === 0) return
    setSelectedCompareRuns((cur) => {
      const valid = cur.filter((id) => descendentRuns.some((r) => r.run.id === id))
      if (valid.length > 0) return valid
      return descendentRuns.slice(0, 3).map((r) => r.run.id)
    })
  }, [descendentRuns])

  const batchApply = useMutation({
    mutationFn: async ({ keys }: { keys: string[]; model: string }) => {
      const chosen = recommendationOptions.filter((o) => keys.includes(o.key))
      const out: number[] = []
      const failures: string[] = []
      for (const item of chosen) {
        try {
          const res = await api.applyInsight(item.insightId, item.rank)
          out.push(res.run_id)
        } catch (error) {
          failures.push(`${item.title}: ${error instanceof Error ? error.message : 'lỗi không rõ'}`)
        }
      }
      return { runIds: out, failures }
    },
    onMutate: () => {
      setBatchApplyIssue(null)
    },
    onSuccess: async ({ runIds, failures }, vars) => {
      setLastBatchRunIds(runIds)
      const indiv = runIds.map((id) => qc.invalidateQueries({ queryKey: ['run', id] }))
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['runs', vars.model, 'active'] }),
        qc.invalidateQueries({ queryKey: ['runs', vars.model, 'recommender'] }),
        qc.invalidateQueries({ queryKey: ['runs', vars.model, 'recent'] }),
        qc.invalidateQueries({ queryKey: ['runs', vars.model, 'nowcast'] }),
        ...indiv,
      ])
      if (failures.length > 0) {
        setBatchApplyIssue(new Error(
          runIds.length > 0
            ? `Đã tạo ${runIds.length} run, nhưng ${failures.length} phương án lỗi: ${failures.join('; ')}`
            : `Không tạo được run nào: ${failures.join('; ')}`,
        ))
      }
    },
  })

  function toggleCandidate(key: string) {
    setSelectedCandidates((cur) => cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key])
  }

  function toggleCompareRun(id: number) {
    setSelectedCompareRuns((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])
  }

  const err = models.error ?? active.error ?? nowcasts.error ?? recentRuns.error ?? recommenderRuns.error ?? latestNowcastScenario.error ?? latestNowcastRun.error ?? appliedRun.error
  if (models.isLoading || active.isLoading || nowcasts.isLoading || recentRuns.isLoading || recommenderRuns.isLoading) return <Loading />

  return (
    <PageBody wide>
      <PageHeader icon={Gauge}
        title="Dashboard vận hành FMCG"
        subtitle="Theo dõi trạng thái live, recommendation và hiệu quả áp dụng trên cùng một màn hình"
        actions={
          <>
            <select className={input} aria-label="Chọn mô hình" value={modelKey} onChange={(e) => setModelKey(e.target.value)}>
              {(models.data ?? []).map((m: ModelSummary) => <option key={m.model_key} value={m.model_key}>{m.model_key}</option>)}
            </select>
            <Link className={btn} to="/reports/benchmarks">Benchmark FMCG</Link>
            {latestNowcast && <Link className={btn} to={`/runs/${latestNowcast.id}`}>Mở NOWCAST mới nhất</Link>}
            {currentModel && <Link className={btnPrimary} to={`/models/${encodeURIComponent(currentModel.model_key)}/live`}>Mở Live Twin</Link>}
          </>
        }
      />
      <Notice>
        Trang này trả lời 3 câu hỏi cho demo: hệ thống hiện đang nhận live data ra sao, đang khuyến nghị bù hàng gì, và lần áp dụng recommendation gần nhất có giúp giảm rủi ro hay tăng throughput hay không.
      </Notice>
      <ErrorBox error={err} />

      <div className="grid gap-3 lg:grid-cols-3">
        <Explainer title="1. Đọc Tình trạng live">
          Nhìn vào nguồn dữ liệu, số binding hoạt động và số nguồn bị trễ. Realtime là tốt nhất; nếu có nguồn stale hoặc lỗi binding thì độ tin cậy của recommendation sẽ giảm.
        </Explainer>
        <Explainer title="2. Đọc Recommendation">
          Xem mục ưu tiên số 1 trước. Coverage càng thấp, pressure càng cao, backorder càng lớn thì nhu cầu bù hàng càng cấp bách. `CRITICAL` nghĩa là nên xử lý trước để tránh thiếu hàng.
        </Explainer>
        <Explainer title="3. Đọc Hiệu quả">
          So sánh NOWCAST với các run RECOMMENDER đã apply. Với `Red minutes`, số nhỏ hơn là tốt. Với `Throughput`, số lớn hơn là tốt. Mục tiêu là giảm đỏ nhưng không làm throughput xấu đi.
        </Explainer>
      </div>

      <section className={`rounded-2xl border p-5 ${heroTone}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Executive Summary</div>
            <h2 className="mt-2 text-2xl font-semibold text-text">Hệ thống hiện tại đang theo dõi realtime, sinh recommendation và đo hiệu quả ngay trên cùng flow.</h2>
            <p className="mt-2 text-sm text-text-2">
              {systemVerdict}. {recommendationVerdict}. {effectVerdict}.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px]">
            <Tag>{currentModel?.model_key ?? modelKey}</Tag>
            <Tag>{latestNowcast ? `NOWCAST #${latestNowcast.id}` : 'Chưa có NOWCAST'}</Tag>
            <Tag>{appliedCandidate ? `RECOMMENDER #${appliedCandidate.run.id}` : 'Chưa apply recommendation'}</Tag>
          </div>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <HeadlineMetric
            label="Tình trạng live"
            value={feed.data?.state === 'running' ? 'Realtime' : hasLiveEvidence ? 'Snapshot' : live.data?.bindings ? 'Đã cấu hình' : 'Offline'}
            hint={
              !live.data || !hasLiveClock
                ? 'Chưa có snapshot live để đánh giá'
                : liveSourceCount === 0 && liveSubjectCount === 0
                  ? live.data.bindings > 0
                    ? `Đã ghép ${live.data.bindings} tín hiệu nhưng chưa thấy nguồn live đổ về`
                    : 'Chưa có binding hoặc nguồn live cho mô hình này'
                  : `${boundSources} nguồn đã ghép, ${staleSources} nguồn stale, ${live.data.errors.length} lỗi binding`
            }
            accent={liveReady ? 'text-ok' : staleSources > 0 ? 'text-warn' : 'text-text'}
          />
          <HeadlineMetric
            label="Ưu tiên số 1"
            value={topRecommendation ? `${topRecommendation.priority ?? 'LOW'} • ${num(topRecommendation.pre_coverage_hours, 1)}h` : 'Không có'}
            hint={topRecommendation ? `${topRecommendation.label ?? topRecommendation.subject} cần bù ${num(topRecommendation.recommended_replenish, 1)} ${topRecommendation.material ?? ''}` : 'NOWCAST mới nhất chưa phát sinh replenishment khẩn cấp'}
            accent={topRecommendation?.priority === 'CRITICAL' ? 'text-bad-text' : topRecommendation ? 'text-warn' : 'text-text'}
          />
          <HeadlineMetric
            label="Hiệu quả gần nhất"
            value={redDelta === undefined ? 'Chưa đủ dữ liệu' : redDelta < 0 ? `${fmtDelta(redDelta)} red` : `${fmtDelta(tpDelta ?? 0)} throughput`}
            hint={redDelta === undefined ? 'Cần có một run RECOMMENDER được apply từ NOWCAST để so sánh' : `Red minutes ${num(nowcastRed, 1)} -> ${num(appliedRed, 1)}, throughput ${num(nowcastTp, 1)} -> ${num(appliedTp, 1)}`}
            accent={redDelta !== undefined && redDelta < 0 ? 'text-ok' : tpDelta !== undefined && tpDelta > 0 ? 'text-ok' : 'text-text'}
          />
        </div>
      </section>

      <BenchmarkPanel modelKey={modelKey} />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Feed & Live"
          value={feed.data?.state === 'running' ? 'Đang chạy' : feed.data?.state === 'paused' ? 'Tạm dừng' : 'Chưa bật'}
          hint={
            !live.data || !hasLiveClock
              ? 'Chưa có snapshot live để đánh giá'
              : liveSourceCount === 0 && liveSubjectCount === 0
                ? live.data.bindings > 0
                  ? `${live.data.bindings} binding đã cấu hình nhưng chưa có dữ liệu vào`
                  : 'Chưa cấu hình binding live'
                : `${boundSources}/${live.data.bindings} binding hoạt động, ${staleSources} nguồn trễ`
          }
          accent={feed.data?.state === 'running' ? 'text-ok' : 'text-text'}
        />
        <Card title="NOWCAST mới nhất">
          {!latestNowcast ? (
            <p className="text-xs text-muted">Chưa có NOWCAST nào cho mô hình này.</p>
          ) : (
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium text-text">Run #{latestNowcast.id}</div>
                <StatusChip status={latestNowcast.status} />
              </div>
              <div className="text-muted">{latestNowcast.scenario_name}</div>
              <div className="text-muted">Bắt đầu: {fmtDateTime(latestNowcast.sim_start)}</div>
              <div className="text-muted">Hoàn tất: {fmtDateTime(latestNowcast.finished_at)}</div>
            </div>
          )}
        </Card>
        <StatCard
          title="Recommendation hiện tại"
          value={`${latestRecommendations.length} insight / ${totalCandidates} candidate`}
          hint={criticalCount > 0 ? `${criticalCount} mục CRITICAL cần bù hàng ngay` : 'Chưa có mục replenishment khẩn cấp'}
          accent={criticalCount > 0 ? 'text-bad-text' : 'text-text'}
        />
        <Card title="Hiệu quả gần nhất">
          {appliedCandidate && appliedRun.data ? (
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium text-text">Run #{appliedCandidate.run.id}</div>
                <StatusChip status={appliedCandidate.run.status} />
              </div>
              <div className="text-muted">Áp từ NOWCAST #{latestNowcast?.id ?? '—'}</div>
              <div className="text-muted">
                {appliedCandidate.run.status === 'DONE'
                  ? 'Đã có số liệu before/after để chứng minh hiệu quả'
                  : 'Đang chờ run đề xuất hoàn tất để chốt hiệu quả'}
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted">Chưa có recommendation nào được apply từ NOWCAST mới nhất.</p>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <Card title="Hệ thống đang chạy ra sao">
          <div className="mb-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-text-2">
            Khu này dùng để xác nhận hệ thống có đang nhận dữ liệu thật hay không. Nếu `Nguồn stale` tăng cao hoặc `Lỗi binding` xuất hiện, hãy hiểu rằng phần forecast phía sau đang dựa trên dữ liệu kém ổn định hơn.
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2 rounded-lg border border-line bg-panel-2 p-3 text-xs">
              <div className="font-medium text-text">Nguồn live hiện tại</div>
              {feed.error && <div className="text-muted">Feed service chưa phản hồi. Dashboard vẫn đọc được snapshot và runs đã có.</div>}
              {!live.data || !hasLiveClock ? (
                <div className="text-muted">Chưa có snapshot live cho mô hình này.</div>
              ) : liveSourceCount === 0 && liveSubjectCount === 0 ? (
                <div className="text-muted">
                  {live.data.bindings > 0
                    ? `Đã ghép ${live.data.bindings} tín hiệu nhưng hiện chưa thấy nguồn live nào đổ về.`
                    : 'Mô hình chưa có binding hoặc nguồn live hoạt động.'}
                </div>
              ) : (
                <>
                  <div className="text-muted">Mốc live: {fmtDateTime(live.data.now)}</div>
                  <div className="text-muted">Subject có tín hiệu: {liveSubjectCount}</div>
                  <div className="text-muted">Nguồn đang thấy: {liveSourceCount}</div>
                  <div className="text-muted">Nguồn đã ghép: {boundSources}</div>
                  <div className="text-muted">Nguồn stale hơn 2 phút: {staleSources}</div>
                  <div className="text-muted">Lỗi binding gần đây: {live.data.errors.length}</div>
                </>
              )}
            </div>
            <div className="space-y-2 rounded-lg border border-line bg-panel-2 p-3 text-xs">
              <div className="font-medium text-text">Run đang hoạt động</div>
              {activeForModel.length === 0 ? (
                <div className="text-muted">Hiện không có run nào đang chạy cho mô hình này.</div>
              ) : (
                activeForModel.slice(0, 4).map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-2">
                    <Link className="text-text hover:underline" to={`/runs/${r.id}`}>#{r.id} {r.scenario_name}</Link>
                    <StatusChip status={r.status} />
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="mt-3 space-y-2">
            <div className="text-xs font-medium text-text">Top nguồn live</div>
            {(live.data?.sources ?? []).length === 0 ? (
              <p className="text-xs text-muted">Chưa có nguồn live nào đổ về mô hình này.</p>
            ) : (
              <div className="space-y-2">
                {live.data!.sources.slice(0, 6).map((s) => (
                  <div key={s.source} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-xs">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-text">{s.desc || s.source}</div>
                      <div className="truncate text-muted">{s.source}</div>
                    </div>
                    <div className="text-right text-muted">
                      <div>{s.count} message</div>
                      <div>{Math.round(s.age_ms / 1000)}s trước</div>
                    </div>
                    <Tag>{s.bound ? 'Đã ghép' : 'Chưa ghép'}</Tag>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        <Card title="Recommendation và ưu tiên bù hàng">
          <div className="mb-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-text-2">
            Khu này trả lời câu hỏi “hệ thống đang khuyên làm gì ngay bây giờ?”. Dòng đầu là phương án khẩn cấp nhất. `Cần bù` là số lượng nên bổ sung, `Coverage trước boost` là số giờ còn trụ được nếu chưa hành động.
          </div>
          {!latestNowcast ? (
            <p className="text-xs text-muted">Chưa có NOWCAST nên chưa sinh recommendation.</p>
          ) : replenishment.length === 0 ? (
            <p className="text-xs text-muted">NOWCAST mới nhất chưa sinh ra replenishment nào.</p>
          ) : (
            <div className="space-y-3">
              {topRecommendation && (
                <div className="rounded-xl border border-bad/50 bg-bad-bg p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-base font-semibold text-text">Ưu tiên số 1: {topRecommendation.label ?? topRecommendation.subject}</div>
                    <PriorityTag priority={topRecommendation.priority} />
                    <Tag>{topRecommendation.material ?? '—'}</Tag>
                  </div>
                  <div className="mt-3 grid gap-3 md:grid-cols-3">
                    <div className="rounded-lg bg-panel px-3 py-2">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted">Cần bù</div>
                      <div className="mt-1 text-2xl font-semibold text-bad-text">{num(topRecommendation.recommended_replenish, 1)}</div>
                      <div className="text-xs text-muted">{topRecommendation.material}</div>
                    </div>
                    <div className="rounded-lg bg-panel px-3 py-2">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted">Coverage trước boost</div>
                      <div className="mt-1 text-2xl font-semibold text-text">{num(topRecommendation.pre_coverage_hours, 1)}h</div>
                      <div className="text-xs text-muted">Pressure {num((topRecommendation.coverage_pressure ?? 0) * 100, 0)}%</div>
                    </div>
                    <div className="rounded-lg bg-panel px-3 py-2">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted">Backorder live</div>
                      <div className="mt-1 text-2xl font-semibold text-text">{num(topRecommendation.backorder_per_hour, 1)}/h</div>
                      <div className="text-xs text-muted">{topRecommendation.upstream_label ?? topRecommendation.upstream_sources?.[0] ?? 'upstream chưa rõ'}</div>
                    </div>
                  </div>
                  <div className="mt-3 text-xs text-text-2">{topRecommendation.reason}</div>
                </div>
              )}
              {replenishment.map((r, idx) => {
                const cand = r.candidates?.[0]
                return (
                  <div key={`${r.subject}-${r.material}`} className={`rounded-lg border p-3 ${idx === 0 ? 'border-bad/40 bg-panel-2' : 'border-line'}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-sm font-semibold text-text">{r.label ?? r.subject}</div>
                      <PriorityTag priority={r.priority} />
                      <Tag>{r.material ?? '—'}</Tag>
                      <Tag>{r.source ?? 'runtime'}</Tag>
                    </div>
                    <div className="mt-2 text-xs text-muted">
                      Cần bù <b className="text-text">{num(r.recommended_replenish, 1)}</b> {r.material}, tồn hiện tại {num(r.stock, 1)}, mục tiêu {num(r.target_stock, 1)}.
                    </div>
                    <div className="mt-1 text-xs text-muted">
                      Phủ trước boost {num(r.pre_coverage_hours, 1)}h, pressure {num((r.coverage_pressure ?? 0) * 100, 0)}%, backorder {num(r.backorder_per_hour, 1)}/h.
                    </div>
                    <div className="mt-1 text-xs text-muted">{r.reason ?? 'Không có diễn giải bổ sung.'}</div>
                    {cand?.action && (
                      <div className="mt-2 rounded-md border border-line bg-panel-2 px-2 py-1 text-[11px] text-text-2">
                        Candidate áp dụng: {cand.action.type} vào {cand.action.target}, bù {num(cand.action.qty, 1)} {cand.action.material} (score {num(cand.score, 2)}).
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card
          title="Chọn nhiều recommendation để chạy thử"
          actions={
            <button
              className={btnPrimary}
              disabled={selectedCandidates.length === 0 || batchApply.isPending}
              onClick={() => batchApply.mutate({ keys: selectedCandidates, model: modelKey })}
            >
              {batchApply.isPending ? 'Đang tạo các phương án...' : `Chạy ${selectedCandidates.length} phương án đã chọn`}
            </button>
          }
        >
          <ErrorBox error={batchApply.error ?? batchApplyIssue} />
          <div className="mb-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-text-2">
            Khu này dành cho việc thử nhiều phương án cùng lúc. Tick nhiều candidate rồi chạy batch để tạo nhiều run `RECOMMENDER`. Mỗi phương án là một giả thuyết xử lý khác nhau để đem ra so sánh.
          </div>
          {recommendationOptions.length === 0 ? (
            <p className="text-xs text-muted">NOWCAST mới nhất chưa có candidate recommendation để chọn.</p>
          ) : (
            <div className="space-y-2">
              <div className="text-xs text-muted">
                Tick nhiều candidate để hệ thống sinh nhiều run `RECOMMENDER`, sau đó compare xem phương án nào giảm rủi ro tốt hơn.
              </div>
              {recommendationOptions.map((opt) => (
                <label key={opt.key} className="flex cursor-pointer items-start gap-3 rounded-lg border border-line px-3 py-2 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selectedCandidates.includes(opt.key)}
                    onChange={() => toggleCandidate(opt.key)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-text">{opt.title}</div>
                    <div className="mt-1 text-muted">{opt.subject} • score {num(opt.score, 2)}</div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Tag>giảm đỏ {num(opt.redDelta, 1)} phút</Tag>
                      <Tag>throughput {fmtDelta(opt.throughputDelta)}</Tag>
                      <Tag>rank #{opt.rank}</Tag>
                    </div>
                  </div>
                </label>
              ))}
              {lastBatchRunIds.length > 0 && (
                <div className="rounded-lg border border-ok/40 bg-panel-2 px-3 py-2 text-xs text-text-2">
                    Đã tạo các run: {lastBatchRunIds.map((id) => `#${id}`).join(', ')}. Khi chạy xong, bạn có thể tick nhiều run ở khung bên cạnh để compare.
                </div>
              )}
            </div>
          )}
        </Card>

        <Card
          title="Chọn nhiều phương án để so sánh"
          actions={compareHref ? <Link className={btnPrimary} to={compareHref}>So sánh các phương án đã chọn</Link> : undefined}
        >
          <div className="mb-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-text-2">
            Baseline luôn là `NOWCAST`. Các run được tick ở đây là những phương án đã apply để đối đầu trực tiếp với baseline. Chọn càng nhiều phương án thì càng dễ thấy phương án nào cải thiện mạnh nhất và phương án nào chỉ đổi bề ngoài.
          </div>
          {!latestNowcast ? (
            <p className="text-xs text-muted">Chưa có NOWCAST baseline để làm gốc so sánh.</p>
          ) : descendentRuns.length === 0 ? (
            <p className="text-xs text-muted">Chưa có run RECOMMENDER nào sinh ra từ NOWCAST #{latestNowcast.id}.</p>
          ) : (
            <div className="space-y-2">
              <div className="text-xs text-muted">
                Baseline luôn là NOWCAST #{latestNowcast.id}. Bạn có thể tick nhiều run `RECOMMENDER` để mở compare nhiều cột cùng lúc.
              </div>
              {descendentRuns.map(({ run, scenario }) => {
                const selected = selectedCompareRuns.includes(run.id)
                return (
                  <label key={run.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 text-xs ${selected ? 'border-text bg-panel-2' : 'border-line'}`}>
                    <input type="checkbox" className="mt-0.5" checked={selected} onChange={() => toggleCompareRun(run.id)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-text">Run #{run.id}</span>
                        <StatusChip status={run.status} />
                        <Tag>{scenario.name}</Tag>
                      </div>
                      <div className="mt-1 text-muted">
                        {scenario.action && typeof scenario.action === 'object'
                            ? `${(scenario.action as { type?: string }).type ?? 'RECOMMEND'} ${(scenario.action as { qty?: number }).qty ?? ''} ${(scenario.action as { material?: string }).material ?? ''} vào ${(scenario.action as { target?: string }).target ?? ''}`
                            : 'Không có action metadata'}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2">
                        <Tag>Red P50 {num(run.red_minutes_p50, 1)}</Tag>
                        <Tag>{fmtDateTime(run.finished_at ?? run.created_at)}</Tag>
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Card title="Có hiệu quả hay không">
          <div className="mb-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-text-2">
            Đây là phần kết luận. Nếu `Red minutes` đi xuống và `Throughput` giữ nguyên hoặc đi lên thì recommendation đang có giá trị thực tế. Nếu giảm đỏ nhưng throughput tụt mạnh, đó chưa chắc là phương án tốt.
          </div>
          {!latestNowcast || !latestNowcastRun.data ? (
            <p className="text-xs text-muted">Chưa có NOWCAST hoàn chỉnh để so sánh hiệu quả.</p>
          ) : !appliedCandidate ? (
            <p className="text-xs text-muted">Chưa có run RECOMMENDER nào được tạo từ NOWCAST mới nhất, nên chưa chứng minh được hiệu quả before/after.</p>
          ) : !appliedRun.data ? (
            <p className="text-xs text-muted">Đang tải run áp dụng recommendation để so sánh.</p>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-line bg-panel-2 p-4">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-muted">Red minutes</div>
                  <div className="mt-2 flex items-end gap-3">
                    <div className="text-3xl font-semibold text-text">{num(appliedRed, 1)}</div>
                    <div className={`text-sm font-semibold ${redDelta !== undefined && redDelta < 0 ? 'text-ok' : redDelta === 0 ? 'text-muted' : 'text-bad-text'}`}>
                      {redDelta === undefined ? '—' : fmtDelta(redDelta)}
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-muted">NOWCAST {num(nowcastRed, 1)} {'->'} RECOMMENDER {num(appliedRed, 1)}</div>
                </div>
                <div className="rounded-xl border border-line bg-panel-2 p-4">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-muted">Throughput</div>
                  <div className="mt-2 flex items-end gap-3">
                    <div className="text-3xl font-semibold text-text">{num(appliedTp, 1)}</div>
                    <div className={`text-sm font-semibold ${tpDelta !== undefined && tpDelta > 0 ? 'text-ok' : tpDelta === 0 ? 'text-muted' : 'text-bad-text'}`}>
                      {tpDelta === undefined ? '—' : fmtDelta(tpDelta)}
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-muted">NOWCAST {num(nowcastTp, 1)} {'->'} RECOMMENDER {num(appliedTp, 1)}</div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Tag>NOWCAST #{latestNowcast.id}</Tag>
                <Tag>RECOMMENDER #{appliedCandidate.run.id}</Tag>
                <Link className={btn} to={`/compare?a=${latestNowcast.id}&b=${appliedCandidate.run.id}`}>Mở so sánh chi tiết</Link>
                <Link className={btnPrimary} to={`/runs/${appliedCandidate.run.id}`}>Mở run đã áp dụng</Link>
              </div>
              <EffectDelta label="Red minutes P50" before={nowcastRed} after={appliedRed} goodWhenLower />
              <EffectDelta label="Throughput P50" before={nowcastTp} after={appliedTp} />
              <div className="rounded-lg border border-line bg-panel-2 p-3 text-xs text-muted">
                {appliedCandidate.scenario.action && typeof appliedCandidate.scenario.action === 'object'
                  ? `Recommendation đã áp dụng: ${(appliedCandidate.scenario.action as { type?: string; target?: string; qty?: number; material?: string }).type ?? 'REPLENISH'} ${(appliedCandidate.scenario.action as { qty?: number }).qty ?? ''} ${(appliedCandidate.scenario.action as { material?: string }).material ?? ''} vào ${(appliedCandidate.scenario.action as { target?: string }).target ?? ''}.`
                  : 'Scenario áp dụng không có action metadata.'}
              </div>
              <div className="text-xs text-muted">
                Thời gian chạy áp dụng: {fmtDuration(appliedRun.data.created_at, appliedRun.data.finished_at)}
              </div>
            </div>
          )}
        </Card>

        <Card title="Lịch sử rủi ro theo các run gần đây">
          <div className="mb-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-text-2">
            Biểu đồ này dùng để nhìn xu hướng tổng thể thay vì từng case đơn lẻ. Cột càng thấp thì `Red minutes P50` càng tốt. Nếu các run `RECOMMENDER` thường xuyên thấp hơn `NOWCAST`, đó là dấu hiệu hệ thống đang đưa ra phương án đáng tin.
          </div>
          {chartRows.length === 0 ? (
            <p className="text-xs text-muted">Chưa có đủ run đã hoàn tất để vẽ lịch sử red minutes.</p>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap gap-2 text-[11px] text-muted">
                <Tag>Đen: NOWCAST</Tag>
                <Tag>Xanh: RECOMMENDER</Tag>
                <Tag>Xám: USER</Tag>
              </div>
              <div className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartRows}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                    <XAxis dataKey="id" tick={axisTick} axisLine={axisLine} tickLine={false} />
                    <YAxis tick={axisTick} axisLine={axisLine} tickLine={false} width={44} />
                    <Tooltip
                      {...tooltipProps}
                      formatter={(v) => [num(typeof v === 'number' ? v : Number(v), 1), 'Red minutes P50']}
                      labelFormatter={(_, payload) => {
                        const row = payload?.[0]?.payload as { scenario?: string; origin?: string; runId?: number } | undefined
                        return row ? `Run #${row.runId} • ${row.origin} • ${row.scenario}` : ''
                      }}
                    />
                    <Bar dataKey="red" radius={[6, 6, 0, 0]}>
                      {chartRows.map((r) => <Cell key={r.runId} fill={r.fill} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </Card>
      </div>
    </PageBody>
  )
}
