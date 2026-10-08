import * as Popover from '@radix-ui/react-popover'
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { createContext, useContext, useEffect, useRef } from 'react'
import type { Badge, FlowNode } from '../lib/graph'
import { NodeAvatar } from './NodeIdentity'
import { pinClass } from './PinDot'

export const ARCHETYPE_LABEL: Record<string, string> = {
  SOURCE: 'Nguồn', STORAGE: 'Kho / buffer', PROCESS: 'Trạm xử lý', SINK: 'Đích', RESOURCE_POOL: 'Đội xe / người',
}

const BADGE_TEXT: Record<string, string> = {
  GREEN: 'text-ok', YELLOW: 'text-warn', RED: 'text-bad-text', INFO: 'text-muted',
}

const NODE_TONE: Record<string, string> = {
  RED: 'border-bad bg-bad-bg', YELLOW: 'border-warn/60', GREEN: 'border-line-2', INFO: 'border-line-2', NONE: 'border-line-2',
}

/**
 * Nhãn do trang cấp qua context thay vì node.data. Màn Trực tiếp đổi nhãn mỗi 0,4 giây: nếu tạo lại object node mỗi lần
 * thì React Flow mất kích thước đã đo và node không bao giờ hiện.
 */
export const LiveBadgeContext = createContext<Map<string, Badge | undefined> | null>(null)

export function KfNode({ id, data, selected }: NodeProps<FlowNode>) {
  const live = useContext(LiveBadgeContext)
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
  const tone = data.issueTone === 'error' ? 'border-bad' : data.issueTone === 'warning' ? 'border-warn' : NODE_TONE[badge?.color ?? 'NONE']
  return (
    <div className={`relative min-w-[140px] rounded-lg border bg-panel px-2 py-1.5 ${tone} ${pool ? 'border-dashed' : ''} ${selected ? 'ring-2 ring-text/60' : ''}`}>
      {!pool && data.archetype !== 'SOURCE' && <Handle type="target" position={inSide} />}
      <div className="flex items-center gap-2" title={ARCHETYPE_LABEL[data.archetype] ?? data.archetype}>
        <NodeAvatar icon={data.icon} archetype={data.archetype} size={26} />
        <div className="min-w-0 leading-tight">
          <div className="text-xs font-semibold text-text">{data.name}</div>
          <div className="text-[10px] tracking-wide text-faint">{data.key}</div>
        </div>
      </div>
      {badge && badge.color !== 'NONE' && (
        <div title={badge.hint} className={`mt-1 text-[11px] font-semibold ${BADGE_TEXT[badge.color]} ${badge.hint ? 'cursor-help' : ''}`}>{badge.text}</div>
      )}
      {data.issue && (
        <div title={data.issueTitle} className={`mt-1 max-w-[200px] text-[11px] font-medium ${data.issueTone === 'warning' ? 'text-lock-text' : 'text-bad-text'}`}>{data.issue}</div>
      )}
      {!pool && data.archetype !== 'SINK' && <Handle type="source" position={outSide} />}
      {data.pins && data.pins.length > 0 && (
        <div className="absolute -top-2.5 right-1 flex gap-1">
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
