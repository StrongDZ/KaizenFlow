import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeftRight, Ban, BatteryCharging, OctagonX, BookOpen, Crosshair, Gauge, Image as ImageIcon, MapPin, Route, ScanLine, SlidersHorizontal, Spline, Trash2, Truck, Unlock, Waypoints, X, Map as MapIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useParams } from 'react-router-dom'
import { api, ApiError } from '../api/client'
import type { AgvMap, Frame, MapPoint, Pt } from '../api/types'
import { CalibrationCard } from '../components/live/CalibrationCard'
import { AgvMapCanvas, type CanvasHandle, type MapSelection, type RingTone } from '../components/live/AgvMapCanvas'
import { FloatingPanel, PanelSection } from '../components/FloatingPanel'
import { HeaderActions } from '../components/shell/ShellContext'
import { MapToolbar, type MapTool } from '../components/live/MapToolbar'
import { BackgroundPanel } from '../components/live/BackgroundPanel'
import { NODE_DRAG_TYPE, NodeTray } from '../components/live/NodeTray'
import { TracePanel } from '../components/live/TracePanel'
import { FeedControl } from '../components/live/FeedControl'
import { FrameCard } from '../components/live/FrameCard'
import { MapTables } from '../components/live/MapTables'
import { PeekHost, SidePeek } from '../components/SidePeek'
import { NodeAvatar } from '../components/NodeIdentity'
import { EmptyState, ErrorBox, Loading, PageBody, PageHeader, Tag, btn, btnPrimary, input } from '../components/ui'
import { useFeedStatus, useLive } from '../hooks/useLive'
import { applyFrame } from '../lib/frame'
import { useModelGraph } from '../hooks/useModelGraph'
import { iconOfType } from '../lib/graph'
import { nodeBadge } from '../lib/liveFrame'
import { addLane, addPoint, laneLengthM, laneTone, movePoint, occupancy, removePoint } from '../lib/mapGeom'
import {
  isOneWay, removeRoad, reverseRoad, roadsOf, roadInsertWaypoint, roadMoveWaypoint, roadOf, roadRemoveWaypoint, setOneWay, setRoadCapacity, straightenRoad,
} from '../lib/roads'
import { poolCount, thresholdsFor } from '../lib/model'
import { connectivityProblems } from '../lib/mapCheck'
import { mapLines, nodeFacts, type MapLine, type Tone } from '../lib/nodeFacts'
import { servedNodes } from '../lib/nodeTray'
import { placeCharger, placeNode } from '../lib/placeNode'
import { traceToMap, type Trace } from '../lib/traceMap'
import { addKeepout, insertKeepoutVertex, keepoutProblems, moveKeepoutVertex, polygonArea, removeKeepout, removeKeepoutVertex } from '../lib/zones'

const STATE_LABEL: Record<string, string> = { MOVING: 'đang chạy', WAITING: 'chờ vào làn', LOADING: 'bốc dỡ hàng', CHARGING: 'đang sạc', IDLE: 'nghỉ' }
const VEHICLE_DOT: Record<string, string> = { MOVING: 'bg-ok', WAITING: 'bg-bad', LOADING: 'bg-warn', CHARGING: 'bg-accent', IDLE: 'bg-faint' }
const TONE_LABEL = { ok: 'thông thoáng', busy: 'đầy chỗ', jam: 'có xe chờ' } as const
const FACT_TONE: Record<Tone, string> = { ok: 'text-ok-text', warn: 'text-lock-text', bad: 'text-bad-text', muted: 'text-text' }
const archetypeOf = (n: { archetype?: string; node_type: string }, types?: Record<string, { archetype: string }>) => n.archetype || types?.[n.node_type]?.archetype || ''

export default function AgvMapPage() {
  const model = decodeURIComponent(useParams().key ?? '')
  const qc = useQueryClient()
  const g = useModelGraph(model)
  const { snapshot } = useLive(model)
  const feed = useFeedStatus(model)
  const saved = useQuery({
    queryKey: ['agv-map', model],
    queryFn: async () => { try { return await api.agvMap(model) } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e } },
  })
  const [draft, setDraft] = useState<AgvMap | null>(null)
  const [selected, setSelected] = useState<MapSelection>(null)
  const [tool, setTool] = useState<MapTool>('select')
  const [linkFrom, setLinkFrom] = useState<string | null>(null)
  // Đang chỉnh ảnh nền trên bản đồ (khung dời, đổi cỡ, xoay)
  const [bgEdit, setBgEdit] = useState(false)
  const canvasRef = useRef<CanvasHandle>(null)
  const closeZoneRef = useRef<() => void>(() => {})
  const [panelOpen, setPanelOpen] = useState(true)
  const [tableOpen, setTableOpen] = useState(false)
  const [tableTab, setTableTab] = useState<'map' | 'cal'>('map')
  const [frameDraft, setFrameDraft] = useState<Frame | null>(null)  // khung toạ độ xe đang chỉnh (xem trước bằng chấm nét đứt)
  const [via, setVia] = useState<Pt[]>([])  // điểm uốn đã bấm của làn đang vẽ dở
  const [bgOpacity, setBgOpacity] = useState(0.55)
  const [showFacts, setShowFacts] = useState(true)  // hiện thông số quan trọng của node ngay dưới node trên bản đồ
  const [trace, setTrace] = useState<Trace | null>(null)  // bản nháp đường dò từ ảnh, chưa thêm vào bản đồ
  const [placing, setPlacing] = useState<string | null>(null)  // node của sơ đồ đang chờ bấm lên bản đồ để đặt
  const [note, setNote] = useState<string | null>(null)  // thông báo sau khi đặt node (vd. trạm chưa nối được)
  const [zoneDraft, setZoneDraft] = useState<Pt[] | null>(null)  // đỉnh đã bấm của vùng cấm đang vẽ dở (null: không ở công cụ vùng cấm)
  const [calib, setCalib] = useState<Pt[] | null>(null)  // hai điểm đã bấm để hiệu chuẩn ảnh nền (null: không đang hiệu chuẩn)
  const editing = draft !== null
  useEffect(() => {
    if (linkFrom === null) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setLinkFrom(null); setVia([]) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [linkFrom])
  const map = draft ?? saved.data ?? null
  useEffect(() => {
    if (placing === null) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPlacing(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [placing])
  useEffect(() => {
    if (!zoneDraft) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoneDraft([])
      else if (e.key === 'Enter') closeZoneRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoneDraft])

  const save = useMutation({
    mutationFn: async (m: AgvMap) => {
      await api.saveAgvMap(model, m)
      if (!m.bg && saved.data?.bg) await api.deleteAgvMapImage(model)  // ảnh nền đã bị gỡ khỏi bản đồ: dọn luôn ảnh trên server
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['agv-map', model] }); setTrace(null); setPlacing(null); setNote(null); setDraft(null); setSelected(null); setTool('select'); setLinkFrom(null); setVia([]); setCalib(null); setZoneDraft(null); setBgEdit(false) },
  })
  const refreshFeed = () => void qc.invalidateQueries({ queryKey: ['feed-status', model] })
  // Một đường hai chiều là hai làn nên chặn hay gỡ chặn đều làm cho cả hai.
  const block = useMutation({ mutationFn: (lanes: string[]) => Promise.all(lanes.map((lane) => api.feed.addIncident({ model, kind: 'lane_block', target: lane, duration_s: 1800 }))), onSuccess: refreshFeed })
  const unblock = useMutation({ mutationFn: (ids: number[]) => Promise.all(ids.map((id) => api.feed.clearIncident(model, id))), onSuccess: refreshFeed })

  const graph = g.status === 'ready' ? g.graph : undefined
  const types = g.status === 'ready' ? g.types : undefined
  const names = useMemo(() => {
    const out: Record<string, string> = {}
    for (const n of graph?.nodes ?? []) out[n.key] = n.name || types?.[n.node_type]?.name || n.key
    return out
  }, [graph, types])
  const kinds = useMemo(() => {
    const out: Record<string, { archetype?: string; icon?: string }> = {}
    for (const n of graph?.nodes ?? []) out[n.key] = { archetype: archetypeOf(n, types) || undefined, icon: iconOfType(types?.[n.node_type]) }
    return out
  }, [graph, types])
  const kindOf = (key: string) => kinds[key]
  const iconOfNode = (key: string) => { const n = graph?.nodes.find((x) => x.key === key); return n ? iconOfType(types?.[n.node_type]) : undefined }
  // Lỗi (server sẽ từ chối lưu) và cảnh báo (vẫn lưu được, nhưng xe sẽ không chạy như mong muốn).
  const allProblems = useMemo(
    () => (map ? [...keepoutProblems(map), ...(graph ? connectivityProblems(map, graph.edges, names) : [])] : []),
    [map, graph, names],
  )
  const problems = useMemo(() => allProblems.filter((p) => !p.warn), [allProblems])
  const warnings = useMemo(() => allProblems.filter((p) => p.warn), [allProblems])
  const issueIds = useMemo(() => new Set(problems.map((p) => p.key)), [problems])
  const rings = useMemo(() => {
    const out: Record<string, RingTone | undefined> = {}
    for (const n of graph?.nodes ?? []) {
      const ref = { node_type: n.node_type, params: n.params ?? {} }
      const b = nodeBadge(n.archetype || types?.[n.node_type]?.archetype || '', snapshot?.subjects[n.key], thresholdsFor(ref, types ?? {}),
        types ? poolCount(ref, types) : undefined)
      out[n.key] = b?.color === 'GREEN' ? 'ok' : b?.color === 'YELLOW' ? 'warn' : b?.color === 'RED' ? 'bad' : undefined
    }
    return out
  }, [graph, types, snapshot])
  // Node có xe chở tới thì phải nối vào đường; node khác (băng chuyền, máy đứng riêng) chỉ cần đánh dấu vị trí. Đội xe không có chỗ trên mặt bằng.
  const served = useMemo(() => servedNodes(graph?.edges ?? []), [graph])
  const unplaceable = useMemo(() => new Set((graph?.nodes ?? []).filter((n) => archetypeOf(n, types) === 'RESOURCE_POOL').map((n) => n.key)), [graph, types])
  const merged = (n: { node_type: string; params?: Record<string, unknown> }) => ({ ...(types?.[n.node_type]?.default_params ?? {}), ...(n.params ?? {}) })
  const factLines = useMemo(() => {
    const out: Record<string, MapLine[]> = {}
    for (const n of graph?.nodes ?? []) {
      const arch = archetypeOf(n, types)
      if (arch === 'RESOURCE_POOL') continue
      const ref = { node_type: n.node_type, params: n.params ?? {} }
      out[n.key] = mapLines(arch, snapshot?.subjects[n.key], { ...(types?.[n.node_type]?.default_params ?? {}), ...(n.params ?? {}) }, thresholdsFor(ref, types ?? {}))
    }
    return out
  }, [graph, types, snapshot])

  const laneBlocks = useMemo(
    // Sự cố thuộc feed của chính mô hình này; id làn của mô hình khác có thể trùng nhưng feed của chúng độc lập.
    () => new Map((feed.data?.incidents ?? []).filter((i) => i.kind === 'lane_block' && i.active).map((i) => [i.target, i])),
    [feed.data, model],
  )
  const blockedIds = useMemo(() => new Set(laneBlocks.keys()), [laneBlocks])
  const fleets = useMemo(() => Object.values(snapshot?.fleet ?? {}), [snapshot])
  const occ = useMemo(() => (map ? occupancy(map, fleets) : new Map()), [map, fleets])
  const ghosts = useMemo(
    () => (frameDraft ? fleets.flat().map((v) => { const [x, y] = applyFrame(frameDraft, v.raw_x, v.raw_y); return { id: v.id, x, y } }) : undefined),
    [frameDraft, fleets],
  )

  if (saved.isLoading || g.status === 'loading') return <Loading />
  if (saved.error) return <PageBody><PageHeader icon={MapIcon} title="Bản đồ AGV" subtitle={model} /><ErrorBox error={saved.error} /></PageBody>

  const startEdit = () => setDraft(saved.data ?? { v: 2, speed_mps: 1.2, points: [], lanes: [] })
  /** Bật/tắt khung chỉnh ảnh nền (dời, đổi cỡ, xoay); đang xem thì tự vào chế độ sửa. */
  const adjustImage = (on: boolean) => {
    if (on && !editing) startEdit()
    setBgEdit(on)
    if (on) { setTool('select'); setLinkFrom(null); setVia([]); setZoneDraft(null); setPlacing(null); setCalib(null) }
  }
  const cancelEdit = () => { setTrace(null); setPlacing(null); setNote(null); setDraft(null); setSelected(null); setTool('select'); setLinkFrom(null); setVia([]); setCalib(null); setZoneDraft(null); setBgEdit(false) }
  const apply = (f: (m: AgvMap) => AgvMap) => setDraft((d) => (d ? f(d) : d))
  const running = feed.data?.state === 'running'

  const onPointClick = (id: string) => {
    if (!editing || tool !== 'connect') return
    if (linkFrom === null) { setLinkFrom(id); setVia([]); return }
    if (id !== linkFrom) apply((m) => addLane(m, linkFrom, id, true, via))
    setLinkFrom(null)
    setVia([])
  }
  const placeAt = (nodeKey: string, at: Pt) => {
    if (!draft) return
    // Chỉ node có xe chở tới mới tự nối vào đường; máy khác (băng chuyền, đứng riêng) chỉ đánh dấu vị trí, không đụng vào mạng đường.
    const r = placeNode(draft, nodeKey, at, { connect: served.has(nodeKey) })
    setDraft(r.map)
    setSelected({ kind: 'point', id: r.pointId })
    setPlacing(null)
    setNote(r.connected === 'none' && r.reason ? `Đã đặt trạm ${r.pointId} nhưng chưa nối vào đường: ${r.reason}.` : null)
  }
  const onBackground = (at: Pt) => {
    if (!editing) return
    if (calib !== null) { if (calib.length < 2) setCalib([...calib, at]); return }  // đang hiệu chuẩn: chỗ trống chỉ để bấm điểm đo
    if (placing !== null) { placeAt(placing, at); return }
    if (tool === 'charger') {
      const r = placeCharger(draft!, at)
      setDraft(r.map)
      setSelected({ kind: 'point', id: r.pointId })
      setNote(r.connected === 'none' ? `Đã đặt chỗ sạc ${r.pointId} nhưng chưa nối vào đường: ${r.reason}.` : null)
      return
    }
    if (tool === 'keepout') { setZoneDraft((d) => [...(d ?? []), at]); return }
    if (tool === 'junction' || tool === 'station') apply((m) => addPoint(m, at, tool))
    else if (tool === 'connect' && linkFrom !== null) setVia((v) => [...v, at])  // chỗ trống khi đang vẽ làn = thêm một điểm uốn
  }

  const selPoint = map && selected?.kind === 'point' ? map.points.find((p) => p.id === selected.id) : undefined
  const closeZone = () => {
    if (!draft || !zoneDraft || zoneDraft.length < 3) return
    const next = addKeepout(draft, zoneDraft)
    setDraft(next)
    setSelected({ kind: 'zone', id: next.keepouts![next.keepouts!.length - 1].id })
    setZoneDraft([])
  }
  closeZoneRef.current = closeZone
  const selZone = map && selected?.kind === 'zone' ? (map.keepouts ?? []).find((z) => z.id === selected.id) : undefined
  const selRoad = map && selected?.kind === 'lane' ? roadOf(map, selected.id) : undefined
  const roadLanes = selRoad ? [selRoad.a, ...(selRoad.b ? [selRoad.b] : [])] : []
  const roadBlockIds = roadLanes.flatMap((l) => (laneBlocks.has(l.id) ? [laneBlocks.get(l.id)!.id] : []))
  const nodeOptions = graph?.nodes ?? []
  const selNode = selPoint?.node_key ? graph?.nodes.find((n) => n.key === selPoint.node_key) : undefined
  const selFacts = selNode
    ? nodeFacts(archetypeOf(selNode, types), snapshot?.subjects[selNode.key], merged(selNode), thresholdsFor({ node_type: selNode.node_type, params: selNode.params ?? {} }, types ?? {}),
      types ? poolCount({ node_type: selNode.node_type, params: selNode.params ?? {} }, types) : undefined)
    : []

  const peek = selPoint ? (
    <SidePeek
      title="Chi tiết điểm" heading={selPoint.id} onClose={() => setSelected(null)}
      subtitle={<Tag>{selPoint.kind === 'station' ? 'Trạm' : selPoint.kind === 'charger' ? 'Chỗ sạc' : 'Ngã tư'}</Tag>}
      summary={selPoint.kind === 'station' ? <p>Gắn với node {selPoint.node_key ? names[selPoint.node_key] ?? selPoint.node_key : '(chưa gắn)'}.</p> : undefined}
      menu={editing ? [{ key: 'delete', label: 'Xoá điểm và các làn nối vào nó', icon: Trash2, danger: true, onSelect: () => { apply((m) => removePoint(m, selPoint.id)); setSelected(null) } }] : undefined}
    >
      {selFacts.length > 0 && <FactList facts={selFacts} />}
      {selPoint.kind === 'station' && selPoint.node_key && !served.has(selPoint.node_key) && !map!.lanes.some((l) => l.from === selPoint.id || l.to === selPoint.id) && (
        <p className="mt-2 text-xs text-muted">Node này không có xe chở tới nên không cần nối vào đường; trạm chỉ đánh dấu vị trí.</p>
      )}
      {editing && <PointEditor point={selPoint} nodes={nodeOptions.map((n) => ({ key: n.key, name: names[n.key] ?? n.key }))}
        onChange={(p) => apply((m) => ({ ...m, points: m.points.map((q) => (q.id === p.id ? p : q)) }))} />}
    </SidePeek>
  ) : selZone ? (
    <SidePeek
      title="Chi tiết vùng cấm" heading={selZone.id} onClose={() => setSelected(null)}
      subtitle={<Tag>Xe không được vào</Tag>}
      summary={<p>{selZone.poly.length} đỉnh, diện tích khoảng {Math.round(Math.abs(polygonArea(selZone.poly)))} m². Đường và điểm không được nằm trong vùng này.</p>}
      menu={editing ? [{ key: 'delete', label: 'Xoá vùng cấm', icon: Trash2, danger: true, onSelect: () => { apply((m) => removeKeepout(m, selZone.id)); setSelected(null) } }] : undefined}
    >
      <div className="space-y-2 text-xs text-text-2">
        {problems.filter((p) => p.message.endsWith(selZone.id)).map((p) => <p key={p.key + p.message} className="text-bad-text">{p.key}: {p.message}</p>)}
        {editing && <p className="text-muted">Kéo chấm đỏ để dời đỉnh, bấm dấu + giữa cạnh để thêm đỉnh, bấm đúp một đỉnh để xoá nó.</p>}
      </div>
    </SidePeek>
  ) : selRoad ? (
    <SidePeek
      title="Chi tiết đường" heading={roadLanes.map((l) => l.id).join(' · ')} onClose={() => setSelected(null)}
      subtitle={<Tag>{selRoad.a.from} {isOneWay(selRoad) ? '→' : '↔'} {selRoad.a.to}</Tag>}
      summary={<p>
        Dài {Math.round(laneLengthM(map!, selRoad.a))} m{(selRoad.a.path?.length ?? 0) > 0 ? `, ${selRoad.a.path!.length} điểm uốn` : ''}, {isOneWay(selRoad) ? 'một chiều' : 'hai chiều'},
        mỗi chiều chứa tối đa {selRoad.b && selRoad.b.capacity !== selRoad.a.capacity ? `${selRoad.a.capacity} / ${selRoad.b.capacity}` : selRoad.a.capacity} xe.
      </p>}
      menu={editing
        ? [
            ...((selRoad.a.path?.length ?? 0) > 0 ? [{ key: 'straight', label: 'Làm thẳng đường', icon: Spline, onSelect: () => apply((m) => straightenRoad(m, selRoad.a.id)) }] : []),
            ...(isOneWay(selRoad) ? [{ key: 'reverse', label: 'Đổi chiều', icon: ArrowLeftRight, onSelect: () => apply((m) => reverseRoad(m, selRoad.a.id)) }] : []),
            { key: 'delete', label: 'Xoá đường', icon: Trash2, danger: true, onSelect: () => { apply((m) => removeRoad(m, selRoad.a.id)); setSelected(null) } },
          ]
        : roadBlockIds.length > 0
          ? [{ key: 'unblock', label: 'Gỡ chặn', icon: Unlock, disabled: unblock.isPending, onSelect: () => unblock.mutate(roadBlockIds) }]
          : [{ key: 'block', label: 'Chặn đường này 30 phút (demo)', icon: Ban, disabled: !running || block.isPending, hint: 'Bật feed giả lập để bơm sự cố chặn đường.', onSelect: () => block.mutate(roadLanes.map((l) => l.id)) }]}
    >
      <div className="space-y-2 text-xs text-text-2">
        {!editing && roadLanes.map((l) => {
          const o = occ.get(l.id)
          return o ? (
            <p key={l.id}>Chiều {l.from} → {l.to}: <b className="text-text">{o.holding}</b> xe, <b className="text-text">{o.waiting}</b> chờ vào làn kế ({TONE_LABEL[laneTone(o)]}).</p>
          ) : null
        })}
        {editing && (
          <>
            <label className="block space-y-1"><span className="block">Sức chứa mỗi chiều</span>
              <input type="number" min={1} className={`${input} w-20`} value={selRoad.a.capacity} onChange={(e) => apply((m) => setRoadCapacity(m, selRoad.a.id, Number(e.target.value)))} /></label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={isOneWay(selRoad)} onChange={(e) => apply((m) => setOneWay(m, selRoad.a.id, e.target.checked))} />
              <span>Một chiều (xe chỉ đi từ {selRoad.a.from} tới {selRoad.a.to})</span></label>
          </>
        )}
        {!editing && roadBlockIds.length > 0 && <p className="text-bad-text">Đang bị chặn (sự cố bơm vào feed giả lập).</p>}
        {!editing && !running && <p className="text-faint">Bật feed giả lập để bơm sự cố chặn đường (thao tác demo).</p>}
      </div>
    </SidePeek>
  ) : null

  const PANEL_W = 320
  // Tấm chi tiết (SidePeek) đè lên mép phải với bề rộng tối đa 680px; thanh công cụ tránh nó.
  const peekInset = peek ? Math.min(680, window.innerWidth * 0.92) : 0
  const DRAWER_H = 280
  const roadCount = map ? roadsOf(map).length : 0
  const placeableNodes = (graph?.nodes ?? []).filter((n) => !unplaceable.has(n.key))
  const placeableCount = placeableNodes.length
  const placedCount = placeableNodes.filter((n) => map?.points.some((p) => p.kind === 'station' && p.node_key === n.key)).length
  const vehicleCount = Object.values(snapshot?.fleet ?? {}).reduce((n, vs) => n + vs.length, 0)
  const fleetList = vehicleCount === 0 ? (
    <div className="flex items-start gap-2.5 rounded-lg bg-panel-2 p-2.5">
      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-raised text-faint"><Truck size={15} aria-hidden /></span>
      <div className="min-w-0 space-y-1.5">
        <p className="text-[12px] font-medium text-text">Chưa thấy xe nào</p>
        <p className="text-[11px] leading-snug text-muted">Ghép tín hiệu "Vị trí từng xe" cho đội xe, rồi bật feed ở thanh trên.</p>
        <Link to={`/models/${encodeURIComponent(model)}/connect`} className="inline-block text-[11.5px] font-medium text-accent hover:underline">Mở Kết nối dữ liệu</Link>
      </div>
    </div>
  ) : (
    <div className="space-y-3">
      {Object.entries(snapshot!.fleet).map(([pool, vs]) => (
        <div key={pool}>
          <div className="mb-1.5 flex items-center gap-2">
            <NodeAvatar archetype="RESOURCE_POOL" icon={iconOfNode(pool)} size={22} />
            <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-text">{names[pool] ?? pool}</span>
            <span className="text-[11px] tabular-nums text-muted">{vs.length} xe</span>
          </div>
          <ul className="space-y-0.5">
            {vs.map((v) => (
              <li key={v.id} className="flex items-center gap-2 rounded-md px-1 py-1 text-[11.5px] hover:bg-panel-2">
                <i className={`h-2 w-2 flex-none rounded-full ${VEHICLE_DOT[v.state] ?? 'bg-faint'}`} aria-hidden />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="flex items-baseline gap-1.5">
                    <b className="font-semibold text-text">{v.id}</b>
                    <span className="text-text-2">{STATE_LABEL[v.state] ?? v.state}</span>
                    {v.load > 0 && <span className="text-muted">chở {v.load}</span>}
                  </span>
                  {(v.lane || v.dest || v.speed !== undefined || v.off_map) && (
                    <span className="block truncate text-[10.5px] text-faint">
                      {[v.dest && `tới ${names[v.dest] ?? v.dest}`, v.lane && `làn ${v.lane}`, v.speed !== undefined && `${v.speed.toFixed(1).replace('.', ',')} m/s`, v.off_map && 'ngoài đường'].filter(Boolean).join(', ')}
                    </span>
                  )}
                </span>
                {v.battery !== undefined && (
                  <span title={`Pin ${Math.round(v.battery)}%`} className="flex flex-none items-center gap-1 tabular-nums">
                    {v.state === 'CHARGING' && <BatteryCharging size={12} className="text-ok" aria-hidden />}
                    <span className="h-1.5 w-8 overflow-hidden rounded-full bg-raised"><i className={`block h-full ${v.battery < 25 ? 'bg-bad' : v.battery < 50 ? 'bg-warn' : 'bg-ok'}`} style={{ width: `${Math.max(2, Math.min(100, v.battery))}%` }} /></span>
                    <span className={`w-7 text-right ${v.battery < 25 ? 'text-bad-text' : 'text-muted'}`}>{Math.round(v.battery)}%</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )

  // Trang kiểu Sơ đồ: canvas lấp đầy vùng làm việc, mọi thứ khác là bảng nổi (bên trái), thanh công cụ (đáy) và ngăn dữ liệu (đáy).
  return (
    <PeekHost peek={peek} onClose={() => setSelected(null)}>
      <div className="flex h-full min-h-[480px] flex-col">
        <HeaderActions>
          {editing ? (
            <>
              <span className="text-[11px] text-muted">Đang sửa bản đồ</span>
              <button className={btn} onClick={cancelEdit}>Huỷ</button>
              <button className={btnPrimary} disabled={save.isPending || problems.length > 0} title={problems.length > 0 ? 'Sửa các lỗi báo trên bản đồ trước khi lưu' : undefined} onClick={() => save.mutate(draft!)}>Lưu bản đồ</button>
            </>
          ) : map ? <button className={btn} onClick={startEdit}>Sửa bản đồ</button> : null}
        </HeaderActions>
        <div className="flex-none border-b border-line bg-panel p-2"><FeedControl model={model} offerFrame /></div>

        <div
          className="relative min-h-0 flex-1 overflow-hidden bg-bg"
          onDragOver={(e) => { if (editing && e.dataTransfer.types.includes(NODE_DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }}
          onDrop={(e) => {
            const key = e.dataTransfer.getData(NODE_DRAG_TYPE)
            if (!editing || !key || !canvasRef.current) return
            e.preventDefault()
            placeAt(key, canvasRef.current.toMap(e))
          }}
        >
          {!map ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <EmptyState title="Mô hình chưa có bản đồ AGV">
                Bản đồ cho biết trạm nào nằm ở đâu, xe đi đường nào và làn nào dễ tắc. Bản đồ mẫu có trong scripts/seed_demo.py; hoặc tự vẽ.
                <div className="mt-3"><button className={btnPrimary} onClick={startEdit}>Vẽ bản đồ mới</button></div>
              </EmptyState>
            </div>
          ) : (
            <>
              <AgvMapCanvas
                ref={canvasRef} padLeft={panelOpen ? PANEL_W + 24 : 0}
                map={map} fleets={fleets} names={names} ringOf={(k) => rings[k]} kindOf={kindOf} linesOf={showFacts ? (k) => factLines[k] : undefined} blocked={blockedIds} selected={selected} editing={editing} linkFrom={linkFrom}
                draft={linkFrom ? { from: linkFrom, via } : null} ghosts={ghosts}
                bgUrl={map.bg ? api.agvMapImageUrl(model, map.bg.rev) : undefined} bgOpacity={bgOpacity} calibPts={calib ?? undefined} tracePreview={trace}
                zoneDraft={tool === 'keepout' ? zoneDraft : null} zonesClickable={!editing || tool === 'select'} issueIds={issueIds} onCloseZone={closeZone}
                onMoveZoneVertex={(id, i, x, y) => apply((m) => moveKeepoutVertex(m, id, i, x, y))}
                onInsertZoneVertex={(id, i, at) => apply((m) => insertKeepoutVertex(m, id, i, at))}
                onRemoveZoneVertex={(id, i) => apply((m) => removeKeepoutVertex(m, id, i))}
                bgEdit={editing && bgEdit} onBgChange={(bg) => apply((m) => ({ ...m, bg }))}
                onSelect={setSelected} onPointClick={onPointClick} onMovePoint={(id, x, y) => apply((m) => movePoint(m, id, x, y))} onBackgroundClick={onBackground}
                onMoveWaypoint={(lane, i, x, y) => apply((m) => roadMoveWaypoint(m, lane, i, x, y))}
                onInsertWaypoint={(lane, i, at) => apply((m) => roadInsertWaypoint(m, lane, i, at))}
                onRemoveWaypoint={(lane, i) => apply((m) => roadRemoveWaypoint(m, lane, i))}
              />

              {panelOpen && (
                <FloatingPanel side="left" width={PANEL_W} top={12} bottom={tableOpen ? DRAWER_H + 12 : 64} title="Bản đồ AGV" onClose={() => setPanelOpen(false)}
                  stats={[
                    { icon: MapPin, value: map.points.length, label: 'điểm' },
                    { icon: Route, value: roadCount, label: 'đường' },
                    { icon: Gauge, value: String(map.speed_mps).replace('.', ','), label: 'm/s' },
                  ]}>
                  <PanelSection title="Đội xe" icon={Truck} meta={vehicleCount > 0 ? `${vehicleCount} xe` : undefined}>{fleetList}</PanelSection>
                  <PanelSection title="Node trên bản đồ" icon={Waypoints} meta={`${placedCount}/${placeableCount}`}>
                    <NodeTray nodes={graph?.nodes ?? []} edges={graph?.edges ?? []} map={map} names={names} types={types} skip={unplaceable} editing={editing} armed={placing}
                      onArm={(k) => { setPlacing(k); if (k) { setTool('select'); setLinkFrom(null); setZoneDraft(null); setCalib(null) } }}
                      onFocusNode={(k) => { const st = map.points.find((p) => p.kind === 'station' && p.node_key === k); if (st) setSelected({ kind: 'point', id: st.id }) }} />
                  </PanelSection>
                  <PanelSection title="Vùng cấm" icon={OctagonX} meta={(map.keepouts ?? []).length || undefined}>
                    <div className="space-y-2 text-xs">
                      {(map.keepouts ?? []).length === 0
                        ? <p className="text-[11px] text-muted">Chưa có vùng cấm. Khoanh máy, kệ, khu văn phòng để xe không đi qua; đường cắt qua vùng cấm sẽ bị báo lỗi.</p>
                        : (
                          <ul className="-mx-1.5 space-y-px">
                            {(map.keepouts ?? []).map((z) => {
                              const bad = problems.filter((p) => p.message.endsWith(z.id)).length
                              const sel = selected?.kind === 'zone' && selected.id === z.id
                              return (
                                <li key={z.id}>
                                  <button type="button" onClick={() => setSelected({ kind: 'zone', id: z.id })}
                                    className={`flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left ${sel ? 'bg-raised' : 'hover:bg-panel-2'}`}>
                                    <span className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-bad/12 text-bad-text" aria-hidden><OctagonX size={14} /></span>
                                    <span className="min-w-0 flex-1 leading-tight">
                                      <span className="block truncate text-[12.5px] font-medium text-text">{z.id}</span>
                                      <span className="block text-[10.5px] text-faint">{z.poly.length} đỉnh, {Math.round(Math.abs(polygonArea(z.poly)))} m²</span>
                                    </span>
                                    {bad > 0 && <span className="flex-none text-[10.5px] font-medium text-bad-text" title="Có đường hoặc điểm nằm trong vùng này">{bad} lỗi</span>}
                                  </button>
                                </li>
                              )
                            })}
                          </ul>
                        )}
                      <button className={btn} onClick={() => {
                        if (!editing) startEdit()
                        setTool('keepout'); setLinkFrom(null); setVia([]); setPlacing(null); setBgEdit(false); setZoneDraft([]); setSelected(null)
                      }}><OctagonX size={13} aria-hidden />Vẽ vùng cấm</button>
                    </div>
                  </PanelSection>
                  {editing && map.bg && (
                    <PanelSection title="Dò đường từ ảnh" icon={ScanLine}>
                      <TracePanel model={model} map={map} preview={trace} onPreview={setTrace}
                        onApply={() => {
                          if (!trace || !draft) return
                          const r = traceToMap(draft, trace)
                          setDraft(r.map)
                          setTrace(null)
                          setNote(`Đã thêm ${r.added} đường từ ảnh${r.dropped > 0 ? `, bỏ ${r.dropped} đường cắt vùng cấm` : ''}. Kéo điểm, thêm điểm uốn hay xoá đường nào chưa đúng, rồi đặt các node lên bản đồ.`)
                        }} />
                    </PanelSection>
                  )}
                  <PanelSection title="Ảnh nền" icon={ImageIcon} meta={map.bg ? (map.bg.calibrated ? 'đã hiệu chuẩn' : 'chưa hiệu chuẩn') : 'chưa có'}>
                    <BackgroundPanel model={model} map={map} editing={editing} opacity={bgOpacity} onOpacity={setBgOpacity} calib={calib} onCalib={setCalib}
                      adjusting={editing && bgEdit} onAdjust={(on) => adjustImage(on)}
                      onChange={(bg) => apply((m) => ({ ...m, bg }))} />
                  </PanelSection>
                  {editing ? (
                    <PanelSection title="Thông số chung" icon={SlidersHorizontal}>
                      <label className="block space-y-1 text-xs"><span className="block text-text-2">Tốc độ xe (m/s)</span>
                        <input className={`${input} w-full`} inputMode="decimal" value={draft!.speed_mps} onChange={(e) => apply((m) => ({ ...m, speed_mps: Number(e.target.value) || 0 }))} /></label>
                    </PanelSection>
                  ) : (
                    <PanelSection title="Khung toạ độ xe" icon={Crosshair} defaultOpen={vehicleCount > 0}>
                      <FrameCard bare model={model} map={map} names={names} fleets={fleets} draft={frameDraft} onDraft={setFrameDraft} />
                    </PanelSection>
                  )}
                  <PanelSection title="Chú giải" icon={BookOpen} defaultOpen={false}>
                    <p className="text-[11px] leading-relaxed text-muted">
                      Xe: <b className="text-ok">xanh</b> đang chạy, <b className="text-warn">vàng</b> bốc dỡ hàng, <b className="text-bad-text">đỏ</b> chờ vào làn, xám nghỉ; vòng nét đứt là đang chở hàng; mũi tên trắng là hướng xe.
                      Làn: xám thông thoáng, <b className="text-warn">vàng</b> đầy chỗ, <b className="text-bad-text">đỏ</b> có xe chờ. Viền trạm theo trạng thái node trong sơ đồ.
                      Lăn chuột để thu phóng, kéo chỗ trống để dời bản đồ.
                    </p>
                  </PanelSection>
                </FloatingPanel>
              )}

              {editing && (
                <div role="status" className="absolute z-10 max-w-[520px] -translate-x-1/2 rounded-lg border border-line bg-panel px-3 py-1.5 text-center text-[11px] text-muted shadow-lg" style={{ bottom: (tableOpen ? DRAWER_H : 0) + 56, left: `calc((100% - ${peekInset}px) / 2)` }}>
                  {placing !== null
                    ? `Bấm lên bản đồ để đặt "${names[placing] ?? placing}"${served.has(placing) ? '; có xe chở tới nên trạm tự nối vào đường gần nhất' : '; chỉ đánh dấu vị trí, không nối đường'}. Esc để huỷ.`
                  : bgEdit
                    ? 'Chỉnh ảnh nền: kéo trong khung để dời, kéo một góc để đổi cỡ, kéo núm tròn để xoay (giữ Shift: bước 15°). Bấm Xong ở bảng bên trái khi vừa ý.'
                  : calib !== null
                    ? 'Hiệu chuẩn: bấm hai điểm trên ảnh có khoảng cách đã biết (một cột tới cột kia, bề rộng lối đi), rồi nhập khoảng cách thật ở bảng bên trái.'
                  : tool === 'keepout'
                    ? (zoneDraft && zoneDraft.length > 0
                      ? `Đã bấm ${zoneDraft.length} đỉnh: bấm tiếp để thêm đỉnh${zoneDraft.length >= 3 ? ', bấm đỉnh đầu hoặc Enter để khép kín' : ''}, Esc để bỏ.`
                      : 'Bấm các đỉnh của vùng xe không được vào (máy, kệ, tường).')
                  : tool === 'connect'
                    ? (linkFrom
                      ? `Đang vẽ từ ${linkFrom}: bấm chỗ trống để thêm điểm uốn (đã có ${via.length}), bấm một điểm để kết thúc, Esc để huỷ.`
                      : 'Bấm điểm đầu, bấm chỗ trống để thêm điểm uốn nếu đường cong hay chéo, rồi bấm điểm cuối. Đường mới là hai chiều.')
                    : tool === 'select' ? 'Kéo điểm để dời; bấm một đường để thêm (dấu +), kéo hoặc xoá (bấm đúp) điểm uốn của nó. Lưu áp dụng cho lần phát kế của feed.' : 'Bấm vào chỗ trống trên bản đồ để đặt điểm mới.'}
                </div>
              )}

              <MapToolbar
                editing={editing} tool={tool} onTool={(t) => { if (!editing) startEdit(); setTool(t); setLinkFrom(null); setVia([]); setPlacing(null); setBgEdit(false); setZoneDraft(t === 'keepout' ? [] : null) }}
                onZoomBy={(f) => canvasRef.current?.zoomBy(f)} onFit={() => canvasRef.current?.fit()}
                panelOpen={panelOpen} onPanel={() => setPanelOpen((o) => !o)} tableOpen={tableOpen} onTable={() => setTableOpen((o) => !o)}
                factsOn={showFacts} onFacts={() => setShowFacts((s) => !s)}
                image={map?.bg ? { on: editing && bgEdit, toggle: () => adjustImage(!(editing && bgEdit)) } : undefined}
                bottom={`${tableOpen ? DRAWER_H + 12 : 12}px`} rightInset={peekInset}
              />

              {tableOpen && (
                <section aria-label="Bảng dữ liệu bản đồ" className="absolute inset-x-0 bottom-0 z-10 flex flex-col border-t border-line bg-panel shadow-lg" style={{ height: DRAWER_H }}>
                  <header className="flex flex-none items-center gap-4 border-b border-line px-4 pt-2">
                    {([['map', 'Điểm và làn'], ['cal', 'Hiệu chỉnh thời gian chuyến']] as const).map(([t, label]) => (
                      <button key={t} role="tab" aria-selected={tableTab === t} onClick={() => setTableTab(t)}
                        className={`-mb-px border-b-2 pb-1.5 text-xs font-medium ${tableTab === t ? 'border-text font-semibold text-text' : 'border-transparent text-muted hover:text-text'}`}>{label}</button>
                    ))}
                    <button aria-label="Đóng bảng" onClick={() => setTableOpen(false)} className="ml-auto pb-1.5 text-muted hover:text-text"><X size={14} /></button>
                  </header>
                  <div className="min-h-0 flex-1 overflow-auto p-3">
                    {tableTab === 'map'
                      ? <MapTables map={map} names={names} occ={occ} blocked={blockedIds} selected={selected} onSelect={setSelected} />
                      : <CalibrationCard model={model} />}
                  </div>
                </section>
              )}
            </>
          )}
          <div className="absolute left-1/2 top-3 z-20 w-[420px] max-w-[calc(100%-1.5rem)] -translate-x-1/2 space-y-2">
            {editing && problems.length > 0 && (
              <div role="alert" className="rounded-lg border border-bad bg-panel px-3 py-2 text-xs text-bad-text shadow-lg">
                <b>Bản đồ có {problems.length} lỗi, chưa lưu được:</b>
                <ul className="mt-1 list-disc pl-4">{problems.slice(0, 4).map((p) => <li key={p.key + p.message}>{p.key}: {p.message}</li>)}</ul>
                {problems.length > 4 && <p className="mt-1">…và {problems.length - 4} lỗi khác.</p>}
              </div>
            )}
            {warnings.length > 0 && (
              <div role="status" className="rounded-lg border border-warn bg-panel px-3 py-2 text-xs text-lock-text shadow-lg">
                <b>{warnings.length} đường nối của xe chưa chạy được trên bản đồ:</b>
                <ul className="mt-1 list-disc pl-4">{warnings.slice(0, 3).map((p) => <li key={p.key}>{p.key}: {p.message}</li>)}</ul>
                {warnings.length > 3 && <p className="mt-1">…và {warnings.length - 3} đường nối khác.</p>}
              </div>
            )}
            {editing && note && (
              <div role="status" className="flex items-start gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-xs text-text-2 shadow-lg">
                <span className="flex-1">{note}</span>
                <button aria-label="Đóng thông báo" className="flex-none text-muted hover:text-text" onClick={() => setNote(null)}><X size={13} /></button>
              </div>
            )}
          </div>
          {(save.error || block.error || unblock.error) && <div className="absolute left-1/2 bottom-24 z-20 w-[420px] -translate-x-1/2"><ErrorBox error={save.error ?? block.error ?? unblock.error} /></div>}
        </div>
      </div>
    </PeekHost>
  )
}

/** Thông số của node trong tấm chi tiết: số đo trực tiếp (từ thiết bị) rồi thiết lập trong sơ đồ. */
function FactList({ facts }: { facts: ReturnType<typeof nodeFacts> }) {
  const groups = [['live', 'Số đo trực tiếp'], ['config', 'Thiết lập trong sơ đồ']] as const
  return (
    <div className="space-y-3 text-xs">
      {groups.map(([section, title]) => {
        const rows = facts.filter((f) => f.section === section)
        return rows.length === 0 ? null : (
          <div key={section}>
            <div className="mb-1 text-[11px] font-semibold text-muted">{title}</div>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
              {rows.map((f) => (<div key={f.label} className="contents"><dt className="text-text-2">{f.label}</dt><dd className={`text-right tabular-nums ${FACT_TONE[f.tone ?? 'muted']}`}>{f.value}</dd></div>))}
            </dl>
          </div>
        )
      })}
    </div>
  )
}

function PointEditor({ point, nodes, onChange }: {
  point: MapPoint; nodes: { key: string; name: string }[]; onChange: (p: MapPoint) => void
}) {
  return (
    <div className="space-y-2 text-xs">
      <label className="block space-y-1"><span className="block text-text-2">Loại điểm</span>
        <select className={`${input} w-full`} value={point.kind} onChange={(e) => onChange({ ...point, kind: e.target.value as MapPoint['kind'] })}>
          <option value="junction">Ngã tư</option><option value="station">Trạm</option><option value="charger">Chỗ sạc</option>
        </select></label>
      {point.kind === 'station' && (
        <label className="block space-y-1"><span className="block text-text-2">Trạm này là node nào trong sơ đồ?</span>
          <select className={`${input} w-full`} value={point.node_key ?? ''} onChange={(e) => onChange({ ...point, node_key: e.target.value || undefined })}>
            <option value="">Chưa gắn</option>
            {nodes.map((n) => <option key={n.key} value={n.key}>{n.name} ({n.key})</option>)}
          </select></label>
      )}
    </div>
  )
}
