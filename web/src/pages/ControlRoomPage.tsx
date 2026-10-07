import { useMutation, useQuery } from '@tanstack/react-query'
import { Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { BandRow, Graph, NodeType, RunDetail, Scenario } from '../api/types'
import { AlertList } from '../components/controlroom/AlertList'
import { Dock } from '../components/controlroom/Dock'
import { PinCard } from '../components/controlroom/PinCard'
import { RecommendationList } from '../components/controlroom/RecommendationList'
import { Ribbon } from '../components/controlroom/Ribbon'
import { RunGate } from '../components/controlroom/RunGate'
import { FloatingPanel, PanelSection } from '../components/FloatingPanel'
import { kfEdgeTypes } from '../components/KfEdge'
import { kfNodeTypes } from '../components/KfNode'
import { WarehousePopover, type WarehouseSkuRow } from '../components/WarehousePopover'
import { HeaderActions, useShell } from '../components/shell/ShellContext'
import { useTheme } from '../hooks/useTheme'
import { StatusChip, btn } from '../components/ui'
import { atCursor } from '../lib/atCursor'
import { cycleSeconds, dotCount, peakRate, travelSeconds } from '../lib/flow'
import { toFlow, type Badge, type FlowNode, type PinView } from '../lib/graph'
import { candidatesOf, kpiP50 } from '../lib/insights'
import { poolCount, thresholdsFor } from '../lib/model'
import { assignPins, pinsByNode, type Pin } from '../lib/pins'
import { isTypingTarget, nextSpeed, stepIndex, tickMs, type Speed } from '../lib/playback'
import { clip, colorFor, indexBands, series, timeline, valueAt, type BandIndex } from '../lib/replay'
import { failureMarks, redZones, rulerOf } from '../lib/ruler'

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
  const rf = useReactFlow()
  const { focus, setFocus } = useShell()
  const { theme } = useTheme()
  const idx = useMemo(() => indexBands(rows), [rows])
  const times = useMemo(() => timeline(idx), [idx])
  const last = Math.max(0, times.length - 1)
  const [ti, setTi] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<Speed>(1)
  const [panelOpen, setPanelOpen] = useState(true)
  const [openPin, setOpenPin] = useState<number | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
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
  const events = useQuery({ queryKey: ['events', run.id, 'FAILURE'], queryFn: () => api.events(run.id, { type: 'FAILURE' }) })
  const marks = useMemo(() => failureMarks(events.data ?? []), [events.data])

  const nodes = useMemo(() => flow.nodes.map((n) => {
    const node = graph.nodes.find((g) => g.key === n.id)
    const pinViews: PinView[] | undefined = byNode.get(n.id)?.map((p) => {
      const points = clip(series(idx, p.node, 'coverage_h'), 24)
      const redH = node ? thresholdsFor({ node_type: node.node_type, params: node.params ?? {} }, types).red_h : undefined
      const recCount = recs.filter((r) => r.subject_key === p.node).reduce((s, r) => s + candidatesOf(r).length, 0)
      return {
        n: p.n, tone: p.tone,
        content: (
          <PinCard
            pin={p} points={points} redH={redH} now={valueAt(points, t)?.p50} cursor={hasTime ? t : undefined}
            recCount={recCount} onShowRecs={() => { setOpenPin(null); setPanelOpen(true) }}
          />
        ),
      }
    })
    return {
      ...n, draggable: false,
      data: { ...n.data, badge: badgeFor(n, idx, t, types), pins: pinViews, pinState: { open: openPin, setOpen: setOpenPin } },
    }
  }), [flow, graph.nodes, byNode, recs, idx, t, hasTime, types, openPin])

  const peak = useMemo(() => peakRate(idx, graph.edges.map((e) => e.key)), [idx, graph.edges])
  // Tua nhanh ×4/×16 thì hạt chỉ nhanh gấp √ lần (×2/×4): nhanh hơn nữa là hạt nhoè, không còn đọc được.
  const dotSpeed = Math.sqrt(speed)
  const edges = useMemo(() => flow.edges.map((e) => {
    const v = valueAt(series(idx, e.id, 'in_transit'), t)?.p50 ?? 0
    const params = e.data?.params ?? {}
    return {
      ...e, type: 'flow',
      label: v >= 0.5 ? `${String(e.label)}, ${Math.round(v)} đang chạy` : e.label,
      data: {
        material: e.data?.material ?? '', params,
        dots: hasTime ? dotCount(idx, e.id, params, t, peak) : 0,
        cycleS: cycleSeconds(travelSeconds(params)) / dotSpeed,
        running: playing,
      },
    }
  }), [flow, idx, t, peak, dotSpeed, playing, hasTime])

  const apply = useMutation({
    mutationFn: ({ id, rank }: { id: number; rank: number }) => api.applyInsight(id, rank),
    onSuccess: (r) => navigate(`/runs/${r.run_id}`),
  })
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
  const showPanel = !focus && panelOpen

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
    <div ref={wrap} className="relative h-full min-h-[480px]">
      <HeaderActions>
        <StatusChip status={run.status} />
        <span className="text-[11px] text-muted">{scenario.replications} lần lặp</span>
        {parentRun && <Link className={btn} to={`/compare?a=${parentRun.id}&b=${run.id}`}>So sánh với gốc</Link>}
        <a className={btn} href={api.exportUrl(run.id)}>Tải CSV</a>
      </HeaderActions>

      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={kfNodeTypes} edgeTypes={kfEdgeTypes} nodesConnectable={false} nodesDraggable={false}
        colorMode={theme} fitView fitViewOptions={{ padding: { top: '56px', right: '280px', bottom: '96px', left: '24px' } }}
        onPaneClick={() => { setOpenPin(null); setPopover(null) }}
        onNodeClick={onNodeClick}
      >
        <Background gap={18} size={1} color="var(--color-line)" />
        <Controls showInteractive={false} position="bottom-left" style={{ marginBottom: 82 }} />
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
      {!focus && hasTime && (
        <p className="pointer-events-none absolute left-3.5 top-[38px] z-10 flex items-center gap-1.5 text-[11px] text-muted">
          <i className="h-2 w-2 flex-none rounded-full bg-text/85" />
          Chấm chạy dọc đường nối là hàng đang chảy; nhiều chấm là lưu lượng lớn. Bấm ▶ để phát.
        </p>
      )}

      {showPanel && (
        <FloatingPanel side="right" top={42} bottom={82} title="Cảnh báo và đề xuất" onClose={() => setPanelOpen(false)}>
          <PanelSection title="Cảnh báo"><AlertList pins={pins} onPick={pickPin} /></PanelSection>
          <PanelSection title="Đề xuất đã kiểm chứng">
            <RecommendationList insights={recs} pending={apply.isPending} error={apply.error} onApply={(id, rank) => apply.mutate({ id, rank })} />
          </PanelSection>
        </FloatingPanel>
      )}
      {!focus && !panelOpen && (
        <button className={`${btn} absolute right-3 top-[42px] z-10 bg-panel`} onClick={() => setPanelOpen(true)}>Cảnh báo và đề xuất</button>
      )}

      <Dock
        times={times} ti={ti} onSeek={(i) => { setPlaying(false); setTi(i) }} playing={playing} onToggle={togglePlay}
        speed={speed} onSpeed={() => setSpeed(nextSpeed(speed))} zones={zones} marks={marks} insetRight={showPanel ? 262 : 14}
      />
    </div>
  )
}
