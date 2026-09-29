import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import { useLiveRuns } from './api/live'
import ComparePage from './pages/ComparePage'
import ControlRoomPage from './pages/ControlRoomPage'
import EditorPage from './pages/EditorPage'
import ModelsPage from './pages/ModelsPage'
import ReportPage from './pages/ReportPage'
import ScenariosPage from './pages/ScenariosPage'

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } })

function Live() {
  useLiveRuns()
  return null
}

function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <nav className="flex items-center gap-4 border-b border-slate-200 bg-white px-6 py-3 print:hidden">
        <Link to="/" className="font-bold text-blue-700">KaizenFlow</Link>
        <span className="text-xs text-slate-400">Digital twin logistics · DENSO D2</span>
      </nav>
      <main>{children}</main>
    </div>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Live />
        <Layout>
          <Routes>
            <Route path="/" element={<ModelsPage />} />
            <Route path="/versions/:id" element={<EditorPage />} />
            <Route path="/versions/:id/scenarios" element={<ScenariosPage />} />
            <Route path="/runs/:id" element={<ControlRoomPage />} />
            <Route path="/runs/:id/report" element={<ReportPage />} />
            <Route path="/compare" element={<ComparePage />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
