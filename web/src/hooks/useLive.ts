import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { api } from '../api/client'
import { mergeLive } from '../lib/liveMerge'
import { getLive, subscribeLive } from '../lib/liveStore'

/**
 * Trạng thái live của một mô hình: bản chụp GET mỗi 3 giây (nguồn, lỗi ghép) ghép với bản đẩy WebSocket 0,4 giây.
 * Component render lại mỗi giây để tuổi dữ liệu tăng dần khi feed ngừng.
 */
export function useLive(model: string | undefined) {
  const base = useQuery({ queryKey: ['live', model], queryFn: () => api.live(model!), enabled: !!model, refetchInterval: 3000 })
  const push = useSyncExternalStore(subscribeLive, () => (model ? getLive(model) : undefined))
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const h = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(h)
  }, [])
  const stamped = useMemo(() => (base.data ? { data: base.data, at: base.dataUpdatedAt } : undefined), [base.data, base.dataUpdatedAt])
  const snapshot = useMemo(() => mergeLive(stamped, push, Date.now()), [stamped, push, tick]) // eslint-disable-line react-hooks/exhaustive-deps
  return { snapshot, isLoading: base.isLoading, error: base.error }
}

/** Trạng thái của feed service (qua proxy của Go); hỏi mỗi 2 giây. `error` khác rỗng nghĩa là feed chưa bật. */
export function useFeedStatus() {
  return useQuery({ queryKey: ['feed-status'], queryFn: api.feed.status, refetchInterval: 2000, retry: false })
}
