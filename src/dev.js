// Dev pipeline helpers — dispatch to GitHub Actions, verify signed callbacks,
// and approve/reject Dev PRs. Pure-ish functions + fetch; no message text logging.
//
// Secrets used: GITHUB_DISPATCH_TOKEN (GitHub), DEV_CALLBACK_SECRET (HMAC).
// Never log token, secret, prompt, or callback body.
import { isProtectedPath } from "./guard.js";

export const DEV_REPO_DEFAULT = "shadowwalker89/my-agent";
export const DEV_WORKFLOW_DEFAULT = "opencode-dev.yml";
export const DEV_RATE_LIMIT = 5;
export const DEV_ACTIVE_TTL_SEC = 30 * 60;
export const DEV_CALLBACK_WINDOW_MS = 5 * 60 * 1000;

export function safeGithubUrl(url) {
  if (typeof url !== "string" || !url) return "";
  return /^https:\/\/github\.com\//.test(url) ? url : "";
}

export function devRepo(env) {
  const v = typeof env?.GH_REPO === "string" ? env.GH_REPO.trim() : "";
  return v || DEV_REPO_DEFAULT;
}

export function devWorkflow(env) {
  const v = typeof env?.GH_WORKFLOW === "string" ? env.GH_WORKFLOW.trim() : "";
  return v || DEV_WORKFLOW_DEFAULT;
}

export function devRateKey(userId) {
  return `dev:rate:${String(userId ?? "")}`;
}

export function devActiveKey(userId) {
  return `dev:active:${String(userId ?? "")}`;
}

export function devNonceKey(nonce) {
  return `dev:nonce:${String(nonce ?? "")}`;
}

// ── rate limit: max DEV_RATE_LIMIT dispatches per user per clock hour ────────
export async function consumeDevRate(env, userId, now = Date.now()) {
  const limit = DEV_RATE_LIMIT;
  if (!env?.STATE) return { ok: true, count: 0, limit };
  const bucket = Math.floor(now / 3600000);
  const key = `${devRateKey(userId)}:${bucket}`;
  const cur = Number((await env.STATE.get(key)) ?? 0) || 0;
  if (cur >= limit) return { ok: false, count: cur, limit };
  await env.STATE.put(key, String(cur + 1), { expirationTtl: 3600 });
  return { ok: true, count: cur + 1, limit };
}

// ── one active run per user ─────────────────────────────────────────────────
export async function isDevActive(env, userId) {
  if (!env?.STATE) return false;
  return Boolean(await env.STATE.get(devActiveKey(userId)));
}

export async function setDevActive(env, userId, active) {
  if (!env?.STATE) return;
  if (active) {
    await env.STATE.put(devActiveKey(userId), "1", { expirationTtl: DEV_ACTIVE_TTL_SEC });
  } else {
    await env.STATE.delete(devActiveKey(userId));
  }
}

// ── dispatch ────────────────────────────────────────────────────────────────
export async function dispatchDev(env, prompt, chatId, userId) {
  const text = String(prompt ?? "").trim();
  const uid = userId ?? chatId;

  if (!text) {
    return {
      ok: false,
      code: "empty_prompt",
      text: "پرامپت خالی است. / Empty prompt.\nمثال / Example: /dev add a /health endpoint",
    };
  }
  if (!env?.GITHUB_DISPATCH_TOKEN) {
    return {
      ok: false,
      code: "missing_token",
      text:
        "❌ اجرای dev ممکن نیست: secret «GITHUB_DISPATCH_TOKEN» روی Worker ست نشده.\n" +
        "Dev is not configured: the GITHUB_DISPATCH_TOKEN secret is missing on the Worker.",
    };
  }
  if (await isDevActive(env, uid)) {
    return {
      ok: false,
      code: "active_run",
      text:
        "⏳ یک اجرای dev برای تو در جریان است (حداکثر ۳۰ دقیقه).\n" +
        "You already have an active dev run. Wait for its callback or try again later.",
    };
  }
  const rate = await consumeDevRate(env, uid);
  if (!rate.ok) {
    return {
      ok: false,
      code: "rate_limited",
      text:
        `🚦 سقف ${rate.limit} اجرای dev در ساعت پر شده.\n` +
        `Rate limit reached: max ${rate.limit} dev dispatches per hour.`,
    };
  }

  const repo = devRepo(env);
  const workflow = devWorkflow(env);
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        "user-agent": "my-agent-worker",
      },
      body: JSON.stringify({
        ref: env.GH_REF || "main",
        inputs: { prompt: text, chat_id: String(chatId ?? ""), user_id: String(uid) },
      }),
    });
    if (!res.ok) {
      return {
        ok: false,
        code: "dispatch_failed",
        status: res.status,
        text:
          `❌ GitHub dispatch شکست خورد (HTTP ${res.status}).\n` +
          `GitHub dispatch failed (HTTP ${res.status}).`,
      };
    }
    await setDevActive(env, uid, true);
    return {
      ok: true,
      status: res.status,
      text:
        "🚀 اجرای dev ثبت شد. نتیجه به‌صورت PR + پیام اینجا می‌آید.\n" +
        "Dev run dispatched. The result will arrive here as a PR message.",
    };
  } catch {
    return {
      ok: false,
      code: "network",
      text: "❌ خطای شبکه در dispatch.\nNetwork error while dispatching to GitHub.",
    };
  }
}

// ── path guard ──────────────────────────────────────────────────────────────
// The single source of truth lives in ./guard.js so the workflow and Worker
// cannot drift. `isForbiddenPath` is kept as an alias for existing callers.
export function isForbiddenPath(path) {
  return isProtectedPath(path);
}

export function pathGuardViolations(files) {
  const list = Array.isArray(files) ? files : [];
  return list
    .map((f) => (typeof f === "string" ? f : f?.filename ?? f?.path ?? ""))
    .filter(Boolean)
    .filter(isForbiddenPath);
}

// The official action creates `opencode/dispatch-*`; we also accept an explicit
// `dispatch/` prefix so the intent is clear and future workflows can use either.
export function isDispatchBranch(ref) {
  const s = String(ref ?? "");
  return s.startsWith("dispatch/") || s.startsWith("opencode/dispatch-");
}

// ── HMAC / replay protection ────────────────────────────────────────────────
export function safeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(String(secret ?? "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(String(message ?? "")));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// verifyCallbackSignature(env, rawBody, header, now) -> { ok, body?, code? }
// Checks: secret present, hex signature, constant-time match, 5-min timestamp
// window, nonce (8-64 chars) unused in KV. Replay is rejected.
export async function verifyCallbackSignature(env, rawBody, signatureHeader, now = Date.now()) {
  const secret = env?.DEV_CALLBACK_SECRET;
  if (!secret) return { ok: false, code: "no_secret" };

  const sig = String(signatureHeader ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false, code: "bad_signature" };

  const expected = await hmacHex(secret, rawBody);
  if (!safeEqualStr(sig, expected)) return { ok: false, code: "bad_signature" };

  let body;
  try {
    body = JSON.parse(String(rawBody ?? ""));
  } catch {
    return { ok: false, code: "bad_json" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, code: "bad_json" };

  const ts = Number(body.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, code: "no_timestamp" };
  if (Math.abs(now - ts) > DEV_CALLBACK_WINDOW_MS) return { ok: false, code: "stale" };

  const nonce = String(body.nonce ?? "");
  if (!/^[A-Za-z0-9._-]{8,64}$/.test(nonce)) return { ok: false, code: "bad_nonce" };

  if (env?.STATE) {
    const key = devNonceKey(nonce);
    if (await env.STATE.get(key)) return { ok: false, code: "replay" };
    await env.STATE.put(key, "1", { expirationTtl: 600 });
  }
  return { ok: true, body };
}

// ── GitHub API ──────────────────────────────────────────────────────────────
async function githubFetch(env, path, init = {}) {
  const token = env?.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    const err = new Error("missing GITHUB_DISPATCH_TOKEN");
    err.code = "missing_token";
    throw err;
  }
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "my-agent-worker",
      ...(init.headers ?? {}),
    },
  });
}

async function fetchPR(env, prNumber) {
  const repo = devRepo(env);
  const res = await githubFetch(env, `/repos/${repo}/pulls/${Number(prNumber)}`);
  if (!res.ok) {
    return { ok: false, code: res.status === 404 ? "pr_not_found" : "pr_fetch_failed", status: res.status, pr: null };
  }
  const pr = await res.json();
  return { ok: true, code: "ok", status: res.status, pr };
}

async function fetchOpenPR(env, prNumber) {
  const found = await fetchPR(env, prNumber);
  if (!found.ok) return found;
  if (found.pr?.state !== "open") {
    return { ok: false, code: "pr_not_open", status: found.status, pr: found.pr };
  }
  return { ok: true, status: found.status, pr: found.pr };
}

export const CI_STATUS_CONTEXT = "ci/offline-checks";

// Fetch the combined commit status for a PR's head SHA and extract the
// ci/offline-checks entry. Returns a structured result:
//   reason: "success" | "failure" | "pending" | "no_status" | "forbidden" | "error"
export async function getPRCiStatus(env, prNumber) {
  const found = await fetchOpenPR(env, prNumber);
  if (!found.ok) {
    return { ok: false, code: found.code, reason: "error", state: "missing", target_url: null, sha: null, status: found.status ?? null };
  }
  const sha = found.pr?.head?.sha ? String(found.pr.head.sha) : "";
  const branch = found.pr?.head?.ref ? String(found.pr.head.ref) : "";
  if (!sha) {
    return { ok: false, code: "no_sha", reason: "error", state: "missing", target_url: null, sha: null, branch, status: null };
  }
  const repo = devRepo(env);
  let res;
  try {
    res = await githubFetch(env, `/repos/${repo}/commits/${encodeURIComponent(sha)}/status`);
  } catch (err) {
    return { ok: false, code: err?.code || "network", reason: "error", state: "missing", target_url: null, sha, branch, status: null };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, code: "forbidden", reason: "forbidden", state: "missing", target_url: null, sha, branch, status: res.status };
  }
  if (!res.ok) {
    return { ok: false, code: "status_failed", reason: "error", state: "missing", target_url: null, sha, branch, status: res.status };
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, code: "bad_json", reason: "error", state: "missing", target_url: null, sha, branch, status: res.status };
  }
  const statuses = Array.isArray(data?.statuses) ? data.statuses : [];
  const ci = statuses.find((s) => s && s.context === CI_STATUS_CONTEXT);
  if (!ci) {
    return { ok: true, code: "ci_missing", reason: "no_status", state: "missing", target_url: data?.target_url ?? null, sha, branch, status: res.status };
  }
  const state = String(ci.state ?? "pending").toLowerCase();
  const normalized = ["success", "failure", "error", "pending"].includes(state) ? state : "pending";
  const reason =
    normalized === "success" ? "success" : normalized === "failure" || normalized === "error" ? "failure" : "pending";
  return {
    ok: true,
    code: "ci_" + normalized,
    reason,
    state: normalized,
    target_url: ci.target_url ?? data?.target_url ?? null,
    sha,
    branch,
    status: res.status,
  };
}

// Display-only helper: look up recent ci.yml runs for a head SHA.
export async function getCiRuns(env, headShaOrBranch, maybeHeadSha, maybeLimit) {
  let sha = headShaOrBranch;
  let limit = 10;
  if (typeof maybeHeadSha === "number") {
    limit = maybeHeadSha;
  } else if (typeof maybeHeadSha === "string" && maybeHeadSha) {
    sha = maybeHeadSha;
    if (typeof maybeLimit === "number") limit = maybeLimit;
  }
  if (!sha) return { ok: false, found: false, run: null, runs: [] };
  const repo = devRepo(env);
  let res;
  try {
    res = await githubFetch(env, `/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${encodeURIComponent(sha)}&per_page=${Number(limit) || 10}`);
  } catch {
    return { ok: false, found: false, run: null, runs: [] };
  }
  if (!res.ok) return { ok: false, found: false, run: null, runs: [], status: res.status };
  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, found: false, run: null, runs: [], status: res.status };
  }
  const all = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
  const matching = all.filter((r) => r && String(r.head_sha ?? "") === String(sha));
  if (!matching.length) return { ok: true, found: false, run: null, runs: [] };
  matching.sort((a, b) => {
    const an = Number(a?.run_number ?? 0);
    const bn = Number(b?.run_number ?? 0);
    if (bn !== an) return bn - an;
    return String(b?.created_at ?? "").localeCompare(String(a?.created_at ?? ""));
  });
  const r = matching[0];
  const run = {
    id: r?.id ?? null,
    run_number: r?.run_number ?? null,
    event: r?.event ?? null,
    status: r?.status ?? null,
    conclusion: r?.conclusion ?? null,
    html_url: r?.html_url ?? null,
    head_sha: r?.head_sha ?? null,
    created_at: r?.created_at ?? null,
  };
  return { ok: true, found: true, run, runs: matching.map((x) => ({
    id: x?.id ?? null,
    run_number: x?.run_number ?? null,
    event: x?.event ?? null,
    status: x?.status ?? null,
    conclusion: x?.conclusion ?? null,
    html_url: x?.html_url ?? null,
    head_sha: x?.head_sha ?? null,
    created_at: x?.created_at ?? null,
  })) };
}

export function shortSha(sha) {
  return String(sha ?? "").slice(0, 7);
}

export async function getPRCiState(env, prNumber) {
  const found = await fetchOpenPR(env, prNumber);
  if (!found.ok) {
    return {
      ok: false,
      code: found.code,
      state: "error",
      reason: "error",
      sha: null,
      branch: null,
      short_sha: null,
      run: null,
      runs: [],
      status: found.status ?? null,
      target_url: null,
      http_status: found.status ?? null,
    };
  }
  const sha = found.pr?.head?.sha ? String(found.pr.head.sha) : "";
  const branch = found.pr?.head?.ref ? String(found.pr.head.ref) : "";
  if (!sha) {
    return { ok: false, code: "no_sha", state: "error", reason: "error", sha: null, branch, short_sha: null, run: null, runs: [], status: null, target_url: null, http_status: null };
  }

  const repo = devRepo(env);
  let statusRes = null;
  let statusData = null;
  let statusHttp = null;
  let forbidden = false;
  let statusError = false;
  try {
    statusRes = await githubFetch(env, `/repos/${repo}/commits/${encodeURIComponent(sha)}/status`);
    statusHttp = statusRes.status;
    if (statusRes.status === 401 || statusRes.status === 403) forbidden = true;
    else if (statusRes.ok) statusData = await statusRes.json();
    else statusError = true;
  } catch {
    statusError = true;
  }

  const statuses = Array.isArray(statusData?.statuses) ? statusData.statuses : [];
  const ci = statuses.find((s) => s && s.context === CI_STATUS_CONTEXT) || null;
  const statusState = ci
    ? (["success", "failure", "error", "pending"].includes(String(ci.state ?? "").toLowerCase())
        ? String(ci.state).toLowerCase()
        : "pending")
    : (statusData ? "missing" : null);
  const targetUrl = ci?.target_url ?? statusData?.target_url ?? null;

  const runsResult = await getCiRuns(env, sha, 10);
  const runs = runsResult.ok ? runsResult.runs : [];
  const run = runsResult.ok && runsResult.found ? runsResult.run : null;
  const runsForbidden = !runsResult.ok && (runsResult.status === 401 || runsResult.status === 403);
  const runsError = !runsResult.ok && !runsForbidden;

  let runState = "no_ci";
  if (run) {
    const st = String(run.status ?? "").toLowerCase();
    const concl = String(run.conclusion ?? "").toLowerCase();
    if (st === "completed") {
      if (concl === "success") runState = "success";
      else if (["failure", "cancelled", "timed_out", "startup_failure", "action_required"].includes(concl)) runState = "failure";
      else runState = "failure";
    } else if (["queued", "in_progress", "waiting", "requested", "pending"].includes(st)) {
      runState = "pending";
    } else {
      runState = "pending";
    }
  }

  // Event-aware gate: a completed pull_request run that failed is a real
  // failure for this SHA, even if a later workflow_dispatch run succeeded.
  // workflow_dispatch runs before the Trigger CI fix checked out main, so
  // they must not mask a pull_request failure. A pull_request run that is
  // still action_required blocks only while no successful test of this SHA
  // exists: bot-authored PRs' pull_request runs need manual approval and
  // never run on their own, while Trigger CI (workflow_dispatch, since 3m
  // checking out the PR head SHA) already tested this SHA and posted the
  // commit status. A pull_request run that is actually queued/in_progress
  // still blocks, because it may yet fail.
  const prRuns = runs.filter((r) => String(r?.event ?? "") === "pull_request");
  const prFailed = prRuns.some((r) => String(r?.status ?? "").toLowerCase() === "completed" && ["failure", "cancelled", "timed_out", "startup_failure"].includes(String(r?.conclusion ?? "").toLowerCase()));
  const prActionRequired = prRuns.some((r) => String(r?.conclusion ?? "").toLowerCase() === "action_required");
  const prPending = prRuns.some((r) => ["queued", "in_progress", "waiting", "requested", "pending"].includes(String(r?.status ?? "").toLowerCase()));
  const wdSuccess = runs.some((r) => String(r?.event ?? "") === "workflow_dispatch" && String(r?.status ?? "").toLowerCase() === "completed" && String(r?.conclusion ?? "").toLowerCase() === "success");
  const prActionRequiredBlocked = prActionRequired && !(wdSuccess && statusState === "success");
  let state;
  if (prFailed) state = "failure";
  else if (prPending || prActionRequiredBlocked) state = "pending";
  else if (forbidden || runsForbidden) state = "forbidden";
  else if (statusState === "failure" || statusState === "error") state = "failure";
  else if (statusError) state = "error";
  else if (runsError) state = "error";
  else if (runState === "success") state = "success";
  else if (runState === "failure") state = "failure";
  else if (runState === "pending") state = "pending";
  else state = "no_ci";

  const httpStatus = (runsForbidden || runsError)
    ? (runsResult.status ?? statusHttp)
    : statusHttp;
  return {
    ok: true,
    code: state,
    state,
    reason: state,
    sha,
    branch,
    short_sha: shortSha(sha),
    run,
    runs,
    status: httpStatus,
    target_url: targetUrl,
    http_status: httpStatus,
    status_state: statusState,
    run_state: runState,
  };
}
export function ciStateEmoji(state) {
  const s = String(state ?? "").toLowerCase();
  if (s === "success") return "✅";
  if (s === "failure" || s === "error") return "❌";
  return "⏳";
}
export async function findLatestDispatchPR(env) {
  const repo = devRepo(env);
  let res;
  try {
    res = await githubFetch(env, `/repos/${repo}/pulls?state=open&per_page=100`);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  const list = Array.isArray(data) ? data : [];
  const dispatch = list
    .filter((p) => isDispatchBranch(p?.head?.ref))
    .sort((a, b) => new Date(b?.created_at ?? 0).getTime() - new Date(a?.created_at ?? 0).getTime());
  return dispatch.length ? (dispatch[0]?.number ?? null) : null;
}

export async function getDiag(env, prNumber) {
  const found = await fetchOpenPR(env, prNumber);
  if (!found.ok) {
    return `PR #${prNumber}: ${found.code ?? "error"} (HTTP ${found.status ?? "?"})`;
  }
  const pr = found.pr;
  const sha = pr?.head?.sha ? String(pr.head.sha) : "";
  const branch = pr?.head?.ref ? String(pr.head.ref) : "";
  const state = pr?.state ?? "?";
  const merged = pr?.merged === true;
  const repo = devRepo(env);

  let statusLines = "";
  let statusHttp = null;
  try {
    const res = await githubFetch(env, `/repos/${repo}/commits/${encodeURIComponent(sha)}/status`);
    statusHttp = res.status;
    if (res.ok) {
      const data = await res.json();
      const statuses = Array.isArray(data?.statuses) ? data.statuses : [];
      statusLines = statuses.length
        ? statuses.map((s) => `  - ${s.context}: ${s.state}`).join("\n")
        : "  (none)";
    } else if (res.status === 401 || res.status === 403) {
      statusLines = `  (forbidden, HTTP ${res.status})`;
    } else {
      statusLines = `  (HTTP ${res.status})`;
    }
  } catch {
    statusLines = "  (error)";
  }

  const runsResult = await getCiRuns(env, sha, 5);
  let runLines = "";
  if (runsResult.ok) {
    if (runsResult.runs && runsResult.runs.length) {
      runLines = runsResult.runs
        .map((r) => `  - #${r.run_number ?? "?"} ${r.event ?? "?"} ${r.status ?? "?"}/${r.conclusion ?? "?"} sha=${shortSha(r.head_sha)} ${r.html_url ?? ""}`)
        .join("\n");
    } else {
      runLines = "  (none)";
    }
  } else {
    runLines = `  (HTTP ${runsResult.status ?? "?"})`;
  }

  const ci = await getPRCiState(env, prNumber);
  return (
    `PR #${prNumber}: state=${state}${merged ? " (merged)" : ""}\n` +
    `branch: ${branch}\n` +
    `head sha: ${shortSha(sha)}\n` +
    `commit statuses on ${shortSha(sha)}:\n${statusLines}\n` +
    `last ci.yml runs:\n${runLines}\n` +
    `verdict: ${ci.state}`
  );
}

export async function approveDevPR(env, prNumber) {
  if (!env?.GITHUB_DISPATCH_TOKEN) {
    return { ok: false, code: "missing_token", text: "GITHUB_DISPATCH_TOKEN is missing on the Worker." };
  }
  const repo = devRepo(env);
  try {
    const found = await fetchOpenPR(env, prNumber);
    if (!found.ok) {
      const pr = found.pr;
      if (found.code === "pr_not_found" || found.status === 404) {
        return {
          ok: false,
          code: "pr_not_found",
          text: `❌ PR #${prNumber} پیدا نشد.\nPR #${prNumber} was not found.`,
        };
      }
      if (pr && pr.merged === true) {
        return {
          ok: false,
          code: "pr_merged",
          text: `✅ این PR قبلاً merge شده است.\nThis PR is already merged.`,
        };
      }
      if (pr && pr.state === "closed") {
        return {
          ok: false,
          code: "pr_closed",
          text: `🗑 این PR قبلاً بسته/رد شده است.\nThis PR is already closed.`,
        };
      }
      return {
        ok: false,
        code: found.code,
        text: `❌ PR #${prNumber} باز نیست.\nPR #${prNumber} is not open.`,
      };
    }
    const pr = found.pr;
    if (!isDispatchBranch(pr?.head?.ref)) {
      return {
        ok: false,
        code: "not_dispatch_branch",
        text:
          `⛔ شاخه‌ی PR «${String(pr?.head?.ref ?? "").slice(0, 80)}» شاخه‌ی dispatch نیست — merge ممنوع.\n` +
          `Refusing to merge: the PR head branch is not a dispatch branch.`,
      };
    }

    const filesRes = await githubFetch(env, `/repos/${repo}/pulls/${Number(prNumber)}/files?per_page=100`);
    if (!filesRes.ok) {
      return {
        ok: false,
        code: "files_failed",
        text: `❌ خواندن فایل‌های PR شکست خورد (HTTP ${filesRes.status}).`,
      };
    }
    const files = await filesRes.json();
    const violations = pathGuardViolations(files);
    if (violations.length) {
      return {
        ok: false,
        code: "forbidden_files",
        files: violations,
        text:
          `⛔ فایل ممنوع در PR: ${violations.slice(0, 8).join(", ")}\n` +
          `Blocked: PR touches protected paths.`,
      };
    }

    const ci = await getPRCiState(env, prNumber);
    const shaShort = ci.short_sha || shortSha(ci.sha);
    const run = ci.run;
    const runLine = run
      ? `CI: ${ciStateEmoji(ci.state === "success" ? "success" : ci.state === "failure" ? "failure" : "pending")} run #${run.run_number ?? "?"} on ${shaShort}`
      : `CI: ${ciStateEmoji(ci.state === "success" ? "success" : ci.state === "failure" ? "failure" : "pending")} ${ci.state}`;
    const runUrl = run?.html_url ? `\n${run.html_url}` : (ci.target_url ? `\n${ci.target_url}` : "");
    if (ci.state !== "success") {
      if (ci.state === "failure") {
        return {
          ok: false,
          code: "ci_failed",
          ci,
          text:
            `❌ CI ناموفق بود. merge انجام نشد.\n` +
            `CI failed; merge was not performed.\n${runLine}${runUrl}`,
        };
      }
      if (ci.state === "forbidden") {
        return {
          ok: false,
          code: "ci_forbidden",
          ci,
          text:
            "⛔ توکن GitHub اجازه‌ی خواندن وضعیت CI را ندارد (Commit statuses: Read).\n" +
            "The GitHub token lacks the 'Commit statuses: Read' permission.",
        };
      }
      if (ci.state === "no_ci") {
        const repo = devRepo(env);
        const link = `https://github.com/${repo}/pull/${prNumber}/checks`;
        return {
          ok: false,
          code: "ci_no_status",
          ci,
          text:
            `⏳ CI هنوز گزارشی نداده است.\n` +
            `CI has not reported yet.\n${link}`,
        };
      }
      if (ci.state === "error") {
        const code = ci.http_status ? ` (HTTP ${ci.http_status})` : "";
        return {
          ok: false,
          code: "ci_error",
          ci,
          text:
            `❌ خواندن وضعیت CI شکست خورد${code}.\n` +
            `Reading CI status failed${code}.`,
        };
      }
      return {
        ok: false,
        code: "ci_pending",
        ci,
        text:
          `⏳ CI هنوز در حال اجراست. کمی بعد دوباره تلاش کن.\n` +
          `CI is still running. Try again shortly.\n${runLine}${runUrl}`,
      };
    }

    const mergeRes = await githubFetch(env, `/repos/${repo}/pulls/${Number(prNumber)}/merge`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merge_method: "squash" }),
    });
    if (!mergeRes.ok) {
      return {
        ok: false,
        code: "merge_failed",
        status: mergeRes.status,
        text: `❌ merge شکست خورد (HTTP ${mergeRes.status}).\nMerge failed (HTTP ${mergeRes.status}).`,
      };
    }
    const merged = await mergeRes.json().catch(() => ({}));
    const branch = String(pr?.head?.ref ?? "");
    if (branch && isDispatchBranch(branch)) {
      const refPath = branch.split("/").map((p) => encodeURIComponent(p)).join("/");
      try {
        await githubFetch(env, `/repos/${repo}/git/refs/heads/${refPath}`, { method: "DELETE" });
      } catch {
        // ignore: branch deletion must not fail the approve flow
      }
    }
    return {
      ok: true,
      sha: merged?.sha ?? null,
      text:
        `✅ PR #${prNumber} با squash merge شد.\n` +
        `PR #${prNumber} merged with squash.`,
    };
  } catch (err) {
    return {
      ok: false,
      code: err?.code || "network",
      text:
        err?.code === "missing_token"
          ? "GITHUB_DISPATCH_TOKEN is missing on the Worker."
          : "❌ خطای شبکه/GitHub هنگام merge.\nNetwork/GitHub error while merging.",
    };
  }
}

export async function rejectDevPR(env, prNumber) {
  if (!env?.GITHUB_DISPATCH_TOKEN) {
    return { ok: false, code: "missing_token", text: "GITHUB_DISPATCH_TOKEN is missing on the Worker." };
  }
  const repo = devRepo(env);
  try {
    const found = await fetchOpenPR(env, prNumber);
    if (!found.ok) {
      const pr = found.pr;
      if (found.code === "pr_not_found" || found.status === 404) {
        return {
          ok: false,
          code: "pr_not_found",
          text: `PR #${prNumber} پیدا نشد.\nPR #${prNumber} was not found.`,
        };
      }
      if (pr && pr.merged === true) {
        return {
          ok: false,
          code: "pr_merged",
          text: `این PR قبلاً merge شده است.\nThis PR is already merged.`,
        };
      }
      if (pr && pr.state === "closed") {
        return {
          ok: false,
          code: "pr_closed",
          text: `این PR قبلاً بسته/رد شده است.\nThis PR is already closed.`,
        };
      }
      return {
        ok: false,
        code: found.code,
        text: `PR #${prNumber} باز نیست — چیزی برای reject نیست.\nPR #${prNumber} is not open.`,
      };
    }
    const pr = found.pr;
    const branch = String(pr?.head?.ref ?? "");

    const closeRes = await githubFetch(env, `/repos/${repo}/pulls/${Number(prNumber)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    });
    if (!closeRes.ok) {
      return {
        ok: false,
        code: "close_failed",
        status: closeRes.status,
        text: `❌ بستن PR شکست خورد (HTTP ${closeRes.status}).\nClosing the PR failed.`,
      };
    }

    let deleted = false;
    if (isDispatchBranch(branch)) {
      const refPath = branch.split("/").map((p) => encodeURIComponent(p)).join("/");
      const delRes = await githubFetch(env, `/repos/${repo}/git/refs/heads/${refPath}`, {
        method: "DELETE",
      });
      deleted = delRes.ok || delRes.status === 422;
    }

    return {
      ok: true,
      deleted,
      text:
        `🗑 PR #${prNumber} بسته شد${deleted ? " و شاخه حذف شد" : ""}.\n` +
        `PR #${prNumber} closed${deleted ? " and the branch was deleted" : ""}.`,
    };
  } catch (err) {
    return {
      ok: false,
      code: err?.code || "network",
      text:
        err?.code === "missing_token"
          ? "GITHUB_DISPATCH_TOKEN is missing on the Worker."
          : "❌ خطای شبکه/GitHub هنگام reject.\nNetwork/GitHub error while rejecting.",
    };
  }
}
