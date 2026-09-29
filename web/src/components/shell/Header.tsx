import * as Dropdown from '@radix-ui/react-dropdown-menu'
import { ChevronDown } from 'lucide-react'
import { Fragment } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useNavCtx } from '../../hooks/useNavCtx'
import { versionStatusLabel } from '../../lib/format'
import { crumbsFor, isTabActive, switchVersionPath, tabsFor, type NavCtx } from '../../lib/nav'

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

export function Header({ actionsRef }: { actionsRef: (el: HTMLDivElement | null) => void }) {
  const { pathname } = useLocation()
  const ctx = useNavCtx(pathname)
  const crumbs = crumbsFor(pathname, ctx)
  const tabs = tabsFor(pathname, ctx)
  return (
    <header className="grid h-10 flex-none grid-cols-[1fr_auto_1fr] items-center gap-4 border-b border-line px-3 print:hidden">
      <div className="flex min-w-0 items-center gap-4">
        <Link to="/models" className="flex flex-none items-center gap-2 text-[13px] font-semibold text-text">
          <i className="h-3.5 w-3.5 rounded-[3px] bg-text" />
          KaizenFlow
        </Link>
        <nav aria-label="Vị trí hiện tại" className="flex min-w-0 items-center text-xs text-muted">
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
      </div>
      <nav aria-label="Tab của object" className="flex gap-0.5 rounded-lg bg-panel p-[3px]">
        {tabs.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            aria-current={isTabActive(t, pathname) ? 'page' : undefined}
            className={`rounded-md px-3 py-1 text-xs font-medium ${isTabActive(t, pathname) ? 'bg-text text-bg' : 'text-muted hover:text-text'}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <div ref={actionsRef} className="flex items-center justify-end gap-2" />
    </header>
  )
}
