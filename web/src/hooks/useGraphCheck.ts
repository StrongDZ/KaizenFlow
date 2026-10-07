import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import type { CheckReport, GraphEdge, GraphNode } from '../api/types'

export type CheckBody = { nodes: GraphNode[]; edges: GraphEdge[] }

/**
 * Kiểm tra sơ đồ đang sửa trên server (mọi luật nằm ở server, web chỉ hiển thị). Tự chạy chế độ nhanh sau `delayMs`
 * kể từ lần sửa cuối; `run(true)` kiểm sâu ngay (hỏi cả sim), dùng khi Lưu, Publish hoặc bấm nút Kiểm tra.
 * Chỉ kết quả của lượt gọi mới nhất được nhận, nên kết quả cũ về muộn không đè kết quả mới.
 */
export function useGraphCheck(versionId: number, body: CheckBody, delayMs = 600) {
  const [report, setReport] = useState<CheckReport>()
  const [checking, setChecking] = useState(true)
  const [error, setError] = useState<unknown>()
  const seq = useRef(0)
  const latest = useRef(body)
  latest.current = body
  const key = JSON.stringify(body)

  const run = useCallback(async (deep: boolean): Promise<CheckReport> => {
    const mine = ++seq.current
    setChecking(true)
    try {
      const r = await api.checkGraph(versionId, latest.current, deep)
      if (mine === seq.current) { setReport(r); setError(undefined) }
      return r
    } catch (e) {
      if (mine === seq.current) setError(e)
      throw e
    } finally {
      if (mine === seq.current) setChecking(false)
    }
  }, [versionId])

  useEffect(() => {
    setChecking(true)
    const t = setTimeout(() => { void run(false).catch(() => undefined) }, delayMs)
    return () => clearTimeout(t)
  }, [key, run, delayMs])

  return { report, checking, error, run }
}
