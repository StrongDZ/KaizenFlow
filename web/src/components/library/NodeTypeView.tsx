import type { NodeType } from '../../api/types'
import { failureModeRows, isAssumed, paramGroups, recipeOf, signalDefRows } from '../../lib/nodeTypeView'
import { Tag } from '../ui'

export function RecipeStrip({ t }: { t: Pick<NodeType, 'name' | 'default_params'> }) {
  const r = recipeOf(t)
  if (!r) {
    return <p className="rounded-xl border border-line bg-panel-2 px-3 py-2.5 text-xs text-muted">Công thức (đầu vào và đầu ra) do từng node quyết định, không nằm ở loại này.</p>
  }
  const pill = 'rounded-lg border border-line-2 bg-panel px-2.5 py-1 text-xs'
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel-2 px-3 py-2.5">
      {r.inputs.map((l) => (
        <span key={l.material} className={pill}>{l.material}<small className="block text-[10px] text-muted">đầu vào, {l.qty}</small></span>
      ))}
      <span className="text-faint">→</span>
      <span className={`${pill} bg-raised font-semibold`}>{t.name}</span>
      <span className="text-faint">→</span>
      {r.outputs.map((l) => (
        <span key={`${l.material}-${l.port}`} className={`${pill} ${l.port === 'NG' ? 'border-bad/50 text-bad-text' : ''}`}>
          {l.material}<small className="block text-[10px] text-muted">cổng {l.port}, {l.qty}</small>
        </span>
      ))}
    </div>
  )
}

export function ParamGrid({ t, compact = false }: { t: Pick<NodeType, 'archetype' | 'default_params'>; compact?: boolean }) {
  const groups = paramGroups(t)
  if (groups.length === 0) return <p className="text-xs text-muted">Loại này chưa có tham số mặc định.</p>
  return (
    <div className="space-y-3">
      <div className={`grid gap-3 ${compact ? 'grid-cols-1' : 'grid-cols-3'}`}>
        {groups.map((g) => (
          <section key={g.title} className="min-w-0 rounded-xl border border-line bg-panel-2 px-3 py-2">
            <h3 className="mb-1 text-[11.5px] font-semibold text-text-2">{g.title}</h3>
            {g.rows.map((r) => (
              <div key={r.label} className="flex justify-between gap-3 border-t border-line/60 py-1 text-xs first:border-0">
                <span className="text-muted">{r.label}</span>
                <b className="text-right font-medium tabular-nums text-text">{r.value}</b>
              </div>
            ))}
          </section>
        ))}
      </div>
      {isAssumed(t) && (
        <p className="flex items-center gap-2 text-[11px] text-muted"><Tag>giả định</Tag>Giá trị mặc định chưa có dữ liệu DENSO, sẽ thay khi có số đo thật.</p>
      )}
    </div>
  )
}

export function FailureModeTable({ t }: { t: Pick<NodeType, 'failure_modes'> }) {
  const rows = failureModeRows(t)
  if (rows.length === 0) return <p className="text-xs text-muted">Loại này không có chế độ hỏng.</p>
  return (
    <table className="w-full border-collapse text-xs">
      <thead><tr className="text-left text-[11px] text-muted"><th className="py-1.5">Mã</th><th>Bắt đầu suy giảm</th><th>Từ suy giảm đến hỏng</th><th>Sửa chữa</th><th>Ảnh hưởng cảm biến</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.code} className="border-t border-line align-top">
            <td className="py-2 font-medium text-text">{r.code}</td><td className="pr-3">{r.onset}</td><td className="pr-3">{r.pf}</td><td className="pr-3">{r.repair}</td><td>{r.effects.join(', ') || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function SignalTable({ t }: { t: Pick<NodeType, 'signals'> }) {
  const rows = signalDefRows(t)
  if (rows.length === 0) return <p className="text-xs text-muted">Loại này không sinh tín hiệu cảm biến.</p>
  return (
    <table className="w-full border-collapse text-xs">
      <thead><tr className="text-left text-[11px] text-muted"><th className="py-1.5">Tín hiệu</th><th>Đơn vị</th><th>Tần số</th><th>Giá trị nền</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} className="border-t border-line"><td className="py-2 font-medium text-text">{r.name}</td><td>{r.unit || '—'}</td><td>{r.rate}</td><td>{r.base}</td></tr>
        ))}
      </tbody>
    </table>
  )
}
