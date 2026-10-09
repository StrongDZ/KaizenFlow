import { useQueries, useQuery } from '@tanstack/react-query'
import { memo, useMemo, useState } from 'react'
import { api } from '../../api/client'
import type { EventRow, Graph, Json, NodeType } from '../../api/types'
import { fmtTime } from '../../lib/format'
import { defaultSensorSubject, signalsOf } from '../../lib/model'
import { SignalChart, type Mark } from '../Charts'
import { NodeIdentity } from '../NodeIdentity'
import { EmptyState } from '../ui'

/** Sự kiện của máy đáng đánh dấu trên biểu đồ tín hiệu: tên tiếng Việt và màu (đỏ là hỏng, vàng là bắt đầu có lỗi). */
const EVENT: Record<string, { label: string; color: string }> = {
  FAULT_ONSET: { label: 'Bắt đầu có lỗi', color: 'var(--color-warn)' },
  FAILURE: { label: 'Hỏng', color: 'var(--color-bad)' },
  REPAIRED: { label: 'Sửa xong', color: 'var(--color-ok)' },
  PLANNED_STOP: { label: 'Dừng theo kế hoạch', color: 'var(--color-text-2)' },
}

function summary(events: EventRow[]): string {
  const failures = events.filter((e) => e.type === 'FAILURE').length
  const faults = events.filter((e) => e.type === 'FAULT_ONSET').length
  const stops = events.filter((e) => e.type === 'PLANNED_STOP').length
  const parts = [failures && `${failures} lần hỏng`, faults && `${faults} lần có lỗi`, stops && `${stops} lần dừng`].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : 'Không có sự cố'
}

/**
 * Tín hiệu cảm biến giả lập của từng máy trong lần lặp đầu tiên, kèm các mốc hỏng và sửa.
 * Bên trái là các máy có cảm biến, máy có sự cố đứng đầu, để người xem biết nên mở máy nào trước.
 */
// memo: panel không phụ thuộc thời điểm phát lại nên không vẽ lại hàng nghìn điểm mỗi bước
export const SensorPanel = memo(function SensorPanel({ runId, graph, types, injections, replications }: {
  runId: number; graph: Graph; types: Record<string, NodeType>; injections: Json[]; replications: number
}) {
  const machines = graph.nodes.filter((n) => signalsOf(n, types).length > 0)
  // Hỏi theo từng loại sự kiện: API cắt ở 5000 dòng theo thời gian, hỏi tất cả thì mất các lần hỏng ở cuối lần chạy.
  const byType = useQueries({ queries: Object.keys(EVENT).map((type) => ({ queryKey: ['events', runId, type], queryFn: () => api.events(runId, { type }) })) })
  const pending = byType.some((q) => q.isPending)
  const rows = byType.map((q) => q.data)
  const byMachine = useMemo(() => {
    const out = new Map<string, EventRow[]>()
    const all = rows.flatMap((r) => r ?? []).sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
    for (const e of all) {
      if (e.rep !== 0 || !EVENT[e.type]) continue
      const list = out.get(e.subject)
      if (list) list.push(e)
      else out.set(e.subject, [e])
    }
    return out
  }, rows) // mảng phụ thuộc là dữ liệu của bốn truy vấn (độ dài cố định): chỉ tính lại khi một trong số đó đổi
  const ordered = useMemo(() => [...machines].sort((a, b) => (byMachine.get(b.key)?.length ?? 0) - (byMachine.get(a.key)?.length ?? 0)), [machines, byMachine])
  const [picked, setPicked] = useState<string | null>(null)
  const subject = picked ?? defaultSensorSubject(ordered.map((n) => n.key), injections)
  const node = machines.find((n) => n.key === subject)
  const names = node ? signalsOf(node, types) : []
  const [signal, setSignal] = useState<string | null>(null)
  const name = signal && names.includes(signal) ? signal : names[0] ?? ''
  const sig = useQuery({ queryKey: ['signals', runId, subject, name], queryFn: () => api.signals(runId, { subject, name }), enabled: !!subject && !!name })
  const events = byMachine.get(subject) ?? []
  const marks: Mark[] = events.map((e) => ({ t: Date.parse(e.t), label: EVENT[e.type].label, color: EVENT[e.type].color }))

  if (machines.length === 0) {
    return (
      <EmptyState title="Mô hình chưa có máy nào khai báo cảm biến">
        Khai báo tín hiệu (rung, nhiệt…) cho loại máy trong Thư viện, mục Loại node, để mô phỏng sinh tín hiệu và nhãn lỗi cho từng máy.
      </EmptyState>
    )
  }
  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Máy có cảm biến" className="w-[248px] flex-none overflow-y-auto border-r border-line p-2">
        <h2 className="px-2 pb-1.5 pt-1 text-[11px] text-muted">{machines.length} máy có cảm biến</h2>
        <ul className="space-y-px">
          {ordered.map((n) => {
            const ev = byMachine.get(n.key) ?? []
            const bad = ev.some((e) => e.type === 'FAILURE')
            const active = n.key === subject
            return (
              <li key={n.key}>
                <button
                  onClick={() => { setPicked(n.key); setSignal(null) }} aria-current={active ? 'true' : undefined}
                  className={`flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left ${active ? 'bg-raised' : 'hover:bg-panel'}`}
                >
                  <NodeIdentity name={n.name || n.key} code={n.key} archetype={n.archetype} icon={typeof types[n.node_type]?.ui?.icon === 'string' ? types[n.node_type].ui.icon as string : undefined} size={24} />
                  <span className={`pl-[34px] text-[11px] ${bad ? 'text-bad-text' : ev.length > 0 ? 'text-warn' : 'text-muted'}`}>{pending ? '…' : summary(ev)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
      <section className="min-w-0 flex-1 overflow-y-auto p-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-semibold text-text">{node?.name || subject}</h2>
          <span className="text-xs text-muted">Lần lặp 1 trong {replications}: tín hiệu và sự kiện của các lần lặp khác có thể khác.</span>
          {names.length > 1 && (
            <div role="tablist" aria-label="Tín hiệu" className="ml-auto flex gap-1">
              {names.map((s) => (
                <button key={s} role="tab" aria-selected={s === name} onClick={() => setSignal(s)}
                  className={`rounded-md px-2 py-0.5 text-[11px] ${s === name ? 'bg-raised font-semibold text-text' : 'text-muted hover:text-text'}`}>{s}</button>
              ))}
            </div>
          )}
        </div>
        <div className="mt-3 rounded-lg border border-line bg-panel p-3">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
            <span>Tín hiệu <b className="font-medium text-text-2">{name}</b></span>
            {Object.entries(EVENT).map(([k, e]) => (
              <span key={k} className="flex items-center gap-1.5"><i className="h-2.5 w-0.5" style={{ background: e.color }} aria-hidden />{e.label}</span>
            ))}
          </div>
          {sig.isPending ? <div className="flex h-[300px] items-center justify-center text-xs text-muted">Đang tải tín hiệu…</div>
            : <SignalChart rows={(sig.data ?? []).filter((r) => r.rep === 0)} marks={marks} height={300} />}
        </div>
        <h3 className="mt-5 text-xs font-semibold text-text">Sự kiện của máy</h3>
        {events.length === 0 ? (
          <p className="mt-1 text-xs text-muted">Máy chạy bình thường suốt lần lặp này: không có lỗi, hỏng hay dừng kế hoạch.</p>
        ) : (
          <ol className="mt-1.5 divide-y divide-line rounded-lg border border-line">
            {events.map((e, i) => (
              <li key={`${e.t}-${i}`} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                <span className="w-12 flex-none tabular-nums text-muted">{fmtTime(Date.parse(e.t))}</span>
                <i className="h-2 w-2 flex-none rounded-full" style={{ background: EVENT[e.type].color }} aria-hidden />
                <span className="text-text">{EVENT[e.type].label}</span>
                {typeof e.payload?.mode === 'string' && <span className="text-muted">{e.payload.mode}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
})
