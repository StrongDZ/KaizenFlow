import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { Graph, NodeType, ScenarioBody } from '../../api/types'
import { formProblems, formToScenarioBody, type ScenarioForm } from '../../lib/scenarioForm'
import { failureModesOf, poolCount } from '../../lib/model'
import { formatScenarioDuration } from '../../lib/scenarioView'
import { Card, ErrorBox, Notice, btn, btnLinkDanger, btnPrimary, input } from '../ui'
import { ScenarioTimeline } from './ScenarioTimeline'

const HORIZON_PRESETS = [1, 4, 8, 24]
const REP_PRESETS = [
  { value: 5, label: 'Thử nhanh' },
  { value: 20, label: 'Khuyến nghị' },
  { value: 50, label: 'Tin cậy cao' },
]
const START_LABEL: Record<string, string> = {
  WARMUP: 'Làm nóng rồi mới ghi',
  EMPTY: 'Nhà máy rỗng',
  LIVE_SNAPSHOT: 'Từ ảnh chụp trực tiếp',
}

export function ScenarioFormView({ graph, types, initial, submitLabel, pending, error, cancelTo, onSubmit }: {
  graph: Graph
  types: Record<string, NodeType>
  initial: ScenarioForm
  submitLabel: string
  pending: boolean
  error: unknown
  cancelTo: string
  onSubmit: (body: ScenarioBody) => void
}) {
  const [f, setF] = useState<ScenarioForm>(initial)
  const set = (patch: Partial<ScenarioForm>) => setF({ ...f, ...patch })
  const faultable = graph.nodes.filter((n) => failureModesOf(n, types).length > 0)
  const pools = graph.nodes.filter((n) => n.archetype === 'RESOURCE_POOL')
  const label = 'flex flex-col gap-1 text-muted'
  const hint = 'text-[10.5px] text-faint'
  // Tên hiển thị của máy/đội (kèm khoá để phân biệt các máy cùng loại), thay cho khoá trần như STAMP_2.
  const nameOf = (n: { key: string; name?: string; node_type: string }) => {
    const shown = n.name || types[n.node_type]?.name || n.key
    return shown === n.key ? n.key : `${shown} (${n.key})`
  }
  const problems = formProblems(f)
  const horizonS = f.hours * 3600
  const workloadHours = f.hours * f.reps
  const timelineEvents = f.inj.map((row) => ({
    atS: row.at_min * 60,
    label: row.target || 'Chưa chọn máy',
    detail: row.failure ? `Lỗi ${row.failure}` : 'Chưa chọn loại lỗi',
  }))
  const presetClass = (active: boolean) => `rounded-lg border px-2.5 py-1.5 text-[11px] font-medium ${
    active ? 'border-accent bg-accent/10 text-accent' : 'border-line-2 text-muted hover:text-text'
  }`
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="space-y-4">
        <Card title="1. Thiết lập mô phỏng">
          <div className="space-y-5 text-xs">
            <label className={label}>Tên scenario
              <input className={input} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Ví dụ: Máy dập 3 hỏng ở giờ thứ 2" />
              <span className={hint}>Đặt tên theo tình huống và thời điểm để dễ tìm trong danh sách run.</span>
            </label>
            <div className="grid gap-5 md:grid-cols-2">
              <div className="space-y-2">
                <div className="font-medium text-text">Thời lượng mô phỏng</div>
                <div className="flex flex-wrap gap-1.5">
                  {HORIZON_PRESETS.map((hours) => (
                    <button type="button" key={hours} className={presetClass(f.hours === hours)} onClick={() => set({ hours })}>{hours} giờ</button>
                  ))}
                </div>
                <label className={label}>Tuỳ chỉnh (giờ)
                  <input type="number" min={0.25} step={0.25} className={`${input} w-32`} value={f.hours} onChange={(e) => set({ hours: Number(e.target.value) })} />
                  <span className={hint}>Horizon càng dài càng thấy được tác động dây chuyền, nhưng thời gian chạy tăng.</span>
                </label>
              </div>
              <div className="space-y-2">
                <div className="font-medium text-text">Độ tin cậy Monte Carlo</div>
                <div className="flex flex-wrap gap-1.5">
                  {REP_PRESETS.map((p) => (
                    <button type="button" key={p.value} className={presetClass(f.reps === p.value)} onClick={() => set({ reps: p.value })}>{p.label} · {p.value}</button>
                  ))}
                </div>
                <label className={label}>Tuỳ chỉnh số lần lặp
                  <input type="number" min={1} max={200} className={`${input} w-32`} value={f.reps} onChange={(e) => set({ reps: Number(e.target.value) })} />
                  <span className={hint}>5 để kiểm tra nhanh; 20 cho demo; 50+ khi cần dải kết quả ổn định hơn.</span>
                </label>
              </div>
            </div>
            <label className={label}>Trạng thái khởi đầu
              <select className={`${input} max-w-sm`} value={f.start} onChange={(e) => set({ start: e.target.value })}>
                <option value="WARMUP">Làm nóng rồi mới ghi — phù hợp đánh giá vận hành ổn định</option>
                <option value="EMPTY">Nhà máy rỗng — quan sát quá trình khởi động</option>
                {f.start === 'LIVE_SNAPSHOT' && <option value="LIVE_SNAPSHOT">Từ ảnh chụp trực tiếp</option>}
              </select>
            </label>
          </div>
        </Card>

        <Card title="2. Timeline scenario">
          <ScenarioTimeline horizonS={horizonS} events={timelineEvents} startLabel={START_LABEL[f.start] ?? f.start} />
        </Card>

        <Card title="3. Sự kiện lỗi">
          <div className="space-y-3">
            {f.inj.map((row, i) => {
              const node = faultable.find((n) => n.key === row.target)
              const upd = (patch: Partial<typeof row>) => set({ inj: f.inj.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
              const maxMin = Math.max(0, Math.round(f.hours * 60))
              return (
                <div key={i} className="rounded-lg border border-line bg-panel-2 p-3 text-xs">
                  <div className="mb-3 flex items-center justify-between">
                    <b className="text-text">Lỗi #{i + 1}</b>
                    <button type="button" className={btnLinkDanger} aria-label="Bỏ dòng này" onClick={() => set({ inj: f.inj.filter((_, j) => j !== i) })}>Bỏ lỗi</button>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className={label}>Máy
                      <select className={input} value={row.target} onChange={(e) => upd({ target: e.target.value, failure: '' })}>
                        {faultable.map((n) => <option key={n.key} value={n.key}>{nameOf(n)}</option>)}
                      </select>
                    </label>
                    <label className={label}>Loại lỗi
                      <select className={input} value={row.failure} onChange={(e) => upd({ failure: e.target.value })}>
                        <option value="">Chọn lỗi</option>
                        {node && failureModesOf(node, types).map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </label>
                  </div>
                  <div className="mt-3 grid items-end gap-3 md:grid-cols-[110px_1fr]">
                    <label className={label}>Xảy ra ở phút
                      <input type="number" min={0} max={maxMin} className={input} value={row.at_min} onChange={(e) => upd({ at_min: Number(e.target.value) })} />
                    </label>
                    <label className={label}>Vị trí trên timeline
                      <input type="range" min={0} max={maxMin} step={1} value={Math.min(maxMin, Math.max(0, row.at_min))} onChange={(e) => upd({ at_min: Number(e.target.value) })} />
                      <span className={hint}>{Math.round(row.at_min)} / {maxMin} phút</span>
                    </label>
                  </div>
                </div>
              )
            })}
            <button type="button" className={btn} disabled={faultable.length === 0}
              onClick={() => set({ inj: [...f.inj, { target: faultable[0].key, failure: failureModesOf(faultable[0], types)[0] ?? '', at_min: Math.max(1, Math.min(60, Math.round(f.hours * 30))) }] })}>
              + Thêm sự kiện lỗi
            </button>
            {faultable.length === 0 && <p className="text-xs text-muted">Mô hình chưa có máy nào khai báo chế độ hỏng.</p>}
          </div>
        </Card>

        <Card title="4. Thay đổi nguồn lực">
          <div className="space-y-3">
            {f.ovr.map((row, i) => {
              const upd = (patch: Partial<typeof row>) => set({ ovr: f.ovr.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
              return (
                <div key={i} className="grid items-end gap-3 rounded-lg border border-line bg-panel-2 p-3 text-xs md:grid-cols-[1fr_120px_auto]">
                  <label className={label}>Đội nguồn lực
                    <select className={input} value={row.target} onChange={(e) => upd({ target: e.target.value })}>
                      {pools.map((p) => <option key={p.key} value={p.key}>{nameOf(p)}, hiện {poolCount(p, types)}</option>)}
                    </select>
                  </label>
                  <label className={label}>Số lượng mới
                    <input type="number" min={1} className={input} value={row.count} onChange={(e) => upd({ count: Number(e.target.value) })} />
                  </label>
                  <button type="button" className={btnLinkDanger} aria-label="Bỏ dòng này" onClick={() => set({ ovr: f.ovr.filter((_, j) => j !== i) })}>Bỏ thay đổi</button>
                </div>
              )
            })}
            <button type="button" className={btn} disabled={pools.length === 0}
              onClick={() => set({ ovr: [...f.ovr, { target: pools[0].key, count: poolCount(pools[0], types) + 1 }] })}>
              + Thêm thay đổi nguồn lực
            </button>
            {f.extra.length > 0 && <p className="text-[11px] text-muted">Giữ nguyên {f.extra.length} thay đổi khác do đề xuất tạo mà form này chưa chỉnh trực tiếp được.</p>}
          </div>
        </Card>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-14">
        <Card title="Tóm tắt trước khi lưu">
          <dl className="space-y-2 text-xs">
            <div className="flex justify-between gap-3"><dt className="text-muted">Thời lượng</dt><dd className="font-medium text-text">{formatScenarioDuration(horizonS)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Lần lặp</dt><dd className="font-medium text-text">{f.reps}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Sự kiện lỗi</dt><dd className="font-medium text-text">{f.inj.length}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Đổi nguồn lực</dt><dd className="font-medium text-text">{f.ovr.length + f.extra.length}</dd></div>
            <div className="border-t border-line pt-2 text-muted">
              Khối lượng lấy mẫu: <b className="text-text-2">{Number.isFinite(workloadHours) ? workloadHours.toLocaleString('vi-VN') : '—'} giờ mô phỏng</b> ({f.reps} × {formatScenarioDuration(horizonS)}). Đây không phải thời gian chờ thực tế.
            </div>
          </dl>
        </Card>
        {problems.length > 0 && (
          <Notice tone="lock">
            <div className="font-medium">Cần sửa trước khi lưu:</div>
            <ul className="mt-1 list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </Notice>
        )}
        <ErrorBox error={error} />
        <div className="flex flex-wrap items-center gap-2">
          <button className={btnPrimary} disabled={pending || problems.length > 0} onClick={() => onSubmit(formToScenarioBody(f))}>{submitLabel}</button>
          <Link className={btn} to={cancelTo}>Huỷ</Link>
        </div>
      </aside>
    </div>
  )
}
