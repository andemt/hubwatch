/** offline: gave up reconnecting; it waits until the user asks to try again. */
export type SystemState = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error'

/** One connected system (today: a Philips Hue bridge). Every data item carries the id of its system. */
export interface SystemStatus {
  /** Stable id, e.g. "hue-ecb5fafffeb1b99d" */
  id: string
  /** Which kind of system, e.g. "hue" */
  kind: string
  name: string | null
  address: string
  /** The system's own id (for Hue: the bridge id) */
  nativeId: string | null
  state: SystemState
  message: string | null
  connectedSince: number | null
  lastEventAt: number | null
  /** Whether HubWatch has pinned the system's TLS certificate (done automatically on the first connection) */
  certificatePinned: boolean
  /** Machine-readable reason for the "error" state, e.g. "certificate_changed" */
  problem: string | null
  /** While not connected: when its devices, rooms and automations were last seen live (they are the last known state). */
  resourcesAsOf: number | null
}

export interface Status {
  version: string
  systems: SystemStatus[]
}

export interface SystemEvent {
  id: number
  systemId: string
  ts: number
  /** update | add | delete | error | backfill */
  eventType: string
  resourceId: string
  resourceType: string
  name: string | null
  room: string | null
  summary: string
  /** The system's own JSON for the event */
  data: string
  /** Who caused the change when HubWatch knows: "hubwatch" when it was switched from this app; otherwise null. */
  origin: 'hubwatch' | null
}

/** Something that can be switched on or off: a light, a device with a light, a room or a zone. */
export interface PowerTarget {
  systemId: string
  id: string
}

export interface Session {
  id: number
  systemId: string
  startedAt: number
  lastSeenAt: number
  endedAt: number | null
}

/** Identifies a device: ids are only unique within one system. */
export interface DeviceRef {
  systemId: string
  id: string
}

export interface Device {
  systemId: string
  id: string
  name: string
  room: string | null
  archetype: string | null
  product: string | null
  model: string | null
  firmware: string | null
  battery: number | null
  batteryState: string | null
  connectivity: string | null
  on: boolean | null
  brightness: number | null
  motion: boolean | null
  motionChangedAt: number | null
  temperature: number | null
  lux: number | null
  contact: string | null
  /** no_update | update_pending | ready_to_install | installing | ... */
  softwareUpdate: string | null
  kinds: string[]
  services: DeviceServiceIds
}

export interface DeviceServiceIds {
  light: string | null
  motion: string | null
  temperature: string | null
  lightLevel: string | null
  power: string | null
  connectivity: string | null
  contact: string | null
}

export type ReadingKind = 'temperature' | 'lux' | 'battery'

export interface Reading {
  ts: number
  value: number
}

export interface DiscoveredBridge {
  ip: string
  id: string | null
  name: string | null
  model: string | null
}

export interface PairResponse {
  paired: boolean
  reason?: string
  systemId?: string
  name?: string
  /** The bridge was already paired; only its IP address was updated (no new application key). */
  alreadyPaired?: boolean
}

export interface LightColor {
  x: number | null
  y: number | null
  mirek: number | null
  brightness: number | null
}

export interface GroupDevice {
  id: string
  name: string
  product: string | null
}

export interface GroupLight {
  id: string
  deviceId: string | null
  name: string
  on: boolean | null
  brightness: number | null
  color: LightColor | null
  connectivity: string | null
}

export interface Scene {
  id: string
  name: string
  smart: boolean
  /** static | dynamic_palette | inactive (scenes); active | inactive (smart scenes) */
  active: string | null
  lastRecall: number | null
  speed: number | null
  autoDynamic: boolean | null
  palette: LightColor[]
}

export interface Group {
  systemId: string
  id: string
  kind: 'room' | 'zone'
  name: string
  archetype: string | null
  on: boolean | null
  brightness: number | null
  lights: GroupLight[]
  /** Devices in the room that are not lights (sensors, switches, …) */
  otherDevices: GroupDevice[]
  scenes: Scene[]
}

export interface NamedRef {
  id: string
  type: string
  name: string | null
}

export interface Automation {
  systemId: string
  id: string
  name: string
  enabled: boolean
  script: string | null
  scriptDescription: string | null
  category: string | null
  status: string | null
  lastError: string | null
  when: string | null
  /** Start time as minutes after local midnight, when it is a fixed clock time */
  startMinute: number | null
  targets: NamedRef[]
  configuration: string
}

export interface RuleCondition {
  address: string
  target: string | null
  attribute: string
  operator: string
  value: string | null
}

export interface RuleAction {
  address: string
  target: string | null
  method: string
  body: string
}

export interface Rule {
  systemId: string
  /** Only unique within its system */
  id: string
  name: string
  status: string | null
  lastTriggered: number | null
  timesTriggered: number
  conditions: RuleCondition[]
  actions: RuleAction[]
}

export interface Schedule {
  systemId: string
  /** Only unique within its system */
  id: string
  name: string
  description: string | null
  status: string | null
  when: string | null
  command: RuleAction | null
}

export interface RulesResponse {
  rules: Rule[]
  schedules: Schedule[]
  /** Systems whose rules could not be read */
  errors: string[]
}

export interface LightStat {
  systemId: string
  id: string
  deviceId: string | null
  name: string
  room: string | null
  onMs: number
  switchOns: number
  perDayMs: number[]
}

export interface ActivityStat {
  systemId: string
  resourceId: string
  deviceId: string | null
  name: string
  room: string | null
  resourceType: string
  count: number
}

export interface MotionSensorStat {
  systemId: string
  id: string
  deviceId: string | null
  name: string
  room: string | null
  count: number
}

export interface Stats {
  from: number
  to: number
  /** yyyy-MM-dd, oldest first */
  days: string[]
  /** How much of the period each system was actually recorded */
  coverage: { systemId: string; recordedMs: number }[]
  lights: LightStat[]
  /** [weekday 0 = Monday][hour 0-23] */
  motionByWeekdayHour: number[][]
  motionTotal: number
  motionSensors: MotionSensorStat[]
  mostActive: ActivityStat[]
}

export interface Alert {
  id: number
  systemId: string
  openedAt: number
  resolvedAt: number | null
  acknowledged: boolean
  kind: string
  key: string
  severity: 'warning' | 'critical'
  title: string
  message: string
}

export interface AlertSettings {
  lowBatteryEnabled: boolean
  lowBatteryPercent: number
  deviceUnreachableEnabled: boolean
  deviceUnreachableMinutes: number
  systemUnreachableEnabled: boolean
  systemUnreachableMinutes: number
  ntfyUrl: string | null
}
