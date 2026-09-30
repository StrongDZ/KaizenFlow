import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api/client'
import { ApiError } from '../../api/client'
import type { Binding, DataSourceRow, Derive, LiveSnapshot, SignalCoverage, SubjectView, Transform } from '../../api/types'
import { previewBinding } from '../../lib/bindingPreview'
import { statusKey } from '../../lib/connectView'
import { describeDerive, emptyDerive, isComplete, previewDerive, toInput } from '../../lib/derive'
import { leafPaths, matchSource } from '../../lib/livePath'
import { stateLabel } from '../../lib/liveFrame'
import { STATE_ENUM } from '../../lib/suggestMapping'
import { ARCHETYPE_LABEL } from '../KfNode'
import { Field, FormDialog } from '../FormDialog'
import { SearchSelect } from '../SearchSelect'
import { btn, btnDangerOutline, btnLinkAccent, input } from '../ui'
import { DeriveEditor } from './DeriveEditor'
import { FieldPicker } from './FieldPicker'

export type BindingDraft = { subject?: string; signal?: string; source?: string; json_path?: string; transform?: Transform; mode?: 'source' | 'derived'; derive?: Derive }

const STANDARD_STATES = ['RUNNING', 'IDLE', 'STARVED', 'BLOCKED', 'DOWN']

/**
 * Thiết lập cách một tín hiệu chuẩn của node/edge lấy giá trị: từ một trường của nguồn dữ liệu (kèm xem trước giá trị), hoặc tự tính từ
 * các tín hiệu khác trong sơ đồ (công thức chọn bằng ô chọn, kèm gợi ý một bấm và kiểm tra hợp lệ trước khi lưu).
 */
export function BindingDialog({ open, model, subjects, sources, coverage, live: liveSnap, draft, existing, onClose }: {
  open: boolean
  model: string
  subjects: SubjectView[]
  sources: DataSourceRow[]
  /** Độ phủ của từng tín hiệu (để biết tín hiệu nào đã ghép và có gợi ý tự tính nào). */
  coverage: Map<string, SignalCoverage>
  live?: LiveSnapshot
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
  const [mode, setMode] = useState<'source' | 'derived'>(draft.mode ?? existing?.mode ?? 'source')
  const [derive, setDerive] = useState<Derive | undefined>(draft.derive ?? existing?.derive ?? undefined)
  const [verdict, setVerdict] = useState<{ state: 'idle' | 'checking' | 'ok' | 'error'; message?: string }>({ state: 'idle' })

  const subj = subjects.find((s) => s.subject === subject)
  const def = subj?.signals.find((s) => s.name === signal)
  const kind = def?.kind ?? 'number'
  const cov = coverage.get(statusKey(subject, signal))
  const suggestions = cov?.suggestions ?? []
  const canDerive = kind !== 'fleet' && subject !== '' && signal !== ''
  const deriveKind: Derive['kind'] = kind === 'text' ? 'activity' : 'sum'
  const cur: Derive = derive?.kind === deriveKind ? derive : emptyDerive(deriveKind)
  const bound = useMemo(() => (s: string, g: string) => { const st = coverage.get(statusKey(s, g))?.status; return st === 'source' || st === 'derived' }, [coverage])
  const nameOf = (id: string) => subjects.find((s) => s.subject === id)?.name ?? id
  const labelOf = (id: string, g: string) => {
    const l = subjects.find((s) => s.subject === id)?.signals.find((x) => x.name === g)?.label ?? g
    return l.charAt(0).toLowerCase() + l.slice(1)
  }
  const readLive = (id: string, g: string): number | undefined => liveSnap?.subjects[id]?.signals[g]?.v
  const live = useMemo(() => sources.find((s) => s.source === source) ?? sources.find((s) => matchSource(source, s.source)), [sources, source])
  const sample = live?.sample ?? undefined
  // Mẫu nhiều nguồn (+, #) hoặc nguồn chưa đăng ký: nhập tay trong mục nâng cao; còn lại luôn chọn từ danh sách.
  const [advanced, setAdvanced] = useState(() => draft.source !== undefined && draft.source !== '' && (/[+#]/.test(draft.source) || !sources.some((s) => s.source === draft.source)))
  const sourceOptions = useMemo(() => sources.map((s) => ({ value: s.source, label: s.source, hint: s.desc })), [sources])
  const subjectOptions = useMemo(
    () => subjects.map((s) => ({ value: s.subject, label: s.name, hint: s.kind === 'node' ? ARCHETYPE_LABEL[s.archetype ?? ''] ?? 'Node' : `đường nối · ${s.material ?? ''}` })),
    [subjects],
  )

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

  const preview = live ? previewBinding(sample, path, kind, transform) : undefined
  const save = useMutation({
    mutationFn: () => api.saveBindings(model, [
      mode === 'derived'
        ? { subject, signal, mode: 'derived', derive: toInput(cur), enabled: true }
        : { subject, signal, mode: 'source', source: source.trim(), json_path: kind === 'fleet' ? '' : path.trim(), transform, enabled: true },
    ]),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bindings', model] })
      void qc.invalidateQueries({ queryKey: ['live', model] })
      void qc.invalidateQueries({ queryKey: ['live-check', model] })
      onClose()
    },
  })
  const remove = useMutation({
    mutationFn: () => api.deleteBinding(model, existing!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bindings', model] })
      void qc.invalidateQueries({ queryKey: ['live', model] })
      void qc.invalidateQueries({ queryKey: ['live-check', model] })
      onClose()
    },
  })

  // Công thức tự tính được kiểm trên server (đầu vào đã ghép, không vòng, đúng kiểu) mỗi khi đổi, trước khi cho lưu.
  const deriveKey = JSON.stringify(toInput(cur))
  const derivedReady = mode === 'derived' && canDerive && isComplete(cur)
  useEffect(() => {
    if (!derivedReady) { setVerdict({ state: 'idle' }); return }
    setVerdict({ state: 'checking' })
    let live = true
    const t = setTimeout(() => {
      api.checkBindings(model, [{ subject, signal, mode: 'derived', derive: JSON.parse(deriveKey) as Derive, enabled: true }])
        .then(() => live && setVerdict({ state: 'ok' }))
        .catch((e: unknown) => live && setVerdict({ state: 'error', message: e instanceof ApiError && e.issues.length > 0 ? e.issues[0].message : e instanceof Error ? e.message : 'Không kiểm tra được' }))
    }, 350)
    return () => { live = false; clearTimeout(t) }
  }, [derivedReady, deriveKey, model, subject, signal])

  const canSubmit = mode === 'derived'
    ? derivedReady && verdict.state === 'ok'
    : subject !== '' && signal !== '' && source.trim() !== '' && (kind === 'fleet' || path.trim() !== '')
  const observed = live && kind === 'text' ? previewRaw(sample, path) : undefined

  return (
    <FormDialog
      open={open}
      title={existing ? 'Sửa ghép nối' : 'Ghép dữ liệu vào sơ đồ'}
      description={mode === 'derived'
        ? 'Tín hiệu này không có thiết bị gửi trực tiếp, nên được tính từ các tín hiệu khác trong sơ đồ. Giá trị sẽ chạy cùng dữ liệu thật.'
        : 'Chọn tín hiệu của node hoặc edge, nguồn dữ liệu và trường trong bản tin. Giá trị xem trước lấy từ bản tin mới nhất đang phát.'}
      width={mode === 'derived' ? 540 : 460}
      submitLabel="Lưu ghép nối"
      pending={save.isPending}
      error={save.error ?? remove.error}
      canSubmit={canSubmit}
      onSubmit={() => save.mutate()}
      onClose={onClose}
    >
      <Field label="Đối tượng trong sơ đồ" hint="Node hoặc đường nối của sơ đồ mà tín hiệu này thuộc về. Gõ tên để lọc.">
        <SearchSelect
          value={subject} options={subjectOptions} disabled={!!existing} label="Đối tượng trong sơ đồ" placeholder="Chọn node hoặc đường nối"
          onChange={(v) => { setSubject(v); setSignal('') }}
        />
      </Field>
      <Field label="Tín hiệu" hint={subj && subj.signals.length === 0 ? undefined : 'Giá trị chuẩn mà node hay đường nối này nhận.'}>
        <select className={`${input} w-full`} value={signal} disabled={!subj || !!existing} onChange={(e) => setSignal(e.target.value)}>
          <option value="">{subj ? 'Chọn tín hiệu…' : 'Chọn đối tượng trước'}</option>
          {subj?.signals.map((s) => <option key={s.name} value={s.name}>{s.label} ({s.name})</option>)}
        </select>
        {subj && subj.signals.length === 0 && (
          <span role="note" className="block text-lock-text">
            {subj.archetype === 'STORAGE'
              ? 'Kho này chưa khai báo vật tư nào nên chưa có tín hiệu Tồn để ghép. Khai báo vật tư trong thuộc tính của kho ở tab Sơ đồ.'
              : 'Đối tượng này chưa có tín hiệu nào để ghép.'}
          </span>
        )}
      </Field>
      {canDerive && (
        <div role="radiogroup" aria-label="Giá trị lấy từ đâu" className="flex gap-1 rounded-lg border border-line bg-panel-2 p-0.5">
          {([['source', 'Từ thiết bị (nguồn dữ liệu)'], ['derived', 'Tự tính từ tín hiệu khác']] as const).map(([m, label]) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
              className={`flex-1 rounded-md px-2 py-1 text-[11.5px] ${mode === m ? 'bg-raised font-semibold text-text shadow-sm' : 'text-muted hover:text-text'}`}>
              {label}
            </button>
          ))}
        </div>
      )}
      {mode === 'source' && canDerive && suggestions.length > 0 && !existing && (
        <div className="flex items-start gap-2 rounded-lg border border-accent/40 bg-panel-2 px-3 py-2">
          <Sparkles size={13} className="mt-0.5 flex-none text-accent" aria-hidden />
          <div className="min-w-0 flex-1 text-text-2">
            Chưa có thiết bị cho tín hiệu này? Có thể tự tính: {suggestions[0].note}
          </div>
          <button type="button" className={btn} onClick={() => { setDerive(suggestions[0].derive); setMode('derived') }}>Dùng gợi ý</button>
        </div>
      )}
      {(mode === 'source' || !canDerive) && (
        <>
      <Field
        label="Nguồn dữ liệu"
        hint={advanced
          ? <>Mẫu nhiều nguồn: <code>+</code> thay một cấp (vd. <code>agv/tug-a/+/pos</code>), <code>#</code> thay phần còn lại ở cuối.</>
          : 'Thiết bị hoặc topic gửi bản tin. Không thấy nguồn cần tìm? Thêm nó ở tab Nguồn dữ liệu.'}
      >
        {advanced ? (
          <input className={`${input} w-full font-mono`} value={source} onChange={(e) => setSource(e.target.value)} placeholder="agv/tug-a/+/pos" aria-label="Mẫu nguồn dữ liệu" />
        ) : (
          <SearchSelect value={source} options={sourceOptions} onChange={setSource} label="Nguồn dữ liệu" placeholder="Chọn nguồn dữ liệu" emptyText="Chưa có nguồn nào. Thêm ở tab Nguồn dữ liệu." />
        )}
        <button type="button" className={btnLinkAccent} onClick={() => setAdvanced((a) => !a)}>
          {advanced ? 'Chọn từ danh sách nguồn' : 'Nâng cao: một mẫu cho nhiều nguồn (+ hoặc #)'}
        </button>
      </Field>
      {kind !== 'fleet' ? (
        <Field label="Trường trong bản tin" hint="Giá trị nào trong bản tin. Danh sách lấy từ bản tin mẫu của nguồn, kèm giá trị hiện có.">
          <FieldPicker sample={sample} value={path} onChange={setPath} />
        </Field>
      ) : (
        <details className="rounded-lg border border-line p-2">
          <summary className="cursor-pointer text-text-2">Tên trường của bản tin vị trí xe (mặc định đúng nếu bản tin có id, x, y, st, seg, load)</summary>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {(['id', 'x', 'y', 'state', 'lane', 'load'] as const).map((f) => (
              <div key={f} className="space-y-0.5">
                <span className="block text-faint">{{ id: 'Mã xe', x: 'Toạ độ x', y: 'Toạ độ y', state: 'Trạng thái', lane: 'Làn', load: 'Tải' }[f]}</span>
                <FieldPicker
                  sample={sample} value={fields[f] ?? ''} onChange={(v) => setFields({ ...fields, [f]: v })}
                  placeholder={`mặc định: ${{ id: 'id', x: 'x', y: 'y', state: 'st', lane: 'seg', load: 'load' }[f]}`}
                />
              </div>
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
        </>
      )}
      {mode === 'derived' && canDerive && (
        <>
          {suggestions.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-text-2"><Sparkles size={12} className="text-accent" aria-hidden />Gợi ý theo cấu trúc sơ đồ</div>
              {suggestions.map((g, i) => (
                <button key={i} type="button" onClick={() => setDerive(g.derive)}
                  className="block w-full rounded-lg border border-line px-3 py-1.5 text-left text-text-2 hover:bg-panel">{g.note}</button>
              ))}
            </div>
          )}
          <DeriveEditor kind={kind === 'text' ? 'text' : 'number'} value={cur} onChange={setDerive} subjects={subjects} bound={bound} self={{ subject, signal }} />
          <div className={`rounded-lg border px-3 py-2 ${verdict.state === 'error' ? 'border-bad/50 bg-bad-bg text-bad-text' : verdict.state === 'ok' ? 'border-ok/40 bg-panel-2' : 'border-line bg-panel-2 text-faint'}`}>
            <div className="text-text-2">{capitalize(describeDerive(cur, nameOf, labelOf))}</div>
            {verdict.state === 'ok' && (() => {
              const v = previewDerive(cur, readLive)
              return <div className="mt-0.5">Hợp lệ{v !== undefined ? <>. Xem trước theo giá trị hiện tại: <b className="text-text">{String(Number(v.toFixed(2))).replace('.', ',')}</b></> : '.'}</div>
            })()}
            {verdict.state === 'error' && <div className="mt-0.5">{verdict.message}</div>}
            {verdict.state === 'checking' && <div className="mt-0.5">Đang kiểm tra…</div>}
            {verdict.state === 'idle' && <div className="mt-0.5">Chọn đủ tín hiệu để kiểm tra.</div>}
          </div>
        </>
      )}
      {existing && (
        <button type="button" className={btnDangerOutline} disabled={remove.isPending} onClick={() => remove.mutate()}>Xoá ghép nối này</button>
      )}
    </FormDialog>
  )
}

const capitalize = (t: string) => (t.startsWith('−') ? t : t.charAt(0).toUpperCase() + t.slice(1))

function previewRaw(last: unknown, path: string): string | undefined {
  const l = leafPaths(last).find((x) => x.path === path)
  return l ? String(l.value) : undefined
}
