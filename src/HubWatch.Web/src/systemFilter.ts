/**
 * Which systems the UI shows. Only affects what is displayed: every system keeps recording.
 * The choice is stored per browser as the systems to hide, so a newly added system is shown.
 */

const KEY = 'hubwatch.hiddenSystems'

export function loadHiddenSystems(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function saveHiddenSystems(ids: string[]) {
  try {
    if (ids.length === 0) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify(ids))
  } catch {
    // storage unavailable: the choice just isn't remembered
  }
}

// The systems currently shown, for API requests and the live stream. null = all.
let visible: string[] | null = null

export function setVisibleSystems(ids: string[] | null) {
  visible = ids
}

/** Value for the API's ?systems= parameter (undefined = all systems). */
export function systemsParam(): string | undefined {
  return visible ? visible.join(',') : undefined
}

export function isSystemVisible(systemId: string) {
  return visible === null || visible.includes(systemId)
}
