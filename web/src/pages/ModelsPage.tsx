import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { ModelSummary } from '../api/types'
import { DeleteAction } from '../components/DeleteAction'
import { DataTable, type Column } from '../components/table/DataTable'
import { EmptyState, ErrorBox, Loading, PageBody, PageHeader, SearchBox, btn, btnPrimary, input } from '../components/ui'
import { fmtDateTime, versionStatusLabel } from '../lib/format'
import { filterRows } from '../lib/table'

const BASE_COLUMNS: Column<ModelSummary>[] = [
  { key: 'model', header: 'Mô hình', cell: (m) => <span className="font-medium text-text">{m.model_key}</span>, sort: (m) => m.model_key },
  { key: 'version', header: 'Version mới nhất', cell: (m) => `v${m.latest_version}`, sort: (m) => m.latest_version },
  { key: 'status', header: 'Trạng thái', cell: (m) => versionStatusLabel(m.status), sort: (m) => m.status },
  { key: 'scenarios', header: 'Scenario', cell: (m) => m.scenarios, sort: (m) => m.scenarios, align: 'right' },
  { key: 'runs', header: 'Lần chạy', cell: (m) => m.runs, sort: (m) => m.runs, align: 'right' },
  { key: 'last', header: 'Chạy gần nhất', cell: (m) => fmtDateTime(m.last_run_at), sort: (m) => (m.last_run_at ? Date.parse(m.last_run_at) : null) },
]

export default function ModelsPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const models = useQuery({ queryKey: ['models'], queryFn: api.models })
  const [q, setQ] = useState('')
  const [key, setKey] = useState('')
  const [creating, setCreating] = useState(false)
  const create = useMutation({
    mutationFn: () => api.createModel(key.trim()),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['models'] })
      navigate(`/versions/${r.version_id}`)
    },
  })
  if (models.isLoading) return <Loading />
  const rows = filterRows(models.data ?? [], q, (m) => [m.model_key])
  const columns: Column<ModelSummary>[] = [
    ...BASE_COLUMNS,
    {
      key: 'del',
      header: '',
      align: 'right',
      cell: (m) => (
        <div className="flex justify-end">
          <DeleteAction
            what={`mô hình ${m.model_key}`}
            run={(cascade) => api.deleteModel(m.model_key, cascade)}
            onDone={() => void qc.invalidateQueries({ queryKey: ['models'] })}
          />
        </div>
      ),
    },
  ]
  return (
    <PageBody>
      <PageHeader
        title="Mô hình"
        subtitle={models.data ? `${models.data.length} mô hình` : undefined}
        actions={
          <>
            <SearchBox value={q} onChange={setQ} placeholder="Tìm mô hình" />
            <button className={btnPrimary} onClick={() => setCreating(!creating)}>Tạo mô hình</button>
          </>
        }
      />
      {creating && (
        <form
          className="flex items-center gap-2 rounded-xl border border-line bg-panel p-3"
          onSubmit={(e) => { e.preventDefault(); if (key.trim()) create.mutate() }}
        >
          <input autoFocus className={`${input} w-72`} aria-label="Tên mô hình" placeholder="vd: denso-line-3" value={key} onChange={(e) => setKey(e.target.value)} />
          <button className={btnPrimary} disabled={!key.trim() || create.isPending}>Tạo</button>
          <button type="button" className={btn} onClick={() => setCreating(false)}>Huỷ</button>
        </form>
      )}
      <ErrorBox error={models.error ?? create.error} />
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(m) => m.model_key}
        onRowClick={(m) => navigate(`/versions/${m.latest_version_id}`)}
        initialSort={{ key: 'model', dir: 'asc' }}
        empty={
          <EmptyState title={q ? 'Không có mô hình khớp' : 'Chưa có mô hình nào'}>
            {q ? 'Thử từ khoá khác.' : 'Bấm "Tạo mô hình", đặt tên rồi dựng sơ đồ nhà máy ở tab Sơ đồ.'}
          </EmptyState>
        }
      />
    </PageBody>
  )
}
