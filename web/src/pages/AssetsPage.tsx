import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cpu } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { Asset } from '../api/types'
import { AssetDialog } from '../components/assets/AssetDialog'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ARCHETYPE_LABEL } from '../components/KfNode'
import { ItemIdentity, roleColor } from '../components/NodeIdentity'
import { DataTable, type Column } from '../components/table/DataTable'
import { EmptyState, ErrorBox, FilterChip, Loading, Notice, PageBody, PageHeader, SearchBox, Tag, btn, btnDangerOutline, btnPrimary } from '../components/ui'
import { filterRows } from '../lib/table'

/**
 * Danh mục Thiết bị: thiết bị thật của nhà máy, định danh duy nhất toàn app. Một thiết bị dùng được
 * ở nhiều mô hình; tham số và tín hiệu khai một lần ở đây, không khai lại theo từng mô hình.
 */
export default function AssetsPage() {
  const qc = useQueryClient()
  const assets = useQuery({ queryKey: ['assets'], queryFn: api.assets })
  const [q, setQ] = useState('')
  const [line, setLine] = useState('')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Asset | null>(null)
  const [deleting, setDeleting] = useState<Asset | null>(null)
  const remove = useMutation({
    mutationFn: (key: string) => api.deleteAsset(key),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['assets'] }); setDeleting(null) },
  })
  if (assets.isLoading) return <Loading />
  const all = assets.data ?? []
  const lines = [...new Set(all.map((a) => a.line).filter((l) => l !== ''))].sort()
  const rows = filterRows(all.filter((a) => line === '' || a.line === line), q, (a) => [a.key, a.name, a.node_type])

  const columns: Column<Asset>[] = [
    {
      key: 'key', header: 'Thiết bị',
      cell: (a) => <ItemIdentity icon={Cpu} name={a.name || a.key} code={a.name ? a.key : undefined} color={roleColor(a.archetype)} />,
      sort: (a) => a.name || a.key,
    },
    { key: 'type', header: 'Loại', cell: (a) => <span className="flex items-center gap-1.5"><Tag>{a.node_type}</Tag>{a.archetype ? <span className="text-faint">{ARCHETYPE_LABEL[a.archetype]}</span> : null}</span>, sort: (a) => a.node_type },
    { key: 'place', header: 'Vị trí', cell: (a) => [a.plant, a.line].filter(Boolean).join(' / ') || '—', sort: (a) => a.plant + a.line },
    {
      key: 'models', header: 'Dùng trong',
      cell: (a) => a.models.length === 0
        ? <span className="text-faint">chưa mô hình nào</span>
        : <span className="flex flex-wrap gap-1">{a.models.map((m) => (
            <Link key={m} to={`/models/${encodeURIComponent(m)}/versions`} className="text-accent underline decoration-dotted hover:opacity-80">{m}</Link>
          ))}</span>,
      sort: (a) => a.models.length,
    },
    { key: 'state', header: 'Trạng thái', cell: (a) => (a.retired ? <Tag tone="warn">Ngừng dùng</Tag> : <span className="text-faint">đang dùng</span>), sort: (a) => (a.retired ? 1 : 0) },
    {
      key: 'act', header: '', align: 'right',
      cell: (a) => (
        <span className="flex justify-end gap-2">
          <button className={btn} onClick={(e) => { e.stopPropagation(); setEditing(a) }}>Sửa</button>
          <button className={btnDangerOutline} onClick={(e) => { e.stopPropagation(); setDeleting(a) }}>Xoá</button>
        </span>
      ),
    },
  ]

  return (
    <PageBody wide>
      <PageHeader icon={Cpu}
        title="Thiết bị"
        subtitle={`${all.length} thiết bị · ${all.filter((a) => a.models.length > 0).length} đang nằm trong sơ đồ`}
        actions={
          <>
            <SearchBox value={q} onChange={setQ} />
            <button className={btnPrimary} onClick={() => setCreating(true)}>Tạo thiết bị</button>
          </>
        }
      />
      <Notice>
        Thiết bị là một máy có thật, định danh duy nhất toàn app. Sơ đồ của mô hình chỉ <em>đặt</em> thiết bị đã khai ở đây,
        nên cùng một máy dùng được ở nhiều mô hình mà tham số và tín hiệu chỉ khai một lần.
        Bước kế tiếp: ghép tín hiệu cho thiết bị ở <Link to="/assets/signals" className="text-accent underline">Tín hiệu thiết bị</Link>.
        Mọi máy đều khai ở đây, kể cả thiết bị phụ trợ (lò hơi, máy nén khí, bơm): mã thiết bị cũng là mã máy khi gắn đồng hồ.
      </Notice>
      {lines.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <FilterChip active={line === ''} onClick={() => setLine('')}>Tất cả</FilterChip>
          {lines.map((l) => <FilterChip key={l} active={line === l} onClick={() => setLine(l)}>{l}</FilterChip>)}
        </div>
      )}
      <ErrorBox error={assets.error} />
      {creating && <AssetDialog onClose={() => setCreating(false)} onSaved={() => setCreating(false)} />}
      {editing && <AssetDialog edit={editing} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        title={`Xoá thiết bị ${deleting?.key ?? ''}?`}
        description={deleting?.models.length
          ? `Thiết bị này đang nằm trong sơ đồ của ${deleting.models.join(', ')}. Gỡ khỏi các sơ đồ đó trước, hoặc đánh dấu Ngừng dùng.`
          : 'Ghép nối tín hiệu của thiết bị cũng bị xoá. Lịch sử số liệu vẫn được giữ.'}
        confirmLabel="Xoá thiết bị" pending={remove.isPending} error={remove.error}
        onConfirm={() => deleting && remove.mutate(deleting.key)} onCancel={() => { setDeleting(null); remove.reset() }}
      />
      <DataTable
        rows={rows} columns={columns} rowKey={(a) => a.key}
        onRowClick={(a) => setEditing(a)}
        initialSort={{ key: 'key', dir: 'asc' }}
        empty={<EmptyState title={q ? 'Không có thiết bị khớp' : 'Chưa có thiết bị nào'}>
          {q ? 'Thử từ khoá khác.' : 'Bấm "Tạo thiết bị" để khai máy đầu tiên, rồi đặt nó lên sơ đồ của một mô hình.'}
        </EmptyState>}
      />
    </PageBody>
  )
}
