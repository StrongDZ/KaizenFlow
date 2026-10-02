import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Ban, Spline, Trash2, Unlock } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { api, ApiError } from '../api/client'
import type { AgvMap, Frame, MapPoint, Pt } from '../api/types'
import { CalibrationCard } from '../components/live/CalibrationCard'
import { AgvMapCanvas, type MapSelection, type RingTone } from '../components/live/AgvMapCanvas'
import { FeedControl } from '../components/live/FeedControl'
import { FrameCard } from '../components/live/FrameCard'
import { MapTables } from '../components/live/MapTables'
import { PeekHost, SidePeek } from '../components/SidePeek'
import { Card, EmptyState, ErrorBox, Loading, Notice, PageBody, PageHeader, Tag, btn, btnPrimary, input } from '../components/ui'
import { useFeedStatus, useLive } from '../hooks/useLive'
import { applyFrame } from '../lib/frame'
import { useModelGraph } from '../hooks/useModelGraph'
import { nodeBadge } from '../lib/liveFrame'
import {
  addLane, addPoint, insertWaypoint, laneLengthM, laneTone, movePoint, moveWaypoint, occupancy, removeLane, removePoint, removeWaypoint, setLaneCapacity,
} from '../lib/mapGeom'
import { poolCount, thresholdsFor } from '../lib/model'

type Tool = 'select' | 'junction' | 'station' | 'connect'

const STATE_LABEL: Record<string, string> = { MOVING: 'đang chạy', WAITING: 'chờ vào làn', LOADING: 'bốc dỡ hàng', IDLE: 'nghỉ' }
const TONE_LABEL = { ok: 'thông thoáng', busy: 'đầy chỗ', jam: 'có xe chờ' } as const

export default function AgvMapPage() {
  const model = decodeURIComponent(useParams().key ?? '')
  const qc = useQueryClient()
  const g = useModelGraph(model)
  const { snapshot } = useLive(model)
  const feed = useFeedStatus()
  const saved = useQuery({
    queryKey: ['agv-map', model],
    queryFn: async () => { try { return await api.agvMap(model) } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e } },
  })
  const [draft, setDraft] = useState<AgvMap | null>(null)
  const [selected, setSelected] = useState<MapSelection>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [linkFrom, setLinkFrom] = useState<string | null>(null)
  const [frameDraft, setFrameDraft] = useState<Frame | null>(null)  // khung toạ độ xe đang chỉnh (xem trước bằng chấm nét đứt)
  const [via, setVia] = useState<Pt[]>([])  // điểm uốn đã bấm của làn đang vẽ dở
  const [bothWays, setBothWays] = useState(true)
  const editing = draft !== null
  useEffect(() => {
    if (linkFrom === null) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setLinkFrom(null); setVia([]) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [linkFrom])
  const map = draft ?? saved.data ?? null

  const save = useMutation({
    mutationFn: (m: AgvMap) => api.saveAgvMap(model, m),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['agv-map', model] }); setDraft(null); setSelected(null); setTool('select'); setLinkFrom(null); setVia([]) },
  })
  const refreshFeed = () => void qc.invalidateQueries({ queryKey: ['feed-status'] })
  const block = useMutation({ mutationFn: (lane: string) => api.feed.addIncident({ kind: 'lane_block', target: lane, duration_s: 1800 }), onSuccess: refreshFeed })
  const unblock = useMutation({ mutationFn: (id: number) => api.feed.clearIncident(id), onSuccess: refreshFeed })

  const graph = g.status === 'ready' ? g.graph : undefined
  const types = g.status === 'ready' ? g.types : undefined
  const names = useMemo(() => {
    const out: Record<string, string> = {}
    for (const n of graph?.nodes ?? []) out[n.key] = n.name || types?.[n.node_type]?.name || n.key
    return out
  }, [graph, types])
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

  const laneBlocks = useMemo(
    // Sự cố thuộc mô hình mà feed đang chạy; id làn của mô hình khác có thể trùng nên không được lẫn vào.
    () => new Map((feed.data?.model === model ? feed.data.incidents : []).filter((i) => i.kind === 'lane_block' && i.active).map((i) => [i.target, i])),
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
  if (saved.error) return <PageBody><PageHeader title="Bản đồ AGV" subtitle={model} /><ErrorBox error={saved.error} /></PageBody>

  const startEdit = () => setDraft(saved.data ?? { v: 2, speed_mps: 1.2, points: [], lanes: [] })
  const cancelEdit = () => { setDraft(null); setSelected(null); setTool('select'); setLinkFrom(null); setVia([]) }
  const apply = (f: (m: AgvMap) => AgvMap) => setDraft((d) => (d ? f(d) : d))
  const running = feed.data?.state === 'running' && feed.data.model === model

  const onPointClick = (id: string) => {
    if (!editing || tool !== 'connect') return
    if (linkFrom === null) { setLinkFrom(id); setVia([]); return }
    if (id !== linkFrom) apply((m) => addLane(m, linkFrom, id, bothWays, via))
    setLinkFrom(null)
    setVia([])
  }
  const onBackground = (at: Pt) => {
    if (!editing) return
    if (tool === 'junction' || tool === 'station') apply((m) => addPoint(m, at, tool))
    else if (tool === 'connect' && linkFrom !== null) setVia((v) => [...v, at])  // chỗ trống khi đang vẽ làn = thêm một điểm uốn
  }

  const selPoint = map && selected?.kind === 'point' ? map.points.find((p) => p.id === selected.id) : undefined
  const selLane = map && selected?.kind === 'lane' ? map.lanes.find((l) => l.id === selected.id) : undefined
  const nodeOptions = graph?.nodes ?? []

  const peek = selPoint ? (
    <SidePeek
      title="Chi tiết điểm" heading={selPoint.id} onClose={() => setSelected(null)}
      subtitle={<Tag>{selPoint.kind === 'station' ? 'Trạm' : selPoint.kind === 'charger' ? 'Chỗ sạc' : 'Ngã tư'}</Tag>}
      summary={selPoint.kind === 'station' ? <p>Gắn với node {selPoint.node_key ? names[selPoint.node_key] ?? selPoint.node_key : '(chưa gắn)'}.</p> : undefined}
      menu={editing ? [{ key: 'delete', label: 'Xoá điểm và các làn nối vào nó', icon: Trash2, danger: true, onSelect: () => { apply((m) => removePoint(m, selPoint.id)); setSelected(null) } }] : undefined}
    >
      {editing && <PointEditor point={selPoint} nodes={nodeOptions.map((n) => ({ key: n.key, name: names[n.key] ?? n.key }))}
        onChange={(p) => apply((m) => ({ ...m, points: m.points.map((q) => (q.id === p.id ? p : q)) }))} />}
    </SidePeek>
  ) : selLane ? (
    <SidePeek
      title="Chi tiết làn" heading={selLane.id} onClose={() => setSelected(null)}
      subtitle={<Tag>{selLane.from} → {selLane.to}</Tag>}
      summary={<p>Dài {Math.round(laneLengthM(map!, selLane))} m{(selLane.path?.length ?? 0) > 0 ? `, ${selLane.path!.length} điểm uốn` : ''}, chứa tối đa {selLane.capacity} xe.</p>}
      menu={editing
        ? [
            ...((selLane.path?.length ?? 0) > 0 ? [{ key: 'straight', label: 'Làm thẳng làn', icon: Spline, onSelect: () => apply((m) => ({ ...m, lanes: m.lanes.map((l) => (l.id === selLane.id ? { ...l, path: undefined } : l)) })) }] : []),
            { key: 'delete', label: 'Xoá làn', icon: Trash2, danger: true, onSelect: () => { apply((m) => removeLane(m, selLane.id)); setSelected(null) } },
          ]
        : laneBlocks.has(selLane.id)
          ? [{ key: 'unblock', label: 'Gỡ chặn', icon: Unlock, disabled: unblock.isPending, onSelect: () => unblock.mutate(laneBlocks.get(selLane.id)!.id) }]
          : [{ key: 'block', label: 'Chặn làn này 30 phút', icon: Ban, disabled: !running || block.isPending, hint: 'Bật feed để bơm sự cố chặn làn.', onSelect: () => block.mutate(selLane.id) }]}
    >
      <div className="space-y-2 text-xs text-text-2">
        {!editing && occ.get(selLane.id) && (
          <p>Đang có <b className="text-text">{occ.get(selLane.id)!.holding}</b> xe, <b className="text-text">{occ.get(selLane.id)!.waiting}</b> chờ vào làn kế: {TONE_LABEL[laneTone(occ.get(selLane.id)!)]}.</p>
        )}
        {editing && (
          <label className="block space-y-1"><span className="block">Sức chứa</span>
            <input type="number" min={1} className={`${input} w-20`} value={selLane.capacity} onChange={(e) => apply((m) => setLaneCapacity(m, selLane.id, Number(e.target.value)))} /></label>
        )}
        {!editing && laneBlocks.has(selLane.id) && <p className="text-bad-text">Đang bị chặn (sự cố bơm từ bảng demo).</p>}
        {!editing && !running && <p className="text-faint">Bật feed để bơm sự cố chặn làn.</p>}
      </div>
    </SidePeek>
  ) : null

  return (
    <PeekHost peek={peek} onClose={() => setSelected(null)}>
      <PageBody wide>
        <PageHeader
          title="Bản đồ AGV"
          subtitle={model}
          actions={!editing && map ? <button className={btn} onClick={startEdit}>Sửa bản đồ</button> : undefined}
        />
        <FeedControl model={model} offerFrame />
        <ErrorBox error={save.error ?? block.error ?? unblock.error} />

        {!map ? (
          <Card title="Chưa có bản đồ">
            <EmptyState title="Mô hình chưa có bản đồ AGV">
              Bản đồ cho biết trạm nào nằm ở đâu, xe đi đường nào và làn nào dễ tắc. Bản đồ mẫu có trong scripts/seed_demo.py; hoặc tự vẽ.
              <div className="mt-3"><button className={btnPrimary} onClick={startEdit}>Vẽ bản đồ mới</button></div>
            </EmptyState>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Card
              title={editing ? 'Đang sửa bản đồ' : 'Xe chạy trực tiếp'}
              actions={editing ? undefined : <Tag>{map.points.length} điểm · {map.lanes.length} làn · {map.speed_mps} m/s</Tag>}
            >
              {editing && (
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  {/* Lưu/Huỷ nằm đầu hàng bên trái: tấm chi tiết đè lên phần bên phải của trang nên không được để nút quan trọng ở đó. */}
                  <button className={btnPrimary} disabled={save.isPending} onClick={() => save.mutate(draft!)}>Lưu bản đồ</button>
                  <button className={btn} onClick={cancelEdit}>Huỷ</button>
                  <span className="mx-1 h-5 w-px bg-line" aria-hidden />
                  {([['select', 'Chọn, kéo'], ['junction', '＋ Ngã tư'], ['station', '＋ Trạm'], ['connect', 'Vẽ làn']] as [Tool, string][]).map(([t, label]) => (
                    <button key={t} aria-pressed={tool === t} onClick={() => { setTool(t); setLinkFrom(null); setVia([]) }}
                      className={`rounded-md border px-2 py-1 text-[11px] ${tool === t ? 'border-text bg-text font-semibold text-bg' : 'border-line-2 text-muted hover:text-text'}`}>{label}</button>
                  ))}
                  {tool === 'connect' && (
                    <label className="flex items-center gap-1 text-[11px] text-muted"><input type="checkbox" checked={bothWays} onChange={(e) => setBothWays(e.target.checked)} /> hai chiều</label>
                  )}
                </div>
              )}
              {editing && (
                <p className="mb-2 text-[11px] text-muted">
                  {tool === 'connect'
                    ? (linkFrom
                      ? `Đang vẽ từ ${linkFrom}: bấm chỗ trống để thêm điểm uốn (đã có ${via.length}), bấm một điểm để kết thúc, Esc để huỷ.`
                      : 'Bấm điểm đầu, bấm chỗ trống để thêm điểm uốn nếu làn cong hay chéo, rồi bấm điểm cuối.')
                    : tool === 'select' ? 'Kéo điểm để dời; bấm một làn để thêm (dấu +), kéo hoặc xoá (bấm đúp) điểm uốn của nó.' : 'Bấm vào chỗ trống trên bản đồ để đặt điểm mới.'}
                </p>
              )}
              <div className="h-[520px] rounded-lg border border-line bg-bg">
                <AgvMapCanvas
                  map={map} fleets={fleets} names={names} ringOf={(k) => rings[k]} blocked={blockedIds} selected={selected} editing={editing} linkFrom={linkFrom}
                  draft={linkFrom ? { from: linkFrom, via } : null} ghosts={ghosts}
                  onSelect={setSelected} onPointClick={onPointClick} onMovePoint={(id, x, y) => apply((m) => movePoint(m, id, x, y))} onBackgroundClick={onBackground}
                  onMoveWaypoint={(lane, i, x, y) => apply((m) => moveWaypoint(m, lane, i, x, y))}
                  onInsertWaypoint={(lane, i, at) => apply((m) => insertWaypoint(m, lane, i, at))}
                  onRemoveWaypoint={(lane, i) => apply((m) => removeWaypoint(m, lane, i))}
                />
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted">
                Xe: <b className="text-ok">xanh</b> đang chạy, <b className="text-warn">vàng</b> bốc dỡ hàng, <b className="text-bad-text">đỏ</b> chờ vào làn, xám nghỉ; vòng nét đứt là đang chở hàng.
                Làn: xám thông thoáng, <b className="text-warn">vàng</b> đầy chỗ, <b className="text-bad-text">đỏ</b> có xe chờ. Viền trạm theo trạng thái node trong sơ đồ.
              </p>
            </Card>

            <div className="space-y-4">
              {editing && (
                <Card title="Thông số chung">
                  <div className="text-xs">
                    <label className="space-y-1"><span className="block text-text-2">Tốc độ xe (m/s)</span>
                      <input className={`${input} w-full`} inputMode="decimal" value={draft!.speed_mps} onChange={(e) => apply((m) => ({ ...m, speed_mps: Number(e.target.value) || 0 }))} /></label>
                  </div>
                </Card>
              )}

              <Card title="Đội xe">
                {Object.keys(snapshot?.fleet ?? {}).length === 0 ? (
                  <p className="text-xs text-muted">Chưa nhận được vị trí xe. Ghép tín hiệu "Vị trí từng xe" cho đội xe ở tab Kết nối dữ liệu, rồi bật feed.</p>
                ) : (
                  <div className="space-y-3">
                    {Object.entries(snapshot!.fleet).map(([pool, vs]) => (
                      <div key={pool}>
                        <div className="mb-1 text-xs font-semibold text-text">{names[pool] ?? pool}</div>
                        <ul className="space-y-1">
                          {vs.map((v) => (
                            <li key={v.id} className="flex items-center gap-2 text-[11.5px] text-text-2">
                              <i className={`h-2 w-2 flex-none rounded-full ${v.state === 'MOVING' ? 'bg-ok' : v.state === 'WAITING' ? 'bg-bad' : v.state === 'LOADING' ? 'bg-warn' : 'bg-faint'}`} />
                              <span className="font-mono">{v.id}</span>
                              <span className="text-muted">{STATE_LABEL[v.state] ?? v.state}{v.load > 0 ? `, chở ${v.load}` : ''}{v.lane ? `, làn ${v.lane}` : ''}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              {!editing && <FrameCard model={model} map={map} names={names} fleets={fleets} draft={frameDraft} onDraft={setFrameDraft} />}
            </div>
          </div>
        )}
        {map && (
          <Card title="Điểm và làn">
            <MapTables map={map} names={names} occ={occ} blocked={blockedIds} selected={selected} onSelect={setSelected} />
          </Card>
        )}
        {!editing && map && <CalibrationCard model={model} />}
        {editing && <Notice>Lưu bản đồ sẽ áp dụng cho lần phát tiếp theo của feed; feed đang chạy giữ bản đồ cũ đến khi bạn bấm Đặt lại rồi Bắt đầu.</Notice>}
      </PageBody>
    </PeekHost>
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
