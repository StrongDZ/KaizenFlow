import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { gaugeApi, type GaugeReading } from '../api/gauge'
import { ApiDownBanner, GaugeArea, gtButton, gtField, gtPrimary } from '../components/gauge/GaugeArea'
import { HistoryChart } from '../components/gauge/HistoryChart'
import { RoiPhoto } from '../components/gauge/RoiPhoto'
import {
  durationLabel, gapLimit, type HistoryEvent, historyEvents, type HistoryRange, historyStats, PRESETS, rangeBounds, timeLabel, toLocalInput,
} from '../lib/gaugeHistory'
import { fmtValue, unitLabel } from '../lib/gaugeView'

/** Độ dài khoảng khiến timeLabel ghi cả ngày lẫn giờ. */
const DAY_AND_CLOCK = 2 * 86_400_000

const EVENT_LABEL: Record<HistoryEvent['kind'], string> = { high: 'Vượt ngưỡng trên', low: 'Dưới ngưỡng dưới', gap: 'Không có số liệu' }

/** Ô chọn khoảng tuỳ ý: hai mốc theo giờ địa phương. */
function CustomRange({ bounds, onApply }: { bounds: { from: number; to: number }; onApply: (from: number, to: number) => void }) {
  const [from, setFrom] = useState(() => toLocalInput(bounds.from))
  const [to, setTo] = useState(() => toLocalInput(bounds.to))
  const a = Date.parse(from), b = Date.parse(to)
  const valid = Number.isFinite(a) && Number.isFinite(b) && b > a
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (valid) onApply(a, b) }}>
      <label className="flex flex-col gap-1 text-xs text-muted">Từ
        <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className={`${gtField} w-auto font-mono`} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">Đến
        <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className={`${gtField} w-auto font-mono`} />
      </label>
      <button type="submit" disabled={!valid} className={gtPrimary}>Xem</button>
      {!valid && <span className="pb-3 text-xs text-bad">Mốc "Đến" phải sau mốc "Từ".</span>}
    </form>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="flex flex-col"><dt className="text-[11px] text-faint">{label}</dt><dd className="font-mono text-sm text-text">{value}</dd></div>
}

/** Lịch sử số liệu của một máy: mỗi đồng hồ một biểu đồ, cùng một trục thời gian, kèm danh sách các lúc bất thường. */
export default function GaugeHistoryPage() {
  const machine = useParams().machine ?? ''
  const station = useQuery({ queryKey: ['gauge', 'station', machine], queryFn: () => gaugeApi.station(machine), refetchInterval: 15_000 })
  const [range, setRange] = useState<HistoryRange>({ preset: '1h' })
  const [custom, setCustom] = useState(false)
  const [hover, setHover] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])

  const preset = 'preset' in range ? PRESETS.find((p) => p.key === range.preset) : undefined
  // Khoảng tính lùi tự trôi theo thời gian; khoảng càng dài thì trôi càng thưa để không hỏi lại server liên tục.
  const bounds = rangeBounds(range, now, preset ? Math.min(Math.max(preset.ms / 240, 15_000), 300_000) : undefined)
  const span = bounds.to - bounds.from
  const gauges = useMemo(() => station.data?.gauges ?? [], [station.data])
  const histories = useQueries({
    queries: gauges.map((g) => ({
      queryKey: ['gauge', 'history', machine, g.gauge_id, bounds.from, bounds.to],
      queryFn: () => gaugeApi.history(machine, g.gauge_id, bounds.from, bounds.to),
      placeholderData: keepPreviousData, staleTime: Infinity,
    })),
  })
  const rows = gauges.map((g, i) => {
    const history = histories[i]?.data
    const gapMs = gapLimit(history?.bucket_s ?? 1, g.type)
    const limits = { min: g.min, max: g.max }
    // Dữ liệu của khoảng trước còn hiện trong lúc chờ khoảng mới: sự kiện được tính trên đúng khoảng của dữ liệu đó.
    const shown = history ? { from: Date.parse(history.from), to: Date.parse(history.to) } : bounds
    return {
      gauge: g, history, gapMs, limits, shown, error: histories[i]?.error,
      stats: historyStats(history?.points ?? []),
      events: history ? historyEvents(history.points, history.bucket_s, gapMs, limits, shown, Math.max(2 * history.bucket_s * 1000, (shown.to - shown.from) / 60)) : [],
    }
  })
  const events = rows.flatMap((r) => r.events.map((e) => ({ ...e, gauge: r.gauge }))).sort((a, b) => b.from - a.from)
  const alarms = events.filter((e) => e.kind !== 'gap').length
  const first = rows.find((r) => r.history)?.history
  const zoom = (from: number, to: number) => { setRange({ from: Math.round(from), to: Math.round(Math.max(to, from + 10_000)) }); setCustom(false) }

  const back = <Link to={`/gauge-twin/${encodeURIComponent(machine)}`} className="text-sm text-muted underline decoration-dotted hover:text-text">← Xem trực tiếp {machine}</Link>
  if (station.isPending) return <GaugeArea>{back}<p className="text-muted">Đang tải trạm {machine}…</p></GaugeArea>
  if (!station.data) return <GaugeArea>{back}<ApiDownBanner error={station.error} /></GaugeArea>

  return (
    <GaugeArea>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div>
          {back}
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Lịch sử <span className="font-mono">{machine}</span></h1>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2" role="group" aria-label="Khoảng thời gian">
          {PRESETS.map((p) => {
            const active = !custom && 'preset' in range && range.preset === p.key
            return (
              <button key={p.key} aria-pressed={active} onClick={() => { setRange({ preset: p.key }); setCustom(false) }}
                className={`min-h-11 rounded-full px-4 text-sm ${active ? 'bg-accent font-bold text-on-accent' : 'bg-panel text-text-2 hover:bg-raised'}`}>
                {p.label}
              </button>
            )
          })}
          <button aria-pressed={custom || 'from' in range} onClick={() => setCustom((v) => !v)}
            className={`min-h-11 rounded-full px-4 text-sm ${custom || 'from' in range ? 'bg-accent font-bold text-on-accent' : 'bg-panel text-text-2 hover:bg-raised'}`}>
            Tự chọn
          </button>
        </div>
      </div>

      {custom && <CustomRange key={`${bounds.from}-${bounds.to}`} bounds={bounds} onApply={(from, to) => { setRange({ from, to }); setCustom(false) }} />}

      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-muted">
        <span className="text-text-2">{timeLabel(bounds.from, DAY_AND_CLOCK)} → {timeLabel(bounds.to, DAY_AND_CLOCK)}</span>
        <span>{durationLabel(span)}</span>
        {first && <span>mỗi điểm là {durationLabel(first.bucket_s * 1000)} · {first.source === 'raw' ? 'từ từng lần đọc' : 'từ số gộp theo phút'}</span>}
        <span>{preset ? 'tự cập nhật' : 'khoảng cố định'}</span>
        <span className={alarms > 0 ? 'text-bad' : ''}>{alarms} lần vượt ngưỡng</span>
        <span className="text-faint">Kéo ngang trên biểu đồ để phóng to.</span>
      </p>

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[999_1_600px] flex-col gap-3">
          {rows.length === 0 && <p className="rounded-xl bg-panel px-5 py-8 text-center text-muted">Config của trạm này chưa khai báo đồng hồ nào.</p>}
          {rows.map(({ gauge, history, stats, events: own, limits, gapMs, shown, error }) => (
            <section key={gauge.gauge_id} className={`flex flex-col gap-2 rounded-xl border bg-panel px-4 py-3 ${own.some((e) => e.kind !== 'gap') ? 'border-bad' : 'border-panel'}`}>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="relative h-11 w-14 flex-none overflow-hidden rounded-md bg-panel-2"><RoiPhoto machine={machine} gauge={gauge} aspect={14 / 11} /></div>
                  <div className="min-w-0">
                    <h2 className="truncate font-mono text-sm">{gauge.gauge_id}</h2>
                    <p className="text-xs text-muted">{unitLabel(gauge.unit) || 'không đơn vị'}</p>
                  </div>
                </div>
                <dl className="flex flex-wrap gap-x-5 gap-y-1">
                  <Stat label="trung bình" value={stats ? fmtValue(stats.mean, gauge.type) : '—'} />
                  <Stat label="thấp nhất" value={stats ? fmtValue(stats.min, gauge.type) : '—'} />
                  <Stat label="cao nhất" value={stats ? fmtValue(stats.max, gauge.type) : '—'} />
                  <Stat label="đầu → cuối" value={stats ? `${fmtValue(stats.first, gauge.type)} → ${fmtValue(stats.last, gauge.type)}` : '—'} />
                  <Stat label="số lần đọc" value={stats ? stats.count.toLocaleString('vi-VN') : '0'} />
                </dl>
                <a href={gaugeApi.historyCsvUrl(machine, gauge.gauge_id, bounds.from, bounds.to)} className={`${gtButton} ml-auto flex items-center`} download>Tải CSV</a>
              </div>
              {error
                ? <p role="alert" className="py-6 text-center text-sm text-bad">Không lấy được lịch sử: {error instanceof Error ? error.message : String(error)}</p>
                : <HistoryChart history={history} type={gauge.type} bounds={shown} limits={limits} stats={stats} events={own} gapMs={gapMs} hover={hover} onHover={setHover} onZoom={zoom} />}
            </section>
          ))}
        </div>

        <aside className="flex min-w-0 flex-[1_1_300px] flex-col gap-2 rounded-xl bg-panel px-4 py-3 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-auto">
          <h2 className="text-sm font-bold">Sự kiện trong khoảng này <span className="font-normal text-muted">· {events.length}</span></h2>
          {events.length === 0 && <p className="py-4 text-sm text-muted">Không có lần vượt ngưỡng hay khoảng mất số liệu nào.</p>}
          <ul className="flex flex-col gap-1.5">
            {events.map((e) => (
              <li key={`${e.gauge.gauge_id}${e.kind}${e.from}`}>
                <EventButton event={e} gauge={e.gauge} span={span} onClick={() => { const pad = Math.max((e.to - e.from) * 0.5, 60_000); zoom(e.from - pad, e.to + pad) }} />
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </GaugeArea>
  )
}

function EventButton({ event, gauge, span, onClick }: { event: HistoryEvent; gauge: GaugeReading; span: number; onClick: () => void }) {
  const gap = event.kind === 'gap'
  return (
    <button onClick={onClick} title="Phóng to vào sự kiện này"
      className={`flex w-full flex-col gap-0.5 rounded-lg border-l-4 bg-raised px-3 py-2 text-left hover:bg-line ${gap ? 'border-faint' : 'border-bad'}`}>
      <span className="flex items-baseline justify-between gap-2">
        <span className={`text-sm font-bold ${gap ? 'text-text-2' : 'text-bad'}`}>{EVENT_LABEL[event.kind]}</span>
        <span className="font-mono text-xs text-muted">{durationLabel(event.to - event.from)}</span>
      </span>
      <span className="truncate font-mono text-xs text-text-2">{gauge.gauge_id}</span>
      <span className="font-mono text-xs text-muted">
        {timeLabel(event.from, span, span <= 6 * 3_600_000)} → {timeLabel(event.to, span, span <= 6 * 3_600_000)}
        {event.peak !== null && <> · {event.kind === 'high' ? 'đỉnh' : 'đáy'} {fmtValue(event.peak, gauge.type)} {unitLabel(gauge.unit)}</>}
      </span>
    </button>
  )
}
