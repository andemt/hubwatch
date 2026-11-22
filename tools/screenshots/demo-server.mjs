// A stand-in for the HubWatch server with an invented demo home, used to take the README screenshots.
// It serves the built frontend and answers the API with generated data — no bridge, hub or database needed.
//
//   node tools/screenshots/demo-server.mjs <path to built wwwroot or dist> [port]
//
// Everything is generated relative to "now", so the screenshots always show recent activity.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

// The capture scripts use this time zone too, so daily curves line up with the clock in the screenshots.
process.env.TZ ??= 'Europe/Stockholm'

const root = path.resolve(process.argv[2] ?? 'src/HubWatch.Web/dist')
const port = Number(process.argv[3] ?? 5099)

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.now()

// Deterministic randomness so every run looks the same.
let seed = 42
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
const pick = (list) => list[Math.floor(rnd() * list.length)]

const HUE = 'hue-001788fffe6a1b2c'
const IKEA = 'ikea-dirigera-7f3a'

// ----- recording sessions: the app was closed for a while last night and two days ago -----

const sessions = [
  { id: 1, systemId: HUE, startedAt: NOW - 30 * DAY, lastSeenAt: NOW - 2 * DAY - 9 * HOUR, endedAt: NOW - 2 * DAY - 9 * HOUR },
  { id: 2, systemId: HUE, startedAt: NOW - 2 * DAY - 5 * HOUR, lastSeenAt: NOW - 14 * HOUR, endedAt: NOW - 14 * HOUR },
  { id: 3, systemId: HUE, startedAt: NOW - 9 * HOUR, lastSeenAt: NOW, endedAt: null },
  { id: 4, systemId: IKEA, startedAt: NOW - 12 * DAY, lastSeenAt: NOW - 14 * HOUR, endedAt: NOW - 14 * HOUR },
  { id: 5, systemId: IKEA, startedAt: NOW - 9 * HOUR, lastSeenAt: NOW, endedAt: null },
]
const recording = (systemId, ts) =>
  sessions.some((s) => s.systemId === systemId && ts >= s.startedAt && ts <= (s.endedAt ?? Infinity))

// ----- the home -----

const svc = () => ({ light: null, motion: null, temperature: null, lightLevel: null, power: null, connectivity: null, contact: null })

function device(systemId, id, name, room, product, extra = {}) {
  return {
    systemId, id, name, room, archetype: null, product, model: null, firmware: '1.122.2',
    battery: null, batteryState: null, connectivity: 'connected', on: null, brightness: null,
    motion: null, motionChangedAt: null, temperature: null, lux: null, contact: null,
    softwareUpdate: 'no_update', kinds: [], services: svc(), ...extra,
  }
}

const MODELS = {
  'Hue Go': 'LLC020', 'Hue White and Color Ambiance': 'LCA001', 'Hue Play Gradient Lightstrip': 'LCX004',
  'Hue White Ambiance': 'LTA001', 'Hue White Ambiance GU10': 'LTG002', 'Hue Enrave pendant': 'LTD011',
  'Hue White': 'LWA001', 'Hue Signe': 'LCT024', 'Hue Lightstrip Plus': 'LCL001', 'Hue Lily XL': 'LCS001',
  'Hue motion sensor': 'SML001', 'Hue outdoor motion sensor': 'SML002', 'Hue secure contact sensor': 'SOC001',
  'Hue dimmer switch': 'RWL022', 'Hue tap dial switch': 'RDM002',
}

function light(systemId, id, name, room, product, on, brightness, color) {
  const d = device(systemId, id, name, room, product, { on, brightness: on ? brightness : 0 })
  d.services.light = `${id}-light`
  d.services.connectivity = `${id}-zb`
  d.kinds = ['light', 'zigbee_connectivity', 'device_software_update']
  d.color = color
  return d
}

function sensor(systemId, id, name, room, product, { battery, motion, temperature, lux, contact }) {
  const d = device(systemId, id, name, room, product, { battery, batteryState: battery < 15 ? 'critical' : battery < 25 ? 'low' : 'normal' })
  d.services.power = `${id}-power`
  d.services.connectivity = `${id}-zb`
  d.kinds = ['device_power', 'zigbee_connectivity']
  if (motion !== undefined) {
    d.services.motion = `${id}-motion`
    d.motion = motion
    d.motionChangedAt = NOW - Math.round(rnd() * 40) * MIN
    d.kinds.push('motion')
  }
  if (temperature !== undefined) {
    d.services.temperature = `${id}-temp`
    d.temperature = temperature
    d.kinds.push('temperature')
  }
  if (lux !== undefined) {
    d.services.lightLevel = `${id}-lux`
    d.lux = lux
    d.kinds.push('light_level')
  }
  if (contact !== undefined) {
    d.services.contact = `${id}-contact`
    d.contact = contact
    d.kinds.push('contact')
  }
  return d
}

function remote(systemId, id, name, room, product, battery) {
  const d = sensor(systemId, id, name, room, product, { battery })
  d.kinds.push('button')
  return d
}

const warm = (mirek, brightness = 80) => ({ x: null, y: null, mirek, brightness })
const xy = (x, y, brightness = 80) => ({ x, y, mirek: null, brightness })

const devices = [
  light(HUE, 'sofa', 'Sofa lamp', 'Living room', 'Hue Go', true, 62, xy(0.53, 0.39)),
  light(HUE, 'ceiling-lr', 'Ceiling', 'Living room', 'Hue White and Color Ambiance', true, 45, warm(370)),
  light(HUE, 'tv-strip', 'TV lightstrip', 'Living room', 'Hue Play Gradient Lightstrip', true, 70, xy(0.18, 0.22)),
  light(HUE, 'reading', 'Reading lamp', 'Living room', 'Hue White Ambiance', false, 0, warm(300)),
  light(HUE, 'kitchen-1', 'Kitchen spot 1', 'Kitchen', 'Hue White Ambiance GU10', true, 90, warm(250)),
  light(HUE, 'kitchen-2', 'Kitchen spot 2', 'Kitchen', 'Hue White Ambiance GU10', true, 90, warm(250)),
  light(HUE, 'island', 'Kitchen island', 'Kitchen', 'Hue Enrave pendant', true, 75, warm(280)),
  light(HUE, 'bed-left', 'Bedside left', 'Bedroom', 'Hue Go', false, 0, xy(0.56, 0.4)),
  light(HUE, 'bed-right', 'Bedside right', 'Bedroom', 'Hue Go', false, 0, xy(0.56, 0.4)),
  light(HUE, 'hall', 'Hallway ceiling', 'Hallway', 'Hue White', false, 0, warm(366)),
  light(HUE, 'desk', 'Desk lamp', 'Office', 'Hue Signe', true, 85, warm(233)),
  light(HUE, 'shelf', 'Bookshelf', 'Office', 'Hue Lightstrip Plus', true, 40, xy(0.31, 0.15)),
  light(HUE, 'porch', 'Porch', 'Garden', 'Hue Lily XL', false, 0, warm(400)),
  light(IKEA, 'ikea-bath', 'Bathroom ceiling', 'Bathroom', 'TRÅDFRI bulb E27 WS 806 lm', false, 0, warm(300)),
  light(IKEA, 'ikea-mirror', 'Mirror light', 'Bathroom', 'TRÅDFRI bulb E14 WS 470 lm', false, 0, warm(300)),
  light(IKEA, 'ikea-kids', 'Night light', 'Kids room', 'TRÅDFRI bulb E14 CWS', true, 15, xy(0.4, 0.2)),

  sensor(HUE, 'motion-hall', 'Hallway sensor', 'Hallway', 'Hue motion sensor', { battery: 81, motion: false, temperature: 20.4, lux: 3 }),
  sensor(HUE, 'motion-kitchen', 'Kitchen sensor', 'Kitchen', 'Hue motion sensor', { battery: 64, motion: true, temperature: 22.1, lux: 180 }),
  sensor(HUE, 'motion-garden', 'Garden sensor', 'Garden', 'Hue outdoor motion sensor', { battery: 12, motion: false, temperature: 3.6, lux: 0 }),
  sensor(HUE, 'contact-door', 'Front door', 'Hallway', 'Hue secure contact sensor', { battery: 93, contact: 'contact' }),
  sensor(IKEA, 'ikea-motion-bath', 'Bathroom sensor', 'Bathroom', 'VALLHORN wireless motion sensor', { battery: 22, motion: false, lux: 0 }),
  sensor(IKEA, 'ikea-env', 'Kids room air', 'Kids room', 'TIMMERFLOTTE temp/hmd sensor', { battery: 77, temperature: 21.2 }),

  remote(HUE, 'dimmer-lr', 'Living room dimmer', 'Living room', 'Hue dimmer switch', 58),
  remote(HUE, 'tap-bed', 'Bedroom tap dial', 'Bedroom', 'Hue tap dial switch', 88),
  remote(IKEA, 'ikea-remote', 'Kids room remote', 'Kids room', 'RODRET dimmer', 45),
]
const byId = new Map(devices.map((d) => [`${d.systemId}:${d.id}`, d]))
for (const d of devices) {
  d.model = MODELS[d.product] ?? (d.systemId === IKEA ? 'LED2201G8' : null)
  if (d.systemId === IKEA) d.firmware = '2.3.093'
  else if (d.services.motion || d.kinds.includes('button')) d.firmware = '2.53.6'
}

// A few health problems, so the Health view has something to show.
byId.get(`${HUE}:porch`).connectivity = 'connectivity_issue'
byId.get(`${HUE}:shelf`).softwareUpdate = 'ready_to_install'
byId.get(`${HUE}:desk`).softwareUpdate = 'update_pending'

// ----- events -----

const events = []
let nextId = 1
function addEvent(d, ts, resourceType, summary, data, extra = {}) {
  if (!recording(d.systemId, ts) && extra.eventType !== 'backfill') return
  const resourceId =
    {
      light: d.services.light, motion: d.services.motion, temperature: d.services.temperature,
      light_level: d.services.lightLevel, device_power: d.services.power, zigbee_connectivity: d.services.connectivity,
      contact: d.services.contact, button: `${d.id}-button`,
    }[resourceType] ?? d.id
  events.push({
    id: 0, systemId: d.systemId, ts, eventType: 'update', resourceId, resourceType, name: d.name, room: d.room,
    summary, data: JSON.stringify({ id: resourceId, type: resourceType, ...data }), origin: null, deviceId: d.id, ...extra,
  })
}

const lights = devices.filter((d) => d.services.light)
const motionSensors = devices.filter((d) => d.services.motion)
const temps = devices.filter((d) => d.services.temperature)
const luxes = devices.filter((d) => d.services.lightLevel)
const remotes = devices.filter((d) => d.kinds.includes('button'))

const tempAt = (d, ts) => {
  const h = new Date(ts).getHours() + new Date(ts).getMinutes() / 60
  const base = d.room === 'Garden' ? 4 : d.room === 'Kitchen' ? 21.6 : 20.6
  const swing = d.room === 'Garden' ? 3.5 : 0.9
  return base + swing * Math.sin(((h - 9) / 24) * 2 * Math.PI) + (rnd() - 0.5) * 0.3 + Math.sin(ts / (3 * DAY)) * 0.6
}
const luxAt = (d, ts) => {
  const h = new Date(ts).getHours() + new Date(ts).getMinutes() / 60
  const daylight = Math.max(0, Math.sin(((h - 8) / 8.5) * Math.PI)) // short November days
  const max = d.room === 'Garden' ? 2200 : d.room === 'Kitchen' ? 320 : 90
  const lamp = d.room !== 'Garden' && h > 16 && h < 23 ? 60 : 0
  return Math.round(daylight * max * (0.7 + rnd() * 0.3) + lamp)
}

for (let t = NOW - 30 * DAY; t < NOW; t += 10 * MIN) {
  const hour = new Date(t).getHours()
  const awake = hour >= 6 && hour <= 23
  const evening = hour >= 16 && hour <= 23

  if (awake && rnd() < (evening ? 0.75 : 0.3)) {
    const s = pick([...motionSensors, motionSensors[0], motionSensors[0], motionSensors[1], motionSensors[1], motionSensors[1]])
    addEvent(s, t + rnd() * 5 * MIN, 'motion', 'Motion detected', { motion: { motion: true } })
    addEvent(s, t + 6 * MIN, 'motion', 'No motion', { motion: { motion: false } })
  }
  if (awake && rnd() < (evening ? 0.3 : 0.1)) {
    const l = pick(lights)
    const on = rnd() < 0.55
    const b = Math.round(30 + rnd() * 70)
    addEvent(l, t + rnd() * 9 * MIN, 'light', on ? `Turned on, brightness ${b}%` : 'Turned off', {
      on: { on }, ...(on ? { dimming: { brightness: b } } : {}),
    })
  }
  if (awake && rnd() < 0.05) {
    const r = pick(remotes)
    const button = 1 + Math.floor(rnd() * 4)
    addEvent(r, t + rnd() * 9 * MIN, 'button', `Button ${button}: ${pick(['initial press', 'short release', 'long press'])}`, {
      button: { button_report: { event: 'short_release' } },
    })
  }
  // Sensors only report when the value changes noticeably, so readings are sparser than motion.
  if (t % HOUR < 10 * MIN) {
    for (const d of temps) {
      if (rnd() < 0.5) continue
      const v = Math.round(tempAt(d, t) * 10) / 10
      addEvent(d, t, 'temperature', `Temperature ${v.toFixed(1)} °C`, { temperature: { temperature: v } })
    }
    for (const d of luxes) {
      if (rnd() < 0.5) continue
      const v = luxAt(d, t)
      addEvent(d, t, 'light_level', `Light level ${v} lx`, { light: { light_level: v } })
    }
  }
}

// The last hour, hand-written so the top of the log tells a story.
const ev = (minAgo, key, resourceType, summary, data, extra) =>
  addEvent(byId.get(key), NOW - minAgo * MIN, resourceType, summary, data, extra)
ev(58, `${HUE}:porch`, 'zigbee_connectivity', 'Zigbee connectivity issue', { status: 'connectivity_issue' })
ev(41, `${HUE}:contact-door`, 'contact', 'Opened', { contact_report: { state: 'no_contact' } })
ev(41.2, `${HUE}:motion-hall`, 'motion', 'Motion detected', { motion: { motion: true } })
ev(41.1, `${HUE}:hall`, 'light', 'Turned on, brightness 100%', { on: { on: true }, dimming: { brightness: 100 } })
ev(40.5, `${HUE}:contact-door`, 'contact', 'Closed', { contact_report: { state: 'contact' } })
ev(33, `${HUE}:hall`, 'light', 'Turned off', { on: { on: false } })
ev(27, `${HUE}:dimmer-lr`, 'button', 'Button 1: short release', { button: { button_report: { event: 'short_release' } } })
ev(26.9, `${HUE}:sofa`, 'light', 'Turned on, brightness 62%, color changed', { on: { on: true }, dimming: { brightness: 62 } })
ev(26.9, `${HUE}:ceiling-lr`, 'light', 'Turned on, brightness 45%, white 2703 K', { on: { on: true }, dimming: { brightness: 45 } })
ev(26.8, `${HUE}:tv-strip`, 'light', 'Turned on, brightness 70%, color changed', { on: { on: true }, dimming: { brightness: 70 } })
ev(19, `${HUE}:motion-garden`, 'device_power', 'Battery 12% (critical)', { power_state: { battery_level: 12, battery_state: 'critical' } })
ev(14, `${IKEA}:ikea-kids`, 'light', 'Turned on, brightness 15%', { on: { on: true }, dimming: { brightness: 15 } }, { origin: 'hubwatch' })
ev(9, `${HUE}:motion-kitchen`, 'motion', 'Motion detected', { motion: { motion: true } })
ev(8.9, `${HUE}:island`, 'light', 'Turned on, brightness 75%, white 3571 K', { on: { on: true }, dimming: { brightness: 75 } })
ev(4, `${HUE}:motion-kitchen`, 'light_level', 'Light level 180 lx', { light: { light_level: 180 } })
ev(2, `${HUE}:motion-kitchen`, 'temperature', 'Temperature 22.1 °C', { temperature: { temperature: 22.1 } })
ev(0.5, `${HUE}:desk`, 'light', 'Brightness 85%', { dimming: { brightness: 85 } })
// Picked up at startup: what sensors reported while HubWatch was closed.
ev(9 * 60 - 0.2, `${HUE}:motion-hall`, 'motion', 'Motion detected', { motion: { motion: true } }, { eventType: 'backfill' })
ev(9 * 60 - 0.3, `${HUE}:dimmer-lr`, 'button', 'Button 4: long press', { button: {} }, { eventType: 'backfill' })

events.sort((a, b) => a.ts - b.ts)
events.forEach((e, i) => (e.id = i + 1))
let lastId = events.length

// ----- groups -----

const lightOf = (d) => ({
  id: d.services.light, deviceId: d.id, name: d.name, on: d.on, brightness: d.brightness,
  color: { ...d.color, brightness: d.brightness }, connectivity: d.connectivity,
})
const scene = (id, name, palette, active, lastRecallMin) => ({
  id, name, smart: false, active, lastRecall: lastRecallMin === null ? null : NOW - lastRecallMin * MIN,
  speed: active === 'dynamic_palette' ? 0.6 : null, autoDynamic: false, palette,
})
const SCENES = {
  'Living room': [
    scene('s1', 'Sunset', [xy(0.55, 0.38), xy(0.6, 0.35), xy(0.5, 0.41), xy(0.45, 0.4)], 'static', 27),
    scene('s2', 'Movie night', [xy(0.17, 0.2), xy(0.25, 0.1), xy(0.55, 0.38)], 'inactive', 2 * 24 * 60),
    scene('s3', 'Read', [warm(233), warm(233)], 'inactive', 3 * 24 * 60 + 300),
    scene('s4', 'Northern lights', [xy(0.17, 0.6), xy(0.15, 0.25), xy(0.3, 0.15), xy(0.2, 0.45)], 'inactive', 9 * 24 * 60),
  ],
  Kitchen: [
    scene('s5', 'Concentrate', [warm(233), warm(233)], 'static', 9),
    scene('s6', 'Dinner', [warm(400), warm(450), xy(0.52, 0.41)], 'inactive', 24 * 60 - 60),
  ],
  Bedroom: [
    scene('s7', 'Nightlight', [xy(0.56, 0.4, 5)], 'inactive', 13 * 60),
    scene('s8', 'Relax', [warm(447), warm(447)], 'inactive', 14 * 60),
  ],
  Office: [
    scene('s9', 'Energize', [warm(156), warm(156)], 'inactive', 5 * 60),
    scene('s10', 'Twilight', [xy(0.3, 0.15), xy(0.22, 0.3), warm(233)], 'static', 3 * 60),
  ],
  'Kids room': [scene('s11', 'Unicorn', [xy(0.4, 0.2), xy(0.3, 0.3), xy(0.5, 0.25)], 'static', 14)],
}

function groups() {
  const rooms = new Map()
  for (const d of devices) {
    const key = `${d.systemId}|${d.room}`
    if (!rooms.has(key)) rooms.set(key, { systemId: d.systemId, room: d.room, list: [] })
    rooms.get(key).list.push(d)
  }
  const result = [...rooms.values()].map(({ systemId, room, list }) => {
    const ls = list.filter((d) => d.services.light)
    const lit = ls.filter((d) => d.on)
    return {
      systemId, id: `room-${room}`, kind: 'room', name: room, archetype: null,
      on: ls.length ? lit.length > 0 : null,
      brightness: lit.length ? lit.reduce((a, d) => a + d.brightness, 0) / lit.length : null,
      lights: ls.map(lightOf),
      otherDevices: list.filter((d) => !d.services.light).map((d) => ({ id: d.id, name: d.name, product: d.product })),
      scenes: SCENES[room] ?? [],
    }
  })
  const downstairs = devices.filter((d) => ['sofa', 'ceiling-lr', 'kitchen-1', 'kitchen-2', 'island', 'hall'].includes(d.id))
  result.push({
    systemId: HUE, id: 'zone-downstairs', kind: 'zone', name: 'Downstairs', archetype: null, on: true, brightness: 70,
    lights: downstairs.map(lightOf), otherDevices: [], scenes: [],
  })
  return result
}

// ----- readings, stats, automations, alerts -----

function readings(resource, kind, hours) {
  const d = devices.find((x) => Object.values(x.services).includes(resource))
  if (!d) return []
  const out = []
  const step = hours > 48 ? 60 * MIN : 15 * MIN
  for (let t = NOW - hours * HOUR; t <= NOW; t += step) {
    if (!recording(d.systemId, t)) continue
    const value =
      kind === 'temperature' ? Math.round(tempAt(d, t) * 10) / 10
      : kind === 'lux' ? luxAt(d, t)
      : Math.max(1, Math.round((d.battery ?? 50) + ((NOW - t) / DAY) * 0.15))
    out.push({ ts: t, value })
  }
  return out
}

function stats(days) {
  const from = NOW - days * DAY
  const dayList = []
  for (let i = days - 1; i >= 0; i--) dayList.push(new Date(NOW - i * DAY).toISOString().slice(0, 10))
  const inRange = events.filter((e) => e.ts >= from && e.eventType !== 'backfill')
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0))
  const motionCount = new Map()
  for (const e of inRange) {
    if (e.resourceType !== 'motion' || !e.summary.startsWith('Motion detected')) continue
    const dt = new Date(e.ts)
    heat[(dt.getDay() + 6) % 7][dt.getHours()]++
    motionCount.set(e.deviceId, (motionCount.get(e.deviceId) ?? 0) + 1)
  }
  const lightStats = lights
    .map((l, i) => {
      const usage = [0.9, 0.5, 0.75, 0.2, 0.6, 0.6, 0.45, 0.15, 0.15, 0.3, 0.85, 0.4, 0.1, 0.25, 0.2, 0.95][i] ?? 0.3
      const perDayMs = dayList.map(() => Math.round(usage * (2 + rnd() * 6) * HOUR))
      return {
        systemId: l.systemId, id: l.services.light, deviceId: l.id, name: l.name, room: l.room,
        onMs: perDayMs.reduce((a, b) => a + b, 0),
        switchOns: inRange.filter((e) => e.deviceId === l.id && e.summary.startsWith('Turned on')).length,
        perDayMs,
      }
    })
    .sort((a, b) => b.onMs - a.onMs)
  const activity = new Map()
  for (const e of inRange) {
    const k = `${e.systemId}|${e.resourceId}`
    const a = activity.get(k) ?? { systemId: e.systemId, resourceId: e.resourceId, deviceId: e.deviceId, name: e.name, room: e.room, resourceType: e.resourceType, count: 0 }
    a.count++
    activity.set(k, a)
  }
  return {
    from, to: NOW, days: dayList,
    coverage: [
      { systemId: HUE, recordedMs: Math.round(days * DAY * 0.93) },
      { systemId: IKEA, recordedMs: Math.round(Math.min(days, 12) * DAY * 0.95) },
    ],
    lights: lightStats,
    motionByWeekdayHour: heat,
    motionTotal: [...motionCount.values()].reduce((a, b) => a + b, 0),
    motionSensors: motionSensors
      .map((d) => ({ systemId: d.systemId, id: d.services.motion, deviceId: d.id, name: d.name, room: d.room, count: motionCount.get(d.id) ?? 0 }))
      .sort((a, b) => b.count - a.count),
    mostActive: [...activity.values()].sort((a, b) => b.count - a.count).slice(0, 10),
  }
}

const automation = (id, name, script, category, when, startMinute, targets, enabled = true) => ({
  systemId: HUE, id, name, enabled, script, scriptDescription: null, category, status: enabled ? 'running' : 'disabled',
  lastError: null, when, startMinute, targets: targets.map((t) => ({ id: `room-${t}`, type: 'room', name: t })), configuration: '{}',
})
const automations = [
  automation('a1', 'Wake up gently', 'Wake up', 'automation', '06:30 · Mon–Fri', 390, ['Bedroom']),
  automation('a2', 'Weekend wake-up', 'Wake up', 'automation', '08:30 · Sat, Sun', 510, ['Bedroom']),
  automation('a3', 'Porch on at sunset', 'Timers', 'automation', 'Sunset · Every day', null, ['Garden']),
  automation('a4', 'Go to sleep', 'Go to sleep', 'automation', '22:45 · Every day', 1365, ['Bedroom', 'Living room']),
  automation('a5', 'Coming home', 'Coming home', 'automation', null, null, ['Hallway', 'Living room']),
  automation('a6', 'Hallway motion', 'Motion Sensor', 'accessory', null, null, ['Hallway']),
  automation('a7', 'Kitchen motion', 'Motion Sensor', 'accessory', null, null, ['Kitchen']),
  automation('a8', 'Christmas lights', 'Timers', 'automation', '16:00 · Every day', 960, ['Living room'], false),
]

const rules = {
  rules: [
    {
      systemId: HUE, id: '12', name: 'Hallway night dim', status: 'enabled', lastTriggered: NOW - 41 * MIN, timesTriggered: 318,
      conditions: [
        { address: '/sensors/5/state/presence', target: 'Hallway sensor', attribute: 'presence', operator: 'eq', value: 'true' },
        { address: '/config/localtime', target: null, attribute: 'localtime', operator: 'in', value: 'T23:00:00/T06:00:00' },
      ],
      actions: [{ address: '/groups/4/action', target: 'Hallway', method: 'PUT', body: '{"on":true,"bri":30}' }],
    },
    {
      systemId: HUE, id: '13', name: 'Dimmer off', status: 'enabled', lastTriggered: NOW - 14 * HOUR, timesTriggered: 92,
      conditions: [{ address: '/sensors/9/state/buttonevent', target: 'Living room dimmer', attribute: 'buttonevent', operator: 'eq', value: '4002' }],
      actions: [{ address: '/groups/1/action', target: 'Living room', method: 'PUT', body: '{"on":false}' }],
    },
  ],
  schedules: [
    { systemId: HUE, id: '3', name: 'Garden off', description: null, status: 'enabled', when: '01:00 · Every day', command: { address: '/groups/7/action', target: 'Garden', method: 'PUT', body: '{"on":false}' } },
  ],
  errors: [],
}

const alerts = [
  { id: 3, systemId: HUE, openedAt: NOW - 19 * MIN, resolvedAt: null, acknowledged: false, kind: 'low_battery', key: 'motion-garden', severity: 'critical', title: 'Garden sensor: battery 12%', message: 'Replace the batteries soon.' },
  { id: 2, systemId: HUE, openedAt: NOW - 58 * MIN, resolvedAt: null, acknowledged: false, kind: 'device_unreachable', key: 'porch', severity: 'warning', title: 'Porch is unreachable', message: 'The light has not answered for 58 minutes.' },
  { id: 1, systemId: IKEA, openedAt: NOW - 3 * DAY, resolvedAt: NOW - 3 * DAY + 20 * MIN, acknowledged: true, kind: 'system_unreachable', key: 'hub', severity: 'warning', title: 'DIRIGERA was unreachable', message: 'Back after 20 minutes.' },
]

const status = {
  version: '0.4.0',
  systems: [
    { id: HUE, kind: 'hue', name: 'Hue Bridge', address: '192.168.1.20', nativeId: '001788FFFE6A1B2C', state: 'connected', message: null, connectedSince: NOW - 9 * HOUR, lastEventAt: NOW - 30_000, certificatePinned: true, problem: null, resourcesAsOf: null },
    { id: IKEA, kind: 'ikea', name: 'DIRIGERA', address: '192.168.1.31', nativeId: '7f3a', state: 'connected', message: null, connectedSince: NOW - 9 * HOUR, lastEventAt: NOW - 14 * MIN, certificatePinned: true, problem: null, resourcesAsOf: null },
  ],
}

// ----- live feed -----

const LIVE_INTERVAL_MS = Number(process.env.LIVE_INTERVAL_MS ?? 2500)
const LIVE = [
  [`${HUE}:motion-hall`, 'motion', 'Motion detected', { motion: { motion: true } }],
  [`${HUE}:hall`, 'light', 'Turned on, brightness 100%', { on: { on: true }, dimming: { brightness: 100 } }],
  [`${HUE}:contact-door`, 'contact', 'Opened', { contact_report: { state: 'no_contact' } }],
  [`${HUE}:contact-door`, 'contact', 'Closed', { contact_report: { state: 'contact' } }],
  [`${HUE}:tap-bed`, 'button', 'Button 1: short release', { button: { button_report: { event: 'short_release' } } }],
  [`${HUE}:bed-left`, 'light', 'Turned on, brightness 40%, color changed', { on: { on: true }, dimming: { brightness: 40 } }],
  [`${IKEA}:ikea-motion-bath`, 'motion', 'Motion detected', { motion: { motion: true } }],
  [`${IKEA}:ikea-bath`, 'light', 'Turned on, brightness 80%, white 3333 K', { on: { on: true }, dimming: { brightness: 80 } }],
]

// ----- HTTP -----

const publicEvent = ({ deviceId, ...e }) => e
const strip = ({ color, ...d }) => d

function api(url, res) {
  const q = url.searchParams
  const p = url.pathname
  const json = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (p === '/api/status') return json(status)
  if (p === '/api/devices') return json(devices.map(strip))
  if (p === '/api/groups') return json(groups())
  if (p === '/api/sessions') return json(sessions)
  if (p === '/api/alerts') return json(alerts)
  if (p === '/api/automations') return json(automations)
  if (p === '/api/rules') return json(rules)
  if (p === '/api/stats') return json(stats(Number(q.get('days') ?? 7)))
  if (p === '/api/readings') return json(readings(q.get('resource'), q.get('kind'), Number(q.get('hours') ?? 24)))
  if (p === '/api/settings/alerts')
    return json({ lowBatteryEnabled: true, lowBatteryPercent: 20, deviceUnreachableEnabled: true, deviceUnreachableMinutes: 10, systemUnreachableEnabled: true, systemUnreachableMinutes: 5, ntfyUrl: null })
  const one = p.match(/^\/api\/events\/(\d+)$/)
  if (one) return json(publicEvent(events.find((e) => e.id === Number(one[1]))))
  if (p === '/api/events') {
    const beforeTs = q.get('beforeTs') ? Number(q.get('beforeTs')) : Infinity
    const beforeId = q.get('beforeId') ? Number(q.get('beforeId')) : Infinity
    const type = q.get('type')
    const dev = q.get('device')
    const limit = Number(q.get('limit') ?? 200)
    const out = []
    for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
      const e = events[i]
      if (e.ts > beforeTs || (e.ts === beforeTs && e.id >= beforeId)) continue
      if (type && e.resourceType !== type) continue
      if (dev && e.deviceId !== dev) continue
      out.push(publicEvent(e))
    }
    return json(out)
  }
  if (p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`)
    const timer = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 10_000)
    // A short scripted stream of new events, so recordings show the log updating live.
    let step = 0
    const feed = setInterval(() => {
      const item = LIVE[step++ % LIVE.length]
      const d = byId.get(item[0])
      const before = events.length
      addEvent(d, Date.now(), item[1], item[2], item[3] ?? {})
      const added = events.slice(before)
      added.forEach((e) => (e.id = ++lastId))
      res.write(`event: events\ndata: ${JSON.stringify(added.map(publicEvent))}\n\n`)
    }, LIVE_INTERVAL_MS)
    res.on('close', () => {
      clearInterval(timer)
      clearInterval(feed)
    })
    return
  }
  res.writeHead(204)
  res.end()
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname.startsWith('/api/')) return api(url, res)
    let file = path.join(root, decodeURIComponent(url.pathname))
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  .listen(port, () => console.log(`Demo HubWatch on http://localhost:${port} (frontend from ${root})`))
