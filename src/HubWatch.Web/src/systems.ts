import { createContext, useCallback, useContext, useState } from 'react'
import { api } from './api'
import type { SystemState, SystemStatus } from './types'

/** The connected systems (from the status), available to every component. */
export const SystemsContext = createContext<SystemStatus[]>([])

export function useSystems() {
  return useContext(SystemsContext)
}

export const SYSTEM_STATE_LABELS: Record<SystemState, string> = {
  connecting: 'Connecting…',
  connected: 'Live',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
  error: 'Error',
}

/** Whether a system is trying to connect right now (and so can be stopped). */
export const isConnecting = (state: SystemState) => state === 'connecting' || state === 'reconnecting'

/**
 * Asks offline systems to try again, or stops systems that are trying. The new state arrives with the status
 * stream; `pending` lists the systems whose request is on its way.
 */
export function useReconnect() {
  const [pending, setPending] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async (id: string, action: (id: string) => Promise<void>, failed: string) => {
    setError(null)
    setPending((p) => [...p, id])
    try {
      await action(id)
      return true
    } catch (e) {
      setError(`${failed}: ${e instanceof Error ? e.message : String(e)}`)
      return false
    } finally {
      setPending((p) => p.filter((x) => x !== id))
    }
  }, [])
  const reconnect = useCallback((id: string) => run(id, api.reconnect, 'Could not reconnect'), [run])
  const stop = useCallback((id: string) => run(id, api.stopConnecting, 'Could not stop'), [run])
  return { reconnect, stop, pending, error }
}

export function systemLabel(system: Pick<SystemStatus, 'name' | 'address'>) {
  return system.name ?? system.address
}

/**
 * Returns a function giving a system's display name, or null while there is only one system
 * (then naming it adds nothing).
 */
export function useSystemName(): (systemId: string) => string | null {
  const systems = useSystems()
  return useCallback(
    (systemId: string) => {
      if (systems.length < 2) return null
      const system = systems.find((s) => s.id === systemId)
      return system ? systemLabel(system) : null
    },
    [systems],
  )
}
