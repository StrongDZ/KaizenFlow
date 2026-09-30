import { ICON_CHOICES } from '../../lib/iconChoices'
import { NodeIcon, hasIcon } from '../nodeIcons'

/**
 * Chọn biểu tượng cho loại node: hiện trên thẻ node, danh sách loại node và panel thuộc tính.
 * Ô đầu tiên là "theo vai trò" (không đặt riêng): node lấy biểu tượng chung của nguồn, kho, trạm, đích hay đội xe.
 */
export function IconPicker({ value, archetype, onChange, disabled }: {
  value: string | undefined; archetype: string; onChange: (icon: string | undefined) => void; disabled?: boolean
}) {
  const known = value ? ICON_CHOICES.find((c) => c.name === value) : undefined
  const tile = (active: boolean) =>
    `flex h-8 w-8 items-center justify-center rounded-lg border ${active ? 'border-line-2 bg-raised text-text' : 'border-transparent text-muted hover:bg-panel-2 hover:text-text'} disabled:pointer-events-none disabled:opacity-50`
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs text-muted">Biểu tượng</legend>
      <div role="group" aria-label="Chọn biểu tượng" className="flex flex-wrap gap-1">
        <button
          type="button" disabled={disabled} aria-pressed={!value} title="Theo vai trò: dùng biểu tượng chung của loại này"
          onClick={() => onChange(undefined)} className={`${tile(!value)} border-dashed`}
        >
          <NodeIcon archetype={archetype} size={16} />
        </button>
        {ICON_CHOICES.map((c) => (
          <button
            key={c.name} type="button" disabled={disabled} aria-pressed={value === c.name} title={c.label} aria-label={c.label}
            onClick={() => onChange(c.name)} className={tile(value === c.name)}
          >
            <NodeIcon name={c.name} size={16} />
          </button>
        ))}
      </div>
      <p className="text-[11px] text-faint">
        {!value ? 'Đang dùng biểu tượng theo vai trò.' : known ? `Đang chọn: ${known.label}.` : hasIcon(value) ? `Đang chọn: ${value}.` : `Biểu tượng "${value}" không có trong danh sách nên node hiện biểu tượng theo vai trò.`}
        {' '}Hiện trên thẻ node và danh sách loại node.
      </p>
    </fieldset>
  )
}
