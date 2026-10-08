export type Section = 'overview' | 'models' | 'alerts' | 'gauge' | 'library'
export type Crumb = { label: string; to?: string; picker?: boolean }
/** `icon`: tên biểu tượng (vẽ ở components/shell/SubNav). */
export type Tab = { label: string; to: string; end?: boolean; also?: string[]; group?: string; icon?: string }
export type NavCtx = {
  modelKey?: string
  version?: number
  versionId?: number
  latestVersionId?: number
  versions?: { id: number; version: number; status: string }[]
  scenarioName?: string
}

export function sectionOf(path: string): Section {
  if (path.startsWith('/alerts')) return 'alerts'
  if (path.startsWith('/gauge-twin')) return 'gauge'
  if (path.startsWith('/reports')) return 'overview'
  // Lần chạy luôn thuộc một mô hình: không có mục riêng trên thanh chính.
  if (path.startsWith('/runs') || path.startsWith('/compare')) return 'models'
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
      { label: 'Control Room', to: base, end: true, icon: 'monitor' },
      { label: 'Cảm biến', to: `${base}/sensors`, icon: 'activity' },
      { label: 'Đề xuất', to: `${base}/recommendations`, icon: 'lightbulb' },
      { label: 'Báo cáo', to: `${base}/report`, icon: 'file' },
    ]
  }
  if (!inModelWorkspace(path)) return []
  return modelTabs(ctx)
}

function modelTabs(ctx: NavCtx): Tab[] {
  // Ba nhóm theo việc người dùng đang làm: dựng mô hình, chạy thử trên mô phỏng, vận hành với dữ liệu thật.
  const design: Tab[] = []
  const simulate: Tab[] = []
  const operate: Tab[] = []
  const vid = ctx.versionId ?? ctx.latestVersionId
  const base = ctx.modelKey ? `/models/${encodeURIComponent(ctx.modelKey)}` : undefined
  if (vid !== undefined) design.push({ label: 'Sơ đồ', to: `/versions/${vid}`, end: true, group: 'Thiết kế', icon: 'diagram' })
  if (base) design.push({ label: 'Phiên bản', to: `${base}/versions`, group: 'Thiết kế', icon: 'history' })
  if (vid !== undefined) {
    simulate.push(
      { label: 'Scenario', to: `/versions/${vid}/scenarios`, also: ['/scenarios/'], group: 'Mô phỏng', icon: 'flask' },
      { label: 'Lần chạy', to: `/versions/${vid}/runs`, group: 'Mô phỏng', icon: 'play' },
    )
  }
  if (base) {
    operate.push(
      { label: 'Trực tiếp', to: `${base}/live`, group: 'Vận hành thật', icon: 'radio' },
      { label: 'Nguồn dữ liệu', to: `${base}/sources`, group: 'Vận hành thật', icon: 'database' },
      { label: 'Kết nối dữ liệu', to: `${base}/connect`, group: 'Vận hành thật', icon: 'plug' },
      { label: 'Bản đồ AGV', to: `${base}/map`, group: 'Vận hành thật', icon: 'map' },
    )
  }
  return [...design, ...simulate, ...operate]
}

/** `icon`: biểu tượng ở đầu panel (library: thư viện, còn lại là mô hình). */
export type SubNav = { title: string; subtitle?: string; icon?: 'library'; groups: { title: string | undefined; tabs: Tab[] }[] }

const LIBRARY_TABS: Tab[] = [
  { label: 'Loại node', to: '/library/node-types', icon: 'shapes' },
  { label: 'Vật tư', to: '/library/materials', icon: 'package' },
]

/**
 * Nội dung panel phụ (đặt cạnh thanh chính): điều hướng bên trong một mô hình, một lần chạy hay thư viện.
 * Trang lần chạy có nhóm của lần chạy lên đầu và vẫn giữ các nhóm của mô hình để quay lại được. Trang cấp cao (danh sách) trả null.
 */
export function subNavFor(path: string, ctx: NavCtx): SubNav | null {
  if (path.startsWith('/library')) return { title: 'Thư viện', icon: 'library', groups: [{ title: undefined, tabs: LIBRARY_TABS }] }
  const run = path.match(/^\/runs\/(\d+)/)
  if (run) {
    const runGroup = { title: `Lần chạy #${run[1]}`, tabs: tabsFor(path, ctx) }
    const model = ctx.modelKey ? groupTabs(modelTabs(ctx)) : []
    return { title: ctx.modelKey ?? `Lần chạy #${run[1]}`, subtitle: ctx.version !== undefined ? `v${ctx.version}` : undefined, groups: [runGroup, ...model] }
  }
  const tabs = tabsFor(path, ctx)
  if (tabs.length === 0) return null
  const subtitle = ctx.version !== undefined ? `v${ctx.version}` : ctx.versions?.length ? `${ctx.versions.length} phiên bản` : undefined
  return { title: ctx.modelKey ?? '…', subtitle, groups: groupTabs(tabs) }
}

/** Trang có sơ đồ hay bản đồ lấp đầy màn hình: panel phụ ẩn đi (mở nổi khi cần) để chỗ cho sơ đồ. */
export function isCanvasPath(path: string): boolean {
  return /^\/versions\/\d+\/?$/.test(path) || /^\/models\/[^/]+\/(live|map)\/?$/.test(path) || /^\/runs\/\d+\/?$/.test(path)
}

/** Tab liền nhau cùng nhóm thì gộp lại (để vẽ chung một khung và một nhãn nhóm). Tab không có nhóm thành một nhóm không tên. */
export function groupTabs(tabs: Tab[]): { title: string | undefined; tabs: Tab[] }[] {
  const out: { title: string | undefined; tabs: Tab[] }[] = []
  for (const t of tabs) {
    const last = out[out.length - 1]
    if (last && last.title === t.group) last.tabs.push(t)
    else out.push({ title: t.group, tabs: [t] })
  }
  return out
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
  if (path === '/alerts') return [{ label: 'Cảnh báo' }]
  const camera = path.match(/^\/gauge-twin\/cameras(?:\/([^/]+))?/)
  if (camera) {
    const out: Crumb[] = [{ label: 'Đồng hồ', to: '/gauge-twin' }, { label: 'Camera', to: camera[1] ? '/gauge-twin/cameras' : undefined }]
    if (camera[1]) out.push({ label: decodeURIComponent(camera[1]) })
    return out
  }
  const gauge = path.match(/^\/gauge-twin(?:\/([^/]+))?/)
  if (gauge) {
    if (!gauge[1]) return [{ label: 'Đồng hồ' }]
    return [{ label: 'Đồng hồ', to: '/gauge-twin' }, { label: decodeURIComponent(gauge[1]) }]
  }
  if (path === '/reports/benchmarks') return [{ label: 'Tổng quan', to: '/' }, { label: 'Benchmark FMCG' }]
  if (path === '/reports/operations') return [{ label: 'Tổng quan', to: '/' }, { label: 'Dashboard vận hành' }]
  if (path === '/reports/warehouse') return [{ label: 'Tổng quan', to: '/' }, { label: 'Điều khiển kho' }]
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
