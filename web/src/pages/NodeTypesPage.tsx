import { useQuery } from '@tanstack/react-query'
import { Shapes } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { Archetype, NodeType } from '../api/types'
import { ARCHETYPE_LABEL } from '../components/KfNode'
import { NodeTypeDetail } from '../components/detail/NodeTypeDetail'
import { NodeIdentity, roleColor } from '../components/NodeIdentity'
import { PeekHost, usePeekParam } from '../components/SidePeek'
import { DataTable, type Column } from '../components/table/DataTable'
import { EmptyState, ErrorBox, FilterChip, Loading, PageBody, PageHeader, SearchBox, Tag, btnPrimary } from '../components/ui'
import { usedIn } from '../lib/format'
import { filterRows } from '../lib/table'

const COLUMNS: Column<NodeType>[] = [
  {
    key: 'name', header: 'Loại node', sort: (t) => t.name,
    cell: (t) => <NodeIdentity name={t.name} code={t.code} icon={typeof t.ui?.icon === 'string' ? t.ui.icon : undefined} archetype={t.archetype} size={30} />,
  },
  { key: 'arch', header: 'Vai trò', cell: (t) => <Tag color={roleColor(t.archetype)}>{ARCHETYPE_LABEL[t.archetype]}</Tag>, sort: (t) => t.archetype },
  { key: 'used', header: 'Dùng trong', cell: (t) => usedIn(t.used_in_versions), sort: (t) => t.used_in_versions ?? 0 },
  { key: 'src', header: 'Nguồn gốc', cell: (t) => (t.is_builtin ? 'Mẫu ban đầu' : 'Tự tạo'), sort: (t) => (t.is_builtin ? 0 : 1) },
]

export default function NodeTypesPage() {
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  const [peek, setPeek] = usePeekParam()
  const [q, setQ] = useState('')
  const [arch, setArch] = useState<Archetype | 'ALL'>('ALL')
  const all = useMemo(() => types.data ?? [], [types.data])
  const rows = filterRows(all.filter((t) => arch === 'ALL' || t.archetype === arch), q, (t) => [t.name, t.code])
  if (types.isLoading) return <Loading />
  const count = (a: Archetype) => all.filter((t) => t.archetype === a).length
  return (
    <PeekHost onClose={() => setPeek(null)} peek={peek ? <NodeTypeDetail key={peek} code={peek} variant="peek" onClose={() => setPeek(null)} /> : null}>
    <PageBody>
      <PageHeader icon={Shapes} title="Loại node" subtitle={`${all.length} loại`} actions={<Link className={btnPrimary} to="/library/node-types/new">Tạo loại node</Link>} />
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} />
        <FilterChip active={arch === 'ALL'} onClick={() => setArch('ALL')}>Tất cả {all.length}</FilterChip>
        {(Object.keys(ARCHETYPE_LABEL) as Archetype[]).map((a) => (
          <FilterChip key={a} active={arch === a} onClick={() => setArch(a)}>
            <i className="mr-1.5 inline-block h-2 w-2 rounded-full align-[1px]" style={{ background: roleColor(a) }} aria-hidden />{ARCHETYPE_LABEL[a]} <span className="tabular-nums opacity-70">{count(a)}</span>
          </FilterChip>
        ))}
      </div>
      <ErrorBox error={types.error} />
      <DataTable
        rows={rows}
        columns={COLUMNS}
        rowKey={(t) => t.code}
        onRowClick={(t) => setPeek(t.code)}
        selected={(t) => t.code === peek}
        empty={<EmptyState icon={Shapes} title="Không có loại node khớp">Thử từ khoá hoặc bộ lọc khác, hoặc bấm "Tạo loại node".</EmptyState>}
      />
    </PageBody>
    </PeekHost>
  )
}
