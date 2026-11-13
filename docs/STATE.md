# STATE (update in every PR)

## Current phase
R0.4 channel extraction

## Done
- R0.1 governance (`chore/r0-1-governance`) — ADR index (`0000`, `0001`), `docs/STATE.md`, `scripts/check-structure.mjs` + `scripts/legacy-sizes.json`, CI structure lint step.
- R0.2 safety net (`test/r0-2-safety-net`) — `eval/golden-persian.json` (113 new cases; 183 total with `intent-synthetic.json`), `scripts/test-golden.mjs` (660 checks + `node:sqlite` migrations 0001–0003 round-trip), `docs/adr/0002-offline-d1-test-harness.md`.
- R0.3 split tests (`test/r0-3-split-tests`) — split 8,547-line `scripts/test-dev.mjs` into 24-line orchestrator + `scripts/tests/harness.mjs` + 6 modular suites (2,633 checks).
- R0.4 channel extraction (`refactor/r0-4-channel-telegram`) — extracted `src/channels/telegram.js` (`Envelope`/`Reply` + Bot API transport) and `src/pipeline/respond.js` (HTML formatting + chunking); shrank `src/telegram.js` below 30 lines and removed it from `scripts/legacy-sizes.json` (14 legacy exceptions remain); added layer import direction lint in `scripts/check-imports.mjs`.

## In progress
- (none — ready for R0.5)

## Decisions
- ADR index: `docs/adr/` (`0001-initial-decisions.md` D1–D21, `0002-offline-d1-test-harness.md`).

## Known issues / risks
- Legacy modules above 300 lines are recorded in `scripts/legacy-sizes.json` (14 files); they may only shrink.
- `src/daily.js` does not yet parse `درهم`/`AED` (pinned as a documented known gap in `eval/golden-persian.json`; scheduled for R3 multi-currency accounting per Contract v3 §7.1 & §11.3).

## Measurements (fill during R1)
- CPU per invocation (worst cases): 
- D1 rows read/written per day: 
- Workers AI neurons per day: 
- Actions minutes per month: 

## Next step
- R0.5 scheduler extraction: extract reminder tick / scheduled jobs from `src/everyday.js` and `src/index.js` into `src/platform/scheduler/`


Acceptance Tests (Given / When / Then)
Given a Telegram message with forward_origin or forward_from, When toEnvelope(update) is called, Then envelope.provenance === "forwarded"; for a direct user message, envelope.provenance === "user".
Given a Reply object with Persian Markdown text and buttons, When renderReply(env, chatId, reply) runs, Then it calls Telegram sendMessage with HTML-formatted text and reply_markup.inline_keyboard.
Given src/telegram.js, src/channels/telegram.js, and src/pipeline/respond.js, When npm run lint:structure and npm run check run, Then all three files are under 250 lines, scripts/legacy-sizes.json has 14 entries (src/telegram.js removed), and layer import direction check passes.
Given the full offline test suite (npm run test:offline), When executed, Then all existing 2,633 checks + new R0.4 channel checks + 660 golden checks pass with 0 failures.
How to Run Tests
npm run check
npm run lint:structure
npm run test:offline 