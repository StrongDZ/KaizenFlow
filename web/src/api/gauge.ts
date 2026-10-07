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
export type GaugeFrame = { frame_jpeg: string; width: number; height: number }

async function get<T>(path: string): Promise<T> {
  const res = await fetch(GAUGE_API_BASE + path)
  const text = await res.text()
  let body: unknown
  try { body = text ? JSON.parse(text) : undefined } catch { body = undefined }
  if (!res.ok) throw new Error((body as { error?: string } | undefined)?.error ?? res.statusText)
  return body as T
}

const station = (machine: string) => `/v1/stations/${encodeURIComponent(machine)}`

export const gaugeApi = {
  stations: () => get<GaugeStation[]>('/v1/live/stations'),
  station: (machine: string) => get<GaugeStation>(`/v1/live/stations/${encodeURIComponent(machine)}`),
  series: (machine: string, gauge: string, minutes = 15) =>
    get<GaugeSeries>(`${station(machine)}/series?gauge=${encodeURIComponent(gauge)}&minutes=${minutes}`),
  /** Một khung hình lấy theo yêu cầu; edge không gửi ảnh về server. */
  frame: (machine: string, camera = '') => get<GaugeFrame>(`${station(machine)}/frame${camera ? `?camera=${encodeURIComponent(camera)}` : ''}`),
}
