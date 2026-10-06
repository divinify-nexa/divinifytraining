# Tests

These are the only automated tests in the repo. They cover the session sync path (Phase 11 onward),
past-day rendering and the per-set "last time" figures (4b1ce46), and day-pill navigation (a03176f).
**Phases 1–16 are otherwise uncovered**: food log, nutrition, story cards, Artemis, Progress, the
Programs manager beyond opening a schedule row, the plan editor, the rest timer and the scanner have
no automated test.

| File | Kind | Covers |
|---|---|---|
| `session-sync.test.js` | `node:test`, no browser | The `Session` module sliced out of `index.html`: every set and status write is queued before it is pushed, released once confirmed, and a lost completion is repaired by `reconcileLegacyDone`. |
| `browser/past-days-and-last-time.js` | Headless Chromium | Past dates render exactly what was logged (checked against the backend rows), with completion state, read-only Phase 12 metrics and readable contrast. Survives reload and pull with zero writes. Phase 17 edit unlock writes and persists. Per-set last time: reps under Reps, weight under lbs, edge cases, no repeated figures, zero writes. Layout at 375/430px, dark/light. |
| `browser/day-pills-navigation.js` | Headless Chromium | Day pills navigate to the viewed week's dates; the window limit; date nav and pills in sync; no `activeDay` or "Plan preview" left; past/today/future rules and the divergence note after the merge; pill done/skipped/today states; Programs → schedule row still opens its template. |
| `browser/harness.js` | Helper | Boots `index.html` in Chromium with the mock backend, external requests blocked and the clock fixed at 2026-10-06. |
| `browser/mock-supabase.js` | Helper | In-memory stand-in for supabase-js; persists across reloads and logs every write. |
| `browser/fixtures/sessions-2026-09.json` | Data | Synthetic data. 12 sessions (2026-09-11 to 2026-10-05) with their set rows, completion flags and a plan built on the app's built-in programs. Exercises are invented ("Strength Lift 07"), reps, weights, durations and metrics are generated, and timestamps are noon on each date. Profile is a stub; weights, PRs, water and food are empty. |

## Running

```sh
node --test tests/session-sync.test.js          # no dependencies

npm i --no-save playwright-core                 # the browser tests only; not a repo dependency
node tests/browser/past-days-and-last-time.js   # exit 0 when every check passes
node tests/browser/day-pills-navigation.js
```

Each browser test takes an optional path to another `index.html` (for example a `git archive` export of an
older commit) for before/after runs. Chromium comes from `$CHROMIUM_PATH`, else the newest Playwright
headless shell in the user cache. `SHOTS_DIR=dir` keeps the layout screenshots from the past-days test.
