import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { DiscoveredBridge } from '../types'
import { Spinner } from './Spinner'

type Phase = 'choose' | 'pairing' | 'updating' | 'failed'

/**
 * How a bridge relates to the bridges HubWatch is already connected to:
 * - current: a connected bridge at its known address (nothing to do)
 * - moved:   a connected bridge (same id) at a new IP address – connecting just updates the address
 */
type Relation = 'current' | 'moved' | null

const PAIR_WINDOW_MS = 60_000

/** A bridge HubWatch is already connected to, so it can be marked in the list and not paired again. */
export interface KnownBridge {
  ip: string
  /** The bridge's own id */
  id: string | null
}

/** Which kind of system to add. DIRIGERA hubs can't be discovered yet, so they take an IP address. */
export type FinderKind = 'hue' | 'dirigera'

const TEXT: Record<FinderKind, { thing: string; placeholder: string; press: string; where: string; timeout: string }> = {
  hue: {
    thing: 'bridge',
    placeholder: '192.168.1.20',
    press: 'Press the link button on your bridge',
    where: "It's the large round button on top.",
    timeout: 'Timed out – the link button was not pressed.',
  },
  dirigera: {
    thing: 'hub',
    placeholder: '192.168.1.30 or gw2-….local',
    press: 'Press the action button on your DIRIGERA hub',
    where: "It's the small button on the bottom of the hub.",
    timeout: 'Timed out – the action button was not pressed.',
  },
}

interface Props {
  kind?: FinderKind
  onPaired: () => void
  /** Shown next to Connect while choosing (e.g. a Cancel button in a dialog). */
  secondaryAction?: React.ReactNode
  known?: KnownBridge[]
  /** Told whether a pairing or address update is in progress, e.g. to hide controls that would interrupt it. */
  onBusyChange?: (busy: boolean) => void
}

const NONE: KnownBridge[] = []

/** Finds Hue bridges on the network (or takes a manual IP) and pairs with the chosen one. */
export function BridgeFinder({ kind = 'hue', onPaired, secondaryAction, known = NONE, onBusyChange }: Props) {
  const text = TEXT[kind]
  const pairOnce = (target: string, start: boolean) =>
    kind === 'dirigera' ? api.pairIkea(target, start) : api.pairHue(target)
  const [bridges, setBridges] = useState<DiscoveredBridge[] | null>(null)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const [ip, setIp] = useState('')
  const [phase, setPhase] = useState<Phase>('choose')
  const [message, setMessage] = useState<string | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const cancelled = useRef(false)

  // Stable across renders while the known bridges are the same, so discovery doesn't re-run.
  const knownKey = known.map((k) => `${k.ip}|${k.id ?? ''}`).join(',')
  const knownList = useMemo(() => known, [knownKey]) // eslint-disable-line react-hooks/exhaustive-deps

  /** The connected bridge with the same id but another address, if any. */
  const movedFrom = useCallback(
    (b: { ip: string; id?: string | null }) =>
      b.id ? knownList.find((k) => k.id && k.id.toLowerCase() === b.id!.toLowerCase() && k.ip !== b.ip.trim()) : undefined,
    [knownList],
  )
  const relationOf = useCallback(
    (b: { ip: string; id?: string | null }): Relation => {
      if (knownList.some((k) => k.ip === b.ip.trim())) return 'current'
      if (movedFrom(b)) return 'moved'
      return null
    },
    [knownList, movedFrom],
  )

  const discover = useCallback(async () => {
    if (kind === 'dirigera') {
      setBridges([])
      return
    }
    setBridges(null)
    setDiscoverError(null)
    try {
      const found = await api.discoverHue()
      setBridges(found)
      // If the paired bridge has moved, that is almost certainly what the user is here for.
      const first = found.find((b) => relationOf(b) === 'moved') ?? found.find((b) => relationOf(b) === null)
      setIp((prev) => (prev.trim() ? prev : (first?.ip ?? '')))
    } catch (e) {
      setDiscoverError((e as Error).message)
      setBridges([])
    }
  }, [relationOf, kind])

  const busy = phase === 'pairing' || phase === 'updating'
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  useEffect(() => {
    cancelled.current = false
    discover()
    return () => {
      cancelled.current = true
    }
  }, [discover])

  /** The paired bridge at a new address: a single call updates the address, no link button needed. */
  async function updateAddress(target: string) {
    cancelled.current = false
    setPhase('updating')
    setMessage(null)
    try {
      const result = await pairOnce(target, true)
      if (cancelled.current) return
      if (result.paired) {
        onPaired()
        return
      }
      // The bridge turned out not to be the paired one after all; fall back to normal pairing.
      await pair(target)
    } catch (e) {
      if (cancelled.current) return
      setMessage((e as Error).message)
      setPhase('failed')
    }
  }

  async function pair(target: string) {
    cancelled.current = false
    setPhase('pairing')
    setMessage(null)
    const deadline = Date.now() + PAIR_WINDOW_MS
    let first = true

    while (!cancelled.current && Date.now() < deadline) {
      setSecondsLeft(Math.ceil((deadline - Date.now()) / 1000))
      try {
        const result = await pairOnce(target, first)
        first = false
        if (cancelled.current) return
        if (result.paired) {
          onPaired()
          return
        }
      } catch (e) {
        if (cancelled.current) return
        setMessage((e as Error).message)
        setPhase('failed')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }

    if (!cancelled.current) {
      setMessage(text.timeout)
      setPhase('failed')
    }
  }

  function cancel() {
    cancelled.current = true
    setPhase('choose')
  }

  if (phase === 'pairing') {
    return (
      <div className="pairing">
        {kind === 'hue' && (
          <div className="bridge-illustration" aria-hidden>
            <div className="bridge-button" />
          </div>
        )}
        <h2>{text.press}</h2>
        <p className="muted">
          {text.where} Waiting… {secondsLeft}s
        </p>
        <button className="secondary" onClick={cancel}>
          Cancel
        </button>
      </div>
    )
  }

  const target = ip.trim()
  const targetBridge = bridges?.find((b) => b.ip === target)
  const targetRelation = relationOf(targetBridge ?? { ip: target })
  const updating = phase === 'updating'

  return (
    <>
      <h2>{kind === 'dirigera' ? '1. Enter the hub’s address' : '1. Choose your bridge'}</h2>
      {kind === 'dirigera' && (
        <p className="muted small">
          Find the hub’s IP address in your router’s list of devices. Its name there starts with “gw2-”, and that name
          followed by “.local” also works.
        </p>
      )}
      {/* Searching and "none found" take the same space as a found bridge, so the card doesn't jump in height. */}
      {bridges === null && (
        <ul className="bridge-list" aria-live="polite">
          <li className="bridge-status">
            <Spinner />
            Searching your network…
          </li>
        </ul>
      )}
      {bridges && bridges.length > 0 && (
        <ul className="bridge-list">
          {bridges.map((b) => {
            const relation = relationOf(b)
            return (
              <li key={b.ip}>
                <label className={relation === 'current' ? 'is-current' : undefined}>
                  <input
                    type="radio"
                    name="bridge"
                    checked={target === b.ip}
                    disabled={relation === 'current' || updating}
                    onChange={() => setIp(b.ip)}
                  />
                  <span>
                    <strong>{b.name ?? 'Hue Bridge'}</strong>
                    <span className="muted"> · {b.ip}</span>
                  </span>
                  {relation === 'current' && <span className="tag">Connected</span>}
                  {relation === 'moved' && <span className="tag tag-warn">New IP address</span>}
                </label>
              </li>
            )
          })}
        </ul>
      )}
      {kind === 'hue' && bridges && bridges.length === 0 && (
        <ul className="bridge-list" aria-live="polite">
          <li className="bridge-status">{discoverError ?? 'No bridge found automatically.'}</li>
        </ul>
      )}
      {bridges && bridges.length > 0 && bridges.every((b) => relationOf(b) === 'current') && (
        <p className="muted small">No other bridge was found. Enter its IP address below if you know it.</p>
      )}

      <div className="manual">
        <label htmlFor="bridge-ip">{kind === 'dirigera' ? 'IP address or name' : 'Or enter the IP address'}</label>
        <div className="row-inline">
          <input
            id="bridge-ip"
            placeholder={text.placeholder}
            value={ip}
            disabled={updating}
            onChange={(e) => setIp(e.target.value)}
          />
          {kind === 'hue' && (
            <button className="secondary" disabled={updating} onClick={discover}>
              Search again
            </button>
          )}
        </div>
      </div>

      <h2>2. Pair</h2>
      {phase === 'failed' && message && <p className="error">{message}</p>}
      {targetRelation === 'current' && <p className="muted small">HubWatch is already connected to this {text.thing}.</p>}
      {targetRelation === 'moved' && (
        <p className="muted small">
          This is a bridge HubWatch is already connected to – it has a new IP address ({movedFrom(targetBridge!)?.ip} →{' '}
          {target}). Updating keeps its history and doesn't need the link button.
        </p>
      )}
      <div className="bridge-finder-actions">
        {secondaryAction}
        <button
          className="primary"
          disabled={!target || targetRelation === 'current' || updating}
          onClick={() => (targetRelation === 'moved' ? updateAddress(target) : pair(target))}
        >
          {updating ? 'Updating…' : targetRelation === 'moved' ? 'Update IP address' : 'Connect'}
        </button>
      </div>
    </>
  )
}
