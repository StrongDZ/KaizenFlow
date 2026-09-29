import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { Card, ErrorBox, PageBody, PageHeader, btn, btnPrimary, input } from '../components/ui'
import { isValidMaterialCode } from '../lib/rules'

export default function MaterialNewPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [unit, setUnit] = useState('pcs')
  const create = useMutation({
    mutationFn: () => api.createMaterial({ code, name: name.trim(), unit: unit.trim() || 'pcs' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['materials'] })
      navigate(`/library/materials/${encodeURIComponent(code)}`)
    },
  })
  const codeOk = isValidMaterialCode(code)
  const label = 'flex flex-col gap-1 text-xs text-muted'
  return (
    <PageBody>
      <PageHeader title="Tạo vật tư" />
      <Card title="Thông tin">
        <div className="grid grid-cols-3 gap-3">
          <label className={label}>Tên<input className={input} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className={label}>
            Mã (không đổi được sau khi tạo)
            <input className={input} value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={code !== '' && !codeOk} />
            {code !== '' && !codeOk && <span className="text-bad-text">Mã chỉ gồm chữ, số, gạch dưới, gạch nối và phải bắt đầu bằng chữ hoặc số.</span>}
          </label>
          <label className={label}>Đơn vị<input className={input} value={unit} onChange={(e) => setUnit(e.target.value)} /></label>
        </div>
      </Card>
      <ErrorBox error={create.error} />
      <div className="flex gap-2">
        <button className={btnPrimary} disabled={create.isPending || !codeOk} onClick={() => create.mutate()}>Tạo vật tư</button>
        <Link className={btn} to="/library/materials">Huỷ</Link>
      </div>
    </PageBody>
  )
}
