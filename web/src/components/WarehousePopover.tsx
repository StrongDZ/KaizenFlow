import * as Popover from '@radix-ui/react-popover'
import { ArrowRight, Package, ShoppingCart, Truck, Warehouse as WarehouseIcon, X } from 'lucide-react'
import { Bar, BarChart, Cell, ResponsiveContainer, XAxis } from 'recharts'
import { useEffect, useMemo, type CSSProperties } from 'react'
import type { WarehouseAdequacy, WarehousePipelineView, WarehouseSkuRow } from '../api/types'
import { DEFAULT_THRESHOLDS, NO_USE_COVERAGE, colorFor } from '../lib/replay'
export type { WarehouseSkuRow } from '../api/types'

export type WarehousePopoverProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchorX: number
  anchorY: number
  title?: string
  rows: WarehouseSkuRow[]
  /** Tùy chọn: dữ liệu pipeline (Order sắp tới / Input sắp tới / Đánh giá đáp ứng).
   *  Không chuyền → Popover hiển thị như cũ (table SKU đơn thuần, backward compat). */
  pipeline?: WarehousePipelineView
  container?: HTMLElement | null
}

type CoverageColor = 'GREEN' | 'YELLOW' | 'RED' | 'NONE'

/* ─── Color helpers ───────────────────────────────────────────── */
function coverageFromFill(pct: number): CoverageColor {
  if (pct >= 92) return 'RED'
  if (pct >= 78) return 'YELLOW'
  if (pct <= 12) return 'RED'
  if (pct <= 28) return 'YELLOW'
  return 'GREEN'
}
function toneClass(color: CoverageColor): string {
  switch (color) {
    case 'GREEN':  return 'border-ok/50 bg-ok-bg text-ok-text'
    case 'YELLOW': return 'border-warn/50 bg-warn-bg text-warn-text'
    case 'RED':    return 'border-bad/50 bg-bad-bg text-bad-text'
    default:       return 'border-line-2 bg-panel text-muted'
  }
}
function adequacyColor(a: WarehouseAdequacy): string {
  if (a === 'ĐỦ HÀNG')     return 'border-ok bg-ok-bg text-ok-text'
  if (a === 'THIẾU HÀNG')   return 'border-bad bg-bad-bg text-bad-text'
  return 'border-warn bg-warn-bg text-warn-text'
}
function adequacyBarColor(a: WarehouseAdequacy): string {
  if (a === 'ĐỦ HÀNG') return 'bg-ok'
  if (a === 'THIẾU HÀNG') return 'bg-bad'
  return 'bg-warn'
}
const INBOUND_STATUS_COLOR: Record<WarehousePipelineView['inbound'][number]['status'], string> = {
  IN_TRANSIT: 'bg-info-bg text-info-text border-info/30',
  DOCKED:     'bg-ok-bg text-ok-text border-ok/30',
  BOOKED:     'bg-panel-2 text-muted border-line-2',
}
const PRIORITY_COLOR: Record<WarehousePipelineView['demand'][number]['priority'], string> = {
  LOW:      'bg-panel-2 text-muted border-line-2',
  NORMAL:   'bg-info-bg text-info-text border-info/30',
  HIGH:     'bg-warn-bg text-warn-text border-warn/30',
  CRITICAL: 'bg-bad-bg text-bad-text border-bad/40',
}

/* ─── Format helpers ──────────────────────────────────────────── */
function labelFor(color: CoverageColor, pct: number, coverageH: number | undefined): string {
  if (coverageH !== undefined) {
    if (coverageH >= NO_USE_COVERAGE) return 'không tiêu thụ'
    return `còn ${coverageH.toFixed(1).replace('.', ',')} giờ`
  }
  if (color === 'NONE') return 'chưa đo'
  return `${pct.toFixed(0)}% dung lượng`
}
function fmtNum(v: number, digits?: number): string {
  if (!Number.isFinite(v)) return '—'
  if (digits !== undefined) return v.toFixed(digits).replace('.', ',')
  if (Number.isInteger(v)) return v.toLocaleString('vi-VN')
  return v.toFixed(1).replace('.', ',')
}
function fmtTsHour(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(+d)) return iso.slice(11, 16)
  return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
}
function fmtTsDayHour(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(+d)) return iso.slice(5, 16).replace('T', ' ')
  return `${d.getDate()}/${d.getMonth() + 1} ${d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`
}

/* ─── Sub-components ──────────────────────────────────────────── */
function TotalsRow({ label, value, tone = 'default', hint }:
  { label: string; value: React.ReactNode; tone?: 'default' | 'ok' | 'warn' | 'bad'; hint?: string }) {
  const toneClassText =
    tone === 'ok'  ? 'text-ok-text'
    : tone === 'warn' ? 'text-warn-text'
    : tone === 'bad'  ? 'text-bad-text'
    : 'text-text'
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-line-2 bg-panel px-2.5 py-2">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</span>
      <span className={`text-[14px] font-semibold tabular-nums leading-tight ${toneClassText}`}>{value}</span>
      {hint && <span className="text-[10px] text-muted">{hint}</span>}
    </div>
  )
}

function PipelineBar({ data }: { data: WarehousePipelineView['timeline_h'] }) {
  if (!data || data.length === 0) return null
  const chartData = data.map((p) => ({
    t: p.t.slice(11, 13) + 'h',
    Tồn: p.on_hand,
    Vào: p.inbound,
    Ra: -p.demand,
  }))
  return (
    <div style={{ width: '100%', height: 78 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} stackOffset="sign">
          <XAxis dataKey="t" axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: 'var(--color-muted)' }} />
          <Bar dataKey="Tồn" stackId="a" radius={[0, 0, 0, 0]}>
            {chartData.map((_, i) => <Cell key={i} fill="var(--color-info)" opacity={0.55} />)}
          </Bar>
          <Bar dataKey="Vào" stackId="b" radius={[2, 2, 0, 0]}>
            {chartData.map((_, i) => <Cell key={i} fill="var(--color-ok)" opacity={0.85} />)}
          </Bar>
          <Bar dataKey="Ra" stackId="c" radius={[2, 2, 0, 0]}>
            {chartData.map((_, i) => <Cell key={i} fill="var(--color-warn)" opacity={0.85} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/* ─── Main Component ──────────────────────────────────────────── */
export function WarehousePopover({ open, onOpenChange, anchorX, anchorY, title, rows, pipeline, container }: WarehousePopoverProps) {
  const enriched = useMemo(() => {
    return rows.map((r) => {
      const pct = r.max > 0 ? Math.min(100, (r.current / r.max) * 100) : 0
      const th = r.thresholds ?? DEFAULT_THRESHOLDS
      let color: CoverageColor = 'NONE'
      if (r.coverageH !== undefined) {
        color = colorFor(r.coverageH, th)
      } else if (r.max > 0) {
        color = coverageFromFill(pct)
      }
      return { ...r, pct, color }
    })
  }, [rows])

  const anchorStyle: CSSProperties = useMemo(() => ({
    position: 'absolute',
    left: anchorX,
    top: anchorY,
    width: 0,
    height: 0,
    pointerEvents: 'none',
  }), [anchorX, anchorY])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Anchor style={anchorStyle} />
      <Popover.Portal container={container}>
        <Popover.Content
          side="right"
          sideOffset={10}
          align="start"
          collisionPadding={16}
          avoidCollisions
          className="z-[60] w-[560px] overflow-hidden rounded-xl border border-line-2 bg-raised shadow-2xl"
        >
          {/* Header */}
          <header className="flex items-center justify-between border-b border-line bg-panel px-4 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                <WarehouseIcon size={11} />
                Tình trạng kho chi tiết
                {pipeline && <span className="ml-1 rounded bg-panel-2 px-1.5 py-0.5 text-[9.5px] font-semibold">Horizon {pipeline.horizon_h}h</span>}
              </div>
              <div className="truncate text-sm font-semibold text-text">{title ?? 'Kho / Buffer'}</div>
            </div>
            <Popover.Close asChild aria-label="Đóng">
              <button className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-text">
                <X size={14} />
              </button>
            </Popover.Close>
          </header>

          <div className="max-h-[460px] overflow-y-auto">
            {/* ═══════════ PIPELINE VIEW (nếu có) ═══════════ */}
            {pipeline && (
              <div className="space-y-3 border-b border-line p-3.5">
                {/* (A) Verdict lớn + 4 KPI tổng hợp */}
                <div className="flex flex-col gap-3 rounded-xl border border-line-2 bg-panel p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-lg border px-2.5 py-1 text-[11.5px] font-bold tracking-wide ${adequacyColor(pipeline.adequacy)}`}>
                      {pipeline.adequacy}
                    </span>
                    <span className="text-[11px] text-muted">
                      Cập nhật <b className="text-text tabular-nums">{fmtTsDayHour(pipeline.as_of)}</b>
                      {' · '}node <code className="rounded bg-panel-2 px-1 py-0.5 text-[10px]">{pipeline.node_key}</code>
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <TotalsRow label="Tồn kho hiện tại" value={fmtNum(pipeline.totals.on_hand_current)} />
                    <TotalsRow label="Input sắp tới" value={`+${fmtNum(pipeline.totals.inbound_total_horizon)}`} tone="ok" hint={`${pipeline.horizon_h} giờ tới`} />
                    <TotalsRow label="Order sắp tới" value={`−${fmtNum(pipeline.totals.demand_total_horizon)}`} tone="warn" hint={`${pipeline.horizon_h} giờ tới`} />
                    {pipeline.totals.shortage_qty > 0 ? (
                      <TotalsRow
                        label="Thiếu dự kiến"
                        value={`−${fmtNum(pipeline.totals.shortage_qty)}`}
                        tone="bad"
                        hint={`Còn ${fmtNum(pipeline.totals.coverage_remaining_h, 1)} giờ`}
                      />
                    ) : (
                      <TotalsRow
                        label="Dư cuối kỳ"
                        value={`+${fmtNum(Math.max(0, pipeline.totals.available_final))}`}
                        tone="ok"
                        hint={`Còn ${fmtNum(pipeline.totals.coverage_remaining_h, 1)} giờ`}
                      />
                    )}
                  </div>

                  {/* Đáp ứng % gauge */}
                  {(() => {
                    const need = pipeline.totals.demand_total_horizon
                    const avail = pipeline.totals.on_hand_current + pipeline.totals.inbound_total_horizon
                    const pct = need > 0 ? Math.min(140, (avail / need) * 100) : 100
                    return (
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center justify-between text-[10.5px]">
                          <span className="text-muted">Khả năng đáp ứng</span>
                          <span className="font-semibold tabular-nums text-text">
                            {pct >= 100 ? '≥ 100%' : pct.toFixed(0) + '%'}
                            <span className="ml-1 text-muted">
                              ({fmtNum(avail)} / {fmtNum(need)})
                            </span>
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-panel-2">
                          <div
                            className={`h-full ${adequacyBarColor(pipeline.adequacy)} transition-[width]`}
                            style={{ width: `${Math.min(100, pct)}%` }}
                          />
                        </div>
                      </div>
                    )
                  })()}

                  {/* Stacked Bar timeline 8 giờ tới */}
                  <div className="flex items-end gap-2 rounded-lg border border-line-2 bg-panel px-2.5 pt-2 pb-1">
                    <div className="flex flex-col gap-1 text-[9.5px] text-muted leading-none pb-1">
                      <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm bg-info opacity-70" /> Tồn</span>
                      <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm bg-ok opacity-85" /> Vào</span>
                      <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm bg-warn opacity-85" /> Ra</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <PipelineBar data={pipeline.timeline_h} />
                    </div>
                  </div>
                </div>

                {/* (B) Section Input sắp tới */}
                <div className="rounded-xl border border-line-2 bg-panel overflow-hidden">
                  <header className="flex items-center justify-between gap-2 border-b border-line-2 bg-panel-2/60 px-3 py-2">
                    <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-text">
                      <Truck size={13} strokeWidth={1.9} />
                      Input sắp tới
                      <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] text-muted tabular-nums">
                        {pipeline.inbound.length} lô · +{fmtNum(pipeline.totals.inbound_total_horizon)}
                      </span>
                    </div>
                    <ArrowRight size={12} className="text-muted" />
                  </header>
                  {pipeline.inbound.length === 0 ? (
                    <div className="px-3 py-4 text-center text-[11px] text-muted">
                      Không có lô hàng nào dự kiến trong {pipeline.horizon_h} giờ tới.
                    </div>
                  ) : (
                    <table className="w-full text-[11px]">
                      <thead className="bg-panel-2/50 text-muted">
                        <tr>
                          <th className="px-3 py-1.5 text-left font-medium">ETA</th>
                          <th className="px-0 py-1.5 text-left font-medium">Lô / SKU</th>
                          <th className="px-0 py-1.5 text-right font-medium pr-3">Số lượng</th>
                          <th className="px-0 py-1.5 pr-3 text-right font-medium">Trạng thái</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pipeline.inbound.map((r) => (
                          <tr key={r.lot_id} className="border-t border-line align-middle">
                            <td className="px-3 py-1.5 tabular-nums text-text-2">{fmtTsHour(r.eta_ts)}</td>
                            <td className="px-0 py-1.5 pr-2">
                              <div className="truncate font-medium text-text">{r.sku}</div>
                              <div className="truncate text-[9.5px] text-muted">
                                <code className="rounded bg-panel-2 px-1">{r.lot_id}</code>
                                {r.source && ` · ${r.source}`}
                              </div>
                            </td>
                            <td className="px-0 py-1.5 pr-3 text-right tabular-nums font-semibold text-ok-text">+{fmtNum(r.qty)}</td>
                            <td className="px-0 py-1.5 pr-3 text-right">
                              <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${INBOUND_STATUS_COLOR[r.status]}`}>
                                {r.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* (C) Section Order sắp tới */}
                <div className="rounded-xl border border-line-2 bg-panel overflow-hidden">
                  <header className="flex items-center justify-between gap-2 border-b border-line-2 bg-panel-2/60 px-3 py-2">
                    <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-text">
                      <ShoppingCart size={13} strokeWidth={1.9} />
                      Order / Đơn hàng sắp tới
                      <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] text-muted tabular-nums">
                        {pipeline.demand.length} đơn · −{fmtNum(pipeline.totals.demand_total_horizon)}
                      </span>
                    </div>
                    <ArrowRight size={12} className="text-muted" />
                  </header>
                  {pipeline.demand.length === 0 ? (
                    <div className="px-3 py-4 text-center text-[11px] text-muted">
                      Không có đơn hàng nào cần xuất trong {pipeline.horizon_h} giờ tới.
                    </div>
                  ) : (
                    <table className="w-full text-[11px]">
                      <thead className="bg-panel-2/50 text-muted">
                        <tr>
                          <th className="px-3 py-1.5 text-left font-medium">Hạn giao</th>
                          <th className="px-0 py-1.5 text-left font-medium">Đơn / SKU</th>
                          <th className="px-0 py-1.5 text-right pr-3 font-medium">Cần xuất</th>
                          <th className="px-0 py-1.5 pr-3 text-right font-medium">Ưu tiên</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pipeline.demand.map((r) => (
                          <tr key={r.order_id} className="border-t border-line align-middle">
                            <td className="px-3 py-1.5 tabular-nums text-text-2">{fmtTsHour(r.due_ts)}</td>
                            <td className="px-0 py-1.5 pr-2">
                              <div className="truncate font-medium text-text">{r.sku}</div>
                              <div className="truncate text-[9.5px] text-muted">
                                <code className="rounded bg-panel-2 px-1">{r.order_id}</code>
                                {r.destination && ` → ${r.destination}`}
                              </div>
                            </td>
                            <td className="px-0 py-1.5 pr-3 text-right tabular-nums font-semibold text-bad-text">−{fmtNum(r.qty)}</td>
                            <td className="px-0 py-1.5 pr-3 text-right">
                              <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${PRIORITY_COLOR[r.priority]}`}>
                                {r.priority}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Tạm giải thích legend cho stacked bar */}
                <div className="rounded-lg border border-line-2 bg-panel-2/50 px-3 py-2 text-[10.5px] text-muted leading-relaxed flex items-start gap-2">
                  <Package size={12} className="mt-0.5 flex-none text-info" />
                  <span>
                    <b className="text-text-2">Cách đọc:</b> Dưới đây là <b className="text-info">tồn kho đầu kỳ</b>, cộng{' '}
                    <b className="text-ok-text">lô hàng vào (cột xanh)</b>, trừ{' '}
                    <b className="text-warn-text">đơn hàng phải xuất (cột vàng)</b> theo từng giờ. Nếu tổng tồn cuối kỳ âm (<code className="text-bad-text">net {'>'} 0 thiếu</code>) tức là{' '}
                    <b className="text-bad-text">phải thiếu hàng</b> ở giờ đó.
                  </span>
                </div>
              </div>
            )}

            {/* ═══════════ TỒN KHO CHI TIẾT THEO SKU (giữ nguyên cũ 100%) ═══════════ */}
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-raised">
                <tr className="text-left text-muted">
                  <th className="px-4 py-2 pr-3 font-medium">SKU</th>
                  <th className="px-0 py-2 pr-3 text-right font-medium">Sức chứa</th>
                  <th className="px-0 py-2 pr-3 text-right font-medium">Tồn kho</th>
                  <th className="px-0 py-2 pr-4 text-right font-medium">Tình trạng</th>
                </tr>
              </thead>
              <tbody>
                {enriched.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-muted">
                      Kho này chưa khai báo vật tư.
                    </td>
                  </tr>
                )}
                {enriched.map((r) => (
                  <tr key={r.sku} className="border-t border-line align-middle">
                    <td className="px-4 py-2 pr-3">
                      <div className="font-medium text-text">{r.sku}</div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-panel-2">
                        <div
                          className={
                            r.color === 'GREEN'
                              ? 'h-full bg-ok'
                              : r.color === 'YELLOW'
                              ? 'h-full bg-warn'
                              : r.color === 'RED'
                              ? 'h-full bg-bad'
                              : 'h-full bg-muted/40'
                          }
                          style={{ width: `${Math.min(100, r.pct)}%` }}
                        />
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted tabular-nums">{r.pct.toFixed(0)}%</div>
                    </td>
                    <td className="px-0 py-2 pr-3 tabular-nums text-right text-text">{fmtNum(r.max)}</td>
                    <td className="px-0 py-2 pr-3 tabular-nums text-right text-text">{fmtNum(r.current)}</td>
                    <td className="px-0 py-2 pr-4 text-right">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold ${toneClass(r.color)}`}
                      >
                        {labelFor(r.color, r.pct, r.coverageH)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Popover.Arrow width={14} height={7} className="fill-raised [&>path]:stroke-line-2 [&>path]:stroke-[1px]" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
