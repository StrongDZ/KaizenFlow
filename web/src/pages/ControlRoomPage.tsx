import { useQuery } from '@tanstack/react-query'
import { Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { Bell, ChevronRight, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { BandRow, Graph, NodeType, RunDetail, Scenario } from '../api/types'
import { Dock } from '../components/controlroom/Dock'
import { PinCard } from '../components/controlroom/PinCard'
import { Ribbon } from '../components/controlroom/Ribbon'
import { RunGate } from '../components/controlroom/RunGate'
import { kfEdgeTypes } from '../components/KfEdge'
import { kfNodeTypes } from '../components/KfNode'
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
  const [openPin, setOpenPin] = useState<number | null>(null)
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
  }), [flow, graph.nodes, byNode, recs, idx, t, hasTime, types, openPin, maintenance, navigate, run.id])

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
      data: {
        material: e.data?.material ?? '', params,
        dots: hasTime && !stoppedAt ? dotCount(idx, e.id, params, t, peak) : 0,
        cycleS: cycleSeconds(travelSeconds(params)) / dotSpeed,
        running: playing && !stoppedAt,
        blocked: Boolean(stoppedAt),
        statusText: stoppedAt ? `dừng tại ${stoppedAt.target}` : v >= 0.5 ? `${Math.round(v)} đang đi` : undefined,
      },
    }
  }), [flow, idx, t, peak, dotSpeed, playing, hasTime, maintenance])

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

  return (
    <div className="relative h-full min-h-[480px]">
      <HeaderActions>
        <StatusChip status={run.status} />
        <span className="text-[11px] text-muted">{scenario.replications} lần lặp</span>
        {parentRun && <Link className={btn} to={`/compare?a=${parentRun.id}&b=${run.id}`}>So sánh với gốc</Link>}
        <a className={btn} href={api.exportUrl(run.id)}>Tải CSV</a>
      </HeaderActions>

      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={kfNodeTypes} edgeTypes={kfEdgeTypes} nodesConnectable={false} nodesDraggable={false}
        colorMode={theme} fitView fitViewOptions={{ padding: { top: '72px', right: '72px', bottom: '126px', left: '24px' } }}
        onPaneClick={() => setOpenPin(null)}
      >
        <Background gap={18} size={1} color="var(--color-line)" />
        <Controls showInteractive={false} position="bottom-left" style={{ marginBottom: 112 }} />
      </ReactFlow>

      {!focus && <Ribbon kpis={run.kpis} at={cursor} time={hasTime ? t : undefined} deltaRed={deltaRed} />}
      {!focus && appliedAction && (
        <div className="pointer-events-none absolute left-3.5 top-[38px] z-10 max-w-[min(560px,calc(100%-120px))] rounded-lg border border-ok/50 bg-panel/95 px-3 py-2 shadow-sm">
          <div className="text-[10px] font-bold uppercase tracking-wide text-ok">Đang xem kết quả sau khi áp dụng đề xuất</div>
          <div className="text-xs font-semibold text-text">{describeAction(appliedAction)}</div>
          {maintenance.length > 0 && <div className="mt-0.5 text-[10.5px] text-muted">Tua timeline tới vùng vàng để xem trạng thái bảo trì trực tiếp trên máy.</div>}
        </div>
      )}
      {!focus && hasTime && (
        <p className={`pointer-events-none absolute left-3.5 z-10 flex items-center gap-1.5 text-[11px] text-muted ${appliedAction ? 'top-[104px]' : 'top-[38px]'}`}>
          <i className="h-2 w-2 flex-none rounded-full bg-text/85" />
          Mỗi chấm sáng là một phần của luồng hàng; nhiều chấm hơn nghĩa là lưu lượng lớn hơn. Bấm ▶ để phát.
        </p>
      )}

      {!focus && (recommendationCount > 0 || pins.length > 0) && (
        <aside aria-label="Thông báo của lần chạy" className="absolute right-3 top-[42px] z-10 w-[270px] space-y-2">
          {recommendationCount > 0 && (
            <Link
              to={`/runs/${run.id}/recommendations`}
              className="group block rounded-xl border border-accent/45 bg-panel/95 p-3 shadow-lg backdrop-blur hover:border-accent"
            >
              <div className="flex items-start gap-2.5">
                <span className="relative flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-accent/12 text-accent">
                  <Bell size={16} />
                  <i className="absolute -right-1 -top-1 min-w-4 rounded-full bg-accent px-1 text-center text-[9px] font-bold leading-4 text-on-accent">{recommendationCount}</i>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[10px] font-bold uppercase tracking-wide text-accent">Đề xuất mới</span>
                  <span className="mt-0.5 block truncate text-xs font-semibold text-text">
                    {bestRecommendation ? describeAction(bestRecommendation.action) : `${recommendationCount} phương án cần xem`}
                  </span>
                  <span className="mt-1 flex items-center gap-1 text-[10.5px] text-muted group-hover:text-text">
                    Mở chi tiết và tinh chỉnh <ChevronRight size={12} />
                  </span>
                </span>
              </div>
            </Link>
          )}
          {pins.length > 0 && (
            <button
              className="flex w-full items-center gap-2 rounded-lg border border-line-2 bg-panel/92 px-3 py-2 text-left shadow-sm backdrop-blur hover:bg-raised"
              onClick={() => pickPin(pins[0])}
            >
              <TriangleAlert size={14} className="flex-none text-warn" />
              <span className="min-w-0 flex-1 text-[11px] text-text-2"><b className="text-text">{pins.length} cảnh báo</b> · xem cảnh báo đầu tiên trên sơ đồ</span>
              <ChevronRight size={12} className="flex-none text-muted" />
            </button>
          )}
        </aside>
      )}

      <Dock
        times={times} ti={ti} onSeek={(i) => { setPlaying(false); setTi(i) }} playing={playing} onToggle={togglePlay}
        speed={speed} onSpeed={() => setSpeed(nextSpeed(speed))} zones={zones} marks={marks} maintenance={maintenance} insetRight={14}
      />
    </div>
  )
}
