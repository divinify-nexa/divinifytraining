// harness.js — shared by the browser tests; not a test itself. Boots index.html in headless
// Chromium with mock-supabase.js in place of the supabase-js CDN script, every other external
// request blocked, and the clock fixed (default 2026-10-06 10:00, the date the fixture was taken).
//
// Needs playwright-core, which the repo deliberately does not depend on:
//   npm i --no-save playwright-core
// Chromium: $CHROMIUM_PATH if set, else the newest Playwright headless shell in the user cache,
// else whatever playwright-core resolves by default (npx playwright install chromium).
const fs = require('fs')
const os = require('os')
const path = require('path')

let chromium
try { ({ chromium } = require('playwright-core')) } catch {
  console.error('playwright-core is not installed. Run: npm i --no-save playwright-core')
  process.exit(2)
}

const APP = path.join(__dirname, '..', '..', 'index.html')
const MOCK = fs.readFileSync(path.join(__dirname, 'mock-supabase.js'), 'utf8')
const FIXTURE = path.join(__dirname, 'fixtures', 'sessions-2026-09.json')

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const cache = process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches/ms-playwright') : path.join(os.homedir(), '.cache/ms-playwright')
  if (!fs.existsSync(cache)) return undefined
  for (const dir of fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse()) {
    for (const sub of fs.readdirSync(path.join(cache, dir))) {
      const exe = path.join(cache, dir, sub, 'chrome-headless-shell')
      if (fs.existsSync(exe)) return exe
    }
  }
  return undefined
}

// The app under test: argv[2] if given (e.g. a `git archive` export for a before/after run), else the repo's index.html.
function appPath() { return process.argv[2] ? path.resolve(process.argv[2]) : APP }

async function boot({ app = appPath(), seed, width = 390, height = 844, scheme = 'dark', now = '2026-10-06T10:00:00' }) {
  const browser = await chromium.launch({ executablePath: chromiumPath() })
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 2 })
  const html = fs.readFileSync(app, 'utf8')
  await ctx.route('**/*', (route) => {
    const u = route.request().url()
    if (u.startsWith('http://app.test/')) return route.fulfill({ contentType: 'text/html', body: html })
    if (u.includes('supabase-js')) return route.fulfill({ contentType: 'application/javascript', body: MOCK })
    return route.abort()
  })
  await ctx.addInitScript(({ seed }) => {
    if (!localStorage.getItem('__mockdb')) localStorage.setItem('__mockdb', JSON.stringify(seed))
  }, { seed })
  const page = await ctx.newPage()
  await page.clock.install({ time: new Date(now) })
  await page.clock.resume()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto('http://app.test/')
  await settle(page)
  return { browser, ctx, page, errors }
}
async function settle(page) {
  await page.waitForFunction(() => typeof syncStatus !== 'undefined' && syncStatus.state !== 'syncing' && !!state, null, { timeout: 15000 })
  await page.waitForTimeout(400)
}
// The fixture: synthetic training data as of 2026-10-06 (12 sessions, 220 set rows, completion flags, a
// plan on the built-in programs) with invented exercises and generated numbers. Fresh copy per call.
function loadFixture() { return JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) }

module.exports = { boot, settle, loadFixture, appPath }
