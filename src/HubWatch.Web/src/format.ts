export type Category = 'light' | 'motion' | 'button' | 'sensor' | 'health' | 'other'

export const CATEGORIES: Record<Category, { label: string }> = {
  light: { label: 'Lights' },
  motion: { label: 'Motion' },
  button: { label: 'Switches' },
  sensor: { label: 'Sensors' },
  health: { label: 'Health' },
  other: { label: 'Other' },
}

/** Aggregates for a room, zone or the whole home (grouped_light, grouped_motion, ...). */
export const isGroup = (resourceType: string) => resourceType.startsWith('grouped_')

export function categoryOf(resourceType: string): Category {
  switch (resourceType) {
    case 'light':
    case 'grouped_light':
      return 'light'
    case 'motion':
    case 'grouped_motion':
    case 'camera_motion':
    case 'convenience_area_motion':
    case 'security_area_motion':
      return 'motion'
    case 'button':
    case 'relative_rotary':
      return 'button'
    case 'temperature':
    case 'grouped_temperature':
    case 'light_level':
    case 'grouped_light_level':
    case 'contact':
    case 'tamper':
      return 'sensor'
    case 'device_power':
    case 'zigbee_connectivity':
      return 'health'
    default:
      return 'other'
  }
}

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const shortTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const day = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export const formatTime = (ts: number) => time.format(ts)
export const formatShortTime = (ts: number) => shortTime.format(ts)
export const formatDateTime = (ts: number) => dateTime.format(ts)

export function formatDay(ts: number) {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86_400_000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return day.format(d)
}

export function formatDuration(ms: number) {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ${minutes % 60} min`
  return `${Math.floor(hours / 24)} days`
}

/** Axis label: clock time for short ranges, date for long ones. */
export function formatAxisTime(ts: number, rangeHours: number) {
  if (rangeHours <= 36) return shortTime.format(ts)
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(ts)
}

/** Duration as "4 h 12 min" / "35 min" / "0 min". */
export function formatHours(ms: number) {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  return minutes % 60 ? `${h} h ${minutes % 60} min` : `${h} h`
}

export function formatAgo(ts: number) {
  const seconds = Math.round((Date.now() - ts) / 1000)
  if (seconds < 60) return 'just now'
  return `${formatDuration(seconds * 1000)} ago`
}
