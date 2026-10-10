// config-api của gauge-twin: danh mục camera, config của từng máy và các bước commissioning.
// Khác query-api (chỉ đọc), dịch vụ này ghi config và đẩy xuống edge.
import type { GaugeDoc, StationConfigDoc, StationDoc } from '../lib/gaugeCommission'

export const GAUGE_CONFIG_API_BASE: string = import.meta.env.VITE_GAUGE_CONFIG_API_URL ?? 'http://localhost:8090'

export type CameraDoc = {
  camera_id: string
  name: string
  location: string
  url: string
  sample_fps: number
  /** Các máy có đồng hồ trên camera này. */
  machines: { machine_id: string; gauges: number }[]
}
export type CameraInput = Pick<CameraDoc, 'name' | 'location' | 'url' | 'sample_fps'>
export type FrameDoc = { frame_jpeg: string; width: number; height: number }
export type PreviewGauge = { gauge_id: string; error?: string; value?: number; unit?: string; quality: number; flags?: string[] }
export type AcceptanceSample = { passed: boolean; truth: number; value?: number; reason?: string; quality_ok: boolean }
export type AcceptanceVerdict = { gauge_id: string; verdict: string; passed: number; failed: number; needed: number }

/** Một vật thể AI phát hiện trên khung hình camera ở chỗ chưa khai báo đồng hồ nào. Chỉ thành đồng hồ khi người dùng kiểm tra và lưu. */
export type GaugeCandidate = {
  candidate_id: number
  camera_id: string
  /** x, y, rộng, cao theo pixel khung hình camera. */
  roi: number[]
  type: string
  score: number
  /** Gợi ý của AI: với đồng hồ kim là tâm và hai đầu thang đo (toạ độ trong hình vuông 256 của vùng), với màn số là số chữ số và màu. */
  hint: { center?: [number, number]; min_pt?: [number, number]; max_pt?: [number, number]; confidence?: number; digits?: number; color?: string }
  /** Ảnh cắt vùng đó ở lần thấy gần nhất, base64. */
  crop_jpeg: string | null
  seen: number
  first_seen: string
  last_seen: string
  status: 'pending' | 'accepted' | 'ignored'
  machine_id: string | null
  gauge_id: string | null
}
/** Đồng hồ đã khai báo có còn được AI nhìn thấy trên camera không. */
export type GaugeSight = {
  machine_id: string
  gauge_id: string
  camera_id: string
  /** seen: vẫn thấy; lost: từng thấy nay không còn; never: AI chưa từng nhận ra; unscanned: camera chưa được quét. */
  state: 'seen' | 'lost' | 'never' | 'unscanned'
  last_seen: string | null
  scanned_at: string | null
}
export type CameraScan = { camera_id: string; scanned_at: string; width: number; height: number; detections: number }

export type EdgeDoc = { edge_id: string; status: string; last_seen: string | null; machines: string[] }
export type AccuracyRow = {
  key: string; type: string; samples: number; passed: number; pass_rate: number
  /** Cận dưới khoảng tin cậy 95% của tỉ lệ đạt: điều số mẫu chứng minh được. */
  lower_bound: number; low_quality: number; mean_error_pct?: number
}
export type AccuracyReport = { samples: number; by_type: AccuracyRow[]; by_gauge: AccuracyRow[] }

/** Lỗi của config-api: câu chính và danh sách chi tiết (từng trường sai). */
export class ConfigApiError extends Error {
  details: string[]
  constructor(message: string, details: string[] = []) {
    super(message)
    this.details = details
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(GAUGE_CONFIG_API_BASE + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let parsed: unknown
  try { parsed = text ? JSON.parse(text) : undefined } catch { parsed = undefined }
  if (!res.ok) {
    const e = parsed as { error?: string; details?: string[] } | undefined
    throw new ConfigApiError(e?.error ?? res.statusText, e?.details ?? [])
  }
  return parsed as T
}

const id = encodeURIComponent

/** Config gửi cho bước đọc thử và nghiệm thu: một đồng hồ, trên đúng khung hình gửi kèm, nên không cần tên camera. */
function singleGaugeConfig(machineId: string, gauge: GaugeDoc): StationConfigDoc {
  const { camera_id: _camera, ...rest } = gauge
  return { machine_id: machineId, plant: 'PREVIEW', line: 'PREVIEW', window_sec: 1, gauges: [rest as GaugeDoc] }
}

export const gaugeConfigApi = {
  cameras: () => call<{ cameras: CameraDoc[] }>('GET', '/v1/cameras').then((r) => r.cameras),
  putCamera: (cameraId: string, camera: CameraInput) => call<CameraDoc>('PUT', `/v1/cameras/${id(cameraId)}`, camera),
  deleteCamera: (cameraId: string) => call<void>('DELETE', `/v1/cameras/${id(cameraId)}`),
  stations: () => call<{ stations: StationDoc[] }>('GET', '/v1/stations').then((r) => r.stations),
  putStation: (config: StationConfigDoc) => call<StationDoc>('PUT', `/v1/stations/${id(config.machine_id)}`, config),
  /** Một khung hình, server tự lấy từ camera. Ảnh không được lưu lại. */
  frame: (source: { camera_id: string } | { url: string }) => call<FrameDoc>('POST', '/v1/commissioning/frame', source),
  /** Đọc thử một đồng hồ trên khung hình đang xem, bằng đúng bộ giải mã của edge. */
  preview: (machineId: string, gauge: GaugeDoc, frameJpeg: string) =>
    call<{ gauges: PreviewGauge[] }>('POST', '/v1/commissioning/preview', { config: singleGaugeConfig(machineId, gauge), frame_jpeg: frameJpeg })
      .then((r) => r.gauges[0]),
  /** Edge và các máy nó đọc; máy có config mà chưa edge nào đọc. */
  edges: () => call<{ edges: EdgeDoc[]; unassigned: string[] }>('GET', '/v1/edges'),
  /** Giao danh sách máy cho một edge; máy đang ở edge khác được chuyển sang. Edge nhận qua MQTT, không cần khởi động lại. */
  putEdge: (edgeId: string, machineIds: string[]) => call<EdgeDoc>('PUT', `/v1/edges/${id(edgeId)}`, { machine_ids: machineIds }),
  /** Độ chính xác đo tại hiện trường, từ các mẫu nghiệm thu đã ghi. */
  accuracy: () => call<AccuracyReport>('GET', '/v1/commissioning/accuracy'),
  /** Đồng hồ AI phát hiện, theo trạng thái; chờ duyệt chỉ gồm những cái đã thấy đủ số lần quét. */
  candidates: (status: GaugeCandidate['status'] = 'pending', cameraId?: string) =>
    call<{ candidates: GaugeCandidate[]; min_seen: number }>('GET', `/v1/discovery/candidates?status=${status}${cameraId ? `&camera_id=${id(cameraId)}` : ''}`),
  /** Không phải đồng hồ cần đo: AI sẽ không đề xuất lại chỗ này. */
  ignoreCandidate: (candidateId: number) => call<GaugeCandidate>('POST', `/v1/discovery/candidates/${candidateId}/ignore`),
  restoreCandidate: (candidateId: number) => call<GaugeCandidate>('POST', `/v1/discovery/candidates/${candidateId}/restore`),
  /** Đồng hồ đã khai báo nào AI còn thấy, và lần quét gần nhất của từng camera. */
  sightings: () => call<{ gauges: GaugeSight[]; scans: CameraScan[]; lost_after_s: number }>('GET', '/v1/discovery/gauges'),
  /** Ghi một mẫu nghiệm thu: giá trị người dùng đang thấy so với giá trị hệ thống đọc trên khung hình vừa lấy. Mẫu được lưu kèm ảnh. */
  accept: (machineId: string, gauge: GaugeDoc, truth: number, frameJpeg: string) =>
    call<{ sample: AcceptanceSample; gauges: AcceptanceVerdict[] }>('POST', '/v1/commissioning/acceptance', {
      config: singleGaugeConfig(machineId, gauge), gauge_id: gauge.gauge_id, truth, frame_jpeg: frameJpeg,
    }),
}
