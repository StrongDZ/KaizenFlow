import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { Json, Scenario } from '../api/types'
import { Card, ErrorBox, Loading, StatusChip, btn, btnPrimary } from '../components/ui'
import { byCode, failureModesOf, poolCount } from '../lib/model'

type InjRow = { target: string; failure: string; at_min: number }
type OvrRow = { target: string; count: number }

const input = 'rounded border border-slate-300 px-2 py-1 text-sm'

export default function ScenariosPage() {
  const vid = Number(useParams().id)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const graph = useQuery({ queryKey: ['graph', vid], queryFn: () => api.graph(vid) })
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  const scenarios = useQuery({ queryKey: ['scenarios', vid], queryFn: () => api.scenarios(vid) })
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
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['scenarios', vid] }),
  })
  const run = useMutation({
    mutationFn: (sid: number) => api.startRun(sid),
    onSuccess: (r) => navigate(`/runs/${r.run_id}`),
  })

  if (!graph.data || !types.data) return <Loading />
  const faultable = graph.data.nodes.filter((n) => failureModesOf(n, typeMap).length > 0)
  const pools = graph.data.nodes.filter((n) => n.archetype === 'RESOURCE_POOL')
  const published = graph.data.status === 'PUBLISHED'

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">{graph.data.model_key} v{graph.data.version}</h1>
        <Link className="text-sm text-blue-600" to={`/versions/${vid}`}>← về mô hình</Link>
      </div>
      {!published && <ErrorBox error={new Error('Mô hình chưa Publish — hãy Publish ở Editor trước khi chạy.')} />}

      <Card title="Tạo scenario (what-if)">
        <div className="grid grid-cols-4 gap-3 text-sm">
          <label>Tên<input className={`${input} mt-1 w-full`} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>Thời lượng (giờ)<input type="number" min={0.25} step={0.25} className={`${input} mt-1 w-full`} value={hours} onChange={(e) => setHours(Number(e.target.value))} /></label>
          <label>Số lần lặp Monte Carlo<input type="number" min={1} max={200} className={`${input} mt-1 w-full`} value={reps} onChange={(e) => setReps(Number(e.target.value))} /></label>
          <label>Khởi đầu
            <select className={`${input} mt-1 w-full`} value={start} onChange={(e) => setStart(e.target.value)}>
              <option value="WARMUP">Làm nóng rồi mới ghi</option>
              <option value="EMPTY">Nhà máy rỗng</option>
            </select>
          </label>
        </div>

        <div className="mt-4">
          <div className="mb-1 text-sm font-medium">Tiêm lỗi (thời điểm máy hỏng)</div>
          {inj.map((row, i) => {
            const node = faultable.find((n) => n.key === row.target)
            return (
              <div key={i} className="mb-1 flex gap-2">
                <select className={input} value={row.target} onChange={(e) => setInj(inj.map((r, j) => j === i ? { ...r, target: e.target.value, failure: '' } : r))}>
                  {faultable.map((n) => <option key={n.key} value={n.key}>{n.key}</option>)}
                </select>
                <select className={input} value={row.failure} onChange={(e) => setInj(inj.map((r, j) => j === i ? { ...r, failure: e.target.value } : r))}>
                  <option value="">— lỗi —</option>
                  {node && failureModesOf(node, typeMap).map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
                <label className="text-sm">hỏng ở phút
                  <input type="number" min={0} className={`${input} ml-1 w-24`} value={row.at_min} onChange={(e) => setInj(inj.map((r, j) => j === i ? { ...r, at_min: Number(e.target.value) } : r))} />
                </label>
                <button className={btn} onClick={() => setInj(inj.filter((_, j) => j !== i))}>×</button>
              </div>
            )
          })}
          <button className={btn} disabled={faultable.length === 0}
            onClick={() => setInj([...inj, { target: faultable[0].key, failure: failureModesOf(faultable[0], typeMap)[0] ?? '', at_min: 60 }])}>
            + Thêm lỗi
          </button>
        </div>

        <div className="mt-4">
          <div className="mb-1 text-sm font-medium">Thay đổi nguồn lực</div>
          {ovr.map((row, i) => (
            <div key={i} className="mb-1 flex gap-2">
              <select className={input} value={row.target} onChange={(e) => setOvr(ovr.map((r, j) => j === i ? { ...r, target: e.target.value } : r))}>
                {pools.map((p) => <option key={p.key} value={p.key}>{p.key} (hiện {poolCount(p, typeMap)})</option>)}
              </select>
              <label className="text-sm">số lượng
                <input type="number" min={1} className={`${input} ml-1 w-20`} value={row.count} onChange={(e) => setOvr(ovr.map((r, j) => j === i ? { ...r, count: Number(e.target.value) } : r))} />
              </label>
              <button className={btn} onClick={() => setOvr(ovr.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <button className={btn} disabled={pools.length === 0}
            onClick={() => setOvr([...ovr, { target: pools[0].key, count: poolCount(pools[0], typeMap) + 1 }])}>
            + Thêm thay đổi
          </button>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button className={btnPrimary} disabled={create.isPending || !name} onClick={() => create.mutate()}>Tạo scenario</button>
          <ErrorBox error={create.error} />
        </div>
      </Card>

      <Card title="Scenario đã tạo">
        <ErrorBox error={run.error} />
        <div className="space-y-2">
          {(scenarios.data ?? []).map((sc) => (
            <ScenarioRow key={sc.id} sc={sc} canRun={published} running={run.isPending} onRun={() => run.mutate(sc.id)} />
          ))}
        </div>
      </Card>
    </div>
  )
}

function describe(sc: Scenario): string {
  const parts = [`${sc.horizon_s / 3600} giờ`, `${sc.replications} lần lặp`]
  if (sc.injections.length) parts.push(`${sc.injections.length} lỗi tiêm`)
  if (sc.overrides.length) parts.push(sc.overrides.map((o: Json) => `${String(o.target)}=${String(o.value)}`).join(', '))
  if (sc.origin === 'RECOMMENDER') parts.push('từ đề xuất')
  return parts.join(' · ')
}

function ScenarioRow({ sc, canRun, running, onRun }: { sc: Scenario; canRun: boolean; running: boolean; onRun: () => void }) {
  const runs = useQuery({ queryKey: ['runs', sc.id], queryFn: () => api.runs(sc.id) })
  return (
    <div className="rounded border border-slate-200 p-3">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="font-medium">{sc.name || `Scenario #${sc.id}`}</div>
          <div className="text-xs text-slate-500">{describe(sc)}</div>
        </div>
        <button className={btnPrimary} disabled={!canRun || running} onClick={onRun}>Chạy</button>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {(runs.data ?? []).map((r) => (
          <Link key={r.id} to={`/runs/${r.id}`} className="flex items-center gap-1 rounded border border-slate-200 px-2 py-0.5 text-xs">
            #{r.id} <StatusChip status={r.status} />
          </Link>
        ))}
      </div>
    </div>
  )
}
