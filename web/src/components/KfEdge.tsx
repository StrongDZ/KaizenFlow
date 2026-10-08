import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react'
import type { CSSProperties } from 'react'
import type { FlowEdge } from '../lib/graph'

/**
 * Edge của Control Room: conveyor góc vuông, nhãn vật tư và vệt sáng chuyển động theo hướng dòng hàng.
 * Độ đậm của vệt lấy từ số hạt tương đối do lib/flow.ts tính.
 */
export function KfEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, label, data, selected }: EdgeProps<FlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 10, offset: 18,
  })
  const dots = data?.dots ?? 0
  const cycle = data?.cycleS ?? 3
  const blocked = data?.blocked === true
  const explicit = typeof style?.stroke === 'string' ? style.stroke : undefined
  const color = explicit ?? (blocked ? 'var(--color-warn)' : selected ? 'var(--color-accent)' : 'color-mix(in srgb, var(--color-accent) 72%, var(--color-text-2))')
  return (
    <>
      <BaseEdge id={`${id}-underlay`} path={path} style={{ stroke: 'var(--color-bg)', strokeWidth: 7, opacity: 0.9 }} />
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{ ...style, stroke: color, strokeWidth: selected ? 3 : blocked ? 2.5 : 2, opacity: selected ? 1 : blocked ? 0.7 : 0.72 }}
      />
      {dots > 0 && !blocked && (
        <>
          <path
            d={path}
            className="kf-conveyor-motion"
            style={{
              stroke: color,
              strokeWidth: 2.5 + Math.min(2, dots * 0.22),
              animationDuration: `${Math.max(0.8, cycle * 0.55)}s`,
              animationPlayState: data?.running ? 'running' : 'paused',
              opacity: 0.28 + Math.min(0.25, dots * 0.04),
            }}
          />
          {Array.from({ length: dots }, (_, i) => {
            const at = (i + 0.5) / dots
            const particleStyle = {
              color,
              offsetPath: `path("${path}")`,
              animationDuration: `${cycle}s`,
              animationDelay: `${-at * cycle}s`,
              animationPlayState: data?.running ? 'running' : 'paused',
              '--kf-at': `${at * 100}%`,
            } as CSSProperties
            return <circle key={i} r={5.25} className="kf-flow-particle" style={particleStyle} />
          })}
        </>
      )}
      <EdgeLabelRenderer>
        <div
          className={`nodrag nopan pointer-events-none absolute flex items-center gap-1 rounded bg-bg/90 px-1 py-px text-[8px] shadow-sm ${selected ? 'ring-1 ring-accent' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}
          title={String(label ?? '')}
        >
          <b className="font-semibold text-text-2">{data?.material || String(label ?? '')}</b>
          {data?.statusText && <span className={blocked ? 'font-semibold text-warn' : 'text-muted'}>· {data.statusText}</span>}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

export const kfEdgeTypes = { flow: KfEdge }
