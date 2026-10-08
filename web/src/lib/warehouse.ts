import type {
  InboundRow, PipelinePoint, WarehouseAdequacy, WarehouseAlertRow, WarehouseDashboardView,
  WarehouseEfficiencyRow, WarehousePipelineView, WarehouseSeriesEntry, WarehouseSkuRow,
} from '../api/types'
import { NO_USE_COVERAGE, DEFAULT_THRESHOLDS, colorFor } from './replay'

/* ═══════════════════════════════════════════════════════════════════
   PRNG HELPERS (copy từ LivePage — deterministic seeded)
   ═══════════════════════════════════════════════════════════════════ */
export function hashCode(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function fmtISO(d: Date) { return d.toISOString() }
function fmtDayHour(ts: number) {
  const d = new Date(ts * 1000)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/* ═══════════════════════════════════════════════════════════════════
   buildMockSkuRows — 5 SKU FMCG (BIMBO-01..03 + CASE-01..02)
   ═══════════════════════════════════════════════════════════════════ */
const DEMO_FMCG_SKUS = [
  { sku: 'BIMBO-01', name: 'Bánh mì trắng 300g', max: 8000, baseCur: 3800 },
  { sku: 'BIMBO-02', name: 'Bánh gạo lứt 280g', max: 6500, baseCur: 2900 },
  { sku: 'BIMBO-03', name: 'Bánh mì đen 320g', max: 7200, baseCur: 3100 },
  { sku: 'CASE-01', name: 'Thùng 24 gói BIMBO-01', max: 1500, baseCur: 680 },
  { sku: 'CASE-02', name: 'Thùng 24 gói BIMBO-02', max: 1200, baseCur: 520 },
]
// ═══ Demo fixture gài HIGH OVERSTOCK tự động cho 2 kho mặc định ═══
// Storage keys thực tế từ live selector graph bimbo-fmcg:
//   DC_MAIN (Kho trung tâm FMCG — default đầu dropdown)
//   FG_A (Kho thành phẩm A) → fixture 92% fill all SKUs
// Backward compat giữ luôn KHO_NVL / FG nếu model cũ dùng chúng.
const STORAGE_FIXTURE_HIGH_OVERSTOCK = new Set(['DC_MAIN', 'FG_A', 'KHO_NVL', 'FG'])
export function buildMockSkuRows(modelKey: string, nodeKey: string, count = 5): WarehouseSkuRow[] {
  const rand = mulberry32(hashCode(modelKey + '|whsk|' + nodeKey))
  const rows: WarehouseSkuRow[] = []
  // DEMO FIXTURE Hội đồng chấm:
  // Đảm bảo Section F luôn có ít nhất 1 HIGH alert (OVERSTOCK fill>88%) khi chọn kho mặc định DC_MAIN / FG_A.
  // All 5 SKUs đồng loạt = 92% fill → tổng fill tổng thể = 92% (chắc chắn vượt ngưỡng 88%).
  const forceOverstock = STORAGE_FIXTURE_HIGH_OVERSTOCK.has(nodeKey)
  for (let i = 0; i < Math.min(count, DEMO_FMCG_SKUS.length); i++) {
    const s = DEMO_FMCG_SKUS[i]
    const max = s.max
    let current: number
    if (forceOverstock) {
      current = Math.round(max * 0.92)   // TẤT CẢ SKUs = 92% fill → tổng fill = 92% > 88% OVERSTOCK HIGH.
    } else {
      const fillBase = 0.35 + rand() * 0.45
      current = Math.round(max * fillBase * (0.92 + rand() * 0.16))
    }
    const perHour = 40 + rand() * 120
    const coverageH = perHour > 0 && current > 0 ? current / perHour : NO_USE_COVERAGE
    rows.push({
      sku: s.sku,
      max,
      current,
      coverageH,
      thresholds: { ...DEFAULT_THRESHOLDS },
    })
  }
  return rows
}

/* ═══════════════════════════════════════════════════════════════════
   buildMockPipelineForWarehouse — copy 100% LivePage L46-155 (seed ||)
   ═══════════════════════════════════════════════════════════════════ */
export function buildMockPipelineForWarehouse(
  model: string,
  nodeKey: string,
  rows: WarehouseSkuRow[],
  horizon_h = 8,
  overrideSeed?: number,
): WarehousePipelineView {
  const seed = hashCode(model + '||' + nodeKey + (overrideSeed ? String(overrideSeed) : rows.map(r => `${r.sku}:${r.current}`).join('|')))
  const rand = mulberry32(seed)

  const on_hand = rows.reduce((s, r) => s + r.current, 0)
  const demandFactor = clamp(0.35 + rand() * 0.9, 0.35, 1.25)
  const demand_total = Math.max(rows.length * 10, Math.round(on_hand * demandFactor))
  const inboundFactor = clamp(0.2 + rand() * 1.15, 0.2, 1.3)
  const inbound_total = Math.round(demand_total * inboundFactor)

  const avail = on_hand + inbound_total
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

  const inboundCount = 2 + Math.floor(rand() * 5)
  const inbound: InboundRow[] = []
  let inboundSum = 0
  const statuses: InboundRow['status'][] = ['IN_TRANSIT', 'DOCKED', 'BOOKED', 'IN_TRANSIT']
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
      shortage_qty: Math.max(0, demandSum - (on_hand + inboundSum)),
      coverage_remaining_h: coverageH,
    },
    adequacy,
    inbound,
    demand,
    timeline_h,
  }
}

/* ═══════════════════════════════════════════════════════════════════
   buildMockWarehouseHistory — FLOW-FIRST, CLAMP COMPENSATION CÁCH (b)
   Algorithm:
    1. Sinh in[t]/out[t] pattern realistic (peak 8h-18h 2.5× đêm)
    2. Tính từ phải→trái NGƯỢC từ anchor cuối (level[T-1] = on_hand_total)
    3. KHI CLAMP KÍCH HOẠT (<0 hoặc >cap): ĐIỀU CHỈNH TRỰC TIẾP in[t] và out[t]
       để level[t-1] nằm trong [0, cap]. Như vậy Σ(in) - Σ(out) = last - first
       là IDENTITY TOÁN HỌC (vì phép điều chỉnh bù trực tiếp vào vế phải).
   ═══════════════════════════════════════════════════════════════════ */
export function buildMockWarehouseHistory(
  modelKey: string, nodeKey: string, windowDays: number,
  anchorOnHandTotal: number, capTotal: number,
): WarehouseSeriesEntry[] {
  const rand = mulberry32(hashCode(modelKey + '|whist|' + nodeKey + '|' + windowDays))
  const T = windowDays * 24
  const inArr: number[] = new Array(T).fill(0)
  const outArr: number[] = new Array(T).fill(0)
  const levelArr: number[] = new Array(T).fill(0)
  levelArr[T - 1] = anchorOnHandTotal

  // B1: Sinh flow pattern, scale nhỏ so với cap để clamp ít xảy ra
  const perHourBase = Math.max(50, Math.round(Math.min(anchorOnHandTotal, capTotal) / (windowDays * 55)))
  for (let t = 0; t < T; t++) {
    const hour = t % 24
    const isPeak = hour >= 8 && hour <= 18
    const peakFactor = isPeak ? 2.5 : 0.6
    const dayFactor = 0.82 + rand() * 0.38
    const variationIn = 0.8 + rand() * 0.5
    const variationOut = 0.72 + rand() * 0.62
    inArr[t] = Math.max(0, Math.round(perHourBase * peakFactor * dayFactor * variationIn))
    outArr[t] = Math.max(10, Math.round(perHourBase * peakFactor * dayFactor * variationOut))
    // USER YÊU CẦU: out24h LUÔN > 0 (không bao giờ rơi vào coverage 99 nhánh cover demo).
    // Đã có Math.max(10, ...) → out tối thiểu 10/giờ → 240/ngày.
  }

  // B2: Tính NGƯỢC từ phải sang trái + CÁCH (b) ĐIỀU CHỈNH in/out khi clamp để identity đúng
  for (let t = T - 1; t >= 1; t--) {
    const lt = levelArr[t]
    let prevLevel = lt - inArr[t] + outArr[t]
    if (prevLevel < 0) {
      // Cần tăng prevLevel về 0: tăng outArr[t] (cộng vào) HOẶC giảm inArr[t] (trừ đi)
      const delta = 0 - prevLevel   // dương, cần bù vào
      // Ưu tiên giảm nhập trước để giữ flow hợp lý
      const reduceIn = Math.min(inArr[t], delta)
      inArr[t] -= reduceIn
      const remain = delta - reduceIn
      // Còn thiếu thì tăng xuất
      outArr[t] += remain
      prevLevel = 0
    } else if (prevLevel > capTotal) {
      // Cần giảm prevLevel về capTotal: giảm outArr[t] HOẶC tăng inArr[t]
      const delta = prevLevel - capTotal  // dương, cần cắt bớt
      const reduceOut = Math.min(outArr[t], delta)
      outArr[t] -= reduceOut
      const remain = delta - reduceOut
      // Còn thiếu thì tăng nhập (tăng nhập làm tăng level? Sai, level[t-1] = lt - in + out
      // → muốn GIẢM prevLevel: giảm out HOẶC tăng in? TĂNG in làm trừ đi thêm → prev GIẢM. Đúng.
      inArr[t] += remain
      prevLevel = capTotal
    }
    levelArr[t - 1] = prevLevel
  }

  // B3: ASSERT IDENTITY (tính toán từ mảng cuối cùng, không dựa vào giả định)
  let sumIn = 0, sumOut = 0
  for (let t = 0; t < T; t++) { sumIn += inArr[t]; sumOut += outArr[t] }
  const deltaNet = sumIn - sumOut
  const deltaLevel = levelArr[T - 1] - levelArr[0]
  if (Math.abs(deltaNet - deltaLevel) > 0.5) {
    // Safety fallback nếu còn lệch do rounding 0.5-1 → bù vào first entry
    const diff = deltaLevel - deltaNet
    if (diff > 0) inArr[0] += Math.round(diff)
    else outArr[0] += Math.round(-diff)
  }

  // B4: Build entries
  const now_s = Math.floor(Date.now() / 1000)
  const entries: WarehouseSeriesEntry[] = []
  const avgOutPerHour = Math.max(1, sumOut / T)
  for (let t = 0; t < T; t++) {
    const ts = now_s - (T - 1 - t) * 3600
    const lvl = levelArr[t]
    const cap = capTotal
    const cov = lvl > 0 ? (lvl / avgOutPerHour) : NO_USE_COVERAGE
    entries.push({
      ts_s: ts,
      sku: '__all__',
      node_key: nodeKey,
      level: lvl,
      capacity: cap,
      coverage_h: cov,
      color: colorFor(cov, DEFAULT_THRESHOLDS),
      inbound_qty: inArr[t],
      outbound_qty: outArr[t],
    })
    // consume fmtDayHour unused var lint
    void fmtDayHour
  }
  return entries
}

/* ═══════════════════════════════════════════════════════════════════
   buildMockWarehouseDashboard — SSoT DERIVATION TOÀN BỘ
   ═══════════════════════════════════════════════════════════════════ */
export function buildMockWarehouseDashboard(
  modelKey: string,
  nodeKey: string,
  nodeName: string,
  windowDays = 14,
): WarehouseDashboardView {
  // F1: SKU rows
  const skuRows = buildMockSkuRows(modelKey, nodeKey, 5)
  // F2 + F3 + F4 = SSoT (tính TỪ SKU, KHÔNG random độc lập)
  const on_hand_total = skuRows.reduce((s, r) => s + r.current, 0)
  const capacity_total = Math.max(1, skuRows.reduce((s, r) => s + r.max, 0))
  const fill_pct = 100 * on_hand_total / capacity_total

  // F3: History (neo cuối = on_hand_total EXACT)
  const history_14d = buildMockWarehouseHistory(modelKey, nodeKey, windowDays, on_hand_total, capacity_total)

  // F4: 24h cuối Vào/Ra (TỪ HISTORY, không random)
  const N24 = Math.min(24, history_14d.length)
  const last24 = history_14d.slice(-N24)
  const inbound_last_24h = last24.reduce((s, e) => s + (e.inbound_qty ?? 0), 0)
  const outbound_last_24h = Math.max(1, last24.reduce((s, e) => s + (e.outbound_qty ?? 0), 0))
  // USER YÊU CẦU out24h luôn > 0: đã có Math.max(1, ...) + history out tối thiểu 10/h → out24h tối thiểu 240.

  const net_flow_last_24h = inbound_last_24h - outbound_last_24h
  // F7 B9 Coverage same window 24h (user yêu cầu):
  const coverage_remaining_h = outbound_last_24h > 0 ? (on_hand_total / (outbound_last_24h / 24)) : NO_USE_COVERAGE

  // F8: Pipeline 8h
  const pipeline = buildMockPipelineForWarehouse(modelKey, nodeKey, skuRows, 8)

  // F9: Efficiency (ok random, không có data thật để derive)
  const randEf = mulberry32(hashCode(modelKey + '|whef|' + nodeKey))
  const efficiency: WarehouseEfficiencyRow = {
    window_days: windowDays,
    oee_pct: Math.round((68 + randEf() * 22) * 10) / 10,
    accuracy_pct: Math.round((92 + randEf() * 6.5) * 10) / 10,
    availability_pct: Math.round((85 + randEf() * 12) * 10) / 10,
    avg_turnover_per_day: Math.round((0.6 + randEf() * 1.8) * 100) / 100,
    avg_fill_rate_pct: Math.round((88 + randEf() * 9) * 10) / 10,
  }

  // F10: Alerts = ĐIỀU KIỆN TÍNH TỪ HERO (KHÔNG RANDOM)
  const alerts: WarehouseAlertRow[] = []
  const nowISO = new Date().toISOString()
  const startT = new Date(Date.now() - 1_800_000).toISOString()
  if (fill_pct > 88) {
    alerts.push({
      alert_id: 'ALW-OVERSTOCK', kind: 'OVERSTOCK', sku: skuRows[0]?.sku,
      severity: 'HIGH', title: 'Tồn dư vượt ngưỡng 88%',
      detail: 'Kho đang chứa hàng quá ngưỡng an toàn, nguy cơ giảm giá hoặc hết date.',
      value_current: Math.round(fill_pct * 10) / 10, value_threshold: 88,
      started_at: startT, acknowledged: false,
    })
  }
  if (fill_pct < 18) {
    alerts.push({
      alert_id: 'ALW-UNDERSTOCK', kind: 'UNDERSTOCK', sku: skuRows[0]?.sku,
      severity: 'HIGH', title: 'Tồn dưới ngưỡng 18%',
      detail: 'Tồn kho quá thấp, cần tăng tốc nhập hàng để tránh mất đơn.',
      value_current: Math.round(fill_pct * 10) / 10, value_threshold: 18,
      started_at: startT,
    })
  }
  if (coverage_remaining_h < 12) {
    alerts.push({
      alert_id: 'ALW-OVERLOAD-DEMAND', kind: 'OVERLOAD_DEMAND',
      severity: 'HIGH', title: 'Chỉ còn dưới 12 giờ hàng',
      detail: 'Nhu cầu 24 giờ tới cao, khả năng thiêu hàng cao nếu không bù kịp.',
      value_current: Math.round(coverage_remaining_h * 10) / 10, value_threshold: 12,
      started_at: startT,
    })
  }
  if (efficiency.oee_pct < 68) {
    alerts.push({
      alert_id: 'ALW-SLA-BREACH', kind: 'SLA_BREACH',
      severity: 'MEDIUM', title: 'OEE thấp hơn SLA 68%',
      detail: 'Hiệu suất kho dưới ngưỡng quy ước, kiểm tra quy trình xếp dỡ.',
      value_current: efficiency.oee_pct, value_threshold: 68,
      started_at: startT,
    })
  }
  if (inbound_last_24h > outbound_last_24h * 1.6) {
    alerts.push({
      alert_id: 'ALW-OVERLOAD-IN', kind: 'OVERLOAD_INBOUND',
      severity: 'MEDIUM', title: 'Vào gấp 1.6 lần Ra',
      detail: 'Dòng hàng vào quá lớn, bãi xếp chờ có thể quá tải.',
      value_current: Math.round(100 * inbound_last_24h / Math.max(1, outbound_last_24h)) / 100,
      value_threshold: 1.6, started_at: startT,
    })
  }
  // Sort HIGH=0, MED=1, LOW=2
  const severityOrder: Record<WarehouseAlertRow['severity'], number> = { HIGH: 0, MEDIUM: 1, LOW: 2 }
  alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])

  const high_alert_count = alerts.filter(a => a.severity === 'HIGH').length

  return {
    node_key: nodeKey,
    node_name: nodeName || nodeKey,
    model_key: modelKey,
    as_of: nowISO,
    hero: {
      on_hand_total,
      capacity_total,
      fill_pct: Math.round(fill_pct * 10) / 10,
      coverage_remaining_h: Math.round(coverage_remaining_h * 10) / 10,
      inbound_last_24h,
      outbound_last_24h,
      net_flow_last_24h,
      high_alert_count,
    },
    pipeline,
    history_14d,
    efficiency,
    alerts,
    sku_rows: skuRows,
  }
}
