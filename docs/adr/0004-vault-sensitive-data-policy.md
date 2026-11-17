# ADR 0004 — Vault storage of card numbers and Sheba, and Vault key separation

- Status: Accepted (policy); Vault key separation: scheduled for R1
- Date: 2026-11-17
- Deciders: owner
- Related: `AGENTS.md` §5; `docs/contract-v3.md` D5, D19

## Context

`AGENTS.md` §5 forbade storing card numbers and passwords in the Vault (Sheba was not named there). The owner decided (N-4) that card numbers and Sheba must be storable and retrievable in the Vault, so that rule must be narrowed without relaxing the secrets that must never be stored.

The Vault encrypts values with AES-GCM. The key is the SHA-256 digest of the value returned by `vaultSecret(env)` (`src/platform/vault/crypto.js:7` and `:22-23`); that helper falls back through `VAULT_MASTER_KEY`, `VAULT_SECRET`, `ADMIN_SECRET`, `TELEGRAM_BOT_TOKEN`, and `TG_TOKEN`. In production only `TG_TOKEN` exists among those names (Worker secret names and `wrangler.jsonc`), so the key is currently derived from the Telegram bot token. This is an inference from the configured names; a dashboard-set plain variable is unlikely but not excluded.

The `vault:analyze` path sends the owner's image to Gemini (`gemini-2.5-flash`, `gemini-2.0-flash`), which is an external LLM call for an image the owner explicitly submits.

Options considered:

1. Keep forbidding card numbers and Sheba. Rejected by the owner: the product needs them stored and retrievable.
2. Store them in plaintext. Rejected: violates the `secret` invariant and exposes data to logs, D1, and LLM paths.
3. Store them only as Vault ciphertext. Chosen.

For the Vault key:

1. Keep the `TG_TOKEN` fallback permanently. Rejected as a target; tolerated temporarily until the migration.
2. Use a dedicated `VAULT_MASTER_KEY`. Chosen target.

## Decision

1. Card numbers and Sheba may be stored only as Vault ciphertext. Plaintext must never reach an LLM request, a log, a D1 column (the `messages.content` column stores the redacted placeholder), or an error message.
2. CVV/CVV2, card PINs/passwords, and OTP codes remain forbidden in the Vault (OTP per D19). Whether the current code rejects CVV/password input is unverified; enforcement, if missing, is a separate follow-up.
3. `vault:analyze` sending the owner's image to Gemini is recorded as an owner-initiated exception to D5 (owner's own key, explicit action).
4. A dedicated `VAULT_MASTER_KEY` with a re-encryption migration is required and is scheduled for R1.
5. The PR-B shape-only input guard stays: secret-shaped text outside `vault_save` is not sent to an LLM and is not stored.

## Consequences

- Do not rotate `TG_TOKEN` before the key migration; the Vault would become undecryptable.
- A leaked `TG_TOKEN` plus a `/backup` JSON could decrypt the Vault, so backups must be treated as sensitive.
- The guard is shape-only: any run of 13+ digits, or any text containing the lock emoji, is treated as secret-shaped, with known false positives.
- The `command` path and media captions/voice echo are outside the guard; these are known gaps.
- D5 now has one documented exception.
