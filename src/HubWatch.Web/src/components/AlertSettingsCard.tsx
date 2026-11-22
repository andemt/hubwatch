import { useEffect, useState } from 'react'
import { api } from '../api'
import type { AlertSettings } from '../types'
import { browserNotifications } from '../notifications'
import { Check } from 'lucide-react'

export function AlertSettingsCard() {
  const [settings, setSettings] = useState<AlertSettings | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [browserOn, setBrowserOn] = useState(browserNotifications.enabled())

  useEffect(() => {
    api.alertSettings().then(setSettings).catch(() => {})
  }, [])

  if (!settings) return null

  const set = <K extends keyof AlertSettings>(key: K, value: AlertSettings[K]) => {
    setSettings({ ...settings, [key]: value })
    setSaved(null)
  }

  async function save() {
    setError(null)
    try {
      setSettings(await api.saveAlertSettings(settings!))
      setSaved('Saved')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function testNtfy() {
    setError(null)
    setSaved(null)
    try {
      await api.testNtfy(settings!.ntfyUrl ?? '')
      setSaved('Test notification sent')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function toggleBrowser(on: boolean) {
    if (on) {
      const ok = await browserNotifications.enable()
      setBrowserOn(ok)
      if (!ok) setError('The browser did not allow notifications. Check the site settings in your browser.')
    } else {
      browserNotifications.disable()
      setBrowserOn(false)
    }
  }

  return (
    <div className="card">
      <h2>Alerts</h2>
      <p className="muted small">Checked every minute while HubWatch is running.</p>

      <div className="settings-grid">
        <label className="check">
          <input type="checkbox" checked={settings.lowBatteryEnabled} onChange={(e) => set('lowBatteryEnabled', e.target.checked)} />
          Battery below
        </label>
        <span className="inline-input">
          <input type="number" min={1} max={99} aria-label="Battery threshold in percent" value={settings.lowBatteryPercent} onChange={(e) => set('lowBatteryPercent', Number(e.target.value))} />%
        </span>

        <label className="check">
          <input type="checkbox" checked={settings.deviceUnreachableEnabled} onChange={(e) => set('deviceUnreachableEnabled', e.target.checked)} />
          Device unreachable for
        </label>
        <span className="inline-input">
          <input type="number" min={1} aria-label="Minutes before a device counts as unreachable" value={settings.deviceUnreachableMinutes} onChange={(e) => set('deviceUnreachableMinutes', Number(e.target.value))} />
          min
        </span>

        <label className="check">
          <input type="checkbox" checked={settings.systemUnreachableEnabled} onChange={(e) => set('systemUnreachableEnabled', e.target.checked)} />
          Bridge or hub unreachable for
        </label>
        <span className="inline-input">
          <input type="number" min={1} aria-label="Minutes before a bridge or hub counts as unreachable" value={settings.systemUnreachableMinutes} onChange={(e) => set('systemUnreachableMinutes', Number(e.target.value))} />
          min
        </span>
      </div>

      <h3>Where to notify</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={browserOn}
          disabled={!browserNotifications.supported()}
          onChange={(e) => toggleBrowser(e.target.checked)}
        />
        Browser notifications (while this page is open)
      </label>

      <div className="manual">
        <label htmlFor="ntfy">
          Phone via <a href="https://ntfy.sh" target="_blank" rel="noreferrer">ntfy</a>: install the ntfy app, subscribe to a
          hard-to-guess topic and paste its URL here
        </label>
        <div className="row-inline">
          <input
            id="ntfy"
            placeholder="https://ntfy.sh/my-hue-alerts-x7k2"
            value={settings.ntfyUrl ?? ''}
            onChange={(e) => set('ntfyUrl', e.target.value || null)}
          />
          <button className="secondary" disabled={!settings.ntfyUrl} onClick={testNtfy}>
            Send test
          </button>
        </div>
      </div>

      <div className="settings-actions">
        <button className="primary" onClick={save}>
          Save
        </button>
        {saved && <span className="status status-ok">
            <Check aria-hidden /> {saved}
          </span>}
        {error && <span className="error small">{error}</span>}
      </div>
    </div>
  )
}
