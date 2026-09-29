import { afterEach, describe, expect, it, vi } from 'vitest'
import { API_BASE, ApiError, api, wsUrl } from './client'

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

describe('api client', () => {
  it('parses JSON and builds query strings', async () => {
    const fn = mockFetch(200, [{ subject: 'S', metric: 'coverage_h', t: '2026-10-01T01:00:00Z', p10: 1, p50: 2, p90: 3 }])
    const rows = await api.bands(7, { metric: 'coverage_h' })
    expect(rows[0].p50).toBe(2)
    expect(fn).toHaveBeenCalledWith(`${API_BASE}/api/runs/7/bands?metric=coverage_h`, expect.anything())
  })

  it('turns 422 into ApiError with issues', async () => {
    mockFetch(422, { error: 'invalid', issues: [{ key: 'S>OUT', message: 'lot too big' }] })
    const err = await api.publish(1).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(422)
    expect((err as ApiError).issues[0].key).toBe('S>OUT')
  })

  it('handles 204 and ws url', async () => {
    mockFetch(204, undefined)
    await expect(api.saveGraph(1, { nodes: [], edges: [] })).resolves.toBeUndefined()
    expect(wsUrl).toBe(API_BASE.replace(/^http/, 'ws') + '/ws')
  })
})
