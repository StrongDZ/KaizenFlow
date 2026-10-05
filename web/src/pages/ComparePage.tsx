import { useQueries, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { axisLine, axisTick, fmtTime, tooltipProps } from '../components/Charts'
import { Card, Loading } from '../components/ui'
import { kpiP50 } from '../lib/insights'
import { byCode, thresholdsFor } from '../lib/model'
import { clip, indexBands, NO_USE_COVERAGE, series } from '../lib/replay'

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
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">
        So sánh nhiều phương án: Run #{baseline.id} làm gốc, {runRows.slice(1).map((r) => `#${r.id}`).join(', ')} là phương án thử
      </h1>
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
