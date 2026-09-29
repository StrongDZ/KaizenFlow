import { useQueries, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { axisLine, axisTick, fmtTime, tooltipProps } from '../components/Charts'
import { Card, Loading } from '../components/ui'
import { kpiP50 } from '../lib/insights'
import { clip, indexBands, series } from '../lib/replay'

const KPIS: [string, string, boolean][] = [
  ['throughput', 'Sản lượng xuất', true], ['red_minutes', 'Tổng phút Đỏ', false], ['backorder_end', 'Nợ đơn cuối kỳ', false],
]

export default function ComparePage() {
  const [params] = useSearchParams()
  const ids = [Number(params.get('a')), Number(params.get('b'))]
  const runs = useQueries({ queries: ids.map((id) => ({ queryKey: ['run', id], queryFn: () => api.run(id) })) })
  const bands = useQueries({ queries: ids.map((id) => ({ queryKey: ['bands', id, 'coverage_h'], queryFn: () => api.bands(id, { metric: 'coverage_h' }) })) })
  const scenarioB = useQuery({ queryKey: ['scenario', runs[1].data?.scenario_id], queryFn: () => api.scenario(runs[1].data!.scenario_id), enabled: !!runs[1].data })
  const [focus, setFocus] = useState('')
  if (runs.some((r) => !r.data) || bands.some((b) => !b.data)) return <Loading />
  const [a, b] = runs.map((r) => r.data!)
  const [ia, ib] = bands.map((x) => indexBands(x.data!))
  const subjects = [...ia.keys()]
  const subject = focus || a.insights.find((i) => i.kind === 'RED_RISK')?.subject_key || subjects[0] || ''
  const sa = clip(series(ia, subject, 'coverage_h'), 24)
  const sb = clip(series(ib, subject, 'coverage_h'), 24)
  const data = sa.map((p, i) => ({ t: p.t, a: p.p50, b: sb[i]?.p50 }))
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">So sánh: Run #{a.id} (gốc) vs Run #{b.id}{scenarioB.data ? ` — ${scenarioB.data.name}` : ''}</h1>
      <Card title="Chỉ số (trung vị)">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted"><tr><th>Chỉ số</th><th className="text-right">Gốc</th><th className="text-right">Mới</th><th className="text-right">Chênh</th></tr></thead>
          <tbody>
            {KPIS.map(([k, label, higherBetter]) => {
              const va = kpiP50(a.kpis, k) ?? 0
              const vb = kpiP50(b.kpis, k) ?? 0
              const d = vb - va
              const good = higherBetter ? d > 0 : d < 0
              return (
                <tr key={k} className="border-t">
                  <td className="py-1">{label}</td><td className="text-right">{va.toFixed(1)}</td><td className="text-right">{vb.toFixed(1)}</td>
                  <td className={`text-right font-medium ${d === 0 ? '' : good ? 'text-ok' : 'text-bad-text'}`}>{d >= 0 ? '+' : ''}{d.toFixed(1)}</td>
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
            <Line dataKey="a" name={`Gốc #${a.id}`} stroke="var(--color-muted)" dot={false} isAnimationActive={false} />
            <Line dataKey="b" name={`Mới #${b.id}`} stroke="var(--color-text)" dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </Card>
    </div>
  )
}
