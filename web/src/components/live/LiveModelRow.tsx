import * as Dropdown from '@radix-ui/react-dropdown-menu'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, MoreHorizontal } from 'lucide-react'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api/client'
import type { FeedStatus, NodeType } from '../../api/types'
import { useLive } from '../../hooks/useLive'
import { nodeBadge, summarize } from '../../lib/liveFrame'
import { fmtFactoryTime, speedLabel } from '../../lib/liveFormat'
import { poolCount, thresholdsFor } from '../../lib/model'

export const LIVE_GRID = 'grid grid-cols-[132px_minmax(150px,220px)_minmax(0,1fr)_120px_28px_14px] items-center gap-x-4'

/**
 * Một mô hình đang phát dữ liệu trực tiếp: trạng thái feed, điều cần chú ý (kho Đỏ/Vàng, máy hỏng, thiết bị im lặng) tính đúng như màn Trực tiếp,
 * giờ nhà máy. Bấm vào dòng mở Trực tiếp của chính mô hình đó; các trang khác của mô hình nằm trong menu ⋯.
 */
export function LiveModelRow({ feed, types }: { feed: FeedStatus; types: Record<string, NodeType> }) {
  const model = feed.model ?? ''
  const mk = encodeURIComponent(model)
  const graph = useQuery({ queryKey: ['graph', feed.version_id], queryFn: () => api.graph(feed.version_id!), enabled: feed.version_id != null })
  const { snapshot } = useLive(model)
  const summary = useMemo(() => {
    if (!graph.data) return undefined
    return summarize(graph.data.nodes.map((n) => {
      const ref = { node_type: n.node_type, params: n.params ?? {} }
      const archetype = n.archetype || types[n.node_type]?.archetype || ''
      return { archetype, badge: nodeBadge(archetype, snapshot?.subjects[n.key], thresholdsFor(ref, types), archetype === 'RESOURCE_POOL' ? poolCount(ref, types) : undefined) }
    }))
  }, [graph.data, snapshot, types])
  const running = feed.state === 'running'
  const incidents = feed.incidents.filter((i) => i.active).length
  const total = graph.data?.nodes.length ?? 0
  const notes: { text: string; tone: string }[] = summary ? [
    summary.redStorages > 0 && { text: `${summary.redStorages} kho Đỏ`, tone: 'text-bad-text font-medium' },
    summary.downMachines > 0 && { text: `${summary.downMachines} máy hỏng`, tone: 'text-bad-text font-medium' },
    summary.yellowStorages > 0 && { text: `${summary.yellowStorages} kho Vàng`, tone: 'text-warn' },
    summary.stale > 0 && { text: `${summary.stale} thiết bị mất tín hiệu`, tone: 'text-muted' },
    incidents > 0 && { text: `${incidents} sự cố đang bơm`, tone: 'text-warn' },
  ].filter((x): x is { text: string; tone: string } => Boolean(x)) : []
  const menu = [
    { label: 'Sơ đồ', to: feed.version_id != null ? `/versions/${feed.version_id}` : `/models/${mk}/versions` },
    ...(feed.has_map ? [{ label: 'Bản đồ AGV', to: `/models/${mk}/map` }] : []),
    { label: 'Kết nối dữ liệu', to: `/models/${mk}/connect` },
    { label: 'Báo cáo kho', to: `/reports/warehouse-dashboard?model=${mk}` },
    { label: 'Điều khiển tồn kho', to: `/reports/warehouse?model=${mk}` },
    { label: 'Dashboard vận hành', to: `/reports/operations?model=${mk}` },
  ]

  return (
    <div className={`${LIVE_GRID} relative border-t border-line px-3 py-2.5 first:border-t-0 hover:bg-panel`}>
      <span className={`flex items-center gap-2 text-xs ${running ? 'text-text-2' : 'text-warn'}`}>
        <i className={`h-2 w-2 flex-none rounded-full ${running ? 'bg-ok' : 'bg-warn'}`} aria-hidden />
        {running ? `Đang phát ${speedLabel(feed.speed).replace(/ \(.*\)$/, '')}` : 'Tạm dừng'}
      </span>
      <span className="min-w-0 leading-tight">
        {/* Liên kết phủ cả dòng (after:inset-0); menu ⋯ nằm trên nó (relative z-10) nên vẫn bấm riêng được. */}
        <Link to={`/models/${mk}/live`} className="block truncate text-[12.5px] font-semibold text-text after:absolute after:inset-0 after:content-['']">{model}</Link>
        <span className="block truncate text-[11px] text-faint">{graph.data ? `v${graph.data.version}, ${total} node` : '…'}</span>
      </span>
      <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-[11.5px]">
        {!summary ? <span className="text-muted">…</span>
          : summary.silent === total ? <span className="text-muted">Chưa node nào nhận dữ liệu: ghép tín hiệu ở Kết nối dữ liệu</span>
          : notes.length === 0 ? <span className="text-muted">Không có gì bất thường</span>
          : notes.map((n) => <span key={n.text} className={n.tone}>{n.text}</span>)}
      </span>
      <span className="text-right text-[11px] leading-tight text-muted">
        <span className="block tabular-nums text-text-2">{fmtFactoryTime(feed.virtual_now)}</span>
        giờ nhà máy{feed.vehicles > 0 ? `, ${feed.vehicles} xe` : ''}
      </span>
      <Dropdown.Root>
        <Dropdown.Trigger aria-label={`Các trang khác của ${model}`} className="relative z-10 flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-text">
          <MoreHorizontal size={15} />
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content align="end" sideOffset={4} className="z-50 min-w-48 rounded-lg border border-line-2 bg-raised p-1 text-xs shadow-xl">
            {menu.map((m) => (
              <Dropdown.Item key={m.label} asChild>
                <Link to={m.to} className="block rounded-md px-2.5 py-1.5 text-text-2 outline-none data-[highlighted]:bg-panel data-[highlighted]:text-text">{m.label}</Link>
              </Dropdown.Item>
            ))}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      <ChevronRight size={14} className="text-faint" aria-hidden />
    </div>
  )
}
