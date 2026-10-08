/** Danh sách "Thiết lập" của một mô hình: các bước từ vật tư đến chạy trực tiếp, bước nào đã xong dựa trên dữ liệu thật, bước kế tiếp là gì. */

export type SetupInput = {
  model: string
  materials: number
  /** Theo thứ tự cũ đến mới (như API trả về). */
  versions: { id: number; status: string; nodes: number }[]
  /** undefined: chưa biết (đang tải hoặc không hỏi được). */
  sources: number | undefined
  coverage: { source: number; derived: number; signals: number; liveReady: boolean } | undefined
  hasMap: boolean | undefined
  /** Trạng thái feed của CHÍNH mô hình này (mỗi mô hình có feed riêng, chạy song song với mô hình khác). */
  feed: { state: string } | undefined
}

export type SetupStep = { key: string; title: string; detail: string; done: boolean; optional?: boolean; to: string; cta: string }

export function setupSteps(i: SetupInput): SetupStep[] {
  const base = `/models/${encodeURIComponent(i.model)}`
  const latest = i.versions[i.versions.length - 1]
  const published = [...i.versions].reverse().find((v) => v.status === 'PUBLISHED')
  const draft = [...i.versions].reverse().find((v) => v.status === 'DRAFT')
  const unknown = '…'
  const running = i.feed?.state === 'running'
  return [
    {
      key: 'materials', title: 'Vật tư', done: i.materials > 0, to: '/library/materials', cta: 'Mở Thư viện vật tư',
      detail: i.materials > 0 ? `Thư viện có ${i.materials} vật tư.` : 'Thư viện chưa có vật tư nào. Tạo vật tư trước khi dựng sơ đồ.',
    },
    {
      key: 'diagram', title: 'Sơ đồ', done: (latest?.nodes ?? 0) > 0, to: latest ? `/versions/${latest.id}` : `${base}/versions`, cta: 'Mở sơ đồ',
      detail: (latest?.nodes ?? 0) > 0 ? `Phiên bản mới nhất có ${latest!.nodes} node.` : 'Sơ đồ còn trống: kéo node từ danh sách loại node vào và nối lại.',
    },
    {
      key: 'publish', title: 'Publish', done: !!published, to: `/versions/${(draft ?? latest)?.id ?? ''}`, cta: 'Mở sơ đồ để Publish',
      detail: published ? `Đã có phiên bản Publish (v${i.versions.indexOf(published) + 1}).` : 'Chưa Publish. Chạy mô phỏng và màn Trực tiếp cần một phiên bản đã Publish.',
    },
    {
      key: 'sources', title: 'Nguồn dữ liệu', done: (i.sources ?? 0) > 0, to: `${base}/sources`, cta: 'Mở Nguồn dữ liệu',
      detail: i.sources === undefined ? unknown : i.sources > 0 ? `${i.sources} nguồn đã đăng ký.` : 'Chưa có nguồn nào. Bật feed ở màn Trực tiếp hoặc thêm nguồn bằng tay.',
    },
    {
      key: 'bindings', title: 'Kết nối dữ liệu', done: i.coverage?.liveReady === true, to: `${base}/connect`, cta: 'Mở Kết nối dữ liệu',
      detail: !i.coverage ? unknown : i.coverage.liveReady
        ? `Đã có ${i.coverage.source + i.coverage.derived}/${i.coverage.signals} tín hiệu, đủ để chạy Live.`
        : `Đã có ${i.coverage.source + i.coverage.derived}/${i.coverage.signals} tín hiệu, chưa đủ để chạy Live. Ghép thêm hoặc dùng tự tính.`,
    },
    {
      key: 'map', title: 'Bản đồ AGV', done: i.hasMap === true, optional: true, to: `${base}/map`, cta: 'Mở Bản đồ AGV',
      detail: i.hasMap === undefined ? unknown : i.hasMap ? 'Đã có bản đồ.' : 'Tuỳ chọn: vẽ bản đồ nếu sơ đồ có xe chở hàng (AGV, xe kéo).',
    },
    {
      key: 'live', title: 'Chạy trực tiếp', done: running, to: `${base}/live`, cta: 'Mở màn Trực tiếp',
      detail: !i.feed ? unknown : running ? 'Feed đang phát cho mô hình này.' : i.feed.state === 'paused' ? 'Feed của mô hình này đang tạm dừng. Bấm "Tiếp tục" ở màn Trực tiếp.' : 'Chưa phát dữ liệu. Bấm "Bắt đầu phát dữ liệu giả lập" ở màn Trực tiếp.',
    },
  ]
}

/** Bước kế tiếp cần làm: bước bắt buộc đầu tiên chưa xong. */
export function nextStep(steps: SetupStep[]): SetupStep | undefined {
  return steps.find((s) => !s.done && !s.optional)
}
