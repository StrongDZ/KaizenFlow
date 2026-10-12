import {
  Activity, Boxes, Camera, Database, Gauge, Library, FileText, FlaskConical, History, LayoutGrid, Lightbulb, Map as MapIcon, Monitor, Package, PanelLeftClose, PanelLeftOpen,
  Cpu, Play, Plug, Radio, ScanSearch, Shapes, Trophy, Warehouse, Workflow, type LucideIcon,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { isTabActive, type SubNav as SubNavData } from '../../lib/nav'

const ICONS: Record<string, LucideIcon> = {
  diagram: Workflow, history: History, flask: FlaskConical, play: Play, radio: Radio, database: Database, plug: Plug, map: MapIcon,
  monitor: Monitor, activity: Activity, lightbulb: Lightbulb, file: FileText, shapes: Shapes, package: Package, gauge: Gauge, camera: Camera,
  trophy: Trophy, boxes: Boxes, warehouse: Warehouse, scan: ScanSearch, cpu: Cpu,
}
const HEAD_ICONS = { overview: LayoutGrid, library: Library, gauge: Gauge, assets: Cpu } as const

/**
 * Panel phụ cạnh thanh chính: điều hướng trong một mục (Tổng quan, một mô hình, đồng hồ, thư viện). Mặc định mở rộng; `compact` là dải biểu tượng hẹp
 * (vẫn bấm chuyển trang được, rê chuột thấy tên) để chừa chỗ cho sơ đồ. `onToggle` đổi giữa hai dạng.
 */
export function SubNav({ nav, path, compact, onToggle }: { nav: SubNavData; path: string; compact: boolean; onToggle: () => void }) {
  const HeadIcon = nav.icon ? HEAD_ICONS[nav.icon] : Workflow
  if (compact) {
    return (
      <nav aria-label={`Điều hướng trong ${nav.title}`} className="flex w-[52px] flex-none flex-col items-center border-r border-line bg-panel-2 print:hidden">
        <button onClick={onToggle} aria-label="Mở rộng panel điều hướng" title={`${nav.title}: mở rộng (phím [)`}
          className="mt-2.5 flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-text">
          <PanelLeftOpen size={16} />
        </button>
        <div className="min-h-0 w-full flex-1 overflow-y-auto px-1.5 pb-3 pt-1">
          {nav.groups.map((g, gi) => (
            <ul key={g.title ?? gi} role="group" aria-label={g.title} className={`space-y-0.5 ${gi > 0 ? 'mt-2 border-t border-line pt-2' : 'mt-1'}`}>
              {g.tabs.map((t) => {
                const Icon = (t.icon && ICONS[t.icon]) || Workflow
                const active = isTabActive(t, path)
                return (
                  <li key={t.to}>
                    <Link to={t.to} aria-current={active ? 'page' : undefined} aria-label={t.label} title={g.title ? `${g.title}: ${t.label}` : t.label}
                      className={`relative flex h-9 w-full items-center justify-center rounded-md ${active ? 'bg-raised text-accent' : 'text-muted hover:bg-panel hover:text-text'}`}>
                      {active && <i className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-accent" aria-hidden />}
                      <Icon size={17} strokeWidth={1.8} aria-hidden />
                    </Link>
                  </li>
                )
              })}
            </ul>
          ))}
        </div>
      </nav>
    )
  }
  return (
    <nav aria-label={`Điều hướng trong ${nav.title}`} className="flex w-[216px] flex-none flex-col border-r border-line bg-panel-2 print:hidden">
      <div className="flex items-center gap-2.5 px-3 pb-2 pt-3">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-accent/15 text-accent" aria-hidden><HeadIcon size={16} /></span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[13px] font-semibold text-text" title={nav.title}>{nav.title}</span>
          {nav.subtitle && <span className="block text-[11px] text-muted">{nav.subtitle}</span>}
        </span>
        <button onClick={onToggle} aria-label="Thu gọn panel điều hướng" title="Thu gọn (phím [)"
          className="flex-none rounded-md p-1 text-faint hover:bg-raised hover:text-text">
          <PanelLeftClose size={15} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 pb-3 pt-1">
        {nav.groups.map((g, gi) => (
          <div key={g.title ?? gi} role="group" aria-label={g.title}>
            {g.title && <div className="px-2 pb-1 pt-1 text-[11px] font-medium text-faint">{g.title}</div>}
            <ul className="space-y-px">
              {g.tabs.map((t) => {
                const Icon = (t.icon && ICONS[t.icon]) || Workflow
                const active = isTabActive(t, path)
                return (
                  <li key={t.to}>
                    <Link
                      to={t.to} aria-current={active ? 'page' : undefined}
                      className={`relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[12.5px] ${active ? 'bg-raised font-semibold text-text' : 'text-text-2 hover:bg-panel hover:text-text'}`}
                    >
                      {active && <i className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-accent" aria-hidden />}
                      <Icon size={15} strokeWidth={1.8} className={active ? 'text-accent' : 'text-muted'} aria-hidden />
                      {t.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  )
}
