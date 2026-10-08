import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { Graph, GraphNode, LiveSnapshot, ModelSummary, NodeType, SubjectSnap } from '../api/types'
import { FeedControl } from '../components/live/FeedControl'
import { Card, EmptyState, ErrorBox, Loading, PageBody, PageHeader, btn, btnPrimary, input } from '../components/ui'
import { useModelGraph } from '../hooks/useModelGraph'
import { fmtDateTime, fmtDelta } from '../lib/format'
import { nodeBadge, summarize } from '../lib/liveFrame'
import { thresholdsFor } from '../lib/model'
import { NO_USE_COVERAGE, colorFor } from '../lib/replay'

const DEFAULT_MODEL = 'bimbo-fmcg'
const STALE_MS = 15000
const NO_TYPES: Record<string, NodeType> = {}

type MaterialRow = {
  material: string
  current: number
  max: number
  headroom: number
  pct: number
  coverageH: number | undefined
  demandPerHour: number
  incomingEdges: Array<{ from: string; material: string; flow?: number }>
  outgoingEdges: Array<{ to: string; material: string; flow?: number }>
  color: string
}

type StorageRow = {
  key: string
  name: string
  nodeType: string
  materials: MaterialRow[]
  state?: string
  stateTs?: string
  ageMs: number
  badgeText?: string
  badgeColor?: string
  worstPct: number
  worstCoverage: number | undefined
}

function num(v: number | null | undefined, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return v.toFixed(digits).replace('.', ',')
}

function pctColor(p: number) {
  if (p >= 92) return 'bg-bad'
  if (p >= 78) return 'bg-warn'
  if (p <= 12) return 'bg-bad'
  if (p <= 28) return 'bg-warn'
  return 'bg-ok'
}

function toneFromColor(color?: string) {
  if (color === 'RED') return 'border-bad/50 bg-bad-bg text-bad-text'
  if (color === 'YELLOW') return 'border-warn/50 bg-warn-bg text-warn-text'
  if (color === 'GREEN') return 'border-ok/50 bg-ok-bg text-ok-text'
  return 'border-line-2 bg-panel text-muted'
}

function storageStockConfig(node: GraphNode): Array<{ material: string; initial: number; max: number }> {
  const raw = (node.params?.stock ?? []) as unknown[]
  const out: Array<{ material: string; initial: number; max: number }> = []
  for (const x of raw) {
    if (x && typeof x === 'object') {
      const o = x as { material?: unknown; initial?: unknown; max?: unknown }
      const material = typeof o.material === 'string' ? o.material : ''
      const initial = typeof o.initial === 'number' ? o.initial : Number(o.initial) || 0
      const max = typeof o.max === 'number' ? o.max : Number(o.max) || 0
      if (material) out.push({ material, initial, max })
    }
  }
  return out
}

function levelSignalsOf(s: SubjectSnap | undefined): Record<string, number> {
  if (!s) return {}
  const out: Record<string, number> = {}
  for (const [name, sv] of Object.entries(s.signals)) {
    if (name.startsWith('level:')) {
      const m = name.slice(6)
      if (m && typeof sv?.v === 'number') out[m] = sv.v
    }
  }
  return out
}

function buildRows(graph: Graph, types: Record<string, NodeType>, snapshot: LiveSnapshot | undefined, current: number): StorageRow[] {
  const stores = graph.nodes.filter((n) => (n.archetype ?? types[n.node_type]?.archetype) === 'STORAGE')
  const byKey = Object.fromEntries(graph.nodes.map((n) => [n.key, n]))
  const nameOf = (k: string) => byKey[k]?.name ?? k
  const rows: StorageRow[] = []
  const now = snapshot ? Date.parse(snapshot.now) : current
  for (const n of stores) {
    const cfg = storageStockConfig(n)
    const snap = snapshot?.subjects[n.key]
    const liveLevels = levelSignalsOf(snap)
    const ref = { node_type: n.node_type, params: n.params }
    const th = thresholdsFor(ref, types)
    const badge = nodeBadge('STORAGE', snap, th)
    const snapTs = snap?.state_ts && !Number.isNaN(Date.parse(snap.state_ts)) ? Date.parse(snap.state_ts) : now
    const ageMs = snap ? Math.max(0, (now - snapTs) + (snap.age_ms ?? 0)) : 0
    const coverageV = snap?.signals?.coverage_h?.v
    const matRows: MaterialRow[] = []
    const incoming = graph.edges.filter((e) => e.dst === n.key)
    const outgoing = graph.edges.filter((e) => e.src === n.key)
    let worstPct = -1
    let worstCoverage: number | undefined
    const materials = cfg.length > 0 ? cfg.map((c) => c.material) : Object.keys(liveLevels)
    for (const m of materials) {
      const c = cfg.find((x) => x.material === m)
      const currentLevel = liveLevels[m] ?? (c ? c.initial : 0)
      const max = c?.max ?? Math.max(0, currentLevel * 1.2)
      const pct = max > 0 ? Math.min(100, (currentLevel / max) * 100) : 0
      if (worstPct < 0 || pct < worstPct) worstPct = pct
      if (coverageV !== undefined && (worstCoverage === undefined || coverageV < worstCoverage)) worstCoverage = coverageV
      const color = colorFor(coverageV, th)
      const rate = snap?.rate ?? 0
      matRows.push({
        material: m,
        current: currentLevel,
        max,
        headroom: Math.max(0, max - currentLevel),
        pct,
        coverageH: coverageV,
        demandPerHour: rate,
        incomingEdges: incoming.filter((e) => e.material === m).map((e) => ({ from: nameOf(e.src), material: e.material, flow: snapshot?.subjects[e.src]?.rate })),
        outgoingEdges: outgoing.filter((e) => e.material === m).map((e) => ({ to: nameOf(e.dst), material: e.material, flow: snapshot?.subjects[e.dst]?.rate })),
        color,
      })
    }
    rows.push({
      key: n.key,
      name: n.name ?? n.key,
      nodeType: n.node_type,
      materials: matRows,
      state: snap?.state,
      stateTs: snap?.state_ts,
      ageMs: ageMs,
      badgeText: badge?.text,
      badgeColor: badge?.color,
      worstPct,
      worstCoverage,
    })
  }
  rows.sort((a, b) => {
    const aCov = a.worstCoverage ?? Infinity
    const bCov = b.worstCoverage ?? Infinity
    if (aCov !== bCov) return aCov - bCov
    return a.worstPct - b.worstPct
  })
  return rows
}

export default function WarehouseControlPage() {
  const models = useQuery({ queryKey: ['models'], queryFn: api.models, staleTime: 60_000 })
  const items = models.data ?? []
  const defaultKey = items.find((m: ModelSummary) => m.model_key === DEFAULT_MODEL)?.model_key
    ?? items.find((m: ModelSummary) => m.status === 'PUBLISHED')?.model_key
    ?? items[0]?.model_key
  const [modelKey, setModelKey] = useState<string>(defaultKey ?? '')
  const currentModel = modelKey || defaultKey || ''
  const g = useModelGraph(currentModel)
  const live = useQuery({ queryKey: ['live', currentModel], queryFn: () => api.live(currentModel), enabled: !!currentModel, refetchInterval: 3000 })
  const modelsError = models.error as Error | null
  const graphError = g.status === 'none' && currentModel ? new Error('Mô hình chưa có phiên bản Publish') : null
  const liveError = live.error as Error | null
  const err = modelsError ?? graphError ?? liveError
  const types = g.status === 'ready' ? g.types : NO_TYPES
  const graph = g.status === 'ready' ? g.graph : undefined
  const snapshot = live.data
  // ⚠ Rules of Hooks: useMemo PHẢI gọi TRƯỚC TẤT CẢ conditional returns.
  // Nếu graph chưa load → rows = [] an toàn, sau đó return <Loading/> đúng logic.
  const rows = useMemo(() => (graph ? buildRows(graph, types, snapshot, live.dataUpdatedAt) : []), [graph, types, snapshot, live.dataUpdatedAt])

  if (models.isLoading) return <Loading />
  if (items.length === 0) return <EmptyState title="Chưa có mô hình nào">Tạo mô hình ở trang Mô hình hoặc chạy scripts/seed_demo.py để có mẫu.</EmptyState>
  if (g.status === 'loading') return <Loading />
  if (g.status === 'none') return <EmptyState title="Mô hình chưa có phiên bản Publish">Mô hình này chưa có phiên bản nào được Publish. Publish một phiên bản rồi quay lại.</EmptyState>
  if (!graph) return <Loading />
  const totalCapacity = rows.reduce((a, r) => a + r.materials.reduce((b, m) => b + m.max, 0), 0)
  const totalStock = rows.reduce((a, r) => a + r.materials.reduce((b, m) => b + m.current, 0), 0)
  const overallPct = totalCapacity > 0 ? (totalStock / totalCapacity) * 100 : 0
  const badges = graph.nodes.map((n) => ({
    archetype: (n.archetype ?? types[n.node_type]?.archetype) ?? '',
    badge: nodeBadge((n.archetype ?? types[n.node_type]?.archetype) ?? '', snapshot?.subjects[n.key], thresholdsFor({ node_type: n.node_type, params: n.params }, types)),
  }))
  const summary = summarize(badges)

  return (
    <PageBody wide>
      <PageHeader
        title="Điều khiển kho"
        subtitle={currentModel}
        actions={
          <div className="flex items-center gap-2">
            <select className={input} value={modelKey} onChange={(e) => setModelKey(e.target.value)} aria-label="Chọn mô hình">
              {items.map((m: ModelSummary) => <option key={m.model_key} value={m.model_key}>{m.model_key} (v{m.latest_version})</option>)}
            </select>
            <Link className={btn} to={`/models/${encodeURIComponent(currentModel)}/live`}>Sơ đồ trực tiếp</Link>
            <Link className={btnPrimary} to="/reports/operations">Dashboard vận hành</Link>
          </div>
        }
      />
      <ErrorBox error={err} />
      <FeedControl model={currentModel} />
      <div className="mt-4 grid grid-cols-4 gap-4">
        <Card title="Số lượng kho">
          <div className="text-3xl font-semibold text-text">{rows.length}</div>
          <div className="mt-1 text-xs text-muted">Trong phiên bản đã Publish của <b>{currentModel}</b>.</div>
        </Card>
        <Card title="Tổng dung lượng / tồn kho">
          <div className="text-3xl font-semibold text-text">{num(totalStock, 0)} / {num(totalCapacity, 0)}</div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-panel-2">
            <div className={`h-full ${pctColor(overallPct)}`} style={{ width: `${Math.min(100, overallPct)}%` }} />
          </div>
          <div className="mt-1 text-xs text-muted">Lấp đầy {num(overallPct, 1)}% tổng dung lượng.</div>
        </Card>
        <Card title="Tình hình kho đỏ / vàng">
          <div className="text-3xl font-semibold">
            <span className="text-bad-text">{summary.redStorages}</span>
            <span className="mx-2 text-muted">/</span>
            <span className="text-warn-text">{summary.yellowStorages}</span>
          </div>
          <div className="mt-1 text-xs text-muted">Kho Đỏ (sắp hết hàng) / Kho Vàng (hơi ít hoặc hơi đầy).</div>
        </Card>
        <Card title="Tiêu cực khác">
          <div className="text-3xl font-semibold">
            <span className="text-bad-text">{summary.downMachines}</span>
            <span className="mx-2 text-muted">·</span>
            <span className={summary.stale > 0 ? 'text-bad-text' : 'text-ok'}>{summary.stale}</span>
          </div>
          <div className="mt-1 text-xs text-muted">Máy hỏng · Nút mất tín hiệu (hơn 15s không cập nhật).</div>
        </Card>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-4">
        <div className="col-span-2 space-y-4">
          {rows.length === 0 ? (
            <Card title="Chi tiết tồn kho theo kho">
              <div className="text-xs text-muted">Mô hình này chưa định nghĩa node loại STORAGE. Thêm kho ở tab Sơ đồ rồi Publish lại phiên bản.</div>
            </Card>
          ) : rows.map((r) => {
            const titleLine = `${r.name}${r.badgeText ? ` · ${r.badgeText}` : ''} · ${r.nodeType}`
            const subLine = `${r.state ? `${r.state} · ` : ''}cập nhật ${r.ageMs > STALE_MS ? `quá ${Math.round(r.ageMs / 1000)}s (mất tín hiệu)` : `${Math.round(r.ageMs / 1000)}s trước`}`
            return (
              <Card
                key={r.key}
                title={`${titleLine} — ${subLine}`}
              >
                <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="py-1.5 pr-3 font-medium">Vật tư</th>
                    <th className="py-1.5 pr-3 font-medium">Tồn / Dung lượng</th>
                    <th className="py-1.5 pr-3 font-medium">Lấp đầy</th>
                    <th className="py-1.5 pr-3 font-medium">Giờ phủ</th>
                    <th className="py-1.5 pr-3 font-medium">Lưu vào / Ra</th>
                  </tr>
                </thead>
                <tbody>
                  {r.materials.length === 0 && (
                    <tr><td colSpan={5} className="py-2 text-muted">Kho này chưa khai báo vật tư và chưa nhận tín hiệu level.</td></tr>
                  )}
                  {r.materials.map((m) => (
                    <tr key={m.material} className="border-t border-line align-top">
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-text">{m.material}</span>
                          {m.color && <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${toneFromColor(m.color)}`}>
                            {m.coverageH === undefined ? 'chưa đo' : m.coverageH >= NO_USE_COVERAGE ? 'không tiêu thụ' : `${num(m.coverageH, 1)}h`}
                          </span>}
                        </div>
                      </td>
                      <td className="py-2 pr-3 tabular-nums text-text">
                        <div>{num(m.current, 0)} / {m.max > 0 ? num(m.max, 0) : '—'}</div>
                        <div className="text-[11px] text-muted">chừa {num(m.headroom, 0)}</div>
                      </td>
                      <td className="py-2 pr-3 w-[200px]">
                        <div className="h-2 w-full overflow-hidden rounded-full bg-panel-2">
                          <div className={`h-full ${pctColor(m.pct)}`} style={{ width: `${Math.min(100, m.pct)}%` }} />
                        </div>
                        <div className="mt-1 text-[11px] text-muted tabular-nums">{num(m.pct, 1)}%</div>
                      </td>
                      <td className="py-2 pr-3 tabular-nums text-text">
                        {m.coverageH === undefined ? '—' : m.coverageH >= NO_USE_COVERAGE ? '∞' : `${num(m.coverageH, 1)} h`}
                        <div className="text-[11px] text-muted">tiêu thụ {num(m.demandPerHour, 1)}/h</div>
                      </td>
                      <td className="py-2 pr-3">
                        <div className="text-muted">
                          vào: {m.incomingEdges.length === 0 ? <span className="text-faint">—</span> : m.incomingEdges.map((e, i) => (
                            <span key={i}>{i > 0 ? ', ' : ''}<span className="text-text">{e.from}</span>{e.flow ? ` ${fmtDelta(e.flow)}/h` : ''}</span>
                          ))}
                        </div>
                        <div className="mt-0.5 text-muted">
                          ra: {m.outgoingEdges.length === 0 ? <span className="text-faint">—</span> : m.outgoingEdges.map((e, i) => (
                            <span key={i}>{i > 0 ? ', ' : ''}<span className="text-text">{e.to}</span>{e.flow ? ` ${fmtDelta(e.flow)}/h` : ''}</span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </Card>
            )
          })}
        </div>
        <div className="space-y-4">
          <Card title="Cảnh báo">
            {rows.filter((r) => r.badgeColor === 'RED' || r.badgeColor === 'YELLOW').length === 0 && (
              <p className="text-xs text-muted">Chưa có cảnh báo Vàng hay Đỏ nào ở kho. Tốt lắm.</p>
            )}
            {rows.filter((r) => r.badgeColor === 'RED' || r.badgeColor === 'YELLOW').map((r) => (
              <div key={r.key} className="mb-2 rounded-lg border border-line px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 text-[10.5px] font-semibold ${toneFromColor(r.badgeColor)}`}>{r.badgeText}</span>
                  <span className="text-sm font-medium text-text">{r.name}</span>
                </div>
                <div className="mt-1 text-[11.5px] text-muted">
                  tồn tồi nhất {num(r.worstPct, 1)}% dung lượng
                  {r.worstCoverage !== undefined && r.worstCoverage < NO_USE_COVERAGE && <> · phủ {num(r.worstCoverage, 1)}h</>}
                </div>
              </div>
            ))}
          </Card>
          <Card title="Nguồn dữ liệu kho">
            {!snapshot && <p className="text-xs text-muted">Chưa có live snapshot. Bật Feed để hệ thống ghi giá trị.</p>}
            {snapshot && (
              <>
                <div className="text-xs">
                  <div>Mốc live: <span className="tabular-nums text-text">{fmtDateTime(snapshot.now)}</span></div>
                  <div className="mt-1">Ghép nối: {snapshot.bindings} binding · {snapshot.errors.length} lỗi ghép</div>
                </div>
                {snapshot.errors.length > 0 && (
                  <ul className="mt-2 space-y-1 text-[11.5px]">
                    {snapshot.errors.slice(0, 5).map((e, i) => <li key={i} className="rounded border border-line bg-panel-2 px-2 py-1 text-bad-text">{e.message} <span className="text-muted">×{e.count}</span></li>)}
                  </ul>
                )}
              </>
            )}
          </Card>
          <QuickActions model={currentModel} rows={rows} />
        </div>
      </div>
    </PageBody>
  )
}

function QuickActions({ model, rows }: { model: string; rows: StorageRow[] }) {
  const qc = useQueryClient()
  const [target, setTarget] = useState(rows[0]?.key ?? '')
  const [material, setMaterial] = useState<string>('')
  const [qty, setQty] = useState<number>(100)
  const chosen = rows.find((r) => r.key === target)
  const matList = chosen?.materials ?? []
  const effMaterial = matList.find((m) => m.material === material)?.material ?? matList[0]?.material ?? ''
  const effCurrent = matList.find((m) => m.material === effMaterial)?.current ?? 0
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['feed-status'] })
    void qc.invalidateQueries({ queryKey: ['live', model] })
  }
  const add = useMutation({ mutationFn: (body: Parameters<typeof api.feed.addIncident>[0]) => api.feed.addIncident(body), onSuccess: refresh })
  if (rows.length === 0) {
    return (
      <Card title="Điều chỉnh nhanh kho">
        <p className="text-xs text-muted">Chưa có kho nào trong mô hình. Hoàn thành Sơ đồ rồi Publish phiên bản mới.</p>
      </Card>
    )
  }
  const go = () => {
    if (!effMaterial) return
    const frac = effCurrent > 0 ? Math.min(1, Math.max(0, qty / effCurrent)) : Math.min(1, Math.max(0, qty / 1000))
    add.mutate({ model, kind: 'stock_drain', target, material: effMaterial, fraction: frac })
  }
  return (
    <Card title="Điều chỉnh nhanh kho">
      <div className="space-y-2 text-xs">
        <select className={`${input} w-full`} aria-label="Kho" value={target} onChange={(e) => setTarget(e.target.value)}>
          {rows.map((r) => <option key={r.key} value={r.key}>{r.name} ({r.materials.length} vật tư)</option>)}
        </select>
        <select className={`${input} w-full`} aria-label="Vật tư" value={effMaterial} onChange={(e) => setMaterial(e.target.value)} disabled={matList.length === 0}>
          {matList.length === 0 && <option value="">(không có vật tư)</option>}
          {matList.map((m) => <option key={m.material} value={m.material}>{m.material} · còn {num(m.current, 0)} / max {num(m.max, 0)}</option>)}
        </select>
        <input className={input} type="number" min={0} value={qty} onChange={(e) => setQty(Number(e.target.value))}
          aria-label="Số lượng rút bớt" />
        <div className="text-[11px] text-muted">
          Tồn hiện tại {num(effCurrent, 0)} · Rút {effCurrent > 0 ? num(Math.min(100, (qty / effCurrent) * 100), 1) : '—'}%
          (tối đa 100%). Feed ghi nhận một lần incident loại stock_drain.
        </div>
        <button className={`${btnPrimary} w-full justify-center`} disabled={!effMaterial || add.isPending || qty <= 0} onClick={go}>
          {add.isPending ? 'Đang gửi…' : `Rút ${qty} ${effMaterial}`}
        </button>
        <ErrorBox error={add.error} />
      </div>
    </Card>
  )
}
