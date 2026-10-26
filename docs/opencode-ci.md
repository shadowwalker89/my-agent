# OpenCode CI

Automated coding via GitHub Actions, routed through the Worker's `combo/code` model.

## Dispatching a run

**From the Actions tab:**

1. Go to **Actions → opencode-dev** in the GitHub UI.
2. Click **Run workflow**.
3. Fill in the **prompt** field (e.g. `add input validation to the /v1/chat/completions handler`).
4. Click **Run workflow**.

**From the CLI (requires `gh`):**

```sh
gh workflow run opencode-dev.yml -f prompt="your prompt here"
```

After the run completes, opencode will have pushed a new branch and opened a PR if it made any changes. The PR URL is printed in the **Run opencode** step log.

## Required secrets

| Secret | Where to add | Purpose |
|--------|-------------|---------|
| `ROUTER_KEY` | Repo Settings → Secrets and variables → Actions | Bearer key for `POST /v1/chat/completions` on the Worker router |

`GITHUB_TOKEN` is provided automatically by GitHub Actions — no setup needed.

## Adding ROUTER_KEY

```sh
gh secret set ROUTER_KEY --repo <owner>/my-agent
```

Or paste it in **Settings → Secrets and variables → Actions → New repository secret**.

## Merging to main

This workflow runs on `patch-3h-opencode-ci`. Merge that branch to `main` first so the workflow file is available on the default branch — GitHub Actions only sees workflow files on the branch being dispatched from (for `workflow_dispatch`, the default branch).

## Known limits

- **Provider must be reachable.** The Worker at `https://my-agent.nova-02aa82bffef8.workers.dev` must be deployed and `ROUTER_KEY` must match `wrangler secret put ROUTER_KEY`.
- **No interactive prompts.** The agent runs with `question` permission denied. Prompts that require clarification will stall or fail.
- **25-minute timeout.** Complex tasks that take longer will be cancelled. Keep prompts focused.
- **One concurrent run.** The `concurrency: opencode-dev` group serialises dispatches — a second dispatch queues and waits, it does not cancel the first.
- **Bash is restricted.** The agent can only run `npm test*`, `npm run check*`, `node scripts/*`, and basic `git` read/write commands. It cannot call `wrangler`, `curl`, or `rm -rf`.
- **opencode.json is protected.** The agent cannot edit `opencode.json`, `.github/workflows/**`, or secret files. This is enforced by the `bash: "*": "deny"` and `read`/`edit` allow-all, but the AGENTS.md rules also instruct it explicitly.
- **No Telegram wiring.** This workflow does not notify Telegram on completion.
