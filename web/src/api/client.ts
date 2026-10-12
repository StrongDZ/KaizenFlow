import type {
  AgvMap, Asset, AssetInput, Binding, Frame, BindingInput, Benchmark7DayResp, BenchmarkReport, CoverageReport, DataSourceRow, SourceTestResult, CalibrationApplied, CalibrationResp, FeedStatus, Incident, IncidentInput, LiveSnapshot, Subjects,
  BandRow, CheckReport, EdgePlan, EventRow, Graph, GraphEdge, GraphNode, InsightRow, Issue, Json, Material, MaterialDetail, MaterialUpdate, ModelSummary,
  NewMaterial, NewNodeType, NewScenario, NodeType, NodeTypeDetail, NodeTypeUpdate, PerformanceKpis, Run, RunDetail, RunRow, Scenario, ScenarioBody, ScenarioRow,
  SignalRow, SourceRow, VersionInfo, WarehouseSeriesEntry, WarehousePipelineView, WarehouseDashboardView,
} from './types'
import { buildMockWarehouseDashboard, buildMockPipelineForWarehouse } from '../lib/warehouse'

export const API_BASE: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8080'
export const wsUrl = API_BASE.replace(/^http/, 'ws') + '/ws'

export class ApiError extends Error {
  status: number
  issues: Issue[]
  impact?: Record<string, number>
  locked: boolean
  constructor(status: number, issues: Issue[], message: string, extra: { impact?: Record<string, number>; locked?: boolean } = {}) {
    super(message)
    this.status = status
    this.issues = issues
    this.impact = extra.impact
    this.locked = extra.locked === true
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const body = text ? JSON.parse(text) : undefined
  if (!res.ok) {
    throw new ApiError(res.status, body?.issues ?? [], body?.error ?? (typeof body?.detail === 'string' ? body.detail : undefined) ?? res.statusText, {
      impact: body?.impact, locked: body?.locked === true,
    })
  }
  return body as T
}

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v)
  const s = p.toString()
  return s ? `?${s}` : ''
}

const post = <T>(path: string, body?: unknown) => req<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
const put = <T>(path: string, body: unknown) => req<T>(path, { method: 'PUT', body: JSON.stringify(body) })
const del = (path: string, cascade = false) => req<void>(`${path}${cascade ? `${path.includes('?') ? '&' : '?'}cascade=true` : ''}`, { method: 'DELETE' })

export const api = {
  nodeTypes: () => req<NodeType[]>('/api/node-types'),
  /** Danh mục nguồn toàn cục: một nguồn là một thiết bị/topic ngoài đời, không thuộc mô hình nào. */
  allSources: () => req<SourceRow[]>('/api/sources'),
  // Danh mục Thiết bị: ngang hàng với Mô hình. Sơ đồ chỉ đặt thiết bị đã có ở đây.
  assets: () => req<Asset[]>('/api/assets'),
  asset: (key: string) => req<Asset>(`/api/assets/${encodeURIComponent(key)}`),
  putAsset: (a: AssetInput) => put<Asset>(`/api/assets/${encodeURIComponent(a.key)}`, a),
  deleteAsset: (key: string) => del(`/api/assets/${encodeURIComponent(key)}`),
  /** Ghép nối tín hiệu của thiết bị: lưu một lần, mọi mô hình có thiết bị đó dùng chung. */
  assetBindings: () => req<{ bindings: Binding[] }>('/api/assets/bindings').then((r) => r.bindings),
  saveAssetBindings: (bindings: BindingInput[]) => put<{ bindings: Binding[] }>('/api/assets/bindings', { bindings }),
  checkAssetBindings: (bindings: BindingInput[]) => put<{ ok: boolean }>('/api/assets/bindings?check=1', { bindings }),
  deleteAssetBinding: (id: number) => del(`/api/assets/bindings/${id}`),
  materials: () => req<Material[]>('/api/materials'),
  models: () => req<ModelSummary[]>('/api/models'),
  /** copy_from: khoá một mô hình có sẵn; mô hình mới bắt đầu từ bản sao sơ đồ mới nhất của nó. */
  createModel: (model_key: string, opts: { settings?: Json; copy_from?: string } = {}) => post<{ version_id: number }>('/api/models', { model_key, ...opts }),
  versions: (key: string) => req<VersionInfo[]>(`/api/models/${encodeURIComponent(key)}/versions`),
  graph: (id: number) => req<Graph>(`/api/versions/${id}`),
  /** Kiểm tra sơ đồ: không thân thì kiểm bản đã lưu, có thân thì kiểm bản đang sửa; deep còn hỏi sim. */
  checkGraph: (id: number, body?: { nodes: GraphNode[]; edges: GraphEdge[] }, deep = false) =>
    req<CheckReport>(`/api/versions/${id}/check${deep ? '?deep=1' : ''}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  saveGraph: (id: number, body: { nodes: GraphNode[]; edges: GraphEdge[]; settings?: Json }) =>
    req<void>(`/api/versions/${id}/graph`, { method: 'PUT', body: JSON.stringify(body) }),
  publish: (id: number) => post<{ status: string }>(`/api/versions/${id}/publish`),
  clone: (id: number) => post<{ version_id: number }>(`/api/versions/${id}/clone`),
  scenarios: (versionId: number) => req<ScenarioRow[]>(`/api/versions/${versionId}/scenarios`),
  scenario: (id: number) => req<Scenario>(`/api/scenarios/${id}`),
  createScenario: (sc: NewScenario) => post<{ id: number }>('/api/scenarios', sc),
  startRun: (scenarioId: number, simStart?: string) =>
    post<{ run_id: number }>(`/api/scenarios/${scenarioId}/runs`, simStart ? { sim_start: simStart } : {}),
  runs: (scenarioId: number) => req<Run[]>(`/api/scenarios/${scenarioId}/runs`),
  run: (id: number) => req<RunDetail>(`/api/runs/${id}`),
  bands: (id: number, q: { subject?: string; metric?: string } = {}) => req<BandRow[]>(`/api/runs/${id}/bands${qs(q)}`),
  events: (id: number, q: { subject?: string; type?: string } = {}) => req<EventRow[]>(`/api/runs/${id}/events${qs(q)}`),
  signals: (id: number, q: { subject?: string; name?: string } = {}) => req<SignalRow[]>(`/api/runs/${id}/signals${qs(q)}`),
  applyInsight: (id: number, rank: number, adjustment?: { to_slots?: number; to_rate?: number }) =>
    post<{ run_id: number }>(`/api/insights/${id}/apply`, { rank, ...(adjustment ? { adjustment } : {}) }),
  allRuns: (q: { status?: string; model?: string; origin?: string; version?: number; limit?: number; offset?: number } = {}) =>
    req<RunRow[]>(`/api/runs${qs({
      status: q.status, model: q.model, origin: q.origin, version: q.version?.toString(), limit: q.limit?.toString(), offset: q.offset?.toString(),
    })}`),
  insights: (q: { kind?: string; status?: string; limit?: number } = {}) =>
    req<InsightRow[]>(`/api/insights${qs({ kind: q.kind, status: q.status, limit: q.limit?.toString() })}`),
  nodeType: (code: string) => req<NodeTypeDetail>(`/api/node-types/${encodeURIComponent(code)}`),
  material: (code: string) => req<MaterialDetail>(`/api/materials/${encodeURIComponent(code)}`),
  createNodeType: (nt: NewNodeType) => post<{ id: number }>('/api/node-types', nt),
  createMaterial: (m: NewMaterial) => post<{ id: number }>('/api/materials', m),
  deleteModel: (key: string, cascade: boolean) => del(`/api/models/${encodeURIComponent(key)}`, cascade),
  deleteVersion: (id: number, cascade: boolean) => del(`/api/versions/${id}`, cascade),
  deleteScenario: (id: number, cascade: boolean) => del(`/api/scenarios/${id}`, cascade),
  deleteRun: (id: number) => del(`/api/runs/${id}`),
  updateScenario: (id: number, body: ScenarioBody) => put<void>(`/api/scenarios/${id}`, body),
  cloneScenario: (id: number) => post<{ id: number }>(`/api/scenarios/${id}/clone`),
  updateNodeType: (code: string, body: NodeTypeUpdate) => put<void>(`/api/node-types/${encodeURIComponent(code)}`, body),
  deleteNodeType: (code: string) => del(`/api/node-types/${encodeURIComponent(code)}`),
  updateMaterial: (code: string, body: MaterialUpdate) => put<void>(`/api/materials/${encodeURIComponent(code)}`, body),
  deleteMaterial: (code: string) => del(`/api/materials/${encodeURIComponent(code)}`),
  exportUrl: (id: number) => `${API_BASE}/api/runs/${id}/export.csv`,

  // --- live twin ---
  live: (key: string) => req<LiveSnapshot>(`/api/models/${encodeURIComponent(key)}/live`),
  clearLive: (key: string) => del(`/api/models/${encodeURIComponent(key)}/live`),
  liveSubjects: (key: string) => req<Subjects>(`/api/models/${encodeURIComponent(key)}/live/subjects`),
  liveSignals: (key: string, q: { subject?: string; name?: string; since?: string; limit?: number } = {}) =>
    req<SignalRow[]>(`/api/models/${encodeURIComponent(key)}/live/signals${qs({ subject: q.subject, name: q.name, since: q.since, limit: q.limit?.toString() })}`),
  liveForecast: (key: string, horizon_s: number) =>
    post<{ scenario_id: number; run_id: number; notes: string[]; at: string }>(`/api/models/${encodeURIComponent(key)}/live/forecast`, { horizon_s }),
  calibration: (key: string) => req<CalibrationResp>(`/api/models/${encodeURIComponent(key)}/live/calibration`),
  applyCalibration: (key: string, edges: string[]) =>
    post<CalibrationApplied>(`/api/models/${encodeURIComponent(key)}/live/calibration/apply`, { edges }),
  ackInsight: (id: number) => post<void>(`/api/insights/${id}/ack`),
  bindings: (key: string) => req<Binding[]>(`/api/models/${encodeURIComponent(key)}/bindings`),
  saveBindings: (key: string, bindings: BindingInput[]) =>
    put<{ bindings: Binding[] }>(`/api/models/${encodeURIComponent(key)}/bindings`, { bindings }),
  /** Kiểm tra các ghép nối với mọi luật như khi lưu nhưng không lưu (hộp Ghép nối dùng để báo hợp lệ trước khi bấm Lưu). */
  checkBindings: (key: string, bindings: BindingInput[]) =>
    put<{ ok: boolean }>(`/api/models/${encodeURIComponent(key)}/bindings?check=1`, { bindings }),
  deleteBinding: (key: string, id: number) => del(`/api/models/${encodeURIComponent(key)}/bindings/${id}`),
  deleteAllBindings: (key: string) => del(`/api/models/${encodeURIComponent(key)}/bindings`),
  liveCheck: (key: string) => req<CoverageReport>(`/api/models/${encodeURIComponent(key)}/live/check`),
  edgePlan: (key: string) => req<EdgePlan>(`/api/models/${encodeURIComponent(key)}/live/edge-plan`),
  sources: (key: string) => req<{ sources: DataSourceRow[] }>(`/api/models/${encodeURIComponent(key)}/sources`).then((r) => r.sources),
  addSource: (key: string, body: { source: string; desc?: string; sample?: unknown }) =>
    post<{ source: string }>(`/api/models/${encodeURIComponent(key)}/sources`, body),
  deleteSource: (key: string, source: string, cascade = false) =>
    del(`/api/models/${encodeURIComponent(key)}/sources?source=${encodeURIComponent(source)}`, cascade),
  testSource: (key: string, body: { source: string; payload: unknown }) =>
    post<SourceTestResult>(`/api/models/${encodeURIComponent(key)}/sources/test`, body),
  agvMap: (key: string) => req<AgvMap>(`/api/models/${encodeURIComponent(key)}/agv-map`),
  saveAgvMap: (key: string, map: AgvMap) => put<void>(`/api/models/${encodeURIComponent(key)}/agv-map`, map),
  /** Địa chỉ ảnh mặt bằng làm nền; `rev` (từ bản đồ) chỉ để trình duyệt không dùng ảnh cũ. */
  agvMapImageUrl: (key: string, rev?: number) => `${API_BASE}/api/models/${encodeURIComponent(key)}/agv-map/image${rev ? `?rev=${rev}` : ''}`,
  uploadAgvMapImage: (key: string, img: Blob) =>
    req<{ width: number; height: number; rev: number }>(`/api/models/${encodeURIComponent(key)}/agv-map/image`, { method: 'PUT', headers: { 'Content-Type': img.type }, body: img }),
  deleteAgvMapImage: (key: string) => del(`/api/models/${encodeURIComponent(key)}/agv-map/image`),
  /** Mỗi mô hình có một feed riêng chạy song song với mô hình khác: mọi lệnh đều nêu rõ mô hình. */
  feed: {
    status: (model: string) => req<FeedStatus>(`/api/feed/status?model=${encodeURIComponent(model)}`),
    /** Các mô hình đang chạy hoặc tạm dừng. */
    list: () => req<FeedStatus[]>('/api/feed/feeds'),
    start: (model: string, speed: number, frame?: Frame & { noise_m?: number }) => post<FeedStatus>('/api/feed/start', { model, speed, ...(frame ? { frame } : {}) }),
    pause: (model: string) => post<FeedStatus>('/api/feed/pause', { model }),
    resume: (model: string) => post<FeedStatus>('/api/feed/resume', { model }),
    speed: (model: string, speed: number) => post<FeedStatus>('/api/feed/speed', { model, speed }),
    stop: (model: string) => post<FeedStatus>('/api/feed/stop', { model }),
    reset: (model: string) => post<FeedStatus>('/api/feed/reset', { model }),
    addIncident: (body: IncidentInput) => post<Incident>('/api/feed/incidents', body),
    clearIncident: (model: string, id: number) => del(`/api/feed/incidents/${id}?model=${encodeURIComponent(model)}`),
  },

  benchmark7day: (key: string, body: { step_s: number; warmup_s: number; replications: number; seed: number; benchmark_ready: boolean }) =>
    post<Benchmark7DayResp>(`/api/models/${encodeURIComponent(key)}/benchmark/7day`, body),
  benchmarkForecast: (key: string, body: { run_id: number } | { warehouse_series_log: WarehouseSeriesEntry[] }) =>
    post<BenchmarkReport>(`/api/models/${encodeURIComponent(key)}/benchmark/forecast`, body),

  // Dashboard tổng thể hiệu năng (OverviewPage)
  // Backend sau này implement endpoint này, trả về shape đúng PerformanceKpis là UI tự động hoạt động.
  performanceKpis: (q: { window?: '7d' | '14d' | '30d'; top_n?: number } = {}) =>
    req<PerformanceKpis>(`/api/performance/kpis${qs({ window: q.window, top_n: q.top_n?.toString() })}`),

  // --- Kho tổng thể (Warehouse Dashboard) ---
  // Ưu tiên gọi API endpoint thật (services/api/internal/httpapi/warehouse.go: handlers.warehousePipeline / warehouseDashboard).
  // Nếu API chưa deploy (404 / network error) → fallback local mock trong lib/warehouse.
  // Swap transaparent: backend up → dùng data thật; backend down → demo vẫn chạy không vỡ UI.
  warehousePipeline: async (modelKey: string, nodeKey: string, horizon_h = 8): Promise<WarehousePipelineView> => {
    try {
      return await req<WarehousePipelineView>(
        `/api/models/${encodeURIComponent(modelKey)}/warehouse-pipeline/${encodeURIComponent(nodeKey)}` +
        qs({ horizon_h: horizon_h.toString() }),
      )
    } catch {
      return buildMockPipelineForWarehouse(modelKey, nodeKey, [], horizon_h) as WarehousePipelineView
    }
  },
  warehouseDashboard: async (modelKey: string, nodeKey: string, nodeName: string, window_days = 14): Promise<WarehouseDashboardView> => {
    try {
      return await req<WarehouseDashboardView>(
        `/api/models/${encodeURIComponent(modelKey)}/warehouse-dashboard/${encodeURIComponent(nodeKey)}` +
        qs({ node_name: nodeName, window_days: window_days.toString() }),
      )
    } catch {
      return buildMockWarehouseDashboard(modelKey, nodeKey, nodeName, window_days) as WarehouseDashboardView
    }
  },
}
