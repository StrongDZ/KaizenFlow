import { Plus, X } from 'lucide-react'
import { useMemo } from 'react'
import type { Derive, SubjectView } from '../../api/types'
import { addTerm, relatedSubjects, removeTerm, updateTerm } from '../../lib/derive'
import { ARCHETYPE_LABEL } from '../KfNode'
import { Field } from '../FormDialog'
import { SearchSelect } from '../SearchSelect'
import { btn, input } from '../ui'

type Props = {
  kind: 'number' | 'text'
  value: Derive
  onChange: (d: Derive) => void
  subjects: SubjectView[]
  /** Tín hiệu đã có ghép nối (nguồn hoặc tự tính): chỉ những tín hiệu này dùng làm đầu vào được. */
  bound: (subject: string, signal: string) => boolean
  /** Tín hiệu đang được thiết lập, loại khỏi danh sách đầu vào (không tự tính từ chính nó). */
  self: { subject: string; signal: string }
}

/**
 * Soạn công thức tự tính bằng ô chọn, không gõ công thức: tín hiệu dạng số là tổng cộng trừ các tín hiệu khác
 * (mỗi số hạng: dấu, đối tượng, tín hiệu, hệ số nhân), trạng thái máy suy từ việc một bộ đếm còn tăng.
 */
export function DeriveEditor({ kind, value, onChange, subjects, bound, self }: Props) {
  // Chỉ được lấy đầu vào từ chính đối tượng này và những gì nối trực tiếp với nó (API cũng ép luật này khi lưu).
  const related = useMemo(() => relatedSubjects(subjects, self.subject), [subjects, self.subject])
  const neighbours = useMemo(() => subjects.filter((s) => related.has(s.subject) && s.subject !== self.subject).map((s) => s.name), [subjects, related, self.subject])
  const candidates = useMemo(() => {
    const out: Record<string, SubjectView['signals']> = {}
    for (const s of subjects) {
      if (!related.has(s.subject)) continue
      const sigs = s.signals.filter((g) => g.kind === 'number' && bound(s.subject, g.name) && !(s.subject === self.subject && g.name === self.signal))
      if (sigs.length > 0) out[s.subject] = sigs
    }
    return out
  }, [subjects, related, bound, self.subject, self.signal])
  const subjectOptions = useMemo(
    () => subjects.filter((s) => candidates[s.subject]).map((s) => ({ value: s.subject, label: s.name, hint: s.kind === 'node' ? ARCHETYPE_LABEL[s.archetype ?? ''] ?? 'Node' : `đường nối · ${s.material ?? ''}` })),
    [subjects, candidates],
  )
  const signalSelect = (subject: string, current: string, onPick: (signal: string) => void, label: string) => (
    <select className={`${input} min-w-0 flex-1`} aria-label={label} value={current} disabled={!subject} onChange={(e) => onPick(e.target.value)}>
      <option value="">{subject ? 'Chọn tín hiệu…' : 'Chọn đối tượng trước'}</option>
      {(candidates[subject] ?? []).map((g) => <option key={g.name} value={g.name}>{g.label} ({g.name})</option>)}
    </select>
  )
  const empty = subjectOptions.length === 0
  const scope = (
    <p className="text-muted">
      Chỉ lấy được tín hiệu của chính đối tượng này và của những đối tượng nối trực tiếp với nó
      {neighbours.length > 0 ? `: ${neighbours.join(', ')}.` : ' (hiện chưa có đối tượng nào nối với nó).'}
    </p>
  )

  if (kind === 'text') {
    const watch = value.watch ?? { subject: '', signal: '' }
    return (
      <div className="space-y-2">
        {scope}
        <Field label="Theo dõi bộ đếm" hint="Máy được coi là đang chạy khi bộ đếm này còn tăng. Chọn bộ đếm đã ghép (vd. số lượt đã nhận hoặc số sản phẩm đạt).">
          <div className="space-y-1.5">
            <SearchSelect value={watch.subject} options={subjectOptions} label="Đối tượng có bộ đếm" placeholder="Chọn node hoặc đường nối" onChange={(v) => onChange({ ...value, watch: { subject: v, signal: '' } })} />
            {signalSelect(watch.subject, watch.signal, (g) => onChange({ ...value, watch: { subject: watch.subject, signal: g } }), 'Tín hiệu bộ đếm')}
          </div>
        </Field>
        <Field label="Coi là nghỉ sau (giây)" hint="Số giây nhà máy không thấy bộ đếm tăng thì máy chuyển sang nghỉ. Gợi ý: gấp đôi thời gian chu kỳ của máy.">
          <input className={`${input} w-full`} type="number" min={1} step="any" value={value.idle_after_s ?? ''}
            onChange={(e) => onChange({ ...value, idle_after_s: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </Field>
        {empty && <p className="text-lock-text">Chưa có bộ đếm liền kề nào được ghép. Ghép số lượt hoặc số sản phẩm của máy (hoặc của đường nối vào, ra nó) trước, rồi quay lại đây.</p>}
      </div>
    )
  }

  const terms = value.terms ?? []
  return (
    <div className="space-y-2">
      {scope}
      {terms.map((t, i) => (
        <div key={i} className="space-y-1.5 rounded-lg border border-line p-2">
          <div className="flex items-center gap-2">
            <select className={`${input} w-24 flex-none`} aria-label="Cộng hay trừ" value={t.sign} onChange={(e) => onChange(updateTerm(value, i, { sign: Number(e.target.value) === -1 ? -1 : 1 }))}>
              <option value={1}>+ cộng</option>
              <option value={-1}>− trừ</option>
            </select>
            <div className="min-w-0 flex-1">
              <SearchSelect value={t.subject} options={subjectOptions} label="Đối tượng" placeholder="Chọn node hoặc đường nối" onChange={(v) => onChange(updateTerm(value, i, { subject: v, signal: '' }))} />
            </div>
            <button type="button" aria-label="Bỏ số hạng này" className="flex-none text-muted hover:text-bad-text" onClick={() => onChange(removeTerm(value, i))}><X size={14} /></button>
          </div>
          <div className="flex items-center gap-2">
            {signalSelect(t.subject, t.signal, (g) => onChange(updateTerm(value, i, { signal: g })), 'Tín hiệu')}
            <label className="flex flex-none items-center gap-1 text-muted">
              nhân với
              <input className={`${input} w-16`} type="number" min={0} step="any" placeholder="1" aria-label="Hệ số nhân" value={t.factor ?? ''}
                onChange={(e) => onChange(updateTerm(value, i, { factor: e.target.value === '' ? undefined : Number(e.target.value) }))} />
            </label>
          </div>
        </div>
      ))}
      <button type="button" className={btn} onClick={() => onChange(addTerm(value))}><Plus size={12} /> Thêm số hạng</button>
      <Field label="Cộng thêm" hint="Một con số cố định cộng vào kết quả, vd. tồn đầu kỳ của kho. Bỏ trống là 0.">
        <input className={`${input} w-full`} type="number" step="any" placeholder="0" value={value.const ?? ''}
          onChange={(e) => onChange({ ...value, const: e.target.value === '' ? 0 : Number(e.target.value) })} />
      </Field>
      {empty && <p className="text-lock-text">Chưa có tín hiệu liền kề nào được ghép để làm đầu vào. Ghép tín hiệu của các đối tượng nối với nó trước, rồi quay lại đây.</p>}
    </div>
  )
}
