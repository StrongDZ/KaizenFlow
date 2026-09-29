import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { FlowNode } from '../lib/graph'

export const ARCHETYPE_LABEL: Record<string, string> = {
  SOURCE: 'Nguồn', STORAGE: 'Kho / buffer', PROCESS: 'Trạm xử lý', SINK: 'Đích', RESOURCE_POOL: 'Đội xe / người',
}

const BADGE: Record<string, string> = {
  GREEN: 'bg-green-100 text-green-800', YELLOW: 'bg-yellow-100 text-yellow-800',
  RED: 'bg-red-100 text-red-800', INFO: 'bg-slate-100 text-slate-700',
}

export function KfNode({ data, selected }: NodeProps<FlowNode>) {
  const pool = data.archetype === 'RESOURCE_POOL'
  const badge = data.badge
  return (
    <div className={`min-w-[160px] rounded-lg border-2 bg-white px-3 py-2 shadow-sm ${selected ? 'ring-2 ring-blue-400' : ''} ${pool ? 'border-dashed' : ''}`}
      style={{ borderColor: data.issue ? '#dc2626' : data.color }}>
      {!pool && data.archetype !== 'SOURCE' && <Handle type="target" position={Position.Left} />}
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{ARCHETYPE_LABEL[data.archetype] ?? data.archetype}</div>
      <div className="font-semibold leading-tight">{data.name}</div>
      <div className="text-xs text-slate-400">{data.key}</div>
      {badge && badge.color !== 'NONE' && (
        <div className={`mt-1 rounded px-1.5 py-0.5 text-xs font-medium ${BADGE[badge.color]}`}>{badge.text}</div>
      )}
      {data.issue && <div className="mt-1 max-w-[200px] text-xs text-red-600">{data.issue}</div>}
      {!pool && data.archetype !== 'SINK' && <Handle type="source" position={Position.Right} />}
    </div>
  )
}

export const kfNodeTypes = { kf: KfNode }
