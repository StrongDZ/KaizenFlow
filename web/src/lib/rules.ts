import type { MaterialUsage, RunStatus, VersionUse } from '../api/types'

export type Rules = { canEdit: boolean; canDelete: boolean; banner: string | null }

/**
 * Loại node nào cũng như nhau, kể cả các loại mẫu nạp sẵn lúc đầu: sửa tự do khi chưa có version đã khoá (không phải nháp) dùng,
 * xoá khi không version nào dùng. Lý do khoá: lúc chạy, thông số mặc định của loại được nạp trực tiếp từ DB, nên sửa loại đang
 * được version đã Publish dùng sẽ làm kết quả cũ của mô hình đó không còn khớp.
 */
export function nodeTypeRules(versions: VersionUse[]): Rules {
  const frozen = versions.filter((v) => v.status !== 'DRAFT')
  if (frozen.length > 0) {
    const names = frozen.slice(0, 3).map((v) => `${v.model_key} v${v.version}`).join(', ')
    return {
      canEdit: false,
      canDelete: false,
      banner: `Đang dùng trong ${frozen.length} phiên bản đã Publish (${names}${frozen.length > 3 ? ', …' : ''}), nên không sửa hay xoá trực tiếp được. Nhân bản để sửa mà không làm đổi kết quả các lần chạy cũ.`,
    }
  }
  if (versions.length > 0) {
    return { canEdit: true, canDelete: false, banner: `Đang dùng trong ${versions.length} phiên bản nháp nên chưa xoá được.` }
  }
  return { canEdit: true, canDelete: true, banner: null }
}

/** Tên sửa tự do; mã luôn bất biến; đơn vị và việc xoá bị khoá khi có bất kỳ tham chiếu nào. */
export function materialRules(u: MaterialUsage): Rules & { canEditUnit: boolean } {
  const total = u.edges.length + u.nodes.length + u.node_types.length
  if (total === 0) return { canEdit: true, canDelete: true, canEditUnit: true, banner: null }
  return {
    canEdit: true,
    canDelete: false,
    canEditUnit: false,
    banner: `Đang dùng ở ${u.edges.length} đường nối, ${u.nodes.length} node và ${u.node_types.length} loại node: vẫn sửa được tên, nhưng không đổi được đơn vị và không xoá được. Mã luôn không đổi.`,
  }
}

export const isValidNodeTypeCode = (s: string): boolean => /^[A-Z][A-Z0-9_]*$/.test(s)
export const isValidMaterialCode = (s: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s)
/** Tên mô hình nằm trong đường dẫn (`/models/<tên>/versions`), nên không được có khoảng trắng hay dấu gạch chéo. */
export const isValidModelKey = (s: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s)

/** Scenario đã có run thì khoá sửa (đổi thông số sẽ làm kết quả cũ không còn khớp); xoá và nhân bản luôn được. */
export function scenarioRules(runs: number): Rules {
  if (runs === 0) return { canEdit: true, canDelete: true, banner: null }
  return { canEdit: false, canDelete: true, banner: `Scenario đã có ${runs} lần chạy nên không sửa được. Nhân bản để thử thông số khác.` }
}

/** Chỉ xoá được lần chạy đã kết thúc. */
export function runRules(status: RunStatus): { canDelete: boolean } {
  return { canDelete: status === 'DONE' || status === 'FAILED' }
}
