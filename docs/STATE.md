# STATE (update in every PR)

## Current phase
R0.3 split tests

## Done
- R0.1 governance (`chore/r0-1-governance`) — ADR index (`0000`, `0001`), `docs/STATE.md`, `scripts/check-structure.mjs` + `scripts/legacy-sizes.json`, CI structure lint step.
- R0.2 safety net (`test/r0-2-safety-net`) — `eval/golden-persian.json` (113 new cases; 183 total with `intent-synthetic.json`), `scripts/test-golden.mjs` (660 checks + `node:sqlite` migrations 0001–0003 round-trip), `docs/adr/0002-offline-d1-test-harness.md`.
- R0.3 split tests (`test/r0-3-split-tests`) — split 8,547-line `scripts/test-dev.mjs` into `scripts/tests/harness.mjs` + modular test suites under `scripts/tests/`, keeping `scripts/test-dev.mjs` < 200 lines with 0 lost assertions.

## In progress
- (none — ready for R0.4)

## Decisions
- ADR index: `docs/adr/` (`0001-initial-decisions.md` D1–D21, `0002-offline-d1-test-harness.md`).

## Known issues / risks
- Legacy modules above 300 lines are recorded in `scripts/legacy-sizes.json`; they may only shrink.
- `src/daily.js` does not yet parse `درهم`/`AED` (pinned as a documented known gap in `eval/golden-persian.json`; scheduled for R3 multi-currency accounting per Contract v3 §7.1 & §11.3).

## Measurements (fill during R1)
- CPU per invocation (worst cases): 
- D1 rows read/written per day: 
- Workers AI neurons per day: 
- Actions minutes per month: 

## Next step
- R0.4 channel extraction: extract `src/channels/telegram.js` (Envelope/Reply) and move HTML formatting to `src/pipeline/respond.js`. 
