import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Shapes } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { Json, NodeTypeDetail } from '../api/types'
import { FailureModesEditor } from '../components/library/FailureModesEditor'
import { IconPicker } from '../components/library/IconPicker'
import { ParamForm } from '../components/library/ParamForm'
import { SignalsEditor } from '../components/library/SignalsEditor'
import { Card, ErrorBox, Loading, Notice, PageBody, PageHeader, Tag, btn, btnPrimary, input } from '../components/ui'
import { withIcon } from '../lib/iconChoices'
import { failureProblems, signalProblems } from '../lib/sensorsEdit'
import { nodeTypeRules } from '../lib/rules'

export default function NodeTypeEditPage() {
  const code = useParams().code ?? ''
  const t = useQuery({ queryKey: ['node-type', code], queryFn: () => api.nodeType(code) })
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  if (t.error) return <PageBody><ErrorBox error={t.error} /></PageBody>
  if (!t.data || !types.data) return <Loading />
  const rules = nodeTypeRules(t.data.usage.versions)
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
  const [signals, setSignals] = useState<Json[]>((d.signals ?? []) as Json[])
  const [modes, setModes] = useState<Json[]>((d.failure_modes ?? []) as Json[])
  const sensorNames = signals.map((s) => String(s.name ?? '').trim()).filter((n) => n !== '')
  const problems = [...signalProblems(signals), ...failureProblems(modes, sensorNames)]
  const update = useMutation({
    mutationFn: () => api.updateNodeType(d.code, {
      name: name.trim(), default_params: params, ui: withIcon(d.ui, icon),
      signals, failure_modes: modes,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['node-type', d.code] })
      void qc.invalidateQueries({ queryKey: ['node-types'] })
      navigate(`/library/node-types/${encodeURIComponent(d.code)}`)
    },
  })
  const invalid = !name.trim() || problems.length > 0
  const hasSensors = d.archetype === 'PROCESS' || signals.length > 0 || modes.length > 0
  return (
    <PageBody>
      <PageHeader icon={Shapes} title="Sửa loại node" subtitle={<Tag>{d.code}</Tag>} />
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
      {hasSensors ? (
        <>
          <Card title={`Cảm biến (${signals.length})`}><SignalsEditor value={signals} onChange={setSignals} /></Card>
          <Card title={`Chế độ hỏng (${modes.length})`}><FailureModesEditor value={modes} onChange={setModes} sensors={sensorNames} /></Card>
        </>
      ) : (
        <Notice>Loại node này không có cảm biến và chế độ hỏng. Chỉ Trạm xử lý (máy) mới có hai phần này.</Notice>
      )}
      {problems.length > 0 && (
        <Notice tone="lock">
          <div className="font-medium">Sửa các chỗ sau trước khi lưu:</div>
          <ul className="mt-1 list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </Notice>
      )}
      <ErrorBox error={update.error} />
      <div className="flex gap-2">
        <button className={btnPrimary} disabled={update.isPending || invalid} onClick={() => update.mutate()}>Lưu thay đổi</button>
        <Link className={btn} to={`/library/node-types/${encodeURIComponent(d.code)}`}>Huỷ</Link>
      </div>
    </PageBody>
  )
}
