import { useCallback, useState } from 'react'
import { Climate } from './Climate'
import { Statistics } from './Statistics'
import { formatHours } from '../format'
import type { Stats, DeviceRef } from '../types'
import { useSystemName } from '../systems'

const RANGES = [
  { label: '24 h', hours: 24 },
  { label: '7 days', hours: 24 * 7 },
  { label: '30 days', hours: 24 * 30 },
  { label: '90 days', hours: 24 * 90 },
]

/** History in one place: sensor charts and statistics, sharing one time range. */
export function Insights({ onOpenDevice }: { onOpenDevice: (device: DeviceRef) => void }) {
  const [hours, setHours] = useState(24 * 7)
  const [coverage, setCoverage] = useState<{ systems: Stats['coverage']; periodMs: number } | null>(null)
  const onCoverage = useCallback(
    (systems: Stats['coverage'], periodMs: number) => setCoverage({ systems, periodMs }),
    [],
  )
  const systemName = useSystemName()

  const percentOf = (recordedMs: number) =>
    coverage && coverage.periodMs > 0 ? Math.round((recordedMs / coverage.periodMs) * 100) : 0
  // The least recorded system decides whether to warn.
  const percent =
    coverage && coverage.systems.length > 0 ? Math.min(...coverage.systems.map((c) => percentOf(c.recordedMs))) : null

  return (
    <div className="page">
      <div className="toolbar">
        <div className="chips" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.hours} className={hours === r.hours ? 'chip active' : 'chip'} onClick={() => setHours(r.hours)}>
              {r.label}
            </button>
          ))}
        </div>
        {coverage && coverage.systems.length > 0 && (
          <span className="muted small" title="Only time when HubWatch was running is included.">
            Recorded{' '}
            {coverage.systems
              .map((c) => {
                const name = systemName(c.systemId)
                return `${name ? `${name}: ` : ''}${formatHours(c.recordedMs)} (${percentOf(c.recordedMs)}%)`
              })
              .join(' · ')}{' '}
            of this period · striped areas were not recorded
          </span>
        )}
      </div>

      {percent !== null && percent < 50 && (
        <p className="notice">
          HubWatch only knows what happened while it was running, so this covers {percent}% of the period. It becomes
          more complete the longer the app runs.
        </p>
      )}

      <Climate onOpenDevice={onOpenDevice} hours={hours} />
      <Statistics onOpenDevice={onOpenDevice} days={Math.max(1, Math.round(hours / 24))} onCoverage={onCoverage} />
    </div>
  )
}
