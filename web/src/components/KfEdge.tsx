import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react'
import type { CSSProperties } from 'react'
import type { FlowEdge } from '../lib/graph'

/**
 * Edge của Control Room: đường bezier như mặc định, thêm các hạt chạy dọc đường. Số hạt và chu kỳ do trang tính từ số liệu
 * (lib/flow.ts); hạt đứng yên khi replay dừng. Khi người dùng bật "giảm chuyển động" thì hạt đứng, rải đều trên đường.
 */
export function KfEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, label, data }: EdgeProps<FlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const dots = data?.dots ?? 0
  const cycle = data?.cycleS ?? 3
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={data?.estimated ? { ...style, strokeDasharray: '6 4' } : style} label={label} labelX={labelX} labelY={labelY} />
      {Array.from({ length: dots }, (_, i) => {
        const at = (i + 0.5) / dots // đứng yên thì nằm giữa các khoảng, không dồn ở đầu đường
        const dotStyle = {
          offsetPath: `path("${path}")`,
          animationDuration: `${cycle}s`,
          animationDelay: `${-at * cycle}s`,
          animationPlayState: data?.running ? 'running' : 'paused',
          '--kf-at': `${at * 100}%`,
        } as CSSProperties
        return <circle key={i} r={3} className="kf-dot" style={dotStyle} />
      })}
    </>
  )
}

export const kfEdgeTypes = { flow: KfEdge }
