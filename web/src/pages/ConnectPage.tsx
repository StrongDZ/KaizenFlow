import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Sparkles, Waypoints, Plug } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import type { Binding, SubjectSnap, SubjectView } from '../api/types'
import { ARCHETYPE_LABEL } from '../components/KfNode'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { NodeAvatar } from '../components/NodeIdentity'
import { BindingDialog, type BindingDraft } from '../components/live/BindingDialog'
import { BindingsTable } from '../components/live/BindingsTable'
import { EdgePlanDialog } from '../components/live/EdgePlanDialog'
import { FeedControl } from '../components/live/FeedControl'
import { ReadinessBar } from '../components/live/ReadinessBar'
import { SignalChip } from '../components/live/SignalChip'
import { SuggestDialog } from '../components/live/SuggestDialog'
import { Card, EmptyState, ErrorBox, Loading, Notice, PageBody, PageHeader, SearchBox, Tag, btn, btnDangerOutline, btnPrimary } from '../components/ui'
import { useLive } from '../hooks/useLive'
import { bindingRows, describeBinding } from '../lib/bindingsTable'
import { iconOfType } from '../lib/graph'
import { filterSubjects, groupNodes, indexCoverage, isBound, splitSubjects, statusKey } from '../lib/connectView'
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
  // Độ phủ: từng tín hiệu đã có nguồn, đã tự tính, chưa có hay hỏng; chức năng nào đã đủ tín hiệu.
  const coverage = useQuery({ queryKey: ['live-check', model], queryFn: () => api.liveCheck(model), refetchInterval: 6000, retry: false })
  // Công thức tự suy lượng hàng trên các đường nối chưa có dữ liệu (kể cả rẽ nhánh).
  const nodeTypes = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  const typeByCode = useMemo(() => new Map((nodeTypes.data ?? []).map((t) => [t.code, t])), [nodeTypes.data])
  const edgePlan = useQuery({ queryKey: ['edge-plan', model], queryFn: () => api.edgePlan(model), refetchInterval: 6000, retry: false })
  const [params, setParams] = useSearchParams()
  const tab: 'node' | 'edge' | 'all' = params.get('tab') === 'edge' ? 'edge' : params.get('tab') === 'all' ? 'all' : 'node'
  const setTab = (t: 'node' | 'edge' | 'all') => setParams((p) => { const n = new URLSearchParams(p); if (t === 'node') n.delete('tab'); else n.set('tab', t); return n }, { replace: true })
  const [q, setQ] = useState('')
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [feature, setFeature] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ d: BindingDraft; existing?: Binding } | null>(null)
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [openSource, setOpenSource] = useState<string | null>(null)
  const [srcQ, setSrcQ] = useState('')
  const clear = useMutation({
    mutationFn: () => api.deleteAllBindings(model),
    onSuccess: () => { setConfirmClear(false); void qc.invalidateQueries({ queryKey: ['bindings', model] }); void qc.invalidateQueries({ queryKey: ['live', model] }); void qc.invalidateQueries({ queryKey: ['live-check', model] }) },
  })

  const list: SubjectView[] = subjects.data?.subjects ?? []
  const bound = useMemo(() => new Map((bindings.data ?? []).map((b) => [`${b.subject}|${b.signal}`, b])), [bindings.data])
  const sources = useMemo(() => registry.data ?? [], [registry.data])
  const liveSources = sources.filter((s) => s.live).length
  const idx = useMemo(() => indexCoverage(coverage.data), [coverage.data])
  const totalSignals = list.reduce((n, s) => n + s.signals.length, 0)
  const boundSignals = coverage.data ? coverage.data.summary.source + coverage.data.summary.derived : list.reduce((n, s) => n + s.signals.filter((x) => bound.has(`${s.subject}|${x.name}`)).length, 0)
  const split = useMemo(() => splitSubjects(list), [list])
  const missingFor = useMemo(() => {
    const r = coverage.data?.readiness.find((x) => x.feature === feature)
    return r ? new Set(r.missing.map((m) => statusKey(m.subject, m.signal))) : undefined
  }, [coverage.data, feature])
  const known = new Set(list.map((s) => s.subject))
  const orphans = (bindings.data ?? []).filter((b) => !known.has(b.subject))
  const suggestion = useMemo(
    () => suggestMapping(sources.map((s) => ({ source: s.source, desc: s.desc, last: s.sample })), list, bindings.data ?? []),
    [sources, list, bindings.data],
  )

  const rows = useMemo(
    () => filterSubjects(tab === 'edge' ? split.edges : split.nodes, idx, { q, onlyMissing, feature: feature ?? undefined, missingFor }),
    [split, tab, idx, q, onlyMissing, feature, missingFor],
  )
  const groups = useMemo(() => groupNodes(rows, ARCHETYPE_LABEL), [rows])
  const tableRows = useMemo(() => {
    const nameOf = (id: string) => list.find((x) => x.subject === id)?.name ?? id
    const labelOf = (id: string, g: string) => {
      const l = list.find((x) => x.subject === id)?.signals.find((y) => y.name === g)?.label ?? g
      return l.charAt(0).toLowerCase() + l.slice(1)
    }
    const status = (sub: string, sig: string) => idx.get(statusKey(sub, sig))?.status
    const value = (sub: string, sig: string) => {
      const kind = list.find((x) => x.subject === sub)?.signals.find((y) => y.name === sig)?.kind ?? 'number'
      return liveValue(sig, kind, snapshot?.subjects[sub])
    }
    return bindingRows(bindings.data ?? [], list, (b) => describeBinding(b, nameOf, labelOf), status, value)
  }, [bindings.data, list, idx, snapshot])
  const shownSources = useMemo(() => filterRows(sources, srcQ, (s) => [s.source, s.desc]), [sources, srcQ])

  if (subjects.isLoading || bindings.isLoading) return <Loading />
  if (subjects.error) {
    return <PageBody><PageHeader icon={Plug} title="Kết nối dữ liệu" subtitle={model} /><ErrorBox error={subjects.error} /></PageBody>
  }

  const open = (d: BindingDraft) => setDraft({ d, existing: d.subject && d.signal ? bound.get(`${d.subject}|${d.signal}`) : undefined })
  const editBinding = (b: Binding) => setDraft({ d: { subject: b.subject, signal: b.signal, source: b.source, json_path: b.json_path, transform: b.transform, mode: b.mode, derive: b.derive ?? undefined }, existing: b })

  /** Chọn một chức năng còn thiếu: lọc theo nó và chuyển sang tab (Node hoặc Đường nối) có những tín hiệu đó. */
  const pickFeature = (f: string | null) => {
    setFeature(f)
    if (!f) return
    const missing = coverage.data?.readiness.find((r) => r.feature === f)?.missing ?? []
    const kinds = new Set(missing.map((m) => list.find((x) => x.subject === m.subject)?.kind))
    if (kinds.size > 0 && !kinds.has(tab === 'node' ? 'node' : 'edge')) setTab(kinds.has('edge') ? 'edge' : 'node')
  }

  const renderRow = (s: SubjectView) => (
    <li key={s.subject} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
      <div className="flex w-56 min-w-0 items-center gap-2.5">
        <NodeAvatar archetype={s.kind === 'node' ? s.archetype : undefined} icon={s.kind === 'edge' ? (s.mode === 'POOL' ? 'truck' : 'route') : iconOfType(s.node_type ? typeByCode.get(s.node_type) : undefined)} size={28} />
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-text">{s.name}</div>
          <div className="truncate text-[10.5px] text-faint">{s.subject}{s.kind === 'edge' && s.material ? ` · ${s.material}${s.mode === 'POOL' ? ' · bằng xe' : ''}` : ''}</div>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
        {s.signals.length === 0 && <span className="text-[11px] text-lock-text">Chưa có tín hiệu nào để ghép{s.archetype === 'STORAGE' ? ': kho chưa khai báo vật tư ở tab Sơ đồ.' : '.'}</span>}
        {s.signals.map((sg) => {
          const b = bound.get(`${s.subject}|${sg.name}`)
          const cov = idx.get(statusKey(s.subject, sg.name))
          const status = cov?.status ?? (b ? (b.mode === 'derived' ? 'derived' : 'source') : 'missing')
          const snap = snapshot?.subjects[s.subject]
          const val = isBound(status) ? liveValue(sg.name, sg.kind, snap) : undefined
          const fresh = snap !== undefined && snap.age_ms < STALE_MS
          const title =
            status === 'broken' ? cov?.reason ?? 'Ghép nối hỏng'
            : status === 'derived' ? `Tự tính: ${cov?.reason ?? 'bấm để xem công thức'}`
            : b && status === 'source' ? `${b.source} → ${b.json_path || '(cả bản tin)'}`
            : cov?.reason ?? (cov?.suggestions?.length ? 'Chưa có: bấm để ghép, có gợi ý tự tính' : 'Chưa có: bấm để ghép')
          return (
            <SignalChip
              key={sg.name} label={sg.label} status={status} value={val} fresh={fresh} title={title}
              suggested={(cov?.suggestions?.length ?? 0) > 0}
              onClick={() => (b ? editBinding(b) : open({ subject: s.subject, signal: sg.name }))}
            />
          )
        })}
      </div>
    </li>
  )

  return (
    <PageBody wide>
      <PageHeader icon={Plug}
        title="Kết nối dữ liệu"
        subtitle={model}
        actions={
          <>
            <button className={btnPrimary} disabled={suggestion.suggestions.length === 0} onClick={() => setSuggestOpen(true)}>
              <Sparkles size={12} /> Gợi ý ghép tự động{suggestion.suggestions.length > 0 ? ` (${suggestion.suggestions.length})` : ''}
            </button>
            <button className={btn} disabled={(edgePlan.data?.items.length ?? 0) === 0} onClick={() => setPlanOpen(true)} title="Tính lượng hàng trên các đường nối chưa có dữ liệu từ bộ đếm của máy và tồn kho">
              <Waypoints size={12} /> Tự suy đường nối{(edgePlan.data?.items.length ?? 0) > 0 ? ` (${edgePlan.data!.items.length})` : ''}
            </button>
            <button className={btn} onClick={() => open({})}><Plus size={12} /> Ghép thủ công</button>
            <button className={btnDangerOutline} disabled={(bindings.data ?? []).length === 0} onClick={() => setConfirmClear(true)}>Xoá mọi ghép nối</button>
          </>
        }
      />
      <FeedControl model={model} />
      <Notice>
        Chỉ ra <b>bản tin nào, trường nào</b> ứng với <b>tín hiệu nào</b> của node hay đường nối. Bấm một ô tín hiệu để ghép, hoặc dùng Gợi ý ghép tự động.
        <div className="mt-1 text-faint">
          Tín hiệu của một <b>node</b> là tín hiệu của chính thiết bị: ghép ở đây thì mọi mô hình có thiết bị đó đều dùng, và xem lại được ở{' '}
          <Link to="/assets/signals" className="text-accent underline">Tín hiệu thiết bị</Link>. Tín hiệu của <b>đường nối</b> chỉ thuộc mô hình này.
        </div>
      </Notice>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Tag>Đã có {boundSignals}/{totalSignals} tín hiệu</Tag>
        {(coverage.data?.summary.derived ?? 0) > 0 && <Tag>{coverage.data!.summary.derived} tự tính</Tag>}
        {(coverage.data?.summary.broken ?? 0) > 0 && <Tag>{coverage.data!.summary.broken} hỏng</Tag>}
        <Tag>{sources.length} nguồn, {liveSources} đang phát, {sources.filter((s) => s.bindings.length === 0).length} chưa ghép</Tag>
        {snapshot && snapshot.now > '0002' && <Tag>Giờ nhà máy {fmtFactoryTime(snapshot.now)}</Tag>}
      </div>
      <ReadinessBar report={coverage.data} active={feature} onPick={pickFeature} />
      {(snapshot?.errors.length ?? 0) > 0 && (
        <Notice tone="lock">
          <div className="font-medium">Có ghép nối đang lỗi, dữ liệu của các tín hiệu này chưa vào được:</div>
          <ul className="mt-1 list-disc pl-5">
            {snapshot!.errors.slice(-5).map((e) => <li key={e.message}>{e.message} <span className="text-faint">(×{e.count})</span></li>)}
          </ul>
        </Notice>
      )}
      {(coverage.data?.problems.length ?? 0) > 0 && (
        <Notice tone="lock">
          <div className="font-medium">Cần xem lại ({coverage.data!.problems.length}):</div>
          <ul className="mt-1 list-disc pl-5">
            {coverage.data!.problems.slice(0, 5).map((p) => <li key={`${p.subject}|${p.signal}|${p.message}`}>{p.message}</li>)}
          </ul>
          {coverage.data!.problems.length > 5 && <div className="mt-1 text-faint">…và {coverage.data!.problems.length - 5} mục khác.</div>}
        </Notice>
      )}
      {orphans.length > 0 && (
        <Notice tone="lock">
          {orphans.length} ghép nối trỏ tới node hoặc edge không còn trong sơ đồ: {orphans.map((o) => `${o.subject}/${o.signal}`).join(', ')}. Chúng bị bỏ qua khi nhận dữ liệu.
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card
          title="Sơ đồ"
          actions={
            tab === 'all' ? undefined : (
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-[11px] text-muted">
                  <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> Chỉ chưa ghép đủ
                </label>
                <SearchBox value={q} onChange={setQ} placeholder={tab === 'node' ? 'Tìm node' : 'Tìm đường nối'} />
              </div>
            )
          }
        >
          <div role="tablist" aria-label="Loại đối tượng" className="-mt-1 mb-3 flex gap-5 border-b border-line">
            {([['node', `Node (${split.nodes.length})`], ['edge', `Đường nối (${split.edges.length})`], ['all', `Tất cả ghép nối (${(bindings.data ?? []).length})`]] as const).map(([t, label]) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                className={`-mb-px border-b-2 pb-1.5 text-xs font-medium ${tab === t ? 'border-text font-semibold text-text' : 'border-transparent text-muted hover:text-text'}`}>
                {label}
              </button>
            ))}
          </div>
          {tab !== 'all' && <p className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-faint">
            <span><i className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-ok" />lấy từ thiết bị</span>
            <span><b className="mr-1 font-semibold text-accent">Σ</b>tự tính từ tín hiệu khác</span>
            <span><b className="mr-1 font-semibold">+</b>chưa có</span>
            <span><b className="mr-1 font-semibold text-bad-text">✕</b>hỏng, bấm để xem lý do</span>
          </p>}
          {tab === 'all' ? (
            <BindingsTable model={model} rows={tableRows} coverage={idx} snapshot={snapshot} onEdit={editBinding} />
          ) : rows.length === 0 ? (
            <EmptyState title="Không có gì để hiện">
              {feature ? 'Không còn tín hiệu nào thiếu cho chức năng này.' : tab === 'node' ? 'Đổi bộ lọc, hoặc mô hình chưa có node nào.' : 'Đổi bộ lọc, hoặc sơ đồ chưa có đường nối nào.'}
            </EmptyState>
          ) : tab === 'node' ? (
            <div className="space-y-3">
              {groups.map((g) => (
                <section key={g.key}>
                  <h3 className="mb-0.5 text-[11px] font-semibold text-muted">{g.title} <span className="font-normal text-faint">{g.subjects.length}</span></h3>
                  <ul className="divide-y divide-line">{g.subjects.map((s) => renderRow(s))}</ul>
                </section>
              ))}
            </div>
          ) : (
            <ul className="divide-y divide-line">{rows.map((s) => renderRow(s))}</ul>
          )}
        </Card>

        <Card
          title={`Nguồn dữ liệu (${sources.length})`}
          actions={<div className="flex items-center gap-2"><Link className="text-[11px] text-accent underline decoration-dotted" to="/assets/sources">Quản lý nguồn</Link><SearchBox value={srcQ} onChange={setSrcQ} placeholder="Tìm nguồn" /></div>}
        >
          {sources.length === 0 ? (
            <EmptyState title="Chưa có nguồn dữ liệu nào">Bật feed ở thanh phía trên để các thiết bị gửi bản tin, hoặc khai báo nguồn ở Thiết bị → Nguồn dữ liệu.</EmptyState>
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
          open model={model} subjects={list} sources={sources} coverage={idx} live={snapshot} draft={draft.d} existing={draft.existing} onClose={() => setDraft(null)}
        />
      )}
      {planOpen && edgePlan.data && <EdgePlanDialog open model={model} plan={edgePlan.data} subjects={list} onClose={() => setPlanOpen(false)} />}
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
