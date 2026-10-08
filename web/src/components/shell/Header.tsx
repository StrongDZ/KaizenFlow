import * as Dropdown from '@radix-ui/react-dropdown-menu'
import { ChevronDown, Moon, PanelLeft, PanelLeftClose, Sun } from 'lucide-react'
import { Fragment } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTheme } from '../../hooks/useTheme'
import { versionStatusLabel } from '../../lib/format'
import { crumbsFor, switchVersionPath, type NavCtx } from '../../lib/nav'

function VersionPicker({ label, ctx, path }: { label: string; ctx: NavCtx; path: string }) {
  const versions = ctx.versions ?? []
  return (
    <Dropdown.Root>
      <Dropdown.Trigger className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-text hover:bg-panel" aria-label="Chọn phiên bản">
        {label}
        <ChevronDown size={12} />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content sideOffset={6} className="z-50 min-w-40 rounded-lg border border-line-2 bg-raised p-1 text-xs shadow-xl">
          {[...versions].reverse().map((v) => (
            <Dropdown.Item key={v.id} asChild>
              <Link
                to={switchVersionPath(path, v.id)}
                className="flex items-center justify-between gap-6 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-panel"
              >
                <span className={v.id === ctx.versionId ? 'font-semibold text-text' : 'text-text-2'}>v{v.version}</span>
                <span className="text-muted">{versionStatusLabel(v.status)}</span>
              </Link>
            </Dropdown.Item>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  )
}

function ThemeToggle() {
  const { theme, toggle } = useTheme()
  const label = theme === 'dark' ? 'Chuyển sang chế độ sáng' : 'Chuyển sang chế độ tối'
  return (
    <button
      onClick={toggle} aria-label={label} title={label}
      className="flex-none rounded-md p-1.5 text-muted hover:bg-panel hover:text-text"
    >
      {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  )
}

export function Header({ actionsRef, ctx, panel }: {
  actionsRef: (el: HTMLDivElement | null) => void
  ctx: NavCtx
  /** Có panel điều hướng phụ ở trang này: nút thu gọn / mở rộng nó. */
  panel?: { open: boolean; toggle: () => void }
}) {
  const { pathname } = useLocation()
  const crumbs = crumbsFor(pathname, ctx)
  return (
    <header className="flex h-11 flex-none items-center gap-3 border-b border-line px-3 print:hidden">
      <Link to="/models" className="flex flex-none items-center gap-2 text-[13px] font-semibold text-text">
        <i className="h-3.5 w-3.5 rounded-[3px] bg-text" />
        KaizenFlow
      </Link>
      {panel && (
        <button
          onClick={panel.toggle} aria-pressed={panel.open} aria-label={panel.open ? 'Thu gọn panel điều hướng' : 'Mở rộng panel điều hướng'}
          title={`${panel.open ? 'Thu gọn' : 'Mở rộng'} panel điều hướng (phím [)`}
          className={`flex-none rounded-md p-1.5 ${panel.open ? 'text-text' : 'text-muted'} hover:bg-panel hover:text-text`}
        >
          {panel.open ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
        </button>
      )}
      <nav aria-label="Vị trí hiện tại" className="flex min-w-0 flex-1 items-center text-xs text-muted">
        {crumbs.map((c, i) => (
          <Fragment key={`${i}-${c.label}`}>
            {i > 0 && <span className="px-1.5 text-faint">/</span>}
            {c.picker ? (
              <VersionPicker label={c.label} ctx={ctx} path={pathname} />
            ) : c.to ? (
              <Link to={c.to} className="truncate hover:text-text">{c.label}</Link>
            ) : (
              <span className={`truncate ${i === crumbs.length - 1 ? 'font-medium text-text' : ''}`}>{c.label}</span>
            )}
          </Fragment>
        ))}
      </nav>
      <div className="flex flex-none items-center justify-end gap-2">
        <div ref={actionsRef} className="flex items-center gap-2" />
        <ThemeToggle />
      </div>
    </header>
  )
}
