import { useMutation, useQuery } from '@tanstack/react-query'
import { Background, Controls, ReactFlow, ReactFlowProvider } from '@xyflow/react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { BandRow, Graph, NodeType, RunDetail, Scenario } from '../api/types'
import { BandChart, SignalChart, fmtTime, type Mark } from '../components/Charts'
import { kfNodeTypes } from '../components/KfNode'
import { Card, ErrorBox, KpiTile, Loading, StatusChip, btn, btnPrimary } from '../components/ui'
import { toFlow, type Badge, type FlowNode } from '../lib/graph'
import { candidatesOf, describeAction, describeInsight, kpiP50 } from '../lib/insights'
import { byCode, poolCount, signalsOf, thresholdsFor } from '../lib/model'
import { clip, colorFor, indexBands, series, timeline, valueAt, type BandIndex } from '../lib/replay'

export default function ControlRoomPage() {
  const runId = Number(useParams().id)
  const run = useQuery({
    queryKey: ['run', runId], queryFn: () => api.run(runId),
    refetchInterval: (q) => (q.state.data && ['DONE', 'FAILED'].includes(q.state.data.status) ? false : 3000),
  })
  const scenario = useQuery({ queryKey: ['scenario', run.data?.scenario_id], queryFn: () => api.scenario(run.data!.scenario_id), enabled: !!run.data })
  const graph = useQuery({ queryKey: ['graph', scenario.data?.model_version_id], queryFn: () => api.graph(scenario.data!.model_version_id), enabled: !!scenario.data })
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  const done = run.data?.status === 'DONE'
  const bands = useQuery({ queryKey: ['bands', runId], queryFn: () => api.bands(runId), enabled: done })

  if (run.error) return <div className="p-6"><ErrorBox error={run.error} /></div>
  if (!run.data || !scenario.data || !graph.data || !types.data) return <Loading />
  if (!done) {
    return (
      <div className="space-y-3 p-6">
        <div className="flex items-center gap-2"><span>Run #{run.data.id}</span><StatusChip status={run.data.status} /></div>
        {run.data.status === 'FAILED'
          ? <ErrorBox error={new Error(run.data.error ?? 'Run thất bại')} />
          : <div className="text-sm text-slate-500">Đang mô phỏng… trang tự cập nhật khi xong.</div>}
      </div>
    )
  }
  if (!bands.data) return <Loading />
  return (
    <ReactFlowProvider>
      <Room run={run.data} scenario={scenario.data} graph={graph.data} types={byCode(types.data)} rows={bands.data} />
    </ReactFlowProvider>
  )
}

function badgeFor(n: FlowNode, idx: BandIndex, t: number, types: Record<string, NodeType>): Badge | undefined {
  const ref = { node_type: n.data.nodeType, params: n.data.params }
  if (n.data.archetype === 'STORAGE') {
    const cov = valueAt(series(idx, n.id, 'coverage_h'), t)?.p50
    const text = cov === undefined ? '—' : cov >= 999 ? 'không tiêu thụ' : `còn ${cov.toFixed(1)} h`
    return { color: colorFor(cov, thresholdsFor(ref, types)), text }
  }
  if (n.data.archetype === 'RESOURCE_POOL') {
    const busy = valueAt(series(idx, n.id, 'busy'), t)?.p50
    const queue = valueAt(series(idx, n.id, 'queue_len'), t)?.p50 ?? 0
    return busy === undefined ? undefined : { color: 'INFO', text: `${Math.round(busy)}/${poolCount(ref, types)} bận · ${Math.round(queue)} chờ` }
  }
  return undefined
}

function Room({ run, scenario, graph, types, rows }: {
  run: RunDetail; scenario: Scenario; graph: Graph; types: Record<string, NodeType>; rows: BandRow[]
}) {
  const navigate = useNavigate()
  const idx = useMemo(() => indexBands(rows), [rows])
  const times = useMemo(() => timeline(idx), [idx])
  const [ti, setTi] = useState(0)
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!playing) return
    const h = setInterval(() => setTi((i) => Math.min(i + 1, times.length - 1)), 120)
    return () => clearInterval(h)
  }, [playing, times.length])
  useEffect(() => { if (ti >= times.length - 1) setPlaying(false) }, [ti, times.length])
  const t = times[ti] ?? 0

  const flow = useMemo(() => toFlow(graph, types), [graph, types])
  const nodes = useMemo(() => flow.nodes.map((n) => ({ ...n, draggable: false, data: { ...n.data, badge: badgeFor(n, idx, t, types) } })), [flow, idx, t, types])
  const edges = useMemo(() => flow.edges.map((e) => {
    const v = valueAt(series(idx, e.id, 'in_transit'), t)?.p50 ?? 0
    return { ...e, animated: v >= 0.5, label: v >= 0.5 ? `${String(e.label)} · ${Math.round(v)} đang chạy` : e.label }
  }), [flow, idx, t])

  const storages = graph.nodes.filter((n) => n.archetype === 'STORAGE')
  const redRisk = run.insights.find((i) => i.kind === 'RED_RISK')
  const [focus, setFocus] = useState<string>(redRisk?.subject_key ?? storages[0]?.key ?? '')
  const focusNode = storages.find((n) => n.key === focus)

  const apply = useMutation({
    mutationFn: ({ id, rank }: { id: number; rank: number }) => api.applyInsight(id, rank),
    onSuccess: (r) => navigate(`/runs/${r.run_id}`),
  })
  const parentRuns = useQuery({ queryKey: ['runs', scenario.parent_id], queryFn: () => api.runs(scenario.parent_id!), enabled: scenario.parent_id !== null })
  const parentRun = parentRuns.data?.find((r) => r.status === 'DONE')

  const fmt = (v?: number, d = 0) => (v === undefined ? '—' : v.toFixed(d))
  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{scenario.name || `Scenario #${scenario.id}`}</h1>
        <span className="text-sm text-slate-500">Run #{run.id} · bắt đầu {new Date(run.sim_start).toLocaleString('vi-VN')} · {scenario.replications} lần lặp</span>
        <div className="flex-1" />
        {parentRun && <Link className={btn} to={`/compare?a=${parentRun.id}&b=${run.id}`}>So sánh với gốc</Link>}
        <Link className={btn} to={`/runs/${run.id}/report`}>Báo cáo</Link>
        <a className={btn} href={api.exportUrl(run.id)}>Tải dữ liệu tổng hợp (CSV)</a>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <KpiTile label="Sản lượng xuất (p50)" value={fmt(kpiP50(run.kpis, 'throughput'))} hint="đơn vị trong khung giờ" />
        <KpiTile label="Tổng phút Đỏ (p50)" value={fmt(kpiP50(run.kpis, 'red_minutes'))} hint="cộng mọi kho" />
        <KpiTile label="Nợ đơn cuối kỳ (p50)" value={fmt(kpiP50(run.kpis, 'backorder_end'))} />
        <KpiTile label="Thời điểm đang xem" value={times.length ? fmtTime(t) : '—'} hint={`${ti + 1}/${times.length}`} />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 h-[460px] rounded-lg border border-slate-200 bg-white">
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={kfNodeTypes} nodesConnectable={false} fitView>
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <div className="space-y-3 overflow-y-auto">
          <Card title="Cảnh báo & điểm nghẽn">
            <ul className="space-y-2 text-sm">
              {run.insights.filter((i) => i.kind !== 'RECOMMENDATION').map((i) => (
                <li key={i.id} className={`rounded px-2 py-1 ${i.kind === 'RED_RISK' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-800'}`}>
                  <button className="text-left" onClick={() => i.subject_key && setFocus(i.subject_key)}>{describeInsight(i)}</button>
                </li>
              ))}
              {run.insights.length === 0 && <li className="text-slate-500">Không có cảnh báo.</li>}
            </ul>
          </Card>
          {run.insights.filter((i) => i.kind === 'RECOMMENDATION').map((i) => (
            <Card key={i.id} title={describeInsight(i)}>
              <ErrorBox error={apply.error} />
              <ol className="space-y-2 text-sm">
                {candidatesOf(i).map((c) => (
                  <li key={c.rank} className="rounded border border-slate-200 p-2">
                    <div className="font-medium">#{c.rank} {describeAction(c.action)}</div>
                    <div className="text-xs text-slate-500">
                      giảm {c.delta_kpi.red_minutes.toFixed(1)} phút Đỏ · sản lượng {c.delta_kpi.throughput >= 0 ? '+' : ''}{c.delta_kpi.throughput.toFixed(1)}
                    </div>
                    <button className={`${btnPrimary} mt-1`} disabled={apply.isPending} onClick={() => apply.mutate({ id: i.id, rank: c.rank })}>
                      Áp dụng &amp; chạy lại
                    </button>
                  </li>
                ))}
              </ol>
            </Card>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-2">
        <button className={btn} onClick={() => { if (ti >= times.length - 1) setTi(0); setPlaying(!playing) }}>{playing ? '⏸ Dừng' : '▶ Phát lại'}</button>
        <input type="range" min={0} max={Math.max(0, times.length - 1)} value={ti} onChange={(e) => { setPlaying(false); setTi(Number(e.target.value)) }} className="flex-1" />
        <span className="w-14 text-right text-sm">{times.length ? fmtTime(t) : ''}</span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card title="Số giờ tồn kho còn đủ dùng (dải p10–p90)" actions={
          <select className="rounded border border-slate-300 px-2 py-0.5 text-sm" value={focus} onChange={(e) => setFocus(e.target.value)}>
            {storages.map((n) => <option key={n.key} value={n.key}>{n.key}</option>)}
          </select>}>
          <BandChart points={clip(series(idx, focus, 'coverage_h'), 24)} cursor={t}
            redH={focusNode ? thresholdsFor(focusNode, types).red_h : undefined} />
        </Card>
        <SensorPanel runId={run.id} graph={graph} types={types} />
      </div>
    </div>
  )
}

const MARKS: Record<string, string> = { FAULT_ONSET: '#f59e0b', FAILURE: '#dc2626', REPAIRED: '#16a34a', PLANNED_STOP: '#2563eb' }

function SensorPanel({ runId, graph, types }: { runId: number; graph: Graph; types: Record<string, NodeType> }) {
  const machines = graph.nodes.filter((n) => signalsOf(n, types).length > 0)
  const [subject, setSubject] = useState(machines[0]?.key ?? '')
  const node = machines.find((n) => n.key === subject)
  const name = node ? signalsOf(node, types)[0] : ''
  const sig = useQuery({ queryKey: ['signals', runId, subject, name], queryFn: () => api.signals(runId, { subject, name }), enabled: !!subject })
  const ev = useQuery({ queryKey: ['events', runId, subject], queryFn: () => api.events(runId, { subject }), enabled: !!subject })
  const marks: Mark[] = (ev.data ?? []).filter((e) => e.rep === 0 && MARKS[e.type])
    .map((e) => ({ t: Date.parse(e.t), label: e.type, color: MARKS[e.type] }))
  if (machines.length === 0) return <Card title="Tín hiệu cảm biến"><div className="text-sm text-slate-500">Mô hình chưa có máy khai báo sensor.</div></Card>
  return (
    <Card title={`Tín hiệu cảm biến giả lập (${name}) — nhãn lỗi`} actions={
      <select className="rounded border border-slate-300 px-2 py-0.5 text-sm" value={subject} onChange={(e) => setSubject(e.target.value)}>
        {machines.map((n) => <option key={n.key} value={n.key}>{n.key}</option>)}
      </select>}>
      <SignalChart rows={(sig.data ?? []).filter((r) => r.rep === 0)} marks={marks} />
    </Card>
  )
}
