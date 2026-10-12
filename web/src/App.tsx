import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Link, Navigate, Route, Routes, useParams, useSearchParams } from 'react-router-dom'
import { useLiveRuns } from './api/live'
import RunLayout from './components/controlroom/RunLayout'
import StationLayout from './components/gauge/StationLayout'
import { Shell } from './components/shell/Shell'
import { EmptyState, PageBody } from './components/ui'
import { shouldRetry } from './lib/retry'
import AgvMapPage from './pages/AgvMapPage'
import AssetsPage from './pages/AssetsPage'
import AssetSignalsPage from './pages/AssetSignalsPage'
import ComparePage from './pages/ComparePage'
import AlertsPage from './pages/AlertsPage'
import SourcesPage from './pages/SourcesPage'
import ConnectPage from './pages/ConnectPage'
import ControlRoomPage from './pages/ControlRoomPage'
import EditorPage from './pages/EditorPage'
import GaugeCameraPage from './pages/GaugeCameraPage'
import GaugeCamerasPage from './pages/GaugeCamerasPage'
import GaugeOverviewPage from './pages/GaugeOverviewPage'
import GaugeInventoryPage from './pages/GaugeInventoryPage'
import GaugeHistoryPage from './pages/GaugeHistoryPage'
import GaugeStationPage from './pages/GaugeStationPage'
import LibraryLayout from './pages/LibraryLayout'
import LivePage from './pages/LivePage'
import MaterialDetailPage from './pages/MaterialDetailPage'
import MaterialsPage from './pages/MaterialsPage'
import ModelsPage from './pages/ModelsPage'
import NodeTypeDetailPage from './pages/NodeTypeDetailPage'
import NodeTypeEditPage from './pages/NodeTypeEditPage'
import NodeTypeNewPage from './pages/NodeTypeNewPage'
import NodeTypesPage from './pages/NodeTypesPage'
import OperationsDashboardPage from './pages/OperationsDashboardPage'
import OverviewPage from './pages/OverviewPage'
import ReportPage from './pages/ReportPage'
import RunComparePage from './pages/RunComparePage'
import RunRecommendationsPage from './pages/RunRecommendationsPage'
import RunSensorsPage from './pages/RunSensorsPage'
import RunsPage from './pages/RunsPage'
import ScenarioDetailPage from './pages/ScenarioDetailPage'
import ScenarioEditPage from './pages/ScenarioEditPage'
import ScenarioNewPage from './pages/ScenarioNewPage'
import ScenariosPage from './pages/ScenariosPage'
import VersionsPage from './pages/VersionsPage'
import WarehouseControlPage from './pages/WarehouseControlPage'
import WarehouseDashboardPage from './pages/WarehouseDashboardPage'

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: shouldRetry } } })

function NotFound() {
  return (
    <PageBody>
      <EmptyState title="Không có trang này">
        Đường dẫn không đúng hoặc trang đã bị bỏ. <Link to="/" className="text-accent underline">Về Tổng quan</Link>
      </EmptyState>
    </PageBody>
  )
}

/** Địa chỉ báo cáo cũ (/reports/…?model=…) dẫn về trang tương ứng trong mô hình; không nêu mô hình thì về danh sách Mô hình. */
const LEGACY_REPORT: Record<string, string> = { operations: 'operations', warehouse: 'stock', 'warehouse-dashboard': 'warehouse-report' }
function LegacyReport() {
  const page = LEGACY_REPORT[useParams().page ?? '']
  const model = useSearchParams()[0].get('model')
  return <Navigate to={page && model ? `/models/${encodeURIComponent(model)}/${page}` : '/models'} replace />
}

function Live() {
  useLiveRuns()
  return null
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Live />
        <Routes>
          <Route element={<Shell />}>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/gauge-twin" element={<GaugeOverviewPage />} />
            <Route path="/gauge-twin/gauges" element={<GaugeInventoryPage />} />
            <Route path="/gauge-twin/cameras" element={<GaugeCamerasPage />} />
            <Route path="/gauge-twin/cameras/:camera" element={<GaugeCameraPage />} />
            {/* Trang Edge đã bỏ (gán máy cho edge qua config-api): đường dẫn cũ về danh sách trạm, không thành trạm tên "edges". */}
            <Route path="/gauge-twin/edges" element={<Navigate to="/gauge-twin" replace />} />
            <Route path="/gauge-twin/:machine" element={<StationLayout />}>
              <Route index element={<GaugeStationPage />} />
              <Route path="history" element={<GaugeHistoryPage />} />
            </Route>
            <Route path="/assets" element={<AssetsPage />} />
            <Route path="/assets/sources" element={<SourcesPage />} />
            <Route path="/assets/signals" element={<AssetSignalsPage />} />
            <Route path="/models" element={<ModelsPage />} />
            <Route path="/models/:key/versions" element={<VersionsPage />} />
            {/* Nguồn dữ liệu là toàn cục, đã chuyển sang mục Thiết bị: đường dẫn cũ trong mô hình về trang mới. */}
            <Route path="/models/:key/sources" element={<Navigate to="/assets/sources" replace />} />
            <Route path="/models/:key/connect" element={<ConnectPage />} />
            <Route path="/models/:key/live" element={<LivePage />} />
            <Route path="/models/:key/map" element={<AgvMapPage />} />
            <Route path="/models/:key/stock" element={<WarehouseControlPage />} />
            <Route path="/models/:key/operations" element={<OperationsDashboardPage />} />
            <Route path="/models/:key/warehouse-report" element={<WarehouseDashboardPage />} />
            <Route path="/versions/:id" element={<EditorPage />} />
            <Route path="/versions/:id/scenarios" element={<ScenariosPage />} />
            <Route path="/versions/:id/scenarios/new" element={<ScenarioNewPage />} />
            <Route path="/scenarios/:id" element={<ScenarioDetailPage />} />
            <Route path="/scenarios/:id/edit" element={<ScenarioEditPage />} />
            {/* Lần chạy chỉ xem trong một mô hình (mục Lần chạy); địa chỉ danh sách chung cũ về Mô hình. */}
            <Route path="/runs" element={<Navigate to="/models" replace />} />
            <Route path="/versions/:id/runs" element={<RunsPage />} />
            <Route path="/runs/:id" element={<RunLayout />}>
              <Route index element={<ControlRoomPage />} />
              <Route path="sensors" element={<RunSensorsPage />} />
              <Route path="recommendations" element={<RunRecommendationsPage />} />
              <Route path="compare" element={<RunComparePage />} />
              <Route path="report" element={<ReportPage />} />
            </Route>
            <Route path="/reports/:page" element={<LegacyReport />} />
            <Route path="/compare" element={<ComparePage />} />
            <Route path="/library" element={<LibraryLayout />}>
              <Route index element={<Navigate to="node-types" replace />} />
              <Route path="node-types" element={<NodeTypesPage />} />
              <Route path="node-types/new" element={<NodeTypeNewPage />} />
              <Route path="node-types/:code/edit" element={<NodeTypeEditPage />} />
              <Route path="node-types/:code" element={<NodeTypeDetailPage />} />
              <Route path="materials" element={<MaterialsPage />} />
              <Route path="materials/:code" element={<MaterialDetailPage />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
