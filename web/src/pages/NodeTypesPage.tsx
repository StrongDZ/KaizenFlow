import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { Archetype, NodeType } from '../api/types'
import { ARCHETYPE_LABEL } from '../components/KfNode'
import { DataTable, type Column } from '../components/table/DataTable'
import { EmptyState, ErrorBox, FilterChip, Loading, PageBody, PageHeader, SearchBox, Tag, btnPrimary } from '../components/ui'
import { usedIn } from '../lib/format'
import { filterRows } from '../lib/table'

const COLUMNS: Column<NodeType>[] = [
  { key: 'name', header: 'Tên', cell: (t) => <span className="font-medium text-text">{t.name}</span>, sort: (t) => t.name },
  { key: 'code', header: 'Mã', cell: (t) => <span className="text-muted">{t.code}</span>, sort: (t) => t.code },
  { key: 'arch', header: 'Loại', cell: (t) => <Tag>{ARCHETYPE_LABEL[t.archetype]}</Tag>, sort: (t) => t.archetype },
  { key: 'used', header: 'Dùng trong', cell: (t) => usedIn(t.used_in_versions), sort: (t) => t.used_in_versions ?? 0 },
  { key: 'src', header: 'Nguồn gốc', cell: (t) => (t.is_builtin ? 'Có sẵn' : 'Tự tạo'), sort: (t) => (t.is_builtin ? 0 : 1) },
]

export default function NodeTypesPage() {
  const navigate = useNavigate()
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  const [q, setQ] = useState('')
  const [arch, setArch] = useState<Archetype | 'ALL'>('ALL')
  const all = useMemo(() => types.data ?? [], [types.data])
  const rows = filterRows(all.filter((t) => arch === 'ALL' || t.archetype === arch), q, (t) => [t.name, t.code])
  if (types.isLoading) return <Loading />
  const count = (a: Archetype) => all.filter((t) => t.archetype === a).length
  return (
    <PageBody>
      <PageHeader title="Loại node" subtitle={`${all.length} loại`} actions={<Link className={btnPrimary} to="/library/node-types/new">Tạo loại node</Link>} />
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} />
        <FilterChip active={arch === 'ALL'} onClick={() => setArch('ALL')}>Tất cả {all.length}</FilterChip>
        {(Object.keys(ARCHETYPE_LABEL) as Archetype[]).map((a) => (
          <FilterChip key={a} active={arch === a} onClick={() => setArch(a)}>{ARCHETYPE_LABEL[a]} {count(a)}</FilterChip>
        ))}
      </div>
      <ErrorBox error={types.error} />
      <DataTable
        rows={rows}
        columns={COLUMNS}
        rowKey={(t) => t.code}
        onRowClick={(t) => navigate(`/library/node-types/${encodeURIComponent(t.code)}`)}
        empty={<EmptyState title="Không có loại node khớp">Thử từ khoá hoặc bộ lọc khác, hoặc bấm "Tạo loại node".</EmptyState>}
      />
    </PageBody>
  )
}
