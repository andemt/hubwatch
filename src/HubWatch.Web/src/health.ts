import { useCallback } from 'react'
import { Json } from './json'
import { formatDateTime } from './format'
import { systemLabel, useSystems } from './systems'

export const LOW_BATTERY = 20

/**
 * When the bridge cannot reliably reach a device, the state it reports is only the last one it heard.
 * Returns true when that is the case, so the UI can show the state as "last known".
 */
export const isStale = (connectivity: string | null) => connectivity !== null && connectivity !== 'connected'

export const STALE_HINT =
  "The bridge can't reliably reach this device, so this is the last state it heard. The real state may differ."

/**
 * Like isStale, but also covers the whole system not being connected (then everything it shows is the last
 * known state). Returns the hint to show, or null when the state is live.
 */
export function useStaleHint() {
  const systems = useSystems()
  return useCallback(
    (systemId: string, connectivity: string | null): string | null => {
      const system = systems.find((s) => s.id === systemId)
      if (system && system.state !== 'connected')
        return (
          `${systemLabel(system)} is not connected, so this is the last state HubWatch saw` +
          `${system.resourcesAsOf ? ` (${formatDateTime(system.resourcesAsOf)})` : ''}. The real state may differ.`
        )
      return isStale(connectivity) ? STALE_HINT : null
    },
    [systems],
  )
}


export function zigbeeLabel(status: string | null) {
  switch (status) {
    case null:
      return { text: 'Not Zigbee', level: 'none' as const }
    case 'connected':
      return { text: 'Connected', level: 'ok' as const }
    case 'disconnected':
      return { text: 'Disconnected', level: 'bad' as const }
    case 'connectivity_issue':
      return { text: 'Connectivity issue', level: 'warn' as const }
    case 'unidirectional_incoming':
      return { text: 'One-way connection', level: 'warn' as const }
    default:
      return { text: status.replace(/_/g, ' '), level: 'warn' as const }
  }
}

export function updateLabel(state: string | null) {
  switch (state) {
    case null:
      return { text: '–', attention: false }
    case 'no_update':
      return { text: 'Up to date', attention: false }
    case 'ready_to_install':
      return { text: 'Ready to install', attention: true }
    case 'update_pending':
      return { text: 'Update available', attention: true }
    default:
      return { text: state.replace(/_/g, ' '), attention: true }
  }
}

/** Zigbee status from a stored zigbee_connectivity event. */
export function zigbeeStatusOf(rawEventData: string): string | null {
  const status = Json.str(rawEventData, 'status')
  if (status !== null) return status
  // IKEA DIRIGERA reports reachability as a boolean on the device.
  const reachable = Json.bool(rawEventData, 'isReachable')
  return reachable === null ? null : reachable ? 'connected' : 'disconnected'
}
