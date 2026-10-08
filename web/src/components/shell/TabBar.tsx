import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { isTabActive, type Tab } from '../../lib/nav'

/**
 * Dải tab của một đối tượng (một lần chạy, một trạm đồng hồ) nằm ngay dưới header chung: các góc nhìn của cùng một thứ.
 * Điều hướng giữa các trang của một mục (mô hình, thư viện, đồng hồ) thì ở panel phụ, không ở đây. `end` là phần bên phải (trạng thái, nút).
 */
export function TabBar({ label, tabs, end }: { label: string; tabs: (Tab & { count?: number })[]; end?: ReactNode }) {
  const { pathname } = useLocation()
  return (
    <div className="flex h-10 flex-none items-stretch gap-4 border-b border-line bg-panel-2 px-3 print:hidden">
      <nav aria-label={label} className="-mb-px flex items-stretch gap-0.5 overflow-x-auto">
        {tabs.map((t) => {
          const active = isTabActive(t, pathname)
          return (
            <Link
              key={t.to} to={t.to} aria-current={active ? 'page' : undefined}
              className={`relative flex items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-[12.5px] ${
                active ? 'border-accent font-semibold text-text' : 'border-transparent text-muted hover:text-text'
              }`}
            >
              {t.label}
              {t.count !== undefined && (
                <span className={`rounded-full px-1.5 text-[10.5px] font-semibold tabular-nums leading-4 ${active ? 'bg-accent text-on-accent' : 'bg-raised text-text-2'}`}>{t.count}</span>
              )}
            </Link>
          )
        })}
      </nav>
      {end && <div className="ml-auto flex min-w-0 items-center gap-3">{end}</div>}
    </div>
  )
}
