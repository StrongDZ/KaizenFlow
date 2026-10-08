import { fitImage } from './mapImage'

/**
 * Thu nhỏ ảnh mặt bằng trước khi tải lên: cạnh dài nhất ≤ maxSide, PNG nếu đủ nhỏ, không thì JPEG. Vùng trong suốt thành nền trắng
 * (bản vẽ xuất từ phần mềm thiết kế hay có nền trong suốt, mà bước dò đường cần nền rõ ràng).
 */
export async function prepareImage(file: Blob, maxSide = 2400, maxBytes = 5 * 1024 * 1024): Promise<{ blob: Blob; w: number; h: number }> {
  const bmp = await createImageBitmap(file)
  const { w, h } = fitImage(bmp.width, bmp.height, maxSide)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Trình duyệt không vẽ được ảnh')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  const toBlob = (type: string, quality?: number) => new Promise<Blob | null>((res) => canvas.toBlob(res, type, quality))
  let blob = await toBlob('image/png')
  if (!blob || blob.size > maxBytes) blob = await toBlob('image/jpeg', 0.88)
  if (!blob || blob.size > maxBytes) blob = await toBlob('image/jpeg', 0.7)
  if (!blob || blob.size > maxBytes) throw new Error('Ảnh quá lớn ngay cả sau khi thu nhỏ, hãy dùng ảnh nhỏ hơn')
  return { blob, w, h }
}
