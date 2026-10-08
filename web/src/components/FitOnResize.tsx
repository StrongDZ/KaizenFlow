import { useReactFlow, useStore, type FitViewOptions } from '@xyflow/react'
import { useEffect, useRef } from 'react'

/**
 * Đặt trong <ReactFlow> của màn chỉ xem (Trực tiếp, Control Room): khung đổi bề rộng đáng kể (thu gọn hay mở rộng panel điều hướng,
 * đổi cỡ cửa sổ) thì canh lại cho sơ đồ vừa khung. Màn sửa sơ đồ không dùng, để khỏi phá góc nhìn người dùng đang chỉnh.
 */
export function FitOnResize({ options }: { options?: FitViewOptions }) {
  const width = useStore((s) => s.width)
  const { fitView } = useReactFlow()
  const last = useRef(width)
  const opts = useRef(options)
  opts.current = options
  useEffect(() => {
    if (width === 0) return
    if (last.current === 0) { last.current = width; return }
    if (Math.abs(width - last.current) < 40) return
    last.current = width
    const t = setTimeout(() => void fitView({ ...opts.current, duration: 250 }), 60)
    return () => clearTimeout(t)
  }, [width, fitView])
  return null
}
