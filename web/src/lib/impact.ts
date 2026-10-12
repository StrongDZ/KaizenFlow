const LABEL: Record<string, string> = { versions: 'phiên bản', scenarios: 'scenario', runs: 'lần chạy', bindings: 'ghép nối' }
const ORDER = ['versions', 'scenarios', 'runs', 'bindings']

/** "2 phiên bản, 3 scenario, 12 lần chạy": những gì sẽ mất khi xoá dây chuyền. */
export function impactText(impact: Record<string, number>): string {
  const known = ORDER.filter((k) => impact[k] > 0).map((k) => `${impact[k]} ${LABEL[k]}`)
  const extra = Object.entries(impact).filter(([k, n]) => !ORDER.includes(k) && n > 0).map(([k, n]) => `${n} ${k}`)
  return [...known, ...extra].join(', ')
}
