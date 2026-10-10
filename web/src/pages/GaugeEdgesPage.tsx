import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { gaugeConfigApi, type EdgeDoc } from '../api/gaugeConfig'
import { ActionError, GaugeArea } from '../components/gauge/GaugeArea'
import { input, Loading } from '../components/ui'
import { ageLabel } from '../lib/gaugeView'

/** Chọn edge cho một máy: chuyển máy khỏi edge cũ sang edge mới, edge nhận qua MQTT. */
function MoveTo({ machine, current, edges }: { machine: string; current: string; edges: EdgeDoc[] }) {
  const qc = useQueryClient()
  const move = useMutation({
    mutationFn: (target: string) => gaugeConfigApi.putEdge(target, [...(edges.find((e) => e.edge_id === target)?.machines ?? []), machine]),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gauge-config', 'edges'] }),
  })
  return (
    <span className="flex items-center gap-1.5">
      <select aria-label={`Edge của ${machine}`} className={`${input} !py-0.5 text-[11px]`} value={current} disabled={move.isPending}
        onChange={(e) => e.target.value && move.mutate(e.target.value)}>
        {current === '' && <option value="">Chưa có edge</option>}
        {edges.map((e) => <option key={e.edge_id} value={e.edge_id}>{e.edge_id}</option>)}
      </select>
      {move.error && <ActionError error={move.error} />}
    </span>
  )
}

/** Edge và các máy nó đọc. Máy mới trên camera một edge đang đọc tự về edge đó; ở đây xem lại và chuyển khi cần. */
export default function GaugeEdgesPage() {
  const q = useQuery({ queryKey: ['gauge-config', 'edges'], queryFn: gaugeConfigApi.edges, refetchInterval: 15_000 })
  if (q.isPending) return <Loading />
  const edges = q.data?.edges ?? []
  const now = Date.now()
  return (
    <GaugeArea>
      <header>
        <h1 className="text-lg font-semibold text-text">Edge</h1>
        <p className="mt-0.5 max-w-3xl text-xs text-muted">
          Mỗi edge đọc các máy được giao ở đây; danh sách tới edge qua MQTT, edge không cần khởi động lại. Máy mới khai trên một camera mà
          một edge đang đọc sẽ tự về edge đó.
        </p>
      </header>
      <ActionError error={q.error} />
      {(q.data?.unassigned.length ?? 0) > 0 && (
        <section className="rounded-lg border border-dashed border-warn px-3 py-2.5">
          <h2 className="text-xs font-semibold text-warn">{q.data!.unassigned.length} máy chưa edge nào đọc</h2>
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
            {q.data!.unassigned.map((m) => (
              <li key={m} className="flex items-center gap-2 text-xs text-text">{m}<MoveTo machine={m} current="" edges={edges} /></li>
            ))}
          </ul>
        </section>
      )}
      {edges.length === 0 && <p className="rounded-lg border border-line px-4 py-8 text-center text-xs text-muted">Chưa có edge nào báo về hoặc được giao máy.</p>}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-3">
        {edges.map((e) => (
          <li key={e.edge_id} className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3.5">
            <div className="flex items-center gap-2">
              <i className={`h-2 w-2 rounded-full ${e.status === 'online' ? 'bg-ok' : 'bg-bad'}`} aria-hidden />
              <h2 className="text-[13px] font-semibold text-text">{e.edge_id}</h2>
              <span className="ml-auto text-[11px] text-muted">
                {e.status === 'online' ? 'đang kết nối' : e.status === 'unknown' ? 'chưa từng báo về' : 'mất kết nối'}
                {e.last_seen && `, báo về ${ageLabel(e.last_seen, now)}`}
              </span>
            </div>
            <p className="text-[11px] text-muted">{e.machines.length} máy</p>
            <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
              {e.machines.map((m) => (
                <li key={m} className="flex items-center justify-between gap-2 px-2.5 py-1 text-xs text-text">
                  {m}<MoveTo machine={m} current={e.edge_id} edges={edges} />
                </li>
              ))}
              {e.machines.length === 0 && <li className="px-2.5 py-2 text-[11px] text-muted">Chưa được giao máy nào.</li>}
            </ul>
          </li>
        ))}
      </ul>
    </GaugeArea>
  )
}
