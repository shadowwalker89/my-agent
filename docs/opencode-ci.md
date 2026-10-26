# OpenCode CI

Automated coding via GitHub Actions, routed through the Worker's `combo/code` model.

The worker endpoint is: `https://my-agent.nova-02aa82bffef8.workers.dev`
The OpenAI-compatible API is at: `POST /v1/chat/completions` (Bearer `ROUTER_KEY`).
Available models: `GET /v1/models` (same auth) — returns `combo/<name>` entries plus catalog models.

## Dispatching a run

**From the Actions tab:**

1. Go to **Actions → opencode-dev** in the GitHub UI.
2. Click **Run workflow**.
3. Fill in the **prompt** field (e.g. `add input validation to the /v1/chat/completions handler`).
4. Click **Run workflow**.

**From the CLI (requires `gh`):**

```sh
gh workflow run opencode-dev.yml \
  --repo shadowwalker89/my-agent \
  -f prompt="your prompt here"
```

After the run completes, opencode pushes a new branch (`opencode/dispatch-*`) and opens a PR if it made changes. The PR URL is printed in the **Run opencode** step log.

The workflow accepts optional `chat_id` / `user_id` inputs. When they are present (as they are for Telegram dispatches), the workflow posts a signed result to `POST /dev/callback` on the Worker, which sends the PR approve/reject buttons back to the chat.

## Telegram dev pipeline

- `/dev <prompt>` forces a dev dispatch.
- Plain text is classified by `src/intent.js` (`chat` / `dev` / `task`). Low-confidence dev/task requests ask for confirmation with inline buttons; the pending request lives 10 minutes in KV.
- `/intent on|off` toggles intent routing per user; when off, every text goes straight to chat.
- The Worker rate-limits dev dispatch to 5 per user per hour and allows one active run per user (30 minutes).
- Approve squash-merges only `opencode/dispatch-*` or `dispatch/*` branches after a second path-guard check. Reject closes the PR and deletes the branch.
- `task` uses `runTask()` in `src/executor.js`. No `EXECUTOR` backend is configured today, so the bot offers "Just chat" instead of failing.

Callback security: the workflow signs the JSON body with HMAC-SHA256 (`DEV_CALLBACK_SECRET`) and sends it in `X-Signature`; the Worker also enforces a 5-minute timestamp window and a one-time nonce stored in KV. Callback failures are logged by code only — never the body or signature.

## Required secrets

| Secret | Where to add | Purpose |
|--------|-------------|---------|
| `ROUTER_KEY` | Repo Settings → Secrets and variables → Actions | Bearer key for `POST /v1/chat/completions` on the Worker |
| `GITHUB_DISPATCH_TOKEN` | Repo Settings → Secrets and variables → Actions | PAT or fine-grained token for Telegram→GitHub dispatch (Part 2) |
| `DEV_CALLBACK_SECRET` | Repo Settings → Secrets and variables → Actions + Worker | Shared HMAC secret for signed callbacks from Actions → Worker |

`GITHUB_TOKEN` is provided automatically by GitHub Actions — no setup needed.

Repository variables needed:

| Variable | Example | Purpose |
|----------|---------|---------|
| `WORKER_URL` | `https://my-agent.nova-02aa82bffef8.workers.dev` | Target for the callback POST from the deploy workflow |

## Adding secrets

```sh
gh secret set ROUTER_KEY              --repo shadowwalker89/my-agent
gh secret set GITHUB_DISPATCH_TOKEN  --repo shadowwalker89/my-agent
gh secret set DEV_CALLBACK_SECRET    --repo shadowwalker89/my-agent

# Repository variable (not secret — the URL is public):
gh variable set WORKER_URL \
  --body "https://my-agent.nova-02aa82bffef8.workers.dev" \
  --repo shadowwalker89/my-agent
```

Worker secrets (set once, never in code):
```sh
npx wrangler secret put ROUTER_KEY
npx wrangler secret put DEV_CALLBACK_SECRET
npx wrangler secret put GITHUB_DISPATCH_TOKEN
```

## Known limits

- **Provider must be reachable.** The Worker must be deployed and `ROUTER_KEY` must match the wrangler secret.
- **No interactive prompts.** The agent runs with `question` permission denied. Prompts that require clarification will stall or fail.
- **25-minute timeout.** Complex tasks that take longer will be cancelled. Keep prompts focused.
- **One concurrent run.** The `concurrency: opencode-dev` group serialises dispatches — a second dispatch queues and waits, it does not cancel the first.
- **Bash is restricted.** The agent can only run `npm test*`, `npm run check*`, `node scripts/*`, and basic `git` read/write commands. It cannot call `wrangler`, `curl`, or `rm -rf`.
- **Protected files.** The agent cannot edit `opencode.json`, `.github/workflows/**`, `wrangler.jsonc`, `.dev.vars*`, or `.env*`. Enforced by AGENTS.md rules and the path-guard CI step.
- **Telegram callback requires DEV_CALLBACK_SECRET** in both GitHub secrets and the Worker. Until both are set, the callback step is a no-op.
- **deploy.yml requires wrangler.jsonc.** See the deploy workflow section below for the safe approach used.

## Deploy workflow

`.github/workflows/deploy.yml` runs on pushes to `main` that touch `src/**`, `package.json`, or `wrangler.jsonc`, and can also be started manually. It:

1. Runs `npm run check` and `npm run test:offline`.
2. Checks for `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Deploys with `cloudflare/wrangler-action@v3` using the **committed** `wrangler.jsonc`.

If either Cloudflare secret is missing, the deploy step is skipped with a warning instead of failing the run. `wrangler.jsonc` stays committed and is never generated by CI; the offline tests degrade gracefully when the gitignored catalog fixtures are absent, so a clean CI checkout still passes.
