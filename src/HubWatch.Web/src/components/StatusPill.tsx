import type { Status, SystemState, SystemStatus } from '../types'
import { SYSTEM_STATE_LABELS as LABELS, systemLabel } from '../systems'

// Worst first, for summing up problems when nothing is live.
const SEVERITY: SystemState[] = ['error', 'offline', 'reconnecting', 'connecting', 'connected']
// Dot order: live first, then the rest worst first, so the eye lands on what works and the red stands out after it.
const DOT_ORDER: SystemState[] = ['connected', 'error', 'offline', 'reconnecting', 'connecting']

/** "2 offline": how several systems in the same state are summed up. */
const PLURAL: Record<SystemState, string> = {
  error: 'with errors',
  offline: 'offline',
  reconnecting: 'reconnecting',
  connecting: 'connecting',
  connected: 'live',
}

/** Up to this many systems get one dot each; more are counted per state so the pill keeps its width. */
const MAX_DOTS = 5

interface Props {
  status: Status
  /** How many systems the UI shows (all by default). */
  shownCount?: number
  /** With several systems, clicking opens the choice of systems to show; with one, the offer to reconnect. */
  onClick?: () => void
  /** Hover hint for the click. */
  clickHint?: string
}

/** Connection state of all systems (including hidden ones: they keep recording). */
export function StatusPill({ status, shownCount, onClick, clickHint }: Props) {
  const systems = [...status.systems].sort((a, b) => DOT_ORDER.indexOf(a.state) - DOT_ORDER.indexOf(b.state))
  if (systems.length === 0) return null
  const live = systems.filter((s) => s.state === 'connected')
  // Leads with what works: "Live" as soon as one system is live. The dots show if another one has a problem.
  const pillState: SystemState = live.length
    ? 'connected'
    : [...systems].sort((a, b) => SEVERITY.indexOf(a.state) - SEVERITY.indexOf(b.state))[0].state

  const total = systems.length
  const shown = shownCount ?? total
  const problems = systems.filter((s) => s.state !== 'connected')
  const [label, detail] = summary(systems, live, problems, total, shown)

  const title = systems
    .map((s) => `${systemLabel(s)}: ${LABELS[s.state]}${s.message ? ` – ${s.message}` : ''}`)
    .concat(onClick && clickHint ? ['', clickHint] : [])
    .join('\n')

  const content = (
    <>
      {total <= MAX_DOTS ? (
        <span className="pill-dots" aria-hidden>
          {systems.map((s) => (
            <span key={s.id} className={`dot dot-${s.state}`} />
          ))}
        </span>
      ) : (
        <span className="pill-dots" aria-hidden>
          {DOT_ORDER.map((state) => {
            const count = systems.filter((s) => s.state === state).length
            return count ? (
              <span key={state} className="dot-count">
                <span className={`dot dot-${state}`} />
                {count}
              </span>
            ) : null
          })}
        </span>
      )}
      {label}
      {detail && <span className="muted pill-bridge"> · {detail}</span>}
    </>
  )

  const className = `pill pill-${pillState}`
  return onClick ? (
    <button className={`${className} pill-button`} title={title} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={className} title={title}>
      {content}
    </div>
  )
}

/** Main text and detail: what is live when anything is, otherwise what is wrong. */
function summary(
  systems: SystemStatus[],
  live: SystemStatus[],
  problems: SystemStatus[],
  total: number,
  shown: number,
): [string, string | null] {
  if (total === 1) return [LABELS[systems[0].state], systemLabel(systems[0])]
  if (problems.length === 0) return ['Live', shown < total ? `${shown} of ${total} systems` : `${total} systems`]
  if (live.length === 1) return ['Live', systemLabel(live[0])]
  if (live.length > 1) return ['Live', `${live.length} of ${total} systems`]
  // Nothing is live.
  if (problems.length === 1) return [LABELS[problems[0].state], systemLabel(problems[0])]
  const states = new Set(problems.map((s) => s.state))
  const label = states.size === 1 ? `${problems.length} ${PLURAL[problems[0].state]}` : `${problems.length} not live`
  return [label, `of ${total} systems`]
}
