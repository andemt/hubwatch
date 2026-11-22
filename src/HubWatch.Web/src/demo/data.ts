/**
 * The made-up homes the demo shows. Values are static (a battery stays at its level); only on/off and motion
 * change, so the live log has something to show.
 */

export interface DemoLight {
  id: string
  on: boolean
  brightness: number
  mirek: number | null
  xy: [number, number] | null
}

export interface DemoDevice {
  id: string
  name: string
  /** Key of the room it is in */
  room: string
  product: string
  model: string
  firmware: string
  archetype: string | null
  battery: number | null
  /** Never changes: a disconnected device stays disconnected */
  connectivity: 'connected' | 'disconnected'
  connectivityId: string | null
  powerId: string | null
  softwareUpdate: string | null
  light?: DemoLight
  motion?: { id: string; motion: boolean; changedAt: number | null; /** device id of a light it switches */ turnsOn?: string }
  temperature?: { id: string; value: number }
  lightLevel?: { id: string; lux: number }
  button?: { id: string; /** device id of the light it toggles */ toggles?: string }
}

export interface DemoRoom {
  key: string
  id: string
  name: string
  archetype: string
}

export interface DemoScene {
  id: string
  name: string
  palette: { x: number | null; y: number | null; mirek: number | null; brightness: number | null }[]
}

export interface DemoAutomation {
  id: string
  name: string
  script: string
  scriptDescription: string
  when: string | null
  startMinute: number | null
  rooms: string[]
}

export interface DemoHome {
  kind: 'hue' | 'dirigera'
  nativeId: string
  name: string
  rooms: DemoRoom[]
  devices: DemoDevice[]
  scenes: Record<string, DemoScene[]>
  automations: DemoAutomation[]
}

/** A stable, uuid-shaped id made from a name, so ids look real and stay the same between reloads. */
export function uuid(seed: string): string {
  let out = ''
  for (let round = 0; out.length < 32; round++) {
    let h = (0x811c9dc5 ^ Math.imul(round + 1, 0x9e3779b1)) >>> 0
    for (const ch of seed) {
      h ^= ch.charCodeAt(0)
      h = Math.imul(h, 16777619) >>> 0
    }
    out += h.toString(16).padStart(8, '0')
  }
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-8${out.slice(17, 20)}-${out.slice(20, 32)}`
}

interface DeviceSpec {
  key: string
  name: string
  room: string
  product: string
  model: string
  firmware: string
  archetype?: string
  battery?: number
  disconnected?: boolean
  zigbee?: boolean
  softwareUpdate?: string
  light?: { on: boolean; brightness: number; mirek?: number; xy?: [number, number] }
  motion?: { turnsOn?: string }
  temperature?: number
  lux?: number
  button?: { toggles?: string }
}

function build(prefix: string, specs: DeviceSpec[]): DemoDevice[] {
  const deviceId = (key: string) => uuid(`${prefix}/device/${key}`)
  const service = (key: string, type: string) => uuid(`${prefix}/${type}/${key}`)
  return specs.map((s) => ({
    id: deviceId(s.key),
    name: s.name,
    room: s.room,
    product: s.product,
    model: s.model,
    firmware: s.firmware,
    archetype: s.archetype ?? null,
    battery: s.battery ?? null,
    connectivity: s.disconnected ? 'disconnected' : 'connected',
    connectivityId: s.zigbee === false ? null : service(s.key, 'zigbee_connectivity'),
    powerId: s.battery !== undefined ? service(s.key, 'device_power') : null,
    softwareUpdate: s.softwareUpdate ?? 'no_update',
    light: s.light && {
      id: service(s.key, 'light'),
      on: s.light.on,
      brightness: s.light.brightness,
      mirek: s.light.mirek ?? null,
      xy: s.light.xy ?? null,
    },
    motion: s.motion && {
      id: service(s.key, 'motion'),
      motion: false,
      changedAt: null,
      turnsOn: s.motion.turnsOn && deviceId(s.motion.turnsOn),
    },
    temperature: s.temperature !== undefined ? { id: service(s.key, 'temperature'), value: s.temperature } : undefined,
    lightLevel: s.lux !== undefined ? { id: service(s.key, 'light_level'), lux: s.lux } : undefined,
    button: s.button && { id: service(s.key, 'button'), toggles: s.button.toggles && deviceId(s.button.toggles) },
  }))
}

function rooms(prefix: string, list: [key: string, name: string, archetype: string][]): DemoRoom[] {
  return list.map(([key, name, archetype]) => ({ key, id: uuid(`${prefix}/room/${key}`), name, archetype }))
}

const white = (mirek: number) => ({ x: null, y: null, mirek, brightness: 80 })
const color = (x: number, y: number, brightness = 80) => ({ x, y, mirek: null, brightness })

export const HUE_NATIVE_ID = '001788fffe4a1b2c'
export const HUE_ADDRESS = '192.168.1.20'

export function createHueHome(): DemoHome {
  const p = 'demo-hue'
  const scene = (room: string, name: string, palette: DemoScene['palette']): DemoScene => ({
    id: uuid(`${p}/scene/${room}/${name}`),
    name,
    palette,
  })
  return {
    kind: 'hue',
    nativeId: HUE_NATIVE_ID,
    name: 'Hue Bridge',
    rooms: rooms(p, [
      ['living', 'Living room', 'living_room'],
      ['kitchen', 'Kitchen', 'kitchen'],
      ['bedroom', 'Bedroom', 'bedroom'],
      ['hallway', 'Hallway', 'hallway'],
    ]),
    devices: build(p, [
      { key: 'sofa', name: 'Sofa lamp', room: 'living', product: 'Hue color lamp', model: 'LCA001', firmware: '1.116.3', archetype: 'sultan_bulb', light: { on: true, brightness: 70, xy: [0.4573, 0.41] } },
      { key: 'ceiling', name: 'Ceiling light', room: 'living', product: 'Hue white ambiance', model: 'LTA001', firmware: '1.116.3', archetype: 'classic_bulb', light: { on: false, brightness: 100, mirek: 366 } },
      { key: 'dimmer', name: 'Living room dimmer', room: 'living', product: 'Hue dimmer switch', model: 'RWL022', firmware: '2.45.2', battery: 85, softwareUpdate: 'update_pending', button: { toggles: 'ceiling' } },
      { key: 'spots', name: 'Kitchen spots', room: 'kitchen', product: 'Hue white ambiance GU10', model: 'LTG002', firmware: '1.116.3', archetype: 'spot_bulb', light: { on: true, brightness: 100, mirek: 233 } },
      { key: 'kitchen-sensor', name: 'Kitchen sensor', room: 'kitchen', product: 'Hue motion sensor', model: 'SML001', firmware: '2.53.6', battery: 64, motion: {}, temperature: 21.4, lux: 180 },
      { key: 'bedside', name: 'Bedside lamp', room: 'bedroom', product: 'Hue Go', model: 'LLC020', firmware: '1.116.3', archetype: 'hue_go', light: { on: false, brightness: 40, xy: [0.5, 0.4] } },
      { key: 'bedroom-ceiling', name: 'Bedroom ceiling', room: 'bedroom', product: 'Hue white', model: 'LWA001', firmware: '1.108.7', archetype: 'classic_bulb', disconnected: true, light: { on: true, brightness: 100, mirek: 370 } },
      { key: 'hall-light', name: 'Hallway light', room: 'hallway', product: 'Hue white ambiance', model: 'LTA001', firmware: '1.116.3', archetype: 'classic_bulb', light: { on: false, brightness: 80, mirek: 300 } },
      { key: 'hall-sensor', name: 'Hallway sensor', room: 'hallway', product: 'Hue motion sensor', model: 'SML002', firmware: '2.53.6', battery: 12, motion: { turnsOn: 'hall-light' }, temperature: 19.2, lux: 24 },
    ]),
    scenes: {
      living: [
        scene('living', 'Relax', [white(447)]),
        scene('living', 'Savanna sunset', [color(0.5267, 0.4133), color(0.6, 0.38), color(0.45, 0.47)]),
      ],
      kitchen: [scene('kitchen', 'Concentrate', [white(233)]), scene('kitchen', 'Bright', [white(366)])],
      bedroom: [scene('bedroom', 'Nightlight', [color(0.561, 0.4042, 1)]), scene('bedroom', 'Read', [white(346)])],
      hallway: [scene('hallway', 'Dimmed', [white(366)])],
    },
    automations: [
      { id: uuid(`${p}/automation/hall-motion`), name: 'Hallway motion', script: 'Motion Sensor', scriptDescription: 'Turns lights on when motion is detected', when: null, startMinute: null, rooms: ['hallway'] },
      { id: uuid(`${p}/automation/wake-up`), name: 'Wake up', script: 'Wake up', scriptDescription: 'Slowly brightens the lights', when: 'Weekdays 07:00', startMinute: 420, rooms: ['bedroom'] },
      { id: uuid(`${p}/automation/night`), name: 'Lights off at night', script: 'Timer', scriptDescription: 'Turns lights off at a set time', when: 'Every day 23:30', startMinute: 1410, rooms: ['living', 'kitchen'] },
    ],
  }
}

export const IKEA_NATIVE_ID = '7c3f2a91-5d0e-4b8a-9e61-2f4d8c1b0a57_1'

export function createIkeaHome(): DemoHome {
  const p = 'demo-ikea'
  return {
    kind: 'dirigera',
    nativeId: IKEA_NATIVE_ID,
    name: 'DIRIGERA hub',
    rooms: rooms(p, [
      ['office', 'Office', 'office'],
      ['balcony', 'Balcony', 'balcony'],
    ]),
    devices: build(p, [
      { key: 'desk', name: 'Desk lamp', room: 'office', product: 'TRÅDFRI bulb E27 WS 806lm', model: 'LED2201G8', firmware: '1.0.21', light: { on: false, brightness: 80, mirek: 370 } },
      { key: 'office-sensor', name: 'Office sensor', room: 'office', product: 'VALLHORN wireless motion sensor', model: 'E2134', firmware: '1.0.64', battery: 90, motion: { turnsOn: 'desk' }, lux: 95 },
      { key: 'outlet', name: 'Balcony lights', room: 'balcony', product: 'TRETAKT smart plug', model: 'E2204', firmware: '2.3.087', light: { on: true, brightness: 100 } },
    ]),
    scenes: {},
    automations: [],
  }
}
