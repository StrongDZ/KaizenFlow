import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { DeleteAction } from '../components/DeleteAction'
import { MaterialInfoForm } from '../components/library/MaterialInfoForm'
import { Card, EmptyState, ErrorBox, Loading, Notice, PageBody, PageHeader, Tag } from '../components/ui'
import { materialRules } from '../lib/rules'

const TABS = ['Đang dùng ở'] as const

export default function MaterialDetailPage() {
  const code = useParams().code ?? ''
  const navigate = useNavigate()
  const qc = useQueryClient()
  const m = useQuery({ queryKey: ['material', code], queryFn: () => api.material(code) })
  const [tab, setTab] = useState<(typeof TABS)[number]>('Đang dùng ở')
  if (m.error) return <PageBody><Link className="text-xs text-muted hover:text-text" to="/library/materials">Danh sách vật tư</Link><ErrorBox error={m.error} /></PageBody>
  if (!m.data) return <Loading />
  const d = m.data
  const rules = materialRules(d.usage)
  const total = d.usage.edges.length + d.usage.nodes.length + d.usage.node_types.length
  const th = 'py-1.5 text-left text-[11px] font-medium text-muted'
  return (
    <PageBody>
      <Link className="text-xs text-muted hover:text-text" to="/library/materials">‹ Danh sách vật tư</Link>
      <PageHeader
        title={d.name || d.code}
        subtitle={<Tag>{d.code}</Tag>}
        actions={rules.canDelete ? (
          <DeleteAction
            what={`vật tư ${d.code}`}
            run={() => api.deleteMaterial(d.code)}
            onDone={() => {
              void qc.invalidateQueries({ queryKey: ['materials'] })
              navigate('/library/materials')
            }}
          />
        ) : undefined}
      />
      {rules.banner && <Notice tone="lock">{rules.banner}</Notice>}
      <MaterialInfoForm key={d.code} d={d} canEditUnit={rules.canEditUnit} />
      <div role="tablist" className="flex gap-5 border-b border-line">
        {TABS.map((name) => (
          <button key={name} role="tab" aria-selected={tab === name} onClick={() => setTab(name)}
            className="-mb-px border-b-2 border-text pb-1.5 text-xs font-semibold text-text">{name}</button>
        ))}
      </div>
      {total === 0 ? (
        <EmptyState title="Chưa có nơi nào dùng vật tư này">Dùng nó làm vật tư của một edge hoặc trong tham số node ở tab Sơ đồ.</EmptyState>
      ) : (
        <div className="space-y-4">
          {d.usage.edges.length > 0 && (
            <Card title={`Edge (${d.usage.edges.length})`}>
              <table className="w-full border-collapse text-xs">
                <thead><tr><th className={th}>Edge</th><th className={th}>Từ</th><th className={th}>Đến</th><th className={th}>Version</th></tr></thead>
                <tbody>
                  {d.usage.edges.map((e) => (
                    <tr key={`${e.version_id}-${e.key}`} className="border-t border-line">
                      <td className="py-1.5 font-medium text-text">{e.key}</td><td>{e.src}</td><td>{e.dst}</td>
                      <td><Link className="text-text hover:underline" to={`/versions/${e.version_id}`}>{e.model_key} v{e.version}</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          {d.usage.nodes.length > 0 && (
            <Card title={`Tham số node (${d.usage.nodes.length})`}>
              <table className="w-full border-collapse text-xs">
                <thead><tr><th className={th}>Node</th><th className={th}>Loại</th><th className={th}>Version</th></tr></thead>
                <tbody>
                  {d.usage.nodes.map((n) => (
                    <tr key={`${n.version_id}-${n.key}`} className="border-t border-line">
                      <td className="py-1.5 font-medium text-text">{n.key}</td><td>{n.node_type}</td>
                      <td><Link className="text-text hover:underline" to={`/versions/${n.version_id}`}>{n.model_key} v{n.version}</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          {d.usage.node_types.length > 0 && (
            <Card title={`Tham số mặc định của node type (${d.usage.node_types.length})`}>
              <div className="flex flex-wrap gap-2">
                {d.usage.node_types.map((c) => <Link key={c} to={`/library/node-types/${encodeURIComponent(c)}`}><Tag>{c}</Tag></Link>)}
              </div>
            </Card>
          )}
        </div>
      )}
    </PageBody>
  )
}
