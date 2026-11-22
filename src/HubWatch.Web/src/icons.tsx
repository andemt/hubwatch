import {
  BatteryMedium,
  Check,
  CircleDot,
  Ellipsis,
  Footprints,
  Lightbulb,
  Minus,
  Thermometer,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { Category } from './format'

/**
 * Icon choices that carry meaning live here, so the app keeps one consistent set.
 * Icons come from Lucide (ISC). Size, stroke and colour are set in styles.css (.lucide),
 * so icons scale with the surrounding text and take their colour from currentColor.
 */

export const CATEGORY_ICONS: Record<Category, LucideIcon> = {
  light: Lightbulb,
  motion: Footprints,
  button: CircleDot,
  sensor: Thermometer,
  health: BatteryMedium,
  other: Ellipsis,
}

/** Icon for an event category, tinted with the category colour. Decorative: the label carries the meaning. */
export function CategoryIcon({ category }: { category: Category }) {
  const Icon = CATEGORY_ICONS[category]
  return <Icon aria-hidden className={`cat-icon cat-icon-${category}`} />
}

export type Level = 'ok' | 'warn' | 'bad' | 'none'

const LEVEL_ICONS: Record<Level, LucideIcon> = {
  ok: Check,
  warn: TriangleAlert,
  bad: X,
  none: Minus,
}

/** Status icon next to a text label (the colour comes from the surrounding .status-* class). */
export function LevelIcon({ level }: { level: Level }) {
  const Icon = LEVEL_ICONS[level]
  return <Icon aria-hidden />
}
