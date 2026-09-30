import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { Material } from '../api/types'
import { Field, FormDialog } from '../components/FormDialog'
import { DataTable, type Column } from '../components/table/DataTable'
import { EmptyState, ErrorBox, Loading, PageBody, PageHeader, SearchBox, btnPrimary, input } from '../components/ui'
import { usedIn } from '../lib/format'
import { isValidMaterialCode } from '../lib/rules'
import { filterRows } from '../lib/table'

const COLUMNS: Column<Material>[] = [
  { key: 'name', header: 'Tên', cell: (m) => <span className="font-medium text-text">{m.name || m.code}</span>, sort: (m) => m.name || m.code },
  { key: 'code', header: 'Mã', cell: (m) => <span className="text-muted">{m.code}</span>, sort: (m) => m.code },
  { key: 'unit', header: 'Đơn vị', cell: (m) => m.unit, sort: (m) => m.unit },
  { key: 'used', header: 'Dùng trong', cell: (m) => usedIn(m.used_in_versions), sort: (m) => m.used_in_versions ?? 0 },
]

export default function MaterialsPage() {
  const navigate = useNavigate()
  const mats = useQuery({ queryKey: ['materials'], queryFn: api.materials })
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [unit, setUnit] = useState('pcs')
  const close = () => { setCreating(false); setCode(''); setName(''); setUnit('pcs'); create.reset() }
  const create = useMutation({
    mutationFn: () => api.createMaterial({ code, name: name.trim(), unit: unit.trim() || 'pcs' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['materials'] })
      navigate(`/library/materials/${encodeURIComponent(code)}`)
    },
  })
  if (mats.isLoading) return <Loading />
  const rows = filterRows(mats.data ?? [], q, (m) => [m.name, m.code])
  return (
    <PageBody>
      <PageHeader
        title="Vật tư"
        subtitle={mats.data ? `${mats.data.length} vật tư` : undefined}
        actions={
          <>
            <SearchBox value={q} onChange={setQ} />
            <button className={btnPrimary} onClick={() => setCreating(true)}>Tạo vật tư</button>
          </>
        }
      />
      <FormDialog
        open={creating} title="Tạo vật tư"
        description="Vật tư là loại hàng chạy qua sơ đồ: nguyên liệu, bán thành phẩm, thành phẩm."
        submitLabel="Tạo vật tư" pending={create.isPending} error={create.error}
        canSubmit={isValidMaterialCode(code)} onSubmit={() => create.mutate()} onClose={close}
      >
        <Field label="Mã vật tư" hint="Không đổi được sau khi tạo. Ví dụ RAW-01, SUB_OK."
          problem={code !== '' && !isValidMaterialCode(code) ? 'Mã chỉ gồm chữ, số, gạch dưới, gạch nối và phải bắt đầu bằng chữ hoặc số.' : null}>
          <input autoFocus className={`${input} w-full`} value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={code !== '' && !isValidMaterialCode(code)} />
        </Field>
        <Field label="Tên hiển thị" hint="Bỏ trống thì dùng mã.">
          <input className={`${input} w-full`} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Đơn vị" hint="Ví dụ pcs (cái), kg.">
          <input className={`${input} w-full`} value={unit} onChange={(e) => setUnit(e.target.value)} />
        </Field>
      </FormDialog>
      <ErrorBox error={mats.error} />
      <DataTable
        rows={rows}
        columns={COLUMNS}
        rowKey={(m) => m.code}
        onRowClick={(m) => navigate(`/library/materials/${encodeURIComponent(m.code)}`)}
        initialSort={{ key: 'code', dir: 'asc' }}
        empty={<EmptyState title={q ? 'Không có vật tư khớp' : 'Chưa có vật tư nào'}>{q ? 'Thử từ khoá khác.' : 'Bấm "Tạo vật tư" để thêm mã vật tư dùng trong sơ đồ.'}</EmptyState>}
      />
    </PageBody>
  )
}
