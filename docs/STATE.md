# STATE (update in every PR)

## Current phase
R0.2 safety net

## Done
- R0.1 governance: ADR index, STATE, structure lint.
- R0.2 offline safety net: `eval/golden-persian.json` plus the existing 70 synthetic cases, deterministic golden runner, and real migration smoke check on `node:sqlite`.

## In progress
- `test/r0-2-safety-net` — golden Persian dataset (113 new cases, 183 combined), `scripts/test-golden.mjs`, ADR 0002.

## Decisions
- ADR index: docs/adr/ (initial decisions D1–D21 in `docs/adr/0001-initial-decisions.md`).
- ADR 0002: offline D1 testing uses zero-dependency `node:sqlite` with the real migration SQL; `@cloudflare/vitest-pool-workers` stays optional/deferred to workerd-binding tests.

## Known issues / risks
- AGENTS.md still references "Decision Log D1–D14"; `docs/contract-v3.md` now records D1–D21 (this PR does not edit AGENTS.md).
- Legacy modules above 300 lines are recorded in `scripts/legacy-sizes.json`; they may only shrink.
- `src/daily.js` does not recognise `درهم` (AED/dirham), so Contract §7.1's «امروز ۲۵۰ درهم ناهار» currently fails the amount validator. R0.2 pins this as a documented known gap in `eval/golden-persian.json`; the fix belongs to the R2 accounting work.
- The offline D1 harness needs Node 22+ (`node:sqlite`); it does not cover workerd bindings, cron, or CPU limits.

## Measurements (fill during R1)
- CPU per invocation (worst cases): 
- D1 rows read/written per day: 
- Workers AI neurons per day: 
- Actions minutes per month: 

## Next step
- R0.3: split `scripts/test-dev.mjs` into module-sized test files.
