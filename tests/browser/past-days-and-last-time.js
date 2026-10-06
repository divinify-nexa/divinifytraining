// past-days-and-last-time.js — browser test for 4b1ce46 and the per-set half of a03176f.
//   [2] every past date in the fixture renders exactly the logged reps/weights/ticks (compared with
//       the mock's rows, not app state), its completion state (Completed / In progress / Not started),
//       recorded Phase 12 metrics read-only, and logged values at >= 4.5:1 contrast
//   [3] the same after reload + pull; viewing, reloading and pulling issue zero writes
//   [4] Phase 17 past-day edit: unlock, change a value, it is pushed and persists; mark not done / done
//   [5] per-set last time on a non-deload Tuesday: reps under Reps, weight under lbs, per set index;
//       blank where history is shorter, extras ignored, absent with no history / on ticks / on past
//       days; the date or suggestion line never repeats a figure; zero writes, nothing materialized
//   [6] layout at 375 and 430px, dark and light, today / past / unlocked past / in-progress past:
//       no overflow, inputs and ticks >= 44px, figures centred under their inputs, no console errors
// Run: node tests/browser/past-days-and-last-time.js [path/to/index.html]   (SHOTS_DIR=dir to keep screenshots)
const { boot, settle, loadFixture, appPath } = require('./harness')
const assert = require('node:assert/strict')
const app = appPath()
let pass = 0, fail = 0
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ', name) } catch (e) { fail++; console.log('  FAIL', name, '\n       ', String(e.message).split('\n').slice(0, 6).join('\n        ')) }
}
const TODAY = '2026-10-06'
const openTrain = (page, d) => page.evaluate((d) => { showPage('workout', document.querySelector('nav .nav-btn[onclick*="workout"]')); setViewDate(d) }, d)
const writes = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('__writes') || '[]').length)

// Every rendered set cell and tick on the viewed date, keyed b/i/s, read straight from the DOM.
const domCells = (page) => page.evaluate(() => {
  const out = {}
  document.querySelectorAll('#workout-content .set-table.editable-only').forEach((row) => {
    const [r, w] = row.querySelectorAll('.set-input')
    const m = /logBlockSet\(\d+,(\d+),(\d+),(\d+)/.exec(r.getAttribute('onchange'))
    out[`${m[1]}/${m[2]}/${m[3]}`] = { reps: r.value, weight: w.value, done: row.querySelector('.set-check').classList.contains('done') }
  })
  document.querySelectorAll('#workout-content .hiit-row').forEach((row) => {
    const m = /toggleBlockTick\(\d+,(\d+),(\d+)\)/.exec(row.querySelector('.set-check').getAttribute('onclick'))
    if (m) out[`${m[1]}/${m[2]}/0`] = { tick: true, done: row.querySelector('.set-check').classList.contains('done') }
  })
  return out
})
// What the cloud holds for a session, in the same shape.
function dbCells(seed, sid) {
  const out = {}
  seed.training_session_sets.filter((r) => r.session_id === sid).forEach((r) => {
    out[`${r.block_idx}/${r.item_idx}/${r.set_idx}`] = { reps: r.reps == null ? '' : String(+r.reps), weight: r.weight == null ? '' : String(+r.weight), done: !!r.done }
  })
  return out
}
function compareDate(seed, sess, dom) {
  const db = dbCells(seed, sess.id)
  const blocks = sess.snapshot.blocks
  let compared = 0
  for (const [k, v] of Object.entries(dom)) {
    const [b, i] = k.split('/').map(Number)
    const it = blocks[b].items[i]
    const want = db[k] || { reps: '', weight: '', done: false }
    if (v.tick) assert.equal(v.done, want.done, `${sess.date} ${it.name} tick`)
    else assert.deepEqual(v, { reps: want.reps, weight: want.weight, done: want.done }, `${sess.date} ${it.name} set ${k}`)
    compared++
  }
  // Every logged DB cell for a visible item must be on screen.
  for (const [k, v] of Object.entries(db)) {
    const [b, i, s] = k.split('/').map(Number), it = blocks[b]?.items?.[i]
    if (!it || it.hidden || it.removed || blocks[b].hidden || (Number(it.sets) > 0 && s >= +it.sets)) continue
    if (v.done || v.reps !== '' || v.weight !== '') assert.ok(dom[k], `${sess.date} logged cell ${k} (${it.name}) not rendered`)
  }
  return compared
}
const pastState = (page) => page.evaluate(() => ({ meta: document.querySelector('.workout-meta-state')?.textContent || null, foot: document.querySelector('.workout-state')?.textContent.trim() || null,
  doneBtn: !!document.querySelector('#workout-content .workout-done') }))

;(async () => {
  const live = loadFixture()
  // ---------- 2 + 3: every past date against the cloud rows; reload; pull; zero writes ----------
  console.log('\n[2] past dates render what was logged + completion state')
  {
    const { browser, page, errors } = await boot({ app, seed: live })
    const bootWrites = await writes(page)
    const sessions = live.training_sessions.filter((s) => s.date < TODAY).sort((a, b) => a.date.localeCompare(b.date))
    const pass1 = {}
    for (const s of sessions) {
      await openTrain(page, s.date)
      const dom = await domCells(page), st = await pastState(page)
      pass1[s.date] = dom
      const logged = Object.values(dbCells(live, s.id)).filter((c) => c.done || c.reps !== '' || c.weight !== '').length
      await check(`${s.date} ${s.status.padEnd(11)} ${String(logged).padStart(2)} logged cells → ${Object.keys(dom).length} rendered match DB; state "${st.meta}"`, async () => {
        compareDate(live, s, dom)
        const want = s.status === 'done' ? 'Completed' : logged ? 'In progress · not marked complete' : 'Not started'
        assert.equal(st.meta, want); assert.equal(st.foot, want); assert.equal(st.doneBtn, false, 'no Mark-complete button on a locked past day')
        if (!logged) assert.ok(Object.values(dom).every((c) => !c.done && !c.reps && !c.weight), '0-logged date renders empty')
      })
    }
    await check('in_progress dates (09-11, 09-25) are not shown as complete', async () => {
      for (const d of ['2026-09-11', '2026-09-25']) { await openTrain(page, d); const st = await pastState(page); assert.equal(st.foot, 'In progress · not marked complete', d) }
    })
    await check('Phase 12 metrics shown read-only on the 4 past dates that recorded them', async () => {
      // What the fixture recorded, per date: the item's scales and distance, and its logged duration.
      const want = {}
      live.training_sessions.forEach((s) => s.snapshot.blocks.forEach((blk, b) => blk.items.forEach((it, i) => {
        if (!it.metrics || !Object.keys(it.metrics).length) return
        const sec = live.training_session_sets.find((r) => r.session_id === s.id && r.block_idx === b && r.item_idx === i && r.set_idx === 0)?.duration_sec
        want[s.date] = { effort: it.metrics.effort ?? null, stamina: it.metrics.stamina ?? null,
          dist: it.metrics.distanceMi != null ? String(it.metrics.distanceMi) : null, dur: sec != null ? String(Math.round(sec / 60)) : null }
      })))
      assert.deepEqual(Object.keys(want).sort(), ['2026-09-15', '2026-09-17', '2026-09-22', '2026-09-29'])
      for (const [d, w] of Object.entries(want)) {
        await openTrain(page, d)
        const got = await page.evaluate(() => [...document.querySelectorAll('.metrics-strip')].map((m) => ({ record: m.classList.contains('is-record'),
          on: [...m.querySelectorAll('.scale-row')].map((r) => +r.querySelector('.scale-btn.on')?.textContent || null), dur: m.querySelector('select').value,
          dist: m.querySelector('input[type=number]')?.value ?? null, enabled: [...m.querySelectorAll('button,select,input')].filter((x) => !x.disabled).length })))
        assert.equal(got.length, 1, `${d}: one strip`)
        assert.ok(got[0].record && got[0].enabled === 0, `${d}: read-only`)
        assert.deepEqual(got[0].on, [w.effort, w.stamina], `${d}: scales`)
        if (w.dist) assert.equal(got[0].dist, w.dist)
        if (w.dur) assert.equal(got[0].dur, w.dur)
      }
    })
    await check('logged value contrast on a locked past day ≥ 4.5:1 (was 3.0 dark / 2.5 light)', async () => {
      for (const scheme of ['dark', 'light']) {
        await page.evaluate((s) => { state.theme = s; applyTheme() }, scheme); await openTrain(page, '2026-09-16')
        const cr = await page.evaluate(() => {
          const parse = (c) => { const m = c.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 } }
          const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
          const over = (fg, bg, a) => ({ r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) })
          const card = parse(getComputedStyle(document.querySelector('#workout-content .ex-row')).backgroundColor)
          const inp = [...document.querySelectorAll('#workout-content .set-input')].find((i) => i.value)
          const op = +getComputedStyle(inp.closest('.set-table')).opacity, v = parse(getComputedStyle(inp).color)
          const [x, y] = [lum(over(v, card, v.a * op)), lum(card)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05)
        })
        console.log(`        ${scheme}: ${cr.toFixed(2)}:1`)
        assert.ok(cr >= 4.5, `${scheme} ${cr}`)
      }
    })
    console.log('\n[3] survives reload and pull; viewing writes nothing')
    const beforeReload = await writes(page)
    await page.reload(); await settle(page)
    await page.evaluate(() => Sync.pull()); await page.waitForTimeout(300)
    for (const s of sessions) {
      await openTrain(page, s.date)
      const dom = await domCells(page)
      await check(`${s.date} identical after reload + pull`, async () => { assert.deepEqual(dom, pass1[s.date]); compareDate(live, s, dom) })
    }
    const after = await writes(page)
    // A fresh device's first sync runs backfillFromLocal (idempotent upserts, unchanged from HEAD);
    // what matters here is that viewing, reloading and pulling add nothing on top of it.
    await check(`writes: first-sync backfill ${bootWrites}; +${beforeReload - bootWrites} from viewing every date; +${after - beforeReload} from reload + pull + viewing again`, async () => {
      assert.equal(beforeReload - bootWrites, 0); assert.equal(after - beforeReload, 0)
    })
    await check('no page errors', async () => assert.deepEqual(errors, []))
    await browser.close()
  }

  // ---------- 4: edit mode on the fixed read path ----------
  console.log('\n[4] Phase 17 edit mode on top of the fixed read path')
  {
    const { browser, page, errors } = await boot({ app, seed: live })
    await openTrain(page, '2026-10-05')
    const sel = (f) => `#workout-content .set-input[onchange^="logBlockSet(0,2,0,0,'${f}'"]`
    // The cell under edit, as the fixture has it. The edit writes values the fixture can never hold
    // (reps 5–15, weights in 5 lb steps), so a pass can't come from the old value.
    const orig = live.training_session_sets.find((r) => r.session_id === 's_2026-10-05_mon-lower-core' && r.block_idx === 2 && r.item_idx === 0 && r.set_idx === 0)
    await check('locked: inputs not interactive, Edit button present', async () => {
      assert.equal(await page.evaluate((s) => getComputedStyle(document.querySelector(s)).pointerEvents, sel('reps')), 'none')
      assert.ok(await page.$('.past-edit-btn'))
    })
    await page.click('.past-edit-btn'); await page.waitForTimeout(100)
    await check('unlocked: values still shown, foot offers "Mark not done", no status line', async () => {
      assert.equal(await page.inputValue(sel('reps')), String(+orig.reps))
      assert.match(await page.textContent('.workout-done'), /Mark not done/)
      assert.equal(await page.$('.workout-state'), null)
    })
    await page.fill(sel('reps'), '77'); await page.dispatchEvent(sel('reps'), 'change')
    await page.fill(sel('weight'), '333'); await page.dispatchEvent(sel('weight'), 'change')
    await page.waitForTimeout(600)
    const row = await page.evaluate(() => JSON.parse(localStorage.getItem('__mockdb')).training_session_sets.find((r) => r.session_id === 's_2026-10-05_mon-lower-core' && r.block_idx === 2 && r.item_idx === 0 && r.set_idx === 0))
    await check(`change pushed to cloud row: reps ${row.reps}, weight ${row.weight}, done ${row.done}`, async () => { assert.equal(+row.reps, 77); assert.equal(+row.weight, 333); assert.equal(row.done, true) })
    await page.click('.past-edit-done'); await page.waitForTimeout(100)
    await page.reload(); await settle(page); await openTrain(page, '2026-10-05')
    await check('after lock + reload + pull: 77 × 333 shown read-only, still Completed', async () => {
      assert.equal(await page.inputValue(sel('reps')), '77'); assert.equal(await page.inputValue(sel('weight')), '333')
      assert.equal((await pastState(page)).foot, 'Completed')
    })
    await check('unlock → Mark not done → in progress; Mark complete → Completed', async () => {
      await page.click('.past-edit-btn'); await page.click('.workout-done'); await page.waitForTimeout(300)
      assert.equal(await page.evaluate(() => state.sessions['2026-10-05'].status), 'in_progress')
      await page.click('.workout-done'); await page.waitForTimeout(300)
      assert.equal(await page.evaluate(() => state.sessions['2026-10-05'].status), 'done')
      await page.click('.past-edit-done'); assert.equal((await pastState(page)).foot, 'Completed')
    })
    await check('no page errors', async () => assert.deepEqual(errors, []))
    await browser.close()
  }

  // ---------- 5: per-set last time ----------
  console.log('\n[5] per-set last time (clock on Tue 2026-10-13: week 5, not a deload, so the suggestion rule can fire)')
    const T5 = '2026-10-13'
  {
    // Seeded on top of the fixture (Tuesdays run tue-upper-traps-z2; the last one done is 09-29).
    // Items are picked by position in that session, so the test never depends on exercise names:
    //   top    (block 0 item 0)  → 8 × 155 on every set: the top of its 6–8 range, so a suggestion shows
    //   short  (block 0 item 2)  set 2 removed: history shorter than today
    //   long   (block 0 item 3)  gains sets 3 and 4 (99 × 99, 98 × 98): history longer than today
    //   none   (block 1 item 1)  every history row removed: no history
    const seed = JSON.parse(JSON.stringify(live))
    const S = 's_2026-09-29_tue-upper-traps-z2'
    const snap = seed.training_sessions.find((s) => s.id === S).snapshot
    const at = (b, i) => ({ b, i, id: snap.blocks[b].items[i].exerciseId, name: snap.blocks[b].items[i].name })
    const bench = at(0, 0), ohp = at(0, 2), rows = at(0, 3), farmer = at(1, 1)
    assert.equal(snap.blocks[0].items[0].repsText, '6–8', 'the top item still tops out at 8')
    seed.training_session_sets.forEach((r) => { if (r.session_id === S && r.block_idx === bench.b && r.item_idx === bench.i) Object.assign(r, { reps: 8, weight: 155, done: true }) })
    seed.training_session_sets = seed.training_session_sets.filter((r) => !(r.session_id === S && r.block_idx === ohp.b && r.item_idx === ohp.i && r.set_idx === 1))
    seed.training_session_sets.push({ ...seed.training_session_sets.find((r) => r.session_id === S && r.block_idx === rows.b && r.item_idx === rows.i), set_idx: 2, reps: 99, weight: 99 },
      { ...seed.training_session_sets.find((r) => r.session_id === S && r.block_idx === rows.b && r.item_idx === rows.i), set_idx: 3, reps: 98, weight: 98 })
    const farmerSessions = new Set(seed.training_sessions.filter((s) => s.snapshot.blocks.some((bl) => bl.items.some((x) => x.exerciseId === farmer.id))).map((s) => s.id))
    seed.training_session_sets = seed.training_session_sets.filter((r) => { const s = seed.training_sessions.find((x) => x.id === r.session_id); return !(farmerSessions.has(r.session_id) && s.snapshot.blocks[r.block_idx]?.items[r.item_idx]?.exerciseId === farmer.id) })

    // Oracle, independent of the app: most recent done session before today with this exercise logged.
    const oracle = (exId) => {
      for (const s of seed.training_sessions.filter((x) => x.status === 'done' && x.date < T5).sort((a, b) => b.date.localeCompare(a.date))) {
        for (let b = 0; b < s.snapshot.blocks.length; b++) for (let i = 0; i < s.snapshot.blocks[b].items.length; i++) {
          const it = s.snapshot.blocks[b].items[i]
          if (it.exerciseId !== exId || it.hidden || it.removed || !(+it.sets > 0)) continue
          const cells = seed.training_session_sets.filter((r) => r.session_id === s.id && r.block_idx === b && r.item_idx === i && (r.done || r.reps != null || r.weight != null) && r.reps != null)
          if (!cells.length) continue
          const per = []; cells.forEach((c) => { per[c.set_idx] = +c.weight > 0 ? `${+c.reps} × ${+c.weight}` : `${+c.reps} reps` }); return { date: s.date, per }
        }
      }
      return null
    }
    // The live plan has progression switched off; switch it on so the suggestion line is exercised.
    seed.training_plan[0].data.programs.hybrid190.progression = {enabled: true, appliesTo: 'allStrength',
      rules: [{id: 'topOfRange', trigger: 'topOfRange', categories: ['strength', 'hypertrophy'], increments: {upper: 5, lower: 10, default: 5}, requireAllSets: false}]}
    const { browser, page, errors } = await boot({ app, seed, now: T5 + 'T10:00:00' })
    await openTrain(page, T5)
    const w0 = await writes(page)
    const items = await page.evaluate(() => {
      const s = Session.resolve(todayKey()).session
      return [...document.querySelectorAll('#workout-content .ex-row')].map((row) => {
        const rowsEl = [...row.querySelectorAll('.set-table.editable-only')]
        const m = rowsEl[0] && /logBlockSet\(\d+,(\d+),(\d+)/.exec(rowsEl[0].querySelector('.set-input').getAttribute('onchange'))
        const it = m ? s.snapshot.blocks[+m[1]].items[+m[2]] : null
        return { name: row.querySelector('.ex-name-display')?.textContent, exId: it?.exerciseId, blockType: m ? s.snapshot.blocks[+m[1]].type : null, sets: rowsEl.length,
          figures: rowsEl.map((r) => { const a = r.querySelector('.set-last-reps')?.textContent, b = r.querySelector('.set-last-lbs')?.textContent
            return a == null ? (b == null ? null : 'LBS WITHOUT REPS') : b == null ? `${a} reps` : `${a} × ${b}` }), line: row.querySelector('.ex-last')?.textContent ?? null, suggest: row.querySelector('.ex-suggest-text')?.textContent ?? null }
      })
    })
    const SKIP = new Set(['warmup', 'mobility', 'agility', 'conditioning', 'cooldown', 'sport'])
    for (const it of items.filter((x) => x.exId)) {
      const o = SKIP.has(it.blockType) ? null : oracle(it.exId)
      const want = Array.from({ length: it.sets }, (_, s) => o?.per[s] ?? null)
      await check(`${it.name.padEnd(24)} figures [${it.figures.map((f) => f ?? '—').join(', ')}]  line "${it.suggest || it.line || ''}"`, async () => {
        assert.deepEqual(it.figures, want)
        if (!o) assert.equal(it.line, null, 'no history → no line')
        // the line never repeats a figure the rows carry
        const text = it.suggest || it.line || ''
        for (const f of want.filter(Boolean)) { assert.ok(!text.includes(f), `line repeats "${f}"`); const [r, x, wt] = f.split(' '); if (wt) assert.ok(!new RegExp(`\\b${wt}\\b`).test(text), `line repeats weight ${wt}`) }
      })
    }
    await check('edge cases present: shorter history blank, longer ignored, no history absent, suggestion shown', async () => {
      const by = Object.fromEntries(items.map((x) => [x.name, x]))
      assert.equal(by[ohp.name].figures[1], null); assert.ok(by[ohp.name].figures[0])
      // history has 4 sets (seeded 99×99 and 98×98), today prescribes 3: the 4th is never shown
      assert.equal(by[rows.name].sets, 3); assert.equal(by[rows.name].figures[2], '99 × 99')
      assert.ok(!by[rows.name].figures.some((f) => /98/.test(f || '')))
      assert.equal(by[bench.name].sets, 4); assert.equal(by[bench.name].figures[3], null)   // 3 sets last time, 4 today
      assert.ok(by[farmer.name].figures.every((f) => f === null)); assert.equal(by[farmer.name].line, null)
      assert.match(by[bench.name].suggest || '', /try \d+ today/)
    })
    await check('tick rows carry no per-set figure', async () => assert.equal(await page.$$eval('#workout-content .hiit-row .set-last', (x) => x.length), 0))
    await check('past days carry no per-set figures', async () => { await openTrain(page, '2026-09-29'); assert.equal(await page.$$eval('.set-last', (x) => x.length), 0) })
    await check('zero writes while rendering last-time, and no session materialized for today', async () => {
      await openTrain(page, T5); await page.evaluate(() => renderWorkoutContent())
      assert.equal(await writes(page), w0)
      assert.equal(await page.evaluate(() => !!state.sessions[todayKey()]), false)
    })
    await check('no page errors', async () => assert.deepEqual(errors, []))
    await browser.close()
  }

  // ---------- 6: layout ----------
  console.log('\n[6] layout: 375/430 × dark/light × today (with last-time) / past locked / past unlocked')
  for (const width of [375, 430]) for (const scheme of ['dark', 'light']) {
    const { browser, page, errors } = await boot({ app, seed: live, width })
    const logs = []; page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && logs.push(m.text()))
    await page.evaluate((s) => { state.theme = s; applyTheme() }, scheme)
    for (const [label, date, unlock] of [['today', TODAY, false], ['past', '2026-10-05', false], ['past-edit', '2026-10-05', true], ['past-inprog', '2026-09-25', false]]) {
      await openTrain(page, date)
      if (unlock) await page.click('.past-edit-btn')
      const r = await page.evaluate(() => {
        const bad = []
        const docOver = document.documentElement.scrollWidth - document.documentElement.clientWidth
        let rowsN = 0, withLast = 0
        document.querySelectorAll('#workout-content .set-table.editable-only').forEach((row) => {
          rowsN++; const rr = row.getBoundingClientRect()
          ;[...row.children].forEach((c) => { const b = c.getBoundingClientRect(); if (b.right > rr.right + 0.5 || b.left < rr.left - 0.5) bad.push('child outside row: ' + c.className) })
          row.querySelectorAll('.set-input').forEach((i) => { const b = i.getBoundingClientRect(); if (b.height < 43.99 || b.width < 43.99) bad.push(`input ${b.width}x${b.height}`) })
          const k = row.querySelector('.set-check').getBoundingClientRect(); if (k.height < 43.99 || k.width < 43.99) bad.push(`check ${k.width}x${k.height}`)
          const [ri, wi] = row.querySelectorAll('.set-input'), mid = (e) => { const b = e.getBoundingClientRect(); return b.left + b.width / 2 }
          const lr = row.querySelector('.set-last-reps'), lw = row.querySelector('.set-last-lbs')
          if (lr) { withLast++; if (Math.abs(mid(lr) - mid(ri)) > 1) bad.push(`reps figure off-centre ${mid(lr) - mid(ri)}`); if (lr.scrollWidth > lr.clientWidth) bad.push('reps figure truncated') }
          if (lw) { if (Math.abs(mid(lw) - mid(wi)) > 1) bad.push(`lbs figure off-centre ${mid(lw) - mid(wi)}`); if (lw.scrollWidth > lw.clientWidth) bad.push('lbs figure truncated')
            if (Math.abs(lw.getBoundingClientRect().top - lr.getBoundingClientRect().top) > 0.5) bad.push('figures not on one line') }
          if (lr || lw) { const below = (lr || lw).getBoundingClientRect().top >= ri.getBoundingClientRect().bottom - 0.5; if (!below) bad.push('figure not below inputs') }
        })
        const st = document.querySelector('.workout-state'); if (st && st.getBoundingClientRect().height < 43.99) bad.push('state < 44')
        return { docOver, rowsN, withLast, bad: [...new Set(bad)] }
      })
      await check(`${width} ${scheme.padEnd(5)} ${label.padEnd(11)} rows ${String(r.rowsN).padStart(2)}, with last-time ${String(r.withLast).padStart(2)}, overflow ${r.docOver}px`, async () => {
        assert.equal(r.docOver, 0); assert.deepEqual(r.bad, [])
      })
      if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/${width}-${scheme}-${label}.png` })
      if (unlock) await page.click('.past-edit-done')
    }
    await check(`${width} ${scheme} console/page errors: ${errors.length + logs.length}`, async () => assert.deepEqual([...errors, ...logs], []))
    await browser.close()
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
