import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Reading, ReadingKind } from '../types'
import type { Gap } from '../sessions'
import { LineChart } from './LineChart'

const KIND = {
  temperature: { unit: '°C', decimals: 1, color: 'var(--sensor)', label: 'temperature' },
  lux: { unit: 'lx', decimals: 0, color: 'var(--light)', label: 'light level' },
  battery: { unit: '%', decimals: 0, color: 'var(--health)', label: 'battery' },
} as const

interface Props {
  resource: string
  kind: ReadingKind
  hours: number
  gaps: Gap[]
  /** Change this to reload (e.g. a timer tick). */
  refreshKey?: number
  name: string
  height?: number
}

/** Loads readings for one sensor and draws them. */
export function SensorChart({ resource, kind, hours, gaps, refreshKey, name, height }: Props) {
  const [points, setPoints] = useState<Reading[] | null>(null)
  const meta = KIND[kind]

  useEffect(() => {
    let cancelled = false
    api.readings(resource, kind, hours).then((r) => {
      if (!cancelled) setPoints(r)
    })
    return () => {
      cancelled = true
    }
  }, [resource, kind, hours, refreshKey])

  if (!points) return <div className="chart-empty" style={{ height: height ?? 170 }} />

  const to = Date.now()
  return (
    <LineChart
      points={points}
      gaps={gaps}
      from={to - hours * 3_600_000}
      to={to}
      rangeHours={hours}
      color={meta.color}
      unit={meta.unit}
      decimals={meta.decimals}
      step={hours <= 48}
      label={`${name} ${meta.label}`}
      height={height}
      yDomain={kind === 'battery' ? [0, 100] : undefined}
    />
  )
}
