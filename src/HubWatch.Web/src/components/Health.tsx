import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useStream } from '../stream'
import type { Device, SystemEvent, DeviceRef } from '../types'
import { formatDateTime } from '../format'
import { LOW_BATTERY, updateLabel, zigbeeLabel, zigbeeStatusOf } from '../health'
import { useSystemName } from '../systems'
import { TriangleAlert } from 'lucide-react'
import { LevelIcon } from '../icons'

const THIRTY_DAYS = 30 * 86_400_000

type Filter = 'zigbee' | 'drops' | 'battery' | 'updates'
const FILTERS: Filter[] = ['zigbee', 'drops', 'battery', 'updates']

/** Filters named in the URL query, e.g. ?filter=zigbee,battery. Unknown names are ignored. */
function filtersFromUrl(): Filter[] {
  const raw = new URLSearchParams(window.location.search).get('filter') ?? ''
  const names = raw.split(',').map((n) => n.trim().toLowerCase())
  return FILTERS.filter((f) => names.includes(f))
}

/** Keeps the selected filters in the query without adding history entries, so a reload or shared link shows the same list. */
function writeFiltersToUrl(filters: Filter[]) {
  const params = new URLSearchParams(window.location.search)
  if (filters.length > 0) params.set('filter', filters.join(','))
  else params.delete('filter')
  const query = params.toString().replace(/%2C/gi, ',')
  const url = window.location.pathname + (query ? `?${query}` : '') + window.location.hash
  if (url !== window.location.pathname + window.location.search + window.location.hash) window.history.replaceState(window.history.state, '', url)
}

export function Health({ onOpenDevice }: { onOpenDevice: (device: DeviceRef) => void }) {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const systemName = useSystemName()
  const [zigbeeEvents, setZigbeeEvents] = useState<SystemEvent[]>([])
  const [tick, setTick] = useState(0)
  const [filters, setFilters] = useState<Filter[]>(filtersFromUrl)

  useEffect(() => {
    const onPop = () => setFilters(filtersFromUrl())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const updateFilters = (next: Filter[]) => {
    setFilters(next)
    writeFiltersToUrl(next)
  }

  useEffect(() => {
    api.devices().then(setDevices)
    api.events({ type: 'zigbee_connectivity', limit: 500 }).then(setZigbeeEvents)
  }, [tick])

  useStream('snapshot', () => setTick((t) => t + 1))
  useStream('events', (incoming) => {
    if (incoming.some((e) => e.resourceType === 'zigbee_connectivity' || e.resourceType === 'device_power'))
      setTick((t) => t + 1)
  })

  const deviceByZigbeeId = useMemo(() => {
    const map = new Map<string, Device>()
    for (const d of devices ?? []) if (d.services.connectivity) map.set(d.services.connectivity, d)
    return map
  }, [devices])

  const drops = useMemo(() => {
    const since = Date.now() - THIRTY_DAYS
    const counts = new Map<string, number>()
    for (const e of zigbeeEvents) {
      if (e.ts < since) continue
      const status = zigbeeStatusOf(e.data)
      if (status && status !== 'connected') counts.set(e.resourceId, (counts.get(e.resourceId) ?? 0) + 1)
    }
    return counts
  }, [zigbeeEvents])

  if (!devices) return <p className="muted center-text">Loading…</p>

  const severity = (d: Device) =>
    (d.connectivity && d.connectivity !== 'connected' ? 4 : 0) +
    (d.battery !== null && d.battery < LOW_BATTERY ? 2 : 0) +
    (updateLabel(d.softwareUpdate).attention ? 1 : 0)

  const dropsOf = (d: Device) => (d.services.connectivity ? (drops.get(d.services.connectivity) ?? 0) : 0)
  const matches: Record<Filter, (d: Device) => boolean> = {
    zigbee: (d) => !!d.connectivity && d.connectivity !== 'connected',
    drops: (d) => dropsOf(d) > 0,
    battery: (d) => d.battery !== null && d.battery < LOW_BATTERY,
    updates: (d) => updateLabel(d.softwareUpdate).attention,
  }

  const lowBattery = devices.filter(matches.battery).length
  const zigbeeIssues = devices.filter(matches.zigbee).length
  const updates = devices.filter(matches.updates).length
  const totalDrops = [...drops.values()].reduce((a, b) => a + b, 0)
  const counts: Record<Filter, number> = { zigbee: zigbeeIssues, drops: totalDrops, battery: lowBattery, updates }

  // Selected filters combine with OR. One whose count is 0 (e.g. after a live update) has nothing to show, so it is ignored.
  const active = filters.filter((f) => counts[f] > 0)
  const toggle = (f: Filter) =>
    updateFilters(active.includes(f) ? active.filter((x) => x !== f) : FILTERS.filter((x) => x === f || active.includes(x)))

  const sorted = [...devices]
    .filter((d) => active.length === 0 || active.some((f) => matches[f](d)))
    .sort((a, b) => severity(b) - severity(a) || a.name.localeCompare(b.name))

  return (
    <div className="page">
      <div className="summary">
        <Stat value={zigbeeIssues} label="Zigbee issues now" active={active.includes('zigbee')} onToggle={() => toggle('zigbee')} />
        <Stat value={totalDrops} label="Connection drops logged (30 days)" active={active.includes('drops')} onToggle={() => toggle('drops')} />
        <Stat value={lowBattery} label={`Battery below ${LOW_BATTERY}%`} active={active.includes('battery')} onToggle={() => toggle('battery')} />
        <Stat value={updates} label="Firmware updates" active={active.includes('updates')} onToggle={() => toggle('updates')} />
      </div>

      <div className="section-head list-head">
        <h3>Devices</h3>
        {active.length > 0 && (
          <span className="muted small">
            Showing {sorted.length} of {devices.length} ·{' '}
            <button className="link" onClick={() => updateFilters([])}>
              Show all
            </button>
          </span>
        )}
      </div>
      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Zigbee</th>
              <th className="num" title="Connection problems logged in the last 30 days">Drops 30 d</th>
              <th>Battery</th>
              <th>Firmware</th>
              <th>Update</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((d) => {
              const z = zigbeeLabel(d.connectivity)
              const u = updateLabel(d.softwareUpdate)
              const dropCount = dropsOf(d)
              return (
                <tr key={`${d.systemId}-${d.id}`}>
                  <td>
                    <button className="link" onClick={() => onOpenDevice({ systemId: d.systemId, id: d.id })}>
                      {d.name}
                    </button>
                    <div className="muted small">
                      {[d.room, d.product, systemName(d.systemId)].filter(Boolean).join(' · ')}
                    </div>
                  </td>
                  <td>
                    <span className={`status status-${z.level}`}>
                      <LevelIcon level={z.level} /> {z.text}
                    </span>
                  </td>
                  <td className="num">{d.services.connectivity ? dropCount : '–'}</td>
                  <td>{d.battery !== null ? <BatteryBar level={d.battery} /> : <span className="muted">Mains</span>}</td>
                  <td className="mono">{d.firmware ?? '–'}</td>
                  <td>
                    <span className={u.attention ? 'status status-warn' : 'muted'}>{u.text}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <h3>Connectivity history</h3>
      {zigbeeEvents.length === 0 ? (
        <p className="muted">No Zigbee status changes recorded yet.</p>
      ) : (
        <ul className="log">
          {zigbeeEvents.slice(0, 100).map((e) => {
            const z = zigbeeLabel(zigbeeStatusOf(e.data))
            const device = deviceByZigbeeId.get(e.resourceId)
            return (
              <li key={e.id} className="history-row">
                <span className="muted small">{formatDateTime(e.ts)}</span>
                <button className="link" disabled={!device} onClick={() => device && onOpenDevice({ systemId: device.systemId, id: device.id })}>
                  {device?.name ?? e.name ?? 'Unknown device'}
                </button>
                <span className={`status status-${z.level}`}>
                  <LevelIcon level={z.level} /> {z.text}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function Stat({ value, label, active, onToggle }: { value: number; label: string; active: boolean; onToggle: () => void }) {
  const warn = value > 0
  const content = (
    <>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </>
  )
  // Only non-zero stats filter the list; a zero stat stays a plain box.
  if (!warn) return <div className="stat">{content}</div>
  return (
    <button
      type="button"
      className={`stat warn clickable${active ? ' active' : ''}`}
      aria-pressed={active}
      title={active ? 'Remove this filter' : 'Show these devices'}
      onClick={onToggle}
    >
      {content}
    </button>
  )
}

export function BatteryBar({ level }: { level: number }) {
  const low = level < LOW_BATTERY
  return (
    <span className={`battery-bar${low ? ' low' : ''}`} title={`${Math.round(level)}%`}>
      <span className="battery-track">
        <span className="battery-fill" style={{ width: `${Math.max(3, Math.min(100, level))}%` }} />
      </span>
      {Math.round(level)}%{low && <TriangleAlert aria-label="Low battery" />}
    </span>
  )
}
