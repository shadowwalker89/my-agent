# STATE (update in every PR)

## Current phase
R0.8 shrink `src/everyday.js` below 300 lines (R0.8a pipeline branches extracted)

## Done
- R0.1 governance (`chore/r0-1-governance`) — ADR index (`0000`, `0001`), `docs/STATE.md`, `scripts/check-structure.mjs` + `scripts/legacy-sizes.json`, CI structure lint step.
- R0.2 safety net (`test/r0-2-safety-net`) — `eval/golden-persian.json` (113 new cases; 183 total with `intent-synthetic.json`), `scripts/test-golden.mjs` (660 checks + `node:sqlite` migrations 0001–0003 round-trip), `docs/adr/0002-offline-d1-test-harness.md`.
- R0.3 split tests (`test/r0-3-split-tests`) — split 8,547-line `scripts/test-dev.mjs` into 24-line orchestrator + `scripts/tests/harness.mjs` + 6 modular suites (2,633 checks).
- R0.4 channel extraction (`refactor/r0-4-channel-telegram`) — extracted `src/channels/telegram.js` (239 lines) and `src/pipeline/respond.js` (156 lines); shrank `src/telegram.js` to 16-line shim (14 legacy exceptions); enforced layer import direction in `scripts/check-imports.mjs`.
- R0.5 scheduler extraction (`refactor/r0-5-scheduler`) — extracted `src/platform/scheduler/index.js` (95 lines) and `scripts/tests/08-platform-scheduler.test.mjs` (210 lines); shrank `src/everyday.js` (3044→3010) and `src/index.js` (2370→2341).
- R0.6 pipeline extraction (`refactor/r0-6-pipeline`) — extracted `src/pipeline/validate.js` (235), `src/pipeline/route.js` (233), and `src/pipeline/interpret.js` (248); shrank `src/interpreter.js` and `src/task-route.js` to shims; shrank `src/intent.js` (240 lines) and removed it from `scripts/legacy-sizes.json` (13 legacy exceptions); shrank `src/everyday.js` (3010→2914); added `scripts/tests/09-pipeline.test.mjs`.
- R0.7a domain reminders (`refactor/r0-7a-domain-reminders`) — extracted `src/domain/reminders/time.js` and `src/domain/reminders/parse.js`; shrank `src/daily.js` (967→670) and `src/everyday.js` (2914→2910); added `scripts/tests/10-domain-reminders.test.mjs`.
- R0.7b domain tasks & projects (`refactor/r0-7b-domain-tasks`) — extracted `src/domain/tasks/parse.js`, `projects.js`, and `service.js` (< 250 lines each); shrank `src/daily.js` (670→508) and `src/everyday.js` (2910→2649); added `scripts/tests/11-domain-tasks.test.mjs`.
- R0.7c domain notes (`refactor/r0-7c-domain-notes`) — extracted `src/domain/notes/parse.js`, `render.js`, and `service.js` (< 250 lines each); shrank `src/daily.js` (508→434) and `src/everyday.js` (2649→2501); added `scripts/tests/12-domain-notes.test.mjs`.
- R0.7d domain expenses (`refactor/r0-7d-domain-expenses`) — extracted `src/domain/expenses/` modules (< 250 lines each); shrank `src/daily.js` below 300 lines and removed it from `scripts/legacy-sizes.json`; shrank `src/everyday.js` further; added `scripts/tests/13-domain-expenses.test.mjs`.
- R0.7e platform vault & admin setup (`refactor/r0-7e-platform-vault`) — extracted `src/platform/vault/` modules and `src/admin/setup.js` (< 250 lines each); shrank `src/vault.js` and `src/connectors.js` to shims and removed both from `scripts/legacy-sizes.json`; shrank `src/everyday.js` further; added `scripts/tests/14-platform-vault.test.mjs`.
- R0.7f skills media, pdf & voice (`refactor/r0-7f-skills-media-pdf`) — extracted `src/skills/media/*` and `src/skills/pdf/*` (< 250 lines each); shrank `src/media.js`, `src/pdf.js`, and `src/voice.js` to shims and removed all three from `scripts/legacy-sizes.json`; shrank `src/everyday.js` further; added `scripts/tests/15-skills-media-pdf.test.mjs` (2,870 checks).
- R0.8a pipeline branches (`refactor/r0-8a-pipeline-branches`) — extracted chat context, model-slot branch, interpreter policy/runner, and NLU branch out of `src/everyday.js` into `< 250`-line modules under `src/pipeline/*`; tightened `scripts/legacy-sizes.json` (`src/everyday.js` 2,354→1,139); added `scripts/tests/16-pipeline-branches.test.mjs`.

## In progress
- R0.8b final `src/everyday.js` shell reduction below 300 lines

## Decisions
- ADR index: `docs/adr/` (`0001-initial-decisions.md` D1–D21, `0002-offline-d1-test-harness.md`).

## Known issues / risks
- Remaining legacy modules above 300 lines are recorded in `scripts/legacy-sizes.json` (7 files); they may only shrink.
- `src/domain/expenses/` does not yet parse `درهم`/`AED` (pinned as a documented known gap in `eval/golden-persian.json`; scheduled for R3 multi-currency accounting per Contract v3 §7.1 & §11.3).
- `wrangler.jsonc` still defines 4 cron triggers; consolidation to a single `* * * * *` cron + `schedules` table is scheduled for R1 per Contract v3 §5 & §8.

## Measurements (fill during R1)
- CPU per invocation (worst cases): 
- D1 rows read/written per day: 
- Workers AI neurons per day: 
- Actions minutes per month: 

## Next step
- R0.8b extract remaining `runDailyBranch`, `handleDailyText`, `resolveDailyCallback`, `handleIncomingFile`, and `/backup` out of `src/everyday.js` so `src/everyday.js` drops below 300 lines and is removed from `scripts/legacy-sizes.json` (completing Phase R0).
