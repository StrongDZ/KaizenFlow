import { ApiError } from '../api/client'

/** Câu báo lỗi cho người dùng: lỗi kỹ thuật chung chung được giải thích bằng tiếng Việt; lời nhắn cụ thể của server thì giữ. */
export function friendlyMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'Không tìm thấy. Có thể nó đã bị xoá, hoặc đường dẫn không đúng.'
    if (error.status >= 500) return 'Máy chủ gặp lỗi. Thử lại sau; nếu vẫn lỗi, xem nhật ký của API.'
    return error.message
  }
  if (error instanceof TypeError) return 'Không kết nối được máy chủ API. Kiểm tra API đã chạy chưa (docker compose up -d).'
  return error instanceof Error ? error.message : String(error)
}
