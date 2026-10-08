import { useQuery } from '@tanstack/react-query'
import { Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { Bell, ChevronLeft, ChevronRight, CircleStop, Gauge, PlayCircle, Sparkles, TriangleAlert, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import type { BandRow, Graph, NodeType, RunDetail, Scenario } from '../api/types'
import { Dock } from '../components/controlroom/Dock'
import { PinCard } from '../components/controlroom/PinCard'
import { Ribbon } from '../components/controlroom/Ribbon'
import { RunGate } from '../components/controlroom/RunGate'
import { FitOnResize } from '../components/FitOnResize'
import { DecisionJourney } from '../components/scenario/DecisionJourney'
import { kfEdgeTypes } from '../components/KfEdge'
import { kfNodeTypes } from '../components/KfNode'
import { WarehousePopover, type WarehouseSkuRow } from '../components/WarehousePopover'
import { HeaderActions, useShell } from '../components/shell/ShellContext'
import { useTheme } from '../hooks/useTheme'
import { StatusChip, btn } from '../components/ui'
import { atCursor } from '../lib/atCursor'
import { cycleSeconds, dotCount, peakRate, travelSeconds } from '../lib/flow'
import { fmtTime } from '../lib/format'
import { toFlow, type Badge, type FlowNode, type PinView } from '../lib/graph'
import { candidatesOf, describeAction, kpiP50, type Action } from '../lib/insights'
import { poolCount, thresholdsFor } from '../lib/model'
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

function badgeFor(n: FlowNode, idx: BandIndex, t: number, types: Record<string, NodeType>): Badge | undefined {
  const ref = { node_type: n.data.nodeType, params: n.data.params }
  if (n.data.archetype === 'STORAGE') {
    const cov = valueAt(series(idx, n.id, 'coverage_h'), t)?.p50
    const text = cov === undefined ? '—' : cov >= 999 ? 'không tiêu thụ' : `còn ${cov.toFixed(1).replace('.', ',')} giờ`
    return {
      color: colorFor(cov, thresholdsFor(ref, types)), text,
      hint: 'Tồn kho đủ dùng thêm chừng này ở tốc độ tiêu thụ gần đây. Xanh là ổn, Vàng là hơi thiếu hoặc thừa, Đỏ là sắp hết hàng.',
    }
  }
  if (n.data.archetype === 'RESOURCE_POOL') {
    const busy = valueAt(series(idx, n.id, 'busy'), t)?.p50
    const queue = valueAt(series(idx, n.id, 'queue_len'), t)?.p50 ?? 0
    return busy === undefined ? undefined : {
      color: 'INFO', text: `${Math.round(busy)}/${poolCount(ref, types)} bận, ${Math.round(queue)} chờ`,
      hint: 'Số xe hoặc người đang làm việc trên tổng số, và số lượt đang xếp hàng chờ họ.',
    }
  }
  return undefined
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
          text: `Còn ${Math.max(1, Math.ceil((activeMaintenance.to - t) / 60_000))} phút · không nhận/nhả hàng`,
          hint: `Bảo trì từ ${fmtTime(activeMaintenance.from)} đến ${fmtTime(activeMaintenance.to)}. Máy tạm dừng cả đầu vào và đầu ra.`,
        } satisfies Badge : badgeFor(n, idx, t, types),
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

  const parentRuns = useQuery({
    queryKey: ['runs', scenario.parent_id], queryFn: () => api.runs(scenario.parent_id!), enabled: scenario.parent_id !== null,
  })
  const parentRun = parentRuns.data?.find((r) => r.status === 'DONE')
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

  return (
    <div className="flex h-full min-h-[480px] overflow-hidden">
      <div ref={wrap} className="relative min-w-0 flex-1">
      <HeaderActions>
        <StatusChip status={run.status} />
        <span className="text-[11px] text-muted">{scenario.replications} lần lặp</span>
        <button className={btn} onClick={() => { setStoryOpen(true); setStoryPlaying(false); jumpStory(0) }}><PlayCircle size={13} /> Trình diễn có hướng dẫn</button>
        {parentRun && <Link className={btn} to={`/compare?a=${parentRun.id}&b=${run.id}`}>So sánh với gốc</Link>}
        <a className={btn} href={api.exportUrl(run.id)}>Tải CSV</a>
      </HeaderActions>

      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={kfNodeTypes} edgeTypes={kfEdgeTypes} nodesConnectable={false} nodesDraggable={false}
        colorMode={theme} fitView minZoom={0.2} fitViewOptions={{ padding: { top: '72px', right: '72px', bottom: '126px', left: '24px' } }}
        onPaneClick={() => { setOpenPin(null); setPopover(null) }}
        onNodeClick={onNodeClick}
      >
        <Background gap={18} size={1} color="var(--color-line)" />
        <FitOnResize options={{ padding: { top: '72px', right: '72px', bottom: '126px', left: '24px' } }} />
        <Controls showInteractive={false} position="bottom-left" style={{ marginBottom: 112 }} />
      </ReactFlow>

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
        <aside aria-label="Trung tâm quyết định" className="flex w-[310px] flex-none flex-col overflow-y-auto border-l border-line bg-panel-2/70">
          <div className="border-b border-line p-2">
            <DecisionJourney
              compact active="observe"
              links={{ decide: `/runs/${run.id}/recommendations`, validate: parentRun ? `/compare?a=${parentRun.id}&b=${run.id}` : undefined, report: `/runs/${run.id}/report` }}
            />
          </div>

          <div className="space-y-3 p-3">
            {storyOpen && activeStory && (
              <section className="overflow-hidden rounded-xl border border-accent/45 bg-panel shadow-sm">
                <header className="flex items-center gap-2 border-b border-line bg-panel-2 px-3 py-2">
                  <Sparkles size={14} className="text-accent" />
                  <div className="min-w-0 flex-1"><div className="text-[9px] font-bold uppercase tracking-wide text-accent">Story mode · mốc {storyIndex + 1}/{bookmarks.length}</div><div className="truncate text-xs font-semibold text-text">{activeStory.label}</div></div>
                  <button aria-label="Đóng story mode" className="text-muted hover:text-text" onClick={() => { setStoryOpen(false); setStoryPlaying(false) }}><X size={14} /></button>
                </header>
                <div className="px-3 py-2.5">
                  <p className="text-[11px] leading-4 text-text-2">{activeStory.detail}</p>
                  {activeStory.target && <p className="mt-1 text-[10px] text-muted">Đang làm nổi bật <b className="text-text">{activeStory.target}</b> và luồng downstream.</p>}
                  <div className="mt-2.5 grid grid-cols-3 gap-1.5">
                    <button className={`${btn} justify-center px-2`} disabled={storyIndex === 0} onClick={() => jumpStory(storyIndex - 1)}><ChevronLeft size={12} /> Trước</button>
                    <button className={`${btn} justify-center px-2`} onClick={() => setStoryPlaying((value) => !value)}>{storyPlaying ? <CircleStop size={12} /> : <PlayCircle size={12} />}{storyPlaying ? 'Dừng' : 'Tự động'}</button>
                    <button className={`${btn} justify-center px-2`} disabled={storyIndex >= bookmarks.length - 1} onClick={() => jumpStory(storyIndex + 1)}>Tiếp <ChevronRight size={12} /></button>
                  </div>
                  <div className="mt-2 flex items-center justify-end gap-1 text-[9.5px] text-muted"><Gauge size={10} /> {fmtTime(activeStory.t)}</div>
                </div>
              </section>
            )}

            {appliedAction && (
              <section className="rounded-xl border border-ok/50 bg-panel p-3 shadow-sm">
                <div className="text-[10px] font-bold uppercase tracking-wide text-ok">Kết quả sau khi áp dụng</div>
                <div className="mt-0.5 text-xs font-semibold text-text">{describeAction(appliedAction)}</div>
                {maintenance.length > 0 && <div className="mt-1 text-[10.5px] text-muted">Các đoạn bảo trì được đánh dấu màu vàng trên timeline.</div>}
                {remainingRedRisk && (
                  <div className="mt-2 rounded-lg border border-bad/45 bg-bad-bg px-2.5 py-2 text-[10.5px] leading-4 text-bad-text">
                    <b>Chưa xử lý hết:</b> {remainingRedRisk.subject_key} vẫn có {Math.round((remainingRedRisk.probability ?? 0) * 100)}% khả năng chuyển Đỏ. Action này mới giảm một phần rủi ro; vùng đỏ trên timeline là kết quả thật của run sau áp dụng.
                  </div>
                )}
                {kpiPairs.length > 0 && (
                  <div className="mt-2 grid grid-cols-3 gap-1 border-t border-line pt-2">
                    {kpiPairs.map((item) => {
                      const delta = (item.after as number) - (item.before as number)
                      const good = item.higher ? delta > 0 : delta < 0
                      return <div key={item.label} className="rounded-md bg-panel-2 p-1.5 text-center"><div className="text-[8.5px] text-muted">{item.label}</div><div className="text-[10px] text-text"><span className="text-faint">{(item.before as number).toFixed(1)}</span> → <b>{(item.after as number).toFixed(1)}</b></div><div className={`text-[8.5px] ${delta === 0 ? 'text-muted' : good ? 'text-ok' : 'text-bad-text'}`}>{delta >= 0 ? '+' : ''}{delta.toFixed(1)}</div></div>
                    })}
                  </div>
                )}
                {parentRun && <Link className="mt-2 inline-flex items-center gap-1 text-[10.5px] font-semibold text-accent hover:underline" to={`/compare?a=${parentRun.id}&b=${run.id}`}>Mở kiểm chứng đầy đủ <ChevronRight size={11} /></Link>}
              </section>
            )}

            {recommendationCount > 0 && (
              <Link to={`/runs/${run.id}/recommendations`} className="group block rounded-xl border border-accent/45 bg-panel p-3 shadow-sm hover:border-accent">
                <div className="flex items-start gap-2.5">
                  <span className="relative flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-accent/12 text-accent"><Bell size={16} /><i className="absolute -right-1 -top-1 min-w-4 rounded-full bg-accent px-1 text-center text-[9px] font-bold leading-4 text-on-accent">{recommendationCount}</i></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[10px] font-bold uppercase tracking-wide text-accent">Đề xuất mới</span>
                    <span className="mt-0.5 block text-xs font-semibold leading-4 text-text">{bestRecommendation ? describeAction(bestRecommendation.action) : `${recommendationCount} phương án cần xem`}</span>
                    <span className="mt-1 flex items-center gap-1 text-[10.5px] text-muted group-hover:text-text">Mở chi tiết và tinh chỉnh <ChevronRight size={12} /></span>
                    {(redImpact !== undefined || throughputImpact !== undefined) && <span className="mt-1.5 block border-t border-line pt-1.5 text-[9.5px] text-text-2">Dự kiến {redImpact !== undefined ? `${redImpact > 0 ? '+' : ''}${redImpact.toFixed(1)} phút Đỏ` : ''}{redImpact !== undefined && throughputImpact !== undefined ? ' · ' : ''}{throughputImpact !== undefined ? `${throughputImpact > 0 ? '+' : ''}${throughputImpact.toFixed(1)} sản lượng` : ''}</span>}
                  </span>
                </div>
              </Link>
            )}

            {pins.length > 0 && (
              <button className="flex w-full items-center gap-2 rounded-lg border border-line-2 bg-panel px-3 py-2 text-left shadow-sm hover:bg-raised" onClick={() => pickPin(pins[0])}>
                <TriangleAlert size={14} className="flex-none text-warn" />
                <span className="min-w-0 flex-1 text-[11px] text-text-2"><b className="text-text">{pins.length} cảnh báo</b> · xem cảnh báo đầu tiên trên sơ đồ</span>
                <ChevronRight size={12} className="flex-none text-muted" />
              </button>
            )}

            {hasTime && (
              <div className="rounded-lg border border-line bg-panel px-3 py-2 text-[10.5px] leading-4 text-muted">
                <div className="flex items-start gap-2"><i className="mt-1 h-2 w-2 flex-none rounded-full bg-accent shadow-[0_0_5px_var(--color-accent)]" /><span>Các <b className="text-text-2">hạt phát sáng theo màu tuyến</b> biểu diễn hàng đang di chuyển; nhiều hạt hơn nghĩa là lưu lượng lớn hơn.</span></div>
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  )
}
