/** Giá trị mặc định của loại node (default_params) đặt cạnh form, để ô trống nói rõ nó sẽ dùng gì. */
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const fmt = (n: number) => String(n).replace('.', ',')

/**
 * Tra mặc định theo id trường của rjsf (`root_arrivals_interarrival`). Khoá tự chứa dấu gạch dưới (`coverage_thresholds`),
 * nên không cắt theo dấu đó mà thử từng khoá làm tiền tố. Đường dẫn đi qua mảng thì không có mặc định.
 */
export function defaultAt(defaults: unknown, id: string): unknown {
  const walk = (node: unknown, rest: string): unknown => {
    if (rest === '') return node
    if (!isObj(node)) return undefined
    for (const key of Object.keys(node).sort((a, b) => b.length - a.length)) {
      if (rest === key || rest.startsWith(`${key}_`)) {
        const found = walk(node[key], rest === key ? '' : rest.slice(key.length + 1))
        if (found !== undefined) return found
      }
    }
    return undefined
  }
  return walk(defaults, id.replace(/^root_?/, ''))
}

/** uiSchema đặt placeholder = mặc định của loại node cho mọi ô số. */
export function placeholderUi(defaults: unknown): Obj {
  if (!isObj(defaults)) return {}
  const out: Obj = {}
  for (const [k, v] of Object.entries(defaults)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = { 'ui:placeholder': fmt(v) }
    else if (isObj(v)) {
      const inner = placeholderUi(v)
      if (Object.keys(inner).length > 0) out[k] = inner
    }
  }
  return out
}
