import { getDefaultRegistry } from '@rjsf/core'
import type { FieldProps } from '@rjsf/utils'
import { KINDS, KIND_LABEL, describeDist, isDistSchema, kindOf, paramsOf, readParam, setKind, setParam, unitFor, type Kind } from '../lib/dist'
import { defaultAt } from '../lib/paramDefaults'

/**
 * Ô "cố định hoặc ngẫu nhiên": chọn kiểu, rồi chỉ hiện các tham số kiểu đó dùng (mặc định của rjsf hiện cả 8 ô cho mọi kiểu).
 */
type Ctx = { defaults?: unknown; emptyLabel?: string }

function DistField({ formData, onChange, name, disabled, readonly, required, idSchema, formContext }: FieldProps) {
  const off = disabled || readonly
  const kind = kindOf(formData)
  const unit = unitFor(name)
  const ctx = (formContext ?? {}) as Ctx
  const inherited = defaultAt(ctx.defaults, idSchema.$id)
  const inheritedText = describeDist(inherited, unit)
  const emptyLabel = ctx.emptyLabel ?? 'Dùng mặc định của loại node'
  const change = (v: unknown) => onChange(v as never)
  return (
    <div className="kf-dist">
      <select
        id={idSchema.$id} aria-label="Kiểu giá trị" disabled={off} value={kind}
        onChange={(e) => {
          const next = e.target.value
          change(next === 'empty' ? undefined : setKind(formData ?? inherited, next as Kind))
        }}
      >
        {(!required || kind === 'empty') && <option value="empty">{emptyLabel}</option>}
        {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        {kind === 'unknown' && <option value="unknown">Kiểu khác (chỉ sửa được trong JSON)</option>}
      </select>
      {kind === 'empty' && inheritedText && !ctx.emptyLabel && <p className="field-description">Mặc định: {inheritedText}</p>}
      {kind !== 'empty' && kind !== 'unknown' && (
        <div className="kf-dist-params">
          {paramsOf(kind).map((p) => {
            const cur = typeof formData === 'number' ? formData : readParam(formData, p.key)
            return (
              <label key={p.key}>
                {p.unitless ? p.label : `${p.label} (${unit})`}
                <input
                  type="number" step="any" disabled={off} value={cur ?? ''}
                  onChange={(e) => {
                    const n = e.target.value === '' ? undefined : Number(e.target.value)
                    change(setParam(formData, p.key, n !== undefined && Number.isFinite(n) ? n : undefined))
                  }}
                />
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

const DefaultOneOf = getDefaultRegistry().fields.OneOfField

/** Thay OneOfField của rjsf: ô phân phối dùng DistField, mọi oneOf khác giữ nguyên. */
function OneOfField(props: FieldProps) {
  return isDistSchema(props.schema) ? <DistField {...props} /> : <DefaultOneOf {...props} />
}

export const distFields = { OneOfField }
