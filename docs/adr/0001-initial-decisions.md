# ADR 0001 — Initial decisions (D1–D21)

- Status: Accepted
- Date: 2026-11-13
- Deciders: owner
- Source: `docs/contract-v3.md` (the contract remains the source of truth)

## Context

The architecture contract v3.0 records the binding decisions for this project.
This ADR is an index of those decisions so the ADR log starts from a known
baseline. It does not replace the contract and does not change any decision.

## Decision

- D1 — Single-owner instance; only one allowlisted Telegram ID, no family mode. (`docs/contract-v3.md` §1)
- D2 — Every install is an independent instance; no multi-tenant mode. (`docs/contract-v3.md` §1)
- D3 — Zero-dollar constraint: Cloudflare Free, GitHub Actions, and free providers; anything not sustainable at $0 becomes T2. (`docs/contract-v3.md` §1)
- D4 — Refactor-first: phases R0 and R1 add no new features. (`docs/contract-v3.md` §1)
- D5 — Data privacy: `personal` only to Workers AI/Gemini (P0/P1), anonymous free providers only for `public`, `secret` never reaches an LLM or log. (`docs/contract-v3.md` §1)
- D6 — Accounting currency: toman and dirham with an explicit currency column; amounts are integers. (`docs/contract-v3.md` §1)
- D7 — Email: Gmail via API from the Worker; Yahoo via IMAP/SMTP and app password through Mail Runner; Atomic Mail unsupported for now. (`docs/contract-v3.md` §1, §7.2)
- D8 — External effects only with an approval bound to the payload hash and an expiry. (`docs/contract-v3.md` §1)
- D9 — Channel digests: only public, categorized channels read through the public `t.me/s/` page. (`docs/contract-v3.md` §1)
- D10 — Contact messages on Telegram: level A (prepared message + chat link) by default; level B Account Runner is T2. (`docs/contract-v3.md` §1)
- D11 — AI video is T2 with no commitment; video summary from a link is T1. (`docs/contract-v3.md` §1)
- D12 — WhatsApp is out of V1; Bale is the second channel. (`docs/contract-v3.md` §1)
- D13 — `/dev` self-upgrade is off by default for public installs and owner-only. (`docs/contract-v3.md` §1)
- D14 — Naming: `Task` is a user to-do; `Job` is a background job (`outbox_jobs`); never mix them. (`docs/contract-v3.md` §1)
- D15 — Default timezone is Asia/Tehran (Jalali default); store times in UTC and convert only at display/parser boundaries. (`docs/contract-v3.md` §11)
- D16 — Contact messages are level A only; Account Runner (level B) is moved to the backlog. (`docs/contract-v3.md` §11)
- D17 — Primary email need is an immediate OTP in Telegram; other email features are deprioritized. (`docs/contract-v3.md` §11)
- D18 — Non-OTP email is summarized by Gemini Free only on explicit request; no automatic daily email summary. (`docs/contract-v3.md` §11)
- D19 — OTP is `secret` data: never sent to an LLM or log, not stored in D1 (only `message_id` for dedup), and the bot message is deleted after N minutes (default 10). (`docs/contract-v3.md` §11)
- D20 — Gmail uses personal OAuth with `gmail.readonly` and polling (`history.list`) in the single tick; no Pub/Sub. (`docs/contract-v3.md` §11)
- D21 — Development method: Gemini (Google AI Studio) is architect/reviewer, OpenCode on the laptop is implementer, and `docs/STATE.md` is project memory. (`docs/contract-v3.md` §11)

## Consequences

- Changing any decision requires a new ADR in `docs/adr/`; the contract must be
  updated in the same change.
- When the contract gains a new decision, this index is extended with one line
  and a section pointer.
- The contract's decision log and this ADR must not contradict each other.

## Status

Accepted. Superseded by a later ADR only if a decision changes.
