import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Stats, DeviceRef } from '../types'
import { formatHours } from '../format'
import { useLiveRefresh } from '../useThrottledRefresh'
import { useSystemName } from '../systems'
import { Collapsible } from './Collapsible'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

interface Props {
  onOpenDevice: (device: DeviceRef) => void
  days: number
  /** Reports how much of the period each system was actually recorded. */
  onCoverage?: (coverage: Stats['coverage'], periodMs: number) => void
}

/** Light usage, motion and activity statistics. Part of the Insights page, which owns the period. */
export function Statistics({ onOpenDevice, days, onCoverage }: Props) {
  const [stats, setStats] = useState<Stats | null>(null)
  const systemName = useSystemName()
  // Statistics change slowly: refresh at most every 30 s while events arrive.
  const tick = useLiveRefresh(undefined, 30_000)

  useEffect(() => {
    api
      .stats(days)
      .then((s) => {
        setStats(s)
        onCoverage?.(s.coverage, s.to - s.from)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, tick])

  if (!stats) return <p className="muted center-text">Loading…</p>

  const maxOn = Math.max(1, ...stats.lights.map((l) => l.onMs))
  const maxActive = Math.max(1, ...stats.mostActive.map((a) => a.count))

  return (
    <>
      <Collapsible id="insights.lights" title="Lights · time on">
        {stats.lights.length === 0 ? (
          <p className="muted">No lights.</p>
        ) : (
          <div className="card stat-list">
            {stats.lights.map((l) => (
              <div key={`${l.systemId}-${l.id}`} className="stat-row">
                <div className="stat-name">
                  <button className="link" onClick={() => l.deviceId && onOpenDevice({ systemId: l.systemId, id: l.deviceId })}>
                    {l.name}
                  </button>
                  {(l.room !== l.name || systemName(l.systemId)) && (
                    <span className="muted small">
                      {[l.room !== l.name ? l.room : null, systemName(l.systemId)].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </div>
                <div className="bar-track" aria-hidden>
                  <div className="bar-fill light" style={{ width: `${(l.onMs / maxOn) * 100}%` }} />
                </div>
                <div className="stat-value-text">
                  <strong>{formatHours(l.onMs)}</strong>
                  <span className="muted small">switched on {l.switchOns}×</span>
                </div>
                <DayColumns values={l.perDayMs} days={stats.days} />
              </div>
            ))}
          </div>
        )}
      </Collapsible>

      <Collapsible id="insights.motion" title="Motion · when is there activity?">
        {stats.motionTotal === 0 ? (
          <p className="muted">No motion recorded in this period.</p>
        ) : (
          <div className="card">
            <Heatmap grid={stats.motionByWeekdayHour} />
            <div className="heatmap-footer">
              <span className="muted small">
                {stats.motionTotal} detections
                {stats.motionSensors.length > 1 &&
                  ` · ${stats.motionSensors
                    .map((s) => `${s.name}${systemName(s.systemId) ? ` (${systemName(s.systemId)})` : ''} ${s.count}`)
                    .join(', ')}`}
              </span>
              <span className="heatmap-legend muted small">
                Fewer
                {[0.15, 0.4, 0.65, 0.9].map((v) => (
                  <span key={v} className="heat-cell" style={{ background: heat(v) }} />
                ))}
                More
              </span>
            </div>
          </div>
        )}
      </Collapsible>

      <Collapsible id="insights.mostActive" title="Most active">
        {stats.mostActive.length === 0 ? (
          <p className="muted">No events in this period.</p>
        ) : (
          <div className="card stat-list">
            {stats.mostActive.map((a) => (
              <div key={`${a.systemId}-${a.resourceId}`} className="stat-row compact">
                <div className="stat-name">
                  <button className="link" disabled={!a.deviceId} onClick={() => a.deviceId && onOpenDevice({ systemId: a.systemId, id: a.deviceId })}>
                    {a.name}
                  </button>
                  <span className="muted small">
                    {[a.room !== a.name ? a.room : null, a.resourceType.replace(/_/g, ' '), systemName(a.systemId)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                <div className="bar-track" aria-hidden>
                  <div className="bar-fill" style={{ width: `${(a.count / maxActive) * 100}%` }} />
                </div>
                <div className="stat-value-text">
                  <strong>{a.count}</strong>
                  <span className="muted small">events</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Collapsible>
    </>
  )
}

/** Sequential scale: one hue, light to dark. */
function heat(t: number) {
  return t <= 0 ? 'var(--surface-2)' : `color-mix(in srgb, var(--motion) ${Math.round(15 + t * 85)}%, var(--surface-2))`
}

function Heatmap({ grid }: { grid: number[][] }) {
  const max = Math.max(1, ...grid.flat())
  return (
    <div className="heatmap" role="table" aria-label="Motion detections by weekday and hour">
      <div className="heatmap-row" role="row">
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="heatmap-hour muted" role="columnheader">
            {h % 3 === 0 ? String(h).padStart(2, '0') : ''}
          </span>
        ))}
      </div>
      {grid.map((hours, d) => (
        <div key={d} className="heatmap-row" role="row">
          <span className="heatmap-day muted" role="rowheader">
            {WEEKDAYS[d]}
          </span>
          {hours.map((count, h) => (
            <span
              key={h}
              role="cell"
              className="heat-cell"
              style={{ background: heat(count / max) }}
              title={`${WEEKDAYS[d]} ${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00 · ${count} detection${count === 1 ? '' : 's'}`}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function DayColumns({ values, days }: { values: number[]; days: string[] }) {
  const max = Math.max(1, ...values)
  return (
    <div className="day-columns" aria-label="Time on per day">
      {values.map((v, i) => (
        <span
          key={days[i]}
          className="day-column"
          title={`${dayLabel.format(new Date(days[i] + 'T12:00:00'))}: ${formatHours(v)}`}
        >
          <span style={{ height: `${v > 0 ? Math.max(8, (v / max) * 100) : 0}%` }} />
        </span>
      ))}
    </div>
  )
}
