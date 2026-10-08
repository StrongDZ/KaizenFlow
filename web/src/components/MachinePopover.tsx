import * as Popover from '@radix-ui/react-popover'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { PlayCircle, RotateCw, ShoppingCart, Truck, Factory as FactoryIcon, AlertTriangle, Clock, Gauge, X } from 'lucide-react'
import { Bar, BarChart, Cell, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import type { ChainVerdict, MachinePipelineView, MachineVerdict, ProcessRecipeContract, ProcessRecipeStage } from '../api/types'

type Props = {
  open: boolean
  onOpenChange?: (o: boolean) => void
  title?: string
  anchorX?: number
  anchorY?: number
  container?: HTMLElement | null
  pipeline: MachinePipelineView
}

const MACHINE_VERDICT_COLORS: Record<MachineVerdict, { chip: string; bar: string; glow: string }> = {
  'ĐANG CHẠY':        { chip: 'bg-ok-bg text-ok-text border-ok/40',     bar: 'bg-ok',     glow: 'shadow-[0_0_0_2px_rgba(var(--color-ok-rgb)_/_0.25)]' },
  'LỖI':              { chip: 'bg-bad-bg text-bad-text border-bad/40',   bar: 'bg-bad',    glow: 'shadow-[0_0_0_2px_rgba(var(--color-bad-rgb)_/_0.25)]' },
  'CHỜ NGUYÊN LIỆU':  { chip: 'bg-info-bg text-info-text border-info/40', bar: 'bg-info',   glow: 'shadow-[0_0_0_2px_rgba(var(--color-info-rgb)_/_0.25)]' },
  'TẮC NGÕ RA':       { chip: 'bg-warn-bg text-warn-text border-warn/40', bar: 'bg-warn',   glow: 'shadow-[0_0_0_2px_rgba(var(--color-warn-rgb)_/_0.25)]' },
}

const CHAIN_VERDICT_COLORS: Record<ChainVerdict, string> = {
  'ĐỒNG BỘ TỐT': 'bg-ok-bg text-ok-text border-ok/40',
  'ĐOẠN GÃY': 'bg-bad-bg text-bad-text border-bad/40',
  'CÓ CHẶN': 'bg-warn-bg text-warn-text border-warn/40',
}
const NODE_STATUS_DOT: Record<string, string> = {
  OK: 'bg-ok',
  WARN: 'bg-warn',
  BAD: 'bg-bad',
}

const INBOUND_STATUS_CLS: Record<string, string> = {
  TRANSFER: 'bg-info-bg text-info-text border-info/40',
  WAIT_BUFFER: 'bg-ok-bg text-ok-text border-ok/40',
  ALLOCATED: 'bg-muted-bg text-text border-line',
}

const OUTPUT_PRIORITY_CLS: Record<string, string> = {
  LOW: 'bg-muted-bg text-text border-line',
  NORMAL: 'bg-info-bg text-info-text border-info/40',
  HIGH: 'bg-warn-bg text-warn-text border-warn/40',
  URGENT: 'bg-bad-bg text-bad-text border-bad/40',
}

function fmtNum(v: number, digits?: number): string {
  if (!Number.isFinite(v)) return '—'
  if (digits !== undefined) return v.toFixed(digits).replace('.', ',')
  if (Number.isInteger(v)) return v.toLocaleString('vi-VN')
  return v.toFixed(1).replace('.', ',')
}
function fmtHHMM(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}

/* ============ MachinePopover ============ */
export function MachinePopover({ open, onOpenChange, title, anchorX, anchorY, pipeline, container }: Props) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => setTick(t => t + 1), 320)
    return () => clearInterval(id)
  }, [open])

  useEffect(() => {
    if (!open || !onOpenChange) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  const anchorStyle: CSSProperties = useMemo(() => ({
    position: 'absolute',
    left: anchorX,
    top: anchorY,
    width: 0,
    height: 0,
    pointerEvents: 'none',
  }), [anchorX, anchorY])

  const verdictColor = MACHINE_VERDICT_COLORS[pipeline.verdict]
  const t = pipeline.totals
  const runPct = Math.max(1, Math.min(100, t.current_batch_pct))
  const oeePct = Math.max(1, Math.min(100, t.oee_pct))
  const recipe: ProcessRecipeContract | undefined = pipeline.recipe
  const cycleMinRemaining = recipe ? Math.max(0, Math.round(recipe.processing.cycle_time_min * (1 - runPct / 100))) : 0
  const concreteInQty = recipe?.input.qty_per_cycle ?? pipeline.current_batch?.qty_in ?? 0
  const concreteOutQty = recipe?.output.qty_per_cycle ?? pipeline.current_batch?.qty_out ?? 0
  const concreteInSku = recipe?.input.sku ?? pipeline.current_batch?.recipe_sku_in ?? ''
  const concreteOutSku = recipe?.output.sku ?? pipeline.current_batch?.recipe_sku_out ?? ''

  const currentStageIdx = useMemo(() => {
    if (!recipe) return -1
    const stages = recipe.processing.stages
    let cum = 0
    for (let i = 0; i < stages.length; i++) {
      cum += stages[i].duration_pct
      if (runPct <= cum) return i
    }
    return stages.length - 1
  }, [recipe, runPct])

  const timeline = pipeline.timeline_h.map(p => ({
    t: fmtHHMM(p.t),
    Vào: p.inbound_load,
    Xử_lý: p.run_capacity,
    Ra: p.output_load,
  }))

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
          className="z-[60] w-[620px] overflow-hidden rounded-xl border border-line-2 bg-raised shadow-2xl"
        >
          {/* Header */}
          <header className="flex items-center justify-between border-b border-line bg-panel px-4 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted">
                <FactoryIcon size={11} />
                Tình trạng máy chi tiết
                <span className="ml-1 rounded bg-panel-2 px-1.5 py-0.5 text-[9.5px] font-semibold">Horizon {pipeline.horizon_h}h</span>
              </div>
              <div className="truncate text-sm font-semibold text-text">{title ?? 'Máy xử lý'}</div>
            </div>
            <Popover.Close asChild aria-label="Đóng">
              <button className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-text">
                <X size={14} />
              </button>
            </Popover.Close>
          </header>

          <div className="max-h-[480px] space-y-3 overflow-y-auto p-4">
            {/* 1. Verdict + as_of */}
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-bold ${verdictColor.chip} ${verdictColor.glow}`}>
                {pipeline.verdict === 'ĐANG CHẠY' ? <PlayCircle size={11} />
                  : pipeline.verdict === 'LỖI' ? <AlertTriangle size={11} />
                  : pipeline.verdict === 'CHỜ NGUYÊN LIỆU' ? <Clock size={11} />
                  : <RotateCw size={11} />}
                {pipeline.verdict}
              </span>
              <span className="text-[10px] text-muted">as_of <b className="text-text">{fmtHHMM(pipeline.as_of)}</b></span>
              <code className="ml-auto rounded border border-line bg-panel-2/50 px-1.5 py-0.5 font-mono text-[10px] text-muted">{pipeline.node_key}</code>
            </div>

            {/* 2. 4 KPI Grid */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-lg border border-line-2 bg-panel px-2.5 py-2">
                <div className="flex items-center gap-1 text-[10px] text-muted"><Truck size={10} /> Input chờ trước máy</div>
                <div className="mt-1 font-mono text-lg font-bold text-info-text tabular-nums">+{fmtNum(t.input_pending_qty)}</div>
                <div className="mt-0.5 text-[9.5px] text-muted">{pipeline.input_pending.length} lô</div>
              </div>

              <div className="rounded-lg border border-line-2 bg-panel px-2.5 py-2">
                <div className="flex items-center gap-1 text-[10px] text-muted"><FactoryIcon size={10} /> Batch đang xử lý</div>
                <div className="mt-1 font-mono text-lg font-bold tabular-nums">
                  {pipeline.current_batch || recipe ? `${fmtNum(concreteInQty)} ${concreteInSku} → ${fmtNum(concreteOutQty)} ${concreteOutSku}` : '—'}
                </div>
                <div className="mt-0.5 text-[9.5px] text-muted">
                  {pipeline.current_batch ? `#${pipeline.current_batch.batch_id} · ${pipeline.current_batch.stage}`
                    : recipe ? `Chuẩn ${recipe.processing.cycle_time_min}'/lô · Hiệu suất chuẩn ${fmtNum(recipe.processing.standard_yield_pct)}%`
                    : 'Không có batch'}
                </div>
              </div>

              <div className="rounded-lg border border-line-2 bg-panel px-2.5 py-2">
                <div className="flex items-center gap-1 text-[10px] text-muted"><ShoppingCart size={10} /> Output chờ kéo đi</div>
                <div className="mt-1 font-mono text-lg font-bold text-warn-text tabular-nums">−{fmtNum(t.output_pending_qty)}</div>
                <div className="mt-0.5 text-[9.5px] text-muted">{pipeline.output_upcoming.length} lô 8h</div>
              </div>

              <div className="rounded-lg border border-line-2 bg-panel px-2.5 py-2">
                <div className="flex items-center gap-1 text-[10px] text-muted"><Gauge size={10} /> OEE 8h</div>
                <div className={`mt-1 font-mono text-lg font-bold tabular-nums ${oeePct >= 75 ? 'text-ok-text' : oeePct >= 50 ? 'text-warn-text' : 'text-bad-text'}`}>{fmtNum(oeePct)}%</div>
                <div className="mt-0.5 text-[9.5px] text-muted">
                  <span className="text-ok-text">{t.batches_done_last_8h}</span> đã làm · <span className="text-info-text">{t.batches_planned_next_8h}</span> kế
                </div>
              </div>
            </div>

            {/* 3. 2 Progress bars animated */}
            <div className="space-y-2.5">
              {/* Batch progress: animated breathing shine (nếu ĐANG CHẠY) */}
              <div>
                <div className="mb-1 flex flex-wrap items-center justify-between gap-1 text-[10.5px]">
                  <span className="flex items-center gap-1 text-muted">
                    <PlayCircle size={10} className="text-ok-text" /> Tiến độ batch
                    {concreteInQty > 0 && concreteInSku && (
                      <span className="text-text-2">
                        · Đã nhận <b className="text-info-text">{fmtNum(concreteInQty)} {concreteInSku}</b>
                        {' → '}
                        đang xử lý
                        {' → '}
                        sẽ ra <b className="text-warn-text">{fmtNum(concreteOutQty)} {concreteOutSku}</b>
                        {cycleMinRemaining > 0 && pipeline.verdict === 'ĐANG CHẠY' && (
                          <> · còn <b className="text-text">{cycleMinRemaining}'</b> xong lô</>
                        )}
                      </span>
                    )}
                  </span>
                  <b className="tabular-nums text-text">{runPct}%</b>
                </div>
                <div className={`relative h-2.5 overflow-hidden rounded-full bg-panel-2 border border-line ${pipeline.verdict === 'LỖI' ? 'opacity-60' : ''}`}>
                  <div
                    className={`h-full rounded-full ${verdictColor.bar} transition-all duration-500 ease-out`}
                    style={{ width: `${runPct}%` }}
                  >
                    {pipeline.verdict === 'ĐANG CHẠY' && (
                      <>
                        <div
                          className="absolute inset-y-0 w-1/3 -skew-x-12 bg-gradient-to-r from-transparent via-white/40 to-transparent"
                          style={{ left: `${((Date.now() / 320) % 250) - 50}%`, transition: 'left 0.32s linear' }}
                        />
                        <i
                          className="absolute right-0 top-1/2 block h-3 w-3 -translate-y-1/2 rounded-full bg-white shadow"
                          style={{ opacity: 0.45 + 0.55 * Math.abs(Math.sin(Date.now() / 420)), transition: 'opacity 0.42s' }}
                        />
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* OEE progress */}
              <div>
                <div className="mb-1 flex items-center justify-between text-[10.5px]">
                  <span className="flex items-center gap-1 text-muted"><Gauge size={10} className="text-ok-text" /> Hiệu suất OEE</span>
                  <b className="tabular-nums text-text">{oeePct}%</b>
                </div>
                <div className="relative h-2 overflow-hidden rounded-full bg-panel-2 border border-line">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${oeePct >= 75 ? 'bg-ok' : oeePct >= 50 ? 'bg-warn' : 'bg-bad'}`}
                    style={{ width: `${oeePct}%` }}
                  />
                </div>
              </div>
            </div>

            {/* 3.5 📋 CÔNG ĐOẠN & DÂY CHUYỀN SSoT */}
            {recipe && (
              <div className="rounded-xl border border-line-2 bg-gradient-to-br from-panel via-panel-2/30 to-panel px-3 py-2.5 space-y-2.5">
                <div className="flex flex-wrap items-center gap-1.5 border-b border-line-2/60 pb-1.5">
                  <span className="inline-flex items-center gap-1 rounded-md bg-info-bg/60 border border-info/30 px-1.5 py-0.5 text-[10px] font-bold text-info-text">📋 CÔNG ĐOẠN & DÂY CHUYỀN SSoT</span>
                  <code className="font-mono text-[10px] text-muted border border-line-2 bg-panel-2/60 px-1.5 py-0.5 rounded">{recipe.recipe_code}</code>
                  <span className="text-[10.5px] font-semibold text-text truncate">{recipe.recipe_name}</span>
                  <span className={`ml-auto inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${CHAIN_VERDICT_COLORS[recipe.full_chain.chain_verdict]}`}>
                    {recipe.full_chain.chain_verdict}
                  </span>
                </div>

                {/* (I) ▶️ Input Contract */}
                <div className="rounded-lg border border-info/25 bg-info-bg/20 p-2">
                  <div className="flex items-center gap-1 text-[10.5px] font-bold text-info-text mb-1.5">
                    ▶️ Input Contract · Nguyên liệu đầu vào
                  </div>
                  <div className="flex flex-wrap items-center gap-2 mb-1.5">
                    <span className="inline-flex items-center rounded-md bg-panel border border-line px-1.5 py-0.5 font-mono text-[10.5px] font-bold text-text">{recipe.input.sku}</span>
                    <span className="text-[11px] font-semibold text-text truncate">{recipe.input.sku_name}</span>
                    <span className="text-[10px] text-muted">từ <b className="text-text-2">{recipe.input.from_node_name}</b> <code className="font-mono text-[9.5px]">[{recipe.input.from_node_key}]</code></span>
                    <span className={`ml-auto text-[10px] font-semibold ${recipe.input.current_coverage_h >= 12 ? 'text-ok-text' : recipe.input.current_coverage_h >= 4 ? 'text-warn-text' : 'text-bad-text'}`}>
                      Còn phủ {fmtNum(recipe.input.current_coverage_h, 1)} giờ
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[10.5px]">
                    <div className="rounded border border-line-2 bg-panel/70 px-2 py-1">
                      <span className="text-muted">Định mức / lô: </span>
                      <b className="font-mono text-info-text tabular-nums">{fmtNum(recipe.input.qty_per_cycle)} {recipe.input.uom}</b>
                    </div>
                    <div className="rounded border border-line-2 bg-panel/70 px-2 py-1">
                      <span className="text-muted">Chu kỳ cấp: </span>
                      <b className="font-mono text-text-2 tabular-nums">{recipe.input.replenish_cycle_min} phút (= chu kỳ máy)</b>
                    </div>
                  </div>
                </div>

                {/* (II) ⚙️ Processing Contract 6 stages */}
                <div className="rounded-lg border border-ok/25 bg-ok-bg/15 p-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1 text-[10.5px] font-bold text-ok-text">
                      ⚙️ Processing Contract · 6 công đoạn chuẩn
                    </div>
                    {currentStageIdx >= 0 && (
                      <span className="text-[10px] font-semibold text-ok-text">
                        Đang ở công đoạn <b>{recipe.processing.stages[currentStageIdx].name}</b>
                      </span>
                    )}
                  </div>
                  <div className="flex w-full items-stretch gap-0.5 h-5 rounded-md overflow-hidden border border-line-2 bg-panel-2/60 mb-1.5">
                    {recipe.processing.stages.map((s: ProcessRecipeStage, i: number) => {
                      const isCurrent = i === currentStageIdx
                      const isPast = i < currentStageIdx
                      return (
                        <div
                          key={s.key}
                          className={`relative flex items-center justify-center text-[8.5px] font-bold transition-all
                            ${isCurrent ? 'bg-ok text-white shadow-[0_0_0_2px_rgba(var(--color-ok-rgb)_/_0.35)] ring-1 ring-ok/60 z-10 scale-[1.04]' 
                              : isPast ? 'bg-ok/65 text-white' 
                              : 'bg-panel text-muted border-r border-line last:border-r-0'}`}
                          style={{ width: `${s.duration_pct}%` }}
                          title={`${s.name} · ${s.duration_pct}%`}
                        >
                          <span className="truncate px-0.5">{s.name.slice(0, 3).toUpperCase()}</span>
                        </div>
                      )
                    })}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[10.5px]">
                    <div className="rounded border border-line-2 bg-panel/70 px-2 py-1">
                      <span className="text-muted">Chu kỳ chuẩn: </span>
                      <b className="font-mono text-text-2 tabular-nums">{recipe.processing.cycle_time_min} phút / lô</b>
                    </div>
                    <div className="rounded border border-line-2 bg-panel/70 px-2 py-1">
                      <span className="text-muted">Hiệu suất chuẩn (Yield): </span>
                      <b className="font-mono text-ok-text tabular-nums">{fmtNum(recipe.processing.standard_yield_pct)}%</b>
                    </div>
                  </div>
                </div>

                {/* (III) ◀️ Output Contract */}
                <div className="rounded-lg border border-warn/25 bg-warn-bg/18 p-2">
                  <div className="flex items-center gap-1 text-[10.5px] font-bold text-warn-text mb-1.5">
                    ◀️ Output Contract · Thành phẩm đầu ra
                  </div>
                  <div className="flex flex-wrap items-center gap-2 mb-1.5">
                    <span className="inline-flex items-center rounded-md bg-panel border border-line px-1.5 py-0.5 font-mono text-[10.5px] font-bold text-text">{recipe.output.sku}</span>
                    <span className="text-[11px] font-semibold text-text truncate">{recipe.output.sku_name}</span>
                    <span className="text-[10px] text-muted">tới <b className="text-text-2">{recipe.output.to_node_name}</b> <code className="font-mono text-[9.5px]">[{recipe.output.to_node_key}]</code></span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[10.5px] mb-1.5">
                    <div className="rounded border border-line-2 bg-panel/70 px-2 py-1">
                      <span className="text-muted">Ra định mức: </span>
                      <b className="font-mono text-warn-text tabular-nums">{fmtNum(recipe.output.qty_per_cycle)} {recipe.output.uom}</b>
                      <span className="text-[9px] text-muted ml-1">({fmtNum(recipe.processing.standard_yield_pct)}% × {fmtNum(recipe.input.qty_per_cycle)})</span>
                    </div>
                    <div className="rounded border border-line-2 bg-panel/70 px-2 py-1">
                      <span className="text-muted">Hao hụt tiêu chuẩn: </span>
                      <b className="font-mono text-bad-text tabular-nums">{fmtNum(recipe.output.loss_pct, 1)}%</b>
                      <span className="text-[9px] text-muted ml-1">= {fmtNum(recipe.input.qty_per_cycle - recipe.output.qty_per_cycle)} {recipe.input.uom}</span>
                    </div>
                  </div>
                  {recipe.output.downstream_depot_name && (
                    <div className="rounded-md border border-line-2 bg-panel-2/60 px-2 py-1 text-[10px] flex items-center gap-1.5">
                      <span className="text-muted">Downstream Đích cuối:</span>
                      <b className="text-text-2">{recipe.output.downstream_depot_name}</b>
                      <code className="font-mono text-[9.5px] text-muted">[{recipe.output.downstream_depot_node_key}]</code>
                      <span className="ml-auto">
                        Nợ đơn: <b className="text-ok-text">0</b>
                      </span>
                    </div>
                  )}
                </div>

                {/* (IV) 🔗 Full Chain Health End-to-end */}
                <div className="rounded-lg border border-line-2 bg-panel-2/50 p-2">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1 text-[10.5px] font-bold text-text">
                      🔗 Full Chain Health · End-to-end Nhà cung cấp → Đích
                    </div>
                    <div className="flex items-center gap-1.5">
                      <b className="font-mono text-[11px] tabular-nums text-text">{fmtNum(recipe.full_chain.chain_health_score)}%</b>
                      <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[9.5px] font-bold ${CHAIN_VERDICT_COLORS[recipe.full_chain.chain_verdict]}`}>
                        {recipe.full_chain.chain_verdict}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-1 px-1 mb-2">
                    {recipe.full_chain.upstream_nodes.map((n: any) => (
                      <div key={n.key} className="flex flex-col items-center min-w-[52px]">
                        <i className={`h-3 w-3 rounded-full ${NODE_STATUS_DOT[n.status] || 'bg-muted'} ring-2 ring-white shadow-sm`} />
                        <span className="mt-0.5 text-[8.5px] font-semibold text-muted truncate max-w-[52px]">{n.archetype === 'SUPPLIER' ? 'NCC' : n.name.slice(0, 7)}</span>
                        <span className="text-[8px] text-muted">{n.status}</span>
                      </div>
                    ))}
                    <span className="text-muted text-[11px] pb-3 flex-none">→</span>
                    <div className="flex flex-col items-center flex-none min-w-[52px]">
                      <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[9px] font-bold ${verdictColor.chip}`}>{pipeline.verdict.slice(0, 6)}</span>
                      <span className="mt-0.5 text-[8.5px] font-semibold text-text">{pipeline.node_key}</span>
                      <span className="text-[8px] text-muted">MÁY</span>
                    </div>
                    <span className="text-muted text-[11px] pb-3 flex-none">→</span>
                    {recipe.full_chain.downstream_nodes.map((n: any) => (
                      <div key={n.key} className="flex flex-col items-center min-w-[52px]">
                        <i className={`h-3 w-3 rounded-full ${NODE_STATUS_DOT[n.status] || 'bg-muted'} ring-2 ring-white shadow-sm`} />
                        <span className="mt-0.5 text-[8.5px] font-semibold text-muted truncate max-w-[52px]">{n.archetype === 'CUSTOMER' ? 'DEPOT' : n.name.slice(0, 7)}</span>
                        <span className="text-[8px] text-muted">{n.status}</span>
                      </div>
                    ))}
                  </div>
                  {recipe.full_chain.chain_blockers && recipe.full_chain.chain_blockers.length > 0 && (
                    <div className="rounded-md border border-bad/40 bg-bad-bg/30 px-2 py-1 text-[9.5px] space-y-0.5">
                      <div className="font-bold text-bad-text">🚨 Đoạn chặn trong chuỗi:</div>
                      {recipe.full_chain.chain_blockers.map((b: string, i: number) => (
                        <div key={i} className="text-bad-text-2 pl-1">· {b}</div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 4. Stacked timeline 8h */}
            <div className="rounded-lg border border-line-2 bg-panel-2/40 p-2">
              <div className="mb-1 flex items-center justify-between px-1">
                <div className="text-[10.5px] text-muted"><b className="text-text">Timeline 8 giờ</b> · Luồng Vào → Xử lý → Ra</div>
                <div className="flex items-center gap-2 text-[9.5px] text-muted">
                  <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm bg-info" /> Vào</span>
                  <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm bg-ok" /> Xử lý</span>
                  <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm bg-warn" /> Ra</span>
                </div>
              </div>
              <div className="h-[78px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={timeline} margin={{ left: -24, right: 4, top: 2, bottom: 2 }}>
                    <XAxis dataKey="t" axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: 'var(--color-muted)', dy: 2 }} />
                    <YAxis type="number" hide />
                    <Bar dataKey="Vào" stackId="v" radius={[2, 2, 0, 0]}>
                      {timeline.map((_, i) => <Cell key={`in-${i}`} fill="var(--color-info)" fillOpacity={0.78} />)}
                    </Bar>
                    <Bar dataKey="Xử_lý" stackId="v" radius={0}>
                      {timeline.map((_, i) => <Cell key={`run-${i}`} fill="var(--color-ok)" fillOpacity={0.88} />)}
                    </Bar>
                    <Bar dataKey="Ra" stackId="v" radius={[2, 2, 0, 0]}>
                      {timeline.map((_, i) => <Cell key={`out-${i}`} fill="var(--color-warn)" fillOpacity={0.82} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* 5. Input / Nguyên liệu trước máy table */}
            <div className="rounded-lg border border-line-2 bg-panel">
              <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
                <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-text">
                  <Truck size={12} className="text-info-text" /> Nguyên liệu sắp / đang chờ trước máy
                </div>
                <span className="text-[10px] text-muted">{pipeline.input_pending.length} lô · <b className="tabular-nums text-info-text">+{fmtNum(t.input_pending_qty)}</b></span>
              </div>
              <div className="max-h-44 overflow-y-auto">
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-panel-2/90 backdrop-blur text-[10px] text-muted">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium">ETA giờ</th>
                      <th className="px-2 py-1.5 text-left font-medium">Lô / SKU / Từ đâu</th>
                      <th className="px-2 py-1.5 text-right font-medium tabular-nums">Số lượng</th>
                      <th className="px-2 py-1.5 text-right font-medium">Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pipeline.input_pending.length === 0 ? (
                      <tr><td colSpan={4} className="px-2 py-3 text-center text-[10.5px] text-muted">Không có lô nào.</td></tr>
                    ) : pipeline.input_pending.map(r => (
                      <tr key={r.lot_id} className="border-t border-line-2/70">
                        <td className="px-2 py-1.5 tabular-nums text-text">{fmtHHMM(r.eta_ts)}</td>
                        <td className="px-2 py-1.5">
                          <div className="font-semibold text-text">{r.sku}</div>
                          <div className="text-[9.5px] text-muted"><code className="font-mono">{r.lot_id}</code> · từ {r.from_node || '—'}</div>
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono font-bold tabular-nums text-info-text">+ {fmtNum(r.qty)}</td>
                        <td className="px-2 py-1.5 text-right">
                          <span className={`inline-block rounded-md border px-1.5 py-0.5 text-[9.5px] font-semibold ${INBOUND_STATUS_CLS[r.status] ?? ''}`}>{r.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 6. Output / Thành phẩm sắp ra */}
            <div className="rounded-lg border border-line-2 bg-panel">
              <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
                <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-text">
                  <ShoppingCart size={12} className="text-warn-text" /> Thành phẩm sắp ra khỏi máy
                </div>
                <span className="text-[10px] text-muted">{pipeline.output_upcoming.length} lô · <b className="tabular-nums text-warn-text">−{fmtNum(
                  pipeline.output_upcoming.reduce((s, r) => s + r.qty, 0)
                )}</b> 8h tới</span>
              </div>
              <div className="max-h-44 overflow-y-auto">
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-panel-2/90 backdrop-blur text-[10px] text-muted">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium">Sẵn sàng</th>
                      <th className="px-2 py-1.5 text-left font-medium">Lô / SKU / Đi đâu</th>
                      <th className="px-2 py-1.5 text-right font-medium tabular-nums">Cần ra</th>
                      <th className="px-2 py-1.5 text-right font-medium">Ưu tiên</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pipeline.output_upcoming.length === 0 ? (
                      <tr><td colSpan={4} className="px-2 py-3 text-center text-[10.5px] text-muted">Chưa có lô nào.</td></tr>
                    ) : pipeline.output_upcoming.map(r => (
                      <tr key={r.lot_id} className="border-t border-line-2/70">
                        <td className="px-2 py-1.5 tabular-nums text-text">{fmtHHMM(r.ready_ts)}</td>
                        <td className="px-2 py-1.5">
                          <div className="font-semibold text-text">{r.sku}</div>
                          <div className="text-[9.5px] text-muted"><code className="font-mono">{r.lot_id}</code> · tới {r.to_node || '—'}</div>
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono font-bold tabular-nums text-warn-text">− {fmtNum(r.qty)}</td>
                        <td className="px-2 py-1.5 text-right">
                          <span className={`inline-block rounded-md border px-1.5 py-0.5 text-[9.5px] font-semibold ${OUTPUT_PRIORITY_CLS[r.priority] ?? ''}`}>{r.priority}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 7. Explainer */}
            <div className="flex items-start gap-1.5 rounded-md border border-line-2 bg-panel-2/60 px-2 py-1.5 text-[9.5px] leading-relaxed text-muted">
              <FactoryIcon size={11} className="mt-0.5 flex-none text-info" />
              <span>
                <b className="text-text-2">Thanh tiến độ batch</b> có hiệu ứng <b className="text-info-text">sáng di chuyển</b> + <b className="text-ok-text">chấm thở pulse</b> khi máy <b>ĐANG CHẠY</b>.
                Timeline: <span className="text-info-text">vào</span> đầu máy → <span className="text-ok-text">xử lý</span> → <span className="text-warn-text">ra</span> cuối máy.
              </span>
            </div>
          </div>

          <Popover.Arrow width={14} height={7} className="fill-raised [&>path]:stroke-line-2 [&>path]:stroke-[1px]" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
