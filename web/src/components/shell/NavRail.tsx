import { Bell, Cpu, Gauge, LayoutGrid, Library, Workflow, type LucideIcon } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { sectionOf, type Section } from '../../lib/nav'

const ITEMS: { key: Section; label: string; to: string; icon: LucideIcon }[] = [
  { key: 'overview', label: 'Tổng quan', to: '/', icon: LayoutGrid },
  { key: 'models', label: 'Mô hình', to: '/models', icon: Workflow },
  { key: 'assets', label: 'Thiết bị', to: '/assets', icon: Cpu },
  { key: 'alerts', label: 'Cảnh báo', to: '/alerts', icon: Bell },
  { key: 'gauge', label: 'Đồng hồ', to: '/gauge-twin', icon: Gauge },
  { key: 'library', label: 'Thư viện', to: '/library/node-types', icon: Library },
]

export function NavRail() {
  const active = sectionOf(useLocation().pathname)
  return (
    <nav aria-label="Điều hướng chính" className="flex w-14 flex-none flex-col items-center gap-1 border-r border-line py-2 print:hidden">
      {ITEMS.map(({ key, label, to, icon: Icon }) => (
        <Link
          key={key}
          to={to}
          aria-current={active === key ? 'page' : undefined}
          className={`group flex w-12 flex-col items-center gap-1 whitespace-nowrap py-1 text-[10px] ${active === key ? 'font-medium text-text' : 'text-muted hover:text-text'}`}
        >
          <span className={`flex h-8 w-10 items-center justify-center rounded-lg ${active === key ? 'bg-accent/15 text-accent' : 'group-hover:bg-panel'}`}>
            <Icon size={18} strokeWidth={1.7} />
          </span>
          {label}
        </Link>
      ))}
    </nav>
  )
}
