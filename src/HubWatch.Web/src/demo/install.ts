import { DemoServer, resetDemo, type StreamName } from './server'

/**
 * Demo mode: answers the app's /api requests and its live stream from a pretend server in the browser, so the
 * UI runs without a backend. api.ts and stream.ts stay unchanged; only fetch and EventSource for /api are
 * replaced.
 */

const server = new DemoServer()

const isApi = (url: string) => url.startsWith('/api/') || url === '/api'

const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url
  const path = url.startsWith(window.location.origin) ? url.slice(window.location.origin.length) : url
  if (!isApi(path)) return realFetch(input, init)

  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  let body: unknown = undefined
  if (typeof init?.body === 'string' && init.body) body = JSON.parse(init.body)
  const result = await server.handle(method, new URL(path, window.location.origin), body)
  if (result.status === 204 || result.body === undefined) return new Response(null, { status: result.status })
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'Content-Type': 'application/json' },
  })
}

type Handler = (e: MessageEvent<string>) => void

/** Stands in for EventSource('/api/stream'): the same named messages, from the pretend server. */
class DemoEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSED = 2
  readyState = 0
  readonly url: string
  readonly withCredentials = false
  onopen: ((e: Event) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  onmessage: Handler | null = null
  private handlers = new Map<string, Set<Handler>>()
  private unlisten: (() => void) | null = null
  private ping: number | undefined

  constructor(url: string | URL) {
    this.url = String(url)
    setTimeout(() => {
      if (this.readyState === 2) return
      this.readyState = 1
      this.onopen?.(new Event('open'))
      this.unlisten = server.listen((name: StreamName, data: unknown) => this.dispatch(name, JSON.stringify(data)))
      // The app reopens a stream that stays silent for too long, like the real server's keep-alive.
      this.ping = window.setInterval(() => this.dispatch('ping', '{}'), 15_000)
    }, 0)
  }

  addEventListener(name: string, handler: Handler) {
    let set = this.handlers.get(name)
    if (!set) this.handlers.set(name, (set = new Set()))
    set.add(handler)
  }

  removeEventListener(name: string, handler: Handler) {
    this.handlers.get(name)?.delete(handler)
  }

  close() {
    this.readyState = 2
    this.unlisten?.()
    window.clearInterval(this.ping)
  }

  private dispatch(name: string, data: string) {
    const event = new MessageEvent(name, { data })
    this.handlers.get(name)?.forEach((h) => h(event))
  }
}

const RealEventSource = window.EventSource
window.EventSource = function (url: string | URL, init?: EventSourceInit) {
  const path = String(url)
  if (isApi(path)) return new DemoEventSource(path)
  return new RealEventSource(url, init)
} as unknown as typeof EventSource
Object.assign(window.EventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 })

/** A small badge so nobody mistakes the demo for their own home, with a way to start over. */
function showBadge() {
  const badge = document.createElement('div')
  badge.className = 'demo-badge'
  badge.setAttribute('role', 'note')
  badge.innerHTML = '<strong>Demo</strong><span>Simulated data, nothing leaves your browser.</span>'
  const reset = document.createElement('button')
  reset.type = 'button'
  reset.textContent = 'Start over'
  reset.addEventListener('click', () => {
    resetDemo()
    window.location.href = import.meta.env.BASE_URL
  })
  badge.append(reset)
  document.body.append(badge)
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showBadge)
else showBadge()
