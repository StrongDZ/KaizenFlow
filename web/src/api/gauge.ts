// query-api của gauge-twin: dịch vụ chỉ đọc, chạy riêng với API của KaizenFlow.
export const GAUGE_API_BASE: string = import.meta.env.VITE_GAUGE_API_URL ?? 'http://localhost:8092'

export type GaugeState = 'ok' | 'poor' | 'alarm' | 'stale'
export type StationState = GaugeState | 'offline'

export type GaugeReading = {
  gauge_id: string
  type: string
  unit: string
  /** x, y, w, h theo pixel của khung hình camera nhìn thấy đồng hồ này. */
  roi: number[]
  /** Camera nhìn thấy đồng hồ; rỗng là camera mặc định của máy. */
  camera_id: string
  min: number | null
  max: number | null
  state: GaugeState
  ts: string | null
  value: number | null
  v_min: number | null
  v_max: number | null
  n_frames: number | null
  quality: number | null
  flags: string[]
}

export type GaugeStation = {
  machine_id: string
  plant: string
  line: string
  config_version: number
  state: StationState
  edge: { edge_id: string; status: string; last_seen: string | null } | null
  /** Mã các camera mà đồng hồ của máy nằm trên đó (rỗng: camera mặc định). Một camera có thể phục vụ nhiều máy. */
  cameras: string[]
  gauges: GaugeReading[]
}

export type SeriesPoint = { ts: string; value: number | null; quality: number | null }
export type GaugeSeries = { machine_id: string; gauge_id: string; points: SeriesPoint[] }
/** Một ô thời gian của lịch sử: trung bình và hai cực trị của ô; quality là điểm thấp nhất (null khi lấy từ bảng gộp phút). */
export type HistoryPoint = { ts: string; value: number | null; min: number | null; max: number | null; quality: number | null; n: number }
export type GaugeHistory = {
  machine_id: string; gauge_id: string; from: string; to: string
  /** Độ rộng một ô, giây. Ô không có lần đọc nào thì vắng mặt trong points. */
  bucket_s: number
  /** raw: từ từng lần đọc; 1m: từ bảng gộp theo phút (khoảng dài hơn 7 ngày). */
  source: 'raw' | '1m'
  points: HistoryPoint[]
}
export type GaugeFrame = { frame_jpeg: string; width: number; height: number }
/** Khung hình trực tiếp do edge gửi kèm số đọc trên chính khung hình đó; width/height là kích thước khung gốc. */
export type LiveFrame = GaugeFrame & {
  camera_id: string
  ts: string
  readings: { gauge_id: string; value: number | null; confidence: number }[]
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(GAUGE_API_BASE + path)
  const text = await res.text()
  let body: unknown
  try { body = text ? JSON.parse(text) : undefined } catch { body = undefined }
  if (!res.ok) throw new Error((body as { error?: string } | undefined)?.error ?? res.statusText)
  return body as T
}

const station = (machine: string) => `/v1/stations/${encodeURIComponent(machine)}`

const historyPath = (machine: string, gauge: string, from: number, to: number) =>
  `${station(machine)}/history?gauge=${encodeURIComponent(gauge)}&from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`

export const gaugeApi = {
  stations: () => get<GaugeStation[]>('/v1/live/stations'),
  station: (machine: string) => get<GaugeStation>(`/v1/live/stations/${encodeURIComponent(machine)}`),
  series: (machine: string, gauge: string, minutes = 15) =>
    get<GaugeSeries>(`${station(machine)}/series?gauge=${encodeURIComponent(gauge)}&minutes=${minutes}`),
  history: (machine: string, gauge: string, from: number, to: number) => get<GaugeHistory>(historyPath(machine, gauge, from, to)),
  /** Địa chỉ tải lịch sử của một đồng hồ dưới dạng CSV. */
  historyCsvUrl: (machine: string, gauge: string, from: number, to: number) => `${GAUGE_API_BASE}${historyPath(machine, gauge, from, to)}&format=csv`,
  /** Xem trực tiếp: gọi lặp lại để edge tiếp tục gửi ảnh; ảnh chỉ nằm trong bộ nhớ server, không được lưu. Chưa có khung hình thì lỗi. */
  liveFrame: (machine: string, camera = '') => get<LiveFrame>(`${station(machine)}/live-frame${camera ? `?camera=${encodeURIComponent(camera)}` : ''}`),
  /** Một khung hình do server tự kéo từ camera; dùng khi chưa có xem trực tiếp. `maxAgeS` là tuổi lớn nhất chấp nhận được (giây):
      server trả ngay khung hình nó vừa kéo gần đây thay vì mở lại camera, đủ cho ảnh nhỏ minh hoạ. */
  frame: (machine: string, camera = '', maxAgeS = 0) => get<GaugeFrame>(`${station(machine)}/frame?max_age=${maxAgeS}${camera ? `&camera=${encodeURIComponent(camera)}` : ''}`),
}
