import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { Card, ErrorBox, Loading, btnPrimary } from '../components/ui'

export default function ModelsPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const models = useQuery({ queryKey: ['models'], queryFn: api.models })
  const [key, setKey] = useState('')
  const create = useMutation({
    mutationFn: () => api.createModel(key.trim()),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['models'] })
      navigate(`/versions/${r.version_id}`)
    },
  })
  if (models.isLoading) return <Loading />
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <Card title="Mô hình nhà máy">
        <ErrorBox error={models.error} />
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr><th className="py-1">Mô hình</th><th>Version</th><th>Trạng thái</th><th /></tr>
          </thead>
          <tbody>
            {(models.data ?? []).map((m) => (
              <tr key={m.model_key} className="border-t border-line">
                <td className="py-2 font-medium">{m.model_key}</td>
                <td>v{m.latest_version}</td>
                <td>{m.status}</td>
                <td className="space-x-3 text-right">
                  <Link className="text-text underline-offset-2 hover:underline" to={`/versions/${m.latest_version_id}`}>Sửa mô hình</Link>
                  <Link className="text-text underline-offset-2 hover:underline" to={`/versions/${m.latest_version_id}/scenarios`}>Scenario &amp; chạy</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Tạo mô hình mới">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (key.trim()) create.mutate() }}>
          <input className="flex-1 rounded border border-line-2 px-2 py-1 text-sm" placeholder="vd: denso-line-3"
            value={key} onChange={(e) => setKey(e.target.value)} />
          <button className={btnPrimary} disabled={!key.trim() || create.isPending}>Tạo</button>
        </form>
        <div className="mt-2"><ErrorBox error={create.error} /></div>
      </Card>
    </div>
  )
}
