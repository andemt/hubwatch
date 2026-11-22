import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useStream } from '../stream'
import type { Device, DeviceRef } from '../types'
import { formatAgo } from '../format'
import { LOW_BATTERY, useStaleHint } from '../health'
import { useSystemName } from '../systems'
import { PowerSwitch } from './PowerSwitch'
import { BatteryLow, BatteryMedium } from 'lucide-react'


export function Devices({ onOpenDevice }: { onOpenDevice: (device: DeviceRef) => void }) {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const reloadTimer = useRef<number | undefined>(undefined)

  const load = useCallback(() => {
    api.devices().then(setDevices).catch(() => {})
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Many events arrive in bursts; refresh at most every 1.5 s.
  const scheduleReload = () => {
    if (reloadTimer.current !== undefined) return
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = undefined
      load()
    }, 1500)
  }
  useStream('events', scheduleReload)
  useStream('snapshot', scheduleReload)

  // Grouped by room name, whichever system a device belongs to.
  const rooms = useMemo(() => {
    const map = new Map<string, Device[]>()
    for (const d of devices ?? []) {
      const room = d.room ?? 'No room'
      map.set(room, [...(map.get(room) ?? []), d])
    }
    return [...map.entries()]
      .sort(([a], [b]) => (a === 'No room' ? 1 : b === 'No room' ? -1 : a.localeCompare(b)))
      .map(([room, list]) => [room, [...list].sort((a, b) => a.name.localeCompare(b.name))] as const)
  }, [devices])

  if (!devices) return <p className="muted center-text">Loading…</p>

  const lowBattery = devices.filter((d) => d.battery !== null && d.battery < LOW_BATTERY)
  const unreachable = devices.filter((d) => d.connectivity && d.connectivity !== 'connected')

  return (
    <div className="page">
      <div className="summary">
        <div className="stat">
          <span className="stat-value">{devices.length}</span>
          <span className="stat-label">Devices</span>
        </div>
        <div className={`stat${lowBattery.length ? ' warn' : ''}`}>
          <span className="stat-value">{lowBattery.length}</span>
          <span className="stat-label">Low battery</span>
        </div>
        <div className={`stat${unreachable.length ? ' warn' : ''}`}>
          <span className="stat-value">{unreachable.length}</span>
          <span className="stat-label">Zigbee issues</span>
        </div>
      </div>

      {rooms.map(([room, list]) => (
        <div key={room} className="room-group">
          <h3>{room}</h3>
          <div className="grid">
            {list.map((d) => (
              <DeviceCard key={`${d.systemId}-${d.id}`} device={d} onOpen={() => onOpenDevice({ systemId: d.systemId, id: d.id })} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function DeviceCard({ device: d, onOpen }: { device: Device; onOpen: () => void }) {
  const systemName = useSystemName()
  const staleHint = useStaleHint()(d.systemId, d.connectivity)
  const stale = staleHint !== null
  return (
    // Not a <button>: the on/off switch is a button of its own and buttons can't be nested. The open button's
    // click area is stretched over the whole card (.device-open::after); the switch sits above it.
    <div className={`card device${d.on && !stale ? ' lit' : ''}`}>
      <div className="device-head">
        <button type="button" className="device-open device-name" onClick={onOpen}>
          {d.name}
        </button>
        <span className="device-head-right">
          {d.battery !== null && (
            <span className={`battery${d.battery < LOW_BATTERY ? ' low' : ''}`} title={d.batteryState ?? undefined}>
              {d.battery < LOW_BATTERY ? <BatteryLow aria-hidden /> : <BatteryMedium aria-hidden />}
              {Math.round(d.battery)}%
            </span>
          )}
          {d.on !== null && (
            <span className="device-power">
              <PowerSwitch on={d.on} targets={[{ systemId: d.systemId, id: d.id }]} label={`Switch ${d.name}`} />
            </span>
          )}
        </span>
      </div>
      <div className="muted small">{[d.product ?? d.model, systemName(d.systemId)].filter(Boolean).join(' · ')}</div>

      <div className="device-state">
        {d.on !== null && (
          <span className={`chip${d.on ? ' on' : ''}${stale ? ' stale' : ''}`} title={staleHint ?? undefined}>
            {d.on ? `On${d.brightness !== null ? ` · ${Math.round(d.brightness)}%` : ''}` : 'Off'}
            {stale && ' (last known)'}
          </span>
        )}
        {d.motion !== null && (
          <span className={`chip${d.motion ? ' alert' : ''}`}>
            {d.motion ? 'Motion' : 'No motion'}
            {d.motionChangedAt ? ` · ${formatAgo(d.motionChangedAt)}` : ''}
          </span>
        )}
        {d.temperature !== null && <span className="chip">{d.temperature.toFixed(1)} °C</span>}
        {d.lux !== null && <span className="chip">{Math.round(d.lux)} lx</span>}
        {d.contact && <span className="chip">{d.contact === 'contact' ? 'Closed' : 'Open'}</span>}
        {d.connectivity && d.connectivity !== 'connected' && (
          <span className="chip warn">Zigbee {d.connectivity.replace(/_/g, ' ')}</span>
        )}
      </div>

      {d.firmware && <div className="muted tiny">Firmware {d.firmware}</div>}
    </div>
  )
}
