import type { PinTone } from '../lib/pins'

const TONE: Record<PinTone, string> = {
  bad: 'bg-bad ring-bad/25',
  warn: 'bg-warn ring-warn/25',
}

/** Class của ghim tròn đánh số; dùng cho nút trên node và chấm trong danh sách. */
export function pinClass(tone: PinTone, size: 'sm' | 'md' = 'md'): string {
  const box = size === 'md' ? 'h-[19px] w-[19px] text-[10.5px] ring-4' : 'h-[17px] w-[17px] text-[9.5px]'
  return `inline-flex flex-none items-center justify-center rounded-full font-bold text-bg ${box} ${TONE[tone]}`
}

export function PinDot({ n, tone }: { n: number; tone: PinTone }) {
  return <span className={pinClass(tone, 'sm')}>{n}</span>
}
