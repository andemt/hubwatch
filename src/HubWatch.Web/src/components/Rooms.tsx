import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../api'
import type { Group, GroupDevice, GroupLight, PowerTarget, Scene, DeviceRef } from '../types'
import { PowerSwitch } from './PowerSwitch'
import { hueColorToHex, paletteBackground } from '../color'
import { formatAgo } from '../format'
import { useLiveRefresh } from '../useThrottledRefresh'
import { useStaleHint } from '../health'
import { useSystemName } from '../systems'
import { Box, ChevronRight, CircleDot, Footprints, TriangleAlert } from 'lucide-react'

const RELEVANT = new Set(['light', 'grouped_light', 'scene', 'smart_scene', 'room', 'zone'])

/** A room or zone as shown: groups with the same name and kind from all systems merged into one. */
interface RoomView {
  key: string
  kind: Group['kind']
  name: string
  on: boolean | null
  brightness: number | null
  /** The groups this view merges, one per system: switching the view switches all of them. */
  members: PowerTarget[]
  lights: (GroupLight & { systemId: string })[]
  otherDevices: (GroupDevice & { systemId: string })[]
  scenes: (Scene & { systemId: string })[]
}

function mergeByName(groups: Group[]): RoomView[] {
  const byKey = new Map<string, Group[]>()
  for (const g of groups) {
    const key = `${g.kind}|${g.name.trim().toLowerCase()}`
    byKey.set(key, [...(byKey.get(key) ?? []), g])
  }

  return [...byKey.entries()]
    .map(([key, list]) => {
      const lit = list.filter((g) => g.on)
      const brightness = lit.map((g) => g.brightness).filter((b): b is number => b !== null)
      return {
        key,
        kind: list[0].kind,
        name: list[0].name,
        on: lit.length > 0 ? true : list.some((g) => g.on === false) ? false : null,
        brightness: brightness.length > 0 ? brightness.reduce((a, b) => a + b, 0) / brightness.length : null,
        members: list.map((g) => ({ systemId: g.systemId, id: g.id })),
        lights: list
          .flatMap((g) => g.lights.map((l) => ({ ...l, systemId: g.systemId })))
          .sort((a, b) => a.name.localeCompare(b.name)),
        otherDevices: list
          .flatMap((g) => g.otherDevices.map((d) => ({ ...d, systemId: g.systemId })))
          .sort((a, b) => a.name.localeCompare(b.name)),
        scenes: list
          .flatMap((g) => g.scenes.map((s) => ({ ...s, systemId: g.systemId })))
          .sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || a.name.localeCompare(b.name)),
      }
    })
    .sort((a, b) => Number(a.kind === 'zone') - Number(b.kind === 'zone') || a.name.localeCompare(b.name))
}

function isActive(s: Scene) {
  return s.active !== null && s.active !== 'inactive'
}

export function Rooms({ onOpenDevice }: { onOpenDevice: (device: DeviceRef) => void }) {
  const [groups, setGroups] = useState<Group[] | null>(null)
  const tick = useLiveRefresh((e) => RELEVANT.has(e.resourceType))

  useEffect(() => {
    api.groups().then(setGroups).catch(() => {})
  }, [tick])

  const rooms = useMemo(() => (groups ? mergeByName(groups) : []), [groups])

  if (!groups) return <p className="muted center-text">Loading…</p>
  if (groups.length === 0)
    return (
      <div className="page">
        <div className="empty">
          <p>No rooms or zones.</p>
          <p className="muted">Create rooms in the Hue app to group your lights.</p>
        </div>
      </div>
    )

  return (
    <div className="page">
      <div className="group-grid">
        {rooms.map((g) => (
          <GroupCard key={g.key} group={g} onOpenDevice={onOpenDevice} />
        ))}
      </div>
    </div>
  )
}

function GroupCard({ group: g, onOpenDevice }: { group: RoomView; onOpenDevice: (device: DeviceRef) => void }) {
  const systemName = useSystemName()
  const staleHint = useStaleHint()
  const state =
    g.lights.length === 0 ? null : g.on ? `On${g.brightness !== null ? ` · ${Math.round(g.brightness)}%` : ''}` : 'Off'
  // If the bridge can't reliably reach any light in the room, the room state is only the last known one too.
  const lightHints = g.lights.map((l) => staleHint(l.systemId, l.connectivity))
  const stale = lightHints.length > 0 && lightHints.every((h) => h !== null)

  return (
    <div className={`card group${g.on && !stale ? ' lit' : ''}`}>
      <div className="group-head">
        <h2>
          {g.name}
          {g.kind === 'zone' && <span className="tag">Zone</span>}
        </h2>
        <div className="group-head-right">
          {state && (
            <span className={`chip${g.on ? ' on' : ''}${stale ? ' stale' : ''}`} title={stale ? (lightHints[0] ?? undefined) : undefined}>
              {state}
              {stale && ' (last known)'}
            </span>
          )}
          {g.lights.length > 0 && <PowerSwitch on={g.on} targets={g.members} label={`Switch ${g.name}`} />}
        </div>
      </div>

      {(g.lights.length > 0 || g.otherDevices.length > 0) && (
        <>
          <h3>Devices</h3>
          <ul className="device-list">
            {g.lights.map((l) => (
              <li key={`${l.systemId}-${l.id}`}>
                <LightRow
                  light={l}
                  system={systemName(l.systemId)}
                  onOpen={l.deviceId ? () => onOpenDevice({ systemId: l.systemId, id: l.deviceId! }) : undefined}
                />
              </li>
            ))}
            {g.otherDevices.map((d) => (
              <li key={`${d.systemId}-${d.id}`}>
                <DeviceRow
                  device={d}
                  roomName={g.name}
                  system={systemName(d.systemId)}
                  onOpen={() => onOpenDevice({ systemId: d.systemId, id: d.id })}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Scenes</h3>
      {g.scenes.length === 0 ? (
        <p className="muted small">No scenes.</p>
      ) : (
        <div className="scene-grid">
          {g.scenes.map((s) => (
            <SceneTile key={`${s.systemId}-${s.id}`} scene={s} system={systemName(s.systemId)} />
          ))}
        </div>
      )}
    </div>
  )
}

/** One clickable row in a room's device list: icon, name (+ system when several are shown), state, chevron. */
function DeviceRowButton({
  icon,
  name,
  system,
  state,
  stale,
  title,
  onOpen,
}: {
  icon: ReactNode
  name: string
  system: string | null
  state?: string
  stale?: boolean
  title?: string
  onOpen?: () => void
}) {
  return (
    <button type="button" className={`device-row${stale ? ' stale' : ''}`} onClick={onOpen} disabled={!onOpen} title={title}>
      <span className="device-row-icon">{icon}</span>
      <span className="device-row-name">
        <span>{name}</span>
        {system && <span className="muted tiny-inline">{system}</span>}
      </span>
      {state && (
        <span className="device-row-state">
          {stale && <TriangleAlert className="stale-mark" aria-hidden />}
          {state}
          {stale && <span className="visually-hidden"> (last known)</span>}
        </span>
      )}
      <ChevronRight className="device-row-chevron" aria-hidden />
    </button>
  )
}

function LightRow({
  light: l,
  system,
  onOpen,
}: {
  light: GroupLight & { systemId: string }
  system: string | null
  onOpen?: () => void
}) {
  // Plugs and plain on/off lights have no colour: show a warm dot when on.
  const hex = l.on ? (hueColorToHex(l.color) ?? 'var(--light)') : null
  const staleHint = useStaleHint()(l.systemId, l.connectivity)
  const stale = staleHint !== null
  const state = l.on ? (l.brightness !== null ? `${Math.round(l.brightness)}%` : 'On') : 'Off'
  return (
    <DeviceRowButton
      icon={<span className="swatch" style={{ background: hex ?? 'transparent', borderColor: hex ?? 'var(--muted)' }} />}
      name={l.name}
      system={system}
      state={state}
      stale={stale}
      title={staleHint ?? undefined}
      onOpen={onOpen}
    />
  )
}

function DeviceRow({
  device: d,
  roomName,
  system,
  onOpen,
}: {
  device: GroupDevice
  roomName: string
  system: string | null
  onOpen: () => void
}) {
  // A sensor is often named after its room ("Hallway" in Hallway): then the product says more.
  const namedAfterRoom = d.name.trim().toLowerCase() === roomName.trim().toLowerCase()
  const label = namedAfterRoom && d.product ? d.product : d.name
  const product = (d.product ?? '').toLowerCase()
  const Icon = product.includes('motion') ? Footprints : /switch|dimmer|button|tap/.test(product) ? CircleDot : Box
  return (
    <DeviceRowButton
      icon={<Icon aria-hidden />}
      name={label}
      system={system}
      title={label !== d.name ? d.name : (d.product ?? undefined)}
      onOpen={onOpen}
    />
  )
}

function SceneTile({ scene: s, system }: { scene: Scene; system: string | null }) {
  const active = isActive(s)
  return (
    <div className={`scene${active ? ' active' : ''}`}>
      <div className="scene-swatch" style={{ background: paletteBackground(s.palette) }} />
      <div className="scene-body">
        <span className="scene-name">{s.name}</span>
        <span className="muted tiny-inline">
          {[
            active && (s.active === 'dynamic_palette' ? '● Active · dynamic' : '● Active'),
            s.smart && 'Smart scene',
            !active && s.lastRecall && `Used ${formatAgo(s.lastRecall)}`,
            system,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
    </div>
  )
}
