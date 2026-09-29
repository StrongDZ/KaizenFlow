import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { Card, ErrorBox, Loading, PageBody, PageHeader, btn, btnPrimary, input } from '../components/ui'
import { byCode, failureModesOf, poolCount } from '../lib/model'

type InjRow = { target: string; failure: string; at_min: number }
type OvrRow = { target: string; count: number }

export default function ScenarioNewPage() {
  const vid = Number(useParams().id)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const graph = useQuery({ queryKey: ['graph', vid], queryFn: () => api.graph(vid) })
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  const typeMap = useMemo(() => byCode(types.data ?? []), [types.data])

  const [name, setName] = useState('Ca sáng')
  const [hours, setHours] = useState(4)
  const [reps, setReps] = useState(20)
  const [start, setStart] = useState('WARMUP')
  const [inj, setInj] = useState<InjRow[]>([])
  const [ovr, setOvr] = useState<OvrRow[]>([])

  const create = useMutation({
    mutationFn: () => api.createScenario({
      model_version_id: vid, name, horizon_s: hours * 3600, replications: reps, start_state: start,
      injections: inj.map((i) => ({ target: i.target, failure: i.failure, at_s: i.at_min * 60 })),
      overrides: ovr.map((o) => ({ target: o.target, path: '/count', value: o.count })),
    }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['scenarios', vid] })
      navigate(`/scenarios/${r.id}`)
    },
  })

  if (!graph.data || !types.data) return <Loading />
  const faultable = graph.data.nodes.filter((n) => failureModesOf(n, typeMap).length > 0)
  const pools = graph.data.nodes.filter((n) => n.archetype === 'RESOURCE_POOL')
  const label = 'flex flex-col gap-1 text-muted'

  return (
    <PageBody>
      <PageHeader title="Tạo scenario" subtitle={`${graph.data.model_key} v${graph.data.version}`} />
      <Card title="Thông số chung">
        <div className="grid grid-cols-4 gap-3 text-xs">
          <label className={label}>Tên<input className={input} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className={label}>Thời lượng (giờ)<input type="number" min={0.25} step={0.25} className={input} value={hours} onChange={(e) => setHours(Number(e.target.value))} /></label>
          <label className={label}>Số lần lặp Monte Carlo<input type="number" min={1} max={200} className={input} value={reps} onChange={(e) => setReps(Number(e.target.value))} /></label>
          <label className={label}>Khởi đầu
            <select className={input} value={start} onChange={(e) => setStart(e.target.value)}>
              <option value="WARMUP">Làm nóng rồi mới ghi</option>
              <option value="EMPTY">Nhà máy rỗng</option>
            </select>
          </label>
        </div>
      </Card>

      <Card title="Tiêm lỗi (thời điểm máy hỏng)">
        <div className="space-y-2">
          {inj.map((row, i) => {
            const node = faultable.find((n) => n.key === row.target)
            return (
              <div key={i} className="flex items-center gap-2 text-xs">
                <select className={input} aria-label="Máy" value={row.target} onChange={(e) => setInj(inj.map((r, j) => (j === i ? { ...r, target: e.target.value, failure: '' } : r)))}>
                  {faultable.map((n) => <option key={n.key} value={n.key}>{n.key}</option>)}
                </select>
                <select className={input} aria-label="Loại lỗi" value={row.failure} onChange={(e) => setInj(inj.map((r, j) => (j === i ? { ...r, failure: e.target.value } : r)))}>
                  <option value="">Chọn lỗi</option>
                  {node && failureModesOf(node, typeMap).map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
                <label className="flex items-center gap-1 text-muted">hỏng ở phút
                  <input type="number" min={0} className={`${input} w-24`} value={row.at_min} onChange={(e) => setInj(inj.map((r, j) => (j === i ? { ...r, at_min: Number(e.target.value) } : r)))} />
                </label>
                <button className={btn} aria-label="Bỏ dòng này" onClick={() => setInj(inj.filter((_, j) => j !== i))}>Bỏ</button>
              </div>
            )
          })}
          <button className={btn} disabled={faultable.length === 0}
            onClick={() => setInj([...inj, { target: faultable[0].key, failure: failureModesOf(faultable[0], typeMap)[0] ?? '', at_min: 60 }])}>
            Thêm lỗi
          </button>
          {faultable.length === 0 && <p className="text-xs text-muted">Mô hình chưa có máy nào khai báo chế độ hỏng.</p>}
        </div>
      </Card>

      <Card title="Thay đổi nguồn lực">
        <div className="space-y-2">
          {ovr.map((row, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <select className={input} aria-label="Đội" value={row.target} onChange={(e) => setOvr(ovr.map((r, j) => (j === i ? { ...r, target: e.target.value } : r)))}>
                {pools.map((p) => <option key={p.key} value={p.key}>{p.key} (hiện {poolCount(p, typeMap)})</option>)}
              </select>
              <label className="flex items-center gap-1 text-muted">số lượng
                <input type="number" min={1} className={`${input} w-20`} value={row.count} onChange={(e) => setOvr(ovr.map((r, j) => (j === i ? { ...r, count: Number(e.target.value) } : r)))} />
              </label>
              <button className={btn} aria-label="Bỏ dòng này" onClick={() => setOvr(ovr.filter((_, j) => j !== i))}>Bỏ</button>
            </div>
          ))}
          <button className={btn} disabled={pools.length === 0}
            onClick={() => setOvr([...ovr, { target: pools[0].key, count: poolCount(pools[0], typeMap) + 1 }])}>
            Thêm thay đổi
          </button>
        </div>
      </Card>

      <ErrorBox error={create.error} />
      <div className="flex items-center gap-2">
        <button className={btnPrimary} disabled={create.isPending || !name.trim()} onClick={() => create.mutate()}>Tạo scenario</button>
        <Link className={btn} to={`/versions/${vid}/scenarios`}>Huỷ</Link>
      </div>
    </PageBody>
  )
}
