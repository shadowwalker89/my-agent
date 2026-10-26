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
