import type { GaugeState, GaugeStation } from '../api/gauge'

/** Trạng thái trạm như màn hình hiển thị. query-api chỉ biết "offline"; ở đây tách thành hai trường hợp khác hẳn nhau:
    trạm từng gửi dữ liệu rồi im (lost) và trạm chưa edge nào báo về (idle). */
export type StationKind = 'alarm' | 'poor' | 'stale' | 'lost' | 'ok' | 'idle'

/** Thứ tự xếp: việc cần người xem đứng trước. */
export const KIND_ORDER: StationKind[] = ['alarm', 'poor', 'stale', 'lost', 'ok', 'idle']

export function stationKind(s: GaugeStation): StationKind {
  if (s.state !== 'offline') return s.state
  return s.edge ? 'lost' : 'idle'
}

export function needsAttention(kind: StationKind): boolean {
  return kind !== 'ok' && kind !== 'idle'
}

export function sortStations(stations: GaugeStation[]): GaugeStation[] {
  const rank = (s: GaugeStation) => KIND_ORDER.indexOf(stationKind(s))
  return [...stations].sort((a, b) => rank(a) - rank(b) || a.machine_id.localeCompare(b.machine_id))
}

export function countKinds(stations: GaugeStation[]): Record<StationKind, number> {
  const out: Record<StationKind, number> = { alarm: 0, poor: 0, stale: 0, lost: 0, ok: 0, idle: 0 }
  for (const s of stations) out[stationKind(s)]++
  return out
}

export function lineKey(s: GaugeStation): string {
  return `${s.plant} / ${s.line}`
}

export function linesOf(stations: GaugeStation[]): string[] {
  return [...new Set(stations.map(lineKey))].sort()
}

/** Dây chuyền mở sẵn: nơi có nhiều trạm đang gửi dữ liệu nhất; hoà thì nơi có nhiều trạm từng gửi hơn;
    không trạm nào gửi thì lấy dây chuyền đầu tiên. */
export function defaultLine(stations: GaugeStation[]): string {
  const lines = linesOf(stations)
  const score = (line: string) => {
    const kinds = stations.filter((s) => lineKey(s) === line).map(stationKind)
    return [kinds.filter((k) => k !== 'idle' && k !== 'lost').length, kinds.filter((k) => k !== 'idle').length]
  }
  let best = lines[0] ?? ''
  let bestScore = [0, 0]
  for (const line of lines) {
    const sc = score(line)
    if (sc[0] > bestScore[0] || (sc[0] === bestScore[0] && sc[1] > bestScore[1])) { best = line; bestScore = sc }
  }
  return best
}

/** line rỗng là mọi dây chuyền. */
export function filterStations(stations: GaugeStation[], line: string, kind: StationKind | 'all'): GaugeStation[] {
  return stations.filter((s) => (line === '' || lineKey(s) === line) && (kind === 'all' || stationKind(s) === kind))
}

/** Đồng hồ kim luôn một chữ số thập phân; màn hình số hiện đúng số đọc được. Dấu phẩy thập phân. */
export function fmtValue(value: number | null, type: string): string {
  if (value === null) return '—'
  // Màn hình số: giữ đủ chữ số như trên màn hình (tối đa 3 chữ số thập phân), không làm tròn bớt.
  const text = type === 'analog_dial' ? value.toFixed(1) : String(Number(value.toFixed(3)))
  return text.replace('.', ',')
}

const UNITS: Record<string, string> = { degC: '°C', degF: '°F', rpm: 'vòng/phút', pcs: 'sản phẩm' }
export function unitLabel(unit: string): string {
  return UNITS[unit] ?? unit
}

const KIND_LABEL: Record<StationKind, string> = {
  alarm: 'Vượt ngưỡng', poor: 'Ảnh kém', stale: 'Chậm dữ liệu', lost: 'Mất tín hiệu', ok: 'Bình thường', idle: 'Chưa có dữ liệu',
}
export function kindLabel(kind: StationKind): string {
  return KIND_LABEL[kind]
}

const FLAG_REASON: [string, string][] = [
  ['FLAG_OUT_OF_RANGE', 'Vượt ngưỡng'], ['FLAG_RATE_LIMIT', 'Đổi quá nhanh'], ['FLAG_NON_MONOTONIC', 'Số đếm bị lùi'],
  ['FLAG_BLUR', 'Ảnh mờ'], ['FLAG_GLARE', 'Bị lóa'], ['FLAG_OCCLUDED', 'Bị che'],
  ['FLAG_FORMAT_INVALID', 'Không đọc được'], ['FLAG_ROI_DRIFT', 'Lệch vùng đọc'],
]

/** Lý do của trạng thái, lấy từ flag đầu tiên giải thích được nó. */
export function gaugeStateLabel(state: GaugeState, flags: string[]): string {
  if (state === 'ok') return 'Bình thường'
  if (state === 'stale') return 'Mất tín hiệu'
  const reason = FLAG_REASON.find(([flag]) => flags.includes(flag))
  return reason ? reason[1] : state === 'alarm' ? 'Vượt ngưỡng' : 'Độ tin cậy thấp'
}

export type Box = { left: number; top: number; width: number; height: number }

/** ROI theo pixel thành phần trăm của khung hình, cắt phần lọt ra ngoài khung. */
export function roiBox(roi: number[], frameW: number, frameH: number): Box | null {
  if (roi.length !== 4 || frameW <= 0 || frameH <= 0) return null
  const [x, y, w, h] = roi
  const x0 = Math.max(0, x), y0 = Math.max(0, y)
  const x1 = Math.min(frameW, x + w), y1 = Math.min(frameH, y + h)
  if (x1 <= x0 || y1 <= y0) return null
  return { left: (x0 * 100) / frameW, top: (y0 * 100) / frameH, width: ((x1 - x0) * 100) / frameW, height: ((y1 - y0) * 100) / frameH }
}

export type RoiCrop = {
  /** Ô cửa sổ nằm giữa thẻ, giữ đúng tỉ lệ của vùng đọc: phần trăm chiều rộng và chiều cao của thẻ. */
  window: { width: number; height: number }
  /** Cả khung hình đặt trong ô cửa sổ sao cho chỉ vùng đọc lộ ra: phần trăm của ô cửa sổ. */
  image: { width: number; height: number; left: number; top: number }
}

/** Cắt vùng đọc của một đồng hồ ra khỏi khung hình camera để hiện trong thẻ có tỉ lệ `aspect` (rộng / cao), không méo, không cắt mất phần nào. */
export function roiCrop(roi: number[], frameW: number, frameH: number, aspect: number): RoiCrop | null {
  const box = roiBox(roi, frameW, frameH)
  if (!box || aspect <= 0) return null
  const ratio = (box.width * frameW) / (box.height * frameH)
  return {
    window: ratio > aspect ? { width: 100, height: (aspect * 100) / ratio } : { width: (ratio * 100) / aspect, height: 100 },
    image: { width: 10000 / box.width, height: 10000 / box.height, left: (-box.left * 100) / box.width, top: (-box.top * 100) / box.height },
  }
}

/** Thuộc tính points của <polyline> cho đường xu hướng; cần ít nhất hai điểm có giá trị. */
export function sparkPoints(points: { value: number | null }[], width: number, height: number): string {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null)
  if (values.length < 2) return ''
  const lo = Math.min(...values), hi = Math.max(...values)
  const round = (n: number) => Math.round(n * 10) / 10
  return values
    .map((v, i) => `${round((i * width) / (values.length - 1))},${round(hi === lo ? height / 2 : height - ((v - lo) * height) / (hi - lo))}`)
    .join(' ')
}

export function ageLabel(iso: string | null, now: number): string {
  if (!iso) return 'chưa có dữ liệu'
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 5) return 'vừa xong'
  if (s < 60) return `${s} giây trước`
  if (s < 3600) return `${Math.round(s / 60)} phút trước`
  return `${Math.round(s / 3600)} giờ trước`
}

/** Tên hiển thị của một camera của máy; camera mặc định không có mã. */
export function cameraLabel(cameraId: string): string {
  return cameraId === '' ? 'Camera chính' : `Camera ${cameraId}`
}

/** Đồng hồ nằm trên một camera của máy. */
export function gaugesOn<T extends { camera_id: string }>(gauges: T[], cameraId: string): T[] {
  return gauges.filter((g) => g.camera_id === cameraId)
}

/** Số ô ảnh trên thẻ trạm ở màn tổng quan; máy có nhiều đồng hồ hơn thì phần còn lại hiện thành dòng gọn. */
export const MAX_TILES = 4

const STATE_RANK: Record<string, number> = { alarm: 0, poor: 1, stale: 2, ok: 3 }

/** Chia đồng hồ của một trạm thành ô ảnh và dòng gọn. Khi phải cắt, đồng hồ cần xem (vượt ngưỡng, ảnh kém, im lặng) được lên ô ảnh trước;
    thứ tự khai báo giữ nguyên trong mỗi phần. Đủ chỗ thì mọi đồng hồ đều là ô ảnh. */
export function splitTiles<T extends { state: string }>(gauges: T[], max = MAX_TILES): [T[], T[]] {
  if (gauges.length <= max) return [gauges, []]
  const picked = new Set(gauges.map((g, i) => [g, i] as const)
    .sort((a, b) => (STATE_RANK[a[0].state] ?? 3) - (STATE_RANK[b[0].state] ?? 3) || a[1] - b[1])
    .slice(0, max).map(([g]) => g))
  return [gauges.filter((g) => picked.has(g)), gauges.filter((g) => !picked.has(g))]
}
