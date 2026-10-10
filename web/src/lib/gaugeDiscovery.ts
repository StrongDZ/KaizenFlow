// Logic thuần của phần AI phát hiện đồng hồ: dựng bản khai báo nháp từ một đề xuất, gom danh mục đồng hồ theo trạng thái.
import type { GaugeCandidate, GaugeSight } from '../api/gaugeConfig'
import { emptyDraft, type GaugeDoc, type GaugeDraft, type GaugeType, type StationDoc } from './gaugeCommission'

const TYPES: GaugeType[] = ['analog_dial', 'seg7', 'timer_mmss', 'rolling_counter']

export const TYPE_LABEL: Record<string, string> = {
  analog_dial: 'Đồng hồ kim', seg7: 'Màn hình số', timer_mmss: 'Màn hình thời gian', rolling_counter: 'Bộ đếm số lăn',
}

/** Mã tạm cho đồng hồ mới, người dùng đổi thành tên có nghĩa trước khi lưu. */
const ID_PREFIX: Record<string, string> = { analog_dial: 'DONG_HO_KIM', seg7: 'MAN_SO', timer_mmss: 'DONG_HO_GIAY', rolling_counter: 'BO_DEM' }

/** Bản khai báo nháp điền sẵn từ đề xuất của AI: loại, vùng, các điểm của đồng hồ kim, số chữ số và màu của màn số. */
export function draftFromCandidate(c: GaugeCandidate): GaugeDraft {
  const type = TYPES.find((t) => t === c.type) ?? 'analog_dial'
  const draft: GaugeDraft = { ...emptyDraft(type), gauge_id: `${ID_PREFIX[type]}_${c.candidate_id}`, roi: c.roi.length === 4 ? [...c.roi] : null }
  const h = c.hint ?? {}
  if (type === 'analog_dial') {
    draft.center = h.center ?? null
    draft.min_pt = h.min_pt ?? null
    draft.max_pt = h.max_pt ?? null
    // Giá trị hai đầu thang đo AI không đọc: người dùng phải nhập.
    draft.max_val = ''
  }
  if (h.digits !== undefined && (type === 'seg7' || type === 'rolling_counter')) draft.digits = String(h.digits)
  if (type === 'seg7' && (h.color === 'red_led' || h.color === 'green_led' || h.color === 'lcd')) draft.color = h.color
  return draft
}

export type InventoryState = 'pending' | 'reading' | 'lost' | 'ignored'

export const STATE_LABEL: Record<InventoryState, string> = {
  pending: 'Chờ duyệt', reading: 'Đang đọc', lost: 'AI không còn thấy', ignored: 'Đã bỏ qua',
}

export type DeclaredRow = { kind: 'declared'; state: 'reading' | 'lost'; machine_id: string; gauge: GaugeDoc; camera_id: string; sight?: GaugeSight }
export type CandidateRow = { kind: 'candidate'; state: 'pending' | 'ignored'; candidate: GaugeCandidate }
export type InventoryRow = DeclaredRow | CandidateRow

/** Mọi đồng hồ đã khai báo kèm việc AI còn thấy nó không, cùng các đề xuất chờ duyệt và đã bỏ qua. Một đồng hồ chỉ "AI không còn thấy" khi AI từng thấy nó. */
export function inventory(stations: StationDoc[], sights: GaugeSight[], pending: GaugeCandidate[], ignored: GaugeCandidate[]): InventoryRow[] {
  const sightOf = new Map(sights.map((s) => [`${s.machine_id}/${s.gauge_id}`, s]))
  const declared: InventoryRow[] = [...stations]
    .sort((a, b) => a.machine_id.localeCompare(b.machine_id))
    .flatMap((s) => s.config.gauges.map((gauge): DeclaredRow => {
      const sight = sightOf.get(`${s.machine_id}/${gauge.gauge_id}`)
      const camera = gauge.camera_id || ((s.config.camera as { camera_id?: string } | undefined)?.camera_id ?? '')
      return { kind: 'declared', state: sight?.state === 'lost' ? 'lost' : 'reading', machine_id: s.machine_id, gauge, camera_id: camera, sight }
    }))
  return [
    ...pending.map((candidate): CandidateRow => ({ kind: 'candidate', state: 'pending', candidate })),
    ...declared,
    ...ignored.map((candidate): CandidateRow => ({ kind: 'candidate', state: 'ignored', candidate })),
  ]
}

export function countStates(rows: InventoryRow[]): Record<InventoryState, number> {
  const out: Record<InventoryState, number> = { pending: 0, reading: 0, lost: 0, ignored: 0 }
  for (const r of rows) out[r.state]++
  return out
}

export function cameraOfRow(r: InventoryRow): string {
  return r.kind === 'declared' ? r.camera_id : r.candidate.camera_id
}

/** Số đề xuất chờ duyệt của từng camera. */
export function pendingByCamera(pending: GaugeCandidate[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of pending) out.set(c.camera_id, (out.get(c.camera_id) ?? 0) + 1)
  return out
}

export type Corner = 'nw' | 'ne' | 'sw' | 'se'

/** Kéo một góc của vùng đọc tới điểm `p` (pixel khung hình); góc đối diện đứng yên. Vùng quá nhỏ thì giữ nguyên vùng cũ. */
export function moveCorner(roi: number[], corner: Corner, p: { x: number; y: number }, min = 12): number[] {
  const [x, y, w, h] = roi
  const fixed = { x: corner.includes('w') ? x + w : x, y: corner.startsWith('n') ? y + h : y }
  const x0 = Math.min(fixed.x, p.x), x1 = Math.max(fixed.x, p.x)
  const y0 = Math.min(fixed.y, p.y), y1 = Math.max(fixed.y, p.y)
  if (x1 - x0 < min || y1 - y0 < min) return roi
  return [Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)]
}
