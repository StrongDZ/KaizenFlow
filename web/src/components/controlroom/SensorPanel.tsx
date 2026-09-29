import { useQuery } from '@tanstack/react-query'
import { memo, useState } from 'react'
import { api } from '../../api/client'
import type { Graph, Json, NodeType } from '../../api/types'
import { defaultSensorSubject, signalsOf } from '../../lib/model'
import { SignalChart, type Mark } from '../Charts'
import { Card, input } from '../ui'

const MARKS: Record<string, string> = {
  FAULT_ONSET: 'var(--color-warn)', FAILURE: 'var(--color-bad)', REPAIRED: 'var(--color-ok)', PLANNED_STOP: 'var(--color-text-2)',
}

// memo: panel không phụ thuộc thời điểm phát lại nên không vẽ lại hàng nghìn điểm mỗi bước
export const SensorPanel = memo(function SensorPanel({ runId, graph, types, injections, height = 200 }: {
  runId: number; graph: Graph; types: Record<string, NodeType>; injections: Json[]; height?: number
}) {
  const machines = graph.nodes.filter((n) => signalsOf(n, types).length > 0)
  const [subject, setSubject] = useState(() => defaultSensorSubject(machines.map((n) => n.key), injections))
  const node = machines.find((n) => n.key === subject)
  const name = node ? signalsOf(node, types)[0] : ''
  const sig = useQuery({ queryKey: ['signals', runId, subject, name], queryFn: () => api.signals(runId, { subject, name }), enabled: !!subject })
  const ev = useQuery({ queryKey: ['events', runId, subject], queryFn: () => api.events(runId, { subject }), enabled: !!subject })
  const marks: Mark[] = (ev.data ?? []).filter((e) => e.rep === 0 && MARKS[e.type])
    .map((e) => ({ t: Date.parse(e.t), label: e.type, color: MARKS[e.type] }))
  if (machines.length === 0) {
    return <Card title="Tín hiệu cảm biến"><div className="text-xs text-muted">Mô hình chưa có máy khai báo cảm biến.</div></Card>
  }
  return (
    <Card
      title={`Tín hiệu cảm biến giả lập (${name}) và nhãn lỗi`}
      actions={
        <select className={input} aria-label="Chọn máy" value={subject} onChange={(e) => setSubject(e.target.value)}>
          {machines.map((n) => <option key={n.key} value={n.key}>{n.key}</option>)}
        </select>
      }
    >
      <SignalChart rows={(sig.data ?? []).filter((r) => r.rep === 0)} marks={marks} height={height} />
    </Card>
  )
})
