// Records a short tour of the app from a running demo server (see demo-server.mjs) and turns it into a GIF.
//
//   node tools/screenshots/tour.mjs [base url] [output gif]
//
// Needs Playwright with Chromium and ffmpeg. Start the demo server with LIVE_INTERVAL_MS=1800 so the log updates
// during the recording.

import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const base = process.argv[2] ?? 'http://localhost:5099'
const out = path.resolve(process.argv[3] ?? 'docs/screenshots/tour.gif')
const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubwatch-tour-'))
const size = { width: 1280, height: 800 }

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
const context = await browser.newContext({
  viewport: size,
  recordVideo: { dir: videoDir, size },
  colorScheme: 'dark',
  locale: 'en-GB',
  timezoneId: 'Europe/Stockholm',
})
const page = await context.newPage()
const wait = (ms) => page.waitForTimeout(ms)
const visible = (text) => page.getByText(text, { exact: true }).filter({ visible: true }).first()
const tab = (name) => page.locator('nav.tabs button', { hasText: name }).first()
const scrollBy = async (y, steps = 12) => {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, y / steps)
    await wait(40)
  }
}

const started = Date.now()
await page.goto(base + '/', { waitUntil: 'networkidle' })
await page.mouse.move(640, 400)
await wait(5500) // live events arrive at the top of the log

await page.getByRole('button', { name: /Motion/ }).first().click() // filter chip
await wait(1600)
await page.getByRole('button', { name: /^All/ }).first().click()
await wait(800)

await tab('Home').click()
await wait(1800)
await scrollBy(560)
await wait(1500)
await visible('Kitchen sensor').click() // device drawer with history charts
await wait(3000)
await page.keyboard.press('Escape')
await wait(600)

await tab('Insights').click()
await wait(2200)
await page.getByText('Motion · when is there activity?', { exact: true }).filter({ visible: true }).first().scrollIntoViewIfNeeded()
await wait(2500)

await tab('Health').click()
await page.evaluate(() => window.scrollTo(0, 0))
await wait(2500)

await tab('Automations').click()
await page.evaluate(() => window.scrollTo(0, 0))
await wait(2500)
const seconds = (Date.now() - started) / 1000

await context.close()
await browser.close()

const video = fs.readdirSync(videoDir).find((f) => f.endsWith('.webm'))
const input = path.join(videoDir, video)
// The video also contains the blank page before the first load; keep the last `seconds`.
const duration = Number(
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input]).toString().trim(),
)
const start = Math.max(0, duration - seconds)
const filters = 'fps=10,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle'
fs.mkdirSync(path.dirname(out), { recursive: true })
execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(start), '-i', input, '-vf', filters, '-loop', '0', out])
console.log(`${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ${seconds.toFixed(0)} s)`)
