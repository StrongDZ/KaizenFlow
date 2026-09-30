import { Plus, X } from 'lucide-react'
import type { Json } from '../../api/types'
import { newSignal } from '../../lib/sensorsEdit'
import { SENSOR_UNITS } from '../../lib/units'
import { DistInput } from '../DistInput'
import { UnitSelect } from '../UnitSelect'
import { btn, input } from '../ui'

/** Bảng cảm biến của một loại node: mỗi dòng là một tín hiệu máy phát ra (tên, đơn vị, tần số lấy mẫu, giá trị nền). Giữ nguyên các trường lạ khi lưu. */
export function SignalsEditor({ value, onChange, disabled }: { value: Json[]; onChange: (v: Json[]) => void; disabled?: boolean }) {
  const set = (i: number, patch: Json) => onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  return (
    <div className="space-y-2 text-xs">
      {value.length === 0 && <p className="text-muted">Loại này chưa có cảm biến. Thêm cảm biến để tạo dữ liệu cho bảo trì dự đoán (vd. độ rung của máy dập).</p>}
      {value.map((s, i) => (
        <div key={i} className="space-y-2 rounded-lg border border-line p-3">
          <div className="grid grid-cols-[1fr_140px_110px_auto] items-end gap-2">
            <label className="space-y-0.5 text-muted">Tên tín hiệu
              <input className={`${input} w-full`} value={String(s.name ?? '')} placeholder="vibration" disabled={disabled} onChange={(e) => set(i, { name: e.target.value })} />
            </label>
            <div className="space-y-0.5 text-muted"><span className="block">Đơn vị</span>
              <UnitSelect value={String(s.unit ?? '')} used={value.map((x) => String(x.unit ?? ''))} presets={SENSOR_UNITS} onChange={(u) => set(i, { unit: u })} disabled={disabled} label="Đơn vị cảm biến" />
            </div>
            <label className="space-y-0.5 text-muted">Lấy mẫu (Hz)
              <input className={`${input} w-full`} type="number" min={0} step="any" value={typeof s.hz === 'number' ? s.hz : ''} disabled={disabled}
                onChange={(e) => set(i, { hz: e.target.value === '' ? undefined : Number(e.target.value) })} />
            </label>
            <button type="button" aria-label="Xoá cảm biến này" disabled={disabled} className="pb-1.5 text-muted hover:text-bad-text" onClick={() => onChange(value.filter((_, j) => j !== i))}><X size={15} /></button>
          </div>
          <div className="space-y-0.5 text-muted"><span className="block">Giá trị nền (lúc máy còn tốt)</span>
            <DistInput value={s.base} onChange={(b) => set(i, { base: b })} unit={String(s.unit ?? '')} label="Giá trị nền" disabled={disabled} />
          </div>
        </div>
      ))}
      <button type="button" className={btn} disabled={disabled} onClick={() => onChange([...value, newSignal()])}><Plus size={12} /> Thêm cảm biến</button>
    </div>
  )
}
