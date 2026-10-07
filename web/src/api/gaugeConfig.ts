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
  /** Ghi một mẫu nghiệm thu: giá trị người dùng đang thấy so với giá trị hệ thống đọc trên khung hình vừa lấy. Mẫu được lưu kèm ảnh. */
  accept: (machineId: string, gauge: GaugeDoc, truth: number, frameJpeg: string) =>
    call<{ sample: AcceptanceSample; gauges: AcceptanceVerdict[] }>('POST', '/v1/commissioning/acceptance', {
      config: singleGaugeConfig(machineId, gauge), gauge_id: gauge.gauge_id, truth, frame_jpeg: frameJpeg,
    }),
}
