import { createContext, useContext, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { createPortal } from 'react-dom'

export type ShellState = {
  focus: boolean
  setFocus: Dispatch<SetStateAction<boolean>>
  actionsEl: HTMLElement | null
}

export const ShellContext = createContext<ShellState>({ focus: false, setFocus: () => {}, actionsEl: null })

export function useShell(): ShellState {
  return useContext(ShellContext)
}

/** Đẩy nút của trang vào phía phải header. */
export function HeaderActions({ children }: { children: ReactNode }) {
  const { actionsEl } = useShell()
  return actionsEl ? createPortal(children, actionsEl) : null
}
