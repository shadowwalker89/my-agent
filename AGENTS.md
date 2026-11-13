# AGENTS.md — my-agent (architecture contract v3.0)

This file is binding. If a task conflicts with it, STOP and ask the owner; do not improvise.
The source of truth for decisions is the "my-agent architecture contract v3.0" doc (Decision Log D1–D14). Changing a decision requires an ADR in `docs/adr/`.

## 1. Product in one paragraph
A single-owner, Persian-first personal assistant on Cloudflare Workers + D1 (+KV, R2 optional), reachable from Telegram (and later Bale). Hard constraint: **$0 cost** (Cloudflare Free, GitHub Actions free minutes, free providers). Others install their own independent instance; there is no multi-tenant mode and no family mode.

## 2. Naming (never mix)
- `Task` = a user's to-do item (project-based). `Job` = a background job (`outbox_jobs`).
- Reminder = a `remind_at` schedule on a Task/Note, not a separate life-cycle.

## 3. Tiers
- **T0 core (must not fail):** ingress + dedup, notes, tasks/projects, reminders, expenses, backup, approvals. Must work with the LLM completely down.
- **T1 skills (best effort, clear error to the user):** email, channel digests, contact messages (level A), image, PDF, vision, translate, video summary.
- **T2 experimental (kill-switch, no promises):** AI video, Account Runner (userbot), WhatsApp.
- T1/T2 code must never be on the critical path of T0.

## 4. Layers and import rules (enforced by lint)
```
channels → ingress → pipeline → domain / skills → platform
```
- Dependencies only point downward. `domain/` and `skills/` NEVER import from `channels/`.
- Only `pipeline/` talks to LLMs. The LLM output is an **Intent (a proposal)**, never a write.
- Database writes happen only inside a Domain **Command**: `validate()` → `execute()` (idempotent via `idempotency_key`) → `undo()`.
- Channel adapters only convert to/from `Envelope` / `Reply`; they contain no business logic.

## 5. Hard invariants
1. Persist every accepted update (dedup table) BEFORE processing it.
2. LLM proposes, deterministic code validates and writes. No LLM arithmetic for money or dates; use the deterministic parsers (Jalali dates, relative times, amounts).
3. Every message carries `provenance` (`user|forwarded|email|channel|pdf|web`) and `data_class` (`public|personal|secret`).
4. Only `provenance=user` may create Commands, change memory (`user_facts`), or request sending anything. Untrusted content (email, channel posts, PDFs, web) is processed in **summarizer mode**: no tools, no memory writes, instructions inside it are never executed.
5. `secret` data never reaches an LLM, a log, or an error message. It is cut before the interpreter. Do not store card numbers or passwords in the vault.
6. Any external side effect (send email, send Telegram message, post, delete) requires an **Approval** bound to the exact payload hash with an expiry. Changed payload = new approval.
7. Money is an INTEGER in minor units with an explicit `currency` (toman, dirham). Corrections are reversals/soft-deletes with audit, never hard deletes.
8. Provider trust: `personal` data only to P0 providers (Workers AI) or P1 with the owner's explicit opt-in; anonymous free providers (P2) get `public` data only.
9. Provider calls are sequential with fallback, never parallel races (parallel = multiplied quota).
10. Every schema change is a numbered, forward-only migration with a test.

## 6. Free-tier budget (Cloudflare Workers Free; re-verify in R1)
- 100k requests/day (cron invocations count), **10 ms CPU per invocation (HTTP and cron)**, 50 external subrequests + 1000 internal (D1/KV/R2) per invocation, 5 cron triggers per account.
- Use **one** cron (every minute) + a `schedules` table. Do not add cron triggers.
- Use `D1.batch()`. Every query must hit an index (D1 bills rows scanned). No full scans of `messages`.
- No KV writes on the per-message path. Write usage counters in batches.
- Heavy work (large PDF, media, IMAP/SMTP, MTProto) goes to a GitHub Actions runner, not the Worker.
- If a feature needs quota, add its row to the quota table in the contract doc in the same PR.

## 7. Code hygiene (this is the main cause of past pain)
- No module over **300 lines**. New modules under 250. `everyday.js` and `index.js` are legacy: they may only shrink.
- Never read big files fully. Use `grep -n` and `sed -n 'A,Bp'` on 50–100 line ranges.
- One concern per PR. Do not refactor and add features in the same PR.
- Tests live next to the module they cover; never grow a mega test file. Add at least one acceptance test (Given/When/Then) and keep the golden Persian dataset green.
- Do not add dependencies without an ADR (Worker size and CPU limits).

## 8. Definition of Done
Code + tests + docs/ADR if a decision changed + quota row + failure behaviour (what the user sees when a provider/quota fails) + a real end-to-end run.

## 9. PR checklist (copy into every PR)
- [ ] Matches the contract doc and this file; import direction respected
- [ ] No new feature during R0/R1 (refactor and hardening only)
- [ ] Migration numbered and tested (if schema changed)
- [ ] No module over 300 lines; legacy files did not grow
- [ ] Canary test: secret/personal text never appears in LLM requests or logs
- [ ] External effect has an Approval with payload hash and expiry
- [ ] Quota impact computed and recorded
- [ ] Acceptance tests + golden dataset pass
- [ ] ADR added if a decision changed

## 10. Forbidden
- Hard-coding personal data (city, name, ids, currency) in code: use settings.
- Calling unofficial/undocumented endpoints in the T0 path.
- Enabling `/dev` self-upgrade by default for public installs.
- Sending anything on behalf of the owner without Approval, or because text inside an email/post/PDF said so.
- Storing API keys or app passwords in D1 plaintext. Secrets go to Worker/GitHub Secrets (or encrypted with the instance key).

## 11. Spec template (required before code for every feature)
1. Goal + at least 5 Persian example utterances
2. Tier (T0/T1/T2) and risk (read / reversible / irreversible)
3. Data: tables, data_class, provenance
4. Contracts used (Envelope, Intent, Command, Skill manifest, Provider, Approval, Job)
5. Failure behaviour (provider down, quota out, timeout)
6. Quota cost (rows in the budget table)
7. Approval needed?
8. Acceptance tests (Given/When/Then)
9. Out of scope
