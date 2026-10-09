import { useMemo, type ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { BandRow, Graph, NodeType, RunDetail, Scenario } from '../../api/types'
import { useRunBundle } from '../../hooks/useRunBundle'
import { byCode } from '../../lib/model'
import { ErrorBox, Loading } from '../ui'

export type RunReady = { run: RunDetail; scenario: Scenario; graph: Graph; types: Record<string, NodeType>; rows: BandRow[] }

export function RunGate({ runId, needBands = false, children }: { runId: number; needBands?: boolean; children: (b: RunReady) => ReactNode }) {
  const { run, scenario, graph, types, bands } = useRunBundle(runId, needBands)
  // giữ nguyên tham chiếu để các useMemo phía dưới không tính lại khi RunGate render lại
  const typeMap = useMemo(() => byCode(types.data ?? []), [types.data])
  if (run.error) return <div className="p-6"><ErrorBox error={run.error} /></div>
  if (!run.data || !scenario.data || !graph.data || !types.data) return <Loading />
  if (run.data.status === 'FAILED') return <div className="p-6"><ErrorBox error={new Error(run.data.error ?? 'Lần chạy thất bại')} /></div>
  if (run.data.status !== 'DONE') {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center p-6">
        <section className="w-full max-w-sm">
          <h1 className="flex items-center gap-2 text-sm font-semibold text-text">
            <LoaderCircle size={15} className="animate-spin text-accent" aria-hidden />
            {run.data.status === 'QUEUED' ? 'Đang chờ đến lượt mô phỏng' : 'Đang mô phỏng'}
          </h1>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-raised"><i className="block h-full w-1/3 animate-pulse rounded-full bg-accent" /></div>
          <p className="mt-3 text-xs leading-5 text-text-2">
            Engine đang chạy {scenario.data.replications} lần lặp và tính KPI. Trang tự hiện kết quả khi xong, không cần tải lại.
          </p>
        </section>
      </div>
    )
  }
  if (needBands && !bands.data) return <Loading />
  return <>{children({ run: run.data, scenario: scenario.data, graph: graph.data, types: typeMap, rows: bands.data ?? [] })}</>
}
