import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { InsightRow } from '../api/types'
import { DataTable, type Column } from '../components/table/DataTable'
import { EmptyState, ErrorBox, FilterChip, Loading, Notice, PageBody, PageHeader, SearchBox, Tag, btn } from '../components/ui'
import { KIND_LABEL, countByKind, filterAlerts, statusLabel } from '../lib/alertsView'
import { fmtDateTime } from '../lib/format'
import { describeInsight } from '../lib/insights'

const KINDS = ['ALL', 'RED_RISK', 'FAULT_RISK', 'BOTTLENECK', 'DRIFT', 'RECOMMENDATION'] as const
const STATUSES = [['OPEN', 'Đang mở'], ['ACK', 'Đã xem'], ['DONE', 'Đã xong'], ['ALL', 'Tất cả']] as const

/**
 * Mọi cảnh báo của hệ thống ở một chỗ: sắp Đỏ, nguy cơ hỏng, điểm nghẽn, lệch dự báo, đề xuất. Lọc theo loại và trạng thái,
 * đánh dấu đã xem, mở lần chạy sinh ra cảnh báo.
 */
export default function AlertsPage() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['insights', 'all'], queryFn: () => api.insights({ limit: 500 }), refetchInterval: 8000 })
  const [kind, setKind] = useState<string>('ALL')
  const [status, setStatus] = useState<string>('OPEN')
  const [q, setQ] = useState('')
  const ack = useMutation({ mutationFn: (id: number) => api.ackInsight(id), onSuccess: () => void qc.invalidateQueries({ queryKey: ['insights'] }) })
  const rows = useMemo(() => list.data ?? [], [list.data])
  const shown = useMemo(() => filterAlerts(rows, { kind, status, q }), [rows, kind, status, q])
  const byKind = useMemo(() => countByKind(filterAlerts(rows, { kind: 'ALL', status, q })), [rows, status, q])
  const open = rows.filter((r) => r.status === 'OPEN').length
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()

  const columns: Column<InsightRow>[] = [
    { key: 'kind', header: 'Loại', cell: (r) => <Tag>{KIND_LABEL[r.kind] ?? r.kind}</Tag>, sort: (r) => r.kind },
    {
      key: 'what', header: 'Nội dung',
      cell: (r) => <span className="block max-w-[520px] text-text">{describeInsight(r)}</span>,
    },
    { key: 'model', header: 'Mô hình', cell: (r) => <span className="whitespace-nowrap">{r.model_key} v{r.version}</span>, sort: (r) => r.model_key },
    { key: 'at', header: 'Phát hiện', cell: (r) => fmtDateTime(r.created_at), sort: (r) => Date.parse(r.created_at) },
    {
      key: 'status', header: 'Trạng thái', sort: (r) => r.status,
      cell: (r) => <span className={r.status === 'OPEN' ? 'font-medium text-text' : 'text-muted'}>{statusLabel(r.status)}</span>,
    },
    {
      key: 'act', header: '', align: 'right',
      cell: (r) => (
        <div className="flex justify-end gap-2" onClick={stop}>
          {r.sim_run_id !== null && <Link className={btn} to={`/runs/${r.sim_run_id}`}>Mở lần chạy</Link>}
          {r.status === 'OPEN' && <button className={btn} disabled={ack.isPending} onClick={() => ack.mutate(r.id)}>Đã xem</button>}
        </div>
      ),
    },
  ]

  if (list.isLoading) return <Loading />
  return (
    <PageBody wide>
      <PageHeader title="Cảnh báo" subtitle={`${open} đang mở`} actions={<SearchBox value={q} onChange={setQ} placeholder="Tìm đối tượng, mô hình" />} />
      <Notice>
        Cảnh báo sinh ra sau mỗi lần chạy mô phỏng (sắp Đỏ, nguy cơ hỏng, điểm nghẽn) và từ màn Trực tiếp (thực tế lệch dự báo). Bấm "Đã xem" khi bạn đã biết;
        cảnh báo không tự mất cho đến khi có kết quả mới thay thế.
      </Notice>
      <div className="flex flex-wrap items-center gap-2">
        {KINDS.map((k) => (
          <FilterChip key={k} active={kind === k} onClick={() => setKind(k)}>{k === 'ALL' ? 'Tất cả' : KIND_LABEL[k]} {byKind[k] ?? 0}</FilterChip>
        ))}
        <span className="mx-1 h-4 w-px bg-line-2" aria-hidden />
        {STATUSES.map(([s, label]) => <FilterChip key={s} active={status === s} onClick={() => setStatus(s)}>{label}</FilterChip>)}
      </div>
      <ErrorBox error={list.error ?? ack.error} />
      <DataTable
        rows={shown} columns={columns} rowKey={(r) => r.id} initialSort={{ key: 'at', dir: 'desc' }}
        empty={
          <div className="rounded-xl border border-line">
            <EmptyState title={rows.length === 0 ? 'Chưa có cảnh báo nào' : 'Không có cảnh báo khớp'}>
              {rows.length === 0 ? 'Chạy một scenario ở mô hình đã Publish, hoặc bật feed ở màn Trực tiếp, cảnh báo sẽ hiện ở đây.' : 'Đổi bộ lọc loại, trạng thái hoặc từ khoá.'}
            </EmptyState>
          </div>
        }
      />
    </PageBody>
  )
}
