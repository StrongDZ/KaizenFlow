export const SPEEDS = [1, 4, 16] as const
export type Speed = (typeof SPEEDS)[number]

const BASE_TICK_MS = 120

export function tickMs(speed: Speed): number {
  return BASE_TICK_MS / speed
}

export function nextSpeed(s: Speed): Speed {
  return SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]
}

export function stepIndex(i: number, len: number, key: string, shift: boolean): number {
  if (len <= 0) return 0
  const last = len - 1
  const d = shift ? 10 : 1
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, i - d)
    case 'ArrowRight':
      return Math.min(last, i + d)
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return i
  }
}

export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!el) return false
  const tag = (el.tagName ?? '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}
