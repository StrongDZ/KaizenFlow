import { useCallback, useSyncExternalStore } from 'react'
import { THEME_KEY, otherTheme, parseTheme, type Theme } from '../lib/theme'

const listeners = new Set<() => void>()

function current(): Theme {
  return parseTheme(document.documentElement.getAttribute('data-theme'))
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Nguồn sự thật là thuộc tính data-theme trên <html> (script trong index.html đặt trước khi vẽ, tránh nháy màu). */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, current, () => 'dark' as Theme)
  const toggle = useCallback(() => {
    const next = otherTheme(current())
    document.documentElement.setAttribute('data-theme', next)
    try { localStorage.setItem(THEME_KEY, next) } catch { /* không lưu được thì chỉ mất lựa chọn sau lần tải lại */ }
    listeners.forEach((fn) => fn())
  }, [])
  return { theme, toggle }
}
