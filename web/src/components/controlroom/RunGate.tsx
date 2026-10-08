import { useMemo, type ReactNode } from 'react'
import { Boxes, LoaderCircle } from 'lucide-react'
import type { BandRow, Graph, NodeType, RunDetail, Scenario } from '../../api/types'
import { useRunBundle } from '../../hooks/useRunBundle'
import { byCode } from '../../lib/model'
import { ErrorBox, Loading, StatusChip } from '../ui'
import { HeaderActions } from '../shell/ShellContext'

export type RunReady = { run: RunDetail; scenario: Scenario; graph: Graph; types: Record<string, NodeType>; rows: BandRow[] }

export function RunGate({ runId, needBands = false, children }: { runId: number; needBands?: boolean; children: (b: RunReady) => ReactNode }) {
  const { run, scenario, graph, types, bands } = useRunBundle(runId, needBands)
  // giữ nguyên tham chiếu để các useMemo phía dưới không tính lại khi RunGate render lại
  const typeMap = useMemo(() => byCode(types.data ?? []), [types.data])
  if (run.error) return <div className="p-6"><ErrorBox error={run.error} /></div>
  if (!run.data || !scenario.data || !graph.data || !types.data) return <Loading />
  if (run.data.status !== 'DONE') {
    return (
      <>
        <HeaderActions><StatusChip status={run.data.status} /></HeaderActions>
        {run.data.status === 'FAILED' ? (
          <div className="p-6"><ErrorBox error={new Error(run.data.error ?? 'Lần chạy thất bại')} /></div>
        ) : (
          <div className="flex h-full min-h-[480px] items-center justify-center bg-[radial-gradient(circle_at_center,color-mix(in_srgb,var(--color-accent)_10%,transparent),transparent_58%)] p-6">
            <section className="w-full max-w-md overflow-hidden rounded-2xl border border-line bg-panel shadow-xl">
              <div className="flex items-center gap-3 border-b border-line bg-panel-2 px-5 py-4">
                <span className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-accent/12 text-accent">
                  <Boxes size={20} />
                  <LoaderCircle size={44} className="absolute animate-spin opacity-45" />
                </span>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-accent">Run #{run.data.id}</div>
                  <h1 className="text-sm font-semibold text-text">Đang mô phỏng scenario</h1>
                </div>
              </div>
              <div className="space-y-3 px-5 py-4">
                <div className="h-1.5 overflow-hidden rounded-full bg-panel-2"><i className="block h-full w-1/2 animate-pulse rounded-full bg-accent" /></div>
                <p className="text-xs leading-5 text-text-2">Engine đang chạy các lần lặp Monte Carlo và đánh giá KPI. Control Room sẽ tự xuất hiện khi dữ liệu hoàn tất.</p>
                <div className="flex items-center justify-between text-[10.5px] text-muted"><span>Không cần tải lại trang</span><span>Tự kiểm tra mỗi 3 giây</span></div>
              </div>
            </section>
          </div>
        )}
      </>
    )
  }
  if (needBands && !bands.data) return <Loading />
  return <>{children({ run: run.data, scenario: scenario.data, graph: graph.data, types: typeMap, rows: bands.data ?? [] })}</>
}
