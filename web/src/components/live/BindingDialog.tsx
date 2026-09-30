import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { api } from '../../api/client'
import type { Binding, SourceSnap, SubjectView, Transform } from '../../api/types'
import { previewBinding } from '../../lib/bindingPreview'
import { leafPaths, matchSource } from '../../lib/livePath'
import { stateLabel } from '../../lib/liveFrame'
import { STATE_ENUM } from '../../lib/suggestMapping'
import { Field, FormDialog } from '../FormDialog'
import { btn, input } from '../ui'

export type BindingDraft = { subject?: string; signal?: string; source?: string; json_path?: string; transform?: Transform }

const STANDARD_STATES = ['RUNNING', 'IDLE', 'STARVED', 'BLOCKED', 'DOWN']

/** Ghép một tín hiệu chuẩn của node/edge với một trường của một nguồn dữ liệu, kèm xem trước giá trị ngay trong hộp. */
export function BindingDialog({ open, model, subjects, sources, draft, existing, onClose }: {
  open: boolean
  model: string
  subjects: SubjectView[]
  sources: SourceSnap[]
  draft: BindingDraft
  existing?: Binding
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [subject, setSubject] = useState(draft.subject ?? '')
  const [signal, setSignal] = useState(draft.signal ?? '')
  const [source, setSource] = useState(draft.source ?? '')
  const [path, setPath] = useState(draft.json_path ?? '')
  const [scale, setScale] = useState(draft.transform?.scale?.toString() ?? '')
  const [offset, setOffset] = useState(draft.transform?.offset?.toString() ?? '')
  const [enumRows, setEnumRows] = useState<[string, string][]>(Object.entries(draft.transform?.enum ?? {}))
  const [fields, setFields] = useState<Record<string, string>>(draft.transform?.fields ?? {})

  const subj = subjects.find((s) => s.subject === subject)
  const def = subj?.signals.find((s) => s.name === signal)
  const kind = def?.kind ?? 'number'
  const live = useMemo(() => sources.find((s) => s.source === source) ?? sources.find((s) => matchSource(source, s.source)), [sources, source])
  const paths = useMemo(() => (live ? leafPaths(live.last) : []), [live])

  const transform: Transform = useMemo(() => {
    const t: Transform = {}
    if (kind === 'number') {
      if (scale.trim() !== '' && Number.isFinite(Number(scale))) t.scale = Number(scale)
      if (offset.trim() !== '' && Number.isFinite(Number(offset))) t.offset = Number(offset)
    } else if (kind === 'text') {
      const e = Object.fromEntries(enumRows.filter(([a, b]) => a.trim() !== '' && b !== ''))
      if (Object.keys(e).length > 0) t.enum = e
    } else {
      const f = Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim() !== ''))
      if (Object.keys(f).length > 0) t.fields = f
    }
    return t
  }, [kind, scale, offset, enumRows, fields])

  const preview = live ? previewBinding(live.last, path, kind, transform) : undefined
  const save = useMutation({
    mutationFn: () => api.saveBindings(model, [{ subject, signal, source: source.trim(), json_path: kind === 'fleet' ? '' : path.trim(), transform, enabled: true }]),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bindings', model] })
      void qc.invalidateQueries({ queryKey: ['live', model] })
      onClose()
    },
  })
  const remove = useMutation({
    mutationFn: () => api.deleteBinding(model, existing!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bindings', model] })
      void qc.invalidateQueries({ queryKey: ['live', model] })
      onClose()
    },
  })

  const canSubmit = subject !== '' && signal !== '' && source.trim() !== '' && (kind === 'fleet' || path.trim() !== '')
  const observed = live && kind === 'text' ? (() => { const v = previewRaw(live.last, path); return v })() : undefined

  return (
    <FormDialog
      open={open}
      title={existing ? 'Sửa ghép nối' : 'Ghép dữ liệu vào sơ đồ'}
      description="Chọn tín hiệu của node hoặc edge, nguồn dữ liệu và trường trong bản tin. Giá trị xem trước lấy từ bản tin mới nhất đang phát."
      submitLabel="Lưu ghép nối"
      pending={save.isPending}
      error={save.error ?? remove.error}
      canSubmit={canSubmit}
      onSubmit={() => save.mutate()}
      onClose={onClose}
    >
      <Field label="Đối tượng trong sơ đồ">
        <select className={`${input} w-full`} value={subject} disabled={!!existing} onChange={(e) => { setSubject(e.target.value); setSignal('') }}>
          <option value="">Chọn node hoặc edge…</option>
          <optgroup label="Node">
            {subjects.filter((s) => s.kind === 'node').map((s) => <option key={s.subject} value={s.subject}>{s.name} ({s.subject})</option>)}
          </optgroup>
          <optgroup label="Edge">
            {subjects.filter((s) => s.kind === 'edge').map((s) => <option key={s.subject} value={s.subject}>{s.name} · {s.material} ({s.subject})</option>)}
          </optgroup>
        </select>
      </Field>
      <Field label="Tín hiệu">
        <select className={`${input} w-full`} value={signal} disabled={!subj || !!existing} onChange={(e) => setSignal(e.target.value)}>
          <option value="">{subj ? 'Chọn tín hiệu…' : 'Chọn đối tượng trước'}</option>
          {subj?.signals.map((s) => <option key={s.name} value={s.name}>{s.label} ({s.name})</option>)}
        </select>
      </Field>
      <Field label="Nguồn dữ liệu" hint={<>Chọn từ nguồn đang phát, hoặc gõ mẫu có <code>+</code> cho một cấp (vd. <code>agv/tug-a/+/pos</code>).</>}>
        <input className={`${input} w-full font-mono`} list="kf-sources" value={source} onChange={(e) => setSource(e.target.value)} placeholder="plc/prs-02/status" />
        <datalist id="kf-sources">{sources.map((s) => <option key={s.source} value={s.source}>{s.desc}</option>)}</datalist>
      </Field>
      {kind !== 'fleet' ? (
        <Field label="Trường trong bản tin" hint={<>Đường dẫn tới giá trị, vd. <code>cnt.ok</code> hoặc <code>items[sku=RAW-01].qty</code>. Gõ để lọc theo trường có sẵn.</>}>
          <input className={`${input} w-full font-mono`} list="kf-paths" value={path} onChange={(e) => setPath(e.target.value)} placeholder="st" />
          <datalist id="kf-paths">{paths.map((l) => <option key={l.path} value={l.path}>{String(l.value)}</option>)}</datalist>
        </Field>
      ) : (
        <details className="rounded-lg border border-line p-2">
          <summary className="cursor-pointer text-text-2">Tên trường của bản tin vị trí xe (mặc định đúng nếu bản tin có id, x, y, st, seg, load)</summary>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {(['id', 'x', 'y', 'state', 'lane', 'load'] as const).map((f) => (
              <label key={f} className="space-y-0.5">
                <span className="block text-faint">{{ id: 'Mã xe', x: 'Toạ độ x', y: 'Toạ độ y', state: 'Trạng thái', lane: 'Làn', load: 'Tải' }[f]}</span>
                <input className={`${input} w-full font-mono`} value={fields[f] ?? ''} placeholder={{ id: 'id', x: 'x', y: 'y', state: 'st', lane: 'seg', load: 'load' }[f]}
                  onChange={(e) => setFields({ ...fields, [f]: e.target.value })} />
              </label>
            ))}
          </div>
        </details>
      )}
      {kind === 'number' && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Nhân với" hint="Đổi đơn vị, vd. 0,001 để từ gram sang kg"><input className={`${input} w-full`} inputMode="decimal" value={scale} onChange={(e) => setScale(e.target.value)} placeholder="1" /></Field>
          <Field label="Cộng thêm" hint="Áp dụng sau khi nhân"><input className={`${input} w-full`} inputMode="decimal" value={offset} onChange={(e) => setOffset(e.target.value)} placeholder="0" /></Field>
        </div>
      )}
      {kind === 'text' && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-text-2">
            <span>Đổi từ ngữ của thiết bị sang trạng thái chuẩn</span>
            <button type="button" className={btn} onClick={() => setEnumRows(Object.entries(STATE_ENUM))}>Dùng bảng chuẩn</button>
          </div>
          {enumRows.length === 0 && <div className="text-faint">Để trống thì giữ nguyên chữ của thiết bị (viết hoa).{observed ? ` Đang thấy giá trị "${observed}".` : ''}</div>}
          {enumRows.map(([raw, std], i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input className={`${input} w-32 font-mono`} value={raw} aria-label="Từ của thiết bị"
                onChange={(e) => setEnumRows(enumRows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
              <span className="text-faint">→</span>
              <select className={`${input} flex-1`} value={std} aria-label="Trạng thái chuẩn"
                onChange={(e) => setEnumRows(enumRows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}>
                {STANDARD_STATES.map((s) => <option key={s} value={s}>{stateLabel(s)} ({s})</option>)}
              </select>
              <button type="button" aria-label="Xoá dòng" className="text-muted hover:text-text" onClick={() => setEnumRows(enumRows.filter((_, j) => j !== i))}><X size={13} /></button>
            </div>
          ))}
          <button type="button" className={btn} onClick={() => setEnumRows([...enumRows, [observed ?? '', 'RUNNING']])}><Plus size={12} /> Thêm dòng</button>
        </div>
      )}
      <div className={`rounded-lg border px-3 py-2 ${preview ? (preview.ok ? 'border-ok/40 bg-panel-2' : 'border-bad/50 bg-bad-bg text-bad-text') : 'border-line bg-panel-2 text-faint'}`}>
        {preview
          ? preview.ok ? <>Xem trước: <b className="text-text">{preview.text}</b></> : preview.reason
          : source.trim() === '' ? 'Chọn nguồn để xem trước giá trị.' : 'Nguồn này chưa phát bản tin nào để xem trước. Vẫn lưu được.'}
      </div>
      {existing && (
        <button type="button" className={`${btn} text-bad-text`} disabled={remove.isPending} onClick={() => remove.mutate()}>Xoá ghép nối này</button>
      )}
    </FormDialog>
  )
}

function previewRaw(last: unknown, path: string): string | undefined {
  const l = leafPaths(last).find((x) => x.path === path)
  return l ? String(l.value) : undefined
}
