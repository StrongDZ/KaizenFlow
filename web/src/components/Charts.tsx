import {
  Area, CartesianGrid, ComposedChart, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { SignalRow } from '../api/types'
import type { Point } from '../lib/replay'

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
}

export function BandChart({ points, redH, unit = ' h', height = 220, cursor }: {
  points: Point[]; redH?: number; unit?: string; height?: number; cursor?: number
}) {
  const data = points.map((p) => ({ t: p.t, base: p.p10, band: Math.max(0, p.p90 - p.p10), p50: p.p50 }))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={fmtTime} fontSize={11} />
        <YAxis fontSize={11} unit={unit} width={52} />
        <Tooltip labelFormatter={(v) => fmtTime(Number(v))} formatter={(v) => Number(v).toFixed(2)} />
        <Area dataKey="base" stackId="b" stroke="none" fill="transparent" isAnimationActive={false} legendType="none" />
        <Area dataKey="band" stackId="b" stroke="none" fill="#93c5fd" fillOpacity={0.5} name="p10–p90" isAnimationActive={false} />
        <Line dataKey="p50" stroke="#1d4ed8" dot={false} name="p50" isAnimationActive={false} />
        {redH !== undefined && redH > 0 && <ReferenceLine y={redH} stroke="#dc2626" strokeDasharray="4 4" />}
        {cursor !== undefined && <ReferenceLine x={cursor} stroke="#0f172a" />}
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
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={fmtTime} fontSize={11} />
        <YAxis fontSize={11} width={52} />
        <Tooltip labelFormatter={(v) => fmtTime(Number(v))} formatter={(v) => Number(v).toFixed(3)} />
        <Line dataKey="v" stroke="#7c3aed" dot={false} isAnimationActive={false} />
        {marks.map((m) => <ReferenceLine key={`${m.t}-${m.label}`} x={m.t} stroke={m.color} label={{ value: m.label, fontSize: 10, fill: m.color }} />)}
      </LineChart>
    </ResponsiveContainer>
  )
}
