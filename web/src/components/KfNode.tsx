import * as Popover from '@radix-ui/react-popover'
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { Wrench } from 'lucide-react'
import { createContext, useContext, useEffect, useRef } from 'react'
import type { NodeType } from '../api/types'
import type { Badge, FlowNode } from '../lib/graph'
import type { Tone } from '../lib/nodeFacts'
import { designRows, effectiveParams } from '../lib/nodeSummary'
import { NodeAvatar } from './NodeIdentity'
import { pinClass } from './PinDot'

export const ARCHETYPE_LABEL: Record<string, string> = {
  SOURCE: 'Nguồn', STORAGE: 'Kho / buffer', PROCESS: 'Trạm xử lý', SINK: 'Đích', RESOURCE_POOL: 'Đội xe / người',
}

/**
 * Nhãn do trang cấp qua context thay vì node.data. Màn Trực tiếp đổi nhãn mỗi 0,4 giây: nếu tạo lại object node mỗi lần
 * thì React Flow mất kích thước đã đo và node không bao giờ hiện.
 */
export const LiveBadgeContext = createContext<Map<string, Badge | undefined> | null>(null)

/**
 * `design`: thân thẻ là thông số thiết lập (cần `types` để gộp mặc định của loại node).
 * `run`: thân thẻ là số đo (data.rows, nhãn trạng thái); không có số đo thì chỉ còn phần đầu.
 */
export const KfNodeContext = createContext<{ mode: 'design' | 'run'; types: Record<string, NodeType> }>({ mode: 'design', types: {} })
export const RUN_NODES = { mode: 'run' as const, types: {} }

/** Chấm trạng thái ở góc phải phần đầu: đọc được cả khi thu nhỏ sơ đồ, lúc chữ trong thân đã quá bé. */
const DOT: Partial<Record<Badge['color'], string>> = { GREEN: 'bg-ok', YELLOW: 'bg-warn', RED: 'bg-bad' }
const STATUS_TEXT: Record<Badge['color'], string> = { GREEN: 'text-text-2', YELLOW: 'text-warn', RED: 'text-bad-text font-semibold', INFO: 'text-text-2', NONE: 'text-muted' }
const ROW_TONE: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad-text', muted: 'text-muted' }

function borderOf(badge: Badge | undefined, issueTone: 'error' | 'warning' | undefined): string {
  if (badge?.kind === 'MAINTENANCE') return 'border-warn'
  if (issueTone === 'error' || badge?.color === 'RED') return 'border-bad/80'
  if (issueTone === 'warning' || badge?.color === 'YELLOW') return 'border-warn/60'
  return 'border-line-2'
}

/**
 * Thẻ node trên sơ đồ: phần đầu là danh tính (biểu tượng theo vai trò, tên, mã), thân là vài dòng trọng yếu.
 * Màu của biểu tượng nói node LÀ GÌ; màu viền và chấm nói node ĐANG THẾ NÀO. Đội xe / người không nối dây nên viền nét đứt.
 */
export function KfNode({ id, data, selected }: NodeProps<FlowNode>) {
  const live = useContext(LiveBadgeContext)
  const { mode, types } = useContext(KfNodeContext)
  const dir = data.dir ?? 'LR'
  const updateInternals = useUpdateNodeInternals()
  // React Flow đo vị trí cổng một lần; đổi hướng thì phải đo lại (lúc mount thì không, để khỏi làm rối fitView ban đầu).
  const shown = useRef(dir)
  useEffect(() => {
    if (shown.current === dir) return
    shown.current = dir
    updateInternals(id)
  }, [id, dir, updateInternals])
  const inSide = dir === 'TB' ? Position.Top : Position.Left
  const outSide = dir === 'TB' ? Position.Bottom : Position.Right
  const pool = data.archetype === 'RESOURCE_POOL'
  const badge = live ? live.get(id) : data.badge
  const maintenance = badge?.kind === 'MAINTENANCE'
  const status = badge && badge.color !== 'NONE' ? badge : undefined
  const rows = data.rows ?? (mode === 'design' ? designRows(data.archetype, effectiveParams(data.params, types[data.nodeType])) : [])
  const dot = status && DOT[status.color]
  const body = status || rows.length > 0 || data.issue
  return (
    <div
      className={`relative w-[164px] rounded-lg border bg-panel text-left shadow-sm ${pool ? 'border-dashed' : ''} ${borderOf(badge, data.issueTone)} ${
        selected ? 'ring-2 ring-accent/70 ring-offset-1 ring-offset-bg' : ''
      }`}
    >
      {!pool && data.archetype !== 'SOURCE' && <Handle type="target" position={inSide} />}
      <div className="flex items-center gap-2 px-2 py-1.5">
        <NodeAvatar icon={data.icon} archetype={data.archetype} size={22} />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[11.5px] font-semibold text-text" title={data.name}>{data.name}</span>
          {data.key !== data.name && <span className="block truncate text-[9.5px] text-faint">{data.key}</span>}
        </span>
        {maintenance
          ? <span title="Đang bảo trì" className="flex-none text-warn"><Wrench size={12} aria-label="Đang bảo trì" /></span>
          : dot && <i className={`h-2 w-2 flex-none rounded-full ${dot}`} aria-hidden />}
      </div>
      {body && (
        <div className="space-y-px border-t border-line px-2 pb-1.5 pt-1 text-[10px] leading-[15px]">
          {status && (
            <div title={status.hint} className={`truncate ${maintenance ? 'font-medium text-warn' : STATUS_TEXT[status.color]} ${status.hint ? 'cursor-help' : ''}`}>
              {status.text}
            </div>
          )}
          {rows.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between gap-2">
              <span className="flex-none text-muted">{r.label}</span>
              <span className={`truncate text-right tabular-nums ${r.tone ? ROW_TONE[r.tone] : 'text-text-2'}`} title={r.value}>{r.value}</span>
            </div>
          ))}
          {data.issue && (
            <div title={data.issueTitle} className={`truncate font-medium ${data.issueTone === 'warning' ? 'text-warn' : 'text-bad-text'}`}>{data.issue}</div>
          )}
        </div>
      )}
      {!pool && data.archetype !== 'SINK' && <Handle type="source" position={outSide} />}
      {data.pins && data.pins.length > 0 && (
        <div className="absolute -right-1.5 -top-2 flex gap-1">
          {data.pins.map((p) => (
            <Popover.Root key={p.n} open={data.pinState?.open === p.n} onOpenChange={(o) => data.pinState?.setOpen(o ? p.n : null)}>
              <Popover.Trigger asChild>
                <button className={`nodrag ${pinClass(p.tone)}`} aria-label={`Cảnh báo ${p.n}`}>{p.n}</button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  side="top" sideOffset={10} collisionPadding={12}
                  className="z-50 w-64 rounded-xl border border-line-2 bg-raised p-3 text-xs text-text shadow-xl"
                >
                  {p.content}
                  <Popover.Arrow className="fill-raised" />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          ))}
        </div>
      )}
    </div>
  )
}

export const kfNodeTypes = { kf: KfNode }
