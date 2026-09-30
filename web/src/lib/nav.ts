export type Section = 'overview' | 'models' | 'runs' | 'library'
export type Crumb = { label: string; to?: string; picker?: boolean }
export type Tab = { label: string; to: string; end?: boolean; also?: string[] }
export type NavCtx = {
  modelKey?: string
  version?: number
  versionId?: number
  latestVersionId?: number
  versions?: { id: number; version: number; status: string }[]
  scenarioName?: string
}

export function sectionOf(path: string): Section {
  if (path.startsWith('/runs') || path.startsWith('/compare')) return 'runs'
  if (path.startsWith('/library')) return 'library'
  if (path.startsWith('/models') || path.startsWith('/versions') || path.startsWith('/scenarios')) return 'models'
  return 'overview'
}

const inModelWorkspace = (path: string) => /^\/(versions|scenarios)\//.test(path) || /^\/models\/[^/]+\/(versions|live|sources|connect|map)/.test(path)

export function tabsFor(path: string, ctx: NavCtx): Tab[] {
  const run = path.match(/^\/runs\/(\d+)/)
  if (run) {
    const base = `/runs/${run[1]}`
    return [
      { label: 'Control Room', to: base, end: true },
      { label: 'Cảm biến', to: `${base}/sensors` },
      { label: 'Đề xuất', to: `${base}/recommendations` },
      { label: 'Báo cáo', to: `${base}/report` },
    ]
  }
  if (!inModelWorkspace(path)) return []
  const tabs: Tab[] = []
  const vid = ctx.versionId ?? ctx.latestVersionId
  if (vid !== undefined) {
    tabs.push(
      { label: 'Sơ đồ', to: `/versions/${vid}`, end: true },
      { label: 'Scenario', to: `/versions/${vid}/scenarios`, also: ['/scenarios/'] },
      { label: 'Lần chạy', to: `/versions/${vid}/runs` },
    )
  }
  if (ctx.modelKey) {
    const base = `/models/${encodeURIComponent(ctx.modelKey)}`
    tabs.push(
      { label: 'Phiên bản', to: `${base}/versions` },
      { label: 'Trực tiếp', to: `${base}/live` },
      { label: 'Nguồn dữ liệu', to: `${base}/sources` },
      { label: 'Kết nối dữ liệu', to: `${base}/connect` },
      { label: 'Bản đồ AGV', to: `${base}/map` },
    )
  }
  return tabs
}

export function isTabActive(tab: Tab, path: string): boolean {
  if (tab.also?.some((p) => path.startsWith(p))) return true
  if (path === tab.to) return true
  return !tab.end && path.startsWith(tab.to + '/')
}

export function crumbsFor(path: string, ctx: NavCtx): Crumb[] {
  const model = ctx.modelKey
  const ver = ctx.version !== undefined ? `v${ctx.version}` : undefined
  const modelTo = model ? `/models/${encodeURIComponent(model)}/versions` : undefined

  if (path === '/') return [{ label: 'Tổng quan' }]
  if (path === '/models') return [{ label: 'Mô hình' }]
  if (/^\/models\/[^/]+\/versions/.test(path)) {
    return [{ label: 'Mô hình', to: '/models' }, { label: model ?? '…' }, { label: 'Phiên bản' }]
  }
  const live = path.match(/^\/models\/[^/]+\/(live|sources|connect|map)/)
  if (live) {
    const label = { live: 'Trực tiếp', sources: 'Nguồn dữ liệu', connect: 'Kết nối dữ liệu', map: 'Bản đồ AGV' }[live[1] as 'live' | 'sources' | 'connect' | 'map']
    return [{ label: 'Mô hình', to: '/models' }, { label: model ?? '…', to: modelTo }, { label }]
  }
  if (/^\/(versions|scenarios)\//.test(path)) {
    const out: Crumb[] = [{ label: 'Mô hình', to: '/models' }, { label: model ?? '…', to: modelTo }]
    if (ver) out.push({ label: ver, picker: true })
    if (path.startsWith('/scenarios/') && ctx.scenarioName) out.push({ label: ctx.scenarioName })
    return out
  }
  if (path === '/runs') return [{ label: 'Lần chạy' }]
  if (path === '/compare') return [{ label: 'Lần chạy', to: '/runs' }, { label: 'So sánh' }]
  const run = path.match(/^\/runs\/(\d+)/)
  if (run) {
    const out: Crumb[] = []
    if (model) out.push({ label: model, to: modelTo })
    if (ver) out.push({ label: ver })
    if (ctx.scenarioName) out.push({ label: ctx.scenarioName })
    out.push({ label: `Lần chạy #${run[1]}` })
    return out
  }
  const lib = path.match(/^\/library\/(node-types|materials)(?:\/([^/]+))?/)
  if (lib) {
    const kind = lib[1] === 'node-types' ? 'Loại node' : 'Vật tư'
    const list = `/library/${lib[1]}`
    const out: Crumb[] = [{ label: 'Thư viện', to: list }, { label: kind, to: lib[2] ? list : undefined }]
    if (lib[2]) out.push({ label: lib[2] === 'new' ? 'Tạo mới' : decodeURIComponent(lib[2]) })
    return out
  }
  return []
}

export function switchVersionPath(path: string, versionId: number): string {
  const sub = path.match(/^\/versions\/\d+\/(scenarios|runs)/)
  if (sub) return `/versions/${versionId}/${sub[1]}`
  if (path.startsWith('/scenarios/')) return `/versions/${versionId}/scenarios`
  return `/versions/${versionId}`
}
