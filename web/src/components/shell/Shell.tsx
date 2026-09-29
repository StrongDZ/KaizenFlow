import { useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Header } from './Header'
import { NavRail } from './NavRail'
import { ShellContext } from './ShellContext'

export function Shell() {
  const { pathname } = useLocation()
  const [focus, setFocus] = useState(false)
  const [actionsEl, setActionsEl] = useState<HTMLElement | null>(null)
  // Chế độ tập trung không được kẹt lại khi sang trang khác.
  useEffect(() => setFocus(false), [pathname])
  const value = useMemo(() => ({ focus, setFocus, actionsEl }), [focus, actionsEl])
  return (
    <ShellContext.Provider value={value}>
      <div className="flex h-screen flex-col bg-bg text-text print:block print:h-auto">
        <Header actionsRef={setActionsEl} />
        <div className="flex min-h-0 flex-1 print:block">
          {!focus && <NavRail />}
          <main className="relative min-w-0 flex-1 overflow-auto print:overflow-visible">
            <Outlet />
          </main>
        </div>
      </div>
    </ShellContext.Provider>
  )
}
