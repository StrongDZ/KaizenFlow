import { useQuery } from '@tanstack/react-query'
import { FileText } from 'lucide-react'
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
import { api } from '../api/client'
import { BandChart, axisLine, axisTick, tooltipProps } from '../components/Charts'
import { ScenarioTimeline } from '../components/scenario/ScenarioTimeline'
import { DataTable, type Column } from '../components/table/DataTable'
import { Card, EmptyState, ErrorBox, Loading, Notice, PageBody, PageHeader, Tag, btn, btnPrimary } from '../components/ui'
import { candidatesOf, describeAction, describeInsight, kpiP50 } from '../lib/insights'
import { fmtDelta } from '../lib/format'
import { byCode, thresholdsFor } from '../lib/model'
import { clip, indexBands, series } from '../lib/replay'
import { describeInjection, describeOverride, formatScenarioDuration } from '../lib/scenarioView'

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
  if (run.error) return <div className="p-6"><ErrorBox error={run.error} /></div>
  if (!run.data || !scenario.data || !graph.data || !types.data || !bands.data) return <Loading />
  const r = run.data
  const typeMap = byCode(types.data)
  const idx = indexBands(bands.data)
  const risky = r.insights.filter((i) => i.kind === 'RED_RISK').map((i) => i.subject_key ?? '')
  const storages = graph.data.nodes.filter((n) => risky.includes(n.key))
  const candidates = r.insights.filter((i) => i.kind === 'RECOMMENDATION').flatMap((i) => candidatesOf(i))
  const kpi = (k: string) => kpiP50(r.kpis, k)?.toFixed(1) ?? '—'
  const serviceLevel = kpiP50(r.kpis, 'service_level')
  return (
    <div data-theme="light" className="min-h-full bg-bg text-text">
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

        <section>
          <h2 className="mb-2 font-semibold">1. Thiết lập scenario</h2>
          <div className="grid grid-cols-3 gap-3 text-sm">
            <div className="rounded border p-2"><div className="text-xs text-muted">Thời lượng</div><b>{formatScenarioDuration(scenario.data.horizon_s)}</b></div>
            <div className="rounded border p-2"><div className="text-xs text-muted">Lần lặp</div><b>{scenario.data.replications}</b></div>
            <div className="rounded border p-2"><div className="text-xs text-muted">Khởi đầu</div><b>{scenario.data.start_state}</b></div>
          </div>
          <div className="mt-3 break-inside-avoid rounded border p-3">
            <ScenarioTimeline
              horizonS={scenario.data.horizon_s}
              events={scenario.data.injections.map((i) => describeInjection(i))}
              startLabel={scenario.data.start_state}
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
          <h2 className="mb-2 font-semibold">2. Chỉ số chính (trung vị)</h2>
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-t"><td className="py-1">Sản lượng xuất</td><td className="text-right">{kpi('throughput')}</td></tr>
              <tr className="border-t"><td className="py-1">Tổng phút Đỏ</td><td className="text-right">{kpi('red_minutes')}</td></tr>
              <tr className="border-t"><td className="py-1">Nợ đơn cuối kỳ</td><td className="text-right">{kpi('backorder_end')}</td></tr>
              <tr className="border-t"><td className="py-1">Mức phục vụ</td><td className="text-right">{serviceLevel === undefined ? '—' : `${(serviceLevel * 100).toFixed(1)}%`}</td></tr>
            </tbody>
          </table>
        </section>

        <section>
          <h2 className="mb-2 font-semibold">3. Dự báo &amp; điểm nghẽn</h2>
          <ul className="list-disc pl-5 text-sm">
            {r.insights.filter((i) => i.kind !== 'RECOMMENDATION').map((i) => <li key={i.id}>{describeInsight(i)}</li>)}
          </ul>
          {storages.map((n) => (
            <div key={n.key} className="mt-3 break-inside-avoid">
              <div className="text-sm font-medium">{n.key} — số giờ tồn kho còn đủ dùng</div>
              <BandChart points={clip(series(idx, n.key, 'coverage_h'), 24)} redH={thresholdsFor(n, typeMap).red_h} height={180} />
            </div>
          ))}
        </section>

        <section>
          <h2 className="mb-2 font-semibold">4. Hành động đề xuất (đã kiểm chứng bằng mô phỏng)</h2>
          {candidates.length === 0 && <div className="text-sm text-muted">Không có hành động nào cải thiện được kết quả.</div>}
          <table className="w-full text-sm">
            <tbody>
              {candidates.map((c) => (
                <tr key={c.rank} className="border-t align-top">
                  <td className="py-1">#{c.rank}</td>
                  <td className="py-1"><b>{describeAction(c.action)}</b>{c.reason && <span className="mt-0.5 block text-xs text-muted">{c.reason}</span>}</td>
                  <td className="text-right">−{c.delta_kpi.red_minutes.toFixed(1)} phút Đỏ</td>
                  <td className="text-right">{c.delta_kpi.throughput >= 0 ? '+' : ''}{c.delta_kpi.throughput.toFixed(1)} sản lượng</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="text-xs text-faint">
          Tham số thiết bị là giả định (chưa có dữ liệu DENSO), đánh dấu "assumed" trong catalog. Kết quả là phân phối từ nhiều lần mô phỏng, không phải một kịch bản duy nhất.
        </section>
      </div>
    </div>
  )
}

export default function ReportPage({ mode = 'run' }: { mode?: ReportMode }) {
  return mode === 'benchmarks' ? <BenchmarkPage /> : <RunReportPage />
}
