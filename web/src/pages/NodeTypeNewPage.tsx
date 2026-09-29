import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import type { Archetype, Json, NodeType, NodeTypeDetail } from '../api/types'
import { ARCHETYPE_LABEL } from '../components/KfNode'
import { ParamForm } from '../components/library/ParamForm'
import { Card, ErrorBox, Loading, PageBody, PageHeader, btn, btnPrimary, input } from '../components/ui'
import { isValidNodeTypeCode } from '../lib/rules'

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

  const create = useMutation({
    mutationFn: () => api.createNodeType({
      code, name: name.trim(), archetype, default_params: params,
      signals: source?.signals, failure_modes: source?.failure_modes, ui: source?.ui,
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
      <PageHeader title={from ? 'Nhân bản node type' : 'Tạo node type'} />
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
      <ErrorBox error={create.error} />
      <div className="flex gap-2">
        <button className={btnPrimary} disabled={create.isPending || !name.trim() || !codeOk} onClick={() => create.mutate()}>
          {from ? 'Tạo bản sao' : 'Tạo node type'}
        </button>
        <Link className={btn} to="/library/node-types">Huỷ</Link>
      </div>
    </PageBody>
  )
}
