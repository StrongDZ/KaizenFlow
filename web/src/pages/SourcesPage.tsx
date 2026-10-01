import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { DataSourceRow, SourceTestResult } from '../api/types'
import { Trash2 } from 'lucide-react'
import { DeleteDialog } from '../components/DeleteAction'
import { FeedControl } from '../components/live/FeedControl'
import { SampleTree } from '../components/live/SampleTree'
import { SourceDialog } from '../components/live/SourceDialog'
import { PeekHost, SidePeek, usePeekParam } from '../components/SidePeek'
import { DataTable, type Column } from '../components/table/DataTable'
import { EmptyState, ErrorBox, Loading, Notice, PageBody, PageHeader, SearchBox, Tag, btn, btnPrimary } from '../components/ui'
import { ageText, parseSample, rateText, summarizeSources } from '../lib/sourceView'
import { filterRows } from '../lib/table'

const COLUMNS: Column<DataSourceRow>[] = [
  {
    key: 'live', header: 'Trạng thái', sort: (r) => (r.live ? 0 : 1),
    cell: (r) => (
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <i className={`h-2 w-2 rounded-full ${r.live ? 'animate-pulse bg-ok' : 'bg-faint'}`} />
        {r.live ? 'Đang phát' : 'Im lặng'}
      </span>
    ),
  },
  {
    key: 'source', header: 'Nguồn', sort: (r) => r.source,
    cell: (r) => (
      <span className="block min-w-0">
        <span className="block truncate font-mono text-[11.5px] text-text">{r.source}</span>
        <span className="block truncate text-[10.5px] text-muted">{r.desc || 'không có mô tả'}</span>
      </span>
    ),
  },
  { key: 'rate', header: 'Tốc độ', cell: (r) => (r.live ? rateText(r.per_min) : '—'), sort: (r) => (r.live ? r.per_min : 0), align: 'right' },
  { key: 'age', header: 'Nhận lần cuối', cell: (r) => ageText(r.age_ms), sort: (r) => r.age_ms },
  {
    key: 'bound', header: 'Đã ghép', sort: (r) => r.bindings.length,
    cell: (r) => (r.bindings.length > 0 ? `${r.bindings.length} tín hiệu` : <span className="text-lock-text">Chưa ghép</span>),
  },
  { key: 'origin', header: 'Loại', cell: (r) => <Tag>{r.origin === 'manual' ? 'Khai báo tay' : 'Tự ghi nhận'}</Tag>, sort: (r) => r.origin },
]

export default function SourcesPage() {
  const model = decodeURIComponent(useParams().key ?? '')
  const qc = useQueryClient()
  const sources = useQuery({ queryKey: ['sources', model], queryFn: () => api.sources(model), refetchInterval: 4000 })
  const subjects = useQuery({ queryKey: ['live-subjects', model], queryFn: () => api.liveSubjects(model), retry: false })
  const [q, setQ] = useState('')
  const [selected, setSelected] = usePeekParam()
  const [adding, setAdding] = useState(false)
  const names = useMemo(() => Object.fromEntries((subjects.data?.subjects ?? []).map((s) => [s.subject, s.name])), [subjects.data])
  const list = useMemo(() => sources.data ?? [], [sources.data])
  const rows = useMemo(() => filterRows(list, q, (r) => [r.source, r.desc]), [list, q])
  const chosen = list.find((r) => r.source === selected)
  const sum = summarizeSources(list)
  if (sources.isLoading) return <Loading />
  return (
    <PeekHost
      onClose={() => setSelected(null)}
      peek={chosen ? <SourceDetail key={chosen.source} model={model} row={chosen} names={names} onGone={() => setSelected(null)} onClose={() => setSelected(null)} /> : null}
    >
    <PageBody wide>
      <PageHeader
        title="Nguồn dữ liệu"
        subtitle={model}
        actions={
          <>
            <SearchBox value={q} onChange={setQ} placeholder="Tìm nguồn" />
            <button className={btnPrimary} onClick={() => setAdding(true)}><Plus size={12} /> Thêm nguồn</button>
          </>
        }
      />
      <FeedControl model={model} />
      <Notice>
        Nguồn là thiết bị hoặc topic gửi bản tin thô (PLC máy dập, hệ thống kho…). Hệ thống ghi nhớ mọi nguồn đã từng gửi bản tin, kể cả khi thiết bị đã tắt.
        Muốn đưa dữ liệu của một nguồn vào sơ đồ, sang tab <Link className="underline decoration-dotted" to={`/models/${encodeURIComponent(model)}/connect`}>Kết nối dữ liệu</Link> để chọn trường của nguồn và ghép vào tín hiệu của node hay đường nối.
      </Notice>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Tag>{sum.total} nguồn</Tag>
        <Tag>{sum.live} đang phát</Tag>
        <Tag>{sum.unbound} chưa ghép</Tag>
      </div>
      <ErrorBox error={sources.error} />
      <DataTable
        rows={rows} columns={COLUMNS} rowKey={(r) => r.source} onRowClick={(r) => setSelected(r.source)} selected={(r) => r.source === selected}
        initialSort={{ key: 'source', dir: 'asc' }}
        empty={
          <div className="rounded-xl border border-line">
            <EmptyState title={q ? 'Không có nguồn khớp' : 'Chưa có nguồn nào'}>
              {q ? 'Thử từ khoá khác.' : 'Bật feed ở thanh phía trên để các thiết bị giả lập bắt đầu gửi bản tin, hoặc bấm "Thêm nguồn" để khai báo một nguồn bằng tay.'}
            </EmptyState>
          </div>
        }
      />
      {adding && (
        <SourceDialog
          model={model} existing={list.map((r) => r.source)} onClose={() => setAdding(false)}
          onCreated={(s) => { setAdding(false); setSelected(s); void qc.invalidateQueries({ queryKey: ['sources', model] }) }}
        />
      )}
    </PageBody>
    </PeekHost>
  )
}

function SourceDetail({ model, row, names, onGone, onClose }: { model: string; row: DataSourceRow; names: Record<string, string>; onGone: () => void; onClose: () => void }) {
  const qc = useQueryClient()
  const [payload, setPayload] = useState(() => (row.sample === null || row.sample === undefined ? '{\n  \n}' : JSON.stringify(row.sample, null, 2)))
  const [result, setResult] = useState<SourceTestResult | null>(null)
  const [deleting, setDeleting] = useState(false)
  const parsed = parseSample(payload)
  const test = useMutation({
    mutationFn: () => api.testSource(model, { source: row.source, payload: parsed.ok ? parsed.value : undefined }),
    onSuccess: setResult,
  })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['sources', model] })
    void qc.invalidateQueries({ queryKey: ['bindings', model] })
    void qc.invalidateQueries({ queryKey: ['live', model] })
  }
  return (
    <SidePeek
      title="Chi tiết nguồn dữ liệu" heading={<span className="font-mono">{row.source}</span>} onClose={onClose}
      subtitle={<><i className={`h-2 w-2 rounded-full ${row.live ? 'bg-ok' : 'bg-faint'}`} />{row.live ? 'Đang phát' : 'Im lặng'}</>}
      menu={[{ key: 'delete', label: 'Xoá nguồn', icon: Trash2, danger: true, onSelect: () => setDeleting(true) }]}
    >
      <DeleteDialog
        open={deleting} onClose={() => setDeleting(false)} what={`nguồn ${row.source}`} run={(cascade) => api.deleteSource(model, row.source, cascade)}
        onDone={() => { refresh(); onGone() }}
      />
      <div className="space-y-4 text-xs">
        <div className="space-y-0.5 text-text-2">
          <p>{row.desc || 'Không có mô tả.'}</p>
          <p className="text-muted">
            {row.live ? 'Đang phát' : 'Im lặng'} · nhận lần cuối {ageText(row.age_ms)} · {row.count.toLocaleString('vi-VN')} bản tin từ khi ghi nhận ·{' '}
            {row.origin === 'manual' ? 'khai báo tay' : 'tự ghi nhận'}
          </p>
        </div>
        <section>
          <h3 className="mb-1 font-semibold text-text">Đang dùng cho ({row.bindings.length})</h3>
          {row.bindings.length === 0 ? (
            <p className="text-muted">
              Chưa có tín hiệu nào lấy dữ liệu từ nguồn này.{' '}
              <Link className="text-accent underline decoration-dotted" to={`/models/${encodeURIComponent(model)}/connect`}>Sang Kết nối dữ liệu để ghép</Link>.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {row.bindings.map((b) => (
                <li key={`${b.subject}|${b.signal}`} className="text-text-2"><b className="font-medium text-text">{names[b.subject] ?? b.subject}</b> · {b.signal}</li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3 className="mb-1 font-semibold text-text">Bản tin mẫu</h3>
          <div className="max-h-56 overflow-y-auto rounded-lg border border-line bg-panel-2 px-2"><SampleTree sample={row.sample} /></div>
        </section>
        <section className="space-y-1.5">
          <h3 className="font-semibold text-text">Gửi thử</h3>
          <p className="text-muted">Chạy một bản tin qua các ghép nối của mô hình để xem tín hiệu nào nhận giá trị gì. Không ghi vào dữ liệu live.</p>
          <textarea className="w-full rounded-lg border border-line-2 bg-panel-2 p-2 font-mono text-[11.5px] text-text" rows={6} spellCheck={false} aria-label="Bản tin gửi thử"
            value={payload} onChange={(e) => { setPayload(e.target.value); setResult(null) }} />
          {!parsed.ok && <p role="alert" className="text-bad-text">{parsed.error}</p>}
          <button className={btn} disabled={!parsed.ok || test.isPending} onClick={() => test.mutate()}>Gửi thử bản tin này</button>
          <ErrorBox error={test.error} />
          {result && (
            <div className="space-y-1 rounded-lg border border-line bg-panel-2 p-2">
              <p className="text-text-2">
                {result.matched === 0 ? 'Chưa có ghép nối nào dùng nguồn này.' : `${result.matched} ghép nối khớp nguồn này, ${result.readings.length} cho ra giá trị.`}
              </p>
              {result.readings.map((r) => (
                <p key={`${r.subject}|${r.signal}`} className="text-text"><b className="font-medium">{names[r.subject] ?? r.subject}</b> · {r.signal} = <b className="tabular-nums">{r.text ?? (r.value === undefined ? '—' : String(r.value).replace('.', ','))}</b></p>
              ))}
              {result.errors.map((e) => <p key={e} className="text-bad-text">{e}</p>)}
            </div>
          )}
        </section>
      </div>
    </SidePeek>
  )
}
