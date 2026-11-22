export type Theme = 'system' | 'light' | 'dark'

const KEY = 'hubwatch.theme'

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}

/** Applies and remembers the theme. "system" follows the operating system's light/dark setting. */
export function setTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
  try {
    if (theme === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, theme)
  } catch {
    /* storage unavailable: the choice lasts until the page is reloaded */
  }
}
