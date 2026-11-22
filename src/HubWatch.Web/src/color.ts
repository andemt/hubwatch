import type { LightColor } from './types'

const gamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)
const clamp = (v: number) => Math.min(1, Math.max(0, v))
const toHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0')).join('')

/** CIE 1931 xy (as used by Hue) to sRGB, at full brightness. */
export function xyToHex(x: number, y: number): string {
  if (y <= 0) return '#ffffff'
  const Y = 1
  const X = (Y / y) * x
  const Z = (Y / y) * (1 - x - y)
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153
  const max = Math.max(r, g, b)
  if (max > 1) {
    r /= max
    g /= max
    b /= max
  }
  return toHex(gamma(Math.max(0, r)), gamma(Math.max(0, g)), gamma(Math.max(0, b)))
}

/** Color temperature in mirek (1,000,000 / kelvin) to an approximate sRGB white. */
export function mirekToHex(mirek: number): string {
  const k = 1_000_000 / mirek / 100
  let r: number, g: number, b: number
  if (k <= 66) {
    r = 255
    g = 99.4708025861 * Math.log(k) - 161.1195681661
    b = k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307
  } else {
    r = 329.698727446 * Math.pow(k - 60, -0.1332047592)
    g = 288.1221695283 * Math.pow(k - 60, -0.0755148492)
    b = 255
  }
  return toHex(r / 255, g / 255, b / 255)
}

export function hueColorToHex(c: LightColor | null): string | null {
  if (!c) return null
  if (c.mirek !== null) return mirekToHex(c.mirek)
  if (c.x !== null && c.y !== null) return xyToHex(c.x, c.y)
  return null
}

/** Darkens a color to suggest its brightness (never fully black, so hues stay recognisable). */
function withBrightness(hex: string, brightness: number | null) {
  if (brightness === null || brightness >= 99) return hex
  const keep = Math.round(35 + 0.65 * Math.max(0, brightness))
  return `color-mix(in srgb, ${hex} ${keep}%, black)`
}

/** CSS background for a scene tile: a gradient through its palette. */
export function paletteBackground(palette: LightColor[]): string {
  const colors = palette
    .map((c) => {
      const hex = hueColorToHex(c)
      return hex ? withBrightness(hex, c.brightness) : null
    })
    .filter((c): c is string => c !== null)
  if (colors.length === 0) return 'var(--surface-2)'
  if (colors.length === 1) return `linear-gradient(135deg, ${colors[0]}, color-mix(in srgb, ${colors[0]} 70%, black))`
  return `linear-gradient(135deg, ${colors.join(', ')})`
}
