import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import { friendlyMessage } from './errors'

describe('friendlyMessage', () => {
  it('explains a missing object instead of showing the bare English "not found"', () => {
    expect(friendlyMessage(new ApiError(404, [], 'not found'))).toBe('Không tìm thấy. Có thể nó đã bị xoá, hoặc đường dẫn không đúng.')
  })
  it('explains a server that is down or unreachable', () => {
    expect(friendlyMessage(new TypeError('Failed to fetch'))).toMatch(/Không kết nối được máy chủ/)
  })
  it('explains a server fault without leaking an internal message', () => {
    expect(friendlyMessage(new ApiError(500, [], 'pq: deadlock detected'))).toMatch(/Máy chủ gặp lỗi/)
  })
  it('keeps the server message when it says something specific (conflicts, validation, locks)', () => {
    expect(friendlyMessage(new ApiError(409, [], 'có lần chạy đang chạy'))).toBe('có lần chạy đang chạy')
    expect(friendlyMessage(new ApiError(422, [], 'sơ đồ không hợp lệ'))).toBe('sơ đồ không hợp lệ')
  })
  it('handles anything else', () => {
    expect(friendlyMessage(new Error('boom'))).toBe('boom')
    expect(friendlyMessage('lạ')).toBe('lạ')
  })
})
