import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom'
import { useLiveRuns } from './api/live'
import { Shell } from './components/shell/Shell'
import { EmptyState, PageBody } from './components/ui'
import { shouldRetry } from './lib/retry'
import AgvMapPage from './pages/AgvMapPage'
import ComparePage from './pages/ComparePage'
import AlertsPage from './pages/AlertsPage'
import SourcesPage from './pages/SourcesPage'
import ConnectPage from './pages/ConnectPage'
import ControlRoomPage from './pages/ControlRoomPage'
import EditorPage from './pages/EditorPage'
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
import RunRecommendationsPage from './pages/RunRecommendationsPage'
import RunSensorsPage from './pages/RunSensorsPage'
import RunsPage from './pages/RunsPage'
import ScenarioDetailPage from './pages/ScenarioDetailPage'
import ScenarioEditPage from './pages/ScenarioEditPage'
import ScenarioNewPage from './pages/ScenarioNewPage'
import ScenariosPage from './pages/ScenariosPage'
import VersionsPage from './pages/VersionsPage'
import WarehouseControlPage from './pages/WarehouseControlPage'

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
            <Route path="/models" element={<ModelsPage />} />
            <Route path="/models/:key/versions" element={<VersionsPage />} />
            <Route path="/models/:key/sources" element={<SourcesPage />} />
            <Route path="/models/:key/connect" element={<ConnectPage />} />
            <Route path="/models/:key/live" element={<LivePage />} />
            <Route path="/models/:key/map" element={<AgvMapPage />} />
            <Route path="/versions/:id" element={<EditorPage />} />
            <Route path="/versions/:id/scenarios" element={<ScenariosPage />} />
            <Route path="/versions/:id/scenarios/new" element={<ScenarioNewPage />} />
            <Route path="/scenarios/:id" element={<ScenarioDetailPage />} />
            <Route path="/scenarios/:id/edit" element={<ScenarioEditPage />} />
            <Route path="/runs" element={<RunsPage scope="all" />} />
            <Route path="/versions/:id/runs" element={<RunsPage scope="version" />} />
            <Route path="/runs/:id" element={<ControlRoomPage />} />
            <Route path="/runs/:id/sensors" element={<RunSensorsPage />} />
            <Route path="/runs/:id/recommendations" element={<RunRecommendationsPage />} />
            <Route path="/runs/:id/report" element={<ReportPage />} />
            <Route path="/reports/benchmarks" element={<ReportPage mode="benchmarks" />} />
            <Route path="/reports/operations" element={<OperationsDashboardPage />} />
            <Route path="/reports/warehouse" element={<WarehouseControlPage />} />
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
