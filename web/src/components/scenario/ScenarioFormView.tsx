import { BookmarkPlus, Boxes, Clock3, Gauge, Save, Trash2, TriangleAlert, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Graph, NodeType, ScenarioBody } from '../../api/types'
import { formProblems, formToScenarioBody, type ScenarioForm } from '../../lib/scenarioForm'
import { affectedNodeNames, applyScenarioTemplate, scenarioTemplates, type ScenarioTemplateKey } from '../../lib/scenarioExperience'
import { failureModeOptionsOf, failureModesOf, poolCount } from '../../lib/model'
import { FULL_DETAIL_MAX_HORIZON_S, formatScenarioDuration, scenarioWarmupSeconds, startStateLabel } from '../../lib/scenarioView'
import { Card, ErrorBox, Notice, btn, btnLinkDanger, btnPrimary, input } from '../ui'
import { ScenarioTimeline } from './ScenarioTimeline'

const HORIZON_PRESETS = [1, 4, 8, 24]
const REP_PRESETS = [
  { value: 5, label: 'Thử nhanh' },
  { value: 20, label: 'Khuyến nghị' },
  { value: 50, label: 'Tin cậy cao' },
]

type SavedPreset = { id: string; name: string; form: ScenarioForm }

const TEMPLATE_ICON = {
  baseline: Gauge,
  failure: TriangleAlert,
  maintenance: Wrench,
  resource: Boxes,
} as const

export function ScenarioFormView({ graph, types, initial, submitLabel, pending, error, cancelTo, onSubmit, onSubmitAndRun }: {
  graph: Graph
  types: Record<string, NodeType>
  initial: ScenarioForm
  submitLabel: string
  pending: boolean
  error: unknown
  cancelTo: string
  onSubmit: (body: ScenarioBody) => void
  onSubmitAndRun?: (body: ScenarioBody) => void
}) {
  const [f, setF] = useState<ScenarioForm>(initial)
  const presetKey = `kaizenflow:scenario-presets:v1:${graph.version_id}`
  const [savedPresets, setSavedPresets] = useState<SavedPreset[]>(() => {
    try {
      const raw = localStorage.getItem(presetKey)
      return raw ? JSON.parse(raw) as SavedPreset[] : []
    } catch { return [] }
  })
  const set = (patch: Partial<ScenarioForm>) => setF({ ...f, ...patch })
  const faultable = graph.nodes.filter((n) => failureModesOf(n, types).length > 0)
  const processes = graph.nodes.filter((n) => n.archetype === 'PROCESS')
  const pools = graph.nodes.filter((n) => n.archetype === 'RESOURCE_POOL')
  const label = 'flex flex-col gap-1 text-muted'
  const hint = 'text-[10.5px] text-faint'
  // Tên hiển thị của máy/đội (kèm khoá để phân biệt các máy cùng loại), thay cho khoá trần như STAMP_2.
  const nameOf = (n: { key: string; name?: string; node_type: string }) => {
    const shown = n.name || types[n.node_type]?.name || n.key
    return shown === n.key ? n.key : `${shown} (${n.key})`
  }
  const failureLabel = (target: string, code: string) => {
    const node = graph.nodes.find((item) => item.key === target)
    return node ? failureModeOptionsOf(node, types).find((mode) => mode.code === code)?.label ?? code : code
  }
  const problems = formProblems(f)
  const horizonS = f.hours * 3600
  const warmupS = scenarioWarmupSeconds(f.start, graph.settings)
  const totalPerReplicationS = horizonS + warmupS
  const workloadHours = totalPerReplicationS / 3600 * f.reps
  const timelineEvents = f.inj.map((row) => ({
    atS: row.at_min * 60,
    label: row.target || 'Chưa chọn máy',
    detail: row.kind === 'planned_stop'
      ? `Dừng có kế hoạch trong ${formatScenarioDuration(row.duration_min * 60)}`
      : row.failure ? `Lỗi ${failureLabel(row.target, row.failure)}` : 'Chưa chọn loại lỗi',
    kind: row.kind,
    durationS: row.kind === 'planned_stop' ? row.duration_min * 60 : undefined,
  }))
  const fullDetail = horizonS <= FULL_DETAIL_MAX_HORIZON_S
  const templates = scenarioTemplates(graph, types)
  const affected = useMemo(() => affectedNodeNames(graph, f.inj.map((row) => row.target).filter(Boolean)), [graph, f.inj])
  const persistPresets = (rows: SavedPreset[]) => {
    setSavedPresets(rows)
    localStorage.setItem(presetKey, JSON.stringify(rows))
  }
  const savePreset = () => {
    const name = f.name.trim() || `Preset ${savedPresets.length + 1}`
    persistPresets([{ id: `${Date.now()}`, name, form: f }, ...savedPresets].slice(0, 12))
  }
  const presetClass = (active: boolean) => `rounded-lg border px-2.5 py-1.5 text-[11px] font-medium ${
    active ? 'border-accent bg-accent/10 text-accent' : 'border-line-2 text-muted hover:text-text'
  }`
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-line bg-panel p-4">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-text">Bạn muốn kiểm chứng tình huống nào?</h2>
            <p className="mt-1 text-[11px] text-muted">Chọn một mẫu để tự điền cấu hình hợp lệ; mọi tham số vẫn có thể chỉnh ở bên dưới.</p>
          </div>
          <button type="button" className={btn} onClick={savePreset}><BookmarkPlus size={13} /> Lưu cấu hình hiện tại</button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {templates.map((template) => {
            const Icon = TEMPLATE_ICON[template.key]
            return (
              <button
                type="button" key={template.key} disabled={!template.available}
                onClick={() => setF(applyScenarioTemplate(template.key as ScenarioTemplateKey, f, graph, types))}
                className="group rounded-xl border border-line-2 bg-panel/80 p-3 text-left transition hover:-translate-y-0.5 hover:border-accent/60 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-panel-2 text-accent group-hover:bg-accent group-hover:text-on-accent"><Icon size={16} /></span>
                <span className="block text-xs font-semibold text-text">{template.title}</span>
                <span className="mt-1 block text-[10.5px] leading-4 text-muted">{template.description}</span>
              </button>
            )
          })}
        </div>
        {savedPresets.length > 0 && (
          <div className="mt-3 border-t border-line pt-3">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold text-muted"><Save size={11} /> Preset của bạn</div>
            <div className="flex flex-wrap gap-2">
              {savedPresets.map((preset) => (
                <span key={preset.id} className="inline-flex overflow-hidden rounded-lg border border-line-2 bg-panel">
                  <button type="button" className="px-2.5 py-1.5 text-[11px] text-text-2 hover:bg-panel-2 hover:text-text" onClick={() => setF(preset.form)}>{preset.name}</button>
                  <button type="button" aria-label={`Xoá preset ${preset.name}`} className="border-l border-line px-2 text-muted hover:text-bad-text" onClick={() => persistPresets(savedPresets.filter((item) => item.id !== preset.id))}><Trash2 size={11} /></button>
                </span>
              ))}
            </div>
          </div>
        )}
      </section>
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
                {!fullDetail && (
                  <div role="note" className="rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-[11px] text-text-2">
                    Trên 12 giờ, backend chỉ tổng hợp KPI và forecast bands; Recommendation, sensor replay và raw events sẽ bị tắt.
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <div className="font-medium text-text">Độ tin cậy Monte Carlo</div>
                <div className="flex flex-wrap gap-1.5">
                  {REP_PRESETS.map((p) => (
                    <button type="button" key={p.value} className={presetClass(f.reps === p.value)} onClick={() => set({ reps: p.value })}>{p.label} · {p.value}</button>
                  ))}
                </div>
                <label className={label}>Tuỳ chỉnh số lần lặp
                  <input type="number" min={1} max={200} step={1} className={`${input} w-32`} value={f.reps} onChange={(e) => set({ reps: Number(e.target.value) })} />
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
          <ScenarioTimeline horizonS={horizonS} events={timelineEvents} startLabel={startStateLabel(f.start)} />
        </Card>

        <Card title="3. Sự kiện">
          <div className="space-y-3">
            {f.inj.map((row, i) => {
              const choices = row.kind === 'planned_stop' ? processes : faultable
              const node = choices.find((n) => n.key === row.target)
              const failureModes = node ? failureModeOptionsOf(node, types) : []
              const selectedFailure = failureModes.find((mode) => mode.code === row.failure)
              const upd = (patch: Partial<typeof row>) => set({ inj: f.inj.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
              const maxMin = Math.max(0, Math.ceil(f.hours * 60) - 1)
              return (
                <div key={i} className="rounded-lg border border-line bg-panel-2 p-3 text-xs">
                  <div className="mb-3 flex items-center justify-between">
                    <b className="text-text">Sự kiện #{i + 1}</b>
                    <button type="button" className={btnLinkDanger} aria-label="Bỏ dòng này" onClick={() => set({ inj: f.inj.filter((_, j) => j !== i) })}>Bỏ sự kiện</button>
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                    <label className={label}>Loại sự kiện
                      <select className={input} value={row.kind} onChange={(e) => {
                        const kind = e.target.value as typeof row.kind
                        const available = kind === 'planned_stop' ? processes : faultable
                        const target = available.some((n) => n.key === row.target) ? row.target : available[0]?.key ?? ''
                        const selected = available.find((n) => n.key === target)
                        upd({ kind, target, failure: kind === 'failure' && selected ? failureModesOf(selected, types)[0] ?? '' : '' })
                      }}>
                        <option value="failure">Lỗi máy</option>
                        <option value="planned_stop">Dừng có kế hoạch</option>
                      </select>
                    </label>
                    <label className={label}>Máy
                      <select className={input} value={row.target} onChange={(e) => {
                        const target = e.target.value
                        const selected = choices.find((item) => item.key === target)
                        upd({ target, failure: row.kind === 'failure' && selected ? failureModesOf(selected, types)[0] ?? '' : '' })
                      }}>
                        {choices.map((n) => <option key={n.key} value={n.key}>{nameOf(n)}</option>)}
                      </select>
                    </label>
                    {row.kind === 'failure' ? (
                      <label className={label}>Loại lỗi
                        <select className={input} value={row.failure} onChange={(e) => upd({ failure: e.target.value })}>
                          <option value="">Chọn lỗi</option>
                          {failureModes.map((mode) => <option key={mode.code} value={mode.code}>{mode.label === mode.code ? mode.code : `${mode.label} (${mode.code})`}</option>)}
                        </select>
                        {selectedFailure?.description && <span className={hint}>{selectedFailure.description}</span>}
                      </label>
                    ) : (
                      <label className={label}>Thời gian dừng (phút)
                        <input type="number" min={1} className={input} value={row.duration_min} onChange={(e) => upd({ duration_min: Number(e.target.value) })} />
                      </label>
                    )}
                  </div>
                  <div className="mt-3 grid items-end gap-3 md:grid-cols-[110px_1fr]">
                    <label className={label}>Xảy ra ở phút
                      <input type="number" min={0} max={maxMin} className={input} value={row.at_min} onChange={(e) => upd({ at_min: Number(e.target.value) })} />
                    </label>
                    <label className={label}>Vị trí trên timeline
                      <input type="range" min={0} max={maxMin} step={1} value={Math.min(maxMin, Math.max(0, row.at_min))} onChange={(e) => upd({ at_min: Number(e.target.value) })} />
                      <span className={hint}>{Math.round(row.at_min)} / {maxMin} phút · phải trước khi scenario kết thúc</span>
                    </label>
                  </div>
                </div>
              )
            })}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btn} disabled={faultable.length === 0}
                onClick={() => set({ inj: [...f.inj, { target: faultable[0].key, kind: 'failure', failure: failureModesOf(faultable[0], types)[0] ?? '', at_min: Math.max(1, Math.min(60, Math.round(f.hours * 30))), duration_min: 30 }] })}>
                + Thêm lỗi máy
              </button>
              <button type="button" className={btn} disabled={processes.length === 0}
                onClick={() => set({ inj: [...f.inj, { target: processes[0].key, kind: 'planned_stop', failure: '', at_min: Math.max(1, Math.min(60, Math.round(f.hours * 30))), duration_min: 30 }] })}>
                + Thêm dừng có kế hoạch
              </button>
            </div>
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
                    <input type="number" min={1} step={1} className={input} value={row.count} onChange={(e) => upd({ count: Number(e.target.value) })} />
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
        {(f.inj.length > 0 || f.ovr.length > 0) && (
          <Card title="Phạm vi tác động dự kiến">
            <div className="space-y-3 text-[11px]">
              {f.inj.map((event, index) => (
                <div key={`${event.target}-${index}`} className="flex gap-2">
                  <span className="flex h-6 w-6 flex-none items-center justify-center rounded-md bg-warn/10 text-warn"><Clock3 size={12} /></span>
                  <div><b className="text-text">Phút {event.at_min}: {event.target}</b><div className="text-muted">{event.kind === 'planned_stop' ? `Bảo trì ${event.duration_min} phút` : `Lỗi ${event.failure ? failureLabel(event.target, event.failure) : 'chưa chọn'}`}</div></div>
                </div>
              ))}
              {affected.length > 0 && (
                <div className="border-t border-line pt-2">
                  <div className="mb-1 text-muted">Luồng có thể bị ảnh hưởng:</div>
                  <div className="flex flex-wrap gap-1">{affected.map((node) => <span key={node.key} className="rounded-md bg-panel-2 px-2 py-1 font-medium text-text-2">{node.name || node.key}</span>)}</div>
                  <p className="mt-2 text-[10px] leading-4 text-faint">Phạm vi này đi theo các cạnh downstream từ máy có sự kiện; kết quả thực tế sẽ được engine mô phỏng.</p>
                </div>
              )}
              {f.ovr.map((override) => <div key={override.target} className="rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-text-2">{override.target}: đặt nguồn lực thành <b>{override.count}</b></div>)}
            </div>
          </Card>
        )}
        <Card title="Tóm tắt trước khi lưu">
          <dl className="space-y-2 text-xs">
            <div className="flex justify-between gap-3"><dt className="text-muted">Thời lượng</dt><dd className="font-medium text-text">{formatScenarioDuration(horizonS)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Warm-up ngoài KPI</dt><dd className="font-medium text-text">{warmupS > 0 ? formatScenarioDuration(warmupS) : 'Không dùng'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Tổng mỗi lần chạy</dt><dd className="font-medium text-text">{formatScenarioDuration(totalPerReplicationS)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Lần lặp</dt><dd className="font-medium text-text">{f.reps}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Lỗi máy</dt><dd className="font-medium text-text">{f.inj.filter((i) => i.kind === 'failure').length}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Dừng kế hoạch</dt><dd className="font-medium text-text">{f.inj.filter((i) => i.kind === 'planned_stop').length}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Đổi nguồn lực</dt><dd className="font-medium text-text">{f.ovr.length + f.extra.length}</dd></div>
            <div className="border-t border-line pt-2 text-muted">
              Khối lượng mô phỏng: <b className="text-text-2">{Number.isFinite(workloadHours) ? workloadHours.toLocaleString('vi-VN') : '—'} giờ</b> ({f.reps} × {formatScenarioDuration(totalPerReplicationS)}, gồm warm-up). Đây không phải thời gian chờ thực tế.
            </div>
            <div className="border-t border-line pt-2">
              <div className={fullDetail ? 'text-ok-solid' : 'text-muted'}>{fullDetail ? '✓' : '—'} Recommendation</div>
              <div className={fullDetail ? 'text-ok-solid' : 'text-muted'}>{fullDetail ? '✓' : '—'} Sensor replay và raw events</div>
              <div className="text-ok-solid">✓ KPI tổng hợp và forecast bands</div>
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
          {onSubmitAndRun && (
            <button className={btnPrimary} disabled={pending || problems.length > 0 || graph.status !== 'PUBLISHED'} onClick={() => onSubmitAndRun(formToScenarioBody(f))}>
              Tạo và chạy ngay
            </button>
          )}
          <button className={onSubmitAndRun ? btn : btnPrimary} disabled={pending || problems.length > 0} onClick={() => onSubmit(formToScenarioBody(f))}>{submitLabel}</button>
          <Link className={btn} to={cancelTo}>Huỷ</Link>
        </div>
        {onSubmitAndRun && graph.status !== 'PUBLISHED' && <p className="text-[11px] text-muted">Cần Publish mô hình trước khi có thể tạo và chạy ngay; bạn vẫn có thể lưu scenario.</p>}
      </aside>
      </div>
    </div>
  )
}
