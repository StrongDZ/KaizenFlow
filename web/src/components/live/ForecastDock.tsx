import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../../api/client'
import type { LiveSnapshot } from '../../api/types'
import { HORIZONS, buildForecastRows, levelMetrics } from '../../lib/forecastSeries'
import { statusLabel } from '../../lib/format'
import { axisLine, axisTick, tooltipProps } from '../Charts'
import { ErrorBox, btnPrimary, input } from '../ui'

const HISTORY_S = 6 * 3600
const fmtAxis = (t: number) => new Date(t).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

/**
 * Dock "Dự báo từ trạng thái live": lấy tồn kho và máy đang hỏng lúc này làm điểm xuất phát rồi mô phỏng tiếp tối đa 1 tuần.
 * Đồ thị chồng đường thực tế (từ dữ liệu live) lên dải P10–P90 của dự báo: thực tế đi ra ngoài dải nghĩa là mô hình đang lệch.
 */
export function ForecastDock({ model, snapshot, names, insetRight }: {
  model: string
  snapshot: LiveSnapshot | undefined
  names: Record<string, string>
  insetRight: number
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(true)
  const [horizon, setHorizon] = useState<number>(86400)
  const [metricId, setMetricId] = useState('')

  const metrics = useMemo(() => levelMetrics(snapshot?.subjects ?? {}, names), [snapshot, names])
  const metric = metrics.find((m) => m.id === metricId) ?? metrics[0]

  const runs = useQuery({ queryKey: ['runs', 'nowcast', model], queryFn: () => api.allRuns({ model, origin: 'NOWCAST', limit: 5 }), refetchInterval: 4000 })
  const run = runs.data?.[0]
  const scenario = useQuery({ queryKey: ['scenario', run?.scenario_id], queryFn: () => api.scenario(run!.scenario_id), enabled: !!run })
  const startMs = run ? Date.parse(run.sim_start) : undefined
  const bands = useQuery({
    queryKey: ['nowcast-bands', run?.id, metric?.subject, metric?.metric],
    queryFn: () => api.bands(run!.id, { subject: metric!.subject, metric: metric!.metric }),
    enabled: run?.status === 'DONE' && !!metric,
  })
  const actual = useQuery({
    queryKey: ['live-actual', model, metric?.subject, metric?.metric, run?.id],
    queryFn: () => api.liveSignals(model, { subject: metric!.subject, name: metric!.metric, since: new Date(startMs! - HISTORY_S * 1000).toISOString(), limit: 5000 }),
    enabled: !!metric && startMs !== undefined,
    refetchInterval: 3000,
  })
  useEffect(() => { if (run?.status === 'DONE') void qc.invalidateQueries({ queryKey: ['nowcast-bands', run.id] }) }, [run?.status, run?.id, qc])

  const go = useMutation({
    mutationFn: () => api.liveForecast(model, horizon),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['runs', 'nowcast', model] }),
  })

  const rows = useMemo(() => buildForecastRows(
    (actual.data ?? []).map((r) => ({ t: Date.parse(r.t), v: r.value })),
    (bands.data ?? []).map((b) => ({ t: Date.parse(b.t), p10: b.p10, p50: b.p50, p90: b.p90 })),
    startMs === undefined ? undefined : startMs - HISTORY_S * 1000,
  ), [actual.data, bands.data, startMs])
  const notes = ((scenario.data?.action as { live_snapshot?: { notes?: string[] } } | null)?.live_snapshot?.notes) ?? []
  const working = run && (run.status === 'QUEUED' || run.status === 'RUNNING')

  return (
    <div className="absolute bottom-3 left-3 z-10 rounded-xl border border-line bg-panel shadow-lg" style={{ right: insetRight }}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
        <button className="flex items-center gap-1 font-semibold text-text" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />} Dự báo từ trạng thái live
        </button>
        <select className={input} aria-label="Dự báo bao xa" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
          {HORIZONS.map((h) => <option key={h.s} value={h.s}>{h.label} tới</option>)}
        </select>
        <button className={btnPrimary} disabled={go.isPending || working === true} onClick={() => go.mutate()}>Dự báo từ bây giờ</button>
        {run && (
          <span className="flex items-center gap-1.5 text-muted">
            <i className={`h-1.5 w-1.5 rounded-full ${working ? 'animate-pulse bg-text' : run.status === 'DONE' ? 'bg-ok' : 'bg-bad'}`} />
            {statusLabel(run.status)}, xuất phát lúc {fmtAxis(Date.parse(run.sim_start))}
            {run.status === 'DONE' && <Link className="ml-1 underline decoration-dotted hover:text-text" to={`/runs/${run.id}`}>Mở Control Room</Link>}
          </span>
        )}
        {metrics.length > 0 && (
          <select className={`${input} ml-auto`} aria-label="Xem tồn của" value={metric?.id ?? ''} onChange={(e) => setMetricId(e.target.value)}>
            {metrics.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        )}
      </div>
      {open && (
        <div className="border-t border-line px-3 pb-3 pt-2">
          <ErrorBox error={go.error ?? (run?.status === 'FAILED' ? new Error(run.error ?? 'Lần chạy dự báo thất bại') : null)} />
          {!run ? (
            <p className="py-6 text-center text-xs text-muted">
              Bấm <b>Dự báo từ bây giờ</b>: hệ thống lấy tồn kho và các máy đang hỏng lúc này làm điểm xuất phát rồi mô phỏng tiếp. Hàng đang chờ trong máy được giả định rỗng.
            </p>
          ) : working ? (
            <p className="py-6 text-center text-xs text-muted">Đang mô phỏng… dự báo dài (vài ngày) có thể mất tới một phút.</p>
          ) : run.status === 'DONE' && metric ? (
            <>
              <div className="h-[170px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={rows}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                    <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={fmtAxis} tick={axisTick} axisLine={axisLine} tickLine={false} scale="time" />
                    <YAxis tick={axisTick} width={44} axisLine={axisLine} tickLine={false} />
                    <Tooltip {...tooltipProps} labelFormatter={(v) => fmtAxis(Number(v))} formatter={(v) => Number(v).toFixed(1)} />
                    <Area dataKey="low" stackId="b" stroke="none" fill="transparent" isAnimationActive={false} legendType="none" connectNulls />
                    <Area dataKey="range" stackId="b" stroke="none" fill="var(--color-muted)" fillOpacity={0.3} name="dải dự báo P10–P90" isAnimationActive={false} connectNulls />
                    <Line dataKey="p50" stroke="var(--color-text-2)" strokeDasharray="4 3" dot={false} name="dự báo giữa (P50)" isAnimationActive={false} connectNulls />
                    <Line dataKey="actual" stroke="var(--color-ok)" strokeWidth={2} dot={false} name="thực tế" isAnimationActive={false} connectNulls />
                    {startMs !== undefined && <ReferenceLine x={startMs} stroke="var(--color-text)" strokeDasharray="2 3" label={{ value: 'lúc dự báo', fontSize: 10, fill: 'var(--color-text-2)', position: 'insideTopRight' }} />}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
                <span><i className="mr-1 inline-block h-0.5 w-4 bg-ok align-middle" />thực tế</span>
                <span><i className="mr-1 inline-block h-2 w-4 bg-muted/40 align-middle" />dải dự báo (80% khả năng)</span>
                {notes.length > 0 && (
                  <details className="ml-auto">
                    <summary className="cursor-pointer">Điểm xuất phát của dự báo</summary>
                    <ul className="mt-1 max-h-24 list-disc space-y-0.5 overflow-y-auto pl-4">{notes.map((n) => <li key={n}>{n}</li>)}</ul>
                  </details>
                )}
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  )
}

