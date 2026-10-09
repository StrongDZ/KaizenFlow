import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Boxes, Warehouse, TrendingUp, TrendingDown, Sparkles,
  Factory, Truck, Wallet, type LucideIcon, AlertTriangle,
} from 'lucide-react'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'
import { api } from '../api/client'
import type {
  ModelSummary, PerformanceKpis, PerfMachineRow, PerfFleetRow,
  PerfStorageRow, PerfFinanceRow, PerfSeriesPoint,
} from '../api/types'
import { EmptyState, ErrorBox, Loading, PageBody } from '../components/ui'
import { fmtDateTime, fmtDelta } from '../lib/format'
import { LIVE_GRID, LiveModelRow } from '../components/live/LiveModelRow'
import { useFeeds } from '../hooks/useLive'
import { byCode } from '../lib/model'

/* ═══════════════════════════════════════════════════════════════════════════
   HELPERS — Seeded PRNG (mulberry32) để mock dữ liệu DETERMINISTIC theo model
   → cùng dữ liệu models trong DB → dashboard giống hệt mọi lần F5.
   ═══════════════════════════════════════════════════════════════════════════ */
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
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/* --- Format helpers (local mini cho dashboard, không chạm format.ts) --- */
function fmtNumber(v: number, digits = 0): string {
  if (!Number.isFinite(v)) return '—'
  return v.toLocaleString('vi-VN', { maximumFractionDigits: digits, minimumFractionDigits: digits })
}
function fmtPercent(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return '—'
  return v.toFixed(digits).replace('.', ',') + '%'
}
function fmtCompactVND(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs >= 1e9) return (v / 1e9).toFixed(1).replace('.', ',') + ' tỷ'
  if (abs >= 1e6) return (v / 1e6).toFixed(1).replace('.', ',') + ' tr'
  if (abs >= 1e3) return (v / 1e3).toFixed(0).replace('.', ',') + ' k'
  return fmtNumber(v, 0) + ' đ'
}

/* --- Polarity mapping: chỉ số nào tăng = tốt, chỉ số nào giảm = tốt --- */
type Polarity = 'higher-better' | 'lower-better'
const POLARITY: Record<string, Polarity> = {
  revenue_wow_pct: 'higher-better',
  oee_wow_pct: 'higher-better',
  pallets_wow_pct: 'higher-better',
  margin_wow_pct: 'higher-better',
  wow_delta_oee: 'higher-better',
  wow_delta_pallets: 'higher-better',
  wow_delta_coverage: 'higher-better',
  wow_delta_margin: 'higher-better',
  red_minutes_14d: 'lower-better',
  wait_pool_avg_min: 'lower-better',
  delivery_lateness_pct: 'lower-better',
}
function polarityClass(metricKey: string, delta: number, fallbackOk = true): string {
  if (Math.abs(delta) < 0.05) return 'bg-panel-2 text-muted border-line-2'
  const pol: Polarity = POLARITY[metricKey] ?? (fallbackOk ? 'higher-better' : 'lower-better')
  const good = pol === 'higher-better' ? delta > 0 : delta < 0
  return good
    ? 'bg-ok-bg/70 text-ok-text border-ok/30'
    : 'bg-err-bg/70 text-err-text border-err/30'
}
function deltaIcon(delta: number): LucideIcon { return delta >= 0 ? TrendingUp : TrendingDown }

/* --- State / Band color chips --- */
const MACHINE_STATE_COLOR: Record<PerfMachineRow['state'], string> = {
  RUNNING: 'bg-ok-bg text-ok-text border-ok/40',
  IDLE:    'bg-warn-bg text-warn-text border-warn/40',
  BLOCKED: 'bg-info-bg text-info-text border-info/40',
  DOWN:    'bg-err-bg text-err-text border-err/40',
  UNKNOWN: 'bg-panel-2 text-muted border-line-2',
}
const FLEET_STATE_COLOR: Record<PerfFleetRow['state'], string> = {
  ACTIVE:      'bg-ok-bg text-ok-text border-ok/40',
  IDLE:        'bg-panel-2 text-muted border-line-2',
  MAINTENANCE: 'bg-warn-bg text-warn-text border-warn/40',
  CHARGING:    'bg-info-bg text-info-text border-info/40',
  UNKNOWN:     'bg-panel-2 text-muted border-line-2',
}
const STORAGE_BAND_COLOR: Record<PerfStorageRow['band_color'], string> = {
  GREEN:  'bg-ok-bg text-ok-text border-ok/40',
  YELLOW: 'bg-warn-bg text-warn-text border-warn/40',
  RED:    'bg-err-bg text-err-text border-err/40',
}
const FINANCE_GRADE_COLOR: Record<PerfFinanceRow['grade'], string> = {
  'TIỆN LỢI': 'bg-ok-bg text-ok-text border-ok/40',
  'CÂN BẰNG': 'bg-warn-bg text-warn-text border-warn/40',
  'LỖ':       'bg-err-bg text-err-text border-err/40',
}

/* ═══════════════════════════════════════════════════════════════════════════
   MOCK GENERATOR — deterministic dựa trên model last_run_at / model_key
   Sau khi backend implement endpoint thật → chỉ cần đổi queryFn trong
   usePerformanceKpis 1 chỗ thôi, UI KHÔNG sửa 1 dòng.
   ═══════════════════════════════════════════════════════════════════════════ */
function series14d(rng: () => number, base: number, vol: number, trend: number): PerfSeriesPoint[] {
  const out: PerfSeriesPoint[] = []
  const today = new Date()
  let v = base
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i)
    v = clamp(v + (rng() - 0.5) * vol + trend / 14, base * 0.5, base * 1.5)
    out.push({ t: d.toISOString().slice(0, 10), v: Number(v.toFixed(3)) })
  }
  return out
}

function buildMockKpis(models: ModelSummary[], topN = 5): PerformanceKpis {
  const mkDefault = (idx: number): ModelSummary => ({
    model_key: `plant-${idx + 1}`,
    latest_version: 1,
    latest_version_id: idx + 100,
    status: 'PUBLISHED',
    scenarios: 2,
    runs: 4,
    last_run_at: new Date(Date.now() - idx * 86_400_000).toISOString(),
  })
  const ms = (models?.length ?? 0) > 0 ? models : [mkDefault(0), mkDefault(1), mkDefault(2)]
  const baseSeed = ms.reduce((acc, m) => acc ^ hashCode(m.model_key + '|' + (m.last_run_at ?? '')), 0xA5A5A5A5)
  const rng = mulberry32(baseSeed)

  const as_of = new Date().toISOString()
  const hero = {
    revenue_7d_vnd: Math.round(lerp(4.8e9, 12.6e9, rng())),
    revenue_wow_pct: Number(((rng() - 0.4) * 18).toFixed(1)),
    oee_avg_pct:    Number(lerp(70, 92, rng()).toFixed(1)),
    oee_wow_pct:    Number(((rng() - 0.45) * 8).toFixed(1)),
    pallets_ph_avg: Number(lerp(38, 126, rng()).toFixed(0)),
    pallets_wow_pct: Number(((rng() - 0.4) * 14).toFixed(1)),
    margin_avg_pct: Number(lerp(14, 34, rng()).toFixed(1)),
    margin_wow_pct: Number(((rng() - 0.45) * 6).toFixed(1)),
  }

  /* --- Máy móc --- */
  const MACHINE_KINDS = [
    { kind: 'Máy đóng gói', nt: 'PACKER' },
    { kind: 'Máy dán tem',  nt: 'LABELER' },
    { kind: 'Máy trộn',     nt: 'MIXER' },
    { kind: 'Máy nạp',      nt: 'FILLER' },
    { kind: 'Nồi hấp',      nt: 'COOKER' },
    { kind: 'Băng tải',     nt: 'CONVEYOR' },
    { kind: 'Máy ép',       nt: 'PRESS' },
    { kind: 'Sàng lọc',     nt: 'SIFTER' },
  ]
  const MACHINE_STATES: PerfMachineRow['state'][] = ['RUNNING', 'RUNNING', 'RUNNING', 'IDLE', 'BLOCKED', 'DOWN']
  const machines: PerfMachineRow[] = []
  for (let i = 0; i < Math.max(topN, ms.length * 2); i++) {
    const m = ms[i % ms.length]
    const k = MACHINE_KINDS[i % MACHINE_KINDS.length]
    const oee = clamp(lerp(58, 96, rng()), 0, 100)
    machines.push({
      key: `${m.model_key}-mach-${i + 1}`,
      name: `${k.kind} ${String.fromCharCode(65 + (i % 6))}-${i + 1}`,
      node_type: k.nt,
      model_key: m.model_key,
      oee: Number(oee.toFixed(1)),
      availability: Number(clamp(oee + (rng() - 0.3) * 6, 0, 100).toFixed(1)),
      performance:  Number(clamp(oee + (rng() - 0.4) * 5, 0, 100).toFixed(1)),
      quality:      Number(clamp(96 + (rng() - 0.3) * 4, 0, 100).toFixed(1)),
      throughput_ph: Number(lerp(120, 1800, rng()).toFixed(0)),
      wow_delta_oee: Number(((rng() - 0.45) * 9).toFixed(1)),
      oee_series_14d: series14d(mulberry32(baseSeed + i * 31 + 1), oee, 4, (rng() - 0.4) * 6),
      state: MACHINE_STATES[Math.floor(rng() * MACHINE_STATES.length)],
    })
  }
  machines.sort((a, b) => b.oee - a.oee)

  /* --- Xe vận chuyển --- */
  const FLEET_KINDS: PerfFleetRow['kind'][] = ['AGV', 'TUGGER', 'FORKLIFT']
  const FLEET_STATES: PerfFleetRow['state'][] = ['ACTIVE', 'ACTIVE', 'ACTIVE', 'IDLE', 'CHARGING', 'MAINTENANCE']
  const fleet: PerfFleetRow[] = []
  for (let i = 0; i < Math.max(topN, ms.length * 2); i++) {
    const m = ms[i % ms.length]
    const kind = FLEET_KINDS[i % 3]
    const pallets = kind === 'FORKLIFT' ? lerp(8, 28, rng()) : kind === 'TUGGER' ? lerp(18, 56, rng()) : lerp(28, 96, rng())
    fleet.push({
      key: `${m.model_key}-fleet-${i + 1}`,
      name: `${kind}-${String(i + 1).padStart(2, '0')}`,
      kind,
      model_key: m.model_key,
      pallets_ph: Number(pallets.toFixed(1)),
      km_total_14d: Number(lerp(40, 520, rng()).toFixed(0)),
      wait_pool_avg_min: Number(lerp(0.6, 11, rng()).toFixed(1)),
      delivery_lateness_pct: Number(clamp(lerp(0.4, 12, rng()), 0, 100).toFixed(1)),
      wow_delta_pallets: Number(((rng() - 0.42) * 15).toFixed(1)),
      series_14d: series14d(mulberry32(baseSeed + i * 31 + 7), pallets, pallets * 0.15, (rng() - 0.45) * pallets * 0.3),
      state: FLEET_STATES[Math.floor(rng() * FLEET_STATES.length)],
    })
  }
  fleet.sort((a, b) => b.pallets_ph - a.pallets_ph)

  /* --- Kho lưu trữ --- */
  const STORAGE_KINDS = [
    { name: 'Kho Nguyên liệu', nt: 'RAW_STORAGE' },
    { name: 'Kho Bán thành phẩm', nt: 'WIP_STORAGE' },
    { name: 'Kho Thành phẩm', nt: 'FG_STORAGE' },
    { name: 'Kho Hạ tầng', nt: 'MAINT_STORAGE' },
    { name: 'Kho Lạnh', nt: 'COLD_STORAGE' },
    { name: 'Kho Return', nt: 'RETURN_STORAGE' },
  ]
  const storage: PerfStorageRow[] = []
  for (let i = 0; i < Math.max(topN, ms.length * 2); i++) {
    const m = ms[i % ms.length]
    const k = STORAGE_KINDS[i % STORAGE_KINDS.length]
    const coverage = lerp(6, 120, rng())
    const redMin = lerp(0, 1800, rng())
    const band: PerfStorageRow['band_color'] = coverage >= 36 && redMin < 180 ? 'GREEN' : coverage >= 12 && redMin < 600 ? 'YELLOW' : 'RED'
    storage.push({
      key: `${m.model_key}-wh-${i + 1}`,
      name: `${k.name} ${m.model_key.slice(0, 3).toUpperCase()}-${i + 1}`,
      node_type: k.nt,
      model_key: m.model_key,
      coverage_h_avg: Number(coverage.toFixed(1)),
      inbound_ph: Number(lerp(18, 360, rng()).toFixed(0)),
      outbound_ph: Number(lerp(14, 320, rng()).toFixed(0)),
      red_minutes_14d: Number(redMin.toFixed(0)),
      fill_pct_avg: Number(lerp(38, 94, rng()).toFixed(1)),
      wow_delta_coverage: Number(((rng() - 0.45) * 14).toFixed(1)),
      coverage_series_14d: series14d(mulberry32(baseSeed + i * 31 + 13), coverage, coverage * 0.2, (rng() - 0.5) * coverage * 0.25),
      band_color: band,
    })
  }
  storage.sort((a, b) => a.band_color.localeCompare(b.band_color) || b.coverage_h_avg - a.coverage_h_avg)

  /* --- Kinh tế / Tài chính (theo từng model / phân khu) --- */
  const FINANCE_NAMES = ['Phân khu Đóng gói', 'Phân khu Sản xuất', 'Nhà máy Tổng thể', 'Chuỗi Cung ứng', 'Dự án Mới']
  const finance: PerfFinanceRow[] = []
  for (let i = 0; i < Math.max(topN, ms.length); i++) {
    const m = ms[i % ms.length]
    const revenue = Math.round(lerp(1.2e9, 8.8e9, rng()))
    const opCost = Math.round(revenue * lerp(0.44, 0.66, rng()))
    const holdCost = Math.round(revenue * lerp(0.05, 0.14, rng()))
    const scrapCost = Math.round(revenue * lerp(0.008, 0.05, rng()))
    const margin = (revenue - opCost - holdCost - scrapCost) / revenue * 100
    const grade: PerfFinanceRow['grade'] = margin >= 22 ? 'TIỆN LỢI' : margin >= 10 ? 'CÂN BẰNG' : 'LỖ'
    finance.push({
      key: `${m.model_key}-fin-${i + 1}`,
      name: ms.length <= 1 ? FINANCE_NAMES[i % FINANCE_NAMES.length] : `${m.model_key} · ${FINANCE_NAMES[i % FINANCE_NAMES.length]}`,
      revenue_14d_vnd: revenue,
      operating_cost_14d_vnd: opCost,
      holding_cost_14d_vnd: holdCost,
      scrap_cost_14d_vnd: scrapCost,
      gross_margin_pct: Number(margin.toFixed(1)),
      wow_delta_margin: Number(((rng() - 0.45) * 5).toFixed(1)),
      margin_series_14d: series14d(mulberry32(baseSeed + i * 31 + 19), margin, 3, (rng() - 0.5) * 2),
      revenue_series_14d: (() => {
        const s = series14d(mulberry32(baseSeed + i * 31 + 23), revenue / 14, revenue * 0.06, 0)
        return s.map((p) => ({ ...p, v: Math.round(p.v) }))
      })(),
      grade,
    })
  }
  finance.sort((a, b) => b.gross_margin_pct - a.gross_margin_pct)

  return {
    as_of,
    hero,
    machines: machines.slice(0, topN),
    fleet:    fleet.slice(0, topN),
    storage:  storage.slice(0, topN),
    finance:  finance.slice(0, topN),
    top_n: topN,
  }
}

/**
 * Hook lấy KPI hiệu năng tổng thể.
 * → Hiện tại dùng mock data DETERMINISTIC (cùng input → cùng output)
 * → Khi backend xong endpoint thật, chỉ cần thay thế queryFn dưới đây =
 *     () => api.performanceKpis({ window: '14d', top_n: topN })
 *   là xong; UI KHÔNG sửa 1 dòng.
 */
function usePerformanceKpis(models: ModelSummary[], topN = 5) {
  return useQuery({
    queryKey: ['perf-kpis', models.map((m) => m.model_key).join('|'), topN, models.map((m) => m.last_run_at ?? '').join('|')],
    queryFn: () => Promise.resolve(buildMockKpis(models, topN)),
    staleTime: Infinity,
    gcTime: Infinity,
  })
}

/* ═══════════════════════════════════════════════════════════════════════════
   UI PRIMITIVES — Sparkline mini, Delta chip, Hero card, Module card
   ═══════════════════════════════════════════════════════════════════════════ */
const SPARK_COLOR = '#6366f1'
const SPARK_COLOR_GOOD = '#10b981'
const SPARK_COLOR_BAD  = '#ef4444'

function SparklineMini({
  data,
  height = 44,
  tone = 'neutral',
}: { data: PerfSeriesPoint[]; height?: number; tone?: 'neutral' | 'good' | 'bad' }) {
  if (!data || data.length === 0) return <div style={{ height }} className="w-full" />
  const color = tone === 'good' ? SPARK_COLOR_GOOD : tone === 'bad' ? SPARK_COLOR_BAD : SPARK_COLOR
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <defs>
            <linearGradient id={`sp-${tone}-${color.slice(1)}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"  stopColor={color} stopOpacity={0.55} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.4}
            fill={`url(#sp-${tone}-${color.slice(1)})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function DeltaChip({ metricKey, value, showIcon = true, fallbackGood = true }:
  { metricKey: string; value: number; showIcon?: boolean; fallbackGood?: boolean }) {
  const cls = polarityClass(metricKey, value, fallbackGood)
  const Icon = deltaIcon(value)
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums ${cls}`}>
      {showIcon && <Icon size={10} strokeWidth={2.2} />}
      {fmtDelta(value)}
    </span>
  )
}

const CARD_BASE = 'rounded-xl border border-line bg-panel'

function HeroKpiCard({
  icon: Icon, title, value, metricKey, delta, hint, series, tone,
}: {
  icon: LucideIcon; title: string; value: React.ReactNode; metricKey: string;
  delta: number; hint?: string; series: PerfSeriesPoint[]; tone?: 'accent' | 'good' | 'warn' | 'err';
}) {
  // Thẻ không tô nền theo tốt/xấu: chiều tăng giảm đã nằm ở chip chênh lệch và màu đường xu hướng.
  const toneCls = tone === 'err' ? 'border-err/40' : 'border-line'
  const sparkTone =
    tone === 'good' ? 'good' : tone === 'err' ? 'bad' : 'neutral'
  return (
    <div className={`${CARD_BASE} relative overflow-hidden ${toneCls} p-4`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
            <Icon size={13} strokeWidth={1.9} /> {title}
          </div>
          <div className="text-2xl font-semibold tabular-nums leading-none text-text tracking-tight">{value}</div>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <DeltaChip metricKey={metricKey} value={delta} />
            {hint && <span className="text-[10.5px] text-muted">{hint}</span>}
          </div>
        </div>
      </div>
      <div className="mt-2 -mx-1 -mb-1 opacity-90">
        <SparklineMini data={series} height={44} tone={sparkTone} />
      </div>
    </div>
  )
}

function ModuleCard<C extends { key: string; name: string }>({
  title, subtitle, icon: Icon, rows, children,
}: {
  title: string; subtitle?: string; icon: LucideIcon;
  rows: C[]; children: (row: C, idx: number) => React.ReactNode;
}) {
  return (
    <section className={`${CARD_BASE} flex flex-col overflow-hidden`}>
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex items-start gap-2.5">
          <div className="flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-line-2 bg-panel-2 text-text-2">
            <Icon size={16} strokeWidth={1.9} />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-[13.5px] font-semibold text-text">{title}</h3>
            {subtitle && <p className="mt-0.5 text-[11px] text-muted">{subtitle}</p>}
          </div>
        </div>
        <span className="rounded-md border border-line-2 bg-panel-2 px-1.5 py-0.5 text-[10px] font-medium text-muted tabular-nums">
          Top {rows.length}
        </span>
      </header>
      <div className="divide-y divide-line">
        {rows.length === 0 ? (
          <div className="!rounded-none !border-none !p-6">
            <EmptyState title="Chưa có dữ liệu">
              Chạy mô phỏng hoặc bật live feed để thấy số liệu thực tế tại đây.
            </EmptyState>
          </div>
        ) : (
          rows.map((r, i) => (
            <div key={r.key} className="flex items-stretch gap-3 px-4 py-3 hover:bg-panel-2/50 transition">
              <div className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-md bg-panel-2 text-[10.5px] font-semibold tabular-nums text-muted">
                {i + 1}
              </div>
              {children(r, i)}
            </div>
          ))
        )}
      </div>
    </section>
  )
}

const chipBase = 'rounded-md border px-1.5 py-0.5 text-[10px] font-medium capitalize'

/* ═══════════════════════════════════════════════════════════════════════════
   PAGE — Dashboard tổng thể hiệu năng
   ═══════════════════════════════════════════════════════════════════════════ */
export default function OverviewPage() {
  /* ═══ Rules of Hooks ═══
     TẤT CẢ useX() phải gọi TRƯỚC mọi early return / isLoading check.
     Không bao giờ di chuyển khối này xuống dưới conditional return. */
  const models = useQuery({ queryKey: ['models'], queryFn: api.models })
  const perf   = usePerformanceKpis(models.data ?? [], 5)
  // Mô hình đang vận hành thật: feed đang phát hoặc tạm dừng. Mỗi mô hình có feed riêng, nhiều mô hình chạy song song.
  const feeds = useFeeds()
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  const typeMap = useMemo(() => byCode(types.data ?? []), [types.data])
  const live = useMemo(
    () => (feeds.data ?? []).filter((f) => f.model && f.state !== 'idle').sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || (a.model ?? '').localeCompare(b.model ?? '')),
    [feeds.data],
  )

  // ————— isLoading check ĐẶT Ở CUỐI khối hooks (không sớm hơn) —————
  const isLoading = models.isLoading || perf.isLoading
  if (isLoading) {
    return (
      <PageBody wide>
        <Loading />
      </PageBody>
    )
  }

  const kpis = perf.data!
  const hero = kpis.hero

  /* Hero series tái sử dụng từ module row đầu tiên của từng loại (đủ 14 mục) */
  const heroRevenueSeries = kpis.finance[0]?.revenue_series_14d ?? []
  const heroOeeSeries     = kpis.machines[0]?.oee_series_14d ?? []
  const heroPalletSeries  = kpis.fleet[0]?.series_14d ?? []
  const heroMarginSeries  = kpis.finance[0]?.margin_series_14d ?? []

  return (
    <PageBody wide>
      <ErrorBox error={models.error ?? perf.error} />

      {/* ════════════════════════════════════════════════════════════════════
          HERO BANNER — Gradient blur + Tóm tắt điều hành (Executive Summary)
          ════════════════════════════════════════════════════════════════════ */}
      <section className="relative overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-panel via-panel to-panel-2 px-5 py-4 sm:px-6 sm:py-5">
        <div aria-hidden className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-accent/15 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-28 -left-12 h-60 w-60 rounded-full bg-ok/10 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute right-1/3 top-1/2 h-40 w-40 rounded-full bg-warn/10 blur-3xl" />

        <div className="relative flex flex-wrap items-center justify-between gap-6">
          <div className="flex max-w-2xl flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-line-2 bg-panel/60 px-2.5 py-0.5 text-[10.5px] font-medium text-text-2">
                <Sparkles size={11} strokeWidth={2} className="text-accent" />
                Tổng quan hiệu năng
              </span>
              <span className="rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-[10.5px] text-warn-text" title="Các chỉ số máy, xe, kho và tài chính trên trang này đang sinh từ dữ liệu mẫu, chưa nối API thật">Số liệu minh hoạ</span>
            </div>
            <h1 className="text-xl font-semibold leading-snug tracking-tight text-text">
              Hiệu năng vận hành nhà máy <span className="font-normal text-muted">—</span> <span className="text-accent">cập nhật {fmtDateTime(kpis.as_of)}</span>
            </h1>
            <p className="max-w-xl text-[12.5px] leading-relaxed text-muted">
              Chỉ số cốt lõi trên bốn trụ cột: <b className="font-medium text-text-2">máy móc, xe vận chuyển, kho lưu trữ và tài chính</b>.
              Mỗi thẻ bên dưới dẫn tới nơi xem chi tiết và xử lý.
            </p>
          </div>

          {/* Số liệu nhanh bên phải */}
          <div className="grid w-full max-w-md grid-cols-2 gap-2 sm:w-auto">
            <div className="flex flex-col gap-0.5 rounded-xl border border-line bg-panel/80 px-3 py-2">
              <div className="flex items-center gap-1.5 text-[10.5px] text-muted"><Boxes size={11} /> Mô hình</div>
              <div className="text-base font-semibold tabular-nums leading-tight text-text">{models.data?.length ?? 0}</div>
              <div className="text-[10px] text-muted">{live.length} đang chạy trực tiếp</div>
            </div>
            <div className="flex flex-col gap-0.5 rounded-xl border border-line bg-panel/80 px-3 py-2">
              <div className="flex items-center gap-1.5 text-[10.5px] text-muted"><Warehouse size={11} /> Kho & Máy</div>
              <div className="text-base font-semibold tabular-nums leading-tight text-text">{fmtNumber(kpis.storage.length + kpis.machines.length)}</div>
              <div className="text-[10px] text-muted">{kpis.fleet.length} phương tiện vận hành</div>
            </div>
            <div className="flex flex-col gap-0.5 rounded-xl border border-line bg-panel/80 px-3 py-2">
              <div className="flex items-center gap-1.5 text-[10.5px] text-muted"><AlertTriangle size={11} /> Kho nguy cơ Đỏ</div>
              <div className="text-base font-semibold tabular-nums leading-tight text-err-text">{kpis.storage.filter((s) => s.band_color === 'RED').length}</div>
              <div className="text-[10px] text-muted">{kpis.storage.filter((s) => s.band_color === 'YELLOW').length} đang cảnh báo Vàng</div>
            </div>
            <div className="flex flex-col gap-0.5 rounded-xl border border-line bg-panel/80 px-3 py-2">
              <div className="flex items-center gap-1.5 text-[10.5px] text-muted"><Factory size={11} /> Máy đang chạy</div>
              <div className="text-base font-semibold tabular-nums leading-tight text-ok-text">{kpis.machines.filter((m) => m.state === 'RUNNING').length}</div>
              <div className="text-[10px] text-muted">{kpis.machines.filter((m) => m.state === 'DOWN').length} máy đang lỗi</div>
            </div>
          </div>
        </div>
      </section>

      {/* Mô hình đang chạy trực tiếp: số thật từ feed và trạng thái live, mỗi dòng mở đúng mô hình đó. */}
      <section className="overflow-hidden rounded-xl border border-line bg-panel-2" aria-labelledby="live-models">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2.5">
          <h2 id="live-models" className="text-[13px] font-semibold text-text">Đang chạy trực tiếp</h2>
          <span className="text-xs text-muted">
            {feeds.isError ? 'không nối được dịch vụ feed' : `${live.length} mô hình${live.length > 1 ? ', chạy song song' : ''}`}
          </span>
          <Link to="/models" className="ml-auto text-xs text-accent hover:underline">Tất cả mô hình</Link>
        </header>
        {live.length > 0 ? (
          <>
            <div className={`${LIVE_GRID} border-b border-line px-3 py-1.5 text-[11px] text-muted`}>
              <span>Feed</span><span>Mô hình</span><span>Cần chú ý</span><span className="text-right">Giờ nhà máy</span><span />
            </div>
            {live.map((f) => <LiveModelRow key={f.model} feed={f} types={typeMap} />)}
          </>
        ) : (
          <p className="px-3 py-5 text-xs text-muted">
            {feeds.isPending ? 'Đang tải…' : <>Chưa mô hình nào đang phát dữ liệu. Mở <Link to="/models" className="text-accent hover:underline">Mô hình</Link>, chọn một mô hình rồi vào Trực tiếp để bắt đầu phát; nhiều mô hình có thể chạy cùng lúc.</>}
          </p>
        )}
      </section>

      {/* ════════════════════════════════════════════════════════════════════
          HERO 4 KPI LỚN — Dễ hiểu, dễ nói trong Hội đồng chấm (demo-ready)
          ════════════════════════════════════════════════════════════════════ */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="KPI tổng thể điều hành">
        <HeroKpiCard
          icon={Wallet} title="Doanh thu 7 ngày"
          value={fmtCompactVND(hero.revenue_7d_vnd)}
          metricKey="revenue_wow_pct" delta={hero.revenue_wow_pct}
          hint="so với 14 ngày trước"
          series={heroRevenueSeries}
          tone={hero.revenue_wow_pct >= 0 ? 'good' : 'err'}
        />
        <HeroKpiCard
          icon={Factory} title="OEE TB máy móc"
          value={fmtPercent(hero.oee_avg_pct)}
          metricKey="oee_wow_pct" delta={hero.oee_wow_pct}
          hint="Availability × Perf × Quality"
          series={heroOeeSeries}
          tone={hero.oee_avg_pct >= 82 ? 'good' : hero.oee_avg_pct >= 70 ? 'warn' : 'err'}
        />
        <HeroKpiCard
          icon={Truck} title="Pallet / giờ (fleet)"
          value={fmtNumber(hero.pallets_ph_avg)}
          metricKey="pallets_wow_pct" delta={hero.pallets_wow_pct}
          hint="không tính thời gian bảo dưỡng"
          series={heroPalletSeries}
          tone={hero.pallets_wow_pct >= 0 ? 'good' : 'err'}
        />
        <HeroKpiCard
          icon={TrendingUp} title="Gross margin TB"
          value={fmtPercent(hero.margin_avg_pct)}
          metricKey="margin_wow_pct" delta={hero.margin_wow_pct}
          hint="(revenue − op/holding/scrap)/revenue"
          series={heroMarginSeries}
          tone={hero.margin_avg_pct >= 22 ? 'good' : hero.margin_avg_pct >= 12 ? 'warn' : 'err'}
        />
      </section>

      {/* ════════════════════════════════════════════════════════════════════
          4 MODULE CARDS — Responsive lg 2 cột / md 1 cột
          ════════════════════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ———————————— (1) MÁY MÓC ———————————— */}
        <ModuleCard<PerfMachineRow>
          title="Hiệu năng máy móc"
          subtitle="OEE, 3 yếu tố cấu thành, trạng thái hiện tại & xu hướng 14 ngày"
          icon={Factory}
          rows={kpis.machines}
        >
          {(r) => (
            <>
              <div className="min-w-0 flex-1 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Link to={`/versions/${models.data?.find((m) => m.model_key === r.model_key)?.latest_version_id ?? ''}`}
                    className="truncate text-[13px] font-semibold text-text hover:underline underline-offset-2">
                    {r.name}
                  </Link>
                  <span className={`${chipBase} bg-panel-2 text-muted border-line-2`}>{r.node_type}</span>
                  <span className={`${chipBase} ${MACHINE_STATE_COLOR[r.state]}`}>{r.state}</span>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted sm:grid-cols-4">
                  <span>OEE <b className="text-text tabular-nums">{fmtPercent(r.oee)}</b></span>
                  <span>Availability <b className="text-text tabular-nums">{fmtPercent(r.availability)}</b></span>
                  <span>Performance <b className="text-text tabular-nums">{fmtPercent(r.performance)}</b></span>
                  <span>Quality <b className="text-text tabular-nums">{fmtPercent(r.quality)}</b></span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-[11px] text-muted">
                    Năng suất <b className="text-text tabular-nums">{fmtNumber(r.throughput_ph)}</b> đơn vị/giờ
                  </span>
                  <DeltaChip metricKey="wow_delta_oee" value={r.wow_delta_oee} />
                </div>
              </div>
              <div className="w-[30%] min-w-[120px] flex-none flex flex-col justify-between">
                <SparklineMini data={r.oee_series_14d} height={52}
                  tone={r.oee >= 82 ? 'good' : r.oee >= 70 ? 'neutral' : 'bad'} />
              </div>
            </>
          )}
        </ModuleCard>

        {/* ———————————— (2) XE VẬN CHUYỂN (Fleet) ———————————— */}
        <ModuleCard<PerfFleetRow>
          title="Hiệu năng xe vận chuyển"
          subtitle="Pallet/giờ, km đã đi, độ trễ giao hàng & thời gian chờ tại bãi"
          icon={Truck}
          rows={kpis.fleet}
        >
          {(r) => (
            <>
              <div className="min-w-0 flex-1 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate text-[13px] font-semibold text-text">{r.name}</span>
                  <span className={`${chipBase} bg-panel-2 text-muted border-line-2`}>{r.kind}</span>
                  <span className={`${chipBase} ${FLEET_STATE_COLOR[r.state]}`}>{r.state}</span>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted sm:grid-cols-4">
                  <span>Pallet/giờ <b className="text-text tabular-nums">{fmtNumber(r.pallets_ph, 1)}</b></span>
                  <span>14 ngày <b className="text-text tabular-nums">{fmtNumber(r.km_total_14d)} km</b></span>
                  <span>Chờ bãi <b className={`tabular-nums ${r.wait_pool_avg_min > 6 ? 'text-err-text' : 'text-text'}`}>{fmtNumber(r.wait_pool_avg_min, 1)} ph</b></span>
                  <span>Trễ kế hoạch <b className={`tabular-nums ${r.delivery_lateness_pct > 6 ? 'text-err-text' : 'text-text'}`}>{fmtPercent(r.delivery_lateness_pct)}</b></span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[11px] text-muted">Model: <b className="text-text">{r.model_key}</b></span>
                  <DeltaChip metricKey="wow_delta_pallets" value={r.wow_delta_pallets} />
                </div>
              </div>
              <div className="w-[30%] min-w-[120px] flex-none flex flex-col justify-between">
                <SparklineMini data={r.series_14d} height={52}
                  tone={r.wow_delta_pallets >= 0 ? 'good' : 'bad'} />
              </div>
            </>
          )}
        </ModuleCard>

        {/* ———————————— (3) KHO LƯU TRỮ ———————————— */}
        <ModuleCard<PerfStorageRow>
          title="Hiệu năng kho lưu trữ"
          subtitle="Độ phủ tồn kho (giờ), lưu thông nhập/xuất, phút Đỏ & Fill %"
          icon={Warehouse}
          rows={kpis.storage}
        >
          {(r) => (
            <>
              <div className="min-w-0 flex-1 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Link to={`/models/${encodeURIComponent(r.model_key)}/live`}
                    className="truncate text-[13px] font-semibold text-text hover:underline underline-offset-2">
                    {r.name}
                  </Link>
                  <span className={`${chipBase} bg-panel-2 text-muted border-line-2`}>{r.node_type}</span>
                  <span className={`${chipBase} ${STORAGE_BAND_COLOR[r.band_color]}`}>BAND {r.band_color}</span>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted sm:grid-cols-4">
                  <span>Coverage <b className="text-text tabular-nums">{fmtNumber(r.coverage_h_avg, 1)} giờ</b></span>
                  <span>Nhập / giờ <b className="text-text tabular-nums">{fmtNumber(r.inbound_ph)}</b></span>
                  <span>Xuất / giờ <b className="text-text tabular-nums">{fmtNumber(r.outbound_ph)}</b></span>
                  <span>Fill <b className="text-text tabular-nums">{fmtPercent(r.fill_pct_avg)}</b></span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-[11px]">
                    Phút Đỏ 14 ngày:{' '}
                    <b className={`tabular-nums ${r.red_minutes_14d > 600 ? 'text-err-text' : r.red_minutes_14d > 180 ? 'text-warn-text' : 'text-ok-text'}`}>
                      {fmtNumber(r.red_minutes_14d)}
                    </b>
                  </span>
                  <DeltaChip metricKey="wow_delta_coverage" value={r.wow_delta_coverage} />
                </div>
              </div>
              <div className="w-[30%] min-w-[120px] flex-none flex flex-col justify-between">
                <SparklineMini data={r.coverage_series_14d} height={52}
                  tone={r.band_color === 'GREEN' ? 'good' : r.band_color === 'RED' ? 'bad' : 'neutral'} />
              </div>
            </>
          )}
        </ModuleCard>

        {/* ———————————— (4) KINH TẾ / TÀI CHÍNH ———————————— */}
        <ModuleCard<PerfFinanceRow>
          title="Hiệu năng kinh tế"
          subtitle="Doanh thu, chi phí 3 loại (vận hành / tồn kho / phế phẩm), Gross margin & xếp loại"
          icon={Wallet}
          rows={kpis.finance}
        >
          {(r) => {
            const totalCost = r.operating_cost_14d_vnd + r.holding_cost_14d_vnd + r.scrap_cost_14d_vnd
            return (
              <>
                <div className="min-w-0 flex-1 flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-[13px] font-semibold text-text">{r.name}</span>
                    <span className={`${chipBase} ${FINANCE_GRADE_COLOR[r.grade]}`}>{r.grade}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted sm:grid-cols-4">
                    <span>Doanh thu 14d <b className="text-text tabular-nums">{fmtCompactVND(r.revenue_14d_vnd)}</b></span>
                    <span>Vận hành <b className="text-text tabular-nums">{fmtCompactVND(r.operating_cost_14d_vnd)}</b></span>
                    <span>Tồn kho <b className="text-text tabular-nums">{fmtCompactVND(r.holding_cost_14d_vnd)}</b></span>
                    <span>Phế phẩm <b className="text-text tabular-nums">{fmtCompactVND(r.scrap_cost_14d_vnd)}</b></span>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-[11px] text-muted">
                      Tổng chi phí <b className="text-text tabular-nums">{fmtCompactVND(totalCost)}</b>
                      {' · '}
                      Margin <b className={`tabular-nums ${r.gross_margin_pct >= 22 ? 'text-ok-text' : r.gross_margin_pct >= 12 ? 'text-warn-text' : 'text-err-text'}`}>
                        {fmtPercent(r.gross_margin_pct)}
                      </b>
                    </span>
                    <DeltaChip metricKey="wow_delta_margin" value={r.wow_delta_margin} />
                  </div>
                </div>
                <div className="w-[30%] min-w-[120px] flex-none flex flex-col justify-between gap-1">
                  <SparklineMini data={r.revenue_series_14d} height={24}
                    tone={r.grade === 'TIỆN LỢI' ? 'good' : r.grade === 'LỖ' ? 'bad' : 'neutral'} />
                  <SparklineMini data={r.margin_series_14d} height={24}
                    tone={r.wow_delta_margin >= 0 ? 'good' : 'bad'} />
                </div>
              </>
            )
          }}
        </ModuleCard>
      </div>

    </PageBody>
  )
}
