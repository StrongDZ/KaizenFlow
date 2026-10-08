import { describe, expect, it } from 'vitest'
import { crumbsFor, groupTabs, isCanvasPath, isTabActive, runTabs, sectionOf, subNavFor, switchVersionPath, tabsFor } from './nav'

describe('sectionOf', () => {
  it('maps paths to rail sections', () => {
    expect(sectionOf('/')).toBe('overview')
    expect(sectionOf('/models')).toBe('models')
    expect(sectionOf('/models/m/versions')).toBe('models')
    expect(sectionOf('/models/m/live')).toBe('models')
    expect(sectionOf('/versions/7/scenarios')).toBe('models')
    expect(sectionOf('/scenarios/5')).toBe('models')
    expect(sectionOf('/alerts')).toBe('alerts')
    expect(sectionOf('/gauge-twin')).toBe('gauge')
    expect(sectionOf('/gauge-twin/machine_001')).toBe('gauge')
    // Lần chạy thuộc về mô hình (không còn mục riêng trên thanh chính)
    expect(sectionOf('/runs')).toBe('models')
    expect(sectionOf('/runs/12/report')).toBe('models')
    expect(sectionOf('/compare')).toBe('models')
    expect(sectionOf('/library/materials/RAW-01')).toBe('library')
  })
})

describe('tabsFor', () => {
  it('gives the model workspace tabs', () => {
    const tabs = tabsFor('/versions/7', { modelKey: 'm', versionId: 7 })
    expect(tabs.map((t) => t.label)).toEqual(['Sơ đồ', 'Phiên bản', 'Scenario', 'Lần chạy', 'Trực tiếp', 'Nguồn dữ liệu', 'Kết nối dữ liệu', 'Bản đồ AGV'])
    expect(tabs.map((t) => t.to)).toEqual([
      '/versions/7', '/models/m/versions', '/versions/7/scenarios', '/versions/7/runs',
      '/models/m/live', '/models/m/sources', '/models/m/connect', '/models/m/map',
    ])
  })

  it('gom tab thành ba nhóm liền nhau: Thiết kế, Mô phỏng, Vận hành thật', () => {
    const tabs = tabsFor('/versions/7', { modelKey: 'm', versionId: 7 })
    expect(tabs.map((t) => t.group)).toEqual(['Thiết kế', 'Thiết kế', 'Mô phỏng', 'Mô phỏng', 'Vận hành thật', 'Vận hành thật', 'Vận hành thật', 'Vận hành thật'])
    expect(groupTabs(tabs).map((g) => [g.title, g.tabs.length])).toEqual([['Thiết kế', 2], ['Mô phỏng', 2], ['Vận hành thật', 4]])
  })

  it('opens the latest version from the versions page', () => {
    const tabs = tabsFor('/models/m/versions', { modelKey: 'm', latestVersionId: 9 })
    expect(tabs[0].to).toBe('/versions/9')
    expect(tabsFor('/models/m/versions', { modelKey: 'm' }).map((t) => t.label)).toEqual(['Phiên bản', 'Trực tiếp', 'Nguồn dữ liệu', 'Kết nối dữ liệu', 'Bản đồ AGV'])
  })

  it('shows the model workspace on the live pages, with the model taken from the URL context', () => {
    for (const path of ['/models/m/live', '/models/m/sources', '/models/m/connect', '/models/m/map']) {
      const tabs = tabsFor(path, { modelKey: 'm', latestVersionId: 9 })
      expect(tabs.map((t) => t.label)).toContain('Trực tiếp')
      expect(tabs[0].to).toBe('/versions/9')
      expect(tabs.filter((t) => isTabActive(t, path)).map((t) => t.label)).toHaveLength(1)
    }
    expect(isTabActive(tabsFor('/models/m/sources', { modelKey: 'm' }).find((t) => t.label === 'Nguồn dữ liệu')!, '/models/m/sources')).toBe(true)
    expect(isTabActive(tabsFor('/models/m/connect', { modelKey: 'm' }).find((t) => t.label === 'Kết nối dữ liệu')!, '/models/m/connect')).toBe(true)
  })

  it('gives the model tabs on run pages and none elsewhere', () => {
    expect(tabsFor('/runs/12/report', { modelKey: 'm', versionId: 7 }).map((t) => t.label)).toContain('Lần chạy')
    expect(tabsFor('/models', {})).toEqual([])
    expect(tabsFor('/library/node-types', {})).toEqual([])
  })

  it('encodes model keys in the versions link', () => {
    expect(tabsFor('/versions/1', { modelKey: 'a b', versionId: 1 })[1].to).toBe('/models/a%20b/versions')
    expect(tabsFor('/versions/1', { modelKey: 'a b', versionId: 1 })[4].to).toBe('/models/a%20b/live')
  })
})

describe('isTabActive', () => {
  const tabs = tabsFor('/scenarios/5', { modelKey: 'm', versionId: 7 })
  it('keeps the diagram tab exact and scenario tab broad', () => {
    expect(isTabActive(tabs[0], '/versions/7')).toBe(true)
    expect(isTabActive(tabs[0], '/versions/7/scenarios')).toBe(false)
    expect(isTabActive(tabs[2], '/versions/7/scenarios/new')).toBe(true)
    expect(isTabActive(tabs[2], '/scenarios/5')).toBe(true)
    expect(isTabActive(tabs[2], '/versions/7')).toBe(false)
  })
})

describe('crumbsFor', () => {
  it('names the live pages under the model', () => {
    expect(crumbsFor('/models/m/live', { modelKey: 'm' }).map((c) => c.label)).toEqual(['Mô hình', 'm', 'Trực tiếp'])
    expect(crumbsFor('/models/m/sources', { modelKey: 'm' }).map((c) => c.label)).toEqual(['Mô hình', 'm', 'Nguồn dữ liệu'])
    expect(crumbsFor('/models/m/connect', { modelKey: 'm' }).map((c) => c.label)).toEqual(['Mô hình', 'm', 'Kết nối dữ liệu'])
    expect(crumbsFor('/models/m/map', { modelKey: 'm' }).map((c) => c.label)).toEqual(['Mô hình', 'm', 'Bản đồ AGV'])
  })

  it('builds crumbs for top-level pages', () => {
    expect(crumbsFor('/', {}).map((c) => c.label)).toEqual(['Tổng quan'])
    expect(crumbsFor('/alerts', {}).map((c) => c.label)).toEqual(['Cảnh báo'])
    expect(crumbsFor('/models', {}).map((c) => c.label)).toEqual(['Mô hình'])
    expect(crumbsFor('/compare', {}).map((c) => c.label)).toEqual(['Lần chạy', 'So sánh'])
  })

  it('names the gauge pages', () => {
    expect(crumbsFor('/gauge-twin', {})).toEqual([{ label: 'Đồng hồ' }])
    expect(crumbsFor('/gauge-twin/machine_001', {})).toEqual([{ label: 'Đồng hồ', to: '/gauge-twin' }, { label: 'machine_001' }])
    expect(crumbsFor('/gauge-twin/cameras', {}).map((c) => c.label)).toEqual(['Đồng hồ', 'Camera'])
    expect(crumbsFor('/gauge-twin/cameras/cam-a', {})).toEqual([
      { label: 'Đồng hồ', to: '/gauge-twin' }, { label: 'Camera', to: '/gauge-twin/cameras' }, { label: 'cam-a' },
    ])
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
    expect(c.map((x) => x.label)).toEqual(['m', 'v2', 'Máy dập 3 hỏng', 'Lần chạy #12'])
  })

  it('builds library crumbs', () => {
    expect(crumbsFor('/library/node-types', {}).map((c) => c.label)).toEqual(['Thư viện', 'Loại node'])
    expect(crumbsFor('/library/materials/RAW-01', {}).map((c) => c.label)).toEqual(['Thư viện', 'Vật tư', 'RAW-01'])
    expect(crumbsFor('/library/node-types/new', {}).map((c) => c.label)).toEqual(['Thư viện', 'Loại node', 'Tạo mới'])
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

describe('subNavFor (panel phụ cạnh thanh chính)', () => {
  it('mô hình: ba nhóm Thiết kế, Mô phỏng, Vận hành thật; mỗi mục có biểu tượng; tiêu đề là tên mô hình', () => {
    const n = subNavFor('/versions/7', { modelKey: 'm', versionId: 7, version: 2 })!
    expect(n.title).toBe('m')
    expect(n.groups.map((g) => g.title)).toEqual(['Thiết kế', 'Mô phỏng', 'Vận hành thật'])
    expect(n.groups.flatMap((g) => g.tabs).every((t) => !!t.icon)).toBe(true)
  })
  it('lần chạy: panel phụ là điều hướng của mô hình, mục Lần chạy sáng; tab của lần chạy không nằm ở đây', () => {
    const n = subNavFor('/runs/12/sensors', { modelKey: 'm', versionId: 7 })!
    expect(n.groups.map((g) => g.title)).toEqual(['Thiết kế', 'Mô phỏng', 'Vận hành thật'])
    const active = n.groups.flatMap((g) => g.tabs).filter((t) => isTabActive(t, '/runs/12/sensors')).map((t) => t.label)
    expect(active).toEqual(['Lần chạy'])
  })
  it('lần chạy đang tải (chưa biết mô hình) vẫn giữ chỗ panel phụ', () => {
    expect(subNavFor('/runs/12', {})).toEqual({ title: '…', groups: [] })
  })
  it('tab của một lần chạy: so với gốc chỉ có khi có lần chạy gốc, đề xuất mang số lượng', () => {
    expect(runTabs(12).map((t) => t.label)).toEqual(['Control Room', 'Cảm biến', 'Đề xuất', 'Báo cáo'])
    const tabs = runTabs(12, { recommendations: 3, compare: true })
    expect(tabs.map((t) => t.to)).toEqual(['/runs/12', '/runs/12/sensors', '/runs/12/recommendations', '/runs/12/compare', '/runs/12/report'])
    expect(tabs[2].count).toBe(3)
    expect(isTabActive(tabs[0], '/runs/12')).toBe(true)
    expect(isTabActive(tabs[0], '/runs/12/report')).toBe(false)
  })
  it('khu đồng hồ: Trạm sáng ở mọi trang trạm, Camera sáng ở trang camera', () => {
    const tabs = subNavFor('/gauge-twin', {})!.groups[0].tabs
    const on = (p: string) => tabs.filter((t) => isTabActive(t, p)).map((t) => t.label)
    expect(on('/gauge-twin')).toEqual(['Trạm'])
    expect(on('/gauge-twin/machine_001/history')).toEqual(['Trạm'])
    expect(on('/gauge-twin/cameras/cam-1')).toEqual(['Camera'])
  })
  it('thư viện có panel phụ riêng', () => {
    const n = subNavFor('/library/materials/RAW-01', {})!
    expect(n.title).toBe('Thư viện')
    expect(n.icon).toBe('library')
    expect(n.groups[0].tabs.map((t) => t.label)).toEqual(['Loại node', 'Vật tư'])
    expect(isTabActive(n.groups[0].tabs[1], '/library/materials/RAW-01')).toBe(true)
  })
  it('trang danh sách cấp cao không có panel phụ', () => {
    for (const p of ['/', '/models', '/alerts', '/runs', '/compare']) expect(subNavFor(p, {})).toBeNull()
  })
})

describe('isCanvasPath (trang sơ đồ: panel phụ ẩn để sơ đồ rộng nhất)', () => {
  it('sơ đồ, trực tiếp, bản đồ AGV, Control Room là trang sơ đồ; trang khác thì không', () => {
    for (const p of ['/versions/7', '/models/m/live', '/models/m/map', '/runs/12']) expect(isCanvasPath(p)).toBe(true)
    for (const p of ['/versions/7/scenarios', '/models/m/connect', '/models/m/versions', '/runs/12/report', '/library/node-types', '/models']) expect(isCanvasPath(p)).toBe(false)
  })
})
