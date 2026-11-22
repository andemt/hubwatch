import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

const KEY = 'hubwatch.collapsedSections'

function loadCollapsed(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function rememberOpen(id: string, open: boolean) {
  try {
    const collapsed = loadCollapsed().filter((c) => c !== id)
    if (!open) collapsed.push(id)
    localStorage.setItem(KEY, JSON.stringify(collapsed))
  } catch {
    // storage unavailable: the choice just isn't remembered
  }
}

interface Props {
  /** Stable id for remembering the state, e.g. "insights.temperature". */
  id: string
  title: ReactNode
  children: ReactNode
}

/**
 * A section whose heading folds it away. Open by default; what the user collapses is remembered in the browser.
 * Native <details>/<summary>, so it works with keyboard and screen readers.
 */
export function Collapsible({ id, title, children }: Props) {
  const [open, setOpen] = useState(() => !loadCollapsed().includes(id))

  return (
    <details
      className="collapsible"
      open={open}
      onToggle={(e) => {
        const now = e.currentTarget.open
        if (now === open) return // the toggle event also fires when React sets the attribute
        setOpen(now)
        rememberOpen(id, now)
      }}
    >
      <summary>
        <ChevronRight aria-hidden className="collapsible-chevron" />
        <span>{title}</span>
      </summary>
      {children}
    </details>
  )
}
