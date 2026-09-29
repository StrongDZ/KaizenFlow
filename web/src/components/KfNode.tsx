import * as Popover from '@radix-ui/react-popover'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { FlowNode } from '../lib/graph'
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

export function KfNode({ data, selected }: NodeProps<FlowNode>) {
  const pool = data.archetype === 'RESOURCE_POOL'
  const badge = data.badge
  const tone = data.issue ? 'border-bad' : NODE_TONE[badge?.color ?? 'NONE']
  return (
    <div className={`relative min-w-[132px] rounded-lg border bg-panel px-2.5 py-2 ${tone} ${pool ? 'border-dashed' : ''} ${selected ? 'ring-2 ring-text/60' : ''}`}>
      {!pool && data.archetype !== 'SOURCE' && <Handle type="target" position={Position.Left} />}
      <div className="text-[10px] text-muted">{ARCHETYPE_LABEL[data.archetype] ?? data.archetype}</div>
      <div className="text-xs font-semibold leading-tight text-text">{data.name}</div>
      <div className="text-[10px] text-faint">{data.key}</div>
      {badge && badge.color !== 'NONE' && (
        <div className={`mt-1 text-[11px] font-semibold ${BADGE_TEXT[badge.color]}`}>{badge.text}</div>
      )}
      {data.issue && <div className="mt-1 max-w-[200px] text-[11px] text-bad-text">{data.issue}</div>}
      {!pool && data.archetype !== 'SINK' && <Handle type="source" position={Position.Right} />}
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
