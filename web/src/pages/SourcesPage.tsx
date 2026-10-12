import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Database, Cpu, Warehouse, Truck, Factory, Gauge, Radio, PencilLine, Radar, Trash2, type LucideIcon } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { SourceBindingRef, SourceRow, SourceTestResult } from '../api/types'
import { DeleteDialog } from '../components/DeleteAction'
import { SampleTree } from '../components/live/SampleTree'
import { SourceDialog } from '../components/live/SourceDialog'
import { PeekHost, SidePeek, usePeekParam } from '../components/SidePeek'
import { ItemIdentity } from '../components/NodeIdentity'
import { DataTable, type Column } from '../components/table/DataTable'
import { EmptyState, ErrorBox, Loading, Notice, PageBody, PageHeader, SearchBox, Tag, btn, btnPrimary } from '../components/ui'
import { ageText, parseSample, rateText, sourceKind, summarizeSources, type SourceKind } from '../lib/sourceView'
import { filterRows } from '../lib/table'

const SOURCE_ICON: Record<SourceKind, LucideIcon> = { machine: Cpu, stock: Warehouse, fleet: Truck, line: Factory, sensor: Gauge, other: Radio }

/** Mô hình đang dùng nguồn: hai cái đầu, còn lại gộp thành "+n". */
const modelsText = (ms: string[]) => (ms.length <= 2 ? ms.join(', ') : `${ms.slice(0, 2).join(', ')} +${ms.length - 2}`)

const COLUMNS: Column<SourceRow>[] = [
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
      <ItemIdentity icon={SOURCE_ICON[sourceKind(r.source)]} name={r.source} code={r.desc || 'không có mô tả'} color={r.live ? 'var(--color-accent)' : 'var(--color-muted)'} />
    ),
  },
  { key: 'rate', header: 'Tốc độ', cell: (r) => (r.live ? rateText(r.per_min) : '—'), sort: (r) => (r.live ? r.per_min : 0), align: 'right' },
  { key: 'age', header: 'Nhận lần cuối', cell: (r) => ageText(r.age_ms), sort: (r) => r.age_ms },
  {
    key: 'bound', header: 'Đã ghép', sort: (r) => r.bindings.length,
    cell: (r) => (r.bindings.length > 0 ? `${r.bindings.length} tín hiệu` : <span className="text-lock-text">Chưa ghép</span>),
  },
  {
    key: 'models', header: 'Dùng ở', sort: (r) => r.models.length,
    cell: (r) => (r.models.length > 0 ? <span className="text-text-2" title={r.models.join(', ')}>{modelsText(r.models)}</span> : <span className="text-faint">chưa mô hình nào</span>),
  },
  { key: 'origin', header: 'Loại', cell: (r) => <Tag icon={r.origin === 'manual' ? PencilLine : Radar}>{r.origin === 'manual' ? 'Khai báo tay' : 'Tự ghi nhận'}</Tag>, sort: (r) => r.origin },
]

/**
 * Nguồn dữ liệu (mục Thiết bị): một nguồn là một thiết bị hay topic ngoài đời, dùng chung cho mọi mô hình.
 * Xoá hay khai báo ở đây là cho cả app; trang Kết nối dữ liệu của mô hình chỉ lọc ra những nguồn mô hình đó cần.
 */
export default function SourcesPage() {
  const sources = useQuery({ queryKey: ['all-sources'], queryFn: api.allSources, refetchInterval: 4000 })
  const assets = useQuery({ queryKey: ['assets'], queryFn: api.assets })
  const [q, setQ] = useState('')
  const [selected, setSelected] = usePeekParam()
  const [adding, setAdding] = useState(false)
  const names = useMemo(() => Object.fromEntries((assets.data ?? []).map((a) => [a.key, a.name || a.key])), [assets.data])
  const list = useMemo(() => sources.data ?? [], [sources.data])
  const rows = useMemo(() => filterRows(list, q, (r) => [r.source, r.desc, ...r.models]), [list, q])
  const chosen = list.find((r) => r.source === selected)
  const sum = summarizeSources(list)
  if (sources.isLoading) return <Loading />
  return (
    <PeekHost
      onClose={() => setSelected(null)}
      peek={chosen ? <SourceDetail key={chosen.source} row={chosen} names={names} onGone={() => setSelected(null)} onClose={() => setSelected(null)} /> : null}
    >
    <PageBody wide>
      <PageHeader icon={Database}
        title="Nguồn dữ liệu"
        subtitle={`${sum.total} nguồn, ${sum.live} đang phát`}
        actions={
          <>
            <SearchBox value={q} onChange={setQ} placeholder="Tìm nguồn hoặc mô hình" />
            <button className={btnPrimary} onClick={() => setAdding(true)}><Plus size={12} /> Thêm nguồn</button>
          </>
        }
      />
      <Notice>
        Mỗi thiết bị hay topic từng gửi bản tin là một nguồn, kể cả khi đã tắt, và dùng chung cho mọi mô hình. Bước kế tiếp: ghép tín hiệu của thiết bị với nguồn ở{' '}
        <Link className="font-medium underline decoration-dotted" to="/assets/signals">Tín hiệu thiết bị</Link>; tín hiệu của đường nối ghép ở Kết nối dữ liệu của từng mô hình.
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
              {q
                ? 'Thử từ khoá khác.'
                : 'Nguồn tự hiện khi thiết bị gửi bản tin: bật feed giả lập ở màn Trực tiếp của một mô hình, hoặc chạy cầu nối đồng hồ. Thiết bị chưa phát thì bấm "Thêm nguồn" để khai báo bằng tay.'}
            </EmptyState>
          </div>
        }
      />
      {adding && (
        <SourceDialog
          existing={list.map((r) => r.source)} onClose={() => setAdding(false)}
          onCreated={(s) => { setAdding(false); setSelected(s) }}
        />
      )}
    </PageBody>
    </PeekHost>
  )
}

/** Một ghép nối dùng nguồn: tên thiết bị (hoặc mã đường nối) · tín hiệu, kèm mô hình nếu ghép nối thuộc riêng một mô hình. */
function RefLine({ name, signal, model, children }: { name: string; signal: string; model?: string; children?: ReactNode }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-text-2">
      <b className="font-medium text-text">{name}</b> · {signal}{children}
      {model ? <Tag>{model}</Tag> : <Tag tone="accent">dùng chung</Tag>}
    </span>
  )
}

function SourceDetail({ row, names, onGone, onClose }: { row: SourceRow; names: Record<string, string>; onGone: () => void; onClose: () => void }) {
  const qc = useQueryClient()
  const [payload, setPayload] = useState(() => (row.sample === null || row.sample === undefined ? '{\n  \n}' : JSON.stringify(row.sample, null, 2)))
  const [result, setResult] = useState<SourceTestResult | null>(null)
  const [deleting, setDeleting] = useState(false)
  const parsed = parseSample(payload)
  const test = useMutation({
    mutationFn: () => api.testSource({ source: row.source, payload: parsed.ok ? parsed.value : undefined }),
    onSuccess: setResult,
  })
  const refresh = () => {
    for (const key of ['all-sources', 'sources', 'bindings', 'asset-bindings', 'live']) void qc.invalidateQueries({ queryKey: [key] })
  }
  const nameOf = (r: Pick<SourceBindingRef, 'subject'>) => names[r.subject] ?? r.subject
  return (
    <SidePeek
      title="Chi tiết nguồn dữ liệu" heading={<span className="font-mono">{row.source}</span>} onClose={onClose}
      subtitle={<><i className={`h-2 w-2 rounded-full ${row.live ? 'bg-ok' : 'bg-faint'}`} />{row.live ? 'Đang phát' : 'Im lặng'}</>}
      summary={<><p>{row.desc || 'Không có mô tả.'}</p><p className="text-muted">Nhận lần cuối {ageText(row.age_ms)} · {row.count.toLocaleString('vi-VN')} bản tin từ khi ghi nhận · {row.origin === 'manual' ? 'khai báo tay' : 'tự ghi nhận'}</p></>}
      menu={[{ key: 'delete', label: 'Xoá nguồn', icon: Trash2, danger: true, onSelect: () => setDeleting(true) }]}
    >
      <DeleteDialog
        open={deleting} onClose={() => setDeleting(false)} what={`nguồn ${row.source}`} run={(cascade) => api.deleteSource(row.source, cascade)}
        onDone={() => { refresh(); onGone() }}
      />
      <div className="space-y-4 text-xs">
        <section>
          <h3 className="mb-1 font-semibold text-text">Đang dùng cho ({row.bindings.length})</h3>
          {row.bindings.length === 0 ? (
            <p className="text-muted">
              Chưa có tín hiệu nào lấy dữ liệu từ nguồn này.{' '}
              <Link className="text-accent underline decoration-dotted" to="/assets/signals">Ghép ở Tín hiệu thiết bị</Link>.
            </p>
          ) : (
            <ul className="space-y-1">
              {row.bindings.map((b) => (
                <li key={`${b.model ?? ''}|${b.subject}|${b.signal}`}><RefLine name={nameOf(b)} signal={b.signal} model={b.model} /></li>
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
          <p className="text-muted">Chạy một bản tin qua mọi ghép nối dùng nguồn này, của thiết bị lẫn đường nối ở mọi mô hình, để xem tín hiệu nào nhận giá trị gì. Không ghi vào dữ liệu live.</p>
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
                <p key={`${r.model ?? ''}|${r.subject}|${r.signal}`}>
                  <RefLine name={nameOf(r)} signal={r.signal} model={r.model}>
                    {' '}= <b className="tabular-nums text-text">{r.text ?? (r.value === undefined ? '—' : String(r.value).replace('.', ','))}</b>
                  </RefLine>
                </p>
              ))}
              {result.errors.map((e) => <p key={e} className="text-bad-text">{e}</p>)}
            </div>
          )}
        </section>
      </div>
    </SidePeek>
  )
}
