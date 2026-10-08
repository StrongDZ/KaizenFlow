import { useQueries, useQuery } from '@tanstack/react-query'
import { CheckCircle2, Download, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { axisLine, axisTick, fmtTime, tooltipProps } from '../components/Charts'
import { DecisionJourney } from '../components/scenario/DecisionJourney'
import { Card, Loading, Notice, btn } from '../components/ui'
import { describeAction, kpiP50, type Action } from '../lib/insights'
import { byCode, thresholdsFor } from '../lib/model'
import { clip, indexBands, NO_USE_COVERAGE, series } from '../lib/replay'
import { comparisonSummarySvg } from '../lib/scenarioExperience'

const KPIS: [string, string, boolean][] = [
  ['throughput', 'Sản lượng xuất', true], ['red_minutes', 'Tổng phút Đỏ', false], ['backorder_end', 'Nợ đơn cuối kỳ', false],
]

const COLORS = [
  'var(--color-muted)',
  'var(--color-text)',
  'var(--color-ok)',
  'var(--color-bad)',
  'var(--color-warn)',
  '#8b5cf6',
]

function runIdsFromParams(params: URLSearchParams): number[] {
  const raw = params.get('ids')
  if (raw) {
    const ids = raw.split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0)
    return Array.from(new Set(ids))
  }
  const pair = [Number(params.get('a')), Number(params.get('b'))].filter((v) => Number.isFinite(v) && v > 0)
  return Array.from(new Set(pair))
}

function durationHoursFor(points: Array<{ t: number; p50: number }>, predicate: (v: number) => boolean): number {
  let out = 0
  for (let i = 0; i < points.length - 1; i += 1) {
    if (!predicate(points[i].p50)) continue
    out += (points[i + 1].t - points[i].t) / 3_600_000
  }
  return out
}

export default function ComparePage() {
  const [params] = useSearchParams()
  const ids = runIdsFromParams(params)
  const runs = useQueries({ queries: ids.map((id) => ({ queryKey: ['run', id], queryFn: () => api.run(id) })) })
  const bands = useQueries({ queries: ids.map((id) => ({ queryKey: ['bands', id, 'coverage_h'], queryFn: () => api.bands(id, { metric: 'coverage_h' }) })) })
  const scenarios = useQueries({ queries: runs.map((r) => ({ queryKey: ['scenario', r.data?.scenario_id], queryFn: () => api.scenario(r.data!.scenario_id), enabled: !!r.data })) })
  const graphQueries = useQueries({ queries: scenarios.map((s) => ({ queryKey: ['graph', s.data?.model_version_id], queryFn: () => api.graph(s.data!.model_version_id), enabled: !!s.data })) })
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  const [focus, setFocus] = useState('')
  if (ids.length < 2) return <div className="mx-auto max-w-5xl p-6 text-sm text-muted">Chọn ít nhất 2 run để so sánh.</div>
  if (runs.some((r) => !r.data) || bands.some((b) => !b.data) || scenarios.some((s) => !s.data) || graphQueries.some((q) => !q.data) || !types.data) return <Loading />
  const runRows = runs.map((r) => r.data!)
  const scenarioRows = scenarios.map((s) => s.data!)
  const nodeTypes = byCode(types.data)
  const baseline = runRows[0]
  const effectiveSeeds = runRows.map((run, index) => scenarioRows[index].seed ?? run.id)
  const comparisonIssues: string[] = []
  if (effectiveSeeds.some((seed) => seed !== effectiveSeeds[0])) comparisonIssues.push(`seed hiệu lực khác nhau (${effectiveSeeds.join(', ')})`)
  if (scenarioRows.some((scenario) => scenario.horizon_s !== scenarioRows[0].horizon_s)) comparisonIssues.push('horizon khác nhau')
  if (scenarioRows.some((scenario) => scenario.replications !== scenarioRows[0].replications)) comparisonIssues.push('số lần lặp khác nhau')
  if (scenarioRows.some((scenario) => scenario.start_state !== scenarioRows[0].start_state)) comparisonIssues.push('trạng thái khởi đầu khác nhau')
  if (scenarioRows.some((scenario) => scenario.model_version_id !== scenarioRows[0].model_version_id)) comparisonIssues.push('phiên bản mô hình khác nhau')
  if (runRows.some((run) => run.sim_start !== runRows[0].sim_start)) comparisonIssues.push('mốc bắt đầu mô phỏng khác nhau')
  const bandIndexes = bands.map((x) => indexBands(x.data!))
  const subjects = [...bandIndexes[0].keys()]
  const subject = focus || baseline.insights.find((i) => i.kind === 'RED_RISK')?.subject_key || subjects[0] || ''
  const seriesByRun = bandIndexes.map((idx) => clip(series(idx, subject, 'coverage_h'), 24))
  const inventories = runRows.map((_, i) => {
    const graph = graphQueries[i].data!
    const storages = graph.nodes.filter((n) => n.archetype === 'STORAGE')
    const idx = bandIndexes[i]
    let stockoutH = 0
    let overstockH = 0
    for (const node of storages) {
      const pts = series(idx, node.key, 'coverage_h')
      if (pts.length < 2) continue
      const th = thresholdsFor({ node_type: node.node_type, params: node.params ?? {} }, nodeTypes)
      stockoutH += durationHoursFor(pts, (v) => Number.isFinite(v) && v < th.red_h)
      overstockH += durationHoursFor(pts, (v) => Number.isFinite(v) && v > th.yellow_high_h && v < NO_USE_COVERAGE)
    }
    return { stockoutH, overstockH, horizonH: scenarioRows[i].horizon_s / 3600 }
  })
  const longest = seriesByRun.reduce((m, rows) => Math.max(m, rows.length), 0)
  const data = Array.from({ length: longest }, (_, i) => {
    const row: Record<string, number | undefined> & { t: number } = { t: seriesByRun[0]?.[i]?.t ?? seriesByRun.find((s) => s[i])?.[i]?.t ?? 0 }
    seriesByRun.forEach((rows, j) => {
      row[`run_${runRows[j].id}`] = rows[i]?.p50
    })
    return row
  })
  const candidate = runRows[1]
  const candidateScenario = scenarioRows[1]
  const verdictMetrics = KPIS.map(([key, label, higherBetter]) => {
    const before = kpiP50(baseline.kpis, key) ?? 0
    const after = kpiP50(candidate.kpis, key) ?? 0
    return { key, label, higherBetter, before, after, delta: after - before }
  })
  const improved = verdictMetrics.filter((metric) => metric.delta !== 0 && (metric.higherBetter ? metric.delta > 0 : metric.delta < 0)).length
  const worsened = verdictMetrics.filter((metric) => metric.delta !== 0 && (metric.higherBetter ? metric.delta < 0 : metric.delta > 0)).length
  const verdictGood = comparisonIssues.length === 0 && improved > 0 && worsened === 0
  const action = candidateScenario.action ? candidateScenario.action as unknown as Action : undefined
  const exportImage = () => {
    const svg = comparisonSummarySvg({
      baselineId: baseline.id,
      candidateId: candidate.id,
      candidateName: action ? describeAction(action) : candidateScenario.name,
      metrics: verdictMetrics.map((metric) => ({ label: metric.label, before: metric.before, after: metric.after })),
    })
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `kaizenflow-run-${baseline.id}-vs-${candidate.id}.svg`
    anchor.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">Kiểm chứng trước và sau</h1>
          <p className="text-xs text-muted">Run #{baseline.id} làm gốc, {runRows.slice(1).map((r) => `#${r.id}`).join(', ')} là phương án thử</p>
        </div>
        <button type="button" className={btn} onClick={exportImage}><Download size={13} /> Tải ảnh tóm tắt</button>
      </div>
      <DecisionJourney active="validate" links={{ observe: `/runs/${candidate.id}`, decide: `/runs/${baseline.id}/recommendations`, report: `/runs/${candidate.id}/report` }} />
      <section className={`overflow-hidden rounded-xl border ${verdictGood ? 'border-ok/55 bg-ok/5' : 'border-warn/55 bg-warn/5'}`}>
        <div className="flex flex-wrap items-start gap-3 p-4">
          <span className={`flex h-10 w-10 flex-none items-center justify-center rounded-xl ${verdictGood ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn'}`}>
            {verdictGood ? <CheckCircle2 size={21} /> : <TriangleAlert size={21} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-wide text-muted">Kết luận kiểm chứng</div>
            <h2 className="mt-0.5 text-sm font-semibold text-text">{verdictGood ? 'Phương án cải thiện KPI chính mà không tạo đánh đổi đo được' : worsened > 0 ? 'Phương án có đánh đổi — cần kỹ sư xác nhận trước khi áp dụng thật' : 'Chưa đủ bằng chứng để kết luận phương án tốt hơn'}</h2>
            <p className="mt-1 text-[11px] text-text-2">{action ? describeAction(action) : candidateScenario.name} · {improved} KPI tốt hơn, {worsened} KPI xấu hơn.</p>
          </div>
        </div>
        <div className="grid border-t border-line sm:grid-cols-3">
          {verdictMetrics.map((metric) => {
            const good = metric.delta !== 0 && (metric.higherBetter ? metric.delta > 0 : metric.delta < 0)
            const bad = metric.delta !== 0 && !good
            return <div key={metric.key} className="border-t border-line px-4 py-3 first:border-t-0 sm:border-l sm:border-t-0 sm:first:border-l-0"><div className="text-[10px] text-muted">{metric.label}</div><div className="mt-1 text-xs text-text"><span className="text-muted">{metric.before.toFixed(1)}</span> → <b>{metric.after.toFixed(1)}</b> <span className={`ml-1 ${good ? 'text-ok' : bad ? 'text-bad-text' : 'text-muted'}`}>({metric.delta >= 0 ? '+' : ''}{metric.delta.toFixed(1)})</span></div></div>
          })}
        </div>
      </section>
      {comparisonIssues.length > 0 ? (
        <Notice tone="lock">So sánh chưa hoàn toàn cùng điều kiện: {comparisonIssues.join('; ')}. Chênh lệch có thể đến từ cấu hình hoặc ngẫu nhiên, không chỉ từ action.</Notice>
      ) : (
        <Notice>Các run dùng cùng seed {effectiveSeeds[0]}, phiên bản mô hình, mốc bắt đầu, horizon, số lần lặp và trạng thái khởi đầu; chênh lệch phù hợp để quy cho thay đổi phương án.</Notice>
      )}
      <Card title="Chỉ số (trung vị)">
        <div className="mb-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-text-2">
          Ngoài KPI mô phỏng gốc, bảng này có thêm `Giờ thiếu hàng` và `Giờ tồn dư`. Đây là tổng thời lượng cộng trên toàn bộ các kho storage, suy ra từ `coverage_h`: dưới ngưỡng đỏ là thiếu hàng, trên ngưỡng `yellow_high` là tồn dư.
        </div>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th>Chỉ số</th>
              <th className="text-right">Gốc #{baseline.id}</th>
              {runRows.slice(1).map((run, i) => <th key={run.id} className="text-right">Run #{run.id} / {scenarioRows[i + 1]?.name ?? '—'}</th>)}
            </tr>
          </thead>
          <tbody>
            {KPIS.map(([k, label, higherBetter]) => {
              const base = kpiP50(baseline.kpis, k) ?? 0
              return (
                <tr key={k} className="border-t">
                  <td className="py-1">{label}</td>
                  <td className="text-right">{base.toFixed(1)}</td>
                  {runRows.slice(1).map((run) => {
                    const val = kpiP50(run.kpis, k) ?? 0
                    const d = val - base
                    const good = higherBetter ? d > 0 : d < 0
                    return (
                      <td key={`${k}-${run.id}`} className={`text-right font-medium ${d === 0 ? '' : good ? 'text-ok' : 'text-bad-text'}`}>
                        <div>{val.toFixed(1)}</div>
                        <div className="text-[11px]">{d >= 0 ? '+' : ''}{d.toFixed(1)}</div>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {[
              { key: 'stockout', label: 'Giờ thiếu hàng', values: inventories.map((x) => x.stockoutH), higherBetter: false },
              { key: 'overstock', label: 'Giờ tồn dư', values: inventories.map((x) => x.overstockH), higherBetter: false },
            ].map((row) => {
              const base = row.values[0] ?? 0
              return (
                <tr key={row.key} className="border-t">
                  <td className="py-1">{row.label}</td>
                  <td className="text-right">{base.toFixed(1)}</td>
                  {row.values.slice(1).map((val, i) => {
                    const d = val - base
                    const good = row.higherBetter ? d > 0 : d < 0
                    return (
                      <td key={`${row.key}-${runRows[i + 1].id}`} className={`text-right font-medium ${d === 0 ? '' : good ? 'text-ok' : 'text-bad-text'}`}>
                        <div>{val.toFixed(1)}</div>
                        <div className="text-[11px]">{d >= 0 ? '+' : ''}{d.toFixed(1)}</div>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>
      <Card title="Số giờ tồn kho còn đủ dùng (p50)" actions={
        <select className="rounded border border-line-2 px-2 py-0.5 text-sm" value={subject} onChange={(e) => setFocus(e.target.value)}>
          {subjects.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>}>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
            <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={fmtTime} tick={axisTick} axisLine={axisLine} tickLine={false} />
            <YAxis unit=" h" tick={axisTick} width={52} axisLine={axisLine} tickLine={false} />
            <Tooltip {...tooltipProps} labelFormatter={(v) => fmtTime(Number(v))} />
            <Legend />
            {runRows.map((run, i) => (
              <Line
                key={run.id}
                dataKey={`run_${run.id}`}
                name={`${i === 0 ? 'Gốc' : 'PA'} #${run.id}`}
                stroke={COLORS[i % COLORS.length]}
                strokeWidth={i === 0 ? 2 : 2.4}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Card>
    </div>
  )
}
