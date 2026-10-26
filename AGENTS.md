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
| `src/admin-page.js` | Single-file admin HTML/CSS/JS (no build step) |
| `src/telegram.js` | Telegram send helpers |
| `src/tgprefs.js` | Per-user combo preferences in KV |
| `scripts/test-combos.mjs` | Offline test — reads fixture JSON files, asserts combo scoring |
| `wrangler.jsonc` | Cloudflare Worker config — do not edit |

## How to verify your changes

Run both commands before finishing:

```
npm run check
node scripts/test-combos.mjs
```

`npm run check` is a syntax check (`node --check`) on every `.js` and `.mjs` file under `src/` and `scripts/`. It exits 1 on any syntax error.

`node scripts/test-combos.mjs` is an offline test that validates combo scoring logic without network, KV, or secrets. It reads fixture files `xk-models.json`, `nv-models.json`, `or-models.json` from the repo root if present (gitignored; skip gracefully if absent), then runs assertions on `classifyTask`, combo selection, and config helpers. Exit code 1 means a regression.

## Mandatory rules

- Run `npm run check` and `node scripts/test-combos.mjs` before every commit or PR. Both must pass.
- Keep patches small and focused. One logical change per PR.
- Never touch secrets or deploy config: do not read or edit `.dev.vars`, `.env`, `wrangler.toml`, `wrangler.jsonc`, or `opencode.json`. Never log secret values, API keys, or message contents.
- Never call `wrangler`, `curl`, or `rm -rf`. Never trigger a deploy.
- Never edit files under `.github/workflows/`.
- For any change to runtime behaviour (routing, scoring, health, fallback, telegram commands), add or adjust an offline test in `scripts/test-combos.mjs`.
- Security: model mappers and router must never echo raw API keys or request headers in responses or logs. Use `redact()` from `src/providers.js` for any snippet that might contain keys.
- Describe every change in the PR body: what changed, why, which tests cover it.

## Coding conventions

- All source files are plain ES modules (`"type": "module"` in `package.json`). No TypeScript, no build step.
- Worker runtime: Cloudflare Workers (no Node.js built-ins). Only Web APIs + `env` bindings.
- KV binding is `STATE`. Never use `env.STATE` outside of `src/` files — scripts are Node.js and mock KV.
- Scoring constants live entirely in `WEIGHTS` at the top of `src/combos.js`. Tune there only.
- Admin page is one self-contained file (`src/admin-page.js`). No external CDN dependencies.
- Log format for each routed request: one line, no message text, no keys: `{combo, used, routed: "auto"|"manual"}`.
