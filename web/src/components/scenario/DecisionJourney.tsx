import { Activity, FileText, GitCompareArrows, Lightbulb, SlidersHorizontal } from 'lucide-react'
import { Link } from 'react-router-dom'

export type JourneyStage = 'setup' | 'observe' | 'decide' | 'validate' | 'report'

const STAGES = [
  { key: 'setup', label: 'Thiết lập', icon: SlidersHorizontal },
  { key: 'observe', label: 'Quan sát', icon: Activity },
  { key: 'decide', label: 'Quyết định', icon: Lightbulb },
  { key: 'validate', label: 'Kiểm chứng', icon: GitCompareArrows },
  { key: 'report', label: 'Báo cáo', icon: FileText },
] as const

export function DecisionJourney({ active, links = {}, compact = false, className = '' }: {
  active: JourneyStage
  links?: Partial<Record<JourneyStage, string>>
  compact?: boolean
  className?: string
}) {
  const activeIndex = STAGES.findIndex((stage) => stage.key === active)
  return (
    <nav aria-label="Hành trình ra quyết định" className={`print:hidden ${className}`}>
      <ol className={`flex items-center overflow-hidden rounded-xl border border-line bg-panel/95 shadow-sm backdrop-blur ${compact ? 'justify-center p-1' : 'p-1.5'}`}>
        {STAGES.map((stage, index) => {
          const Icon = stage.icon
          const selected = stage.key === active
          const visited = index < activeIndex
          const content = (
            <span title={compact ? stage.label : undefined} className={`flex items-center rounded-lg font-medium transition ${compact ? 'gap-1 px-1 py-1 text-[9.5px]' : 'gap-1.5 px-3 py-2 text-[11px]'} ${
              selected ? 'bg-accent text-on-accent' : visited ? 'text-text-2' : 'text-muted'
            }`}>
              <span className={`flex h-5 w-5 items-center justify-center rounded-full ${selected ? 'bg-on-accent/15' : visited ? 'bg-ok/15 text-ok' : 'bg-panel-2'}`}>
                <Icon size={compact ? 11 : 12} />
              </span>
              <span className={compact && !selected ? 'sr-only' : ''}>{stage.label}</span>
            </span>
          )
          return (
            <li key={stage.key} className="flex items-center">
              {links[stage.key] && !selected ? <Link to={links[stage.key]!}>{content}</Link> : content}
              {index < STAGES.length - 1 && <i className={`${compact ? 'mx-px w-2' : 'mx-0.5 w-3'} h-px ${index < activeIndex ? 'bg-ok/60' : 'bg-line-2'}`} />}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
