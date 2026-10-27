# Agent Rules — my-agent

## Project structure

| Path | Role |
|------|------|
| `src/index.js` | Worker entry point — all HTTP endpoints, scheduled cron, Telegram webhook |
| `src/router.js` | `runCombo`, `getComboTargets`, `classifyFailure`, `directCall` |
| `src/combos.js` | Combo rules (`RULES`), scoring (`pickModels`, `diversify`, `WEIGHTS`) |
| `src/catalog.js` | KV catalog sync (`syncProvider`, `getSyncReport`) |
| `src/config.js` | Manual provider/combo CRUD in KV (`config:v1`) |
| `src/providers.js` | Built-in provider definitions, `listProviderModels`, model mappers |
| `src/health.js` | Per-target and per-provider health/cooldown in KV |
| `src/overrides.js` | KV pin/ban/prefer tools |
| `src/task-route.js` | Pure `classifyTask`, `comboCandidates`, `selectCombo` — no side effects |
| `src/intent.js` | `classifyIntentSync`, `classifyIntent`, `needsConfirmation` — chat/dev/task router |
| `src/dev.js` | Dev dispatch, HMAC callback verification, PR approve/reject, path guard |
| `src/guard.js` | Shared `isProtectedPath` used by the Worker and the opencode-dev workflow |
| `src/executor.js` | `runTask(env, spec)` task executor interface (default: not configured) |
| `src/admin-page.js` | Single-file admin HTML/CSS/JS (no build step) |
| `src/telegram.js` | Telegram send helpers |
| `src/tgprefs.js` | Per-user combo preferences in KV |
| `scripts/test-combos.mjs` | Offline test — combo scoring, config, Telegram commands |
| `scripts/test-dev.mjs` | Offline test — intent, executor, dispatch, HMAC, path guard, approve/reject |
| `wrangler.jsonc` | Cloudflare Worker config — do not edit |

## How to verify your changes

Run both commands before finishing:

```
npm run check
npm run test:offline
```

`npm run check` is a syntax check (`node --check`) on every `.js` and `.mjs` file under `src/` and `scripts/`. It exits 1 on any syntax error.

`npm run test:offline` runs `scripts/test-combos.mjs` then `scripts/test-dev.mjs`. Both are offline (no network, KV, or secrets). `test-combos.mjs` reads fixture files `xk-models.json`, `nv-models.json`, `or-models.json` from the repo root when present (gitignored); when absent it warns and skips catalog-dependent assertions instead of failing. Exit code 1 means a regression.

## Dev pipeline (Telegram → GitHub Actions → PR → Telegram)

1. Telegram text is classified by `src/intent.js` as `chat`, `dev`, or `task`.
2. Low-confidence `dev`/`task` asks for confirmation with inline buttons (`intent:yes` / `intent:chat`), pending 10 minutes in KV.
3. `dev` calls `dispatchDev()` → GitHub `workflow_dispatch` of `.github/workflows/opencode-dev.yml` with `prompt`, `chat_id`, `user_id`.
4. The workflow runs opencode, runs a path guard, then POSTs a signed body to `/dev/callback`.
5. The Worker verifies HMAC + timestamp + nonce, clears the active run, and sends PR approve/reject buttons.
6. Approve squash-merges only `opencode/dispatch-*` or `dispatch/*` branches whose files pass the path guard; reject closes the PR and deletes the branch.
7. `task` calls `runTask()` in `src/executor.js`; with no `EXECUTOR` backend it offers "Just chat" instead of failing.

Secrets (names only): Worker needs `GITHUB_DISPATCH_TOKEN`, `DEV_CALLBACK_SECRET`; GitHub Actions needs `ROUTER_KEY`, `DEV_CALLBACK_SECRET`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, plus the `WORKER_URL` variable. `.github/workflows/deploy.yml` deploys using the committed `wrangler.jsonc`; it skips with a warning when the Cloudflare secrets are absent.

## Mandatory rules

- Run `npm run check` and `npm run test:offline` before every commit or PR. Both must pass.
- Keep patches small and focused. PRs must stay small (max 5 files, max 300 changed lines), one purpose per PR.
- Never log secret values, API keys, or message contents. Never read or print `.dev.vars*` / `.env*` values.
- Agents must not edit `.github/**`, `opencode.json`, `wrangler.jsonc`, `.env*`, `.dev.vars*`. Changes to these are made by the human.
- Never call `wrangler`, `curl`, or `rm -rf` from an agent session. Never trigger a deploy manually.
- For any change to runtime behaviour (routing, scoring, health, fallback, telegram commands, intent, dev pipeline, path guard), add or adjust an offline test in `scripts/test-combos.mjs` or `scripts/test-dev.mjs`.
- Security: model mappers and router must never echo raw API keys or request headers in responses or logs. Use `redact()` from `src/providers.js` for any snippet that might contain keys.
- Describe every change in the PR body: what changed, why, which tests cover it.

## Coding conventions

- All source files are plain ES modules (`"type": "module"` in `package.json`). No TypeScript, no build step.
- Worker runtime: Cloudflare Workers (no Node.js built-ins). Only Web APIs + `env` bindings.
- KV binding is `STATE`. Never use `env.STATE` outside of `src/` files — scripts are Node.js and mock KV.
- Scoring constants live entirely in `WEIGHTS` at the top of `src/combos.js`. Tune there only.
- Admin page is one self-contained file (`src/admin-page.js`). No external CDN dependencies.
- Protected paths for the agent (deny in opencode.json): `.github/**`, `opencode.json`, `wrangler.toml`, `wrangler.jsonc`, `wrangler.json`, `.dev.vars*`, `.env*` (except `*.env.example` / `.dev.vars.example`), `package-lock.json`. Humans change these manually.
- Log format for each routed request: one line, no message text, no keys: `{combo, used, routed: "auto"|"manual"}`.
