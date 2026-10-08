import { useQuery } from '@tanstack/react-query'
import { Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { ChevronLeft, ChevronRight, CircleStop, Download, PlayCircle, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import type { BandRow, Graph, NodeType, RunDetail, Scenario } from '../api/types'
import { Dock } from '../components/controlroom/Dock'
import { PinCard } from '../components/controlroom/PinCard'
import { Ribbon } from '../components/controlroom/Ribbon'
import { RunGate } from '../components/controlroom/RunGate'
import { FitOnResize } from '../components/FitOnResize'
import { kfEdgeTypes } from '../components/KfEdge'
import { KfNodeContext, RUN_NODES, kfNodeTypes } from '../components/KfNode'
import { WarehousePopover, type WarehouseSkuRow } from '../components/WarehousePopover'
import { HeaderActions, useShell } from '../components/shell/ShellContext'
import { useParentRun } from '../hooks/useParentRun'
import { useTheme } from '../hooks/useTheme'
import { PinDot } from '../components/PinDot'
import { btn, btnGhost } from '../components/ui'
import { atCursor } from '../lib/atCursor'
import { cycleSeconds, dotCount, peakRate, travelSeconds } from '../lib/flow'
import { fmtTime } from '../lib/format'
import { toFlow, type Badge, type FlowNode, type PinView } from '../lib/graph'
import { candidatesOf, describeAction, describeInsight, kpiP50, type Action } from '../lib/insights'
import { poolCount, thresholdsFor } from '../lib/model'
import { effectiveParams } from '../lib/nodeSummary'
import { runRows } from '../lib/runNode'
import { assignPins, pinsByNode, type Pin } from '../lib/pins'
import { isTypingTarget, nextSpeed, stepIndex, tickMs, type Speed } from '../lib/playback'
import { clip, colorFor, indexBands, series, timeline, valueAt, type BandIndex } from '../lib/replay'
import { failureMarks, maintenanceAt, maintenanceWindows, redZones, rulerOf } from '../lib/ruler'
import { downstreamKeys, storyBookmarks } from '../lib/scenarioExperience'
import { nearestIndex } from '../lib/ruler'

export default function ControlRoomPage() {
  const runId = Number(useParams().id)
  return (
    <RunGate runId={runId} needBands>
      {({ run, scenario, graph, types, rows }) => (
        <ReactFlowProvider>
          <Room run={run} scenario={scenario} graph={graph} types={types} rows={rows} />
        </ReactFlowProvider>
      )}
    </RunGate>
  )
}

/** Dòng trạng thái của kho: số giờ tồn còn đủ dùng, màu theo ngưỡng của chính kho đó. Node khác không có ngưỡng nên không có dòng này. */
function badgeFor(n: FlowNode, idx: BandIndex, t: number, types: Record<string, NodeType>): Badge | undefined {
  if (n.data.archetype !== 'STORAGE') return undefined
  const ref = { node_type: n.data.nodeType, params: n.data.params }
  const cov = valueAt(series(idx, n.id, 'coverage_h'), t)?.p50
  if (cov === undefined) return undefined
  return {
    color: colorFor(cov, thresholdsFor(ref, types)), text: cov >= 999 ? 'Không tiêu thụ' : `Đủ dùng ${cov.toFixed(1).replace('.', ',')} giờ`,
    hint: 'Tồn kho đủ dùng thêm chừng này ở tốc độ tiêu thụ gần đây. Xanh là ổn, Vàng là hơi thiếu hoặc thừa, Đỏ là sắp hết hàng.',
  }
}

/** Mọi chỉ số của một node tại thời điểm t (trung vị qua các lần lặp). */
function valuesAt(idx: BandIndex, key: string, t: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [metric, points] of idx.get(key) ?? []) {
    const p = valueAt(points, t)
    if (p) out[metric] = p.p50
  }
  return out
}

/** Tổng sức chứa khai báo của kho; thiếu ở một vật tư thì không tính được. */
function maxStockOf(n: FlowNode, types: Record<string, NodeType>): number | undefined {
  const stock = effectiveParams(n.data.params, types[n.data.nodeType]).stock
  if (!Array.isArray(stock) || stock.length === 0) return undefined
  const maxes = stock.map((x) => (typeof x === 'object' && x !== null ? (x as { max?: unknown }).max : undefined))
  return maxes.every((m) => typeof m === 'number') ? (maxes as number[]).reduce((a, b) => a + b, 0) : undefined
}

function Room({ run, scenario, graph, types, rows }: {
  run: RunDetail; scenario: Scenario; graph: Graph; types: Record<string, NodeType>; rows: BandRow[]
}) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const rf = useReactFlow()
  const { focus, setFocus } = useShell()
  const { theme } = useTheme()
  const idx = useMemo(() => indexBands(rows), [rows])
  const times = useMemo(() => timeline(idx), [idx])
  const last = Math.max(0, times.length - 1)
  const [ti, setTi] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<Speed>(1)
  const [openPin, setOpenPin] = useState<number | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const [storyOpen, setStoryOpen] = useState(searchParams.get('story') === '1')
  const [storyIndex, setStoryIndex] = useState(0)
  const [storyPlaying, setStoryPlaying] = useState(false)
  const t = times[ti] ?? 0
  const hasTime = times.length > 0

  useEffect(() => {
    if (!playing) return
    const h = setInterval(() => setTi((i) => Math.min(i + 1, last)), tickMs(speed))
    return () => clearInterval(h)
  }, [playing, speed, last])
  useEffect(() => { if (ti >= last) setPlaying(false) }, [ti, last])

  const togglePlay = useCallback(() => {
    if (ti >= last) setTi(0)
    setPlaying((p) => !p)
  }, [ti, last])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target as HTMLElement | null) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === ' ') {
        if ((e.target as HTMLElement | null)?.tagName === 'BUTTON') return
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'f' || e.key === 'F') setFocus((f) => !f)
      else if (e.key === 'Escape') setFocus(false)
      else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
        e.preventDefault()
        setPlaying(false)
        setTi((i) => stepIndex(i, times.length, e.key, e.shiftKey))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, setFocus, times.length])

  const flow = useMemo(() => toFlow(graph, types), [graph, types])
  const pins = useMemo(() => assignPins(run.insights), [run.insights])
  const byNode = useMemo(() => pinsByNode(pins), [pins])
  const recs = useMemo(() => run.insights.filter((i) => i.kind === 'RECOMMENDATION'), [run.insights])
  const cursor = useMemo(() => atCursor(idx, graph.nodes, types, t), [idx, graph.nodes, types, t])
  const zones = useMemo(() => redZones(idx, graph.nodes, types, rulerOf(times).step), [idx, graph.nodes, types, times])
  const maintenance = useMemo(() => maintenanceWindows(scenario.injections, run.sim_start), [scenario.injections, run.sim_start])
  const appliedAction = scenario.origin === 'RECOMMENDER' && scenario.action
    ? scenario.action as unknown as Action
    : undefined
  const events = useQuery({ queryKey: ['events', run.id, 'FAILURE'], queryFn: () => api.events(run.id, { type: 'FAILURE' }) })
  const marks = useMemo(() => failureMarks(events.data ?? []), [events.data])
  const bookmarks = useMemo(() => storyBookmarks({ times, events: events.data ?? [], maintenance, zones }), [times, events.data, maintenance, zones])
  const activeStory = storyOpen ? bookmarks[Math.min(storyIndex, Math.max(0, bookmarks.length - 1))] : undefined
  const storyAffected = useMemo(() => new Set(activeStory?.target ? downstreamKeys(graph, activeStory.target) : []), [activeStory?.target, graph])

  const jumpStory = useCallback((index: number) => {
    const next = Math.max(0, Math.min(bookmarks.length - 1, index))
    const bookmark = bookmarks[next]
    if (!bookmark) return
    setStoryIndex(next)
    setPlaying(false)
    setTi(nearestIndex(times, bookmark.t))
    const validTarget = bookmark.target && graph.nodes.some((node) => node.key === bookmark.target)
    void rf.fitView(validTarget
      ? { nodes: [{ id: bookmark.target! }], duration: 450, maxZoom: 1.15, padding: 0.7 }
      : { duration: 450, maxZoom: 1, padding: 0.18 })
  }, [bookmarks, graph.nodes, rf, times])

  useEffect(() => {
    if (!storyPlaying || bookmarks.length < 2) return
    const timer = setInterval(() => setStoryIndex((index) => {
      const next = index + 1
      if (next >= bookmarks.length) { setStoryPlaying(false); return index }
      const bookmark = bookmarks[next]
      setTi(nearestIndex(times, bookmark.t))
      const validTarget = bookmark.target && graph.nodes.some((node) => node.key === bookmark.target)
      void rf.fitView(validTarget
        ? { nodes: [{ id: bookmark.target! }], duration: 450, maxZoom: 1.15, padding: 0.7 }
        : { duration: 450, maxZoom: 1, padding: 0.18 })
      return next
    }), 3600)
    return () => clearInterval(timer)
  }, [storyPlaying, bookmarks, graph.nodes, rf, times])

  const nodes = useMemo(() => flow.nodes.map((n) => {
    const node = graph.nodes.find((g) => g.key === n.id)
    const activeMaintenance = maintenanceAt(maintenance, n.id, t)
    const pinViews: PinView[] | undefined = byNode.get(n.id)?.map((p) => {
      const points = clip(series(idx, p.node, 'coverage_h'), 24)
      const redH = node ? thresholdsFor({ node_type: node.node_type, params: node.params ?? {} }, types).red_h : undefined
      const recCount = recs.filter((r) => r.subject_key === p.node).reduce((s, r) => s + candidatesOf(r).length, 0)
      return {
        n: p.n, tone: p.tone,
        content: (
          <PinCard
            pin={p} points={points} redH={redH} now={valueAt(points, t)?.p50} cursor={hasTime ? t : undefined}
            recCount={recCount} onShowRecs={() => navigate(`/runs/${run.id}/recommendations`)}
          />
        ),
      }
    })
    return {
      ...n, draggable: false,
      className: activeStory?.target
        ? n.id === activeStory.target ? 'kf-story-focus' : storyAffected.has(n.id) ? 'kf-story-affected' : 'kf-story-muted'
        : undefined,
      data: {
        ...n.data,
        badge: activeMaintenance ? {
          color: 'INFO',
          kind: 'MAINTENANCE',
          text: `Bảo trì, còn ${Math.max(1, Math.ceil((activeMaintenance.to - t) / 60_000))} phút`,
          hint: `Bảo trì từ ${fmtTime(activeMaintenance.from)} đến ${fmtTime(activeMaintenance.to)}. Máy tạm dừng cả đầu vào và đầu ra.`,
        } satisfies Badge : badgeFor(n, idx, t, types),
        rows: runRows(n.data.archetype, valuesAt(idx, n.id, t), {
          poolCount: n.data.archetype === 'RESOURCE_POOL' ? poolCount({ node_type: n.data.nodeType, params: n.data.params }, types) : undefined,
          maxStock: n.data.archetype === 'STORAGE' ? maxStockOf(n, types) : undefined,
        }),
        pins: pinViews,
        pinState: { open: openPin, setOpen: setOpenPin },
      },
    }
  }), [flow, graph.nodes, byNode, recs, idx, t, hasTime, types, openPin, maintenance, navigate, run.id, activeStory?.target, storyAffected])

  const peak = useMemo(() => peakRate(idx, graph.edges.map((e) => e.key)), [idx, graph.edges])
  // Tua nhanh ×4/×16 thì hạt chỉ nhanh gấp √ lần (×2/×4): nhanh hơn nữa là hạt nhoè, không còn đọc được.
  const dotSpeed = Math.sqrt(speed)
  const edges = useMemo(() => flow.edges.map((e) => {
    const v = valueAt(series(idx, e.id, 'in_transit'), t)?.p50 ?? 0
    const params = e.data?.params ?? {}
    const stoppedAt = maintenanceAt(maintenance, e.source, t) ?? maintenanceAt(maintenance, e.target, t)
    return {
      ...e, type: 'flow',
      label: e.label,
      style: activeStory?.target && storyAffected.has(e.source) && storyAffected.has(e.target)
        ? { stroke: activeStory.tone === 'bad' ? 'var(--color-bad)' : 'var(--color-warn)', strokeWidth: 3 }
        : undefined,
      data: {
        material: e.data?.material ?? '', params,
        dots: hasTime && !stoppedAt ? dotCount(idx, e.id, params, t, peak) : 0,
        cycleS: cycleSeconds(travelSeconds(params)) / dotSpeed,
        running: playing && !stoppedAt,
        blocked: Boolean(stoppedAt),
        statusText: stoppedAt ? `dừng tại ${stoppedAt.target}` : v >= 0.5 ? `${Math.round(v)} đang đi` : undefined,
      },
    }
  }), [flow, idx, t, peak, dotSpeed, playing, hasTime, maintenance, activeStory?.target, activeStory?.tone, storyAffected])

  const parentRun = useParentRun(scenario.parent_id)
  const deltaRed = parentRun && kpiP50(run.kpis, 'red_minutes') !== undefined && kpiP50(parentRun.kpis, 'red_minutes') !== undefined
    ? (kpiP50(run.kpis, 'red_minutes') as number) - (kpiP50(parentRun.kpis, 'red_minutes') as number)
    : undefined

  const pickPin = (p: Pin) => {
    void rf.fitView({ nodes: [{ id: p.node }], duration: 300, maxZoom: 1.1, padding: 0.6 })
    setTimeout(() => setOpenPin(p.n), 320)
  }
  const recommendationCount = recs.reduce((sum, insight) => sum + candidatesOf(insight).length, 0)
  const bestRecommendation = recs.flatMap(candidatesOf).find((candidate) => candidate.rank === 1)
  const remainingRedRisk = run.insights.find((insight) => insight.kind === 'RED_RISK')
  const bestDelta = bestRecommendation?.expected_impact?.delta
  const redImpact = typeof bestDelta?.red_minutes === 'number' ? bestDelta.red_minutes : undefined
  const throughputImpact = typeof bestDelta?.throughput === 'number' ? bestDelta.throughput : undefined
  const kpiPairs = parentRun ? [
    { label: 'Sản lượng', before: kpiP50(parentRun.kpis, 'throughput'), after: kpiP50(run.kpis, 'throughput'), higher: true },
    { label: 'Phút Đỏ', before: kpiP50(parentRun.kpis, 'red_minutes'), after: kpiP50(run.kpis, 'red_minutes'), higher: false },
    { label: 'Nợ đơn', before: kpiP50(parentRun.kpis, 'backorder_end'), after: kpiP50(run.kpis, 'backorder_end'), higher: false },
  ].filter((item) => item.before !== undefined && item.after !== undefined) : []

  const [popover, setPopover] = useState<{ nodeId: string; x: number; y: number } | null>(null)
  const popoverFlowNode = popover ? nodes.find((n) => n.id === popover.nodeId) : undefined
  const popoverRows = useMemo<WarehouseSkuRow[]>(() => {
    if (!popoverFlowNode || !graph) return []
    const gNode = graph.nodes.find((n) => n.key === popoverFlowNode.id)
    if (!gNode) return []
    const coverageH = valueAt(series(idx, popoverFlowNode.id, 'coverage_h'), t)?.p50
    const stockParams = (gNode.params?.stock ?? types[popoverFlowNode.data.nodeType]?.default_params?.stock ?? []) as unknown[]
    const out: WarehouseSkuRow[] = []
    const th = thresholdsFor({ node_type: popoverFlowNode.data.nodeType, params: gNode.params ?? {} }, types)
    for (const x of stockParams) {
      if (x && typeof x === 'object') {
        const o = x as { material?: unknown; initial?: unknown; max?: unknown }
        const sku = typeof o.material === 'string' ? o.material : ''
        const max = typeof o.max === 'number' ? o.max : Number(o.max) || 0
        const initial = typeof o.initial === 'number' ? o.initial : Number(o.initial) || 0
        if (sku) {
          const perSku = valueAt(series(idx, popoverFlowNode.id, `level:${sku}`), t)?.p50
          const alt = valueAt(series(idx, popoverFlowNode.id, `stock_${sku}`), t)?.p50
          const level = valueAt(series(idx, popoverFlowNode.id, 'level'), t)?.p50
          out.push({
            sku,
            max,
            current: perSku ?? alt ?? level ?? initial,
            coverageH,
            thresholds: th,
          })
        }
      }
    }
    return out
  }, [popoverFlowNode, graph, types, idx, t])
  const onNodeClick = (_e: ReactMouseEvent, node: FlowNode) => {
    if (node.data.archetype !== 'STORAGE') { setPopover(null); return }
    const r = wrap.current?.getBoundingClientRect()
    setPopover({
      nodeId: node.id,
      x: _e.clientX - (r?.left ?? 0) + 12,
      y: _e.clientY - (r?.top ?? 0),
    })
  }

  const nameOf = (key: string) => graph.nodes.find((n) => n.key === key)?.name ?? key
  return (
    <div className="flex h-full min-h-[480px] overflow-hidden">
      <div ref={wrap} className="relative min-w-0 flex-1">
      <HeaderActions>
        <button className={btn} onClick={() => { setStoryOpen(true); setStoryPlaying(false); jumpStory(0) }} title="Tự đi qua các mốc đáng chú ý của lần chạy">
          <PlayCircle size={13} /> Xem các mốc chính
        </button>
        <a className={btn} href={api.exportUrl(run.id)}><Download size={13} /> CSV</a>
      </HeaderActions>

      <KfNodeContext.Provider value={RUN_NODES}>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={kfNodeTypes} edgeTypes={kfEdgeTypes} nodesConnectable={false} nodesDraggable={false}
        colorMode={theme} fitView minZoom={0.2} fitViewOptions={{ padding: { top: '56px', right: '40px', bottom: '126px', left: '24px' } }}
        onPaneClick={() => { setOpenPin(null); setPopover(null) }}
        onNodeClick={onNodeClick}
      >
        <Background gap={18} size={1} color="var(--color-line)" />
        <FitOnResize options={{ padding: { top: '56px', right: '40px', bottom: '126px', left: '24px' } }} />
        <Controls showInteractive={false} position="bottom-left" style={{ marginBottom: 112 }} />
      </ReactFlow>
      </KfNodeContext.Provider>

      {popover && popoverFlowNode && (
        <WarehousePopover
          open
          onOpenChange={(o) => { if (!o) setPopover(null) }}
          anchorX={popover.x}
          anchorY={popover.y}
          title={`${popoverFlowNode.data.name} (${popoverFlowNode.data.key})`}
          rows={popoverRows}
          container={wrap.current}
        />
      )}

      {!focus && <Ribbon kpis={run.kpis} at={cursor} time={hasTime ? t : undefined} deltaRed={deltaRed} />}

      <Dock
        times={times} ti={ti} onSeek={(i) => { setPlaying(false); setTi(i) }} playing={playing} onToggle={togglePlay}
        speed={speed} onSpeed={() => setSpeed(nextSpeed(speed))} zones={zones} marks={marks} maintenance={maintenance} bookmarks={bookmarks} insetRight={14}
      />
      </div>

      {!focus && (
        <aside aria-label="Diễn biến cần chú ý" className="flex w-[300px] flex-none flex-col overflow-y-auto border-l border-line bg-panel-2">
          {storyOpen && activeStory && (
            <section className="border-b border-line p-3">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-[11px] text-muted">Mốc {storyIndex + 1}/{bookmarks.length}, lúc {fmtTime(activeStory.t)}</span>
                <button aria-label="Đóng phần xem các mốc" className={btnGhost} onClick={() => { setStoryOpen(false); setStoryPlaying(false) }}><X size={14} /></button>
              </div>
              <h2 className="mt-0.5 text-[13px] font-semibold leading-snug text-text">{activeStory.label}</h2>
              <p className="mt-1 text-[11.5px] leading-[17px] text-text-2">{activeStory.detail}</p>
              {activeStory.target && <p className="mt-1 text-[11px] text-muted">Đang làm nổi bật {nameOf(activeStory.target)} và các node phía sau nó.</p>}
              <div className="mt-2.5 flex gap-1.5">
                <button className={`${btn} px-2`} disabled={storyIndex === 0} onClick={() => jumpStory(storyIndex - 1)} aria-label="Mốc trước"><ChevronLeft size={13} /></button>
                <button className={`${btn} flex-1 justify-center`} onClick={() => setStoryPlaying((value) => !value)}>{storyPlaying ? <CircleStop size={13} /> : <PlayCircle size={13} />}{storyPlaying ? 'Dừng' : 'Tự chạy'}</button>
                <button className={`${btn} px-2`} disabled={storyIndex >= bookmarks.length - 1} onClick={() => jumpStory(storyIndex + 1)} aria-label="Mốc sau"><ChevronRight size={13} /></button>
              </div>
            </section>
          )}

          {appliedAction && (
            <section className="border-b border-line p-3">
              <h2 className="text-[11px] text-muted">Lần chạy này đã áp dụng</h2>
              <div className="mt-0.5 text-[12.5px] font-semibold text-text">{describeAction(appliedAction)}</div>
              {kpiPairs.length > 0 && (
                <dl className="mt-2 space-y-1">
                  {kpiPairs.map((item) => {
                    const delta = (item.after as number) - (item.before as number)
                    const good = item.higher ? delta > 0 : delta < 0
                    return (
                      <div key={item.label} className="flex items-baseline justify-between gap-2 text-[11.5px]">
                        <dt className="text-muted">{item.label}</dt>
                        <dd className="tabular-nums text-text-2">
                          {(item.before as number).toFixed(1)} → <b className="font-semibold text-text">{(item.after as number).toFixed(1)}</b>
                          <span className={`ml-1.5 ${delta === 0 ? 'text-muted' : good ? 'text-ok' : 'text-bad-text'}`}>{delta >= 0 ? '+' : ''}{delta.toFixed(1)}</span>
                        </dd>
                      </div>
                    )
                  })}
                </dl>
              )}
              {remainingRedRisk && (
                <p className="mt-2 text-[11px] leading-4 text-bad-text">
                  {nameOf(remainingRedRisk.subject_key ?? '')} vẫn có {Math.round((remainingRedRisk.probability ?? 0) * 100)}% khả năng chuyển Đỏ: thay đổi này mới giảm một phần rủi ro.
                </p>
              )}
              {parentRun && <Link className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline" to={`/runs/${run.id}/compare`}>So đầy đủ với lần chạy gốc <ChevronRight size={12} /></Link>}
            </section>
          )}

          <section className="border-b border-line p-3">
            <h2 className="flex items-center gap-2 text-[12px] font-semibold text-text">
              Cần chú ý
              <span className="font-normal text-muted">{pins.length === 0 ? 'không có' : pins.length}</span>
            </h2>
            {pins.length === 0 ? (
              <p className="mt-1 text-[11.5px] text-muted">Không kho nào có nguy cơ chuyển Đỏ và không trạm nào là điểm nghẽn rõ rệt.</p>
            ) : (
              <ul className="-mx-1.5 mt-1.5 space-y-px">
                {pins.map((p) => (
                  <li key={p.n}>
                    <button
                      className={`flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-raised ${openPin === p.n ? 'bg-raised' : ''}`}
                      onClick={() => pickPin(p)}
                    >
                      <PinDot n={p.n} tone={p.tone} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12px] font-medium leading-4 text-text">{nameOf(p.node)}</span>
                        <span className="block text-[11px] leading-4 text-muted">{describeInsight(p.insight).replace(`${p.node} `, '')}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="p-3">
            <h2 className="flex items-center gap-2 text-[12px] font-semibold text-text">
              Đề xuất
              <span className="font-normal text-muted">{recommendationCount === 0 ? 'chưa có' : recommendationCount}</span>
            </h2>
            {bestRecommendation ? (
              <Link to={`/runs/${run.id}/recommendations`} className="group -mx-1.5 mt-1 block rounded-md px-1.5 py-1.5 hover:bg-raised">
                <span className="block text-[12px] font-medium leading-4 text-text">{describeAction(bestRecommendation.action)}</span>
                {(redImpact !== undefined || throughputImpact !== undefined) && (
                  <span className="mt-0.5 block text-[11px] text-muted">
                    Dự kiến {[
                      redImpact !== undefined ? `${redImpact > 0 ? '+' : ''}${redImpact.toFixed(1)} phút Đỏ` : '',
                      throughputImpact !== undefined ? `${throughputImpact > 0 ? '+' : ''}${throughputImpact.toFixed(1)} sản lượng` : '',
                    ].filter(Boolean).join(', ')}
                  </span>
                )}
                <span className="mt-1 flex items-center gap-1 text-[11px] font-medium text-accent">
                  {recommendationCount > 1 ? `Xem cả ${recommendationCount} phương án` : 'Xem chi tiết'} <ChevronRight size={12} />
                </span>
              </Link>
            ) : (
              <p className="mt-1 text-[11.5px] text-muted">Engine chưa tìm được thay đổi nào cải thiện rõ rệt cho lần chạy này.</p>
            )}
          </section>

          {hasTime && (
            <p className="mt-auto border-t border-line px-3 py-2.5 text-[11px] leading-4 text-muted">
              Chấm chạy trên đường nối là hàng đang di chuyển; càng nhiều chấm, lưu lượng càng lớn. Bấm vào kho để xem tồn từng vật tư.
            </p>
          )}
        </aside>
      )}
    </div>
  )
}
