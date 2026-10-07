import type { AgvMap, MapPoint } from '../api/types'
import { laneLengthM, laneTone, type Occupancy } from './mapGeom'
import { norm } from './suggestMapping'

const KIND: Record<MapPoint['kind'], string> = { junction: 'Ngã tư', station: 'Trạm', charger: 'Chỗ sạc' }
const TONE: Record<'ok' | 'busy' | 'jam', string> = { ok: 'Thông thoáng', busy: 'Đầy chỗ', jam: 'Có xe chờ' }

/** Tên dễ đọc của một điểm: trạm gắn node thì tên node; còn lại là mã điểm. */
export function pointLabel(p: MapPoint, names: Record<string, string>): string {
  if (p.kind === 'station') return p.node_key ? names[p.node_key] ?? p.node_key : `${p.id} (trạm chưa gắn node)`
  return p.id
}

export type PointRow = { id: string; kind: string; node: string; x: number; y: number; lanes: number }
export type LaneRow = { id: string; from: string; to: string; lengthM: number; capacity: number; status: string }

export function pointRows(m: AgvMap, names: Record<string, string>): PointRow[] {
  return m.points.map((p) => ({
    id: p.id, kind: KIND[p.kind] ?? p.kind,
    node: p.kind === 'station' ? (p.node_key ? names[p.node_key] ?? p.node_key : 'chưa gắn') : '',
    x: p.x, y: p.y, lanes: m.lanes.filter((l) => l.from === p.id || l.to === p.id).length,
  }))
}

export function laneRows(m: AgvMap, names: Record<string, string>, occ: Map<string, Occupancy>, blocked: Set<string>): LaneRow[] {
  const at = (id: string) => { const p = m.points.find((x) => x.id === id); return p ? pointLabel(p, names) : id }
  return m.lanes.map((l) => {
    const o = occ.get(l.id)
    return {
      id: l.id, from: at(l.from), to: at(l.to), lengthM: laneLengthM(m, l), capacity: l.capacity,
      status: blocked.has(l.id) ? 'Đang bị chặn' : TONE[o ? laneTone(o) : 'ok'],
    }
  })
}

const has = (q: string, ...texts: string[]) => texts.some((t) => norm(t).includes(q))

export const filterPointRows = (rows: PointRow[], q: string): PointRow[] => { const n = norm(q); return n === '' ? rows : rows.filter((r) => has(n, r.id, r.kind, r.node)) }
export const filterLaneRows = (rows: LaneRow[], q: string): LaneRow[] => { const n = norm(q); return n === '' ? rows : rows.filter((r) => has(n, r.id, r.from, r.to, r.status)) }
