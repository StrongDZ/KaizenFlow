import { sparkGeom } from '../../lib/spark'
import type { Point } from '../../lib/replay'

export function Sparkline({ points, redH, cursor, width = 216, height = 42 }: {
  points: Point[]; redH?: number; cursor?: number; width?: number; height?: number
}) {
  const g = sparkGeom(points, width, height, { redH, cursor, cap: 24 })
  if (!g.band) return null
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Số giờ tồn kho còn đủ dùng, dải p10 đến p90">
      <polygon points={g.band} fill="var(--color-bad)" fillOpacity={0.2} />
      <polyline points={g.line} fill="none" stroke="var(--color-text)" strokeWidth={1.4} />
      {g.thresholdY !== undefined && (
        <line x1={0} x2={width} y1={g.thresholdY} y2={g.thresholdY} stroke="var(--color-bad)" strokeDasharray="3 3" />
      )}
      {g.cursorX !== undefined && <line x1={g.cursorX} x2={g.cursorX} y1={0} y2={height} stroke="var(--color-text)" strokeOpacity={0.6} />}
    </svg>
  )
}
