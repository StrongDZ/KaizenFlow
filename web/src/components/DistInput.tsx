import { KINDS, KIND_LABEL, kindOf, paramsOf, readParam, setKind, setParam, type Kind } from '../lib/dist'
import { input } from './ui'

/**
 * Ô "cố định hoặc ngẫu nhiên" dùng ngoài form rjsf (cảm biến, chế độ hỏng): chọn kiểu, rồi chỉ hiện các tham số kiểu đó dùng.
 * Đổi kiểu giữ độ lớn cũ và điền đủ tham số kiểu mới.
 */
export function DistInput({ value, onChange, unit = 'giây', label, disabled }: {
  value: unknown; onChange: (v: unknown) => void; unit?: string; label: string; disabled?: boolean
}) {
  const kind = kindOf(value)
  return (
    <div className="space-y-1.5">
      <select className={`${input} w-full`} aria-label={label} disabled={disabled} value={kind}
        onChange={(e) => onChange(e.target.value === 'empty' ? undefined : setKind(value, e.target.value as Kind))}>
        {kind === 'empty' && <option value="empty">Chưa đặt</option>}
        {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        {kind === 'unknown' && <option value="unknown">Kiểu khác (giữ nguyên)</option>}
      </select>
      {kind !== 'empty' && kind !== 'unknown' && (
        <div className="grid grid-cols-3 gap-2">
          {paramsOf(kind).map((p) => {
            const cur = typeof value === 'number' ? value : readParam(value, p.key)
            return (
              <label key={p.key} className="space-y-0.5 text-[10.5px] text-muted">
                <span className="block">{p.unitless || unit === '' ? p.label : `${p.label} (${unit})`}</span>
                <input className={`${input} w-full`} type="number" step="any" disabled={disabled} value={cur ?? ''} aria-label={`${label}: ${p.label}`}
                  onChange={(e) => {
                    const n = e.target.value === '' ? undefined : Number(e.target.value)
                    onChange(setParam(value, p.key, n !== undefined && Number.isFinite(n) ? n : undefined))
                  }} />
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}
