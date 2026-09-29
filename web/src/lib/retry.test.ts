import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import { shouldRetry } from './retry'

describe('shouldRetry', () => {
  it('never retries a client error, so a missing object shows its error at once', () => {
    expect(shouldRetry(0, new ApiError(404, [], 'không tìm thấy'))).toBe(false)
    expect(shouldRetry(0, new ApiError(409, [], 'xung đột'))).toBe(false)
  })
  it('retries network and server errors twice', () => {
    expect(shouldRetry(0, new TypeError('Failed to fetch'))).toBe(true)
    expect(shouldRetry(1, new ApiError(503, [], 'bận'))).toBe(true)
    expect(shouldRetry(2, new ApiError(503, [], 'bận'))).toBe(false)
  })
})
