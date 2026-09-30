import { Plus, X } from 'lucide-react'
import type { Json } from '../../api/types'
import { EFFECT_LABEL, newFailureMode, withEffect, withoutEffect } from '../../lib/sensorsEdit'
import { DistInput } from '../DistInput'
import { btn, input } from '../ui'

/**
 * Các chế độ hỏng của một loại node: mã, khi nào bắt đầu suy giảm, bao lâu từ suy giảm đến hỏng, suy giảm làm cảm biến nào lệch ra sao,
 * và sửa mất bao lâu. Hỏng thì máy dừng (DOWN). `sensors` là tên các cảm biến hiện có để chọn.
 */
export function FailureModesEditor({ value, onChange, sensors, disabled }: { value: Json[]; onChange: (v: Json[]) => void; sensors: string[]; disabled?: boolean }) {
  const set = (i: number, m: Json) => onChange(value.map((x, j) => (j === i ? m : x)))
  return (
    <div className="space-y-3 text-xs">
      {value.length === 0 && <p className="text-muted">Loại này chưa có chế độ hỏng. Thêm chế độ hỏng để mô phỏng máy xuống cấp rồi hỏng (vd. mòn bạc đạn).</p>}
      {value.map((m, i) => {
        const effects = Array.isArray(m.effects) ? (m.effects as Json[]) : []
        const onFail = (m.on_fail ?? {}) as Json
        return (
          <div key={i} className="space-y-3 rounded-lg border border-line p-3">
            <div className="flex items-end gap-2">
              <label className="flex-1 space-y-0.5 text-muted">Mã chế độ hỏng
                <input className={`${input} w-full font-mono`} value={String(m.code ?? '')} placeholder="bearing_wear" disabled={disabled} onChange={(e) => set(i, { ...m, code: e.target.value })} />
              </label>
              <button type="button" aria-label="Xoá chế độ hỏng này" disabled={disabled} className="pb-1.5 text-muted hover:text-bad-text" onClick={() => onChange(value.filter((_, j) => j !== i))}><X size={15} /></button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-0.5 text-muted"><span className="block">Bắt đầu suy giảm sau</span>
                <DistInput value={m.onset} onChange={(v) => set(i, { ...m, onset: v })} label="Bắt đầu suy giảm" disabled={disabled} />
              </div>
              <div className="space-y-0.5 text-muted"><span className="block">Từ suy giảm đến hỏng</span>
                <DistInput value={m.p_to_f} onChange={(v) => set(i, { ...m, p_to_f: v })} label="Từ suy giảm đến hỏng" disabled={disabled} />
              </div>
            </div>
            <div className="space-y-1.5">
              <span className="block text-muted">Suy giảm làm cảm biến lệch thế nào</span>
              {effects.map((e, k) => (
                <div key={k} className="grid grid-cols-[1fr_1.4fr_90px_auto] items-center gap-2">
                  <select className={input} aria-label="Cảm biến bị ảnh hưởng" value={String(e.signal ?? '')} disabled={disabled}
                    onChange={(ev) => set(i, { ...m, effects: effects.map((x, j) => (j === k ? { ...x, signal: ev.target.value } : x)) })}>
                    {!sensors.includes(String(e.signal ?? '')) && <option value={String(e.signal ?? '')}>{String(e.signal ?? '') || 'Chọn cảm biến'} (không có trong danh sách)</option>}
                    {sensors.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <select className={input} aria-label="Kiểu ảnh hưởng" value={String(e.kind ?? '')} disabled={disabled}
                    onChange={(ev) => set(i, { ...m, effects: effects.map((x, j) => (j === k ? { ...x, kind: ev.target.value } : x)) })}>
                    {!(String(e.kind ?? '') in EFFECT_LABEL) && <option value={String(e.kind ?? '')}>{String(e.kind ?? '')} (không hợp lệ)</option>}
                    {Object.entries(EFFECT_LABEL).map(([k2, label]) => <option key={k2} value={k2}>{label}</option>)}
                  </select>
                  <input className={`${input} w-full`} type="number" step="any" disabled={disabled}
                    aria-label={'delta' in e ? 'Mức tuyệt đối' : 'Mức (số lần độ lệch chuẩn)'} title={'delta' in e ? 'Mức tuyệt đối (cùng đơn vị cảm biến)' : 'Mức, tính bằng số lần độ lệch chuẩn của cảm biến'}
                    value={typeof ('delta' in e ? e.delta : e.mag_sd) === 'number' ? Number('delta' in e ? e.delta : e.mag_sd) : ''}
                    onChange={(ev) => {
                      const n = ev.target.value === '' ? undefined : Number(ev.target.value)
                      set(i, { ...m, effects: effects.map((x, j) => (j === k ? { ...x, ['delta' in e ? 'delta' : 'mag_sd']: n } : x)) })
                    }} />
                  <button type="button" aria-label="Bỏ ảnh hưởng này" disabled={disabled} className="text-muted hover:text-bad-text" onClick={() => set(i, withoutEffect(m, k))}><X size={14} /></button>
                </div>
              ))}
              <button type="button" className={btn} disabled={disabled || sensors.length === 0} onClick={() => set(i, withEffect(m, sensors[0]))}><Plus size={12} /> Thêm ảnh hưởng</button>
              {sensors.length === 0 && <p className="text-faint">Thêm cảm biến ở phần trên trước, rồi chọn cảm biến bị ảnh hưởng ở đây.</p>}
            </div>
            <div className="space-y-0.5 text-muted"><span className="block">Khi hỏng máy dừng. Sửa mất</span>
              <DistInput value={onFail.mttr} onChange={(v) => set(i, { ...m, on_fail: { ...onFail, state: onFail.state ?? 'DOWN', mttr: v } })} label="Thời gian sửa" disabled={disabled} />
            </div>
          </div>
        )
      })}
      <button type="button" className={btn} disabled={disabled} onClick={() => onChange([...value, newFailureMode()])}><Plus size={12} /> Thêm chế độ hỏng</button>
    </div>
  )
}
