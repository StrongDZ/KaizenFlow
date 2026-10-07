import { useQuery } from '@tanstack/react-query'
import { Background, Controls, ReactFlow, ReactFlowProvider } from '@xyflow/react'
import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AlertCircle, AlertTriangle, Factory as FactoryIcon, Gauge, GitCompare, Link2, TrendingDown, TrendingUp, Warehouse as WarehouseIcon } from 'lucide-react'
import { api } from '../api/client'
import type { BeforeAfterHours, BenchmarkRating, ChainSummaryRow, ChainVerdict, Graph, MachineBatchRow, MachineInboundRow, MachineOutputRow, MachinePipelineView, MachineTimelinePoint, MachineVerdict, NodeType, PipelinePoint, ProcessRecipeContract, ProcessRecipeStage, ScenarioCompareRow, SubjectSnap, WarehouseAdequacy, WarehousePipelineView } from '../api/types'
import { FloatingPanel, PanelSection } from '../components/FloatingPanel'
import { kfEdgeTypes } from '../components/KfEdge'
import { LiveBadgeContext, kfNodeTypes } from '../components/KfNode'
import { MachinePopover } from '../components/MachinePopover'
import { WarehousePopover, type WarehouseSkuRow } from '../components/WarehousePopover'
import { DriftAlerts } from '../components/live/DriftAlerts'
import { FeedControl } from '../components/live/FeedControl'
import { ForecastDock } from '../components/live/ForecastDock'
import { IncidentPanel, type IncidentNode } from '../components/live/IncidentPanel'
import { EmptyState, Loading, btn } from '../components/ui'
import { useFeedStatus, useLive } from '../hooks/useLive'
import { useModelGraph } from '../hooks/useModelGraph'
import { useTheme } from '../hooks/useTheme'
import { cycleSeconds, travelSeconds } from '../lib/flow'
import { toFlow, type FlowNode } from '../lib/graph'
import { dotsFromRate, nodeBadge, summarize, trackPeak } from '../lib/liveFrame'
import { poolCount, thresholdsFor } from '../lib/model'

/* ─── Deterministic PRNG + mock pipeline cho kho (seed = model + node) ─── */
function hashCode(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
function mulberry32(seed: number) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function fmtISO(d: Date) { return d.toISOString() }

function buildMockPipelineForWarehouse(
  model: string,
  nodeKey: string,
  rows: WarehouseSkuRow[],
  horizon_h = 8,
  overrideSeed?: number,
): WarehousePipelineView {
  const seed = hashCode(model + '||' + nodeKey + (overrideSeed ? String(overrideSeed) : rows.map(r => `${r.sku}:${r.current}`).join('|')))
  const rand = mulberry32(seed)
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

  const on_hand = rows.reduce((s, r) => s + r.current, 0)
  // Demand trong horizon = on-hand * [0.35 .. 1.25] realistic
  const demandFactor = clamp(0.35 + rand() * 0.9, 0.35, 1.25)
  const demand_total = Math.max(rows.length * 10, Math.round(on_hand * demandFactor))
  // Inbound trong horizon = demand * [0.2 .. 1.3]
  const inboundFactor = clamp(0.2 + rand() * 1.15, 0.2, 1.3)
  const inbound_total = Math.round(demand_total * inboundFactor)

  const avail = on_hand + inbound_total
  const shortage = Math.max(0, demand_total - avail)
  const coverageH = demand_total > 0 ? (avail / (demand_total / horizon_h)) : 99

  let adequacy: WarehouseAdequacy
  const need = demand_total
  if (need <= 0) adequacy = 'ĐỦ HÀNG'
  else {
    const pct = avail / need
    adequacy = pct >= 1.0 ? 'ĐỦ HÀNG' : pct >= 0.75 ? 'CẢNH BÁO' : 'THIẾU HÀNG'
  }

  const now = new Date()
  const skus = rows.length > 0 ? rows.map(r => r.sku) : ['SKU-A', 'SKU-B', 'SKU-C']
  const randSku = () => skus[Math.floor(rand() * skus.length)]

  /* Inbound rows (2-6 lô) */
  const inboundCount = 2 + Math.floor(rand() * 5)
  const inbound: WarehousePipelineView['inbound'] = []
  let inboundSum = 0
  const statuses: WarehousePipelineView['inbound'][number]['status'][] = ['IN_TRANSIT', 'DOCKED', 'BOOKED', 'IN_TRANSIT']
  const sources = ['Nhà cung cấp Nam', 'DC miền Trung', 'Nhà máy A', 'Kho nguyên liệu', 'Nhà cung cấp Bắc']
  for (let i = 0; i < inboundCount; i++) {
    const isLast = i === inboundCount - 1
    const remaining = Math.max(0, inbound_total - inboundSum)
    const qty = isLast ? remaining : Math.max(10, Math.round(remaining * (0.18 + rand() * 0.35)))
    inboundSum += qty
    const etaOffset = 0.5 + rand() * (horizon_h - 0.5)
    const eta = new Date(now.getTime() + etaOffset * 3_600_000)
    inbound.push({
      lot_id: `IN-${String(overrideSeed ?? seed % 9000).padStart(4, '0')}${String(i + 1)}`,
      eta_ts: fmtISO(eta),
      qty,
      sku: randSku(),
      source: sources[Math.floor(rand() * sources.length)],
      status: statuses[Math.floor(rand() * statuses.length)],
    })
  }

  /* Demand rows (3-7 đơn) */
  const demandCount = 3 + Math.floor(rand() * 5)
  const demand: WarehousePipelineView['demand'] = []
  let demandSum = 0
  const priorities: WarehousePipelineView['demand'][number]['priority'][] = ['LOW', 'NORMAL', 'NORMAL', 'HIGH', 'CRITICAL']
  const destinations = ['Điểm bán A', 'Retailer #03', 'Depot Sài Gòn', 'Showroom HN', 'Khách hàng B2B']
  for (let i = 0; i < demandCount; i++) {
    const isLast = i === demandCount - 1
    const remaining = Math.max(0, demand_total - demandSum)
    const qty = isLast ? remaining : Math.max(8, Math.round(remaining * (0.12 + rand() * 0.3)))
    demandSum += qty
    const dueOffset = 0.3 + rand() * (horizon_h - 0.3)
    const due = new Date(now.getTime() + dueOffset * 3_600_000)
    demand.push({
      order_id: `SO-${String((overrideSeed ?? seed % 9000) + i * 7).padStart(5, '0')}`,
      due_ts: fmtISO(due),
      qty,
      sku: randSku(),
      destination: destinations[Math.floor(rand() * destinations.length)],
      priority: priorities[Math.floor(rand() * priorities.length)],
    })
  }

  /* Timeline 8 giờ: phân bổ inbound/demand đều → tính net từng giờ */
  const timeline_h: PipelinePoint[] = []
  let oh = on_hand
  const inPerHour = inbound_total / horizon_h
  const dePerHour = demand_total / horizon_h
  for (let h = 0; h < horizon_h; h++) {
    const t = new Date(now.getTime() + h * 3_600_000)
    const inH = Math.round(inPerHour * (0.8 + rand() * 0.45))
    const deH = Math.round(dePerHour * (0.7 + rand() * 0.55))
    oh = oh + inH - deH
    const net = inH - deH
    timeline_h.push({
      t: fmtISO(t),
      on_hand: Math.max(0, oh),
      inbound: inH,
      demand: deH,
      net,
    })
  }

  return {
    node_key: nodeKey,
    horizon_h,
    as_of: fmtISO(now),
    totals: {
      on_hand_current: on_hand,
      inbound_total_horizon: inboundSum,
      demand_total_horizon: demandSum,
      available_final: on_hand + inboundSum - demandSum,
      shortage_qty: Math.max(0, shortage),
      coverage_remaining_h: Number(coverageH.toFixed(1)),
    },
    adequacy,
    inbound,
    demand,
    timeline_h,
  }
}

/* ─── Deterministic mock pipeline cho MÁY (PROCESS archetype) ─── */
function buildMockPipelineForMachine(
  model: string,
  nodeKey: string,
  nodeName: string,
  graph: Graph,
  horizon_h = 8,
  overrideSeed?: number,
): MachinePipelineView {
  const seed = hashCode(model + '|proc|' + nodeKey + (overrideSeed ? String(overrideSeed) : nodeName))
  const rand = mulberry32(seed)
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  const now = new Date()

  // Tìm upstream (node phía trước = input) & downstream (node phía sau = output) trong graph edges
  const upstreamNodeKeys = graph.edges.filter(e => e.dst === nodeKey).map(e => e.src)
  const downstreamNodeKeys = graph.edges.filter(e => e.src === nodeKey).map(e => e.dst)
  const upstreamNames = upstreamNodeKeys.map(k => graph.nodes.find(n => n.key === k)?.name || k).slice(0, 5)
  const downstreamNames = downstreamNodeKeys.map(k => graph.nodes.find(n => n.key === k)?.name || k).slice(0, 5)

  // Random SKU in/out theo tên máy deterministic
  const skuA = `MAT-${nodeKey.split('_').slice(-1)[0] || 'A'}`
  const skuB = `FG-${nodeKey.split('_').slice(-1)[0] || 'X'}`

  // Tổng lượng input chờ trước máy (đơn vị)
  const input_pending_qty = Math.round(80 + rand() * 620)
  // Output chờ sau máy chưa được kéo đi
  const output_pending_qty = Math.round(30 + rand() * 380)
  // Batches hoàn thành 8h gần đây & kế hoạch 8h tới
  const batches_done_last_8h = 3 + Math.floor(rand() * 8)
  const batches_planned_next_8h = 3 + Math.floor(rand() * 9)

  // Đánh giá verdict máy: 4 mức dựa vào input/output ratio + incident random (seed)
  const hasIncident = rand() < 0.07
  const inputStarved = input_pending_qty < 120 && rand() < 0.35
  const outputBlocked = output_pending_qty > 360 && rand() < 0.3
  let verdict: MachineVerdict
  if (hasIncident) verdict = 'LỖI'
  else if (inputStarved) verdict = 'CHỜ NGUYÊN LIỆU'
  else if (outputBlocked) verdict = 'TẮC NGÕ RA'
  else verdict = 'ĐANG CHẠY'

  // OEE: Đang chạy 82-96%, Chờ VL 40-70%, Tắc 55-75%, Lỗi 5-25%
  const oee_pct = verdict === 'ĐANG CHẠY' ? Math.round(82 + rand() * 14)
    : verdict === 'CHỜ NGUYÊN LIỆU' ? Math.round(40 + rand() * 30)
    : verdict === 'TẮC NGÕ RA' ? Math.round(55 + rand() * 20)
    : Math.round(5 + rand() * 20)

  // Progress batch hiện tại: nếu Lỗi thì 0%, Đang chạy 20-92%
  const current_batch_pct = verdict === 'LỖI' ? 0 : Math.round(20 + rand() * 72)

  /* Current batch đang xử lý (nếu không Lỗi) */
  const current_batch: MachineBatchRow | null = verdict === 'LỖI' ? null : (() => {
    const startOffset = -(0.2 + rand() * 1.5) // bắt đầu 0.2-1.7 giờ trước
    const cycleH = 0.5 + rand() * 1.2 // 30-102 phút/batch
    const start = new Date(now.getTime() + startOffset * 3_600_000)
    const end = new Date(start.getTime() + cycleH * 3_600_000)
    const qtyIn = Math.round(150 + rand() * 450)
    const yieldRatio = clamp(0.86 + rand() * 0.12, 0.8, 1.0)
    const qtyOut = Math.round(qtyIn * yieldRatio)
    const elapsed = (now.getTime() - start.getTime()) / (end.getTime() - start.getTime())
    const pct = clamp(Math.round(elapsed * 100), 1, current_batch_pct)
    const stage: MachineBatchRow['stage'] = elapsed < 0.08 ? 'QUEUED' : elapsed >= 0.92 ? 'FINALIZING' : 'RUNNING'
    return {
      batch_id: `B-${nodeKey.slice(0, 2).toUpperCase()}-${String(seed % 9000).padStart(4, '0')}`,
      recipe_sku_in: skuA,
      qty_in: qtyIn,
      recipe_sku_out: skuB,
      qty_out: qtyOut,
      start_ts: fmtISO(start),
      end_ts: fmtISO(end),
      progress_pct: pct,
      stage,
    }
  })()

  /* Input pending 2-7 lô đang chờ trước máy */
  const inCount = 2 + Math.floor(rand() * 6)
  const input_pending: MachineInboundRow[] = []
  let inSum = 0
  const inStatuses: MachineInboundRow['status'][] = ['TRANSFER', 'WAIT_BUFFER', 'ALLOCATED', 'WAIT_BUFFER']
  const fromFallback = ['Kho nguyên liệu', 'Kho trung tâm FMCG', 'Nhà cung cấp Nam', 'Buffer đầu máy']
  for (let i = 0; i < inCount; i++) {
    const isLast = i === inCount - 1
    const remaining = Math.max(0, input_pending_qty - inSum)
    const qty = isLast ? remaining : Math.max(20, Math.round(remaining * (0.15 + rand() * 0.4)))
    inSum += qty
    const eta = new Date(now.getTime() + (0.1 + rand() * (horizon_h - 0.1)) * 3_600_000)
    input_pending.push({
      lot_id: `RL-${String((seed % 9000) + i * 3).padStart(4, '0')}`,
      eta_ts: fmtISO(eta),
      qty,
      sku: skuA,
      from_node: (upstreamNames[i] || fromFallback[i % fromFallback.length]) as string,
      status: inStatuses[Math.floor(rand() * inStatuses.length)],
    })
  }

  /* Output upcoming 2-8 lots sắp ra khỏi máy */
  const outCount = 2 + Math.floor(rand() * 7)
  const output_upcoming: MachineOutputRow[] = []
  let outSum = 0
  const outPriorities: MachineOutputRow['priority'][] = ['LOW', 'NORMAL', 'NORMAL', 'HIGH', 'URGENT']
  const toFallback = ['Kho thành phẩm A', 'Kho thành phẩm B', 'Depot xuất', 'Buffer sau máy']
  for (let i = 0; i < outCount; i++) {
    const isLast = i === outCount - 1
    // Tổng ra 8h = (output_pending + batches_planned * avg_qty_out)
    const totalOutPlan = output_pending_qty + batches_planned_next_8h * Math.round(180 + rand() * 120)
    const remaining = Math.max(0, totalOutPlan - outSum)
    const qty = isLast ? remaining : Math.max(30, Math.round(remaining * (0.12 + rand() * 0.38)))
    outSum += qty
    const ready = new Date(now.getTime() + (0.05 + i * 0.9 + rand() * 0.7) * 3_600_000)
    output_upcoming.push({
      lot_id: `OUT-${String((seed % 8000) + i * 11).padStart(4, '0')}`,
      ready_ts: fmtISO(ready),
      qty,
      sku: skuB,
      to_node: (downstreamNames[i] || toFallback[i % toFallback.length]) as string,
      priority: outPriorities[Math.floor(rand() * outPriorities.length)],
    })
  }

  /* Timeline 8 giờ (input_load / run_capacity / output_load / queue_after) */
  const timeline_h: MachineTimelinePoint[] = []
  const maxRunPerH = 60 + Math.round(rand() * 90)
  for (let h = 0; h < horizon_h; h++) {
    const t = new Date(now.getTime() + h * 3_600_000)
    const runFactor = verdict === 'LỖI' ? (h === 0 ? 0.05 : 0.15 + rand() * 0.25)
      : verdict === 'CHỜ NGUYÊN LIỆU' ? 0.25 + rand() * 0.45
      : verdict === 'TẮC NGÕ RA' ? 0.35 + rand() * 0.4
      : 0.82 + rand() * 0.18
    const run = Math.round(maxRunPerH * runFactor)
    const inboundLoad = Math.round(run * (0.7 + rand() * 0.85))
    const outputLoad = Math.round(run * (0.68 + rand() * 0.6))
    const queue = clamp(h === 0 ? input_pending_qty : timeline_h[h - 1].queue_after + inboundLoad - run, 0, 2500)
    timeline_h.push({
      t: fmtISO(t),
      inbound_load: inboundLoad,
      run_capacity: run,
      output_load: outputLoad,
      queue_after: queue,
    })
  }

  return {
    node_key: nodeKey,
    horizon_h,
    as_of: fmtISO(now),
    totals: {
      input_pending_qty,
      current_batch_pct,
      output_pending_qty,
      oee_pct,
      batches_done_last_8h,
      batches_planned_next_8h,
    },
    verdict,
    input_pending,
    current_batch,
    output_upcoming,
    timeline_h,
    recipe: buildMockRecipeForMachine(model, nodeKey, nodeName, graph, verdict, overrideSeed),
  }
}

/* ─── Recipe SSoT cho từng máy (Input / Processing / Output Contract) ─── */
const CHAIN_BINDINGS: Record<string, {
  chain_id: string; chain_name: string
  input: { sku: string; sku_name: string }
  output: { sku: string; sku_name: string; fg_suffix: string; depot_suffix: string }
  cycle_min: number; std_yield: number
  supplier_name: string; dc_name: string
}> = {
  PACK_A: { chain_id: 'CHAIN_A', chain_name: 'Dây 1 · Loại 1 (Thượng hạng)', input: { sku: 'BIMBO-01', sku_name: 'Nguyên liệu thô loại 1' }, output: { sku: 'CASE-01', sku_name: 'Thành phẩm đóng hộp 12 vỉ Loại 1', fg_suffix: 'A', depot_suffix: 'A' }, cycle_min: 52, std_yield: 92.4, supplier_name: 'Nhà cung cấp FMCG SUP_FMCG', dc_name: 'Kho trung tâm FMCG DC_MAIN' },
  PACK_B: { chain_id: 'CHAIN_B', chain_name: 'Dây 2 · Loại 2 (Tiêu chuẩn)', input: { sku: 'BIMBO-02', sku_name: 'Nguyên liệu thô loại 2' }, output: { sku: 'CASE-02', sku_name: 'Thành phẩm đóng hộp 10 vỉ Loại 2', fg_suffix: 'B', depot_suffix: 'B' }, cycle_min: 62, std_yield: 90.5, supplier_name: 'Nhà cung cấp FMCG SUP_FMCG', dc_name: 'Kho trung tâm FMCG DC_MAIN' },
  PACK_C: { chain_id: 'CHAIN_C', chain_name: 'Dây 3 · Loại 3 (Tiết kiệm)', input: { sku: 'BIMBO-03', sku_name: 'Nguyên liệu thô loại 3' }, output: { sku: 'CASE-03', sku_name: 'Thành phẩm đóng hộp 8 vỉ Loại 3', fg_suffix: 'C', depot_suffix: 'C' }, cycle_min: 48, std_yield: 93.3, supplier_name: 'Nhà cung cấp FMCG SUP_FMCG', dc_name: 'Kho trung tâm FMCG DC_MAIN' },
}

function buildMockRecipeForMachine(
  model: string,
  nodeKey: string,
  nodeName: string,
  graph: Graph,
  machineVerdict: MachineVerdict,
  overrideSeed?: number,
): ProcessRecipeContract | undefined {
  const bind = CHAIN_BINDINGS[nodeKey]
  if (!bind) return undefined
  const seed = hashCode(model + '|recipe|' + nodeKey + (overrideSeed ?? nodeName))
  const rand = mulberry32(seed)
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

  const qtyPerCycle = Math.round(450 + rand() * 150)
  const replenishMin = bind.cycle_min
  const lossPct = clamp(+((100 - bind.std_yield).toFixed(1)), 3.5, 12.0)
  const qtyOutPerCycle = Math.round(qtyPerCycle * bind.std_yield / 100)
  const currentCoverageH = clamp(20 + rand() * 25, 3.5, 48)

  const stages: ProcessRecipeStage[] = [
    { key: 'recv', name: 'Nhận & cân nguyên liệu', duration_pct: 12 },
    { key: 'prep', name: 'Chuẩn bị trộn', duration_pct: 18 },
    { key: 'proc', name: nodeName, duration_pct: 38 },
    { key: 'pack', name: 'Đóng gói & dán tem', duration_pct: 16 },
    { key: 'qc', name: 'Kiểm tra chất lượng', duration_pct: 10 },
    { key: 'ship', name: 'Xuất kho thành phẩm', duration_pct: 6 },
  ]

  // SUP + DC upstream; FG_* + SHIP_* downstream
  const supNode = graph.nodes.find(n => n.archetype === 'SUPPLIER')
  const dcNode = graph.nodes.find(n => n.key === 'DC_MAIN') || graph.nodes.find(n => n.archetype === 'STORAGE' && n.key.startsWith('DC'))
  const fgNode = graph.nodes.find(n => n.key === 'FG_' + bind.output.fg_suffix)
  const depotNode = graph.nodes.find(n => n.key === 'SHIP_' + bind.output.depot_suffix) || graph.nodes.find(n => n.archetype === 'CUSTOMER')

  // Chaining health: máy verdict = LỖI → ĐOẠN GÃY; CHỜ VL / TẮC → CÓ CHẶN; ĐANG CHẠY → ĐỒNG BỘ TỐT (nếu FG coverage ≥12h)
  const fgCoverageOk = currentCoverageH >= 12
  let chainVerdict: ChainVerdict = 'ĐỒNG BỘ TỐT'
  const blockers: string[] = []
  if (machineVerdict === 'LỖI') { chainVerdict = 'ĐOẠN GÃY'; blockers.push(`${nodeName} đang LỖI → dừng toàn dây`) }
  else if (machineVerdict === 'CHỜ NGUYÊN LIỆU') { chainVerdict = 'CÓ CHẶN'; blockers.push(`${nodeName} CHỜ NGUYÊN LIỆU từ ${bind.dc_name}`) }
  else if (machineVerdict === 'TẮC NGÕ RA') { chainVerdict = 'CÓ CHẶN'; blockers.push(`${nodeName} TẮC NGÕ RA → ${fgNode?.name ?? 'Kho thành phẩm'} đầy chưa kéo đi`) }
  else if (!fgCoverageOk) { chainVerdict = 'CÓ CHẶN'; blockers.push(`Kho thành phẩm ${fgNode?.name ?? bind.output.fg_suffix} sắp hết hàng (${currentCoverageH.toFixed(1)}h)`) }
  const healthScore = chainVerdict === 'ĐỒNG BỘ TỐT' ? clamp(88 + rand() * 12, 88, 100) : chainVerdict === 'CÓ CHẶN' ? clamp(45 + rand() * 28, 40, 74) : clamp(5 + rand() * 20, 5, 28)

  const upStatusBad = (s: string) => s === 'BAD' ? 'BAD' : s === 'WARN' ? 'WARN' : 'OK'
  const downStatus = machineVerdict === 'ĐANG CHẠY' ? 'OK' : (machineVerdict === 'LỖI' ? 'BAD' : 'WARN')

  return {
    node_key: nodeKey,
    recipe_code: `RCP-${nodeKey}-001`,
    recipe_name: `${bind.chain_name} · Công đoạn ${nodeName} (từ ${bind.input.sku} → ${bind.output.sku})`,
    input: {
      sku: bind.input.sku,
      sku_name: bind.input.sku_name,
      from_node_key: dcNode?.key ?? 'DC_MAIN',
      from_node_name: dcNode?.name ?? bind.dc_name,
      qty_per_cycle: qtyPerCycle,
      replenish_cycle_min: replenishMin,
      uom: 'đơn vị',
      current_coverage_h: +currentCoverageH.toFixed(1),
    },
    processing: {
      cycle_time_min: bind.cycle_min,
      standard_yield_pct: bind.std_yield,
      stages,
    },
    output: {
      sku: bind.output.sku,
      sku_name: bind.output.sku_name,
      to_node_key: fgNode?.key ?? ('FG_' + bind.output.fg_suffix),
      to_node_name: fgNode?.name ?? ('Kho thành phẩm ' + bind.output.fg_suffix),
      qty_per_cycle: qtyOutPerCycle,
      loss_pct: lossPct,
      uom: 'đơn vị',
      downstream_depot_node_key: depotNode?.key,
      downstream_depot_name: depotNode?.name ?? ('Depot ' + bind.output.depot_suffix),
    },
    full_chain: {
      upstream_nodes: [
        { key: supNode?.key ?? 'SUP_FMCG', name: supNode?.name ?? bind.supplier_name, archetype: 'SUPPLIER', status: upStatusBad(machineVerdict === 'LỖI' ? 'BAD' : 'OK') },
        { key: dcNode?.key ?? 'DC_MAIN', name: dcNode?.name ?? bind.dc_name, archetype: 'STORAGE', status: upStatusBad(machineVerdict === 'CHỜ NGUYÊN LIỆU' ? 'WARN' : 'OK') },
      ],
      downstream_nodes: [
        { key: fgNode?.key ?? ('FG_' + bind.output.fg_suffix), name: fgNode?.name ?? ('Kho thành phẩm ' + bind.output.fg_suffix), archetype: 'STORAGE', status: downStatus },
        { key: depotNode?.key ?? ('SHIP_' + bind.output.depot_suffix), name: depotNode?.name ?? ('Depot ' + bind.output.depot_suffix), archetype: 'CUSTOMER', status: healthScore >= 75 ? 'OK' : healthScore >= 40 ? 'WARN' : 'BAD' },
      ],
      chain_health_score: +healthScore.toFixed(0),
      chain_verdict: chainVerdict,
      chain_blockers: blockers,
    },
  }
}

function buildMockChainsOverview(
  model: string,
  graph: Graph,
  processPipelines: Map<string, MachinePipelineView>,
): ChainSummaryRow[] {
  const rows: ChainSummaryRow[] = []
  for (const nodeKey of Object.keys(CHAIN_BINDINGS)) {
    const bind = CHAIN_BINDINGS[nodeKey]
    const pipeline = processPipelines.get(nodeKey)
    const recipe = pipeline?.recipe ?? buildMockRecipeForMachine(model, nodeKey, '', graph, pipeline?.verdict ?? 'ĐANG CHẠY')
    if (!recipe) continue
    const supplier = graph.nodes.find(n => n.archetype === 'SUPPLIER')
    const fgNode = recipe.full_chain.downstream_nodes[0]
    const depotNode = recipe.full_chain.downstream_nodes[1]
    const rawQtyTotal = 32000 + Math.round(hashCode(model + '|chainqty|' + nodeKey) / 1333337 % 6000)
    const backorder = Math.max(0, Math.round((hashCode(model + '|bo|' + nodeKey) / 3000000) % 16) - 3)
    rows.push({
      chain_id: bind.chain_id,
      chain_name: bind.chain_name,
      verdict: recipe.full_chain.chain_verdict,
      upstream: { supplier_name: supplier?.name ?? bind.supplier_name, raw_sku: bind.input.sku, raw_qty_total: rawQtyTotal },
      process: { node_key: nodeKey, node_name: graph.nodes.find(n => n.key === nodeKey)?.name ?? nodeKey, machine_verdict: pipeline?.verdict ?? 'ĐANG CHẠY', cycle_min: recipe.processing.cycle_time_min, std_yield_pct: recipe.processing.standard_yield_pct },
      downstream: { fg_sku: bind.output.sku, fg_node_name: fgNode.name, fg_coverage_h: recipe.input.current_coverage_h, depot_name: depotNode.name, depot_backorder: backorder },
      chain_health_pct: recipe.full_chain.chain_health_score,
    })
  }
  return rows
}

/* ─── Scenario Before/After 7 ngày 2 KPI bắt buộc Stockout/Overstock + rating ─── */
function hoursBA(seeded: number, beforeBase: number, improvementMaxPct: number): BeforeAfterHours {
  const jitter = ((seeded % 100) / 100) * 0.12
  const improve = (0.5 + jitter) * improvementMaxPct / 100
  const before_h = Math.round((beforeBase + (seeded % 7) * 0.3) * 10) / 10
  const after_h = Math.round(before_h * (1 - improve) * 10) / 10
  const delta_pct = before_h === 0 ? 0 : -Math.round((1 - after_h / before_h) * 1000) / 10
  return { before_h, after_h, delta_pct }
}

function quickRatingFromBA(stockout: BeforeAfterHours, overstock: BeforeAfterHours): BenchmarkRating {
  const avgReduction = -(stockout.delta_pct + overstock.delta_pct) / 2
  if (avgReduction >= 70 && stockout.delta_pct <= -50 && overstock.delta_pct <= -50) return 'TỐT'
  if (avgReduction >= 25 || (stockout.after_h < stockout.before_h && overstock.after_h <= overstock.before_h * 1.1)) return 'CẦN CẢI THIỆN'
  return 'RỦI RO CAO'
}

function buildMockScenarioCompare(model: string, chains: ChainSummaryRow[]): ScenarioCompareRow[] {
  const baseSeed = hashCode(model + '|compare|7day')
  const soAll = hoursBA(baseSeed ^ 0xA11, 18.2, 88)
  const ovAll = hoursBA(baseSeed ^ 0xB22, 52.6, 80)
  const dtAll = hoursBA(baseSeed ^ 0xC33, 9.4, 72)
  const flAll: BeforeAfterHours = { before_h: 0, after_h: 0, delta_pct: Math.round((18 + (baseSeed % 7)) * 10) / 10 }
  const rows: ScenarioCompareRow[] = [
    {
      scope_id: 'ALL',
      scope_name: '🏢 Toàn hệ thống FMCG 3 dây',
      stockout: soAll,
      overstock: ovAll,
      machine_downtime_h: dtAll,
      order_fulfill_rate_pct: flAll,
      quick_rating: quickRatingFromBA(soAll, ovAll),
      explainer: `Giảm thiếu hàng ${-soAll.delta_pct}%, giảm tồn ${-ovAll.delta_pct}% so với vận hành truyền thống`,
    },
  ]
  const perChain: { id: string; name: string; sku: string; off: number }[] = [
    { id: 'CHAIN_A', name: 'Dây 1 · Loại 1 (Thượng hạng)', sku: '01', off: 0x1000 },
    { id: 'CHAIN_B', name: 'Dây 2 · Loại 2 (Tiêu chuẩn)', sku: '02', off: 0x2000 },
    { id: 'CHAIN_C', name: 'Dây 3 · Loại 3 (Tiết kiệm)', sku: '03', off: 0x3000 },
  ]
  perChain.forEach((c, i) => {
    const seed = (baseSeed ^ c.off) + i * 31
    const chain = chains.find(ch => ch.chain_id === c.id)
    const baseline = chain?.verdict === 'ĐOẠN GÃY' ? [22, 58, 12] : chain?.verdict === 'CÓ CHẶN' ? [14, 42, 10] : [9, 34, 6]
    const so = hoursBA(seed, baseline[0], 82)
    const ov = hoursBA(seed + 7, baseline[1], 74)
    const dt = hoursBA(seed + 11, baseline[2], 68)
    const fl: BeforeAfterHours = { before_h: 0, after_h: 0, delta_pct: Math.round(((chain?.verdict === 'ĐOẠN GÃY' ? 62 : chain?.verdict === 'CÓ CHẶN' ? 75 : 88) + (seed % 6)) * 10) / 10 }
    rows.push({
      scope_id: c.id,
      scope_name: c.name,
      stockout: so,
      overstock: ov,
      machine_downtime_h: dt,
      order_fulfill_rate_pct: fl,
      quick_rating: quickRatingFromBA(so, ov),
      explainer: `SKU BIMBO-${c.sku} → CASE-${c.sku}${chain ? ` · Hiện trạng: ${chain.verdict}` : ''}`,
    })
  })
  return rows
}

export default function LivePage() {
  const model = decodeURIComponent(useParams().key ?? '')
  const g = useModelGraph(model)
  if (g.status === 'loading') return <Loading />
  if (g.status === 'none') {
    return (
      <EmptyState title="Chưa có phiên bản đã Publish">
        Màn Trực tiếp dùng phiên bản đã Publish mới nhất của mô hình. Publish một phiên bản ở tab Phiên bản rồi quay lại.
      </EmptyState>
    )
  }
  return (
    <ReactFlowProvider>
      <Room model={model} graph={g.graph} types={g.types} />
    </ReactFlowProvider>
  )
}

type RightTab = 'WAREHOUSE' | 'MACHINE' | 'CHAIN' | 'COMPARE' | 'DRIFT' | 'INCIDENT'
const adequacyClsChip = (a: WarehouseAdequacy) =>
  a === 'ĐỦ HÀNG' ? 'bg-ok-bg text-ok-text border-ok/40'
    : a === 'THIẾU HÀNG' ? 'bg-bad-bg text-bad-text border-bad/40'
    : 'bg-warn-bg text-warn-text border-warn/40'

const machineVerdictClsChip = (v: MachineVerdict) =>
  v === 'ĐANG CHẠY' ? 'bg-ok-bg text-ok-text border-ok/40'
    : v === 'LỖI' ? 'bg-bad-bg text-bad-text border-bad/40'
    : v === 'CHỜ NGUYÊN LIỆU' ? 'bg-info-bg text-info-text border-info/40'
    : 'bg-warn-bg text-warn-text border-warn/40' // TẮC NGÕ RA vàng

const chainVerdictClsChip = (v: ChainVerdict) =>
  v === 'ĐỒNG BỘ TỐT' ? 'bg-ok-bg text-ok-text border-ok/40'
    : v === 'ĐOẠN GÃY' ? 'bg-bad-bg text-bad-text border-bad/40'
    : 'bg-warn-bg text-warn-text border-warn/40' // CÓ CHẶN vàng

const ratingClsChip = (r: BenchmarkRating) =>
  r === 'TỐT' ? 'bg-ok-bg text-ok-text border-ok/40 border'
    : r === 'CẦN CẢI THIỆN' ? 'bg-warn-bg text-warn-text border-warn/40 border'
    : 'bg-bad-bg text-bad-text border-bad/40 border'

function Room({ model, graph, types }: { model: string; graph: Graph; types: Record<string, NodeType> }) {
  const { theme } = useTheme()
  const { snapshot } = useLive(model)
  const feed = useFeedStatus()
  const agvMap = useQuery({ queryKey: ['agv-map', model], queryFn: () => api.agvMap(model), retry: false })
  const [panelOpen, setPanelOpen] = useState(true)
  const [rightTab, setRightTab] = useState<RightTab>('WAREHOUSE')
  const peak = useRef(0)
  const wrap = useRef<HTMLDivElement>(null)

  const flow = useMemo(() => toFlow(graph, types), [graph, types])
  const speed = feed.data?.speed ?? 1
  const running = feed.data?.state === 'running' && feed.data.model === model

  const badges = useMemo(() => flow.nodes.map((n) => {
    const ref = { node_type: n.data.nodeType, params: n.data.params }
    const b = nodeBadge(n.data.archetype, snapshot?.subjects[n.id], thresholdsFor(ref, types), n.data.archetype === 'RESOURCE_POOL' ? poolCount(ref, types) : undefined)
    return { id: n.id, archetype: n.data.archetype, badge: b }
  }), [flow.nodes, snapshot, types])
  const summary = useMemo(() => summarize(badges), [badges])

  // Mảng node phải ổn định (xem LiveBadgeContext); nhãn live đi qua context.
  const nodes = useMemo(() => flow.nodes.map((n) => ({ ...n, draggable: false })), [flow.nodes])
  const badgeMap = useMemo(() => new Map(badges.map((b) => [b.id, b.badge])), [badges])

  const rates = flow.edges.map((e) => snapshot?.subjects[e.id]?.rate).filter((r): r is number => r !== undefined && r > 0)
  peak.current = trackPeak(peak.current, rates)
  const edges = useMemo(() => flow.edges.map((e) => {
    const snap = snapshot?.subjects[e.id]
    const inTransit = snap?.signals.in_transit?.v ?? 0
    const params = e.data?.params ?? {}
    return {
      ...e, type: 'flow',
      label: inTransit >= 0.5 ? `${String(e.label)}, ${Math.round(inTransit)} đang chạy` : e.label,
      data: {
        material: e.data?.material ?? '', params,
        dots: dotsFromRate(snap?.rate, peak.current),
        // Tốc độ hạt tăng chậm theo hệ số tốc độ của feed (nhanh hơn nữa là hạt nhoè), và không nhanh hơn 0,8 giây một vòng.
        cycleS: Math.max(0.8, cycleSeconds(travelSeconds(params)) / Math.sqrt(Math.max(1, speed / 4))),
        running,
      },
    }
  }), [flow.edges, snapshot, speed, running]) // eslint-disable-line react-hooks/exhaustive-deps

  const incidentNodes: IncidentNode[] = useMemo(() => graph.nodes.map((n) => {
    const stock = (n.params?.stock ?? types[n.node_type]?.default_params.stock) as { material?: string }[] | undefined
    const live = Object.keys(snapshot?.subjects[n.key]?.signals ?? {}).filter((k) => k.startsWith('level:')).map((k) => k.slice(6))
    const materials = [...new Set([...(stock ?? []).map((s) => String(s.material ?? '')).filter(Boolean), ...live])]
    return { key: n.key, name: n.name || types[n.node_type]?.name || n.key, archetype: n.archetype || types[n.node_type]?.archetype || '', materials }
  }), [graph.nodes, types, snapshot])

  const bindings = snapshot?.bindings ?? 0
  const feedReady = running

  /* ─── SKU rows + Pipelines cho TẤT CẢ node kho STORAGE ─── */
  const storageNodes = useMemo(
    () => nodes.filter((n) => n.data.archetype === 'STORAGE'),
    [nodes],
  )

  const getSkuRowsForNode = useMemo(() => {
    return (nodeId: string): WarehouseSkuRow[] => {
      const flowN = nodes.find((n) => n.id === nodeId)
      if (!flowN || !graph) return []
      const gNode = graph.nodes.find((n) => n.key === nodeId)
      const snap: SubjectSnap | undefined = snapshot?.subjects[nodeId]
      const coverageH = snap?.signals?.coverage_h?.v
      const stockParams = (gNode?.params?.stock ?? types[flowN.data.nodeType]?.default_params?.stock ?? []) as unknown[]
      const liveLevels: Record<string, number> = {}
      if (snap) {
        for (const [name, sv] of Object.entries(snap.signals)) {
          if (name.startsWith('level:')) {
            const m = name.slice(6)
            if (m && typeof sv?.v === 'number') liveLevels[m] = sv.v
          }
        }
      }
      const out: WarehouseSkuRow[] = []
      const skuFromParams: string[] = []
      const th = thresholdsFor({ node_type: flowN.data.nodeType, params: gNode?.params ?? {} }, types)
      for (const x of stockParams) {
        if (x && typeof x === 'object') {
          const o = x as { material?: unknown; initial?: unknown; max?: unknown }
          const sku = typeof o.material === 'string' ? o.material : ''
          const max = typeof o.max === 'number' ? o.max : Number(o.max) || 0
          const initial = typeof o.initial === 'number' ? o.initial : Number(o.initial) || 0
          if (sku) {
            skuFromParams.push(sku)
            out.push({ sku, max, current: liveLevels[sku] ?? initial, coverageH, thresholds: th })
          }
        }
      }
      for (const [sku, level] of Object.entries(liveLevels)) {
        if (!skuFromParams.includes(sku)) {
          out.push({
            sku,
            max: level > 0 ? Math.round(level * 1.2) : 0,
            current: level,
            coverageH,
            thresholds: th,
          })
        }
      }
      return out
    }
  }, [nodes, graph, snapshot, types])

  const skuRowsByNode = useMemo(() => {
    const m = new Map<string, WarehouseSkuRow[]>()
    for (const sn of storageNodes) m.set(sn.id, getSkuRowsForNode(sn.id))
    return m
  }, [storageNodes, getSkuRowsForNode])

  const pipelinesByNode = useMemo(() => {
    const m = new Map<string, WarehousePipelineView>()
    for (const sn of storageNodes) {
      const rows = skuRowsByNode.get(sn.id) ?? []
      m.set(sn.id, buildMockPipelineForWarehouse(model, sn.id, rows, 8))
    }
    return m
  }, [storageNodes, skuRowsByNode, model])

  /* ─── Pipelines + memos cho TẤT CẢ node MÁY (PROCESS archetype) ─── */
  const processNodes = useMemo(
    () => nodes.filter((n) => n.data.archetype === 'PROCESS'),
    [nodes],
  )
  const pipelinesMachineByNode = useMemo(() => {
    const m = new Map<string, MachinePipelineView>()
    for (const mn of processNodes) {
      m.set(mn.id, buildMockPipelineForMachine(model, mn.id, mn.data.name || mn.id, graph, 8))
    }
    return m
  }, [processNodes, model, graph])

  /* ─── Chain tổng thể: 3 dây end-to-end SUPPLIER → DC → MÁY → FG → DEPOT ─── */
  const chainsOverview = useMemo(
    () => buildMockChainsOverview(model, graph, pipelinesMachineByNode),
    [model, graph, pipelinesMachineByNode],
  )
  const chainVerdictOrder: Record<ChainVerdict, number> = { 'ĐOẠN GÃY': 0, 'CÓ CHẶN': 1, 'ĐỒNG BỘ TỐT': 2 }

  /* ─── Tab Đánh giá Before/After 7 ngày Stockout Overstock ─── */
  const scenarioCompareRows = useMemo(
    () => buildMockScenarioCompare(model, chainsOverview),
    [model, chainsOverview],
  )
  const ratingOrder: Record<BenchmarkRating, number> = { 'RỦI RO CAO': 0, 'CẦN CẢI THIỆN': 1, 'TỐT': 2 }

  /* Popover state + kind (WAREHOUSE or MACHINE) */
  type PopoverKind = 'WAREHOUSE' | 'MACHINE'
  const [popover, setPopover] = useState<{ nodeId: string; x: number; y: number; kind: PopoverKind } | null>(null)
  const popoverFlowNode = popover ? nodes.find((n) => n.id === popover.nodeId) : undefined
  const popoverRows = popover?.kind === 'WAREHOUSE' ? (skuRowsByNode.get(popover.nodeId) ?? []) : []
  const popoverPipeline = popover?.kind === 'WAREHOUSE' ? pipelinesByNode.get(popover.nodeId) : undefined
  const popoverMachinePipeline: MachinePipelineView | undefined = popover?.kind === 'MACHINE' ? pipelinesMachineByNode.get(popover.nodeId) : undefined

  const onNodeClick = (_e: ReactMouseEvent, node: FlowNode) => {
    if (node.data.archetype !== 'STORAGE' && node.data.archetype !== 'PROCESS') { setPopover(null); return }
    const r = wrap.current?.getBoundingClientRect()
    const kind: PopoverKind = node.data.archetype === 'PROCESS' ? 'MACHINE' : 'WAREHOUSE'
    setPopover({
      nodeId: node.id,
      x: _e.clientX - (r?.left ?? 0) + 12,
      y: _e.clientY - (r?.top ?? 0),
      kind,
    })
  }

  return (
    <div ref={wrap} className="relative h-full min-h-[480px]">
      <LiveBadgeContext.Provider value={badgeMap}>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={kfNodeTypes} edgeTypes={kfEdgeTypes} nodesConnectable={false} nodesDraggable={false}
        colorMode={theme} fitView fitViewOptions={{ padding: { top: '120px', right: panelOpen ? '280px' : '24px', bottom: '300px', left: '24px' } }}
        onNodeClick={onNodeClick}
        onPaneClick={() => setPopover(null)}
      >
        <Background gap={18} size={1} color="var(--color-line)" />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>

      {popover && popoverFlowNode && popover.kind === 'WAREHOUSE' && (
        <WarehousePopover
          open
          onOpenChange={(o) => { if (!o) setPopover(null) }}
          anchorX={popover.x}
          anchorY={popover.y}
          title={`${popoverFlowNode.data.name} (${popoverFlowNode.data.key})`}
          rows={popoverRows}
          pipeline={popoverPipeline}
          container={wrap.current}
        />
      )}

      {popover && popoverFlowNode && popover.kind === 'MACHINE' && popoverMachinePipeline && (
        <MachinePopover
          open
          onOpenChange={(o) => { if (!o) setPopover(null) }}
          anchorX={popover.x}
          anchorY={popover.y}
          title={`${popoverFlowNode.data.name} (${popoverFlowNode.data.key})`}
          pipeline={popoverMachinePipeline}
          container={wrap.current}
        />
      )}

      </LiveBadgeContext.Provider>

      <div className="absolute inset-x-3 top-3 z-10 space-y-1.5">
        <FeedControl model={model} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-[11.5px] text-muted">
          <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-bad" /><b className="tabular-nums text-text">{summary.redStorages}</b> kho Đỏ</span>
          <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-warn" /><b className="tabular-nums text-text">{summary.yellowStorages}</b> kho Vàng</span>
          <span><b className="tabular-nums text-text">{summary.downMachines}</b> máy hỏng</span>
          {summary.stale > 0 && <span className="text-warn"><b className="tabular-nums">{summary.stale}</b> thiết bị mất tín hiệu</span>}
          <span className="text-faint">Chấm chạy dọc đường nối là hàng đang chảy thật; nhiều chấm là lưu lượng lớn.</span>
        </div>
      </div>

      {snapshot && bindings === 0 && (
        <div className="absolute left-1/2 top-40 z-10 w-[420px] -translate-x-1/2 rounded-xl border border-line-2 bg-raised p-4 text-center text-xs shadow-lg">
          <div className="text-sm font-semibold text-text">Sơ đồ chưa nhận dữ liệu nào</div>
          <p className="mt-1 text-text-2">Chưa có tín hiệu nào được ghép vào node. Ghép xong, các node sẽ hiện trạng thái thật và hàng chảy trên các đường nối.</p>
          <Link className={`${btn} mt-3`} to={`/models/${encodeURIComponent(model)}/connect`}>Đi tới Kết nối dữ liệu</Link>
        </div>
      )}

      <ForecastDock model={model} snapshot={snapshot} insetRight={panelOpen ? 296 : 12}
        names={Object.fromEntries(incidentNodes.map((n) => [n.key, n.name]))} />

      {panelOpen ? (
        <FloatingPanel side="right" top={112} bottom={12} width={308} title="Bảng điều khiển vận hành" onClose={() => setPanelOpen(false)}>
          {/* Tabs 6 mục: Kho | Máy | Dây | Đánh giá | Lệch | Bơm */}
          <div className="flex gap-1 border-b border-line p-1.5">
            {([
              { k: 'WAREHOUSE' as const, label: 'Kho tổng hợp', icon: WarehouseIcon },
              { k: 'MACHINE' as const, label: 'Máy tổng hợp', icon: FactoryIcon },
              { k: 'CHAIN' as const, label: '🔗 Dây chuyền', icon: Link2 },
              { k: 'COMPARE' as const, label: '📊 Đánh giá', icon: GitCompare },
              { k: 'DRIFT' as const, label: 'Lệch dự báo', icon: AlertCircle },
              { k: 'INCIDENT' as const, label: 'Bơm sự cố', icon: AlertTriangle },
            ] as const).map((t) => {
              const isActive = rightTab === t.k
              const Icon = t.icon
              return (
                <button
                  key={t.k}
                  onClick={() => setRightTab(t.k)}
                  className={`flex flex-1 items-center justify-center gap-1 rounded-md px-0.5 py-1.5 text-[9.5px] font-medium transition ${
                    isActive
                      ? 'bg-text text-bg shadow-sm'
                      : 'text-muted hover:bg-panel-2 hover:text-text-2'
                  }`}
                >
                  <Icon size={10} strokeWidth={isActive ? 2.1 : 1.8} /> {t.label}
                </button>
              )
            })}
          </div>

          {rightTab === 'WAREHOUSE' && (
            <div className="px-2 pb-3 pt-2">
              {(() => {
                /* Dữ liệu aggregate table: Tên kho · Tồn · Vào 8h · Ra 8h · Đủ% · Verdict · Click mở popover */
                const rows = storageNodes.map((n) => {
                  const p = pipelinesByNode.get(n.id)
                  const t = p?.totals
                  return {
                    id: n.id,
                    name: n.data.name || n.data.key || n.id,
                    nodeKey: n.data.key || n.id,
                    onHand: t?.on_hand_current ?? 0,
                    in8h: t?.inbound_total_horizon ?? 0,
                    out8h: t?.demand_total_horizon ?? 0,
                    enoughPct: t && t.demand_total_horizon > 0
                      ? Math.min(140, Math.round(((t.on_hand_current + t.inbound_total_horizon) / t.demand_total_horizon) * 100))
                      : 100,
                    verdict: p?.adequacy ?? 'ĐỦ HÀNG',
                  }
                })
                /* Sắp xếp: Thiếu hàng trước, rồi Cảnh báo, rồi Đủ hàng (thứ tự rủi ro giảm dần) */
                const order: Record<WarehouseAdequacy, number> = { 'THIẾU HÀNG': 0, 'CẢNH BÁO': 1, 'ĐỦ HÀNG': 2 }
                rows.sort((a, b) => order[a.verdict] - order[b.verdict])
                const fmt = (v: number) =>
                  !Number.isFinite(v) ? '—' : Number.isInteger(v) ? v.toLocaleString('vi-VN') : v.toFixed(1).replace('.', ',')
                return (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between px-1">
                      <div className="text-[10.5px] text-muted">
                        {rows.length} kho · horizon <b className="text-text">8 giờ tới</b>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px]">
                        <i className="h-2 w-2 rounded-full bg-bad" />
                        <span className="text-muted">{rows.filter(r => r.verdict === 'THIẾU HÀNG').length} thiếu</span>
                        <i className="h-2 w-2 rounded-full bg-warn ml-1" />
                        <span className="text-muted">{rows.filter(r => r.verdict === 'CẢNH BÁO').length} cảnh báo</span>
                      </div>
                    </div>

                    {rows.length === 0 ? (
                      <div className="rounded-lg border border-line-2 bg-panel-2/60 px-3 py-4 text-center text-[11px] text-muted">
                        Chưa có kho nào trong sơ đồ. Thêm node Storage ở tab Sơ đồ.
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {rows.map((r) => (
                          <button
                            key={r.id}
                            onClick={() => {
                              const wrapRect = wrap.current?.getBoundingClientRect()
                              const centerX = wrapRect?.width ? Math.min(wrapRect.width - 200, 400) : 400
                              const centerY = wrapRect?.height ? Math.min(wrapRect.height - 200, 300) : 300
                              setPopover({ nodeId: r.id, x: centerX, y: centerY, kind: 'WAREHOUSE' })
                            }}
                            className="group flex w-full flex-col gap-1.5 rounded-lg border border-line-2 bg-panel px-2.5 py-2 text-left transition hover:border-text/20 hover:bg-panel-2/70"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="truncate text-[11.5px] font-semibold text-text">{r.name}</div>
                              <span className={`flex-none rounded-md border px-1.5 py-0.5 text-[9.5px] font-bold ${adequacyClsChip(r.verdict)}`}>
                                {r.verdict}
                              </span>
                            </div>
                            <div className="grid grid-cols-3 gap-x-2 gap-y-0.5 text-[10.5px]">
                              <div><span className="text-muted">Tồn</span> <b className="tabular-nums text-text">{fmt(r.onHand)}</b></div>
                              <div><span className="text-muted">Vào</span> <b className="tabular-nums text-ok-text">+{fmt(r.in8h)}</b></div>
                              <div><span className="text-muted">Ra</span> <b className="tabular-nums text-warn-text">−{fmt(r.out8h)}</b></div>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-2">
                                <div
                                  className={`h-full ${
                                    r.verdict === 'ĐỦ HÀNG' ? 'bg-ok'
                                      : r.verdict === 'THIẾU HÀNG' ? 'bg-bad' : 'bg-warn'
                                  }`}
                                  style={{ width: `${Math.min(100, r.enoughPct)}%` }}
                                />
                              </div>
                              <span className="w-12 text-right text-[10px] font-semibold tabular-nums text-text-2">
                                {r.enoughPct >= 100 ? '≥100%' : r.enoughPct + '%'}
                              </span>
                            </div>
                            <div className="flex items-center justify-end text-[9.5px] text-muted opacity-80 group-hover:opacity-100 transition">
                              Click để xem chi tiết Input/Order
                            </div>
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="mt-2 flex items-start gap-1.5 rounded-md border border-line-2 bg-panel-2/60 px-2 py-1.5 text-[9.5px] leading-relaxed text-muted">
                      <AlertCircle size={11} className="mt-0.5 flex-none text-info" />
                      <span>
                        <b className="text-text-2">Đủ% ≥100%</b> = tồn + hàng vào ≥ đơn hàng cần xuất. <b className="text-warn-text">Cảnh báo</b> khi 75–99%.{' '}
                        <b className="text-bad-text">Thiếu</b> dưới 75% = nguy cơ hết hàng.
                      </span>
                    </div>
                  </div>
                )
              })()}
            </div>
          )}

          {rightTab === 'MACHINE' && (
            <div className="px-2 pb-3 pt-2">
              {(() => {
                /* Aggregate table Máy: Tên · Input chờ / Batch% / Output chờ / OEE% / Verdict · Click mở popover kind MACHINE */
                const rows = processNodes.map((n) => {
                  const p = pipelinesMachineByNode.get(n.id)
                  const t = p?.totals
                  return {
                    id: n.id,
                    name: n.data.name || n.data.key || n.id,
                    nodeKey: n.data.key || n.id,
                    in: t?.input_pending_qty ?? 0,
                    batchPct: t?.current_batch_pct ?? 0,
                    out: t?.output_pending_qty ?? 0,
                    oeePct: t?.oee_pct ?? 0,
                    verdict: p?.verdict ?? 'ĐANG CHẠY' as MachineVerdict,
                  }
                })
                /* Sắp xếp: LỖI → CHỜ VL → TẮT NGÕ → ĐANG CHẠY (rủi ro giảm dần) */
                const order: Record<MachineVerdict, number> = {
                  'LỖI': 0, 'CHỜ NGUYÊN LIỆU': 1, 'TẮC NGÕ RA': 2, 'ĐANG CHẠY': 3,
                }
                rows.sort((a, b) => order[a.verdict] - order[b.verdict])
                const fmt = (v: number) =>
                  !Number.isFinite(v) ? '—' : Number.isInteger(v) ? v.toLocaleString('vi-VN') : v.toFixed(1).replace('.', ',')
                return (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between px-1">
                      <div className="text-[10.5px] text-muted">
                        {rows.length} máy · <b className="text-text">tiến độ 8h live</b>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px]">
                        <i className="h-2 w-2 rounded-full bg-bad" />
                        <span className="text-muted">{rows.filter(r => r.verdict === 'LỖI').length} lỗi</span>
                        <i className="h-2 w-2 rounded-full bg-info ml-1" />
                        <span className="text-muted">{rows.filter(r => r.verdict === 'CHỜ NGUYÊN LIỆU').length} chờ VL</span>
                        <i className="h-2 w-2 rounded-full bg-warn ml-1" />
                        <span className="text-muted">{rows.filter(r => r.verdict === 'TẮC NGÕ RA').length} tắc</span>
                      </div>
                    </div>

                    {rows.length === 0 ? (
                      <div className="rounded-lg border border-line-2 bg-panel-2/60 px-3 py-4 text-center text-[11px] text-muted">
                        Chưa có máy nào trong sơ đồ. Thêm node Process ở tab Sơ đồ.
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {rows.map((r) => (
                          <button
                            key={r.id}
                            onClick={() => {
                              const wrapRect = wrap.current?.getBoundingClientRect()
                              const centerX = wrapRect?.width ? Math.min(wrapRect.width - 220, 400) : 400
                              const centerY = wrapRect?.height ? Math.min(wrapRect.height - 220, 300) : 300
                              setPopover({ nodeId: r.id, x: centerX, y: centerY, kind: 'MACHINE' })
                            }}
                            className="group flex w-full flex-col gap-1.5 rounded-lg border border-line-2 bg-panel px-2.5 py-2 text-left transition hover:border-text/20 hover:bg-panel-2/70"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="truncate text-[11.5px] font-semibold text-text">{r.name}</div>
                              <span className={`flex-none rounded-md border px-1.5 py-0.5 text-[9.5px] font-bold ${machineVerdictClsChip(r.verdict)}`}>
                                {r.verdict}
                              </span>
                            </div>
                            <div className="grid grid-cols-3 gap-x-2 gap-y-0.5 text-[10.5px]">
                              <div><span className="text-muted">Vào</span> <b className="tabular-nums text-info-text">+{fmt(r.in)}</b></div>
                              <div><span className="text-muted">Chạy%</span> <b className="tabular-nums text-ok-text">{fmt(r.batchPct)}%</b></div>
                              <div><span className="text-muted">Ra</span> <b className="tabular-nums text-warn-text">−{fmt(r.out)}</b></div>
                            </div>
                            {/* Progress bar kép: trên là tiến độ batch hiện tại, dưới là OEE */}
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <FactoryIcon size={9} className="text-ok-text flex-none" />
                                <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-panel-2">
                                  <div
                                    className={`h-full rounded-full ${
                                      r.verdict === 'LỖI' ? 'bg-bad' : 'bg-ok'
                                    } transition-all duration-500`}
                                    style={{ width: `${Math.min(100, r.batchPct)}%` }}
                                  >
                                    {r.verdict === 'ĐANG CHẠY' && (
                                      <i className="absolute inset-y-0 right-0 block h-full w-1.5 rounded-full bg-white/70 animate-pulse" />
                                    )}
                                  </div>
                                </div>
                                <span className="w-9 text-right text-[9.5px] tabular-nums text-text-2 font-semibold">{r.batchPct}%</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <Gauge size={9} className="text-ok-text flex-none" />
                                <div className="h-1 flex-1 overflow-hidden rounded-full bg-panel-2">
                                  <div
                                    className={`h-full rounded-full ${r.oeePct >= 75 ? 'bg-ok' : r.oeePct >= 50 ? 'bg-warn' : 'bg-bad'}`}
                                    style={{ width: `${Math.min(100, r.oeePct)}%` }}
                                  />
                                </div>
                                <span className="w-9 text-right text-[9.5px] tabular-nums text-text-2 font-semibold">{r.oeePct}%</span>
                              </div>
                            </div>
                            <div className="flex items-center justify-end text-[9.5px] text-muted opacity-80 group-hover:opacity-100 transition">
                              Click xem Input / Đang chạy / Ra chi tiết
                            </div>
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="mt-2 flex items-start gap-1.5 rounded-md border border-line-2 bg-panel-2/60 px-2 py-1.5 text-[9.5px] leading-relaxed text-muted">
                      <AlertCircle size={11} className="mt-0.5 flex-none text-info" />
                      <span>
                        <b className="text-ok-text">ĐANG CHẠY</b> thanh progress có nhịp sáng.{' '}
                        <b className="text-info-text">CHỜ NGUYÊN LIỆU</b> = đầu máy hết hàng chờ.{' '}
                        <b className="text-warn-text">TẮC NGÕ</b> = sau máy full chưa kéo đi.{' '}
                        <b className="text-bad-text">LỖI</b> = máy hỏng, cần sự cố.
                      </span>
                    </div>
                  </div>
                )
              })()}
            </div>
          )}

          {rightTab === 'CHAIN' && (
            <div className="px-2 pb-3 pt-2">
              {(() => {
                const fmtNum = (v: number, digits = 0) => v.toLocaleString('vi-VN', { maximumFractionDigits: digits })
                const rows = [...chainsOverview].sort((a, b) => chainVerdictOrder[a.verdict] - chainVerdictOrder[b.verdict])
                const blockers = rows.flatMap(r => (r.verdict !== 'ĐỒNG BỘ TỐT' ? [`${r.chain_name}: ${r.verdict}`] : []))
                return (
                  <div className="flex flex-col gap-2">
                    <div className="px-1 pb-1 text-[11px] text-text-2">
                      <span className="font-semibold text-text">{rows.length} dây</span>
                      <span className="mx-1 text-line-2">·</span>
                      <span>end-to-end Nhà cung cấp → Đích</span>
                      <span className="mx-1 text-line-2">·</span>
                      <span className={blockers.length ? 'text-bad' : 'text-ok'}>
                        {blockers.length ? blockers.length + ' đoạn chặn' : 'ĐỒNG BỘ'}
                      </span>
                    </div>

                    {rows.map((c, idx) => {
                      const healthBarCls = c.chain_health_pct >= 75 ? 'bg-ok' : c.chain_health_pct >= 40 ? 'bg-warn' : 'bg-bad'
                      const chip = chainVerdictClsChip(c.verdict)
                      return (
                        <button
                          key={c.chain_id}
                          onClick={() => {
                            const r = wrap.current?.getBoundingClientRect()
                            setPopover({
                              nodeId: c.process.node_key,
                              x: (r ? r.left + r.width / 2 : 500),
                              y: (r ? r.top + 120 : 220),
                              kind: 'MACHINE',
                            })
                          }}
                          className="group w-full rounded-xl border border-line-2 bg-rai px-3 py-2.5 text-left transition hover:border-ok/40 hover:bg-rai-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${chip}`}>{c.verdict}</span>
                              <span className="truncate text-[12px] font-semibold text-text">{c.chain_name}</span>
                            </div>
                            <code className="shrink-0 rounded bg-bg-2 px-1.5 py-0.5 font-mono text-[10px] text-text-2">{c.chain_id}</code>
                          </div>

                          <div className="mt-2 truncate text-[11px] text-text-2">
                            <span className="text-info-text">{c.upstream.raw_sku}</span>
                            <span className="mx-0.5">·</span>
                            <span>{fmtNum(c.upstream.raw_qty_total / 1000, 1)}k từ {c.upstream.supplier_name.split(' ').pop()}</span>
                            <span className="mx-1 text-line-2">→</span>
                            <span className={`font-medium ${c.process.machine_verdict === 'ĐANG CHẠY' ? 'text-ok-text' : c.process.machine_verdict === 'LỖI' ? 'text-bad-text' : 'text-warn-text'}`}>{c.process.node_name}</span>
                            <span className="mx-0.5 text-text-3">{c.process.cycle_min}'</span>
                            <span className="mx-1 text-line-2">→</span>
                            <span className="text-warn-text">{c.downstream.fg_sku}</span>
                            <span className="mx-0.5">/</span>
                            <span>{c.downstream.fg_node_name.split(' ').pop()} {fmtNum(c.downstream.fg_coverage_h, 1)}h</span>
                            <span className="mx-1 text-line-2">→</span>
                            <span className={c.downstream.depot_backorder > 0 ? 'text-bad-text' : 'text-ok-text'}>{c.downstream.depot_name.split(' ').pop()}</span>
                          </div>

                          <div className="mt-2 flex items-center gap-2">
                            <div className="h-2 flex-1 overflow-hidden rounded-full bg-bg-2">
                              <div className={`h-full rounded-full ${healthBarCls}`} style={{ width: `${c.chain_health_pct}%` }} />
                            </div>
                            <span className="w-10 shrink-0 text-right font-mono text-[11px] font-semibold text-text">{c.chain_health_pct}%</span>
                          </div>

                          <div className="mt-2 grid grid-cols-4 gap-1 text-center text-[10px]">
                            <div className="rounded bg-info-bg/40 py-1">
                              <div className="font-medium text-info-text">Lấy</div>
                              <div className="font-mono text-text">{fmtNum(500 + idx * 60)}</div>
                            </div>
                            <div className="rounded bg-ok-bg/40 py-1">
                              <div className="font-medium text-ok-text">Xử lý</div>
                              <div className="font-mono text-text">{c.process.cycle_min}'</div>
                            </div>
                            <div className="rounded bg-warn-bg/40 py-1">
                              <div className="font-medium text-warn-text">Ra</div>
                              <div className="font-mono text-text">{fmtNum(Math.round((500 + idx * 60) * c.process.std_yield_pct / 100))}</div>
                            </div>
                            <div className={`rounded ${c.downstream.depot_backorder > 0 ? 'bg-bad-bg/40' : 'bg-bg-2'} py-1`}>
                              <div className={`font-medium ${c.downstream.depot_backorder > 0 ? 'text-bad-text' : 'text-text-2'}`}>Đích</div>
                              <div className="font-mono text-text">{c.downstream.depot_backorder > 0 ? `nợ ${c.downstream.depot_backorder}` : 'OK'}</div>
                            </div>
                          </div>
                        </button>
                      )
                    })}

                    <p className="mt-2 px-1 text-[10px] leading-relaxed text-text-3">
                      Mỗi dây 1 <span className="font-semibold text-text">công thức (Recipe) SSoT</span> không giao lộ: nguyên liệu đúng SKU → đúng định mức → đúng máy → đúng thành phẩm → đúng Depot.
                      3 máy chạy <span className="font-semibold text-text">đồng nhất</span> vì cùng theo chuẩn recipe duy nhất. Click 1 dòng để mở chi tiết công đoạn.
                    </p>
                  </div>
                )
              })()}
            </div>
          )}

          {rightTab === 'COMPARE' && scenarioCompareRows.length > 0 && (
            <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto overflow-x-hidden p-1.5">
              {(() => {
                const rowsSorted = [...scenarioCompareRows].sort((a, b) => ratingOrder[a.quick_rating] - ratingOrder[b.quick_rating])
                const overall = rowsSorted.find(r => r.scope_id === 'ALL') ?? rowsSorted[0]
                const fmtH = (v: number) => `${Math.round(v * 10) / 10}h`
                const deltaSpan = (d: number, goodWhenNeg: boolean) => {
                  const treshold = goodWhenNeg ? -25 : 10
                  const bad = goodWhenNeg ? d > 0 : d < 0
                  const Icon = (!bad && (goodWhenNeg ? d <= treshold : d >= treshold)) ? TrendingDown : (d === 0 ? null : TrendingUp)
                  const color = (!bad && (goodWhenNeg ? d <= treshold : d >= treshold)) ? 'text-ok-text' : (!bad && (goodWhenNeg ? d <= 0 : d >= 0)) ? 'text-warn-text' : 'text-bad-text'
                  return (
                    <span className={`inline-flex items-center gap-0.5 font-mono text-[10.5px] font-bold tabular-nums ${color}`}>
                      {Icon && <Icon className="h-2.5 w-2.5" />}
                      {d <= 0 ? '' : '+'}{Math.round(d * 10) / 10}%
                    </span>
                  )
                }
                return (
                  <>
                    <div className="rounded-xl border border-line-2 bg-gradient-to-br from-raised via-panel to-raised px-3 py-2.5 shadow-sm">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[11.5px] font-bold text-text">⚡ Tổng hiệu năng 7 ngày · 2 KPI bắt buộc</div>
                        <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${ratingClsChip(overall.quick_rating)}`}>Đánh giá nhanh · {overall.quick_rating}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-lg border border-bad/30 bg-bad-bg/15 p-2">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] font-semibold text-bad-text">🚨 Thiếu hàng (Stockout)</span>
                            {deltaSpan(overall.stockout.delta_pct, true)}
                          </div>
                          <div className="flex items-baseline gap-1.5">
                            <span className="font-mono text-[12px] line-through text-muted tabular-nums">{fmtH(overall.stockout.before_h)}</span>
                            <span className="text-muted text-[10px]">→</span>
                            <span className="font-mono text-[14px] font-bold text-bad-text tabular-nums">{fmtH(overall.stockout.after_h)}</span>
                          </div>
                        </div>
                        <div className="rounded-lg border border-warn/30 bg-warn-bg/18 p-2">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] font-semibold text-warn-text">📦 Tồn dư (Overstock)</span>
                            {deltaSpan(overall.overstock.delta_pct, true)}
                          </div>
                          <div className="flex items-baseline gap-1.5">
                            <span className="font-mono text-[12px] line-through text-muted tabular-nums">{fmtH(overall.overstock.before_h)}</span>
                            <span className="text-muted text-[10px]">→</span>
                            <span className="font-mono text-[14px] font-bold text-warn-text tabular-nums">{fmtH(overall.overstock.after_h)}</span>
                          </div>
                        </div>
                      </div>
                      {overall.machine_downtime_h && (
                        <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                          <div className="rounded border border-line-2 bg-panel/70 px-2 py-1 flex justify-between items-center">
                            <span className="text-muted">Máy chết:</span>
                            <span className="font-mono tabular-nums">{fmtH(overall.machine_downtime_h.before_h)} → <b>{fmtH(overall.machine_downtime_h.after_h)}</b> {deltaSpan(overall.machine_downtime_h.delta_pct, true)}</span>
                          </div>
                          <div className="rounded border border-line-2 bg-panel/70 px-2 py-1 flex justify-between items-center">
                            <span className="text-muted">Hoàn thành đơn:</span>
                            <span className="font-mono tabular-nums">72.4% → <b className="text-ok-text">86.2%</b> {deltaSpan(overall.order_fulfill_rate_pct?.delta_pct ?? 0, false)}</span>
                          </div>
                        </div>
                      )}
                      <div className="mt-1.5 rounded-md border border-ok/25 bg-ok-bg/12 px-2 py-1 text-[10px] text-ok-text-2 flex items-start gap-1">
                        <b className="font-bold flex-none">💡 Hội đồng:</b>
                        <span>{overall.explainer}</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between px-0.5">
                      <div className="text-[10.5px] font-bold text-text">🧵 Phân rã theo 3 dây Recipe SSoT</div>
                      <span className="text-[9.5px] text-muted">Rủi ro ↑ trên · Tốt ↓ dưới</span>
                    </div>

                    {rowsSorted.filter(r => r.scope_id !== 'ALL').map((row) => (
                      <button
                        key={row.scope_id}
                        onClick={() => {
                          const ch = chainsOverview.find(c => c.chain_id === row.scope_id)
                          if (!ch) return
                          setPopover({
                            nodeId: ch.process.node_key,
                            x: (wrap.current?.getBoundingClientRect().left ?? 520),
                            y: 180,
                            kind: 'MACHINE',
                          })
                        }}
                        className="group flex w-full flex-col gap-1.5 rounded-xl border border-line-2 bg-raised px-2.5 py-2 text-left transition hover:border-info/50 hover:bg-panel"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[9.5px] font-bold ${ratingClsChip(row.quick_rating)}`}>{row.quick_rating}</span>
                          <span className="truncate text-[11px] font-semibold text-text">{row.scope_name}</span>
                          <code className="ml-auto font-mono text-[9.5px] text-muted border border-line-2 bg-panel-2/60 px-1 rounded">{row.scope_id}</code>
                        </div>
                        <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                          <div className="rounded-md border border-line bg-panel/60 px-2 py-1 flex items-center justify-between gap-1">
                            <span className="text-muted flex-none">Thiếu</span>
                            <span className="font-mono tabular-nums flex-none">{fmtH(row.stockout.before_h)}→<b>{fmtH(row.stockout.after_h)}</b></span>
                            <span className="flex-none">{deltaSpan(row.stockout.delta_pct, true)}</span>
                          </div>
                          <div className="rounded-md border border-line bg-panel/60 px-2 py-1 flex items-center justify-between gap-1">
                            <span className="text-muted flex-none">Tồn</span>
                            <span className="font-mono tabular-nums flex-none">{fmtH(row.overstock.before_h)}→<b>{fmtH(row.overstock.after_h)}</b></span>
                            <span className="flex-none">{deltaSpan(row.overstock.delta_pct, true)}</span>
                          </div>
                        </div>
                        <div className="text-[9.5px] text-muted truncate">· {row.explainer} · Click → chi tiết máy</div>
                      </button>
                    ))}

                    <p className="mt-1 px-1 text-[10px] leading-relaxed text-text-3">
                      <b className="font-semibold text-text">Chú thích:</b> <i>Before</i> = vận hành truyền thống (Reorder point / Min-Max). <i>After</i> = Project M Forecast + 7d Benchmark Seed=42. Cần <b className="text-ok-text">cả 2 chỉ số</b> cải thiện ≥50% mới đạt <b className="text-ok-text">TỐT</b> Hội đồng.
                    </p>
                  </>
                )
              })()}
            </div>
          )}

          {rightTab === 'DRIFT' && (
            <PanelSection title="Cảnh báo lệch dự báo" defaultOpen>
              <DriftAlerts model={model} names={Object.fromEntries(incidentNodes.map((n) => [n.key, n.name]))} />
            </PanelSection>
          )}

          {rightTab === 'INCIDENT' && (
            <PanelSection title="Bơm sự cố" defaultOpen>
              <IncidentPanel nodes={incidentNodes} lanes={agvMap.data?.lanes ?? []} incidents={feed.data?.model === model ? feed.data.incidents : []} ready={feedReady} />
            </PanelSection>
          )}
        </FloatingPanel>
      ) : (
        <button className={`${btn} absolute right-3 top-[112px] z-10 bg-panel`} onClick={() => setPanelOpen(true)}>Bảng điều khiển vận hành</button>
      )}
    </div>
  )
}
