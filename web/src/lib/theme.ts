export type Theme = 'dark' | 'light'
export const THEME_KEY = 'kf-theme'

/** Giá trị lạ hay thiếu thì về tối, như spec. */
export function parseTheme(raw: string | null | undefined): Theme {
  return raw === 'light' ? 'light' : 'dark'
}

export function otherTheme(t: Theme): Theme {
  return t === 'dark' ? 'light' : 'dark'
}

type Reader = { getItem(key: string): string | null }

/** localStorage có thể thiếu hoặc ném lỗi (cửa sổ ẩn danh, chặn dữ liệu trang): khi đó dùng mặc định. */
export function readStored(store: Reader | undefined): Theme {
  try {
    return parseTheme(store?.getItem(THEME_KEY))
  } catch {
    return 'dark'
  }
}
