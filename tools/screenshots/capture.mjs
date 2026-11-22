// Takes the README screenshots from a running demo server (see demo-server.mjs), in light and dark.
//
//   node tools/screenshots/capture.mjs [base url] [output folder]
//
// Needs Playwright with Chromium and sharp (npm i -D playwright sharp && npx playwright install chromium).
// Screenshots are saved as WebP at 2× so they stay sharp on high-resolution screens without getting large.
// SHOTS=rooms,health limits the run to some shots; CHROME=/path/to/chrome uses an installed browser.

import { chromium } from 'playwright'
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'

const base = process.argv[2] ?? 'http://localhost:5099'
const out = path.resolve(process.argv[3] ?? 'docs/screenshots')
fs.mkdirSync(out, { recursive: true })

/** Scrolls so the element with this exact text sits just below the sticky top bar. */
const scrollTo = (text) => async (page) => {
  await page.getByText(text, { exact: true }).filter({ visible: true }).first().evaluate((el) => {
    const bar = document.querySelector('header')?.getBoundingClientRect().height ?? 0
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - bar - 24)
  })
}

const SHOTS = [
  { name: 'live-log', path: '/' },
  { name: 'rooms', path: '/home', prepare: scrollTo('Hallway') },
  { name: 'device', path: '/home?device=hue-001788fffe6a1b2c:motion-kitchen' },
  { name: 'insights', path: '/insights' },
  { name: 'statistics', path: '/insights', prepare: scrollTo('Motion · when is there activity?') },
  { name: 'health', path: '/health' },
  { name: 'automations', path: '/automations' },
]

const only = process.env.SHOTS?.split(',')
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    locale: 'en-GB',
    timezoneId: 'Europe/Stockholm',
  })
  for (const shot of SHOTS) {
    if (only && !only.includes(shot.name)) continue
    await page.goto(base + shot.path, { waitUntil: 'networkidle' })
    await page.waitForTimeout(800) // charts and drawers animate in
    await shot.prepare?.(page)
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    const file = path.join(out, `${shot.name}-${scheme}.webp`)
    await sharp(await page.screenshot()).webp({ quality: 88, effort: 6 }).toFile(file)
    console.log(file)
  }
  await page.close()
}
await browser.close()
