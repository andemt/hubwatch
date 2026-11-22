import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Reading } from '../types'
import type { Gap } from '../sessions'
import { formatAxisTime, formatDateTime } from '../format'

interface Props {
  points: Reading[]
  gaps: Gap[]
  from: number
  to: number
  rangeHours: number
  /** CSS color, e.g. 'var(--sensor)' */
  color: string
  unit: string
  decimals?: number
  /**
   * Hue sensors report on change, so a value holds until the next report:
   * draw steps. Averaged (bucketed) data is drawn as a plain line.
   */
  step?: boolean
  /** Accessible name, e.g. "Hallway temperature" */
  label: string
  height?: number
  /** Fixed y-range, e.g. [0, 100] for battery. Defaults to the data's range. */
  yDomain?: [number, number]
}

const M = { top: 10, right: 12, bottom: 22, left: 40 }
const HOUR = 3_600_000
const DAY = 24 * HOUR
const TICK_INTERVALS = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 5 * DAY, 7 * DAY, 14 * DAY]

function niceStep(span: number, count: number) {
  const raw = span / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10
  return nice * magnitude
}

function timeTicks(from: number, to: number, maxTicks: number) {
  const interval = TICK_INTERVALS.find((i) => (to - from) / i <= maxTicks) ?? TICK_INTERVALS[TICK_INTERVALS.length - 1]
  const d = new Date(from)
  if (interval < DAY) {
    d.setMinutes(0, 0, 0)
    const hours = interval / HOUR
    while (d.getTime() < from || d.getHours() % hours !== 0) d.setHours(d.getHours() + 1)
  } else {
    d.setHours(0, 0, 0, 0)
    if (d.getTime() < from) d.setDate(d.getDate() + 1)
  }
  const ticks: number[] = []
  const stepDays = interval / DAY
  while (d.getTime() <= to) {
    ticks.push(d.getTime())
    if (interval < DAY) d.setHours(d.getHours() + interval / HOUR)
    else d.setDate(d.getDate() + stepDays) // calendar days, safe across DST
  }
  return ticks
}

/** Lightweight dependency-free time-series chart with a hover crosshair. */
export function LineChart({ points, gaps, from, to, rangeHours, color, unit, decimals = 1, step = true, label, height = 170, yDomain }: Props) {
  // Each chart needs its own pattern id: a pattern inside a hidden tab does not render elsewhere.
  const hatchId = `gap-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const wrapper = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  const [hoverX, setHoverX] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapper.current
    if (!el) return
    // A chart in a hidden tab or a collapsed section measures 0 wide. Keep the last real width then (instead of
    // dropping to the minimum), and measure again when it becomes visible: the resize observer alone does not
    // always report that change.
    const measure = () => {
      const w = el.clientWidth
      if (w > 0) setWidth(Math.max(200, w))
    }
    measure()
    const resize = new ResizeObserver(measure)
    const visible = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) measure()
    })
    resize.observe(el)
    visible.observe(el)
    return () => {
      resize.disconnect()
      visible.disconnect()
    }
  }, [])

  const now = Date.now()
  const end = Math.min(to, now)
  const innerW = width - M.left - M.right
  const innerH = height - M.top - M.bottom

  const chart = useMemo(() => {
    const sorted = [...points].sort((a, b) => a.ts - b.ts)
    const values = sorted.map((p) => p.value)
    let min = yDomain?.[0] ?? (values.length ? Math.min(...values) : 0)
    let max = yDomain?.[1] ?? (values.length ? Math.max(...values) : 1)
    if (max - min < 1e-9) {
      min -= 1
      max += 1
    }
    const yStep = niceStep(max - min, 4)
    const yMin = Math.floor(min / yStep) * yStep
    const yMax = Math.ceil(max / yStep) * yStep
    const yTicks: number[] = []
    for (let v = yMin; v <= yMax + yStep / 2; v += yStep) yTicks.push(v)

    const x = (ts: number) => M.left + ((ts - from) / (to - from)) * innerW
    const y = (v: number) => M.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH

    const hasGapBetween = (a: number, b: number) => gaps.some((g) => g.start < b && g.end > a)

    // Split into segments at recording gaps.
    const segments: Reading[][] = []
    for (const p of sorted) {
      const current = segments[segments.length - 1]
      if (!current || hasGapBetween(current[current.length - 1].ts, p.ts)) segments.push([p])
      else current.push(p)
    }

    const paths = segments.map((seg, i) => {
      let d = ''
      seg.forEach((p, j) => {
        if (j === 0) d += `M${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`
        else if (step) d += `H${x(p.ts).toFixed(1)}V${y(p.value).toFixed(1)}`
        else d += `L${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`
      })
      // The newest value is still valid until now (unless a gap follows it).
      const last = seg[seg.length - 1]
      if (step && i === segments.length - 1 && !hasGapBetween(last.ts, end)) d += `H${x(end).toFixed(1)}`
      return d
    })

    return { sorted, yTicks, x, y, paths, hasGapBetween }
  }, [points, gaps, from, to, innerW, innerH, step, end, yDomain])

  const xTicks = useMemo(() => timeTicks(from, to, Math.max(2, Math.floor(innerW / 90))), [from, to, innerW])

  // ----- hover -----
  const hover = useMemo(() => {
    if (hoverX === null || chart.sorted.length === 0) return null
    const ts = from + ((hoverX - M.left) / innerW) * (to - from)
    if (ts < from || ts > end) return null
    const inGap = gaps.find((g) => ts >= g.start && ts <= g.end)
    if (inGap) return { ts, gap: inGap, point: null }

    // binary search: last point at or before ts
    const pts = chart.sorted
    let lo = 0
    let hi = pts.length - 1
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (pts[mid].ts <= ts) lo = mid
      else hi = mid - 1
    }
    let point = pts[lo].ts <= ts ? pts[lo] : null
    if (!step) {
      const next = pts[lo + 1]
      if (!point || (next && Math.abs(next.ts - ts) < Math.abs(point.ts - ts))) point = next ?? point
    }
    if (point && step && chart.hasGapBetween(point.ts, ts)) point = null
    return { ts: step ? ts : (point?.ts ?? ts), gap: null, point }
  }, [hoverX, chart, from, to, end, innerW, gaps, step])

  const fmt = (v: number) => `${v.toFixed(decimals)} ${unit}`
  const latest = chart.sorted[chart.sorted.length - 1]
  const summary = latest
    ? `${label}: latest ${fmt(latest.value)}, range ${fmt(Math.min(...chart.sorted.map((p) => p.value)))} to ${fmt(
        Math.max(...chart.sorted.map((p) => p.value)),
      )}`
    : `${label}: no data`

  return (
    <div className="chart" ref={wrapper}>
      {points.length === 0 ? (
        <div className="chart-empty" style={{ height }}>
          No readings in this period
        </div>
      ) : (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={summary}
          onMouseMove={(e) => setHoverX(e.clientX - e.currentTarget.getBoundingClientRect().left)}
          onMouseLeave={() => setHoverX(null)}
        >
          <defs>
            <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" className="gap-hatch-line" />
            </pattern>
          </defs>

          {gaps
            .filter((g) => g.end > from && g.start < to)
            .map((g) => (
              <rect
                key={g.start}
                x={chart.x(Math.max(g.start, from))}
                y={M.top}
                width={Math.max(1, chart.x(Math.min(g.end, to)) - chart.x(Math.max(g.start, from)))}
                height={innerH}
                fill={`url(#${hatchId})`}
              />
            ))}

          {chart.yTicks.map((v) => (
            <g key={v}>
              <line className="grid" x1={M.left} x2={width - M.right} y1={chart.y(v)} y2={chart.y(v)} />
              <text className="axis" x={M.left - 6} y={chart.y(v)} textAnchor="end" dominantBaseline="middle">
                {Number(v.toFixed(2))}
              </text>
            </g>
          ))}

          {xTicks.map((t) => (
            <text key={t} className="axis" x={chart.x(t)} y={height - 6} textAnchor="middle">
              {formatAxisTime(t, rangeHours)}
            </text>
          ))}

          {chart.paths.map((d, i) => (
            <path key={i} d={d} fill="none" style={{ stroke: color }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}

          {hover && (
            <g pointerEvents="none">
              <line className="crosshair" x1={chart.x(hover.ts)} x2={chart.x(hover.ts)} y1={M.top} y2={M.top + innerH} />
              {hover.point && (
                <circle
                  cx={step ? chart.x(hover.ts) : chart.x(hover.point.ts)}
                  cy={chart.y(hover.point.value)}
                  r={4.5}
                  style={{ fill: color }}
                  className="hover-dot"
                />
              )}
            </g>
          )}
        </svg>
      )}

      {hover && (
        <div
          className="tooltip"
          style={{
            left: chart.x(hover.ts),
            transform: chart.x(hover.ts) > width - 160 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
          }}
        >
          {hover.point ? <strong>{fmt(hover.point.value)}</strong> : <strong>Not recording</strong>}
          <span>{formatDateTime(hover.point && !step ? hover.point.ts : hover.ts)}</span>
        </div>
      )}
    </div>
  )
}
