import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useStream } from '../stream'
import type { Device, DeviceRef, SystemEvent, ReadingKind, Session } from '../types'
import { gapsFrom } from '../sessions'
import { categoryOf, formatAgo, formatDay, formatTime } from '../format'
import { updateLabel, useStaleHint, zigbeeLabel } from '../health'
import { SensorChart } from './SensorChart'
import { RangePicker } from './RangePicker'
import { PowerSwitch } from './PowerSwitch'
import { BatteryBar } from './Health'
import { useSystemName } from '../systems'
import { TriangleAlert, X } from 'lucide-react'
import { CategoryIcon, LevelIcon } from '../icons'

const PAGE_SIZE = 100

export function DeviceDrawer({ device: ref, onClose }: { device: DeviceRef; onClose: () => void }) {
  const { systemId: refSystem, id: deviceId } = ref
  const [device, setDevice] = useState<Device | null>(null)
  const systemName = useSystemName()
  const [events, setEvents] = useState<SystemEvent[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [hours, setHours] = useState(24 * 7)
  const [sessions, setSessions] = useState<{ from: number; list: Session[] }>({ from: Date.now(), list: [] })
  const [tick, setTick] = useState(0)
  const throttle = useRef<number | undefined>(undefined)

  useEffect(() => {
    api.devices().then((list) => setDevice(list.find((d) => d.systemId === refSystem && d.id === deviceId) ?? null))
    // Only this device's own system: the same id can exist in another system.
    api.events({ device: deviceId, systems: refSystem, limit: PAGE_SIZE }).then((list) => {
      setEvents((prev) => {
        // keep already loaded older pages when refreshing
        if (!prev) return list
        const ids = new Set(list.map((e) => e.id))
        return [...list, ...prev.filter((e) => !ids.has(e.id) && e.ts < (list[list.length - 1]?.ts ?? 0))]
      })
      setHasMore((more) => more || list.length === PAGE_SIZE)
    })
  }, [refSystem, deviceId, tick])

  useEffect(() => {
    setEvents(null)
    setHasMore(false)
  }, [deviceId])

  useEffect(() => {
    const from = Date.now() - hours * 3_600_000
    api.sessions(from).then((list) => setSessions({ from, list }))
  }, [hours, tick])

  // Native modal: traps focus, closes on Escape and returns focus to the opener when closed.
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
  }, [])
  const close = () => dialog.current?.close()

  const refreshSoon = () => {
    if (throttle.current !== undefined) return
    throttle.current = window.setTimeout(() => {
      throttle.current = undefined
      setTick((t) => t + 1)
    }, 2000)
  }
  useStream('events', refreshSoon)
  useStream('snapshot', refreshSoon)

  // Only the device's own system decides when it was recorded.
  const systemId = device?.systemId
  const gaps = useMemo(
    () =>
      systemId
        ? gapsFrom(
            sessions.list.filter((s) => s.systemId === systemId),
            sessions.from,
            undefined,
            [systemId],
          )
        : [],
    [sessions, systemId],
  )

  async function loadOlder() {
    const last = events?.[events.length - 1]
    if (!last) return
    const older = await api.events({ device: deviceId, systems: refSystem, beforeTs: last.ts, beforeId: last.id, limit: PAGE_SIZE })
    setEvents((prev) => [...(prev ?? []), ...older])
    setHasMore(older.length === PAGE_SIZE)
  }

  const charts: { kind: ReadingKind; resource: string; title: string }[] = device
    ? [
        device.services.temperature && { kind: 'temperature' as const, resource: device.services.temperature, title: 'Temperature' },
        device.services.lightLevel && { kind: 'lux' as const, resource: device.services.lightLevel, title: 'Light level' },
        device.services.power && { kind: 'battery' as const, resource: device.services.power, title: 'Battery' },
      ].filter((c): c is { kind: ReadingKind; resource: string; title: string } => Boolean(c))
    : []

  const z = zigbeeLabel(device?.connectivity ?? null)
  const staleHint = useStaleHint()(ref.systemId, device?.connectivity ?? null)
  const stale = staleHint !== null
  const update = device?.softwareUpdate ? updateLabel(device.softwareUpdate) : null
  let lastDay = ''

  return (
    <dialog
      ref={dialog}
      className="drawer"
      aria-label={device?.name ?? 'Device'}
      onClose={onClose}
      // The inner wrapper fills the dialog, so a click that lands on the dialog itself is a backdrop click.
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <div className="drawer-body">
        <header className="drawer-head">
          <div>
            <h2>{device?.name ?? '…'}</h2>
            <div className="muted small">
              {[device?.room, device?.product, device && systemName(device.systemId)].filter(Boolean).join(' · ')}
            </div>
          </div>
          <button className="close" onClick={close} aria-label="Close">
            <X aria-hidden />
          </button>
        </header>

        {device && stale && (
          <div className={`drawer-alert drawer-alert-${z.level}`} role="status">
            <TriangleAlert aria-hidden />
            <div>
              <strong>
                Zigbee: {z.text.toLowerCase()}
              </strong>
              <p>
                {systemName(device.systemId) ?? 'The bridge'} can't reliably reach this device, so the state below is the
                last one it heard and switching it may not work. Check that it has power and isn't too far from other
                mains-powered devices.
              </p>
            </div>
          </div>
        )}

        {device && (
          <dl className="facts">
            {device.on !== null && (
              <>
                <dt>State</dt>
                <dd>
                  <span className="power">
                    <PowerSwitch
                      on={device.on}
                      targets={[{ systemId: device.systemId, id: device.id }]}
                      label={`Switch ${device.name}`}
                    />
                    <span className={stale ? 'stale-value' : undefined} title={staleHint ?? undefined}>
                      {device.on ? `On${device.brightness !== null ? ` · ${Math.round(device.brightness)}%` : ''}` : 'Off'}
                      {stale && <span className="muted"> (last known)</span>}
                    </span>
                  </span>
                </dd>
              </>
            )}
            {device.motion !== null && (
              <>
                <dt>Motion</dt>
                <dd>
                  {device.motion ? 'Motion' : 'No motion'}
                  {device.motionChangedAt ? ` · changed ${formatAgo(device.motionChangedAt)}` : ''}
                </dd>
              </>
            )}
            {device.connectivity && !stale && (
              <>
                <dt>Zigbee</dt>
                <dd>
                  <span className={`status status-${z.level}`}>
                    <LevelIcon level={z.level} /> {z.text}
                  </span>
                </dd>
              </>
            )}
            {device.battery !== null && (
              <>
                <dt>Battery</dt>
                <dd>
                  <BatteryBar level={device.battery} />
                </dd>
              </>
            )}
            <dt>Model</dt>
            <dd>{device.model ?? '–'}</dd>
            <dt>Firmware</dt>
            <dd>
              <span>
                {device.firmware ?? '–'}
                {update && (
                  <>
                    {' · '}
                    <span className={update.attention ? 'status status-warn' : 'muted'}>{update.text}</span>
                  </>
                )}
              </span>
            </dd>
          </dl>
        )}

        {charts.length > 0 && (
          <>
            <div className="drawer-section-head">
              <h3>History</h3>
              <RangePicker hours={hours} onChange={setHours} />
            </div>
            {charts.map((c) => (
              <div key={c.resource} className="drawer-chart">
                <div className="small muted">{c.title}</div>
                <SensorChart
                  resource={c.resource}
                  kind={c.kind}
                  hours={hours}
                  gaps={gaps}
                  refreshKey={tick}
                  name={device!.name}
                  height={130}
                />
              </div>
            ))}
          </>
        )}

        <h3>Events</h3>
        {events === null ? (
          <p className="muted">Loading…</p>
        ) : events.length === 0 ? (
          <p className="muted">No events recorded for this device yet.</p>
        ) : (
          <ul className="log compact">
            {events.map((e) => {
              const day = formatDay(e.ts)
              const header = day !== lastDay
              lastDay = day
              const cat = categoryOf(e.resourceType)
              return (
                <Fragment key={e.id}>
                  {header && <li className="day">{day}</li>}
                  <li className={`event cat-${cat}`}>
                    <span className="time">{formatTime(e.ts)}</span>
                    <span className="icon"><CategoryIcon category={cat} /></span>
                    <span className="what">
                      {e.summary}
                      {e.eventType === 'backfill' && <span className="badge">while closed</span>}
                      {e.origin === 'hubwatch' && <span className="badge origin">from HubWatch</span>}
                    </span>
                  </li>
                </Fragment>
              )
            })}
          </ul>
        )}
        {hasMore && (
          <div className="center-text">
            <button className="secondary" onClick={loadOlder}>
              Load older events
            </button>
          </div>
        )}
      </div>
    </dialog>
  )
}
