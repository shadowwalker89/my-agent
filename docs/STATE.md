# STATE (update in every PR)

## Current phase
R0.5 scheduler extraction

## Done
- R0.1 governance (`chore/r0-1-governance`) — ADR index (`0000`, `0001`), `docs/STATE.md`, `scripts/check-structure.mjs` + `scripts/legacy-sizes.json`, CI structure lint step.
- R0.2 safety net (`test/r0-2-safety-net`) — `eval/golden-persian.json` (113 new cases; 183 total with `intent-synthetic.json`), `scripts/test-golden.mjs` (660 checks + `node:sqlite` migrations 0001–0003 round-trip), `docs/adr/0002-offline-d1-test-harness.md`.
- R0.3 split tests (`test/r0-3-split-tests`) — split 8,547-line `scripts/test-dev.mjs` into 24-line orchestrator + `scripts/tests/harness.mjs` + 6 modular suites (2,633 checks).
- R0.4 channel extraction (`refactor/r0-4-channel-telegram`) — extracted `src/channels/telegram.js` (`Envelope`/`Reply` + Bot API transport) and `src/pipeline/respond.js` (HTML formatting + chunking); shrank `src/telegram.js` below 30 lines and removed it from `scripts/legacy-sizes.json` (14 legacy exceptions remain); added layer import direction lint in `scripts/check-imports.mjs`.
- R0.5 scheduler extraction (`refactor/r0-5-scheduler`) — extracted the reminder tick and cron dispatch to `src/platform/scheduler/index.js` (`CRON_PROVIDER`, `buildReminderMessage`, `isMidnightUtc`, `makeTelegramSendMessage`, `runReminderTick`, `runScheduledTick`); `src/everyday.js` now delegates `runReminderTick` and shrank 3044→3010, `src/index.js` now delegates `scheduled()` and shrank 2370→2341; added `scripts/tests/08-platform-scheduler.test.mjs` (2714 checks). Failure behaviour: claim failure returns `{ ok: false }`; failed delivery releases the claim and logs only the task id/reason, never user text; `syncProvider`/reminder errors are caught and logged. Quota impact: unchanged — same D1 calls, same sends, no KV writes, no new cron trigger.

## In progress
- (none — ready for R0.6)

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
- R0.6 pipeline extraction: move intent parsing / responder plumbing out of the legacy `everyday.js` shell into `src/pipeline/`


Acceptance Tests (Given / When / Then)
Given a Telegram message with forward_origin or forward_from, When toEnvelope(update) is called, Then envelope.provenance === "forwarded"; for a direct user message, envelope.provenance === "user".
Given a Reply object with Persian Markdown text and buttons, When renderReply(env, chatId, reply) runs, Then it calls Telegram sendMessage with HTML-formatted text and reply_markup.inline_keyboard.
Given src/telegram.js, src/channels/telegram.js, and src/pipeline/respond.js, When npm run lint:structure and npm run check run, Then all three files are under 250 lines, scripts/legacy-sizes.json has 14 entries (src/telegram.js removed), and layer import direction check passes.
Given `src/platform/scheduler/index.js` and the thin wrappers in `src/everyday.js` / `src/index.js`, When `npm run lint:structure` and `npm run check` run, Then the scheduler module is under 250 lines with no upward imports, `src/everyday.js` (3010) and `src/index.js` (2341) only shrank, and no new legacy exception was added.
Given a due reminder or a catalog cron, When `runReminderTick` / `runScheduledTick` runs, Then delivery behaves exactly as before (`r.telegram_id`, raw `inline_keyboard`, legacy labels, `telegram_send_failed` handling), catalog failures log `syncProvider(<provider>) failed:`, reminder failures log `reminder tick failed:`, and the Worker `scheduled()` still returns `undefined`.
Given the full offline test suite (npm run test:offline), When executed, Then all 2,714 checks (including new R0.5 scheduler tests) + 660 golden checks pass with 0 failures.
How to Run Tests
npm run check
npm run lint:structure
npm run test:offline 