import * as Popover from '@radix-ui/react-popover'
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { Wrench } from 'lucide-react'
import { createContext, useContext, useEffect, useRef } from 'react'
import type { Badge, FlowNode } from '../lib/graph'
import { NodeIcon } from './nodeIcons'
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

const ARCHETYPE_ACCENT: Record<string, string> = {
  SOURCE: '#64748b', STORAGE: '#a16207', PROCESS: '#5aa2ff', SINK: '#16a34a', RESOURCE_POOL: '#7c3aed',
}

function DeviceFace({ archetype, icon, accent, tone, selected }: {
  archetype: string; icon?: string; accent: string; tone: string; selected: boolean
}) {
  const common = `relative flex items-center justify-center border-2 bg-panel-2 shadow-lg ${tone} ${selected ? 'ring-2 ring-text/60 ring-offset-2 ring-offset-bg' : ''}`
  if (archetype === 'RESOURCE_POOL') {
    return (
      <div className={`${common} h-[58px] w-[58px] rounded-full border-dashed`}>
        <div className="absolute inset-1 rounded-full border opacity-30" style={{ borderColor: accent }} />
        <NodeIcon name={icon} archetype={archetype} size={25} className="relative" />
        <i className="absolute bottom-1.5 h-1.5 w-1.5 rounded-full" style={{ backgroundColor: accent }} />
      </div>
    )
  }
  if (archetype === 'STORAGE') {
    return (
      <div className={`${common} h-[58px] w-[76px] rounded-md`}>
        <div className="absolute inset-x-2 bottom-2 top-2 flex flex-col justify-between opacity-35" aria-hidden>
          {[0, 1, 2].map((n) => <i key={n} className="h-px w-full" style={{ backgroundColor: accent }} />)}
        </div>
        <div className="absolute bottom-1.5 left-1.5 top-1.5 w-px opacity-50" style={{ backgroundColor: accent }} />
        <div className="absolute bottom-1.5 right-1.5 top-1.5 w-px opacity-50" style={{ backgroundColor: accent }} />
        <NodeIcon name={icon} archetype={archetype} size={25} className="relative drop-shadow" />
      </div>
    )
  }
  if (archetype === 'SOURCE' || archetype === 'SINK') {
    return (
      <div className={`${common} h-[56px] w-[72px] rounded-b-md rounded-t-[22px]`}>
        <div className="absolute inset-x-2 bottom-1.5 h-1 rounded-full opacity-35" style={{ backgroundColor: accent }} />
        <NodeIcon name={icon} archetype={archetype} size={25} className="relative" />
      </div>
    )
  }
  return (
    <div className={`${common} h-[58px] w-[76px] rounded-lg`}>
      {[['left-1.5', 'top-1.5'], ['right-1.5', 'top-1.5'], ['left-1.5', 'bottom-1.5'], ['right-1.5', 'bottom-1.5']].map(([x, y]) => (
        <i key={`${x}-${y}`} className={`absolute ${x} ${y} h-1.5 w-1.5 rounded-full bg-line-2`} />
      ))}
      <div className="absolute inset-x-2 bottom-1.5 h-1 rounded-full opacity-55" style={{ backgroundColor: accent }} />
      <NodeIcon name={icon} archetype={archetype} size={27} className="relative" />
      <i className="absolute right-2 top-2 h-2 w-2 rounded-full border border-panel" style={{ backgroundColor: accent }} />
    </div>
  )
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
  const maintenance = badge?.kind === 'MAINTENANCE'
  const accent = data.accent ?? ARCHETYPE_ACCENT[data.archetype] ?? 'var(--color-muted)'
  const tone = maintenance
    ? 'border-warn text-warn ring-2 ring-warn/25'
    : data.issueTone === 'error' ? 'border-bad' : data.issueTone === 'warning' ? 'border-warn' : NODE_TONE[badge?.color ?? 'NONE']
  return (
    <div className="relative flex min-w-[108px] flex-col items-center overflow-visible text-center" style={{ color: accent }}>
      {maintenance && (
        <div className="mb-1.5 flex items-center justify-center gap-1 rounded-full border border-warn/60 bg-lock-bg px-2 py-0.5 text-[8.5px] font-bold uppercase tracking-wide text-warn shadow-sm">
          <Wrench size={11} /> Đang bảo trì
        </div>
      )}
      <div className="relative">
        {!pool && data.archetype !== 'SOURCE' && <Handle type="target" position={inSide} />}
        <DeviceFace archetype={data.archetype} icon={data.icon} accent={accent} tone={tone} selected={selected} />
        {!pool && data.archetype !== 'SINK' && <Handle type="source" position={outSide} />}
      </div>
      <div className="mt-1.5 max-w-[118px] rounded-md bg-bg/80 px-1.5 py-1 shadow-sm">
        <div className="truncate text-[11px] font-bold leading-none text-text">{data.key}</div>
        <div className="mt-0.5 truncate text-[8.5px] text-muted">{data.name}</div>
      </div>
      {badge && badge.color !== 'NONE' && (
        <div title={badge.hint} className={`mt-1 max-w-[132px] rounded-full border border-line bg-panel px-2 py-0.5 text-[8.5px] font-semibold ${BADGE_TEXT[badge.color]} ${badge.hint ? 'cursor-help' : ''}`}>{badge.text}</div>
      )}
      {data.issue && (
        <div title={data.issueTitle} className={`mt-1 max-w-[132px] text-[9px] font-medium ${data.issueTone === 'warning' ? 'text-lock-text' : 'text-bad-text'}`}>{data.issue}</div>
      )}
      {data.pins && data.pins.length > 0 && (
        <div className="absolute -right-1 -top-2 flex gap-1">
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
