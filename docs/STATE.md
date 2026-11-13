# STATE (update in every PR)

## Current phase
R0.1 governance

## Done
- (no merged R0.1 PRs yet; this PR starts governance)

## In progress
- `chore/r0-1-governance` — ADR index, STATE, structure lint

## Decisions
- ADR index: docs/adr/ (initial decisions D1–D21 in `docs/adr/0001-initial-decisions.md`)

## Known issues / risks
- AGENTS.md still references "Decision Log D1–D14"; `docs/contract-v3.md` now records D1–D21 (this PR does not edit AGENTS.md).
- Legacy modules above 300 lines are recorded in `scripts/legacy-sizes.json`; they may only shrink.

## Measurements (fill during R1)
- CPU per invocation (worst cases): 
- D1 rows read/written per day: 
- Workers AI neurons per day: 
- Actions minutes per month: 

## Next step
- R0.2 safety net: golden Persian dataset and workerd/D1 tests.
