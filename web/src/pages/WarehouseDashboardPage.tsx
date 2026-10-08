import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation } from 'react-router-dom'
import {
  Warehouse as WarehouseIcon, Boxes, TrendingUp as TrendingUpIcon, TrendingDown as TrendingDownIcon,
  AlertTriangle, Gauge, Clock, ArrowLeftRight, Package, Factory,
  ChevronDown, type LucideIcon, Truck, CheckCircle2, ClipboardList,
} from 'lucide-react'
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, Bar,
} from 'recharts'
import { api } from '../api/client'
import type {
  GraphNode, ModelSummary, WarehouseDashboardView, WarehouseAlertRow,
  WarehouseSkuRow, WarehouseSeriesEntry, PipelinePoint, InboundRow,
} from '../api/types'
import { EmptyState, ErrorBox, Loading, PageBody, PageHeader, Card, btnGhost } from '../components/ui'
import { fmtDateTime as fmtDateTimeOrig } from '../lib/format'

type Resolution = '1h' | '6h' | '1d'
const SEVERITY_SORT: Record<WarehouseAlertRow['severity'], number> = { HIGH: 0, MEDIUM: 1, LOW: 2 }
const KIND_LABEL: Record<WarehouseAlertRow['kind'], string> = {
  OVERSTOCK: 'Tồn dư', UNDERSTOCK: 'Thiếu hàng', OVERLOAD_INBOUND: 'Quá tải đầu vào',
  OVERLOAD_DEMAND: 'Nhu cầu quá lớn', SLA_BREACH: 'Vi phạm SLA',
}
const KIND_CHIP: Record<WarehouseAlertRow['kind'], string> = {
  OVERSTOCK: 'bg-warn-bg text-warn-text border-warn/40',
  UNDERSTOCK: 'bg-bad-bg text-bad-text border-bad/40',
  OVERLOAD_INBOUND: 'bg-info-bg text-info-text border-info/40',
  OVERLOAD_DEMAND: 'bg-bad-bg text-bad-text border-bad/40',
  SLA_BREACH: 'bg-warn-bg text-warn-text border-warn/40',
}
const INT_FMT = new Intl.NumberFormat('vi-VN')
function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return INT_FMT.format(Math.round(v))
}
function fmtCompact(d: Date): string {
  return d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function fmtTime(d: Date): string {
  return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
}
function fmtDate(d: Date): string {
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })
}

function skuTone(pct: number) {
  if (pct >= 88) return 'bg-bad-bg text-bad-text border-bad/40'
  if (pct >= 68) return 'bg-warn-bg text-warn-text border-warn/40'
  if (pct <= 18) return 'bg-bad-bg text-bad-text border-bad/40'
  if (pct <= 32) return 'bg-warn-bg text-warn-text border-warn/40'
  return 'bg-ok-bg text-ok-text border-ok/40'
}

function aggregateHistory(entries: WarehouseSeriesEntry[], resolution: Resolution): WarehouseSeriesEntry[] {
  if (entries.length === 0) return []
  const stepH = resolution === '1h' ? 1 : resolution === '6h' ? 6 : 24
  const out: WarehouseSeriesEntry[] = []
  for (let i = 0; i < entries.length; i += stepH) {
    const slice = entries.slice(i, i + stepH)
    const first = slice[0]!
    const last = slice.at(-1)!
    const inSum = slice.reduce((s, e) => s + (e.inbound_qty ?? 0), 0)
    const outSum = slice.reduce((s, e) => s + (e.outbound_qty ?? 0), 0)
    const avgLevel = slice.reduce((s, e) => s + e.level, 0) / slice.length
    const avgCov = slice.reduce((s, e) => s + e.coverage_h, 0) / slice.length
    out.push({
      ts_s: first.ts_s, sku: first.sku, node_key: first.node_key,
      level: Math.round(avgLevel), capacity: first.capacity, coverage_h: Math.round(avgCov * 10) / 10,
      color: first.color, inbound_qty: inSum, outbound_qty: outSum,
    })
    if (i + stepH >= entries.length) {
      out[out.length - 1]!.level = last.level
    }
  }
  return out
}

export default function WarehouseDashboardPage() {
  void useLocation()
  const modelsQ = useQuery({ queryKey: ['models'], queryFn: api.models, staleTime: 30_000 })
  const selectedModelKey = useMemo(() => {
    const m = (modelsQ.data ?? []).find((x) => x.model_key === 'bimbo-fmcg') ?? (modelsQ.data ?? [])[0]
    return m?.model_key ?? 'bimbo-fmcg'
  }, [modelsQ.data])
  const selectedVersionId = useMemo(() => {
    const m = (modelsQ.data ?? []).find((x) => x.model_key === selectedModelKey)
    return m?.latest_version_id
  }, [modelsQ.data, selectedModelKey])

  const graphQ = useQuery({
    queryKey: ['graph', selectedVersionId],
    enabled: !!selectedVersionId,
    queryFn: () => api.graph(selectedVersionId!),
    staleTime: 60_000,
  })

  const storageNodes = useMemo<GraphNode[]>(() => {
    const g = graphQ.data
    if (!g) return []
    return g.nodes.filter((n) => n.archetype === 'STORAGE' || n.key === 'SUPPLIER')
  }, [graphQ.data])
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null)
  const resolvedNodeKey = useMemo(() => {
    if (selectedNodeKey && storageNodes.some((n) => n.key === selectedNodeKey)) return selectedNodeKey
    const def = storageNodes.find((n) => n.key === 'KHO_NVL') ?? storageNodes[0]
    return def?.key ?? null
  }, [storageNodes, selectedNodeKey])
  const resolvedNode = useMemo(
    () => storageNodes.find((n) => n.key === resolvedNodeKey) ?? null,
    [storageNodes, resolvedNodeKey],
  )

  const dashboardQ = useQuery({
    queryKey: ['warehouse-dashboard', selectedModelKey, resolvedNodeKey, resolvedNode?.name],
    enabled: !!selectedModelKey && !!resolvedNodeKey && !!resolvedNode,
    queryFn: () => api.warehouseDashboard(selectedModelKey, resolvedNodeKey!, resolvedNode!.name ?? resolvedNodeKey!, 14),
    staleTime: 10_000,
  })

  const [resolution, setResolution] = useState<Resolution>('6h')
  const agg = useMemo(
    () => aggregateHistory(dashboardQ.data?.history_14d ?? [], resolution),
    [dashboardQ.data?.history_14d, resolution],
  )

  const sortedAlerts: WarehouseAlertRow[] = useMemo(() => {
    return [...(dashboardQ.data?.alerts ?? [])].sort(
      (a, b) => SEVERITY_SORT[a.severity] - SEVERITY_SORT[b.severity] || a.started_at.localeCompare(b.started_at),
    )
  }, [dashboardQ.data?.alerts])

  const isLoading = modelsQ.isLoading || graphQ.isLoading || (!!resolvedNodeKey && dashboardQ.isLoading)
  const err = modelsQ.error ?? graphQ.error ?? dashboardQ.error

  return (
    <PageBody>
      <PageHeader
        title="Kho tổng thể"
        subtitle={
          <span className="inline-flex items-center gap-2 text-xs text-muted">
            <WarehouseIcon size={12} strokeWidth={1.8} />
            Dashboard tồn kho tổng hợp: order sắp tới, lịch sử nhập/xuất, hiệu suất, cảnh báo theo độ rủi ro.
          </span>
        }
        actions={
          <Link to="/reports/warehouse" className={btnGhost}>
            <Boxes size={13} /> Điều khiển tồn kho
          </Link>
        }
      />

      {/* Sticky Selector top-[40px] — Shell header h-10 = 40px */}
      <div className="sticky top-[40px] z-30 -mx-6 mb-4 border-b border-line bg-bg/85 px-6 py-2 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-2">
          <ModelPicker models={modelsQ.data ?? []} value={selectedModelKey} disabled={modelsQ.isLoading} />
          <NodePicker nodes={storageNodes} value={resolvedNodeKey ?? ''} onChange={setSelectedNodeKey} disabled={!graphQ.data} />
          <div className="ml-auto flex items-center gap-1 rounded-lg border border-line-2 bg-panel px-2 py-1">
            {(['1h', '6h', '1d'] as Resolution[]).map((r) => (
              <button
                key={r}
                onClick={() => setResolution(r)}
                className={
                  'rounded-md px-2.5 py-1 text-[11px] font-medium tabular-nums transition ' +
                  (resolution === r
                    ? 'bg-text text-bg'
                    : 'text-muted hover:bg-panel-2 hover:text-text')
                }
              >
                {r === '1h' ? '1 giờ' : r === '6h' ? '6 giờ' : '1 ngày'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {err ? (
        <ErrorBox error={err instanceof Error ? err : new Error(String(err))} />
      ) : isLoading ? (
        <Loading />
      ) : !dashboardQ.data ? (
        <EmptyState title="Chưa có dữ liệu kho">
          Chọn mô hình và kho ở thanh trên để xem dashboard.
        </EmptyState>
      ) : (
        <DashboardContent view={dashboardQ.data} aggHistory={agg} alerts={sortedAlerts} resolution={resolution} />
      )}
    </PageBody>
  )
}

/* ——— Subcomponents ——— */

function ModelPicker({ models, value, disabled }: { models: ModelSummary[]; value: string; disabled?: boolean }) {
  return (
    <label className="inline-flex items-center gap-2 rounded-lg border border-line-2 bg-panel px-2.5 py-1.5 text-xs">
      <Factory size={12} className="text-muted" />
      <span className="text-muted">Mô hình</span>
      <select
        disabled={disabled}
        value={value}
        className="bg-transparent pr-4 text-[12px] font-medium text-text outline-none disabled:opacity-60"
        aria-label="Chọn mô hình"
      >
        {models.map((m) => (
          <option key={m.model_key} value={m.model_key}>{m.model_key} · v{m.latest_version}</option>
        ))}
        {models.length === 0 && <option value="">(đang tải)</option>}
      </select>
      <ChevronDown size={12} className="-ml-3 text-muted" />
    </label>
  )
}

function NodePicker({ nodes, value, onChange, disabled }: {
  nodes: GraphNode[]; value: string; onChange: (k: string) => void; disabled?: boolean
}) {
  return (
    <label className="inline-flex items-center gap-2 rounded-lg border border-line-2 bg-panel px-2.5 py-1.5 text-xs">
      <Package size={12} className="text-muted" />
      <span className="text-muted">Kho / Node</span>
      <select
        disabled={disabled || nodes.length === 0}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent pr-4 text-[12px] font-medium text-text outline-none disabled:opacity-60"
        aria-label="Chọn kho"
      >
        {nodes.map((n) => (
          <option key={n.key} value={n.key}>{n.name ?? n.key} ({n.key})</option>
        ))}
        {nodes.length === 0 && <option value="">(chưa có kho)</option>}
      </select>
      <ChevronDown size={12} className="-ml-3 text-muted" />
    </label>
  )
}

function DashboardContent({
  view, aggHistory, alerts, resolution,
}: {
  view: WarehouseDashboardView; aggHistory: WarehouseSeriesEntry[]; alerts: WarehouseAlertRow[]; resolution: Resolution
}) {
  const h = view.hero
  const pipeline = view.pipeline
  const tl = pipeline.timeline_h ?? []
  const demandNext8 = pipeline.totals.demand_total_horizon
  const inboundNext8 = pipeline.totals.inbound_total_horizon
  const inboundSorted: InboundRow[] = [...(pipeline.inbound ?? [])].sort(
    (a, b) => a.eta_ts.localeCompare(b.eta_ts),
  )
  const chartData = aggHistory.map((e) => {
    const d = new Date(e.ts_s * 1000)
    return {
      ts: e.ts_s,
      time: resolution === '1d' ? fmtDate(d) : resolution === '6h' && e.ts_s % (24 * 3600) === 0 ? fmtDate(d) : fmtCompact(d),
      'Tồn kho': e.level,
      'Nhập vào': e.inbound_qty ?? 0,
      'Xuất ra': e.outbound_qty ?? 0,
      capacity: e.capacity,
    }
  })

  return (
    <div className="flex flex-col gap-4">
      {/* A. Hero 8 KPI */}
      <section aria-label="Hero KPI" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <HeroCard label="TỒN TỔNG" value={fmtInt(h.on_hand_total)} unit="pallet" tone="ok" icon={Package}
          sub={fmtInt(h.capacity_total) + ' dung lượng'} />
        <HeroCard label="DUNG LƯỢNG" value={fmtInt(h.capacity_total)} unit="slot" tone="neutral" icon={Boxes}
          sub={h.fill_pct.toFixed(1) + '% đầy'} />
        <HeroCard label="FILL %" value={h.fill_pct.toFixed(1)} unit="%" tone={h.fill_pct >= 88 ? 'bad' : h.fill_pct >= 68 ? 'warn' : 'ok'} icon={Gauge}
          sub={h.fill_pct >= 88 ? 'Gần đầy — rủi ro OVERSTOCK' : h.fill_pct <= 22 ? 'Thấp — rủi ro UNDERSTOCK' : 'Trong ngưỡng an toàn'} />
        <HeroCard label="COVERAGE" value={h.coverage_remaining_h.toFixed(0)} unit="giờ" tone={h.coverage_remaining_h < 12 ? 'bad' : h.coverage_remaining_h < 24 ? 'warn' : 'ok'} icon={Clock}
          sub={'Tồn đủ ' + h.coverage_remaining_h.toFixed(0) + 'h nhu cầu'} />
        <HeroCard label="VÀO 24H" value={fmtInt(h.inbound_last_24h)} unit="pallet" tone="neutral" icon={TrendingDownIcon}
          sub="Tổng nhập 24h vừa qua" />
        <HeroCard label="RA 24H" value={fmtInt(h.outbound_last_24h)} unit="pallet" tone="neutral" icon={TrendingUpIcon}
          sub="Tổng xuất 24h vừa qua" />
        <HeroCard label="NET 24H" value={(h.net_flow_last_24h >= 0 ? '+' : '') + fmtInt(h.net_flow_last_24h)} unit="pallet"
          tone={h.net_flow_last_24h < -50 ? 'bad' : h.net_flow_last_24h > 50 ? 'warn' : 'ok'} icon={ArrowLeftRight}
          sub={h.net_flow_last_24h < 0 ? 'Tồn giảm' : h.net_flow_last_24h > 0 ? 'Tồn tăng' : 'Bằng phẳng'} />
        <HeroCard label="CẢNH BÁO CAO" value={String(h.high_alert_count)} unit="bản" tone={h.high_alert_count > 0 ? 'bad' : 'ok'} icon={AlertTriangle}
          sub={h.high_alert_count > 0 ? 'Xem Cảnh báo bên dưới' : 'Không có cảnh báo HIGH'} />
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* B. Đơn nhập sắp tới */}
        <Card title={'Nhập hàng sắp tới · ' + inboundSorted.length + ' đơn'}>
          {inboundSorted.length === 0 ? (
            <EmptyState title="Không có đơn nhập sắp tới">
              Pipeline 8h có {fmtInt(inboundNext8)} pallet dự kiến.
            </EmptyState>
          ) : (
            <div className="max-h-[380px] overflow-y-auto">
              <div className="flex flex-col divide-y divide-line">
                {inboundSorted.map((o, i) => {
                  const t = Date.parse(o.eta_ts)
                  const diffH = (t - Date.now()) / 3_600_000
                  const urgent = diffH < 6
                  return (
                    <div key={o.lot_id || i} className="flex items-start gap-3 px-1 py-2.5">
                      <div className={
                        'mt-1 h-2 w-2 flex-none rounded-full ' +
                        (urgent ? 'bg-bad animate-pulse' : 'bg-ok')
                      } />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <div className="truncate text-xs font-medium text-text">
                            {o.lot_id || 'Đơn #' + (i + 1).toString().padStart(3, '0')}
                            {o.sku && <span className="ml-1.5 rounded border border-line-2 bg-panel-2 px-1 text-[10px] text-muted">{o.sku}</span>}
                          </div>
                          <span className={'whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold border ' +
                            (urgent ? 'border-bad/40 bg-bad-bg text-bad-text' : 'border-line-2 bg-panel-2 text-muted')}>
                            {urgent ? 'GẦN' : 'SẮP'}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted tabular-nums">
                          <span>+{fmtInt(o.qty)} pallet</span>
                          <span>·</span>
                          <span>{isNaN(t) ? o.eta_ts : fmtCompact(new Date(t))}</span>
                          {o.source && <><span>·</span><span className="truncate">từ {o.source}</span></>}
                          {o.status && (
                            <>
                              <span>·</span>
                              <StatusChip status={o.status} />
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </Card>

        {/* C. Pipeline 8h tới */}
        <Card title={
          'Dòng chảy 8 giờ tới · Nhập ' + fmtInt(inboundNext8) + ' · Ra ' + fmtInt(demandNext8)
        }>
          {tl.length === 0 ? (
            <EmptyState title="Chưa có pipeline 8h" />
          ) : (
            <>
              <div className="h-[280px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={tl.map((p: PipelinePoint) => {
                    let t = p.t
                    try {
                      const d = new Date(Date.parse(p.t))
                      t = fmtTime(d)
                    } catch { /* ignore */ }
                    return {
                      time: t,
                      'Nhu cầu': p.demand,
                      'Đầu vào': p.inbound,
                      'Thiếu': Math.max(0, p.demand - p.inbound),
                    }
                  })} margin={{ top: 8, right: 10, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--line-2))" />
                    <XAxis dataKey="time" tick={{ fontSize: 10, fill: 'hsl(var(--muted))' }} />
                    <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted))' }} />
                    <Tooltip
                      contentStyle={{ fontSize: 11, borderRadius: 10, border: '1px solid hsl(var(--line-2))', background: 'hsl(var(--panel))' }}
                      labelStyle={{ fontWeight: 600, color: 'hsl(var(--text))' }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
                    <Bar dataKey="Đầu vào" stackId="in" fill="hsl(var(--ok))" radius={[4, 4, 0, 0]} opacity={0.85} />
                    <Bar dataKey="Nhu cầu" stackId="out" fill="hsl(var(--accent))" radius={[4, 4, 0, 0]} opacity={0.85} />
                    <Line type="monotone" dataKey="Thiếu" stroke="hsl(var(--bad))" strokeWidth={2} dot={{ r: 2 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 border-t border-line-2 pt-3 text-center text-[11px]">
                <div>
                  <div className="text-muted">Adequacy</div>
                  <div className="text-sm font-semibold tabular-nums">{String(pipeline.adequacy)}</div>
                </div>
                <div>
                  <div className="text-muted">Available cuối</div>
                  <div className="text-sm font-semibold tabular-nums">{fmtInt(pipeline.totals.available_final)}</div>
                </div>
                <div>
                  <div className="text-muted">Tổng thiếu 8h</div>
                  <div className={'text-sm font-semibold tabular-nums ' + (pipeline.totals.shortage_qty > 0 ? 'text-bad-text' : 'text-ok-text')}>
                    {fmtInt(pipeline.totals.shortage_qty)}
                  </div>
                </div>
              </div>
            </>
          )}
        </Card>
      </div>

      {/* D. Lịch sử 14 ngày — ComposedChart */}
      <Card title={
        'Lịch sử tồn · Nhập · Xuất (14 ngày) · độ phân giải: ' +
        (resolution === '1h' ? '1 giờ' : resolution === '6h' ? '6 giờ' : '1 ngày')
      }>
        <div className="h-[320px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="stockGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--accent))" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="hsl(var(--accent))" stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--line-2))" />
              <XAxis dataKey="time" tick={{ fontSize: 10, fill: 'hsl(var(--muted))' }} />
              <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted))' }} />
              <Tooltip
                contentStyle={{ fontSize: 11, borderRadius: 10, border: '1px solid hsl(var(--line-2))', background: 'hsl(var(--panel))' }}
                labelStyle={{ fontWeight: 600, color: 'hsl(var(--text))' }}
                formatter={(v, n) => {
                  const num = typeof v === 'number' ? v : Number(v ?? 0)
                  const label = typeof n === 'string' ? n : ''
                  const unit = label === 'Tồn kho' ? ' pallet' : ' pallet/' + (resolution === '1d' ? 'ngày' : resolution === '6h' ? '6h' : 'giờ')
                  return [fmtInt(num) + unit, label]
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
              <Area type="monotone" dataKey="Tồn kho" stroke="hsl(var(--accent))" strokeWidth={2} fill="url(#stockGrad)" />
              <Line type="monotone" dataKey="Nhập vào" stroke="hsl(var(--ok))" strokeWidth={1.8} dot={false} />
              <Line type="monotone" dataKey="Xuất ra" stroke="hsl(var(--warn))" strokeWidth={1.8} dot={false} strokeDasharray="5 3" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* E. Efficiency */}
        <Card title="Hiệu suất vận hành">
          <EfficiencyGauges view={view} />
        </Card>

        {/* F. Alerts */}
        <Card title={
          'Cảnh báo kho' + (alerts.length > 0 ? ' · ' + alerts.length : '')
        }>
          {alerts.length === 0 ? (
            <EmptyState title="Không có cảnh báo nào">
              Tồn kho và pipeline đang trong ngưỡng an toàn.
            </EmptyState>
          ) : (
            <div className="max-h-[420px] overflow-y-auto">
              <div className="flex flex-col divide-y divide-line">
                {alerts.map((a, i) => (
                  <div key={a.alert_id + i} className="flex items-start gap-3 px-1 py-3">
                    <div
                      className={'mt-0.5 h-2.5 w-2.5 flex-none rounded-full ring-2 ' +
                        (a.severity === 'HIGH' ? 'bg-bad ring-bad/20' : a.severity === 'MEDIUM' ? 'bg-warn ring-warn/20' : 'bg-ok ring-ok/20')}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold text-text">{a.title}</span>
                        <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${KIND_CHIP[a.kind]}`}>{KIND_LABEL[a.kind]}</span>
                        <span className={'rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ' +
                          (a.severity === 'HIGH' ? 'bg-bad-bg text-bad-text' : a.severity === 'MEDIUM' ? 'bg-warn-bg text-warn-text' : 'bg-ok-bg text-ok-text')}>
                          {a.severity === 'HIGH' ? 'Cao' : a.severity === 'MEDIUM' ? 'Trung bình' : 'Thấp'}
                        </span>
                      </div>
                      <p className="mt-1 text-[11.5px] text-muted">{a.detail}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[10.5px] tabular-nums text-muted">
                        <span>Hiện tại: <b className="text-text">{fmtInt(a.value_current)}</b></span>
                        <span>Ngưỡng: <b className="text-text">{fmtInt(a.value_threshold)}</b></span>
                        <span>Bắt đầu: {fmtDateTimeOrig(a.started_at)}</span>
                        {a.acknowledged && <span className="rounded border border-line-2 bg-panel-2 px-1 text-muted">đã xác nhận</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* G. Bảng SKU */}
      <Card title={'Chi tiết theo SKU · ' + view.sku_rows.length + ' SKU'}>
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-line-2 bg-panel-2/50 text-left text-[10.5px]r text-muted">
                <th className="px-3 py-2 font-semibold">SKU</th>
                <th className="px-3 py-2 text-right font-semibold">Tồn</th>
                <th className="px-3 py-2 text-right font-semibold">Max</th>
                <th className="px-3 py-2 text-right font-semibold">Fill %</th>
                <th className="px-3 py-2 w-[28%] font-semibold">Thanh tiến độ</th>
                <th className="px-3 py-2 text-right font-semibold">Coverage</th>
                <th className="px-3 py-2 text-center font-semibold">Thể loại</th>
              </tr>
            </thead>
            <tbody>
              {view.sku_rows.map((row, i) => <SkuTr key={row.sku + i} row={row} />)}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

const STATUS_META: Record<InboundRow['status'], { label: string; cls: string; Icon: LucideIcon }> = {
  IN_TRANSIT: { label: 'Đang vận chuyển', cls: 'bg-info-bg text-info-text border-info/40', Icon: Truck },
  DOCKED:     { label: 'Đã cập bến',     cls: 'bg-ok-bg text-ok-text border-ok/40',       Icon: CheckCircle2 },
  BOOKED:     { label: 'Đã đặt trước',   cls: 'bg-panel-2 text-muted border-line-2',     Icon: ClipboardList },
}
function StatusChip({ status }: { status: InboundRow['status'] }) {
  const meta = STATUS_META[status]
  const Ico = meta.Icon
  return (
    <span className={'inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-medium ' + meta.cls}>
      <Ico size={9.5} /> {meta.label}
    </span>
  )
}

function SkuTr({ row }: { row: WarehouseSkuRow }) {
  const pct = row.max > 0 ? (100 * row.current / row.max) : 0
  const tone = skuTone(pct)
  const barBg = pct >= 88 ? 'bg-bad' : pct <= 18 ? 'bg-bad' : pct >= 68 ? 'bg-warn' : pct <= 32 ? 'bg-warn' : 'bg-ok'
  return (
    <tr className="border-b border-line/70 hover:bg-panel-2/40 transition">
      <td className="px-3 py-2 font-mono text-[11.5px] font-semibold text-text">{row.sku}</td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtInt(row.current)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-muted">{fmtInt(row.max)}</td>
      <td className="px-3 py-2 text-right tabular-nums font-medium">{pct.toFixed(1)}%</td>
      <td className="px-3 py-2">
        <div className="relative h-2 overflow-hidden rounded-full bg-panel-2">
          <div
            className={`absolute inset-y-0 left-0 rounded-full ${barBg} transition-[width] duration-500`}
            style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
          />
        </div>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {row.coverageH == null || !isFinite(row.coverageH) ? '—' : row.coverageH.toFixed(0) + 'h'}
      </td>
      <td className="px-3 py-2 text-center">
        <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>
          {pct >= 88 ? 'Gần đầy' : pct <= 18 ? 'Thấp' : pct >= 68 ? 'Cao' : pct <= 32 ? 'Hơi thấp' : 'Bình thường'}
        </span>
      </td>
    </tr>
  )
}

function EfficiencyGauges({ view }: { view: WarehouseDashboardView }) {
  const e = view.efficiency
  return (
    <div className="flex flex-col gap-4">
      <EffRow label="OEE" value={e.oee_pct} goodAt={85} warnAt={70} />
      <EffRow label="Accuracy" value={e.accuracy_pct} goodAt={95} warnAt={85} />
      <EffRow label="Availability" value={e.availability_pct} goodAt={92} warnAt={80} />
      <div className="grid grid-cols-2 gap-3 border-t border-line-2 pt-3 text-[11px]">
        <div>
          <div className="text-muted">Vòng quay/ngày</div>
          <div className="text-sm font-semibold tabular-nums">{e.avg_turnover_per_day.toFixed(2)}×</div>
        </div>
        <div>
          <div className="text-muted">Fill rate TB</div>
          <div className="text-sm font-semibold tabular-nums">{e.avg_fill_rate_pct.toFixed(1)}%</div>
        </div>
        <div className="col-span-2">
          <div className="text-muted">Window đánh giá</div>
          <div className="text-sm font-semibold tabular-nums">{e.window_days} ngày gần nhất</div>
        </div>
      </div>
    </div>
  )
}

function EffRow({ label, value, goodAt, warnAt }: { label: string; value: number; goodAt: number; warnAt: number }) {
  const color = value >= goodAt ? 'bg-ok' : value >= warnAt ? 'bg-warn' : 'bg-bad'
  const colorText = value >= goodAt ? 'text-ok-text' : value >= warnAt ? 'text-warn-text' : 'text-bad-text'
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="font-medium text-text">{label}</span>
        <span className={`font-semibold tabular-nums ${colorText}`}>{value.toFixed(1)}%</span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-panel-2">
        <div className={`absolute inset-y-0 left-0 rounded-full ${color} transition-[width] duration-700`}
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  )
}

function HeroCard({
  label, value, unit, sub, tone, icon: Icon,
}: {
  label: string; value: string; unit: string; sub?: string;
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
  icon: LucideIcon;
}) {
  const toneRing =
    tone === 'ok' ? 'border-ok/30' :
    tone === 'warn' ? 'border-warn/40' :
    tone === 'bad' ? 'border-bad/40' :
    'border-line-2'
  const toneText =
    tone === 'ok' ? 'text-ok-text' :
    tone === 'warn' ? 'text-warn-text' :
    tone === 'bad' ? 'text-bad-text' :
    'text-text'
  return (
    <section className={'rounded-xl border bg-panel p-3 ' + toneRing}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] font-semiboldr text-muted">
            <Icon size={11} strokeWidth={2} /> {label}
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className={`truncate text-[20px] font-bold tabular-nums leading-tight ${toneText}`}>{value}</span>
            <span className="text-[10.5px] text-muted whitespace-nowrap">{unit}</span>
          </div>
          {sub && <div className="mt-1 text-[10.5px] text-muted leading-snug">{sub}</div>}
        </div>
      </div>
    </section>
  )
}
