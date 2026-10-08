import { useQuery } from '@tanstack/react-query'
import { Package } from 'lucide-react'
import { ItemIdentity } from '../components/NodeIdentity'
import { useState } from 'react'
import { api } from '../api/client'
import type { Material } from '../api/types'
import { MaterialDetail } from '../components/detail/MaterialDetail'
import { MaterialCreateDialog } from '../components/library/MaterialCreateDialog'
import { PeekHost, usePeekParam } from '../components/SidePeek'
import { DataTable, type Column } from '../components/table/DataTable'
import { EmptyState, ErrorBox, Loading, PageBody, PageHeader, SearchBox, btnPrimary } from '../components/ui'
import { usedIn } from '../lib/format'
import { filterRows } from '../lib/table'

const COLUMNS: Column<Material>[] = [
  { key: 'name', header: 'Vật tư', cell: (m) => <ItemIdentity icon={Package} name={m.name || m.code} code={m.name ? m.code : undefined} color="var(--color-role-storage)" />, sort: (m) => m.name || m.code },
  { key: 'unit', header: 'Đơn vị', cell: (m) => m.unit, sort: (m) => m.unit },
  { key: 'used', header: 'Dùng trong', cell: (m) => usedIn(m.used_in_versions), sort: (m) => m.used_in_versions ?? 0 },
]

export default function MaterialsPage() {
  const mats = useQuery({ queryKey: ['materials'], queryFn: api.materials })
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [peek, setPeek] = usePeekParam()
  if (mats.isLoading) return <Loading />
  const rows = filterRows(mats.data ?? [], q, (m) => [m.name, m.code])
  return (
    <PeekHost onClose={() => setPeek(null)} peek={peek ? <MaterialDetail key={peek} code={peek} variant="peek" onClose={() => setPeek(null)} /> : null}>
    <PageBody>
      <PageHeader icon={Package}
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
          onCreated={(code) => { setCreating(false); setPeek(code) }}
        />
      )}
      <ErrorBox error={mats.error} />
      <DataTable
        rows={rows}
        columns={COLUMNS}
        rowKey={(m) => m.code}
        onRowClick={(m) => setPeek(m.code)}
        selected={(m) => m.code === peek}
        initialSort={{ key: 'name', dir: 'asc' }}
        empty={<EmptyState title={q ? 'Không có vật tư khớp' : 'Chưa có vật tư nào'}>{q ? 'Thử từ khoá khác.' : 'Bấm "Tạo vật tư" để thêm mã vật tư dùng trong sơ đồ.'}</EmptyState>}
      />
    </PageBody>
    </PeekHost>
  )
}
