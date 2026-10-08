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

  it('sends a safe recommendation adjustment when the operator edits capacity', async () => {
    const fn = mockFetch(202, { run_id: 42 })
    await expect(api.applyInsight(9, 2, { to_slots: 4 })).resolves.toEqual({ run_id: 42 })
    expect(fn).toHaveBeenCalledWith(`${API_BASE}/api/insights/9/apply`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ rank: 2, adjustment: { to_slots: 4 } }),
    }))
  })

  it('keeps impact and locked flags from 409 bodies', async () => {
    mockFetch(409, { error: 'has dependents', impact: { scenarios: 3, runs: 12 } })
    const impact = (await api.deleteScenario(1, false).catch((e: unknown) => e)) as ApiError
    expect(impact).toBeInstanceOf(ApiError)
    expect(impact.status).toBe(409)
    expect(impact.impact).toEqual({ scenarios: 3, runs: 12 })
    expect(impact.locked).toBe(false)

    mockFetch(409, { error: 'đã khoá', locked: true, usage: { runs: 1 } })
    const locked = (await api.updateScenario(1, { name: 'x', horizon_s: 60, replications: 1, start_state: 'WARMUP', injections: [], overrides: [] }).catch((e: unknown) => e)) as ApiError
    expect(locked.locked).toBe(true)
    expect(locked.impact).toBeUndefined()
  })

  it('sends DELETE with an optional cascade flag and PUT with a JSON body', async () => {
    const fn = mockFetch(204, undefined)
    await api.deleteScenario(5, true)
    expect(fn).toHaveBeenCalledWith(`${API_BASE}/api/scenarios/5?cascade=true`, expect.objectContaining({ method: 'DELETE' }))
    await api.deleteScenario(5, false)
    expect(fn).toHaveBeenLastCalledWith(`${API_BASE}/api/scenarios/5`, expect.objectContaining({ method: 'DELETE' }))
    await api.deleteModel('a b', true)
    expect(fn).toHaveBeenLastCalledWith(`${API_BASE}/api/models/a%20b?cascade=true`, expect.objectContaining({ method: 'DELETE' }))
    await api.deleteRun(9)
    expect(fn).toHaveBeenLastCalledWith(`${API_BASE}/api/runs/9`, expect.objectContaining({ method: 'DELETE' }))
    await api.updateMaterial('RAW-01', { name: 'X' })
    expect(fn).toHaveBeenLastCalledWith(`${API_BASE}/api/materials/RAW-01`, expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: 'X' }) }))
  })
})
