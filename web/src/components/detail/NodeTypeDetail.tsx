import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../../api/client'
import type { VersionUse } from '../../api/types'
import { versionStatusLabel } from '../../lib/format'
import { nodeTypeRules } from '../../lib/rules'
import { DeleteAction } from '../DeleteAction'
import { ARCHETYPE_LABEL } from '../KfNode'
import { FailureModeTable, ParamGrid, RecipeStrip, SignalTable } from '../library/NodeTypeView'
import { NodeIcon } from '../nodeIcons'
import { DetailShell, type DetailVariant } from '../SidePeek'
import { DataTable, type Column } from '../table/DataTable'
import { EmptyState, ErrorBox, Notice, Tag, btn } from '../ui'

const TABS = ['Tham số', 'Chế độ hỏng', 'Cảm biến', 'Đang dùng ở'] as const

const USE_COLUMNS: Column<VersionUse>[] = [
  { key: 'model', header: 'Mô hình', cell: (u) => <Link className="text-text hover:underline" to={`/versions/${u.version_id}`}>{u.model_key} v{u.version}</Link> },
  { key: 'status', header: 'Trạng thái', cell: (u) => versionStatusLabel(u.status) },
  { key: 'nodes', header: 'Số node', cell: (u) => u.nodes, align: 'right' },
]

/** Chi tiết một loại node: tham số mặc định, chế độ hỏng, cảm biến, nơi đang dùng. Dùng ở trang riêng hoặc khung bên phải của danh sách loại node. */
export function NodeTypeDetail({ code, variant, onClose }: { code: string; variant: DetailVariant; onClose?: () => void }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const t = useQuery({ queryKey: ['node-type', code], queryFn: () => api.nodeType(code) })
  const [tab, setTab] = useState<(typeof TABS)[number]>('Tham số')
  const back = { to: '/library/node-types', label: 'Danh sách loại node' }
  if (t.error) return <DetailShell variant={variant} title={code} back={back} onClose={onClose}><ErrorBox error={t.error} /></DetailShell>
  if (!t.data) return <DetailShell variant={variant} title={code} back={back} onClose={onClose} loading><span /></DetailShell>
  const d = t.data
  const rules = nodeTypeRules(d.usage.versions)
  return (
    <DetailShell
      variant={variant} title={d.name} back={back} onClose={onClose}
      fullPageTo={`/library/node-types/${encodeURIComponent(d.code)}`}
      subtitle={<span className="flex items-center gap-2"><NodeIcon name={typeof d.ui?.icon === 'string' ? d.ui.icon : undefined} archetype={d.archetype} size={15} className="text-text-2" /><Tag>{d.code}</Tag><Tag>{ARCHETYPE_LABEL[d.archetype]}</Tag></span>}
      actions={
        <>
          <Link className={btn} to={`/library/node-types/new?from=${encodeURIComponent(d.code)}`}>Nhân bản</Link>
          {rules.canEdit && <Link className={btn} to={`/library/node-types/${encodeURIComponent(d.code)}/edit`}>Sửa</Link>}
          {rules.canDelete && (
            <DeleteAction
              what={`loại node ${d.code}`}
              run={() => api.deleteNodeType(d.code)}
              onDone={() => {
                void qc.invalidateQueries({ queryKey: ['node-types'] })
                if (variant === 'peek') onClose?.(); else navigate('/library/node-types')
              }}
            />
          )}
        </>
      }
    >
      {rules.banner && <Notice tone="lock">{rules.banner}</Notice>}
      <div role="tablist" className="flex gap-5 border-b border-line">
        {TABS.map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={`-mb-px border-b-2 pb-1.5 text-xs font-medium ${tab === name ? 'border-text font-semibold text-text' : 'border-transparent text-muted hover:text-text'}`}
          >
            {name}
          </button>
        ))}
      </div>
      {tab === 'Tham số' && (
        <div className="space-y-3">
          <RecipeStrip t={d} />
          <ParamGrid t={d} compact={variant === 'peek'} />
        </div>
      )}
      {tab === 'Chế độ hỏng' && <div className="overflow-x-auto"><FailureModeTable t={d} /></div>}
      {tab === 'Cảm biến' && <div className="overflow-x-auto"><SignalTable t={d} /></div>}
      {tab === 'Đang dùng ở' && (
        <DataTable rows={d.usage.versions} columns={USE_COLUMNS} rowKey={(u) => u.version_id}
          empty={<EmptyState title="Chưa có phiên bản nào dùng loại này">Kéo loại này vào sơ đồ ở tab Sơ đồ của một mô hình.</EmptyState>} />
      )}
    </DetailShell>
  )
}
