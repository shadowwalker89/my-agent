# Safety net for the self-modifying pipeline

## Flow

```
Telegram /dev
  -> GitHub Actions opencode-dev.yml (pinned by SHA)
  -> PR (opencode/dispatch-*)
  -> path guard + dispatch ci.yml on PR head
  -> Telegram callback with Approve / Reject / 🔄 CI buttons
  -> Approve checks the ci.yml run on the exact PR head SHA (fail closed):
       success  -> squash merge -> push to main -> deploy.yml
       failure  -> blocked, shows CI run URL
       pending  -> blocked, retry shortly
  -> deploy.yml: preflight + checks + deploy + smoke (/health, /v1/models)
       smoke fail -> npx wrangler rollback + Telegram alert
       smoke ok   -> Telegram success
```

## Required secrets

Worker (wrangler secret):
- `ROUTER_KEY`, `DEV_CALLBACK_SECRET`, `GITHUB_DISPATCH_TOKEN`, `TG_TOKEN`, `TG_SECRET`, `ALLOWED_TG_IDS`, `ADMIN_KEY` (optional)

GitHub Actions secrets:
- `ROUTER_KEY`, `GITHUB_DISPATCH_TOKEN`, `DEV_CALLBACK_SECRET`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

Repository variable:
- `WORKER_URL` = `https://my-agent.nova-02aa82bffef8.workers.dev`

Token permission: the Worker's GitHub token (GITHUB_DISPATCH_TOKEN) needs "Commit statuses: Read" (fine-grained PAT) to read the combined commit status used by the CI gate.

## How to test

1. Normal /dev with a tiny docs-only prompt: expect ⏳ then ✅ CI status; Approve blocked while pending, allowed on success.
2. A prompt that breaks `npm run check`: expect ❌ and Approve blocked.
3. Run deploy workflow manually with `simulate_failure=true`: expect rollback and the Telegram alert, then re-run normally to restore.
4. A /dev prompt asking to edit `.github/workflows/ci.yml`: expect refusal / no change.

## Rollback

On smoke failure, `npx wrangler rollback --message "smoke test failed" --yes` runs, then /health is re-checked.
- If rollback succeeds and /health returns ok:true: Telegram "⚠️ دیپلوی ناموفق بود و rollback انجام شد".
- Otherwise: Telegram "🚨 rollback هم ناموفق بود، دستی بررسی کن".
The job ends failed in both cases.

## Known limits

- Rollback reverts Worker code only, not KV/D1 data.
- CI dispatch from opencode-dev uses GITHUB_TOKEN; a dispatch failure is logged as a warning and does not fail the job.
- `simulate_failure` triggers a real rollback to the previous version.
