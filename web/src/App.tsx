import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { useLiveRuns } from './api/live'
import { Shell } from './components/shell/Shell'
import ComparePage from './pages/ComparePage'
import ControlRoomPage from './pages/ControlRoomPage'
import EditorPage from './pages/EditorPage'
import ModelsPage from './pages/ModelsPage'
import ReportPage from './pages/ReportPage'
import ScenariosPage from './pages/ScenariosPage'
import Stub from './pages/Stub'

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } })

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
            <Route path="/" element={<Navigate to="/models" replace />} />
            <Route path="/models" element={<ModelsPage />} />
            <Route path="/versions/:id" element={<EditorPage />} />
            <Route path="/versions/:id/scenarios" element={<ScenariosPage />} />
            <Route path="/runs" element={<Stub title="Lần chạy" />} />
            <Route path="/runs/:id" element={<ControlRoomPage />} />
            <Route path="/runs/:id/sensors" element={<Stub title="Cảm biến" />} />
            <Route path="/runs/:id/recommendations" element={<Stub title="Đề xuất" />} />
            <Route path="/runs/:id/report" element={<ReportPage />} />
            <Route path="/compare" element={<ComparePage />} />
            <Route path="/library/*" element={<Stub title="Thư viện" />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
