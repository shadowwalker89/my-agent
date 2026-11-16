# ADR 0003 — Channel-owned Telegram transport with injected media downloaders

- Status: Accepted
- Date: 2026-11-15
- Deciders: owner
- Related: `AGENTS.md` §4; `docs/contract-v3.md` §3, §8 (R0); `docs/audits/r0-audit.md` F1

## Context

The layering contract requires `channels → ingress → pipeline → domain/skills → platform` and states that channel adapters own Telegram transport. The R0.7f extraction moved the voice flow into `src/skills/media/`, but the Telegram file download remained in the skill (`src/skills/media/voice-transcribe.js`) and called `api.telegram.org` directly. That violated layer direction (skills must not own channel transport), duplicated transport knowledge, and made the R0 audit's F1 finding a High-severity blocker.

`src/skills/**` cannot import `src/channels/telegram.js` upward, so moving the call is not enough; the dependency must be provided from a layer allowed to know the channel.

Options considered:

1. Let the skill import the channel adapter. Rejected: upward import violates `AGENTS.md` §4.
2. Keep the Telegram call in the skill. Rejected: violates channel ownership and the audit gate.
3. Implement the download in `src/channels/telegram.js` and inject it into voice handlers from the composition root. Chosen.

## Decision

Telegram transport, including voice file metadata lookup and file download, lives in `src/channels/telegram.js` (`downloadTelegramVoice`). The media skills receive that function through dependency injection; they do not call `api.telegram.org`, read `env.TG_TOKEN` for transport, or import `src/channels/`. The Worker entry point (`src/index.js`) wires the channel-owned downloader into both production voice call sites. The existing `GEMINI_TIMEOUT_MS` timeout value (`20000`) is preserved for the download stage.

This ADR applies the existing layer rule to media downloads. It does not change the R0 layering policy or add a new provider, dependency, schema, or cron.

## Consequences

- Channel ownership is enforceable: `src/skills/media/**` contains no Telegram transport strings.
- Voice tests inject a fake downloader, so the skill boundary is testable without network access.
- Any future media skill that needs a channel file must use the same injection pattern; adding a direct channel import is a contract violation.
- Wiring responsibility stays in `src/index.js` (the composition root) until the R1 ingress/channel wiring refactor.
- Implementation is present in the uncommitted F1 working tree. This ADR does not close R0 by itself: Steps 5–7 of the R0 closure (final evidence, 14-scenario manual Telegram smoke test, independent read-only re-audit) and a clean worktree gate remain required.

## Status

Accepted as the durable transport-boundary decision. R0 acceptance remains **OPEN / NOT CLOSED** until the closure gates in `docs/audits/r0-audit.md` are satisfied.
