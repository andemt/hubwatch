import { useEffect, useRef } from 'react'
import type { Alert, SystemEvent, Status } from './types'
import { isSystemVisible } from './systemFilter'

interface StreamMessages {
  status: Status
  events: SystemEvent[]
  /** A system (re)loaded its devices, or the stream reconnected (systemId ""): history may have changed */
  snapshot: { systemId: string; at: number }
  alert: Alert
}

type Name = keyof StreamMessages
type Listener<K extends Name> = (data: StreamMessages[K]) => void

const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 15000
/** The server sends at least a "ping" every 15 s; silence for longer means the connection is dead. */
const SILENCE_MS = 40000

/**
 * One shared EventSource for the whole app. The browser reconnects by itself when an open connection drops, but
 * gives up for good when the server answers with an error (e.g. the dev proxy while the backend restarts), so
 * then we reconnect ourselves with back-off. After any reconnect a "snapshot" is sent to the app's own listeners
 * so views reload what they missed.
 *
 * A connection can also die without the browser noticing (the dev proxy keeps it open after the backend
 * restarts, or the computer sleeps), so it is also reopened when nothing, not even a ping, arrives for a while.
 */
class HueStream {
  private source: EventSource | null = null
  private retryTimer: number | undefined
  private retryDelay = RETRY_MIN_MS
  private lostConnection = false
  private watchdog: number | undefined
  private listeners: { [K in Name]: Set<Listener<K>> } = {
    status: new Set(),
    events: new Set(),
    snapshot: new Set(),
    alert: new Set(),
  }

  on<K extends Name>(name: K, listener: Listener<K>): () => void {
    this.ensureOpen()
    this.listeners[name].add(listener)
    return () => {
      this.listeners[name].delete(listener)
    }
  }

  private ensureOpen() {
    if (this.source || this.retryTimer !== undefined) return
    this.open()
  }

  private open() {
    const source = new EventSource('/api/stream')
    this.source = source
    this.resetWatchdog(source)
    source.addEventListener('ping', () => this.resetWatchdog(source))
    ;(Object.keys(this.listeners) as Name[]).forEach((name) => {
      source.addEventListener(name, (e) => {
        this.resetWatchdog(source)
        const data = visibleOnly(name, JSON.parse((e as MessageEvent<string>).data))
        if (data !== null) this.emit(name, data)
      })
    })

    source.onopen = () => {
      this.resetWatchdog(source)
      this.retryDelay = RETRY_MIN_MS
      if (this.lostConnection) {
        this.lostConnection = false
        this.emit('snapshot', { systemId: '', at: Date.now() })
      }
    }

    source.onerror = () => {
      this.lostConnection = true
      if (source.readyState !== EventSource.CLOSED) return // the browser is retrying by itself
      this.reopenLater(source)
    }
  }

  private reopenLater(source: EventSource) {
    if (this.source !== source) return
    window.clearTimeout(this.watchdog)
    source.close()
    this.source = null
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined
      this.open()
    }, this.retryDelay)
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS)
  }

  private resetWatchdog(source: EventSource) {
    if (this.source !== source) return
    window.clearTimeout(this.watchdog)
    this.watchdog = window.setTimeout(() => {
      this.lostConnection = true
      this.reopenLater(source)
    }, SILENCE_MS)
  }

  private emit(name: Name, data: unknown) {
    const set = this.listeners[name] as unknown as Set<(data: unknown) => void>
    set.forEach((listener) => listener(data))
  }
}

/** Drops live data from systems hidden in the UI (they keep recording). Returns null when nothing is left. */
function visibleOnly(name: Name, data: unknown): unknown {
  switch (name) {
    case 'events': {
      const events = (data as SystemEvent[]).filter((e) => isSystemVisible(e.systemId))
      return events.length > 0 ? events : null
    }
    case 'alert':
    case 'snapshot':
      return isSystemVisible((data as { systemId: string }).systemId) ? data : null
    default:
      return data
  }
}

export const hueStream = new HueStream()

/** Subscribe to a live message type for the lifetime of a component. */
export function useStream<K extends Name>(name: K, listener: Listener<K>) {
  const ref = useRef(listener)
  ref.current = listener
  useEffect(() => hueStream.on(name, (data) => ref.current(data)), [name])
}
