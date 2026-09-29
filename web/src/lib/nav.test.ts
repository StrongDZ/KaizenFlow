import { describe, expect, it } from 'vitest'
import { crumbsFor, isTabActive, sectionOf, switchVersionPath, tabsFor } from './nav'

describe('sectionOf', () => {
  it('maps paths to rail sections', () => {
    expect(sectionOf('/')).toBe('overview')
    expect(sectionOf('/models')).toBe('models')
    expect(sectionOf('/models/m/versions')).toBe('models')
    expect(sectionOf('/versions/7/scenarios')).toBe('models')
    expect(sectionOf('/scenarios/5')).toBe('models')
    expect(sectionOf('/runs')).toBe('runs')
    expect(sectionOf('/runs/12/report')).toBe('runs')
    expect(sectionOf('/compare')).toBe('runs')
    expect(sectionOf('/library/materials/RAW-01')).toBe('library')
  })
})

describe('tabsFor', () => {
  it('gives the model workspace tabs', () => {
    const tabs = tabsFor('/versions/7', { modelKey: 'm', versionId: 7 })
    expect(tabs.map((t) => t.label)).toEqual(['Sơ đồ', 'Scenario', 'Lần chạy', 'Phiên bản'])
    expect(tabs.map((t) => t.to)).toEqual(['/versions/7', '/versions/7/scenarios', '/versions/7/runs', '/models/m/versions'])
  })

  it('opens the latest version from the versions page', () => {
    const tabs = tabsFor('/models/m/versions', { modelKey: 'm', latestVersionId: 9 })
    expect(tabs[0].to).toBe('/versions/9')
    expect(tabsFor('/models/m/versions', { modelKey: 'm' }).map((t) => t.label)).toEqual(['Phiên bản'])
  })

  it('gives the run workspace tabs and none elsewhere', () => {
    expect(tabsFor('/runs/12/report', {}).map((t) => t.to)).toEqual([
      '/runs/12', '/runs/12/sensors', '/runs/12/recommendations', '/runs/12/report',
    ])
    expect(tabsFor('/models', {})).toEqual([])
    expect(tabsFor('/library/node-types', {})).toEqual([])
  })

  it('encodes model keys in the versions link', () => {
    expect(tabsFor('/versions/1', { modelKey: 'a b', versionId: 1 })[3].to).toBe('/models/a%20b/versions')
  })
})

describe('isTabActive', () => {
  const tabs = tabsFor('/scenarios/5', { modelKey: 'm', versionId: 7 })
  it('keeps the diagram tab exact and scenario tab broad', () => {
    expect(isTabActive(tabs[0], '/versions/7')).toBe(true)
    expect(isTabActive(tabs[0], '/versions/7/scenarios')).toBe(false)
    expect(isTabActive(tabs[1], '/versions/7/scenarios/new')).toBe(true)
    expect(isTabActive(tabs[1], '/scenarios/5')).toBe(true)
    expect(isTabActive(tabs[1], '/versions/7')).toBe(false)
  })
})

describe('crumbsFor', () => {
  it('builds crumbs for top-level pages', () => {
    expect(crumbsFor('/', {}).map((c) => c.label)).toEqual(['Tổng quan'])
    expect(crumbsFor('/models', {}).map((c) => c.label)).toEqual(['Mô hình'])
    expect(crumbsFor('/compare', {}).map((c) => c.label)).toEqual(['Lần chạy', 'So sánh'])
  })

  it('shows model, version picker and scenario in the model workspace', () => {
    const c = crumbsFor('/scenarios/5', { modelKey: 'm', version: 2, scenarioName: 'Ca sáng' })
    expect(c.map((x) => x.label)).toEqual(['Mô hình', 'm', 'v2', 'Ca sáng'])
    expect(c[2].picker).toBe(true)
    expect(crumbsFor('/versions/7/scenarios', { modelKey: 'm', version: 2 }).map((x) => x.label)).toEqual(['Mô hình', 'm', 'v2'])
  })

  it('degrades gracefully while data is loading', () => {
    expect(crumbsFor('/versions/7', {}).map((c) => c.label)).toEqual(['Mô hình', '…'])
  })

  it('names runs like the spec example', () => {
    const c = crumbsFor('/runs/12', { modelKey: 'm', version: 2, scenarioName: 'Máy dập 3 hỏng' })
    expect(c.map((x) => x.label)).toEqual(['m', 'v2', 'Máy dập 3 hỏng', 'Run #12'])
  })

  it('builds library crumbs', () => {
    expect(crumbsFor('/library/node-types', {}).map((c) => c.label)).toEqual(['Thư viện', 'Node type'])
    expect(crumbsFor('/library/materials/RAW-01', {}).map((c) => c.label)).toEqual(['Thư viện', 'Vật tư', 'RAW-01'])
    expect(crumbsFor('/library/node-types/new', {}).map((c) => c.label)).toEqual(['Thư viện', 'Node type', 'Tạo mới'])
  })
})

describe('switchVersionPath', () => {
  it('keeps the current tab when switching versions', () => {
    expect(switchVersionPath('/versions/3', 7)).toBe('/versions/7')
    expect(switchVersionPath('/versions/3/scenarios', 7)).toBe('/versions/7/scenarios')
    expect(switchVersionPath('/versions/3/scenarios/new', 7)).toBe('/versions/7/scenarios')
    expect(switchVersionPath('/versions/3/runs', 7)).toBe('/versions/7/runs')
    expect(switchVersionPath('/scenarios/5', 7)).toBe('/versions/7/scenarios')
    expect(switchVersionPath('/models/m/versions', 7)).toBe('/versions/7')
  })
})
