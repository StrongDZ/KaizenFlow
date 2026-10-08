import { Activity, Flame, Funnel, Lightbulb, Wrench, type LucideIcon } from 'lucide-react'
import { KIND_LABEL } from '../lib/alertsView'
import { Tag } from './ui'

/** Mỗi loại cảnh báo một biểu tượng và một tông: đỏ là sắp hết hàng thật, vàng là rủi ro vận hành, xanh dương là lệch số liệu, xanh lá là gợi ý. */
const META: Record<string, { icon: LucideIcon; tone: 'bad' | 'warn' | 'accent' | 'ok' }> = {
  RED_RISK: { icon: Flame, tone: 'bad' },
  FAULT_RISK: { icon: Wrench, tone: 'warn' },
  BOTTLENECK: { icon: Funnel, tone: 'warn' },
  DRIFT: { icon: Activity, tone: 'accent' },
  RECOMMENDATION: { icon: Lightbulb, tone: 'ok' },
}
const TILE: Record<string, string> = {
  bad: 'bg-bad/12 text-bad-text', warn: 'bg-warn/12 text-warn', accent: 'bg-accent/12 text-accent', ok: 'bg-ok/12 text-ok',
}

export const alertIcon = (kind: string): LucideIcon => META[kind]?.icon ?? Activity

export function AlertKindTag({ kind }: { kind: string }) {
  const m = META[kind]
  return <Tag tone={m?.tone ?? 'neutral'} icon={m?.icon}>{KIND_LABEL[kind] ?? kind}</Tag>
}

/** Ô biểu tượng tròn cho một dòng cảnh báo (danh sách ngắn, không có cột Loại). */
export function AlertKindIcon({ kind, size = 28 }: { kind: string; size?: number }) {
  const m = META[kind]
  const Icon = m?.icon ?? Activity
  return (
    <span title={KIND_LABEL[kind] ?? kind} className={`inline-flex flex-none items-center justify-center rounded-full ${TILE[m?.tone ?? 'accent']}`} style={{ width: size, height: size }}>
      <Icon size={Math.round(size * 0.5)} aria-hidden />
    </span>
  )
}
