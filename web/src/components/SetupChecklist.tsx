import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Circle } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api, ApiError } from '../api/client'
import type { VersionInfo } from '../api/types'
import { nextStep, setupSteps } from '../lib/setupSteps'
import { Card, btnAccentOutline } from './ui'

/**
 * Danh sách "Thiết lập" của mô hình: từ vật tư đến chạy trực tiếp, bước nào xong rồi, bước nào làm tiếp.
 * Người dùng không phải nhớ thứ tự; mỗi bước dẫn thẳng tới màn hình làm việc đó.
 */
export function SetupChecklist({ model, versions }: { model: string; versions: VersionInfo[] }) {
  const materials = useQuery({ queryKey: ['materials'], queryFn: api.materials })
  const sources = useQuery({ queryKey: ['sources', model], queryFn: () => api.sources(model), retry: false })
  const coverage = useQuery({ queryKey: ['live-check', model], queryFn: () => api.liveCheck(model), retry: false })
  const map = useQuery({
    queryKey: ['agv-map', model],
    queryFn: async () => { try { await api.agvMap(model); return true } catch (e) { if (e instanceof ApiError && e.status === 404) return false; throw e } },
    retry: false,
  })
  const feed = useQuery({ queryKey: ['feed-status', model], queryFn: () => api.feed.status(model), retry: false, refetchInterval: 4000 })
  const steps = setupSteps({
    model,
    materials: materials.data?.length ?? 0,
    versions: versions.map((v) => ({ id: v.id, status: v.status, nodes: v.nodes })),
    sources: sources.data?.length,
    coverage: coverage.data ? {
      source: coverage.data.summary.source, derived: coverage.data.summary.derived, signals: coverage.data.summary.signals,
      liveReady: coverage.data.readiness.find((r) => r.feature === 'live')?.ok ?? false,
    } : undefined,
    hasMap: map.data,
    feed: feed.data ? { state: feed.data.state } : undefined,
  })
  const next = nextStep(steps)
  const done = steps.filter((s) => s.done).length
  return (
    <Card title={`Thiết lập mô hình (${done}/${steps.length})`}>
      <ol className="grid gap-x-6 gap-y-1.5 text-xs md:grid-cols-2">
        {steps.map((s) => (
          <li key={s.key} className="flex items-start gap-2 py-1">
            {s.done ? <CheckCircle2 size={15} className="mt-px flex-none text-ok" aria-label="Đã xong" /> : <Circle size={15} className="mt-px flex-none text-faint" aria-label="Chưa xong" />}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Link to={s.to} className="font-medium text-text hover:underline">{s.title}</Link>
                {s.optional && <span className="text-[10.5px] text-faint">tuỳ chọn</span>}
                {next?.key === s.key && <Link to={s.to} className={`${btnAccentOutline} ml-auto !px-2 !py-0.5`}>{s.cta}</Link>}
              </div>
              <p className="text-muted">{s.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  )
}
