import { useCallback, useEffect, useState } from 'react'

/**
 * Side panels are kept in the URL (?device=…, ?automation=…, ?event=…) so a reload or a shared link opens the same
 * panel and Back closes it. At most one panel is open at a time.
 */
export type PanelParam = 'device' | 'automation' | 'event'
const PANEL_PARAMS: PanelParam[] = ['device', 'automation', 'event']

/** Marks history entries this app added for a panel, so closing can go Back instead of adding another entry. */
const PUSHED = 'hubwatchPanel'
/** pushState/replaceState don't fire popstate; this tells the other hooks on the page that the URL changed. */
const CHANGED = 'hubwatch:panelroute'

function read(param: PanelParam): string | null {
  return new URLSearchParams(window.location.search).get(param)
}

function urlWith(param: PanelParam | null, value: string | null): string {
  const params = new URLSearchParams(window.location.search)
  for (const p of PANEL_PARAMS) params.delete(p)
  if (param && value !== null) params.set(param, value)
  // Colons are allowed in a query; keep them readable (system:id).
  const q = params.toString().replace(/%3A/gi, ':')
  return window.location.pathname + (q ? `?${q}` : '') + window.location.hash
}

const anyPanelOpen = () => PANEL_PARAMS.some((p) => read(p) !== null)
const pushedByUs = () => (window.history.state as Record<string, unknown> | null)?.[PUSHED] === true

/**
 * The value of one panel parameter, with functions that open the panel (adds a history entry, or replaces the
 * current one when a panel is already open) and close it (goes Back when the entry is ours, otherwise just
 * removes the parameter so Back doesn't leave the app).
 */
export function usePanelRoute(param: PanelParam): [string | null, (value: string) => void, () => void] {
  const [value, setValue] = useState(() => read(param))

  useEffect(() => {
    const sync = () => setValue(read(param))
    window.addEventListener('popstate', sync)
    window.addEventListener(CHANGED, sync)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener(CHANGED, sync)
    }
  }, [param])

  const open = useCallback(
    (next: string) => {
      if (read(param) === next) return
      const url = urlWith(param, next)
      if (anyPanelOpen()) window.history.replaceState(window.history.state, '', url)
      else window.history.pushState({ [PUSHED]: true }, '', url)
      window.dispatchEvent(new Event(CHANGED))
    },
    [param],
  )

  const close = useCallback(() => {
    if (read(param) === null) return
    if (pushedByUs()) {
      window.history.back()
    } else {
      window.history.replaceState(window.history.state, '', urlWith(null, null))
      window.dispatchEvent(new Event(CHANGED))
    }
  }, [param])

  return [value, open, close]
}

/** "systemId:id" for panels that need both (an id is only unique within its system). */
export function encodeRef(ref: { systemId: string; id: string }): string {
  return `${ref.systemId}:${ref.id}`
}

/** Parses encodeRef; the id is after the last colon, so a system id may itself contain colons. */
export function decodeRef(value: string | null): { systemId: string; id: string } | null {
  if (!value) return null
  const i = value.lastIndexOf(':')
  if (i <= 0 || i === value.length - 1) return null
  return { systemId: value.slice(0, i), id: value.slice(i + 1) }
}
