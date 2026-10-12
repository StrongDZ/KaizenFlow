export type Section = 'overview' | 'models' | 'assets' | 'alerts' | 'gauge' | 'library'
export type Crumb = { label: string; to?: string; picker?: boolean }
/** `icon`: tên biểu tượng (vẽ ở components/shell/SubNav). */
export type Tab = { label: string; to: string; end?: boolean; also?: string[]; not?: string[]; group?: string; icon?: string }
export type NavCtx = {
  modelKey?: string
  version?: number
  versionId?: number
  latestVersionId?: number
  versions?: { id: number; version: number; status: string }[]
  scenarioName?: string
  scenarioId?: number
}

export function sectionOf(path: string): Section {
  if (path.startsWith('/alerts')) return 'alerts'
  if (path.startsWith('/assets')) return 'assets'
  if (path.startsWith('/gauge-twin')) return 'gauge'
  if (isOverviewPath(path)) return 'overview'
  // Lần chạy (và so sánh lần chạy) luôn thuộc một mô hình: không có mục riêng trên thanh chính.
  if (path.startsWith('/runs/') || path.startsWith('/compare')) return 'models'
  if (path.startsWith('/library')) return 'library'
  if (path.startsWith('/models') || path.startsWith('/versions') || path.startsWith('/scenarios')) return 'models'
  return 'overview'
}

/** Trang của một mô hình nằm dưới /models/:key/… (ngoài sơ đồ, phiên bản, scenario, lần chạy có đường dẫn riêng). */
export const MODEL_PAGES = {
  versions: 'Phiên bản', live: 'Trực tiếp', stock: 'Điều khiển kho', map: 'Bản đồ AGV', sources: 'Nguồn dữ liệu', connect: 'Kết nối dữ liệu',
  operations: 'Dashboard vận hành', 'warehouse-report': 'Báo cáo kho',
} as const
const MODEL_PAGE_RE = new RegExp(`^/models/[^/]+/(${Object.keys(MODEL_PAGES).join('|')})(?:/|$)`)

/** Trang cấp nhà máy (nhiều mô hình): mục Tổng quan, chỉ một trang. */
const isOverviewPath = (path: string) => path === '/'

const inModelWorkspace = (path: string) => /^\/(versions|scenarios)\//.test(path) || MODEL_PAGE_RE.test(path) || /^\/runs\/\d+/.test(path) || path === '/compare'

export function tabsFor(path: string, ctx: NavCtx): Tab[] {
  // Lần chạy thuộc mục "Lần chạy" của mô hình: panel phụ vẫn là điều hướng mô hình; tab của chính lần chạy nằm ở đầu trang (runTabs).
  if (!inModelWorkspace(path)) return []
  return modelTabs(ctx)
}

/** Tab trong một lần chạy, theo thứ tự người dùng đi: xem diễn biến, xem cảm biến, xem đề xuất, so với lần chạy gốc (nếu có), báo cáo. */
export function runTabs(runId: number, opts: { recommendations?: number; compare?: boolean } = {}): (Tab & { count?: number })[] {
  const base = `/runs/${runId}`
  const tabs: (Tab & { count?: number })[] = [
    { label: 'Control Room', to: base, end: true },
    { label: 'Cảm biến', to: `${base}/sensors` },
    { label: 'Đề xuất', to: `${base}/recommendations`, count: opts.recommendations || undefined },
  ]
  if (opts.compare) tabs.push({ label: 'So với lần chạy gốc', to: `${base}/compare` })
  tabs.push({ label: 'Báo cáo', to: `${base}/report` })
  return tabs
}

function modelTabs(ctx: NavCtx): Tab[] {
  // Bốn nhóm theo việc người dùng đang làm: dựng mô hình, chạy thử trên mô phỏng, vận hành với dữ liệu thật, xem báo cáo.
  const design: Tab[] = []
  const simulate: Tab[] = []
  const operate: Tab[] = []
  const report: Tab[] = []
  const vid = ctx.versionId ?? ctx.latestVersionId
  const base = ctx.modelKey ? `/models/${encodeURIComponent(ctx.modelKey)}` : undefined
  if (vid !== undefined) design.push({ label: 'Sơ đồ', to: `/versions/${vid}`, end: true, group: 'Thiết kế', icon: 'diagram' })
  if (base) design.push({ label: 'Phiên bản', to: `${base}/versions`, group: 'Thiết kế', icon: 'history' })
  if (vid !== undefined) {
    simulate.push(
      { label: 'Scenario', to: `/versions/${vid}/scenarios`, also: ['/scenarios/'], group: 'Mô phỏng', icon: 'flask' },
      { label: 'Lần chạy', to: `/versions/${vid}/runs`, also: ['/runs/', '/compare'], group: 'Mô phỏng', icon: 'play' },
    )
  }
  if (base) {
    // Xem trước (sơ đồ, kho, xe), thiết lập nguồn và ghép tín hiệu sau.
    operate.push(
      { label: 'Trực tiếp', to: `${base}/live`, group: 'Vận hành thật', icon: 'radio' },
      { label: 'Điều khiển kho', to: `${base}/stock`, group: 'Vận hành thật', icon: 'boxes' },
      { label: 'Bản đồ AGV', to: `${base}/map`, group: 'Vận hành thật', icon: 'map' },
      { label: 'Nguồn dữ liệu', to: `${base}/sources`, group: 'Vận hành thật', icon: 'database' },
      { label: 'Kết nối dữ liệu', to: `${base}/connect`, group: 'Vận hành thật', icon: 'plug' },
    )
    report.push(
      { label: 'Dashboard vận hành', to: `${base}/operations`, group: 'Báo cáo', icon: 'monitor' },
      { label: 'Báo cáo kho', to: `${base}/warehouse-report`, group: 'Báo cáo', icon: 'warehouse' },
    )
  }
  return [...design, ...simulate, ...operate, ...report]
}

/** `icon`: biểu tượng ở đầu panel (overview: tổng quan, library: thư viện, gauge: đồng hồ, còn lại là mô hình). */
export type SubNav = { title: string; subtitle?: string; icon?: 'overview' | 'library' | 'gauge' | 'assets'; groups: { title: string | undefined; tabs: Tab[] }[] }

/** Mục Thiết bị: danh mục thiết bị thật của nhà máy và tín hiệu của chúng — ngang hàng với Mô hình,
 *  vì một thiết bị không thuộc mô hình nào mà dùng được ở nhiều mô hình. */
const ASSET_TABS: Tab[] = [
  { label: 'Danh mục thiết bị', to: '/assets', end: true, icon: 'cpu' },
  { label: 'Tín hiệu thiết bị', to: '/assets/signals', icon: 'plug' },
]

const GAUGE_TABS: Tab[] = [
  { label: 'Trạm', to: '/gauge-twin', not: ['/gauge-twin/cameras', '/gauge-twin/gauges'], icon: 'gauge' },
  { label: 'Danh mục đồng hồ', to: '/gauge-twin/gauges', icon: 'scan' },
  { label: 'Camera', to: '/gauge-twin/cameras', icon: 'camera' },
]

const LIBRARY_TABS: Tab[] = [
  { label: 'Loại node', to: '/library/node-types', icon: 'shapes' },
  { label: 'Vật tư', to: '/library/materials', icon: 'package' },
]

/**
 * Nội dung panel phụ (đặt cạnh thanh chính): mọi trang của một mục đều nằm ở đây (Tổng quan, một mô hình, khu đồng hồ, thư viện),
 * không trang nào chỉ vào được qua nút trong trang khác. Trang lần chạy dùng đúng điều hướng của mô hình (mục Lần chạy sáng);
 * tab của chính lần chạy nằm ở dải tab đầu trang. Danh sách mô hình và Cảnh báo là một trang duy nhất nên không có panel phụ.
 */
export function subNavFor(path: string, ctx: NavCtx): SubNav | null {
  if (path.startsWith('/assets')) return { title: 'Thiết bị', icon: 'assets', groups: [{ title: undefined, tabs: ASSET_TABS }] }
  if (path.startsWith('/library')) return { title: 'Thư viện', icon: 'library', groups: [{ title: undefined, tabs: LIBRARY_TABS }] }
  if (path.startsWith('/gauge-twin')) return { title: 'Đồng hồ', icon: 'gauge', groups: [{ title: undefined, tabs: GAUGE_TABS }] }
  const tabs = tabsFor(path, ctx)
  // Lần chạy hay trang so sánh mà chưa biết thuộc mô hình nào (đang tải): giữ chỗ panel để bố cục không giật khi dữ liệu về.
  if (tabs.length === 0 && (/^\/runs\/\d+/.test(path) || path === '/compare')) return { title: '…', groups: [] }
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
  if (tab.not?.some((p) => path.startsWith(p))) return false
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
  if (path === '/gauge-twin/gauges') return [{ label: 'Đồng hồ', to: '/gauge-twin' }, { label: 'Danh mục đồng hồ' }]
  const gauge = path.match(/^\/gauge-twin(?:\/([^/]+))?/)
  if (gauge) {
    if (!gauge[1]) return [{ label: 'Đồng hồ' }]
    return [{ label: 'Đồng hồ', to: '/gauge-twin' }, { label: decodeURIComponent(gauge[1]) }]
  }
  if (path === '/models') return [{ label: 'Mô hình' }]
  const page = path.match(MODEL_PAGE_RE)?.[1] as keyof typeof MODEL_PAGES | undefined
  if (page) {
    // Trang Phiên bản chính là nơi tên mô hình dẫn tới: không tự dẫn về chính nó.
    return [{ label: 'Mô hình', to: '/models' }, { label: model ?? '…', to: page === 'versions' ? undefined : modelTo }, { label: MODEL_PAGES[page] }]
  }
  if (/^\/(versions|scenarios)\//.test(path)) {
    const out: Crumb[] = [{ label: 'Mô hình', to: '/models' }, { label: model ?? '…', to: modelTo }]
    if (ver) out.push({ label: ver, picker: true })
    if (path.startsWith('/scenarios/') && ctx.scenarioName) out.push({ label: ctx.scenarioName })
    return out
  }
  if (path === '/compare') {
    const out: Crumb[] = [{ label: 'Mô hình', to: '/models' }, { label: model ?? '…', to: modelTo }]
    if (ctx.versionId !== undefined) out.push({ label: 'Lần chạy', to: `/versions/${ctx.versionId}/runs` })
    out.push({ label: 'So sánh' })
    return out
  }
  const run = path.match(/^\/runs\/(\d+)/)
  if (run) {
    const out: Crumb[] = []
    if (model) out.push({ label: model, to: modelTo })
    if (ver) out.push({ label: ver, to: ctx.versionId !== undefined ? `/versions/${ctx.versionId}` : undefined })
    if (ctx.scenarioName) out.push({ label: ctx.scenarioName, to: ctx.scenarioId !== undefined ? `/scenarios/${ctx.scenarioId}` : undefined })
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
