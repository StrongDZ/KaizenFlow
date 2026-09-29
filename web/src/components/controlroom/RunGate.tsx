import { useMemo, type ReactNode } from 'react'
import type { BandRow, Graph, NodeType, RunDetail, Scenario } from '../../api/types'
import { useRunBundle } from '../../hooks/useRunBundle'
import { byCode } from '../../lib/model'
import { EmptyState, ErrorBox, Loading, StatusChip } from '../ui'
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
          <EmptyState title="Đang mô phỏng">Trang tự cập nhật khi lần chạy xong.</EmptyState>
        )}
      </>
    )
  }
  if (needBands && !bands.data) return <Loading />
  return <>{children({ run: run.data, scenario: scenario.data, graph: graph.data, types: typeMap, rows: bands.data ?? [] })}</>
}
