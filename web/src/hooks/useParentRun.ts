import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Run, Scenario } from '../api/types'
import { pickParentBaseline } from '../lib/report'

/**
 * Lần chạy gốc để so với lần chạy này: lần chạy của scenario cha (scenario sinh ra khi áp đề xuất hay hiệu chỉnh) có cùng seed và mốc bắt đầu,
 * chọn bằng đúng luật của Báo cáo (pickParentBaseline). Không lấy lần chạy mới nhất của scenario cha: lần đó có thể tạo sau và khác seed.
 * `pending`: còn đang tải nên chưa biết có hay không.
 */
export function useParentRun(current: Run | undefined, scenario: Scenario | undefined): { run: Run | undefined; pending: boolean } {
  const pid = scenario?.parent_id ?? null
  const parent = useQuery({ queryKey: ['scenario', pid], queryFn: () => api.scenario(pid!), enabled: pid !== null })
  const runs = useQuery({ queryKey: ['runs', pid], queryFn: () => api.runs(pid!), enabled: pid !== null })
  const run = current && scenario && runs.data && parent.data
    ? pickParentBaseline(runs.data, current, scenario.seed ?? null, parent.data.seed ?? null)
    : undefined
  return { run, pending: scenario === undefined || (pid !== null && (runs.isPending || parent.isPending)) }
}
