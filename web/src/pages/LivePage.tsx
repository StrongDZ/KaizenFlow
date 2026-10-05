import { useQuery } from '@tanstack/react-query'
import { Background, Controls, ReactFlow, ReactFlowProvider } from '@xyflow/react'
import { useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { Graph, NodeType } from '../api/types'
import { FloatingPanel, PanelSection } from '../components/FloatingPanel'
import { kfEdgeTypes } from '../components/KfEdge'
import { LiveBadgeContext, kfNodeTypes } from '../components/KfNode'
import { DriftAlerts } from '../components/live/DriftAlerts'
import { FeedControl } from '../components/live/FeedControl'
import { ForecastDock } from '../components/live/ForecastDock'
import { IncidentPanel, type IncidentNode } from '../components/live/IncidentPanel'
import { EmptyState, Loading, btn } from '../components/ui'
import { useFeedStatus, useLive } from '../hooks/useLive'
import { useModelGraph } from '../hooks/useModelGraph'
import { useTheme } from '../hooks/useTheme'
import { estimatedEdges } from '../lib/edgePlan'
import { cycleSeconds, travelSeconds } from '../lib/flow'
import { toFlow } from '../lib/graph'
import { dotsFromRate, nodeBadge, summarize, trackPeak } from '../lib/liveFrame'
import { poolCount, thresholdsFor } from '../lib/model'

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

function Room({ model, graph, types }: { model: string; graph: Graph; types: Record<string, NodeType> }) {
  const { theme } = useTheme()
  const { snapshot } = useLive(model)
  const feed = useFeedStatus()
  const agvMap = useQuery({ queryKey: ['agv-map', model], queryFn: () => api.agvMap(model), retry: false })
  const bindingList = useQuery({ queryKey: ['bindings', model], queryFn: () => api.bindings(model) })
  const estimated = useMemo(() => estimatedEdges(bindingList.data ?? []), [bindingList.data])
  const [panelOpen, setPanelOpen] = useState(true)
  const peak = useRef(0)

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
        estimated: estimated.has(e.id),
      },
    }
  }), [flow.edges, snapshot, speed, running, estimated]) // eslint-disable-line react-hooks/exhaustive-deps

  const incidentNodes: IncidentNode[] = useMemo(() => graph.nodes.map((n) => {
    const stock = (n.params?.stock ?? types[n.node_type]?.default_params.stock) as { material?: string }[] | undefined
    const live = Object.keys(snapshot?.subjects[n.key]?.signals ?? {}).filter((k) => k.startsWith('level:')).map((k) => k.slice(6))
    const materials = [...new Set([...(stock ?? []).map((s) => String(s.material ?? '')).filter(Boolean), ...live])]
    return { key: n.key, name: n.name || types[n.node_type]?.name || n.key, archetype: n.archetype || types[n.node_type]?.archetype || '', materials }
  }), [graph.nodes, types, snapshot])

  const bindings = snapshot?.bindings ?? 0
  const feedReady = running

  return (
    <div className="relative h-full min-h-[480px]">
      <LiveBadgeContext.Provider value={badgeMap}>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={kfNodeTypes} edgeTypes={kfEdgeTypes} nodesConnectable={false} nodesDraggable={false}
        colorMode={theme} fitView fitViewOptions={{ padding: { top: '120px', right: panelOpen ? '280px' : '24px', bottom: '300px', left: '24px' } }}
      >
        <Background gap={18} size={1} color="var(--color-line)" />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
      </LiveBadgeContext.Provider>

      <div className="absolute inset-x-3 top-3 z-10 space-y-1.5">
        <FeedControl model={model} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-[11.5px] text-muted">
          <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-bad" /><b className="tabular-nums text-text">{summary.redStorages}</b> kho Đỏ</span>
          <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-warn" /><b className="tabular-nums text-text">{summary.yellowStorages}</b> kho Vàng</span>
          <span><b className="tabular-nums text-text">{summary.downMachines}</b> máy hỏng</span>
          {summary.stale > 0 && <span className="text-warn"><b className="tabular-nums">{summary.stale}</b> thiết bị mất tín hiệu</span>}
          <span className="text-faint">Chấm chạy dọc đường nối là hàng đang chảy, nhiều chấm là lưu lượng lớn. Đường nét đứt là số ước lượng, không phải số đo.</span>
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
        <FloatingPanel side="right" top={112} bottom={12} width={272} title="Bảng điều khiển demo" onClose={() => setPanelOpen(false)}>
          <PanelSection title="Cảnh báo lệch dự báo">
            <DriftAlerts model={model} names={Object.fromEntries(incidentNodes.map((n) => [n.key, n.name]))} />
          </PanelSection>
          <PanelSection title="Bơm sự cố">
            <IncidentPanel nodes={incidentNodes} lanes={agvMap.data?.lanes ?? []} incidents={feed.data?.model === model ? feed.data.incidents : []} ready={feedReady} />
          </PanelSection>
        </FloatingPanel>
      ) : (
        <button className={`${btn} absolute right-3 top-[112px] z-10 bg-panel`} onClick={() => setPanelOpen(true)}>Bảng điều khiển demo</button>
      )}
    </div>
  )
}
