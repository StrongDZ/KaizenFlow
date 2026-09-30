import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { Json, NodeTypeDetail } from '../api/types'
import { IconPicker } from '../components/library/IconPicker'
import { ParamForm } from '../components/library/ParamForm'
import { Card, ErrorBox, Loading, Notice, PageBody, PageHeader, Tag, btn, btnPrimary, input } from '../components/ui'
import { withIcon } from '../lib/iconChoices'
import { parseJsonArray } from '../lib/jsonText'
import { nodeTypeRules } from '../lib/rules'

export default function NodeTypeEditPage() {
  const code = useParams().code ?? ''
  const t = useQuery({ queryKey: ['node-type', code], queryFn: () => api.nodeType(code) })
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  if (t.error) return <PageBody><ErrorBox error={t.error} /></PageBody>
  if (!t.data || !types.data) return <Loading />
  const rules = nodeTypeRules(t.data, t.data.usage.versions)
  if (!rules.canEdit) {
    return (
      <PageBody>
        <Notice tone="lock">{rules.banner}</Notice>
        <Link className={btn} to={`/library/node-types/${encodeURIComponent(code)}`}>Về chi tiết</Link>
      </PageBody>
    )
  }
  const schema = types.data.find((x) => x.archetype === t.data.archetype)?.param_schema
  return <NodeTypeEditForm key={t.data.code} d={t.data} schema={schema} banner={rules.banner} />
}

/** Khởi tạo state thẳng từ node type khi mount, để rjsf không thấy formData đổi sau khi đã dựng (xem ParamForm). */
function NodeTypeEditForm({ d, schema, banner }: { d: NodeTypeDetail; schema?: Json; banner: string | null }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState(d.name)
  const [icon, setIcon] = useState<string | undefined>(typeof d.ui?.icon === 'string' ? d.ui.icon : undefined)
  const [params, setParams] = useState<Json>(d.default_params)
  const [signals, setSignals] = useState(JSON.stringify(d.signals, null, 2))
  const [modes, setModes] = useState(JSON.stringify(d.failure_modes, null, 2))
  const sigParsed = parseJsonArray(signals)
  const modeParsed = parseJsonArray(modes)
  const update = useMutation({
    mutationFn: () => api.updateNodeType(d.code, {
      name: name.trim(), default_params: params, ui: withIcon(d.ui, icon),
      signals: sigParsed.ok ? sigParsed.value : undefined, failure_modes: modeParsed.ok ? modeParsed.value : undefined,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['node-type', d.code] })
      void qc.invalidateQueries({ queryKey: ['node-types'] })
      navigate(`/library/node-types/${encodeURIComponent(d.code)}`)
    },
  })
  const invalid = !name.trim() || !sigParsed.ok || !modeParsed.ok
  const area = `${input} h-40 w-full font-mono`
  return (
    <PageBody>
      <PageHeader title="Sửa loại node" subtitle={<Tag>{d.code}</Tag>} />
      {banner && <Notice tone="lock">{banner}</Notice>}
      <Card title="Thông tin chung">
        <label className="flex max-w-md flex-col gap-1 text-xs text-muted">
          Tên<input className={input} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="mt-4"><IconPicker value={icon} archetype={d.archetype} onChange={setIcon} /></div>
      </Card>
      <Card title="Tham số mặc định">
        <div className="rjsf">
          {schema ? <ParamForm schema={schema} value={params} onChange={setParams} /> : <p className="text-xs text-muted">Chưa có schema cho loại này.</p>}
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-4">
        <Card title="Cảm biến (JSON)">
          <textarea className={area} aria-label="Cảm biến (JSON)" value={signals} onChange={(e) => setSignals(e.target.value)} spellCheck={false} />
          {!sigParsed.ok && <p role="alert" className="mt-1 text-xs text-bad-text">{sigParsed.error}</p>}
        </Card>
        <Card title="Chế độ hỏng (JSON)">
          <textarea className={area} aria-label="Chế độ hỏng (JSON)" value={modes} onChange={(e) => setModes(e.target.value)} spellCheck={false} />
          {!modeParsed.ok && <p role="alert" className="mt-1 text-xs text-bad-text">{modeParsed.error}</p>}
        </Card>
      </div>
      <ErrorBox error={update.error} />
      <div className="flex gap-2">
        <button className={btnPrimary} disabled={update.isPending || invalid} onClick={() => update.mutate()}>Lưu thay đổi</button>
        <Link className={btn} to={`/library/node-types/${encodeURIComponent(d.code)}`}>Huỷ</Link>
      </div>
    </PageBody>
  )
}
