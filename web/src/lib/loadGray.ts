import type { Gray } from './traceMap'
import { grayFromRGBA } from './traceMap'

/**
 * Tải ảnh (từ địa chỉ trên server) về ảnh xám, thu nhỏ để cạnh dài nhất ≤ maxSide cho phân tích nhanh.
 * `scale` = bề rộng ảnh xám / bề rộng ảnh gốc (≤ 1): mỗi pixel ảnh xám ứng với 1/scale pixel ảnh gốc.
 */
export async function loadGray(url: string, maxSide = 900): Promise<{ gray: Gray; scale: number }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Không tải được ảnh nền (${res.status})`)
  const bmp = await createImageBitmap(await res.blob())
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Trình duyệt không đọc được điểm ảnh')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bmp, 0, 0, w, h)
  const src = bmp.width
  bmp.close()
  return { gray: grayFromRGBA(ctx.getImageData(0, 0, w, h).data, w, h), scale: w / src }
}
