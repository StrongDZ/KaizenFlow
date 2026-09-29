import { ApiError } from '../api/client'

/** Lỗi 4xx là câu trả lời dứt khoát của server nên không thử lại; lỗi mạng hoặc 5xx thử tối đa hai lần. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false
  return failureCount < 2
}
