import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Braces, Check, Copy, X } from 'lucide-react'

/**
 * Right-hand side panel (native modal dialog): traps focus, closes on Escape or a backdrop click and returns focus
 * to the opener when closed.
 */
export function Drawer({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
  }, [])
  const close = () => dialog.current?.close()

  return (
    <dialog
      ref={dialog}
      className="drawer"
      aria-label={title}
      // A nested dialog's close event also reaches here through React, so only react to our own.
      onClose={(ev) => ev.target === ev.currentTarget && onClose()}
      // The inner wrapper fills the dialog, so a click that lands on the dialog itself is a backdrop click.
      onClick={(ev) => ev.target === ev.currentTarget && close()}
    >
      <div className="drawer-body">
        <header className="drawer-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="muted small">{subtitle}</div>}
          </div>
          <button className="close" onClick={close} aria-label="Close">
            <X aria-hidden />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  )
}

type Field = { path: string; value: string; kind: 'string' | 'number' | 'boolean' | 'null' | 'empty' }

/** Flattens JSON into "a.b.c → value" rows so it can be shown as a table. */
function flatten(value: unknown, path = '', out: Field[] = []): Field[] {
  if (value === null || value === undefined) {
    out.push({ path, value: '–', kind: 'null' })
  } else if (Array.isArray(value)) {
    if (value.length === 0) out.push({ path, value: 'none', kind: 'empty' })
    else if (value.every((v) => v === null || typeof v !== 'object')) out.push({ path, value: value.map(String).join(', '), kind: 'string' })
    else value.forEach((v, i) => flatten(v, `${path}[${i}]`, out))
  } else if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) out.push({ path, value: 'none', kind: 'empty' })
    for (const [k, v] of entries) flatten(v, path ? `${path}.${k}` : k, out)
  } else if (typeof value === 'boolean') {
    out.push({ path, value: value ? 'true' : 'false', kind: 'boolean' })
  } else if (typeof value === 'number') {
    out.push({ path, value: String(value), kind: 'number' })
  } else {
    out.push({ path, value: String(value), kind: 'string' })
  }
  return out
}

/** Pretty-printed JSON, or the raw string when it does not parse. */
function pretty(json: string) {
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}

/** A JSON string shown as a property/value table, with a heading and a button that shows the raw JSON. */
export function PropertyTable({ title, json, empty = 'No readable data.' }: { title: string; json: string; empty?: string }) {
  const [showJson, setShowJson] = useState(false)
  const fields = useMemo(() => {
    try {
      return flatten(JSON.parse(json))
    } catch {
      return null
    }
  }, [json])

  return (
    <>
      <div className="drawer-section-head">
        <h3>{title}</h3>
        {json && (
          <button type="button" className="secondary small-button with-icon" onClick={() => setShowJson(true)}>
            <Braces aria-hidden /> View JSON
          </button>
        )}
      </div>
      {fields === null ? (
        <p className="muted">{empty}</p>
      ) : (
        <div className="drawer-table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Property</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f, i) => (
                <tr key={`${f.path}-${i}`}>
                  <td>
                    <code>{f.path || 'value'}</code>
                  </td>
                  <td className={`val val-${f.kind}`}>{f.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showJson && <JsonDialog title={title} json={json} onClose={() => setShowJson(false)} />}
    </>
  )
}

/** Centred modal with the raw JSON and a copy button. Opens above the side panel; Escape closes only this. */
function JsonDialog({ title, json, onClose }: { title: string; json: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [copied, setCopied] = useState(false)
  const text = useMemo(() => pretty(json), [json])

  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
  }, [])
  const close = () => dialog.current?.close()

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard not available */
    }
  }

  return (
    <dialog
      ref={dialog}
      className="json-dialog"
      aria-label={`${title} as JSON`}
      onClose={(ev) => {
        ev.stopPropagation()
        if (ev.target === ev.currentTarget) onClose()
      }}
      onClick={(ev) => {
        ev.stopPropagation()
        if (ev.target === ev.currentTarget) close()
      }}
    >
      <div className="json-dialog-body">
        <header className="json-dialog-head">
          <h3>{title} · JSON</h3>
          <div className="json-dialog-actions">
            <button type="button" className="secondary small-button with-icon" onClick={copy}>
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />} {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className="close" onClick={close} aria-label="Close">
              <X aria-hidden />
            </button>
          </div>
        </header>
        <pre>{text}</pre>
      </div>
    </dialog>
  )
}
