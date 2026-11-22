import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useStream } from '../stream'
import type { Device, ReadingKind, Session, DeviceRef } from '../types'
import { gapsFrom } from '../sessions'
import { useSystems } from '../systems'
import { SensorChart } from './SensorChart'
import { useSystemName } from '../systems'
import { Collapsible } from './Collapsible'

/** Temperature and light charts. Part of the Insights page, which owns the time range. */
export function Climate({ onOpenDevice, hours }: { onOpenDevice: (device: DeviceRef) => void; hours: number }) {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [sessions, setSessions] = useState<{ from: number; list: Session[] }>({ from: Date.now(), list: [] })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    api.devices().then(setDevices)
  }, [tick])

  useEffect(() => {
    const from = Date.now() - hours * 3_600_000
    api.sessions(from).then((list) => setSessions({ from, list }))
  }, [hours, tick])

  // Charts refresh once a minute and after a reconnect.
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  useStream('snapshot', () => setTick((t) => t + 1))

  const systems = useSystems()
  const systemName = useSystemName()
  const systemIds = useMemo(() => systems.map((s) => s.id), [systems])
  const gaps = useMemo(() => gapsFrom(sessions.list, sessions.from, undefined, systemIds), [sessions, systemIds])

  if (!devices) return <p className="muted center-text">Loading…</p>

  const temperature = devices.filter((d) => d.services.temperature)
  const light = devices.filter((d) => d.services.lightLevel)

  const section = (title: string, list: Device[], kind: ReadingKind) => (
    <Collapsible id={`insights.${kind}`} title={title}>
      <div className="chart-grid">
        {list.map((d) => {
          const resource = kind === 'temperature' ? d.services.temperature! : d.services.lightLevel!
          const current = kind === 'temperature' ? d.temperature : d.lux
          return (
            <div key={`${d.systemId}-${resource}`} className="card chart-card">
              <div className="chart-head">
                <button className="link" onClick={() => onOpenDevice({ systemId: d.systemId, id: d.id })}>
                  {d.name}
                  {d.room && d.room !== d.name && <span className="muted"> · {d.room}</span>}
                  {systemName(d.systemId) && <span className="muted"> · {systemName(d.systemId)}</span>}
                </button>
                {current !== null && (
                  <span className="current">
                    {kind === 'temperature' ? `${current.toFixed(1)} °C` : `${Math.round(current)} lx`}
                  </span>
                )}
              </div>
              <SensorChart
                resource={resource}
                kind={kind}
                hours={hours}
                gaps={gaps.filter((g) => g.systemId === d.systemId)}
                refreshKey={tick}
                name={d.name}
              />
            </div>
          )
        })}
      </div>
    </Collapsible>
  )

  if (temperature.length === 0 && light.length === 0) return null

  return (
    <>
      {temperature.length > 0 && section('Temperature', temperature, 'temperature')}
      {light.length > 0 && section('Light level', light, 'lux')}
    </>
  )
}
