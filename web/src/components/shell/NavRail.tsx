import { Bell, Gauge, LayoutGrid, Library, Play, Workflow, type LucideIcon } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { sectionOf, type Section } from '../../lib/nav'

const ITEMS: { key: Section; label: string; to: string; icon: LucideIcon }[] = [
  { key: 'overview', label: 'Tổng quan', to: '/', icon: LayoutGrid },
  { key: 'models', label: 'Mô hình', to: '/models', icon: Workflow },
  { key: 'runs', label: 'Lần chạy', to: '/runs', icon: Play },
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
          className={`flex w-12 flex-col items-center gap-0.5 whitespace-nowrap rounded-lg py-1.5 text-[9.5px] ${
            active === key ? 'bg-panel text-text' : 'text-muted hover:text-text'
          }`}
        >
          <Icon size={18} strokeWidth={1.6} />
          {label}
        </Link>
      ))}
    </nav>
  )
}
