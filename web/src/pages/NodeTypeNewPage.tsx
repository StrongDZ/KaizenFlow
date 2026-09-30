import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import type { Archetype, Json, NodeType, NodeTypeDetail } from '../api/types'
import { ARCHETYPE_LABEL } from '../components/KfNode'
import { FailureModesEditor } from '../components/library/FailureModesEditor'
import { IconPicker } from '../components/library/IconPicker'
import { ParamForm } from '../components/library/ParamForm'
import { SignalsEditor } from '../components/library/SignalsEditor'
import { Card, ErrorBox, Loading, Notice, PageBody, PageHeader, btn, btnPrimary, input } from '../components/ui'
import { withIcon } from '../lib/iconChoices'
import { isValidNodeTypeCode } from '../lib/rules'
import { failureProblems, signalProblems } from '../lib/sensorsEdit'

export default function NodeTypeNewPage() {
  const from = useSearchParams()[0].get('from')
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  const source = useQuery({ queryKey: ['node-type', from], queryFn: () => api.nodeType(from!), enabled: !!from })
  if (source.error) return <PageBody><ErrorBox error={source.error} /></PageBody>
  if (!types.data || (from && !source.data)) return <Loading />
  return <NodeTypeForm types={types.data} source={source.data} />
}

/** Khởi tạo state thẳng từ bản gốc khi mount, để rjsf không thấy formData đổi sau khi đã dựng. */
function NodeTypeForm({ types, source }: { types: NodeType[]; source?: NodeTypeDetail }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const from = source?.code
  const [name, setName] = useState(source ? `${source.name} (bản sao)` : '')
  const [code, setCode] = useState(source ? `${source.code}_COPY` : '')
  const [archetype, setArchetype] = useState<Archetype>(source?.archetype ?? 'PROCESS')
  const [params, setParams] = useState<Json>(source?.default_params ?? {})
  const [icon, setIcon] = useState<string | undefined>(typeof source?.ui?.icon === 'string' ? source.ui.icon : undefined)
  const [signals, setSignals] = useState<Json[]>((source?.signals ?? []) as Json[])
  const [modes, setModes] = useState<Json[]>((source?.failure_modes ?? []) as Json[])
  const sensorNames = signals.map((s) => String(s.name ?? '').trim()).filter((n) => n !== '')
  const problems = archetype === 'PROCESS' ? [...signalProblems(signals), ...failureProblems(modes, sensorNames)] : []

  const create = useMutation({
    mutationFn: () => api.createNodeType({
      code, name: name.trim(), archetype, default_params: params,
      signals: archetype === 'PROCESS' ? signals : [], failure_modes: archetype === 'PROCESS' ? modes : [], ui: withIcon(source?.ui, icon),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['node-types'] })
      navigate(`/library/node-types/${encodeURIComponent(code)}`)
    },
  })
  const schema = types.find((t) => t.archetype === archetype)?.param_schema
  const codeOk = isValidNodeTypeCode(code)
  const label = 'flex flex-col gap-1 text-xs text-muted'
  return (
    <PageBody>
      <PageHeader title={from ? 'Nhân bản loại node' : 'Tạo loại node'} />
      <Card title="Thông tin chung">
        <div className="grid grid-cols-3 gap-3">
          <label className={label}>Tên<input className={input} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className={label}>
            Mã (chữ hoa, số, gạch dưới)
            <input className={input} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} aria-invalid={code !== '' && !codeOk} />
            {code !== '' && !codeOk && <span className="text-bad-text">Mã phải bắt đầu bằng chữ cái và chỉ gồm A–Z, 0–9, gạch dưới.</span>}
          </label>
          <label className={label}>
            Loại
            <select className={input} value={archetype} disabled={!!from} onChange={(e) => { setArchetype(e.target.value as Archetype); setParams({}) }}>
              {(Object.keys(ARCHETYPE_LABEL) as Archetype[]).map((a) => <option key={a} value={a}>{ARCHETYPE_LABEL[a]}</option>)}
            </select>
          </label>
        </div>
        <div className="mt-4"><IconPicker value={icon} archetype={archetype} onChange={setIcon} /></div>
      </Card>
      <Card title="Tham số mặc định">
        <div className="rjsf">
          {schema ? (
            <ParamForm key={archetype} schema={schema} value={params} onChange={setParams} />
          ) : (
            <p className="text-xs text-muted">Chưa có schema cho loại này.</p>
          )}
        </div>
      </Card>
      {archetype === 'PROCESS' && (
        <>
          <Card title={`Cảm biến (${signals.length})`}><SignalsEditor value={signals} onChange={setSignals} /></Card>
          <Card title={`Chế độ hỏng (${modes.length})`}><FailureModesEditor value={modes} onChange={setModes} sensors={sensorNames} /></Card>
        </>
      )}
      {problems.length > 0 && (
        <Notice tone="lock">
          <div className="font-medium">Sửa các chỗ sau trước khi tạo:</div>
          <ul className="mt-1 list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </Notice>
      )}
      <ErrorBox error={create.error} />
      <div className="flex gap-2">
        <button className={btnPrimary} disabled={create.isPending || !name.trim() || !codeOk || problems.length > 0} onClick={() => create.mutate()}>
          {from ? 'Tạo bản sao' : 'Tạo loại node'}
        </button>
        <Link className={btn} to="/library/node-types">Huỷ</Link>
      </div>
    </PageBody>
  )
}
