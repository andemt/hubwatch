import type {
  Alert,
  AlertSettings,
  Automation,
  Device,
  DiscoveredBridge,
  Group,
  SystemEvent,
  PairResponse,
  Reading,
  ReadingKind,
  RulesResponse,
  Session,
  Stats,
  Status,
} from './types'
import { systemsParam } from './systemFilter'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    let message = response.statusText
    try {
      const problem = await response.json()
      message = problem.detail ?? problem.title ?? message
    } catch {
      /* not JSON */
    }
    throw new Error(message)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function query(params: Record<string, string | number | undefined | null>) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const api = {
  status: () => request<Status>('/api/status'),
  discoverHue: () => request<DiscoveredBridge[]>('/api/hue/discover'),
  /** Adds a Hue bridge. Poll while the user presses the link button: paired stays false until then. */
  pairHue: (ip: string) => request<PairResponse>('/api/hue/pair', { method: 'POST', body: JSON.stringify({ ip }) }),
  /**
   * Adds an IKEA DIRIGERA hub. Call with start = true first (the hub hands out a pairing code), then poll while the
   * user presses the action button on the hub: paired stays false until then.
   */
  pairIkea: (ip: string, start = false) =>
    request<PairResponse>('/api/ikea/pair', { method: 'POST', body: JSON.stringify({ ip, start }) }),
  /** Disconnects a system; its history is kept unless deleteData. */
  removeSystem: (id: string, deleteData = false) =>
    request<void>(`/api/systems/${encodeURIComponent(id)}${query({ deleteData: deleteData ? 'true' : undefined })}`, {
      method: 'DELETE',
    }),
  /** Starts connecting again to a system that gave up (state "offline"). */
  reconnect: (id: string) => request<void>(`/api/systems/${encodeURIComponent(id)}/reconnect`, { method: 'POST' }),
  /** Stops trying to connect to a system (state "connecting" or "reconnecting"); it goes "offline". */
  stopConnecting: (id: string) => request<void>(`/api/systems/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  /** Trusts the new certificate a system presented (problem "certificate_changed"). */
  trustCertificate: (id: string) =>
    request<void>(`/api/systems/${encodeURIComponent(id)}/trust-certificate`, { method: 'POST' }),
  // Data requests only return the systems shown in the UI (see systemFilter.ts).
  events: (
    params: { beforeTs?: number; beforeId?: number; limit?: number; type?: string; device?: string; systems?: string } = {},
  ) =>
    request<SystemEvent[]>(`/api/events${query({ ...params, systems: params.systems ?? systemsParam() })}`),
  /** One event by id; fails (404) when it doesn't exist or its system is hidden. */
  event: (id: number) => request<SystemEvent>(`/api/events/${id}${query({ systems: systemsParam() })}`),
  sessions: (from?: number) => request<Session[]>(`/api/sessions${query({ from, systems: systemsParam() })}`),
  devices: () => request<Device[]>(`/api/devices${query({ systems: systemsParam() })}`),
  groups: () => request<Group[]>(`/api/groups${query({ systems: systemsParam() })}`),
  stats: (days: number) => request<Stats>(`/api/stats${query({ days, systems: systemsParam() })}`),
  alerts: () => request<Alert[]>(`/api/alerts${query({ systems: systemsParam() })}`),
  ackAlert: (id: number) => request<void>(`/api/alerts/${id}/ack`, { method: 'POST' }),
  ackAllAlerts: () => request<void>(`/api/alerts/ack-all${query({ systems: systemsParam() })}`, { method: 'POST' }),
  alertSettings: () => request<AlertSettings>('/api/settings/alerts'),
  saveAlertSettings: (settings: AlertSettings) =>
    request<AlertSettings>('/api/settings/alerts', { method: 'PUT', body: JSON.stringify(settings) }),
  testNtfy: (url: string) => request<void>(`/api/settings/alerts/test-ntfy${query({ url })}`, { method: 'POST' }),
  automations: () => request<Automation[]>(`/api/automations${query({ systems: systemsParam() })}`),
  rules: () => request<RulesResponse>(`/api/rules${query({ systems: systemsParam() })}`),
  /** Switches a light, a device's light, a room or a zone. The change shows up as an event with origin "hubwatch". */
  setPower: (systemId: string, target: string, on: boolean) =>
    request<void>(`/api/systems/${encodeURIComponent(systemId)}/power`, {
      method: 'POST',
      body: JSON.stringify({ target, on }),
    }),
  readings: (resource: string, kind: ReadingKind, hours: number) =>
    request<Reading[]>(`/api/readings${query({ resource, kind, hours, systems: systemsParam() })}`),
}
