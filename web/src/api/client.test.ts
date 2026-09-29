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
  it('builds the all-runs query and skips empty filters', async () => {
    const fn = mockFetch(200, [])
    await api.allRuns({ status: 'QUEUED,RUNNING', model: 'm', version: 3, limit: 50 })
    expect(fn).toHaveBeenCalledWith(`${API_BASE}/api/runs?status=QUEUED%2CRUNNING&model=m&version=3&limit=50`, expect.anything())
    await api.allRuns()
    expect(fn).toHaveBeenLastCalledWith(`${API_BASE}/api/runs`, expect.anything())
  })

  it('encodes catalog codes and posts new catalog entries', async () => {
    const fn = mockFetch(200, { code: 'A B' })
    await api.nodeType('A B')
    expect(fn).toHaveBeenCalledWith(`${API_BASE}/api/node-types/A%20B`, expect.anything())
    await api.material('RAW-01')
    expect(fn).toHaveBeenLastCalledWith(`${API_BASE}/api/materials/RAW-01`, expect.anything())
    mockFetch(201, { id: 5 })
    await expect(api.createMaterial({ code: 'X', name: 'X', unit: 'pcs' })).resolves.toEqual({ id: 5 })
  })

  it('queries insights with filters', async () => {
    const fn = mockFetch(200, [])
    await api.insights({ kind: 'RED_RISK', limit: 5 })
    expect(fn).toHaveBeenCalledWith(`${API_BASE}/api/insights?kind=RED_RISK&limit=5`, expect.anything())
  })
})
