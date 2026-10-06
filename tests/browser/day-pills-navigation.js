// day-pills-navigation.js — browser test for a03176f (day pills navigate to dates).
//   [1] from Tue Oct 6: MON → Mon Oct 5 read-only and Completed; THU → Thu Oct 8 as a future preview;
//       pills past the +28-day window are disabled and never navigate; date nav and pills stay in sync
//   [2] no activeDay / setDay / data-preview / session-only / "Plan preview" left in the source, and
//       no "Plan preview" rendered on any date from 21 days back to the end of the window
//   [3] past edit unlock still writes and persists; future refuses logging with zero writes; today
//       materializes and pushes; the Phase 13 divergence note (and Reset, today only) still appear
//   [4] pill states: selected = viewed day, today ring only when today is not selected, done and
//       skipped marks across weeks with mixed statuses
//   [5] Programs → program → schedule row still opens that row's template and returns to Programs
//       without moving the Train tab
// Run: node tests/browser/day-pills-navigation.js [path/to/index.html]
const { boot, settle, loadFixture, appPath } = require('./harness')
const assert = require('node:assert/strict')
const fs = require('fs')
const app = appPath()
let pass = 0, fail = 0
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ', name) } catch (e) { fail++; console.log('  FAIL', name, '\n       ', String(e.message).split('\n').slice(0, 6).join('\n        ')) }
}
const writes = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('__writes') || '[]').length)
const train = (page) => page.evaluate(() => showPage('workout', document.querySelector('nav .nav-btn[onclick*="workout"]')))
const pill = (page, label) => page.click(`#day-pills .pill:text-is("${label}")`)
const view = (page) => page.evaluate(() => ({
  date: viewKey(), nav: document.querySelector('#date-nav-workout .date-nav-label span')?.textContent,
  active: [...document.querySelectorAll('#day-pills .pill.active')].map((p) => p.textContent.trim()),
  pills: [...document.querySelectorAll('#day-pills .pill')].map((p) => ({ l: p.textContent.trim(), cls: [...p.classList].filter((c) => c !== 'pill').sort().join(' '), dis: p.disabled })),
  sub: document.getElementById('train-sub')?.textContent, readonly: document.body.dataset.readonly,
  state: document.querySelector('.workout-state')?.textContent.trim() || null,
  filled: [...document.querySelectorAll('#workout-content .set-input')].filter((i) => i.value).length,
  inputsLive: [...document.querySelectorAll('#workout-content .set-input')].some((i) => getComputedStyle(i.closest('.editable-only')).pointerEvents !== 'none'),
  planPreview: /Plan preview/.test(document.getElementById('page-workout').textContent),
  doneBtn: document.querySelector('.workout-done')?.textContent.trim().replace(/\s+/g, ' ') || null,
  diverged: document.querySelector('.workout-meta-note.diverged')?.textContent || null, reset: !!document.querySelector('.meta-reset'),
}))

;(async () => {
  // Seed on the fixture: a skipped Wednesday in the week of 09-21 (mixed statuses: done, done,
  // skipped, in progress) and a started session today on Monday's template (diverged → Reset).
  const seed = loadFixture()
  const mon = seed.training_sessions.find((s) => s.date === '2026-10-05')
  seed.training_sessions.push({ ...JSON.parse(JSON.stringify(seed.training_sessions.find((s) => s.date === '2026-09-22'))), id: 's_2026-09-23_skip', date: '2026-09-23', status: 'skipped', completed_at: null })
  const todaySession = { ...JSON.parse(JSON.stringify(mon)), id: 's_2026-10-06_mon-lower-core', date: '2026-10-06', status: 'in_progress', completed_at: null }
  const { browser, page, errors } = await boot({ app, seed })
  // the harness aborts every external request (fonts), which Chromium logs as a failed resource
  const logs = []; page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && logs.push(m.text()))
  await train(page)

  console.log('\n[1] pills navigate')
  let v = await view(page)
  await check(`start: ${v.date} "${v.nav}", active pill ${v.active}`, async () => { assert.equal(v.date, '2026-10-06'); assert.deepEqual(v.active, ['TUE']) })
  const w0 = await writes(page)
  await pill(page, 'MON'); v = await view(page)
  await check(`tap MON → ${v.date} "${v.nav}" · ${v.sub} · ${v.filled} values · "${v.state}" · read-only ${v.readonly}`, async () => {
    assert.equal(v.date, '2026-10-05'); assert.equal(v.nav, 'Mon, Oct 5'); assert.deepEqual(v.active, ['MON'])
    assert.equal(v.state, 'Completed'); assert.equal(v.readonly, 'true'); assert.equal(v.inputsLive, false); assert.ok(v.filled >= 19)
    assert.ok(await page.$('.past-edit-btn'), 'Edit unlock offered')
  })
  await pill(page, 'THU'); v = await view(page)
  await check(`tap THU → ${v.date} "${v.nav}" · ${v.sub} · inputs interactive: ${v.inputsLive}`, async () => {
    assert.equal(v.date, '2026-10-08'); assert.deepEqual(v.active, ['THU']); assert.equal(v.readonly, 'true'); assert.equal(v.inputsLive, false)
    assert.match(v.sub, /Planned/); assert.equal(v.filled, 0)
  })
  await check(`no writes from pill navigation (+${(await writes(page)) - w0})`, async () => assert.equal(await writes(page), w0))
  await page.evaluate(() => setViewDate('2026-11-02')); v = await view(page)
  await check(`viewing ${v.date} (window ends ${await page.evaluate(() => lastPlannableDate())}): disabled ${v.pills.filter((p) => p.dis).map((p) => p.l).join(',')}`, async () => {
    assert.deepEqual(v.pills.filter((p) => p.dis).map((p) => p.l), ['WED', 'THU', 'FRI', 'SAT', 'SUN'])
    await page.click('#day-pills .pill:text-is("SAT")', { force: true }); assert.equal(await page.evaluate(() => viewKey()), '2026-11-02', 'disabled pill does not navigate')
    await page.evaluate(() => pickDay(5)); assert.equal(await page.evaluate(() => viewKey()), '2026-11-02', 'pickDay refuses past the window')
    await pill(page, 'TUE'); assert.equal(await page.evaluate(() => viewKey()), '2026-11-03', 'last day in window is reachable')
  })
  await page.evaluate(() => setViewDate('2026-10-06'))
  await check('date nav → pills: prev/next/today keep the active pill on the viewed weekday', async () => {
    for (const [act, want, lbl] of [['goPrevDay()', '2026-10-05', 'MON'], ['goPrevDay()', '2026-10-04', 'SUN'], ['goPrevDay()', '2026-10-03', 'SAT'], ['goNextDay()', '2026-10-04', 'SUN'], ['goToday()', '2026-10-06', 'TUE']]) {
      await page.click(`#date-nav-workout button[onclick="${act}"]`); const x = await view(page)
      assert.equal(x.date, want); assert.deepEqual(x.active, [lbl], `${act} → ${want}`)
    }
  })
  await check('pills → date nav: SUN from Tue Oct 6 is Sun Oct 11 (Mon-start week), label follows', async () => {
    await pill(page, 'SUN'); const x = await view(page); assert.equal(x.date, '2026-10-11'); assert.equal(x.nav, 'Sun, Oct 11')
    await pill(page, 'MON'); assert.equal((await view(page)).date, '2026-10-05')
  })

  console.log('\n[2] activeDay removed; no "Plan preview" anywhere')
  await check('source: no activeDay, setDay, data-preview, session-only or "Plan preview"', async () => {
    const src = fs.readFileSync(app, 'utf8')
    for (const w of ['activeDay', 'setDay(', 'data-preview', 'session-only', 'Plan preview']) assert.equal(src.split(w).length - 1, 0, w)
    assert.equal(await page.evaluate(() => typeof activeDay), 'undefined')
  })
  const scanned = []
  for (let d = -21; d <= 28; d++) {
    const date = await page.evaluate((d) => { setViewDate(shiftDateKey(todayKey(), d)); return viewKey() }, d)
    const x = await view(page); scanned.push(date)
    if (x.planPreview) { await check(`${date} shows Plan preview`, async () => assert.fail('Plan preview rendered')) }
    for (let i = 0; i < 7; i++) { if (x.pills[i].dis) continue }
  }
  await check(`no "Plan preview" on any of ${scanned.length} dates ${scanned[0]}..${scanned.at(-1)}, header never says "Plan preview"`, async () => assert.ok(true))

  console.log('\n[3] past / today / future behaviour after the merge')
  await page.evaluate(() => setViewDate('2026-10-05'))
  await check('past: unlock → edit a value → pushed → persists after lock + reload', async () => {
    await page.click('.past-edit-btn')
    const sel = `#workout-content .set-input[onchange^="logBlockSet(0,2,0,0,'reps'"]`
    await page.fill(sel, '77'); await page.dispatchEvent(sel, 'change'); await page.waitForTimeout(500)   // a value the fixture never holds
    const row = await page.evaluate(() => JSON.parse(localStorage.getItem('__mockdb')).training_session_sets.find((r) => r.session_id === 's_2026-10-05_mon-lower-core' && r.block_idx === 2 && r.item_idx === 0 && r.set_idx === 0))
    assert.equal(+row.reps, 77)
    await page.click('.past-edit-done'); await page.reload(); await settle(page); await train(page); await page.evaluate(() => setViewDate('2026-10-05'))
    assert.equal(await page.inputValue(sel), '77')
  })
  await page.evaluate(() => setViewDate('2026-10-08'))
  await check('future: logging refused, nothing written, nothing materialized', async () => {
    const before = await writes(page)
    await page.evaluate(() => logBlockSet(getViewDayIdx(), 0, 0, 0, 'reps', '5')); await page.waitForTimeout(300)
    assert.equal(await writes(page), before); assert.equal(await page.evaluate(() => !!state.sessions['2026-10-08']), false)
  })
  await pill(page, 'TUE')
  await check('today: tap TUE back to today, log a set → session materialized and pushed', async () => {
    const x = await view(page); assert.equal(x.date, '2026-10-06'); assert.equal(x.readonly, ''); assert.equal(x.inputsLive, true)
    const sel = `#workout-content .set-input[onchange*="'reps'"]`
    await page.fill(sel, '7'); await page.dispatchEvent(sel, 'change'); await page.waitForTimeout(500)
    const s = await page.evaluate(() => state.sessions['2026-10-06']); assert.ok(s, 'materialized'); assert.equal(s.status, 'in_progress')
    const db = await page.evaluate((id) => JSON.parse(localStorage.getItem('__mockdb')).training_session_sets.filter((r) => r.session_id === id && r.reps === 7).length, s.id)
    assert.equal(db, 1)
  })
  await browser.close()
  // Today's session started on Monday's template → the divergence note with Reset, reached by pill.
  {
    // plus a past in-progress session on Wed Sep 30 that was started on Monday's template
    const seed2 = JSON.parse(JSON.stringify(seed)); seed2.training_sessions.push(todaySession,
      { ...JSON.parse(JSON.stringify(mon)), id: 's_2026-09-30_mon-lower-core', date: '2026-09-30', status: 'in_progress', completed_at: null })
    seed2.training_session_sets.push({ ...seed.training_session_sets.find((r) => r.session_id === mon.id && r.block_idx === 2), session_id: todaySession.id })
    const b2 = await boot({ app, seed: seed2 }); await train(b2.page)
    await b2.page.evaluate(() => setViewDate('2026-10-01')); await pill(b2.page, 'WED')
    const p = await view(b2.page)
    await check(`past diverged (Wed Sep 30, by pill): "${(p.diverged || '').slice(0, 70)}…" reset ${p.reset}`, async () => {
      assert.equal(p.date, '2026-09-30'); assert.match(p.diverged || '', /Started as .* schedule now says/); assert.equal(p.reset, false)
    })
    await b2.page.evaluate(() => setViewDate('2026-10-05')); await pill(b2.page, 'TUE')
    const x = await view(b2.page)
    await check(`divergence + Reset on today after pill navigation: "${(x.diverged || '').slice(0, 70)}…" reset ${x.reset}`, async () => {
      assert.equal(x.date, '2026-10-06'); assert.match(x.diverged || '', /Started as/); assert.equal(x.reset, true)
    })
    await check('no page errors (second boot)', async () => assert.deepEqual(b2.errors, []))
    await b2.browser.close()
  }

  console.log('\n[4] pill states')
  {
    const b3 = await boot({ app, seed }); const p3 = b3.page; await train(p3)
    const cls = (x) => Object.fromEntries(x.pills.map((p) => [p.l, p.cls]))
    let x = await view(p3)
    await check(`viewing today (Tue Oct 6): ${JSON.stringify(cls(x))}`, async () => {
      assert.equal(cls(x).TUE, 'active'); assert.equal(cls(x).MON, 'done'); assert.ok(!x.pills.some((p) => /is-today/.test(p.cls)))
    })
    await p3.evaluate(() => setViewDate('2026-10-05')); x = await view(p3)
    await check(`viewing Mon Oct 5: ${JSON.stringify(cls(x))}`, async () => { assert.equal(cls(x).MON, 'active done'); assert.equal(cls(x).TUE, 'is-today') })
    await p3.evaluate(() => setViewDate('2026-09-24')); x = await view(p3)
    await check(`week of Sep 21 (done, done, skipped, viewed, in progress, –, –): ${JSON.stringify(cls(x))}`, async () => {
      assert.deepEqual(cls(x), { MON: 'done', TUE: 'done', WED: 'skipped', THU: 'active', FRI: '', SAT: '', SUN: '' })
    })
    await p3.evaluate(() => setViewDate('2026-09-17')); x = await view(p3)
    await check(`week of Sep 14 (planned Fri 09-18 has no dot): ${JSON.stringify(cls(x))}`, async () => {
      assert.deepEqual(cls(x), { MON: 'done', TUE: 'done', WED: 'done', THU: 'active done', FRI: '', SAT: '', SUN: '' })
    })

    console.log('\n[5] template browsing via Programs → schedule row')
    await p3.evaluate(() => setViewDate('2026-10-05'))
    const before = await p3.evaluate(() => ({ date: viewKey(), html: document.getElementById('workout-content').innerHTML.length }))
    for (const [i, lbl] of [[3, 'THU'], [0, 'MON']]) {
      await p3.evaluate(() => { Programs.open(); Programs.openProgram('hybrid190') })
      await p3.click(`[onclick="Programs.openDay(${i})"]`)
      const r = await p3.evaluate((i) => ({ open: document.getElementById('plan-editor').classList.contains('open'), tpl: PlanEditor.draft?.tplId,
        want: state.plan.programs.hybrid190.schedule[i].templateId, name: PlanEditor.draft?.name, date: viewKey() }), i)
      await p3.evaluate(() => PlanEditor.close())
      const back = await p3.evaluate(() => ({ owner: Sheet.owner === Programs, view: Programs.view, prog: Programs.progId, date: viewKey(), active: document.querySelector('#day-pills .pill.active')?.textContent }))
      await check(`${lbl} row → editor on "${r.name}" (${r.tpl}); close → Programs/${back.view}/${back.prog}; Train still ${back.date} ${back.active}`, async () => {
        assert.ok(r.open); assert.equal(r.tpl, r.want); assert.equal(r.date, before.date)
        assert.ok(back.owner); assert.equal(back.view, 'program'); assert.equal(back.prog, 'hybrid190'); assert.equal(back.date, before.date); assert.equal(back.active, 'MON')
      })
      await p3.evaluate(() => Sheet.close())
    }
    await check('no page errors (pill-state boot)', async () => assert.deepEqual(b3.errors, []))
    await b3.browser.close()
  }
  await check(`no page or console errors (main boot): ${JSON.stringify([...errors, ...logs])}`, async () => assert.deepEqual([...errors, ...logs], []))
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
