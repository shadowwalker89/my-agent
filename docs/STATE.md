# STATE (update in every PR)

## Current phase
R0.7 domain extraction (R0.7c notes)

## Done
- R0.1 governance (`chore/r0-1-governance`) — ADR index (`0000`, `0001`), `docs/STATE.md`, `scripts/check-structure.mjs` + `scripts/legacy-sizes.json`, CI structure lint step.
- R0.2 safety net (`test/r0-2-safety-net`) — `eval/golden-persian.json` (113 new cases; 183 total with `intent-synthetic.json`), `scripts/test-golden.mjs` (660 checks + `node:sqlite` migrations 0001–0003 round-trip), `docs/adr/0002-offline-d1-test-harness.md`.
- R0.3 split tests (`test/r0-3-split-tests`) — split 8,547-line `scripts/test-dev.mjs` into 24-line orchestrator + `scripts/tests/harness.mjs` + 6 modular suites (2,633 checks).
- R0.4 channel extraction (`refactor/r0-4-channel-telegram`) — extracted `src/channels/telegram.js` (239 lines) and `src/pipeline/respond.js` (156 lines); shrank `src/telegram.js` to 16-line shim (14 legacy exceptions); enforced layer import direction in `scripts/check-imports.mjs`.
- R0.5 scheduler extraction (`refactor/r0-5-scheduler`) — extracted `src/platform/scheduler/index.js` (95 lines) and `scripts/tests/08-platform-scheduler.test.mjs` (210 lines); shrank `src/everyday.js` (3044→3010) and `src/index.js` (2370→2341).
- R0.6 pipeline extraction (`refactor/r0-6-pipeline`) — extracted `src/pipeline/validate.js` (235), `src/pipeline/route.js` (233), and `src/pipeline/interpret.js` (248); shrank `src/interpreter.js` and `src/task-route.js` to shims; shrank `src/intent.js` (240 lines) and removed it from `scripts/legacy-sizes.json` (13 legacy exceptions); shrank `src/everyday.js` (3010→2914); added `scripts/tests/09-pipeline.test.mjs`.
- R0.7a domain reminders (`refactor/r0-7a-domain-reminders`) — extracted `src/domain/reminders/time.js` and `src/domain/reminders/parse.js`; shrank `src/daily.js` (967→670) and `src/everyday.js` (2914→2910); added `scripts/tests/10-domain-reminders.test.mjs`.
- R0.7b domain tasks & projects (`refactor/r0-7b-domain-tasks`) — extracted `src/domain/tasks/parse.js`, `projects.js`, and `service.js` (< 250 lines each); shrank `src/daily.js` (670→508) and `src/everyday.js` (2910→2649); added `scripts/tests/11-domain-tasks.test.mjs`.
- R0.7c domain notes (`refactor/r0-7c-domain-notes`) — extracted `src/domain/notes/` modules (< 250 lines each) from `src/daily.js` and `src/everyday.js`; tightened `scripts/legacy-sizes.json`; added `scripts/tests/12-domain-notes.test.mjs`.

## In progress
- R0.7 incremental domain/skill extraction (`expenses` -> `vault` -> `media`)

## Decisions
- ADR index: `docs/adr/` (`0001-initial-decisions.md` D1–D21, `0002-offline-d1-test-harness.md`).

## Known issues / risks
- Legacy modules above 300 lines are recorded in `scripts/legacy-sizes.json`; they may only shrink.
- `src/daily.js` does not yet parse `درهم`/`AED` (pinned as a documented known gap in `eval/golden-persian.json`; scheduled for R3 multi-currency accounting per Contract v3 §7.1 & §11.3).
- `wrangler.jsonc` still defines 4 cron triggers; consolidation to a single `* * * * *` cron + `schedules` table is scheduled for R1 per Contract v3 §5 & §8.

## Measurements (fill during R1)
- CPU per invocation (worst cases): 
- D1 rows read/written per day: 
- Workers AI neurons per day: 
- Actions minutes per month: 

## Next step
- R0.7d domain expenses extraction: extract `src/domain/expenses/` from `src/everyday.js` and `src/daily.js`.
