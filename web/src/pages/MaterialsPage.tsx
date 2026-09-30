import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { Material } from '../api/types'
import { MaterialCreateDialog } from '../components/library/MaterialCreateDialog'
import { DataTable, type Column } from '../components/table/DataTable'
import { EmptyState, ErrorBox, Loading, PageBody, PageHeader, SearchBox, btnPrimary } from '../components/ui'
import { usedIn } from '../lib/format'
import { filterRows } from '../lib/table'

const COLUMNS: Column<Material>[] = [
  { key: 'name', header: 'Tên', cell: (m) => <span className="font-medium text-text">{m.name || m.code}</span>, sort: (m) => m.name || m.code },
  { key: 'code', header: 'Mã', cell: (m) => <span className="text-muted">{m.code}</span>, sort: (m) => m.code },
  { key: 'unit', header: 'Đơn vị', cell: (m) => m.unit, sort: (m) => m.unit },
  { key: 'used', header: 'Dùng trong', cell: (m) => usedIn(m.used_in_versions), sort: (m) => m.used_in_versions ?? 0 },
]

export default function MaterialsPage() {
  const navigate = useNavigate()
  const mats = useQuery({ queryKey: ['materials'], queryFn: api.materials })
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  if (mats.isLoading) return <Loading />
  const rows = filterRows(mats.data ?? [], q, (m) => [m.name, m.code])
  return (
    <PageBody>
      <PageHeader
        title="Vật tư"
        subtitle={mats.data ? `${mats.data.length} vật tư` : undefined}
        actions={
          <>
            <SearchBox value={q} onChange={setQ} />
            <button className={btnPrimary} onClick={() => setCreating(true)}>Tạo vật tư</button>
          </>
        }
      />
      {creating && (
        <MaterialCreateDialog
          onClose={() => setCreating(false)}
          onCreated={(code) => navigate(`/library/materials/${encodeURIComponent(code)}`)}
        />
      )}
      <ErrorBox error={mats.error} />
      <DataTable
        rows={rows}
        columns={COLUMNS}
        rowKey={(m) => m.code}
        onRowClick={(m) => navigate(`/library/materials/${encodeURIComponent(m.code)}`)}
        initialSort={{ key: 'code', dir: 'asc' }}
        empty={<EmptyState title={q ? 'Không có vật tư khớp' : 'Chưa có vật tư nào'}>{q ? 'Thử từ khoá khác.' : 'Bấm "Tạo vật tư" để thêm mã vật tư dùng trong sơ đồ.'}</EmptyState>}
      />
    </PageBody>
  )
}
