import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'

/** Lần chạy gốc để so sánh: scenario sinh ra từ một scenario khác (áp đề xuất, hiệu chỉnh) và scenario đó đã có lần chạy xong. */
export function useParentRun(parentScenarioId: number | null | undefined) {
  const runs = useQuery({
    queryKey: ['runs', parentScenarioId], queryFn: () => api.runs(parentScenarioId!), enabled: parentScenarioId != null,
  })
  return runs.data?.find((r) => r.status === 'DONE')
}
