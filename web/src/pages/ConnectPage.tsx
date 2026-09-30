import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { Binding, SubjectSnap, SubjectView } from '../api/types'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { BindingDialog, type BindingDraft } from '../components/live/BindingDialog'
import { FeedControl } from '../components/live/FeedControl'
import { SuggestDialog } from '../components/live/SuggestDialog'
import { Card, EmptyState, ErrorBox, Loading, Notice, PageBody, PageHeader, SearchBox, Tag, btn, btnDangerOutline, btnPrimary } from '../components/ui'
import { useLive } from '../hooks/useLive'
import { STALE_MS, stateLabel } from '../lib/liveFrame'
import { leafPaths } from '../lib/livePath'
import { fmtFactoryTime } from '../lib/liveFormat'
import { suggestMapping } from '../lib/suggestMapping'
import { filterRows } from '../lib/table'

function liveValue(sig: string, kind: string, snap?: SubjectSnap): string | undefined {
  if (!snap) return undefined
  if (kind === 'text') return snap.state ? stateLabel(snap.state) : undefined
  if (kind === 'fleet') return undefined
  const v = snap.signals[sig]?.v
  return v === undefined ? undefined : String(Number(v.toFixed(1))).replace('.', ',')
}

export default function ConnectPage() {
  const model = decodeURIComponent(useParams().key ?? '')
  const qc = useQueryClient()
  const { snapshot } = useLive(model)
  const subjects = useQuery({ queryKey: ['live-subjects', model], queryFn: () => api.liveSubjects(model), retry: false })
  const bindings = useQuery({ queryKey: ['bindings', model], queryFn: () => api.bindings(model) })
  // Nguồn lấy từ danh sách đã đăng ký (còn nguyên khi feed tắt), không phải từ ảnh chụp tạm của live.
  const registry = useQuery({ queryKey: ['sources', model], queryFn: () => api.sources(model), refetchInterval: 4000 })
  const [q, setQ] = useState('')
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [draft, setDraft] = useState<{ d: BindingDraft; existing?: Binding } | null>(null)
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [openSource, setOpenSource] = useState<string | null>(null)
  const [srcQ, setSrcQ] = useState('')
  const clear = useMutation({
    mutationFn: () => api.deleteAllBindings(model),
    onSuccess: () => { setConfirmClear(false); void qc.invalidateQueries({ queryKey: ['bindings', model] }); void qc.invalidateQueries({ queryKey: ['live', model] }) },
  })

  const list: SubjectView[] = subjects.data?.subjects ?? []
  const bound = useMemo(() => new Map((bindings.data ?? []).map((b) => [`${b.subject}|${b.signal}`, b])), [bindings.data])
  const sources = useMemo(() => registry.data ?? [], [registry.data])
  const liveSources = sources.filter((s) => s.live).length
  const totalSignals = list.reduce((n, s) => n + s.signals.length, 0)
  const boundSignals = list.reduce((n, s) => n + s.signals.filter((x) => bound.has(`${s.subject}|${x.name}`)).length, 0)
  const known = new Set(list.map((s) => s.subject))
  const orphans = (bindings.data ?? []).filter((b) => !known.has(b.subject))
  const suggestion = useMemo(
    () => suggestMapping(sources.map((s) => ({ source: s.source, desc: s.desc, last: s.sample })), list, bindings.data ?? []),
    [sources, list, bindings.data],
  )

  const rows = useMemo(() => {
    const byText = filterRows(list, q, (s) => [s.name, s.subject])
    return onlyMissing ? byText.filter((s) => s.signals.some((x) => !bound.has(`${s.subject}|${x.name}`))) : byText
  }, [list, q, onlyMissing, bound])
  const shownSources = useMemo(() => filterRows(sources, srcQ, (s) => [s.source, s.desc]), [sources, srcQ])

  if (subjects.isLoading || bindings.isLoading) return <Loading />
  if (subjects.error) {
    return <PageBody><PageHeader title="Kết nối dữ liệu" subtitle={model} /><ErrorBox error={subjects.error} /></PageBody>
  }

  const open = (d: BindingDraft) => setDraft({ d, existing: d.subject && d.signal ? bound.get(`${d.subject}|${d.signal}`) : undefined })
  const editBinding = (b: Binding) => setDraft({ d: { subject: b.subject, signal: b.signal, source: b.source, json_path: b.json_path, transform: b.transform }, existing: b })

  return (
    <PageBody wide>
      <PageHeader
        title="Kết nối dữ liệu"
        subtitle={model}
        actions={
          <>
            <button className={btnPrimary} disabled={suggestion.suggestions.length === 0} onClick={() => setSuggestOpen(true)}>
              <Sparkles size={12} /> Gợi ý ghép tự động{suggestion.suggestions.length > 0 ? ` (${suggestion.suggestions.length})` : ''}
            </button>
            <button className={btn} onClick={() => open({})}><Plus size={12} /> Ghép thủ công</button>
            <button className={btnDangerOutline} disabled={(bindings.data ?? []).length === 0} onClick={() => setConfirmClear(true)}>Xoá mọi ghép nối</button>
          </>
        }
      />
      <FeedControl model={model} />
      <Notice>
        Thiết bị gửi bản tin thô, tên trường và từ ngữ riêng của từng hãng. Ở đây bạn chỉ ra <b>bản tin nào, trường nào</b> ứng với <b>tín hiệu nào</b> của
        node hay edge trong sơ đồ. Ghép xong, tab Trực tiếp sẽ chạy theo dữ liệu thật. Bấm một ô tín hiệu để ghép, hoặc dùng gợi ý tự động.
      </Notice>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Tag>Đã ghép {boundSignals}/{totalSignals} tín hiệu</Tag>
        <Tag>{sources.length} nguồn, {liveSources} đang phát, {sources.filter((s) => s.bindings.length === 0).length} chưa ghép</Tag>
        {snapshot && snapshot.now > '0002' && <Tag>Giờ nhà máy {fmtFactoryTime(snapshot.now)}</Tag>}
      </div>
      {(snapshot?.errors.length ?? 0) > 0 && (
        <Notice tone="lock">
          <div className="font-medium">Có ghép nối đang lỗi, dữ liệu của các tín hiệu này chưa vào được:</div>
          <ul className="mt-1 list-disc pl-5">
            {snapshot!.errors.slice(-5).map((e) => <li key={e.message}>{e.message} <span className="text-faint">(×{e.count})</span></li>)}
          </ul>
        </Notice>
      )}
      {orphans.length > 0 && (
        <Notice tone="lock">
          {orphans.length} ghép nối trỏ tới node hoặc edge không còn trong sơ đồ: {orphans.map((o) => `${o.subject}/${o.signal}`).join(', ')}. Chúng bị bỏ qua khi nhận dữ liệu.
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card
          title="Node và edge trong sơ đồ"
          actions={
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-[11px] text-muted">
                <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> Chỉ chưa ghép đủ
              </label>
              <SearchBox value={q} onChange={setQ} placeholder="Tìm node hoặc edge" />
            </div>
          }
        >
          {rows.length === 0 ? (
            <EmptyState title="Không có gì để hiện">Đổi bộ lọc, hoặc mô hình chưa có node nào.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((s) => (
                <li key={s.subject} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
                  <div className="w-52 min-w-0">
                    <div className="truncate text-xs font-medium text-text">{s.name}</div>
                    <div className="truncate text-[10.5px] text-faint">{s.subject}{s.kind === 'edge' && s.material ? ` · ${s.material}` : ''}</div>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                    {s.signals.map((sg) => {
                      const b = bound.get(`${s.subject}|${sg.name}`)
                      const snap = snapshot?.subjects[s.subject]
                      const val = b ? liveValue(sg.name, sg.kind, snap) : undefined
                      const fresh = snap !== undefined && snap.age_ms < STALE_MS
                      return (
                        <button
                          key={sg.name}
                          title={b ? `${b.source} → ${b.json_path || '(cả bản tin)'}` : 'Chưa ghép: bấm để ghép'}
                          onClick={() => (b ? editBinding(b) : open({ subject: s.subject, signal: sg.name }))}
                          className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${b ? 'border-line-2 text-text hover:bg-panel-2' : 'border-dashed border-line-2 text-faint hover:text-text'}`}
                        >
                          {b ? <i className={`h-1.5 w-1.5 rounded-full ${fresh ? 'bg-ok' : 'bg-warn'}`} /> : <Plus size={10} />}
                          {sg.label}
                          {val !== undefined && <b className="tabular-nums">{val}</b>}
                        </button>
                      )
                    })}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title={`Nguồn dữ liệu (${sources.length})`}
          actions={<div className="flex items-center gap-2"><Link className="text-[11px] text-accent underline decoration-dotted" to={`/models/${encodeURIComponent(model)}/sources`}>Quản lý nguồn</Link><SearchBox value={srcQ} onChange={setSrcQ} placeholder="Tìm nguồn" /></div>}
        >
          {sources.length === 0 ? (
            <EmptyState title="Chưa có nguồn dữ liệu nào">Bật feed ở thanh phía trên để các thiết bị gửi bản tin, hoặc khai báo nguồn ở tab Nguồn dữ liệu.</EmptyState>
          ) : (
            <ul className="max-h-[560px] divide-y divide-line overflow-y-auto">
              {shownSources.map((s) => (
                <li key={s.source} className="py-1.5">
                  <button className="flex w-full items-start gap-2 text-left" onClick={() => setOpenSource(openSource === s.source ? null : s.source)} aria-expanded={openSource === s.source}>
                    <i className={`mt-1 h-1.5 w-1.5 flex-none rounded-full ${s.live ? 'bg-ok' : 'bg-faint'}`} title={`${s.live ? 'Đang phát' : 'Im lặng'}, ${s.bindings.length > 0 ? `${s.bindings.length} tín hiệu đã ghép` : 'chưa ghép'}`} />
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[11px] text-text">{s.source}</span>
                      <span className="block truncate text-[10.5px] text-muted">{s.desc || 'không có mô tả'}</span>
                    </span>
                  </button>
                  {openSource === s.source && (
                    <ul className="mt-1 space-y-0.5 pl-3.5 text-[11px]">
                      {leafPaths(s.sample).map((l) => (
                        <li key={l.path} className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-mono text-text-2">{l.path || '(giá trị)'}</span>
                          <b className="tabular-nums text-text">{String(l.value)}</b>
                          <button className="text-muted underline decoration-dotted hover:text-text" onClick={() => open({ source: s.source, json_path: l.path })}>Ghép</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {draft && (
        <BindingDialog
          key={`${draft.existing?.id ?? 'new'}-${draft.d.subject ?? ''}-${draft.d.signal ?? ''}-${draft.d.source ?? ''}-${draft.d.json_path ?? ''}`}
          open model={model} subjects={list} sources={sources} draft={draft.d} existing={draft.existing} onClose={() => setDraft(null)}
        />
      )}
      {suggestOpen && (
        <SuggestDialog open model={model} suggestions={suggestion.suggestions} unmatched={suggestion.unmatched} subjects={list} onClose={() => setSuggestOpen(false)} />
      )}
      <ConfirmDialog
        open={confirmClear} title="Xoá mọi ghép nối?" pending={clear.isPending} error={clear.error} confirmLabel="Xoá tất cả"
        description={<>Xoá {(bindings.data ?? []).length} ghép nối của mô hình <b>{model}</b>. Sơ đồ ở tab Trực tiếp sẽ ngừng nhận dữ liệu cho đến khi ghép lại.</>}
        onConfirm={() => clear.mutate()} onCancel={() => setConfirmClear(false)}
      />
    </PageBody>
  )
}
