import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import type { MaterialDetail } from '../../api/types'
import { Card, ErrorBox, btnPrimary, input } from '../ui'
import { UnitSelect } from '../UnitSelect'

export function MaterialInfoForm({ d, canEditUnit }: { d: MaterialDetail; canEditUnit: boolean }) {
  const qc = useQueryClient()
  const all = useQuery({ queryKey: ['materials'], queryFn: api.materials })
  const [name, setName] = useState(d.name)
  const [unit, setUnit] = useState(d.unit)
  const save = useMutation({
    mutationFn: () => api.updateMaterial(d.code, { name: name.trim(), unit: canEditUnit ? unit.trim() || undefined : undefined }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['material', d.code] })
      void qc.invalidateQueries({ queryKey: ['materials'] })
    },
  })
  const dirty = name.trim() !== d.name || (canEditUnit && unit.trim() !== d.unit)
  const label = 'flex flex-col gap-1 text-xs text-muted'
  return (
    <Card title="Thông tin" actions={<button className={btnPrimary} disabled={save.isPending || !dirty} onClick={() => save.mutate()}>Lưu thay đổi</button>}>
      <div className="grid grid-cols-3 gap-4">
        <label className={label}>Tên<input className={input} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className={label}>Mã (không đổi được)<input className={`${input} opacity-60`} value={d.code} disabled /></label>
        <div className={label}>
          <span>Đơn vị</span>
          <UnitSelect value={unit} used={(all.data ?? []).map((m) => m.unit)} onChange={setUnit} disabled={!canEditUnit} />
        </div>
      </div>
      <div className="mt-2"><ErrorBox error={save.error} /></div>
    </Card>
  )
}
