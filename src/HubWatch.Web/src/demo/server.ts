import type {
  ActivityStat,
  Alert,
  AlertSettings,
  Automation,
  Device,
  DiscoveredBridge,
  Group,
  LightStat,
  MotionSensorStat,
  Reading,
  Session,
  Stats,
  SystemEvent,
  SystemStatus,
} from '../types'
import {
  createHueHome,
  createIkeaHome,
  HUE_ADDRESS,
  HUE_NATIVE_ID,
  type DemoDevice,
  type DemoHome,
} from './data'

/**
 * A pretend HubWatch server that runs in the browser. It answers the same /api requests as the real one and
 * pushes the same live messages, so the UI runs unchanged. Values are static; only lights and motion change.
 */

/** How much made-up history a system gets when it is added. */
const HISTORY_MS = 3 * 3_600_000
/** Seconds the user "presses the link button" for: pairing succeeds after this. */
const PAIR_DELAY_MS = 3_000
const STORAGE_KEY = 'hubwatch.demo'
const MAX_EVENTS = 20_000

export type StreamName = 'status' | 'events' | 'snapshot' | 'alert'
type Listener = (name: StreamName, data: unknown) => void

interface DemoSystem {
  status: SystemStatus
  home: DemoHome
  /** Internal number, like the database's system id */
  index: number
  sessionStart: number
  /** When the user added it: before this, history is made up at a slower pace */
  addedAt: number
}

interface StoredEvent {
  ev: SystemEvent
  on?: boolean
  motion?: boolean
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const rand = (min: number, max: number) => min + Math.random() * (max - min)
const pick = <T>(list: T[]): T | undefined => list[Math.floor(Math.random() * list.length)]
const iso = (t: number) => new Date(t).toISOString()
const pretty = (s: string) => s.replace(/_/g, ' ')

export class DemoServer {
  private systems: DemoSystem[] = []
  private events: StoredEvent[] = []
  private alerts: Alert[] = []
  private nextEventId = 1
  private nextAlertId = 1
  private nextSystemIndex = 1
  private queue: { at: number; fn: (t: number) => void }[] = []
  private live = false
  private batch: SystemEvent[] = []
  private listeners = new Set<Listener>()
  private pairing = new Map<string, number>()
  private alertSettings: AlertSettings = {
    lowBatteryEnabled: true,
    lowBatteryPercent: 20,
    deviceUnreachableEnabled: true,
    deviceUnreachableMinutes: 30,
    systemUnreachableEnabled: true,
    systemUnreachableMinutes: 10,
    ntfyUrl: null,
  }

  constructor() {
    for (const saved of loadSaved()) this.addSystem(saved.kind, saved.address)
    this.live = true
    window.setInterval(() => this.tick(), 1000)
  }

  listen(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private send(name: StreamName, data: unknown) {
    this.listeners.forEach((l) => l(name, data))
  }

  // ----- simulation -----

  private tick() {
    this.advance(Date.now())
    this.flush()
  }

  private schedule(at: number, fn: (t: number) => void) {
    this.queue.push({ at, fn })
    this.queue.sort((a, b) => a.at - b.at)
  }

  /** Runs everything scheduled up to `to`, in time order. */
  private advance(to: number) {
    while (this.queue.length > 0 && this.queue[0].at <= to) {
      const item = this.queue.shift()!
      item.fn(item.at)
    }
  }

  private flush() {
    if (this.batch.length === 0) return
    const batch = this.batch
    this.batch = []
    this.send('events', batch)
  }

  private addSystem(kind: 'hue' | 'dirigera', address: string): DemoSystem {
    const now = Date.now()
    // Everything up to now is made-up history: it is stored, not sent live.
    const wasLive = this.live
    this.live = false
    const home = kind === 'hue' ? createHueHome() : createIkeaHome()
    const id = kind === 'hue' ? `hue-${home.nativeId}` : `dirigera-${home.nativeId.toLowerCase().replace(/_/g, '-')}`
    const sessionStart = now - HISTORY_MS
    const sys: DemoSystem = {
      home,
      index: this.nextSystemIndex++,
      sessionStart,
      addedAt: now,
      status: {
        id,
        kind,
        name: home.name,
        address,
        nativeId: home.nativeId,
        state: 'connected',
        message: null,
        connectedSince: sessionStart,
        lastEventAt: null,
        certificatePinned: true,
        problem: null,
        resourcesAsOf: null,
      },
    }
    this.systems.push(sys)

    // What the first snapshot would have logged: the devices that can't be reached, and low batteries.
    for (const d of home.devices) {
      if (d.connectivity === 'disconnected' && d.connectivityId) {
        this.record(sys, d, 'zigbee_connectivity', d.connectivityId, 'Zigbee disconnected', sessionStart + 1000, {
          data: { id: d.connectivityId, owner: owner(d), status: 'disconnected', type: 'zigbee_connectivity' },
        })
        this.openAlert(sys, 'device_unreachable', d.id, 'critical', `${d.name} is unreachable`,
          `${d.name}${this.inRoom(sys, d)} reports "disconnected". Check that it has power and is within range.`,
          sessionStart + 60_000)
      }
      if (d.battery !== null && d.powerId) {
        const low = d.battery < this.alertSettings.lowBatteryPercent
        this.record(sys, d, 'device_power', d.powerId, `Battery ${d.battery}%${low ? ' (low)' : ''}`, sessionStart + 2000, {
          data: { id: d.powerId, owner: owner(d), power_state: { battery_level: d.battery, battery_state: low ? 'low' : 'normal' }, type: 'device_power' },
        })
        if (low)
          this.openAlert(sys, 'low_battery', d.id, 'warning', `Low battery: ${d.name}`,
            `${d.name}${this.inRoom(sys, d)} is at ${d.battery}% battery.`, sessionStart + 60_000)
      }
    }

    // Made-up history, then live events from now on.
    this.schedule(sessionStart + rand(10_000, 60_000), (t) => this.act(sys, t))
    this.advance(now)
    this.live = wasLive
    return sys
  }

  private removeSystem(sys: DemoSystem) {
    this.systems = this.systems.filter((s) => s !== sys)
    this.events = this.events.filter((e) => e.ev.systemId !== sys.status.id)
    this.alerts = this.alerts.filter((a) => a.systemId !== sys.status.id)
  }

  /** One random thing happening in the home, then the next one is scheduled. */
  private act(sys: DemoSystem, t: number) {
    if (!this.systems.includes(sys)) return
    const devices = sys.home.devices.filter((d) => d.connectivity === 'connected')
    const roll = Math.random()
    if (roll < 0.4) {
      const sensor = pick(devices.filter((d) => d.motion && !d.motion.motion))
      if (sensor) this.motion(sys, sensor, t)
    } else if (roll < 0.7) {
      const light = pick(devices.filter((d) => d.light))
      if (light) this.setLight(sys, light, !light.light!.on, t, null)
    } else if (roll < 0.82) {
      const dimmer = pick(devices.filter((d) => d.button))
      if (dimmer) this.press(sys, dimmer, t)
    } else {
      const sensor = pick(devices.filter((d) => d.temperature || d.lightLevel))
      if (sensor) this.report(sys, sensor, t)
    }
    // Live: something every few seconds. Made-up history: a calmer pace, so it stays readable.
    let next = t + (t < sys.addedAt ? rand(90_000, 300_000) : rand(3_000, 9_000))
    if (t < sys.addedAt && next > sys.addedAt) next = sys.addedAt + rand(1_000, 4_000)
    this.schedule(next, (at) => this.act(sys, at))
  }

  private motion(sys: DemoSystem, d: DemoDevice, t: number) {
    const set = (motion: boolean, at: number) => {
      d.motion!.motion = motion
      d.motion!.changedAt = at
      const data =
        sys.home.kind === 'hue'
          ? { id: d.motion!.id, motion: { motion, motion_valid: true, motion_report: { changed: iso(at), motion } }, owner: owner(d), type: 'motion' }
          : { id: d.id, deviceType: 'motionSensor', attributes: { isDetected: motion } }
      this.record(sys, d, 'motion', d.motion!.id, motion ? 'Motion detected' : 'No motion', at, { data, motion })
    }
    set(true, t)
    const light = d.motion!.turnsOn ? sys.home.devices.find((x) => x.id === d.motion!.turnsOn) : undefined
    if (light && !light.light!.on) this.setLight(sys, light, true, t + 400, null)
    this.schedule(t + rand(15_000, 60_000), (at) => {
      if (!this.systems.includes(sys)) return
      set(false, at)
      if (light)
        this.schedule(at + rand(15_000, 40_000), (off) => {
          if (this.systems.includes(sys) && !d.motion!.motion && light.light!.on) this.setLight(sys, light, false, off, null)
        })
    })
  }

  private press(sys: DemoSystem, d: DemoDevice, t: number) {
    const event = (ev: string, at: number) =>
      this.record(sys, d, 'button', d.button!.id, `Button 1: ${pretty(ev)}`, at, {
        data: { id: d.button!.id, button: { button_report: { event: ev, updated: iso(at) }, last_event: ev }, owner: owner(d), type: 'button' },
      })
    event('initial_press', t)
    this.schedule(t + 300, (at) => {
      if (!this.systems.includes(sys)) return
      event('short_release', at)
      const light = sys.home.devices.find((x) => x.id === d.button!.toggles)
      if (light && light.connectivity === 'connected') this.setLight(sys, light, !light.light!.on, at + 200, null)
    })
  }

  private report(sys: DemoSystem, d: DemoDevice, t: number) {
    if (d.temperature && (!d.lightLevel || Math.random() < 0.5)) {
      const value = d.temperature.value
      this.record(sys, d, 'temperature', d.temperature.id, `Temperature ${value.toFixed(1)} °C`, t, {
        data: { id: d.temperature.id, owner: owner(d), temperature: { temperature_report: { changed: iso(t), temperature: value } }, type: 'temperature' },
      })
    } else if (d.lightLevel) {
      const lux = d.lightLevel.lux
      const level = Math.round(10000 * Math.log10(lux) + 1)
      const data =
        sys.home.kind === 'hue'
          ? { id: d.lightLevel.id, light: { light_level_report: { changed: iso(t), light_level: level } }, owner: owner(d), type: 'light_level' }
          : { id: d.id, deviceType: 'lightSensor', attributes: { illuminance: level } }
      this.record(sys, d, 'light_level', d.lightLevel.id, `Light level ${lux} lx`, t, { data })
    }
  }

  private setLight(sys: DemoSystem, d: DemoDevice, on: boolean, t: number, origin: 'hubwatch' | null) {
    const light = d.light!
    light.on = on
    if (on && origin === null && Math.random() < 0.3) light.brightness = pick([40, 60, 80, 100])!
    const isOutlet = light.mirek === null && light.xy === null && sys.home.kind === 'dirigera'
    const summary = on && !isOutlet ? `Turned on, brightness ${light.brightness}%` : on ? 'Turned on' : 'Turned off'
    const data =
      sys.home.kind === 'hue'
        ? { id: light.id, on: { on }, ...(on ? { dimming: { brightness: light.brightness } } : {}), owner: owner(d), type: 'light' }
        : { id: d.id, deviceType: isOutlet ? 'outlet' : 'light', attributes: { isOn: on, ...(on && !isOutlet ? { lightLevel: light.brightness } : {}) } }
    this.record(sys, d, 'light', light.id, summary, t, { data, on, origin })
  }

  private record(
    sys: DemoSystem,
    d: DemoDevice,
    resourceType: string,
    resourceId: string,
    summary: string,
    t: number,
    extra: { data: unknown; on?: boolean; motion?: boolean; origin?: 'hubwatch' | null },
  ) {
    const ev: SystemEvent = {
      id: this.nextEventId++,
      systemId: sys.status.id,
      ts: Math.round(t),
      eventType: 'update',
      resourceId,
      resourceType,
      name: d.name,
      room: this.roomName(sys, d),
      summary,
      data: JSON.stringify(extra.data),
      origin: extra.origin ?? null,
    }
    this.events.push({ ev, on: extra.on, motion: extra.motion })
    const n = this.events.length
    if (n > 1 && this.events[n - 2].ev.ts > ev.ts) this.events.sort((a, b) => a.ev.ts - b.ev.ts || a.ev.id - b.ev.id)
    if (n > MAX_EVENTS) this.events.splice(0, n - MAX_EVENTS)
    sys.status.lastEventAt = Math.max(sys.status.lastEventAt ?? 0, ev.ts)
    if (this.live) this.batch.push(ev)
  }

  private openAlert(sys: DemoSystem, kind: string, key: string, severity: 'warning' | 'critical', title: string, message: string, at: number) {
    const alert: Alert = {
      id: this.nextAlertId++,
      systemId: sys.status.id,
      openedAt: at,
      resolvedAt: null,
      acknowledged: false,
      kind,
      key,
      severity,
      title,
      message,
    }
    this.alerts.push(alert)
    if (this.live) this.send('alert', alert)
  }

  private roomName(sys: DemoSystem, d: DemoDevice) {
    return sys.home.rooms.find((r) => r.key === d.room)?.name ?? null
  }

  private inRoom(sys: DemoSystem, d: DemoDevice) {
    const room = this.roomName(sys, d)
    return room && room !== d.name ? ` (${room})` : ''
  }

  // ----- requests -----

  async handle(method: string, url: URL, body: unknown): Promise<{ status: number; body?: unknown }> {
    try {
      const result = await this.route(method, url.pathname.replace(/^\/api/, ''), url.searchParams, body)
      return result === undefined ? { status: 204 } : { status: 200, body: result }
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, body: { title: e.message, detail: e.message } }
      throw e
    } finally {
      this.flush()
    }
  }

  private async route(method: string, path: string, q: URLSearchParams, body: unknown): Promise<unknown> {
    const num = (name: string) => (q.get(name) !== null && q.get(name) !== '' ? Number(q.get(name)) : undefined)
    const selected = this.selected(q.get('systems'))
    let m: RegExpMatchArray | null

    if (method === 'GET' && path === '/status') return { version: 'demo', systems: this.systems.map((s) => s.status) }

    if (method === 'GET' && path === '/hue/discover') {
      await delay(700)
      const found: DiscoveredBridge[] = [{ ip: HUE_ADDRESS, id: HUE_NATIVE_ID, name: 'Hue Bridge', model: 'BSB002' }]
      return found
    }
    if (method === 'POST' && path === '/hue/pair') return this.pair('hue', String((body as { ip?: string })?.ip ?? ''))
    if (method === 'POST' && path === '/ikea/pair') return this.pair('dirigera', String((body as { ip?: string })?.ip ?? ''))

    if ((m = path.match(/^\/systems\/([^/]+)(\/[a-z-]+)?$/))) {
      const sys = this.systems.find((s) => s.status.id === decodeURIComponent(m![1]))
      if (!sys) throw new HttpError(404, 'No such system.')
      const action = m[2]
      if (method === 'DELETE' && !action) {
        this.removeSystem(sys)
        this.save()
        this.send('status', { version: 'demo', systems: this.systems.map((s) => s.status) })
        return undefined
      }
      if (method === 'POST' && action === '/power') return this.power(sys, body as { target: string; on: boolean })
      if (method === 'POST' && (action === '/reconnect' || action === '/stop' || action === '/trust-certificate')) return undefined
    }

    if (method === 'GET' && path === '/events') {
      const beforeTs = num('beforeTs')
      const beforeId = num('beforeId') ?? Number.MAX_SAFE_INTEGER
      const limit = num('limit') ?? 200
      const type = q.get('type')
      const device = q.get('device')
      const ids = device ? this.resourceIdsOfDevice(device) : null
      const out: SystemEvent[] = []
      for (let i = this.events.length - 1; i >= 0 && out.length < limit; i--) {
        const e = this.events[i].ev
        if (!selected.includes(e.systemId)) continue
        if (beforeTs !== undefined && !(e.ts < beforeTs || (e.ts === beforeTs && e.id < beforeId))) continue
        if (type && e.resourceType !== type) continue
        if (ids && !ids.includes(e.resourceId)) continue
        out.push(e)
      }
      return out
    }
    if (method === 'GET' && (m = path.match(/^\/events\/(\d+)$/))) {
      const e = this.events.find((x) => x.ev.id === Number(m![1]) && selected.includes(x.ev.systemId))
      if (!e) throw new HttpError(404, 'Not found')
      return e.ev
    }

    if (method === 'GET' && path === '/sessions') {
      const from = num('from') ?? Date.now() - 7 * 86_400_000
      const now = Date.now()
      const sessions: Session[] = this.inSystems(selected)
        .filter(() => now >= from)
        .map((s) => ({ id: s.index, systemId: s.status.id, startedAt: s.sessionStart, lastSeenAt: now, endedAt: null }))
      return sessions
    }

    if (method === 'GET' && path === '/devices') return this.inSystems(selected).flatMap((s) => s.home.devices.map((d) => this.toDevice(s, d)))
    if (method === 'GET' && path === '/groups') return this.inSystems(selected).flatMap((s) => this.groups(s))
    if (method === 'GET' && path === '/automations') return this.inSystems(selected).flatMap((s) => this.automations(s))
    if (method === 'GET' && path === '/rules') return { rules: [], schedules: [], errors: [] }
    if (method === 'GET' && path === '/readings')
      return this.readings(selected, q.get('resource') ?? '', q.get('kind') ?? '', num('hours') ?? 24)
    if (method === 'GET' && path === '/stats') return this.stats(selected, num('days') ?? 7)

    if (method === 'GET' && path === '/alerts')
      return this.alerts.filter((a) => selected.includes(a.systemId)).sort((a, b) => b.openedAt - a.openedAt)
    if (method === 'POST' && (m = path.match(/^\/alerts\/(\d+)\/ack$/))) {
      const alert = this.alerts.find((a) => a.id === Number(m![1]))
      if (alert) alert.acknowledged = true
      return undefined
    }
    if (method === 'POST' && path === '/alerts/ack-all') {
      this.alerts.filter((a) => selected.includes(a.systemId)).forEach((a) => (a.acknowledged = true))
      return undefined
    }
    if (method === 'GET' && path === '/settings/alerts') return this.alertSettings
    if (method === 'PUT' && path === '/settings/alerts') {
      this.alertSettings = { ...this.alertSettings, ...(body as AlertSettings) }
      return this.alertSettings
    }
    if (method === 'POST' && path === '/settings/alerts/test-ntfy')
      throw new HttpError(400, "The demo doesn't send notifications. In the real app this sends a test message to your ntfy topic.")

    throw new HttpError(404, `The demo has no ${method} ${path}`)
  }

  /** The systems a data request covers: those in ?systems=, or all. */
  private selected(param: string | null): string[] {
    if (param === null) return this.systems.map((s) => s.status.id)
    return param.split(',').filter(Boolean)
  }

  private inSystems(ids: string[]) {
    return this.systems.filter((s) => ids.includes(s.status.id))
  }

  private async pair(kind: 'hue' | 'dirigera', ip: string) {
    ip = ip.trim()
    if (!ip) throw new HttpError(400, 'Enter an IP address.')
    const existing = this.systems.find((s) => s.status.kind === kind)
    if (existing) {
      if (existing.status.address === ip) return { paired: true, alreadyPaired: true, systemId: existing.status.id, name: existing.status.name }
      throw new HttpError(409, `The demo has one ${kind === 'hue' ? 'Hue Bridge' : 'DIRIGERA hub'}, and it is already added.`)
    }
    await delay(300)
    const started = this.pairing.get(kind)
    const now = Date.now()
    if (started === undefined || now - started > 60_000) {
      this.pairing.set(kind, now)
      return { paired: false }
    }
    if (now - started < PAIR_DELAY_MS) return { paired: false }
    this.pairing.delete(kind)
    const sys = this.addSystem(kind, ip)
    this.save()
    this.send('status', { version: 'demo', systems: this.systems.map((s) => s.status) })
    return { paired: true, systemId: sys.status.id, name: sys.status.name }
  }

  private power(sys: DemoSystem, request: { target: string; on: boolean }) {
    const { target, on } = request
    const room = sys.home.rooms.find((r) => r.id === target)
    const lights = room
      ? sys.home.devices.filter((d) => d.room === room.key && d.light && d.connectivity === 'connected')
      : sys.home.devices.filter((d) => d.light && (d.id === target || d.light.id === target))
    if (lights.length === 0) throw new HttpError(404, 'Nothing to switch.')
    if (!room && lights[0].connectivity !== 'connected')
      throw new HttpError(502, `${lights[0].name} can't be reached, so it can't be switched.`)
    const now = Date.now()
    lights.forEach((d) => this.setLight(sys, d, on, now, 'hubwatch'))
    return undefined
  }

  private resourceIdsOfDevice(deviceId: string): string[] {
    for (const s of this.systems) {
      const d = s.home.devices.find((x) => x.id === deviceId)
      if (d) return [d.id, ...serviceIds(d)]
    }
    return [deviceId]
  }

  private deviceOfResource(sys: DemoSystem, resourceId: string) {
    return sys.home.devices.find((d) => d.id === resourceId || serviceIds(d).includes(resourceId)) ?? null
  }

  private toDevice(sys: DemoSystem, d: DemoDevice): Device {
    const kinds = [
      d.light && 'light',
      d.motion && 'motion',
      d.temperature && 'temperature',
      d.lightLevel && 'light_level',
      d.button && 'button',
      d.powerId && 'device_power',
      d.connectivityId && 'zigbee_connectivity',
    ].filter((k): k is string => !!k)
    return {
      systemId: sys.status.id,
      id: d.id,
      name: d.name,
      room: this.roomName(sys, d),
      archetype: d.archetype,
      product: d.product,
      model: d.model,
      firmware: d.firmware,
      battery: d.battery,
      batteryState: d.battery === null ? null : d.battery < this.alertSettings.lowBatteryPercent ? 'low' : 'normal',
      connectivity: d.connectivityId ? d.connectivity : null,
      on: d.light?.on ?? null,
      brightness: d.light ? d.light.brightness : null,
      motion: d.motion?.motion ?? null,
      motionChangedAt: d.motion?.changedAt ?? null,
      temperature: d.temperature?.value ?? null,
      lux: d.lightLevel?.lux ?? null,
      contact: null,
      softwareUpdate: d.softwareUpdate,
      kinds,
      services: {
        light: d.light?.id ?? null,
        motion: d.motion?.id ?? null,
        temperature: d.temperature?.id ?? null,
        lightLevel: d.lightLevel?.id ?? null,
        power: d.powerId,
        connectivity: d.connectivityId,
        contact: null,
      },
    }
  }

  private groups(sys: DemoSystem): Group[] {
    return sys.home.rooms.map((room) => {
      const inRoom = sys.home.devices.filter((d) => d.room === room.key)
      const lights = inRoom.filter((d) => d.light)
      const on = lights.filter((d) => d.light!.on)
      return {
        systemId: sys.status.id,
        id: room.id,
        kind: 'room' as const,
        name: room.name,
        archetype: room.archetype,
        on: lights.length > 0 ? on.length > 0 : null,
        brightness: on.length > 0 ? Math.round(on.reduce((sum, d) => sum + d.light!.brightness, 0) / on.length) : null,
        lights: lights.map((d) => ({
          id: d.light!.id,
          deviceId: d.id,
          name: d.name,
          on: d.light!.on,
          brightness: d.light!.brightness,
          color:
            d.light!.mirek !== null || d.light!.xy !== null
              ? { x: d.light!.xy?.[0] ?? null, y: d.light!.xy?.[1] ?? null, mirek: d.light!.mirek, brightness: d.light!.brightness }
              : null,
          connectivity: d.connectivityId ? d.connectivity : null,
        })),
        otherDevices: inRoom.filter((d) => !d.light).map((d) => ({ id: d.id, name: d.name, product: d.product })),
        scenes: (sys.home.scenes[room.key] ?? []).map((s, i) => ({
          id: s.id,
          name: s.name,
          smart: false,
          active: 'inactive',
          lastRecall: sys.sessionStart - (i + 1) * 5_400_000,
          speed: 0.6,
          autoDynamic: false,
          palette: s.palette,
        })),
      }
    })
  }

  private automations(sys: DemoSystem): Automation[] {
    return sys.home.automations.map((a) => {
      const targets = a.rooms.map((key) => {
        const room = sys.home.rooms.find((r) => r.key === key)!
        return { id: room.id, type: 'room', name: room.name }
      })
      return {
        systemId: sys.status.id,
        id: a.id,
        name: a.name,
        enabled: true,
        script: a.script,
        scriptDescription: a.scriptDescription,
        category: 'automation',
        status: 'running',
        lastError: null,
        when: a.when,
        startMinute: a.startMinute,
        targets,
        configuration: JSON.stringify({ where: targets.map((t) => ({ group: { rid: t.id, rtype: 'room' } })), when: a.when }),
      }
    })
  }

  private readings(selected: string[], resource: string, kind: string, hours: number): Reading[] {
    for (const sys of this.inSystems(selected)) {
      const d = this.deviceOfResource(sys, resource)
      if (!d) continue
      const value =
        kind === 'temperature' ? d.temperature?.value : kind === 'lux' ? d.lightLevel?.lux : kind === 'battery' ? d.battery : undefined
      if (value === undefined || value === null) return []
      const now = Date.now()
      const step = 5 * 60_000
      const out: Reading[] = []
      for (let t = Math.max(sys.sessionStart, now - hours * 3_600_000); t <= now; t += step) out.push({ ts: t, value })
      return out
    }
    return []
  }

  private stats(selected: string[], days: number): Stats {
    const now = Date.now()
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    start.setDate(start.getDate() - (days - 1))
    const from = start.getTime()
    const dayStarts: number[] = []
    for (let i = 0; i < days; i++) {
      const d = new Date(from)
      d.setDate(d.getDate() + i)
      dayStarts.push(d.getTime())
    }
    const dayKey = (t: number) => {
      const d = new Date(t)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    const dayIndex = (t: number) => {
      let i = dayStarts.length - 1
      while (i > 0 && dayStarts[i] > t) i--
      return i
    }
    const systems = this.inSystems(selected)
    const inRange = this.events.filter((e) => selected.includes(e.ev.systemId) && e.ev.ts >= from && e.ev.ts <= now)

    const lights: LightStat[] = []
    for (const sys of systems) {
      for (const d of sys.home.devices.filter((x) => x.light)) {
        const id = d.light!.id
        const mine = this.events.filter((e) => e.ev.systemId === sys.status.id && e.ev.resourceId === id && e.on !== undefined)
        let state = false
        let cursor = Math.max(from, sys.sessionStart)
        let onMs = 0
        let switchOns = 0
        const perDayMs = dayStarts.map(() => 0)
        const addOn = (a: number, b: number) => {
          while (a < b) {
            const i = dayIndex(a)
            const end = Math.min(b, dayStarts[i + 1] ?? Infinity)
            perDayMs[i] += end - a
            onMs += end - a
            a = end
          }
        }
        for (const e of mine) {
          if (e.ev.ts < cursor) {
            state = e.on!
            continue
          }
          if (state) addOn(cursor, e.ev.ts)
          if (!state && e.on) switchOns++
          state = e.on!
          cursor = e.ev.ts
        }
        if (state && d.connectivity === 'connected') addOn(cursor, now)
        lights.push({ systemId: sys.status.id, id, deviceId: d.id, name: d.name, room: this.roomName(sys, d), onMs, switchOns, perDayMs })
      }
    }

    const motionByWeekdayHour = Array.from({ length: 7 }, () => Array<number>(24).fill(0))
    const motionCounts = new Map<string, number>()
    const activity = new Map<string, { e: SystemEvent; count: number }>()
    for (const { ev, motion } of inRange) {
      if (motion) {
        const d = new Date(ev.ts)
        motionByWeekdayHour[(d.getDay() + 6) % 7][d.getHours()]++
        const key = `${ev.systemId}|${ev.resourceId}`
        motionCounts.set(key, (motionCounts.get(key) ?? 0) + 1)
      }
      if (ev.resourceType === 'device_power' || ev.resourceType === 'zigbee_connectivity') continue
      const key = `${ev.systemId}|${ev.resourceId}`
      const a = activity.get(key)
      if (a) a.count++
      else activity.set(key, { e: ev, count: 1 })
    }

    const deviceIdOf = (systemId: string, resourceId: string) => {
      const sys = this.systems.find((s) => s.status.id === systemId)
      return sys ? (this.deviceOfResource(sys, resourceId)?.id ?? null) : null
    }
    const motionSensors: MotionSensorStat[] = [...motionCounts].map(([key, count]) => {
      const [systemId, id] = key.split('|')
      const e = inRange.find((x) => x.ev.systemId === systemId && x.ev.resourceId === id)!.ev
      return { systemId, id, deviceId: deviceIdOf(systemId, id), name: e.name ?? id, room: e.room, count }
    })
    const mostActive: ActivityStat[] = [...activity.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map(({ e, count }) => ({
        systemId: e.systemId,
        resourceId: e.resourceId,
        deviceId: deviceIdOf(e.systemId, e.resourceId),
        name: e.name ?? e.resourceId,
        room: e.room,
        resourceType: e.resourceType,
        count,
      }))

    return {
      from,
      to: now,
      days: dayStarts.map(dayKey),
      coverage: systems.map((s) => ({ systemId: s.status.id, recordedMs: now - Math.max(from, s.sessionStart) })),
      lights,
      motionByWeekdayHour,
      motionTotal: [...motionCounts.values()].reduce((a, b) => a + b, 0),
      motionSensors,
      mostActive,
    }
  }

  private save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.systems.map((s) => ({ kind: s.status.kind, address: s.status.address }))))
    } catch {
      // storage unavailable: the demo starts empty next time
    }
  }
}

function loadSaved(): { kind: 'hue' | 'dirigera'; address: string }[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter(
      (v): v is { kind: 'hue' | 'dirigera'; address: string } =>
        !!v && (v.kind === 'hue' || v.kind === 'dirigera') && typeof v.address === 'string',
    )
  } catch {
    return []
  }
}

/** Forgets the added systems, so the demo starts from the setup screen again. */
export function resetDemo() {
  try {
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem('hubwatch.hiddenSystems')
  } catch {
    // nothing stored
  }
}

const owner = (d: DemoDevice) => ({ rid: d.id, rtype: 'device' })

function serviceIds(d: DemoDevice): string[] {
  return [d.light?.id, d.motion?.id, d.temperature?.id, d.lightLevel?.id, d.button?.id, d.powerId, d.connectivityId].filter(
    (x): x is string => !!x,
  )
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
