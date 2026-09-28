import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { wsUrl } from './client'

/** Nghe /ws; khi run đổi trạng thái thì làm mới query liên quan. Tự nối lại sau 2 s. */
export function useLiveRuns(): void {
  const qc = useQueryClient()
  useEffect(() => {
    let ws: WebSocket | null = null
    let stopped = false
    const connect = () => {
      ws = new WebSocket(wsUrl)
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as { type?: string; run_id?: number }
        if (msg.type === 'run_status') {
          void qc.invalidateQueries({ queryKey: ['run', msg.run_id] })
          void qc.invalidateQueries({ queryKey: ['runs'] })
        }
      }
      ws.onclose = () => {
        if (!stopped) setTimeout(connect, 2000)
      }
    }
    connect()
    return () => {
      stopped = true
      ws?.close()
    }
  }, [qc])
}
