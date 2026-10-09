import {
  Area, CartesianGrid, ComposedChart, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { SignalRow } from '../api/types'
import { fmtTime } from '../lib/format'
import type { Point } from '../lib/replay'

export { fmtTime }

export const axisTick = { fill: 'var(--color-muted)', fontSize: 11 }
export const axisLine = { stroke: 'var(--color-line-2)' }
export const tooltipProps = {
  contentStyle: { background: 'var(--color-raised)', border: '1px solid var(--color-line-2)', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: 'var(--color-text-2)' },
  itemStyle: { color: 'var(--color-text)' },
}

export function BandChart({ points, redH, unit = ' h', height = 220, cursor }: {
  points: Point[]; redH?: number; unit?: string; height?: number; cursor?: number
}) {
  const data = points.map((p) => ({ t: p.t, base: p.p10, band: Math.max(0, p.p90 - p.p10), p50: p.p50 }))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
        <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={fmtTime} tick={axisTick} axisLine={axisLine} tickLine={false} />
        <YAxis tick={axisTick} unit={unit} width={52} axisLine={axisLine} tickLine={false} />
        <Tooltip {...tooltipProps} labelFormatter={(v) => fmtTime(Number(v))} formatter={(v) => Number(v).toFixed(2)} />
        <Area dataKey="base" stackId="b" stroke="none" fill="transparent" isAnimationActive={false} legendType="none" />
        <Area dataKey="band" stackId="b" stroke="none" fill="var(--color-muted)" fillOpacity={0.3} name="p10–p90" isAnimationActive={false} />
        <Line dataKey="p50" stroke="var(--color-text)" dot={false} name="p50" isAnimationActive={false} />
        {redH !== undefined && redH > 0 && <ReferenceLine y={redH} stroke="var(--color-bad)" strokeDasharray="4 4" />}
        {cursor !== undefined && <ReferenceLine x={cursor} stroke="var(--color-text)" />}
      </ComposedChart>
    </ResponsiveContainer>
  )
}

export type Mark = { t: number; label: string; color: string }

export function SignalChart({ rows, marks, height = 200 }: { rows: SignalRow[]; marks: Mark[]; height?: number }) {
  const data = rows.map((r) => ({ t: Date.parse(r.t), v: r.value }))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
        <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={fmtTime} tick={axisTick} axisLine={axisLine} tickLine={false} />
        <YAxis tick={axisTick} width={52} axisLine={axisLine} tickLine={false} />
        <Tooltip {...tooltipProps} labelFormatter={(v) => fmtTime(Number(v))} formatter={(v) => Number(v).toFixed(3)} />
        <Line dataKey="v" stroke="var(--color-accent)" strokeWidth={1} strokeOpacity={0.85} dot={false} isAnimationActive={false} />
        {marks.map((m) => (
          <ReferenceLine key={`${m.t}-${m.label}`} x={m.t} stroke={m.color} strokeWidth={1.5} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}
