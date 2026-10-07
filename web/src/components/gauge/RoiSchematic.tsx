import type { ReactNode } from 'react'
import type { GaugeReading } from '../../api/gauge'
import { roiBox } from '../../lib/gaugeView'
import { toneOf } from './tone'

/** Khung hình mặc định của camera trạm khi chưa có ảnh để biết kích thước thật. */
export const DEFAULT_FRAME = { width: 1920, height: 1080 }

/** Sơ đồ vị trí các vùng đọc của một trạm, vẽ từ toạ độ ROI trong config. Có ảnh thì ảnh nằm dưới các khung. */
export function RoiSchematic({ gauges, frame = DEFAULT_FRAME, image, children, rounded = 'rounded-lg' }: {
  gauges: GaugeReading[]
  frame?: { width: number; height: number }
  image?: string
  /** Lớp phủ thêm (nhãn giá trị, nút); toạ độ theo phần trăm của khung. */
  children?: ReactNode
  rounded?: string
}) {
  return (
    <div className={`relative overflow-hidden bg-raised ${rounded}`} style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
      {image && <img src={image} alt="" className="absolute inset-0 h-full w-full" />}
      {gauges.map((g) => {
        const box = roiBox(g.roi, frame.width, frame.height)
        if (!box) return null
        return (
          <div
            key={g.gauge_id}
            className={`absolute rounded-sm border-2 ${toneOf(g.state).border}`}
            style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }}
          />
        )
      })}
      {children}
    </div>
  )
}
