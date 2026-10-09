import { useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useNavCtx } from '../../hooks/useNavCtx'
import { isCanvasPath, subNavFor } from '../../lib/nav'
import { Header } from './Header'
import { NavRail } from './NavRail'
import { ShellContext } from './ShellContext'
import { SubNav } from './SubNav'

/** Lựa chọn thu gọn panel phụ, nhớ riêng cho trang sơ đồ và trang thường (thu gọn ở sơ đồ không làm trang danh sách bị thu theo). */
const KEY = { canvas: 'kf-subnav-canvas', page: 'kf-subnav' } as const
type Kind = keyof typeof KEY

function readCompact(): Record<Kind, boolean> {
  const one = (k: Kind) => { try { return localStorage.getItem(KEY[k]) === 'compact' } catch { return false } }
  return { canvas: one('canvas'), page: one('page') }
}

export function Shell() {
  const { pathname, search } = useLocation()
  const ctx = useNavCtx(pathname, search)
  const sub = subNavFor(pathname, ctx)
  const kind: Kind = isCanvasPath(pathname) ? 'canvas' : 'page'
  const [focus, setFocus] = useState(false)
  const [actionsEl, setActionsEl] = useState<HTMLElement | null>(null)
  // Mặc định panel phụ mở rộng ở mọi trang; người dùng tự thu gọn thành dải biểu tượng nếu muốn.
  const [compact, setCompact] = useState(readCompact)
  // Chế độ tập trung không được kẹt lại khi sang trang khác.
  useEffect(() => setFocus(false), [pathname])

  const isCompact = compact[kind]
  const toggle = () => {
    if (!sub) return
    setCompact((c) => {
      const next = { ...c, [kind]: !c[kind] }
      try { localStorage.setItem(KEY[kind], next[kind] ? 'compact' : 'open') } catch { /* chỉ mất lựa chọn sau khi tải lại */ }
      return next
    })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (e.key === '[' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); toggle() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const value = useMemo(() => ({ focus, setFocus, actionsEl }), [focus, actionsEl])
  return (
    <ShellContext.Provider value={value}>
      <div className="flex h-screen flex-col bg-bg text-text print:block print:h-auto">
        <Header actionsRef={setActionsEl} ctx={ctx} panel={sub && !focus ? { open: !isCompact, toggle } : undefined} />
        <div className="flex min-h-0 flex-1 print:block">
          {!focus && <NavRail />}
          {sub && !focus && <SubNav nav={sub} path={pathname} compact={isCompact} onToggle={toggle} />}
          <main className="relative min-w-0 flex-1 overflow-auto print:overflow-visible">
            <Outlet />
          </main>
        </div>
      </div>
    </ShellContext.Provider>
  )
}
