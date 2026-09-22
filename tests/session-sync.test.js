// Runs the real Session module out of index.html, in a sandbox.
//
// The app is one 10k-line HTML file, so there is nothing to import. This test slices the
// `const Session = { ... }` literal straight out of the file and evaluates it against stubs,
// which means it tests the shipping code rather than a copy that can drift from it.
//
// What it covers is the one thing the app cannot get wrong: a logged set or a completed session
// must never exist only in memory. Every write queues the session BEFORE pushing, so a request
// that never resolves — the tab closed, the phone locked mid-request — still has a retry path and
// survives the next pull. Both halves are asserted: the queue takes the write, and the queue lets
// go once the push is confirmed.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const APP = path.join(__dirname, '..', 'index.html')

const SRC = fs.readFileSync(APP, 'utf8')

/** The declaration starting at `opening`, brace-matched to its close. */
function blockAt(opening, what) {
  const start = SRC.indexOf(opening)
  assert.notEqual(start, -1, `could not find \`${opening}\` in index.html — ${what} moved or was renamed`)
  let depth = 0
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') {
      depth--
      if (depth === 0) return SRC.slice(start, i + 1) + ';'
    }
  }
  throw new Error(`unbalanced braces in ${what}`)
}

// The real helpers the writes reach, plus Session itself. `const`/`function` bind to the script's
// own lexical scope, out of reach of the sandbox object, so each is assigned to globalThis.
const APP_SRC = [
  blockAt('function isLegacyShape(', 'isLegacyShape').replace('function isLegacyShape(', 'globalThis.isLegacyShape = function('),
  blockAt('function flattenBlocks(', 'flattenBlocks').replace('function flattenBlocks(', 'globalThis.flattenBlocks = function('),
  'globalThis.isSetItem = (item) => Number(item?.sets) > 0;',
  'globalThis.itemHidden = (item) => !!(item?.hidden || item?.removed);',
  blockAt('const Session = {', 'the Session module').replace('const Session = ', 'globalThis.Session = '),
].join('\n')

/**
 * A sandbox holding just enough of the app for the writes under test. Anything a call does not
 * reach can stay undefined — the helpers resolve at call time, not at evaluation time.
 */
function sandbox({ sessions = {}, workoutsCompleted = [], pending = [] } = {}) {
  const pushed = { sets: 0, status: 0, workoutDone: [] }
  const ctx = {
    state: {
      sessions,
      sessionSets: {},
      workoutsCompleted,
      pendingSessionSync: pending,
      setLog: {},
    },
    saves: 0,
    pushed,
    save() { ctx.saves++ },
    toast() {},
    formatViewDateLabel: (d) => d,
    getDayIdxFromDate(date) {
      const d = new Date(date + 'T00:00:00')
      return d.getDay() === 0 ? 6 : d.getDay() - 1
    },
    todayKey: () => '2026-09-22',
    Sync: {
      ready: true,
      pushSessionSet() { pushed.sets++ },
      pushSessionStatus() { pushed.status++ },
      pushWorkoutDone(date, d) { pushed.workoutDone.push(`${date}-${d}`) },
      pushWorkoutUndone(date, d) { pushed.workoutDone = pushed.workoutDone.filter((k) => k !== `${date}-${d}`) },
    },
  }
  vm.createContext(ctx)
  vm.runInContext(APP_SRC, ctx)
  // renderSyncState touches the DOM; the queue itself is what this test is about.
  ctx.Session.renderSyncState = () => {}
  return ctx
}

/** A session row shaped like one `newRow` produces, with a single one-set block. */
function row(overrides = {}) {
  return {
    id: 's_2026-09-21_lower-strength',
    date: '2026-09-21',
    status: 'in_progress',
    snapshot: { blocks: [{ type: 'strength', items: [{ exerciseId: 'squat', name: 'Squat', sets: 1 }] }] },
    ...overrides,
  }
}

// ===== a logged set is queued before it is pushed ===========================

test('committing a set queues the session before pushing it', () => {
  const ctx = sandbox()
  const s = row()
  ctx.state.sessions[s.date] = s
  ctx.Session.cell(s, 0, 0, 0).weight = 225
  ctx.Session.commit(s, 0, 0, 0)

  assert.deepEqual(ctx.state.pendingSessionSync, [s.id], 'the set must not rest on the push alone')
  assert.equal(ctx.pushed.sets, 1)
  assert.ok(ctx.saves > 0, 'the write must reach localStorage too')
})

test('a set logged while the session is already queued does not queue it twice', () => {
  const ctx = sandbox()
  const s = row()
  ctx.state.sessions[s.date] = s
  ctx.Session.cell(s, 0, 0, 0).reps = 5
  ctx.Session.commit(s, 0, 0, 0)
  ctx.Session.commit(s, 0, 0, 0)
  assert.deepEqual(ctx.state.pendingSessionSync, [s.id])
})

// ===== the other half: a confirmed push releases the queue ==================

test('a confirmed push flushes, and a failed one keeps the session queued', () => {
  const ctx = sandbox()
  const s = row()
  ctx.state.sessions[s.date] = s
  let flushes = 0
  ctx.Session.flush = () => { flushes++ }

  ctx.Session.afterPush(s.id, false)
  assert.deepEqual(ctx.state.pendingSessionSync, [s.id], 'a failed push must leave a retry behind')

  ctx.Session.afterPush(s.id, true)
  assert.equal(flushes, 1, 'a confirmed push drains the queue rather than leaving it to rot')
})

// ===== completion ===========================================================

test('marking a session done queues it, writes both records, and pushes the status', () => {
  const ctx = sandbox()
  const s = row()
  ctx.state.sessions[s.date] = s
  ctx.Session.setStatus(s, 'done')

  assert.equal(s.status, 'done')
  assert.ok(s.completed_at, 'a completed session records when')
  assert.equal(s.statusDirty, true)
  assert.deepEqual(ctx.state.pendingSessionSync, [s.id], 'a completion must survive a lost request')
  assert.deepEqual(ctx.state.workoutsCompleted, ['2026-09-21-0'])
  assert.equal(ctx.pushed.status, 1)
})

// ===== reconcileLegacyDone: both halves =====================================

test('a completion the cloud row lost is restored from the legacy flag and re-pushed', () => {
  const ctx = sandbox({
    sessions: { '2026-09-21': row({ status: 'in_progress' }) },
    workoutsCompleted: ['2026-09-21-0'],
  })
  ctx.Session.reconcileLegacyDone()

  assert.equal(ctx.state.sessions['2026-09-21'].status, 'done')
  assert.equal(ctx.pushed.status, 1, 'the restored status must go back to the cloud')
  assert.deepEqual(ctx.state.pendingSessionSync, ['s_2026-09-21_lower-strength'])
})

test('reconcile leaves alone every session the flag does not claim', () => {
  // The positive half: proving it restores completions is worthless if it just marks everything
  // done. A day with no flag, a skipped day, and a mismatched key must all come through untouched.
  const ctx = sandbox({
    sessions: {
      '2026-09-21': row({ status: 'in_progress' }),                                  // no flag
      '2026-09-20': row({ id: 's_2026-09-20_x', date: '2026-09-20', status: 'skipped' }),   // flagged, but skipped
      '2026-09-19': row({ id: 's_2026-09-19_x', date: '2026-09-19', status: 'planned' }),   // flag names the wrong weekday
    },
    workoutsCompleted: ['2026-09-20-6', '2026-09-19-4'],
  })
  ctx.Session.reconcileLegacyDone()

  assert.equal(ctx.state.sessions['2026-09-21'].status, 'in_progress')
  assert.equal(ctx.state.sessions['2026-09-20'].status, 'skipped', 'a skip is not a completion')
  assert.equal(ctx.state.sessions['2026-09-19'].status, 'planned')
  assert.equal(ctx.pushed.status, 0)
  assert.deepEqual(ctx.state.pendingSessionSync, [])
})

// ===== the retry actually resolves =========================================

/**
 * A stand-in for the cloud that reproduces the one behaviour this all turns on: an UPDATE against
 * a row that isn't there changes nothing (and, since fix 3, reports failure), while pushSession
 * inserts the full row — status, started_at and completed_at included.
 */
function fakeServer(ctx) {
  const rows = new Map()
  const calls = []
  ctx.Sync.sessionSetRow = (session_id, b, i, n) => ({ session_id, block_idx: b, item_idx: i, set_idx: n })
  ctx.Sync.pushSession = async (s, { overwrite = false } = {}) => {
    calls.push('insert')
    if (!rows.has(s.id) || overwrite) {
      rows.set(s.id, { id: s.id, date: s.date, status: s.status, completed_at: s.completed_at ?? null })
    }
    return true
  }
  ctx.Sync.updateSessionStatus = async (s) => {
    calls.push('status')
    const row = rows.get(s.id)
    if (!row) return false          // zero rows matched — what fix 3 now detects
    Object.assign(row, { status: s.status, completed_at: s.completed_at ?? null })
    return true
  }
  ctx.Sync.setWorkoutDoneFlag = async () => { calls.push('flag'); return true }
  ctx.Sync.upsertSessionSets = async () => { calls.push('sets'); return true }
  ctx.Sync.pushSessionStatus = (s) => {
    ctx.inflight = ctx.Sync.updateSessionStatus(s).then((ok) => ctx.Session.afterPush(s.id, ok))
  }
  return { rows, calls }
}

test('a completion whose row was never inserted is queued, then the flush inserts the row and lands it', async () => {
  const ctx = sandbox()
  const server = fakeServer(ctx)
  const s = row()
  ctx.state.sessions[s.date] = s
  ctx.Session.setStatus(s, 'done')
  await ctx.inflight

  // The push failed against a row that does not exist, so the completion is still owed.
  assert.equal(server.rows.size, 0, 'nothing should exist on the server yet')
  assert.deepEqual(ctx.state.pendingSessionSync, [s.id], 'the completion must still be queued')
  assert.equal(s.statusDirty, true)

  server.calls.length = 0     // only the retry's own ordering matters from here
  await ctx.Session.flush()

  assert.equal(server.rows.get(s.id)?.status, 'done', 'the retry must land the completion')
  assert.equal(server.calls.indexOf('insert') < server.calls.indexOf('status'), true,
    'the row has to be inserted before the status update, or the retry never resolves')
  assert.deepEqual(ctx.state.pendingSessionSync, [], 'a landed completion leaves the queue')
  assert.equal(s.statusDirty, undefined, 'and stops being owed')
})

test('the flush keeps a session queued while the cloud is unreachable', () => {
  // The other half: draining the queue must depend on the write actually landing.
  const ctx = sandbox()
  fakeServer(ctx)
  const s = row()
  ctx.state.sessions[s.date] = s
  ctx.Sync.pushSession = async () => false      // offline
  ctx.Session.setStatus(s, 'done')

  return ctx.Session.flush().then(() => {
    assert.deepEqual(ctx.state.pendingSessionSync, [s.id], 'an unreachable cloud must not clear the queue')
    assert.equal(s.statusDirty, true, 'the completion is still owed')
  })
})

test('reconcile is idempotent — a day already done is not re-pushed', () => {
  const ctx = sandbox({
    sessions: { '2026-09-21': row({ status: 'done', completed_at: '2026-09-21T18:00:00.000Z' }) },
    workoutsCompleted: ['2026-09-21-0'],
  })
  ctx.Session.reconcileLegacyDone()
  assert.equal(ctx.pushed.status, 0)
  assert.deepEqual(ctx.state.pendingSessionSync, [])
})
