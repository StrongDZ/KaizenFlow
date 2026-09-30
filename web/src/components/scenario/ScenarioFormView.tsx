import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { Graph, NodeType, ScenarioBody } from '../../api/types'
import { formToScenarioBody, type ScenarioForm } from '../../lib/scenarioForm'
import { failureModesOf, poolCount } from '../../lib/model'
import { Card, ErrorBox, btn, btnLinkDanger, btnPrimary, input } from '../ui'

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
  return (
    <>
      <Card title="Thông số chung">
        <div className="grid grid-cols-4 gap-3 text-xs">
          <label className={label}>Tên<input className={input} value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
          <label className={label}>Thời lượng (giờ)<input type="number" min={0.25} step={0.25} className={input} value={f.hours} onChange={(e) => set({ hours: Number(e.target.value) })} /></label>
          <label className={label}>Số lần lặp Monte Carlo<input type="number" min={1} max={200} className={input} value={f.reps} onChange={(e) => set({ reps: Number(e.target.value) })} /></label>
          <label className={label}>Khởi đầu
            <select className={input} value={f.start} onChange={(e) => set({ start: e.target.value })}>
              <option value="WARMUP">Làm nóng rồi mới ghi</option>
              <option value="EMPTY">Nhà máy rỗng</option>
              {f.start === 'LIVE_SNAPSHOT' && <option value="LIVE_SNAPSHOT">Từ ảnh chụp trực tiếp</option>}
            </select>
          </label>
        </div>
      </Card>

      <Card title="Tiêm lỗi (thời điểm máy hỏng)">
        <div className="space-y-2">
          {f.inj.map((row, i) => {
            const node = faultable.find((n) => n.key === row.target)
            const upd = (patch: Partial<typeof row>) => set({ inj: f.inj.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
            return (
              <div key={i} className="flex items-center gap-2 text-xs">
                <select className={input} aria-label="Máy" value={row.target} onChange={(e) => upd({ target: e.target.value, failure: '' })}>
                  {faultable.map((n) => <option key={n.key} value={n.key}>{n.key}</option>)}
                </select>
                <select className={input} aria-label="Loại lỗi" value={row.failure} onChange={(e) => upd({ failure: e.target.value })}>
                  <option value="">Chọn lỗi</option>
                  {node && failureModesOf(node, types).map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <label className="flex items-center gap-1 text-muted">hỏng ở phút
                  <input type="number" min={0} className={`${input} w-24`} value={row.at_min} onChange={(e) => upd({ at_min: Number(e.target.value) })} />
                </label>
                <button className={btnLinkDanger} aria-label="Bỏ dòng này" onClick={() => set({ inj: f.inj.filter((_, j) => j !== i) })}>Bỏ</button>
              </div>
            )
          })}
          <button className={btn} disabled={faultable.length === 0}
            onClick={() => set({ inj: [...f.inj, { target: faultable[0].key, failure: failureModesOf(faultable[0], types)[0] ?? '', at_min: 60 }] })}>
            Thêm lỗi
          </button>
          {faultable.length === 0 && <p className="text-xs text-muted">Mô hình chưa có máy nào khai báo chế độ hỏng.</p>}
        </div>
      </Card>

      <Card title="Thay đổi nguồn lực">
        <div className="space-y-2">
          {f.ovr.map((row, i) => {
            const upd = (patch: Partial<typeof row>) => set({ ovr: f.ovr.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
            return (
              <div key={i} className="flex items-center gap-2 text-xs">
                <select className={input} aria-label="Đội" value={row.target} onChange={(e) => upd({ target: e.target.value })}>
                  {pools.map((p) => <option key={p.key} value={p.key}>{p.key} (hiện {poolCount(p, types)})</option>)}
                </select>
                <label className="flex items-center gap-1 text-muted">số lượng
                  <input type="number" min={1} className={`${input} w-20`} value={row.count} onChange={(e) => upd({ count: Number(e.target.value) })} />
                </label>
                <button className={btnLinkDanger} aria-label="Bỏ dòng này" onClick={() => set({ ovr: f.ovr.filter((_, j) => j !== i) })}>Bỏ</button>
              </div>
            )
          })}
          <button className={btn} disabled={pools.length === 0}
            onClick={() => set({ ovr: [...f.ovr, { target: pools[0].key, count: poolCount(pools[0], types) + 1 }] })}>
            Thêm thay đổi
          </button>
          {f.extra.length > 0 && (
            <p className="text-[11px] text-muted">Giữ nguyên {f.extra.length} thay đổi khác (do đề xuất tạo) mà form này chưa sửa được.</p>
          )}
        </div>
      </Card>

      <ErrorBox error={error} />
      <div className="flex items-center gap-2">
        <button className={btnPrimary} disabled={pending || !f.name.trim() || f.hours <= 0} onClick={() => onSubmit(formToScenarioBody(f))}>{submitLabel}</button>
        <Link className={btn} to={cancelTo}>Huỷ</Link>
      </div>
    </>
  )
}
