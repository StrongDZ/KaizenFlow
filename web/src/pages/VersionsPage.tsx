import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { VersionInfo } from '../api/types'
import { DeleteAction } from '../components/DeleteAction'
import { DataTable, type Column } from '../components/table/DataTable'
import { EmptyState, ErrorBox, Loading, PageBody, PageHeader, Tag, btn } from '../components/ui'
import { fmtDateTime, versionStatusLabel } from '../lib/format'

export default function VersionsPage() {
  const key = useParams().key ?? ''
  const qc = useQueryClient()
  const navigate = useNavigate()
  const versions = useQuery({ queryKey: ['versions', key], queryFn: () => api.versions(key) })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['versions', key] })
    void qc.invalidateQueries({ queryKey: ['models'] })
  }
  const clone = useMutation({ mutationFn: (id: number) => api.clone(id), onSuccess: (r) => { refresh(); navigate(`/versions/${r.version_id}`) } })
  const publish = useMutation({ mutationFn: (id: number) => api.publish(id), onSuccess: refresh })
  if (versions.isLoading) return <Loading />
  const rows = [...(versions.data ?? [])].reverse()
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()
  const columns: Column<VersionInfo>[] = [
    { key: 'version', header: 'Version', cell: (v) => <span className="font-medium text-text">v{v.version}</span>, sort: (v) => v.version },
    { key: 'status', header: 'Trạng thái', cell: (v) => <Tag>{versionStatusLabel(v.status)}</Tag>, sort: (v) => v.status },
    { key: 'created', header: 'Ngày tạo', cell: (v) => fmtDateTime(v.created_at), sort: (v) => Date.parse(v.created_at) },
    { key: 'nodes', header: 'Node', cell: (v) => v.nodes, sort: (v) => v.nodes, align: 'right' },
    { key: 'scenarios', header: 'Scenario', cell: (v) => v.scenarios, sort: (v) => v.scenarios, align: 'right' },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (v) => (
        <div className="flex justify-end gap-2" onClick={stop}>
          <button className={btn} disabled={clone.isPending} onClick={() => clone.mutate(v.id)}>Nhân bản</button>
          {v.status === 'DRAFT' && <button className={btn} disabled={publish.isPending} onClick={() => publish.mutate(v.id)}>Publish</button>}
          <DeleteAction what={`phiên bản v${v.version}`} run={(cascade) => api.deleteVersion(v.id, cascade)} onDone={refresh} />
        </div>
      ),
    },
  ]
  return (
    <PageBody>
      <PageHeader title="Phiên bản" subtitle={key} />
      <ErrorBox error={versions.error ?? clone.error ?? publish.error} />
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(v) => v.id}
        onRowClick={(v) => navigate(`/versions/${v.id}`)}
        empty={<EmptyState title="Mô hình này chưa có phiên bản">Tạo mô hình lại từ trang Mô hình.</EmptyState>}
      />
    </PageBody>
  )
}
