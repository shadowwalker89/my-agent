// تست آفلاین pipeline 3i: intent router، executor، dev dispatch/HMAC، path guard
// و مسیرهای Telegram. بدون شبکه/KV/راز — fetch و KV شبیه‌سازی می‌شوند.
// اجرا: node scripts/test-dev.mjs
import {
  classifyIntentSync,
  classifyIntent,
  needsConfirmation,
} from "../src/intent.js";
import { runTask, EXECUTOR_NOT_CONFIGURED } from "../src/executor.js";
import {
  isForbiddenPath,
  pathGuardViolations,
  isDispatchBranch,
  safeEqualStr,
  hmacHex,
  verifyCallbackSignature,
  safeGithubUrl,
  getCiRuns,
  getPRCiStatus,
  getPRCiState,
} from "../src/dev.js";
import { isProtectedPath } from "../src/guard.js";
import { normalizePrefs, DEFAULT_PREFS } from "../src/tgprefs.js";

const failures = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
}

function fakeKV() {
  const store = new Map();
  return {
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
    async list() {
      return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true };
    },
    store,
  };
}

// ── 1) intent classifier ───────────────────────────────────────────────────
{
  const dev = classifyIntentSync("add a /health endpoint to the worker");
  check(dev.intent === "dev" && dev.confidence >= 0.9, `EN dev: ${JSON.stringify(dev)}`);

  const devFa = classifyIntentSync("پروژه رو بهتر کن");
  check(devFa.intent === "dev" && devFa.confidence >= 0.9, `FA dev: ${JSON.stringify(devFa)}`);

  const task = classifyIntentSync("convert this pdf to docx");
  check(task.intent === "task" && task.confidence >= 0.85, `task: ${JSON.stringify(task)}`);

  const chat = classifyIntentSync("hello there, how are you?");
  check(chat.intent === "chat", `chat: ${JSON.stringify(chat)}`);

  const refOnly = classifyIntentSync("worker");
  check(refOnly.intent === "dev" && refOnly.confidence < 0.7, `project-ref-only: ${JSON.stringify(refOnly)}`);

  const actionOnly = classifyIntentSync("please add something");
  check(actionOnly.intent === "dev" && actionOnly.confidence < 0.7, `action-only: ${JSON.stringify(actionOnly)}`);

  const empty = classifyIntentSync("   ");
  check(empty.intent === "chat" && empty.confidence === 1, `empty: ${JSON.stringify(empty)}`);

  check(needsConfirmation({ intent: "dev", confidence: 0.55 }) === true, "dev 0.55 → confirm");
  check(needsConfirmation({ intent: "dev", confidence: 0.9 }) === false, "dev 0.9 → no confirm");
  check(needsConfirmation({ intent: "chat", confidence: 0.1 }) === false, "chat → no confirm");

  const noLlm = await classifyIntent("worker", { callLLM: false });
  check(noLlm.intent === "dev" && noLlm.confidence < 0.7, `callLLM=false: ${JSON.stringify(noLlm)}`);

  // بدون ROUTER_KEY نباید LLM صدا زده شود و نباید به chat تنزل کند.
  const noKey = await classifyIntent("worker", { env: { STATE: fakeKV() } });
  check(noKey.intent === "dev" && noKey.confidence < 0.7, `no ROUTER_KEY: ${JSON.stringify(noKey)}`);
}

// ── 2) prefs.intent ────────────────────────────────────────────────────────
{
  check(DEFAULT_PREFS.intent === true, "DEFAULT_PREFS.intent باید true باشد");
  check(normalizePrefs({ intent: false }).intent === false, "intent=false حفظ شود");
  check(normalizePrefs({ intent: "no" }).intent === true, "intent غیر boolean نادیده گرفته شود");
  check(normalizePrefs(null).intent === true, "intent پیش‌فرض true");
}

// ── 3) path guard + branch ─────────────────────────────────────────────────
{
  check(isForbiddenPath(".github/workflows/opencode-dev.yml") === true, "workflow ممنوع");
  check(isForbiddenPath("src/index.js") === false, "src مجاز");
  check(isForbiddenPath("wrangler.jsonc") === true, "wrangler ممنوع");
  check(isForbiddenPath("wrangler.toml") === true, "wrangler.toml ممنوع");
  check(isForbiddenPath("wrangler.json") === true, "wrangler.json ممنوع");
  check(isForbiddenPath(".github/workflows/ci.yml") === true, "ci.yml ممنوع");
  check(isForbiddenPath(".github/workflows/deploy.yml") === true, "deploy.yml ممنوع");
  check(isForbiddenPath(".dev.vars") === true, ".dev.vars ممنوع");
  check(isForbiddenPath(".env.local") === true, ".env.local ممنوع");
  check(isForbiddenPath("package-lock.json") === true, "package-lock ممنوع");
  check(isForbiddenPath("opencode.json") === true, "opencode.json ممنوع");
  check(isForbiddenPath("docs/opencode-ci.md") === false, "docs مجاز");
  check(isForbiddenPath("src\\index.js") === false, "backslash نرمال شود");
  check(isForbiddenPath(".github\\workflows\\a.yml") === true, "backslash ممنوع");
  check(isForbiddenPath("README.md") === false, "README مجاز");

  // shared module used by the workflow and the Worker
  check(isProtectedPath(".github/workflows/x.yml") === true, "guard: workflow ممنوع");
  check(isProtectedPath("wrangler.jsonc") === true, "guard: wrangler ممنوع");
  check(isProtectedPath("wrangler.json") === true, "guard: wrangler.json ممنوع");
  check(isProtectedPath("src/index.js") === false, "guard: src مجاز");
  check(isProtectedPath("opencode.json") === true, "guard: opencode.json ممنوع");
  check(isProtectedPath("README.md") === false, "guard: README مجاز");

  const v = pathGuardViolations([{ filename: "src/a.js" }, { filename: "wrangler.jsonc" }, "docs/x.md"]);
  check(v.length === 1 && v[0] === "wrangler.jsonc", `violations: ${JSON.stringify(v)}`);

  check(isDispatchBranch("opencode/dispatch-abc-123") === true, "opencode/dispatch-*");
  check(isDispatchBranch("dispatch/task-1") === true, "dispatch/*");
  check(isDispatchBranch("feature/x") === false, "feature/x رد شود");
}

// ── 4) HMAC / replay ───────────────────────────────────────────────────────
{
  check(safeEqualStr("abc", "abc") === true, "safeEqual برابر");
  check(safeEqualStr("abc", "abd") === false, "safeEqual نابرابر");
  check(safeEqualStr("abc", "abcd") === false, "safeEqual طول");
  check(safeEqualStr(null, "a") === false, "safeEqual غیر رشته");

  const sig1 = await hmacHex("secret", "payload");
  const sig2 = await hmacHex("secret", "payload");
  check(sig1 === sig2 && /^[0-9a-f]{64}$/.test(sig1), "hmacHex پایدار و hex");

  const secret = "test-callback-secret";
  const env = { STATE: fakeKV(), DEV_CALLBACK_SECRET: secret };
  const now = Date.now();

  const body = { timestamp: now, nonce: "nonce-abc-123", ok: true, pr: 7, chat_id: "4242" };
  const raw = JSON.stringify(body);
  const sig = await hmacHex(secret, raw);

  const ok = await verifyCallbackSignature(env, raw, sig, now);
  check(ok.ok === true && ok.body?.pr === 7, `verify ok: ${JSON.stringify(ok)}`);

  const replay = await verifyCallbackSignature(env, raw, sig, now);
  check(replay.ok === false && replay.code === "replay", `replay: ${JSON.stringify(replay)}`);

  const staleBody = { timestamp: now - 10 * 60 * 1000, nonce: "nonce-stale-1" };
  const staleRaw = JSON.stringify(staleBody);
  const staleSig = await hmacHex(secret, staleRaw);
  const stale = await verifyCallbackSignature(env, staleRaw, staleSig, now);
  check(stale.ok === false && stale.code === "stale", `stale: ${JSON.stringify(stale)}`);

  const bad = await verifyCallbackSignature(env, raw, "0".repeat(64), now);
  check(bad.ok === false && bad.code === "bad_signature", `bad sig: ${JSON.stringify(bad)}`);

  const noSecret = await verifyCallbackSignature({ STATE: fakeKV() }, raw, sig, now);
  check(noSecret.ok === false && noSecret.code === "no_secret", `no secret: ${JSON.stringify(noSecret)}`);
}

// ── 5) executor interface ──────────────────────────────────────────────────
{
  const notConfigured = await runTask({}, { kind: "task", prompt: "convert a.pdf" });
  check(
    notConfigured.ok === false && notConfigured.code === "not_configured" && notConfigured.text === EXECUTOR_NOT_CONFIGURED,
    `not configured: ${JSON.stringify(notConfigured)}`,
  );
  const empty = await runTask({ EXECUTOR: "freestyle" }, { kind: "task", prompt: "  " });
  check(empty.ok === false && empty.code === "empty_prompt", `empty prompt: ${JSON.stringify(empty)}`);
  const unsupported = await runTask({}, { kind: "image", prompt: "x" });
  check(unsupported.ok === false && unsupported.code === "unsupported_kind", `unsupported kind: ${JSON.stringify(unsupported)}`);
}

// ── mock world (telegram + github + unexpected) ────────────────────────────
function mockWorld({ prFiles = [], ciState = "success", ciTargetUrl = "https://ci.example/run/1", ciRuns = [{ status: "completed", conclusion: "success", html_url: "https://runs.example/1", head_sha: "headsha123", run_number: 12, event: "push", created_at: "2026-01-01T00:00:00Z" }], runsForbidden = false, ciRunsStatus = 200, prState = "open", prMerged = false, prMissing = false } = {}) {
  const calls = { telegram: [], github: [], unexpected: 0 };
  const orig = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://api.telegram.org/")) {
      const m = /\/bot[^/]+\/(\w+)$/.exec(u);
      let payload = {};
      try {
        payload = JSON.parse(String(init.body ?? "{}"));
      } catch {}
      calls.telegram.push({ method: m ? m[1] : "", payload });
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    if (u.startsWith("https://api.github.com/")) {
      const method = String(init.method ?? "GET").toUpperCase();
      let body = null;
      try {
        body = init.body ? JSON.parse(String(init.body)) : null;
      } catch {}
      calls.github.push({ method, url: u, body });
       if (u.includes("/actions/workflows/ci.yml/runs") && method === "GET") {
         if (runsForbidden) return new Response("", { status: 403 });
         if (ciRunsStatus && ciRunsStatus !== 200) return new Response("", { status: ciRunsStatus });
         return Response.json({ workflow_runs: ciRuns });
       }
      if (u.includes("/actions/workflows/")) return new Response(null, { status: 204 });
      if (/\/pulls\/\d+\/files/.test(u)) return Response.json(prFiles);
      if (/\/pulls\/\d+\/merge$/.test(u) && method === "PUT") {
        return Response.json({ sha: "deadbeef", merged: true });
      }
      if (/\/commits\/[^/]+\/status$/.test(u) && method === "GET") {
        if (ciState === "forbidden") return new Response("", { status: 403 });
        if (ciState === "error") return new Response("", { status: 500 });
        return Response.json({
          state: ciState === "missing" ? "pending" : ciState,
          statuses: ciState === "missing" ? [] : [{ context: "ci/offline-checks", state: ciState, target_url: ciTargetUrl }],
        });
      }
      if (prMissing) {
        // handled below by status check
      }
      if (/\/pulls\/\d+$/.test(u) && method === "GET") {
        if (prMissing) return new Response("", { status: 404 });
        return Response.json({
          state: prState,
          merged: prMerged,
          merged_at: prMerged ? "2026-01-01T00:00:00Z" : null,
          number: 7,
          head: { ref: "opencode/dispatch-abc-123", sha: "headsha123" },
          html_url: "https://github.com/shadowwalker89/my-agent/pull/7",
        });
      }
      if (/\/pulls\/\d+$/.test(u) && method === "PATCH") return Response.json({ state: "closed" });
      if (u.includes("/git/refs/heads/") && method === "DELETE") return new Response(null, { status: 204 });
      return new Response("", { status: 200 });
    }
    calls.unexpected += 1;
    return new Response(JSON.stringify({ error: { message: "unexpected fetch" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, restore: () => (global.fetch = orig) };
}

const workerDefault = (await import("../src/index.js")).default;
const ctxNull = {};

async function sendTg(env, update) {
  const pending = [];
  const res = await workerDefault.fetch(
    new Request("https://test.local/telegram", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": env.TG_SECRET },
      body: JSON.stringify(update),
    }),
    env,
    { waitUntil: (p) => pending.push(p) },
  );
  check(res.status === 200, `/telegram باید 200 بدهد (${res.status})`);
  await Promise.all(pending);
}

function msgUpdate(text, userId = 4242) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: Math.floor(Date.now() / 1000),
      from: { id: userId, is_bot: false, first_name: "T" },
      chat: { id: userId, type: "private" },
      text,
    },
  };
}

function cbUpdate(data, userId = 4242) {
  return {
    update_id: 2,
    callback_query: {
      id: "cb-1",
      from: { id: userId, is_bot: false, first_name: "T" },
      message: { message_id: 11, chat: { id: userId, type: "private" } },
      data,
    },
  };
}

function newEnv(extra = {}) {
  return {
    STATE: fakeKV(),
    TG_TOKEN: "fake-token",
    TG_SECRET: "fake-tg-secret",
    ALLOWED_TG_IDS: "4242",
    ...extra,
  };
}

// ── 6) POST /dev/callback ──────────────────────────────────────────────────
{
  const world = mockWorld();
  try {
    const secret = "test-callback-secret";
    const env = newEnv({ DEV_CALLBACK_SECRET: secret });
    await env.STATE.put("dev:active:4242", "1");

    const body = {
      timestamp: Date.now(),
      nonce: "nonce-cb-0001",
      ok: true,
      pr: 7,
      url: "https://github.com/shadowwalker89/my-agent/pull/7",
      chat_id: "4242",
      user_id: "4242",
    };
    const raw = JSON.stringify(body);
    const sig = await hmacHex(secret, raw);

    const res = await workerDefault.fetch(
      new Request("https://test.local/dev/callback", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Signature": sig },
        body: raw,
      }),
      env,
      ctxNull,
    );
    check(res.status === 200, `dev callback باید 200 (${res.status})`);
    const sent = world.calls.telegram.find((c) => c.method === "sendMessage");
    check(Boolean(sent), "callback باید sendMessage بفرستد");
    const kb = sent?.payload?.reply_markup?.inline_keyboard ?? [];
    const datas = kb.flat().map((b) => b.callback_data);
    check(datas.includes("dev:approve:7") && datas.includes("dev:reject:7"), `inline keyboard: ${JSON.stringify(datas)}`);
    check(sent?.payload?.text?.includes("PR #7"), "متن callback باید PR را نشان دهد");
    check(!JSON.stringify(sent?.payload ?? {}).includes(secret), "secret نباید در پیام باشد");
    check((await env.STATE.get("dev:active:4242")) === null, "active باید پاک شود");

    const replay = await workerDefault.fetch(
      new Request("https://test.local/dev/callback", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Signature": sig },
        body: raw,
      }),
      env,
      ctxNull,
    );
    check(replay.status === 401, `replay باید 401 (${replay.status})`);

    const noCfg = await workerDefault.fetch(
      new Request("https://test.local/dev/callback", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Signature": sig },
        body: raw,
      }),
      newEnv(),
      ctxNull,
    );
    check(noCfg.status === 503, `بدون secret باید 503 (${noCfg.status})`);

    const blockedBody = {
      timestamp: Date.now(),
      nonce: "nonce-cb-0002",
      ok: false,
      reason: "blocked: PR touches protected paths",
      pr: 8,
      chat_id: "4242",
      user_id: "4242",
    };
    const blockedRaw = JSON.stringify(blockedBody);
    const blockedSig = await hmacHex(secret, blockedRaw);
    const blockedRes = await workerDefault.fetch(
      new Request("https://test.local/dev/callback", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Signature": blockedSig },
        body: blockedRaw,
      }),
      env,
      ctxNull,
    );
    check(blockedRes.status === 200, `blocked callback باید 200 (${blockedRes.status})`);
    const blockedMsg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(
      String(blockedMsg?.payload?.text ?? "").includes("blocked: PR touches protected paths"),
      `پیام blocked: ${JSON.stringify(blockedMsg?.payload)}`,
    );
    check(!blockedMsg?.payload?.reply_markup, "blocked callback نباید دکمه‌ی approve داشته باشد");
  } finally {
    world.restore();
  }
}

// ── 7) Telegram intent routing ─────────────────────────────────────────────
{
  const world = mockWorld();
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });

    // dev با اطمینان بالا → dispatch
    await sendTg(env, msgUpdate("add a /health endpoint to the worker"));
    const dispatch = world.calls.github.find((c) => c.url.includes("/actions/workflows/"));
    check(Boolean(dispatch), "dev باید GitHub dispatch بفرستد");
    check(dispatch?.body?.inputs?.prompt === "add a /health endpoint to the worker", `dispatch prompt: ${JSON.stringify(dispatch?.body)}`);
    check(dispatch?.body?.inputs?.user_id === "4242", "dispatch باید user_id بفرستد");
    const devMsg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(String(devMsg?.payload?.text ?? "").includes("🚀"), "پیام dispatch باید تأیید کند");
    check((await env.STATE.get("dev:active:4242")) === "1", "active بعد از dispatch ست شود");

    // اطمینان پایین → دکمه‌ی تأیید، بدون dispatch
    await env.STATE.delete("dev:active:4242");
    const ghBefore = world.calls.github.length;
    await sendTg(env, msgUpdate("worker"));
    const confirmMsg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    const confirmKb = confirmMsg?.payload?.reply_markup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
    check(confirmKb.includes("intent:yes") && confirmKb.includes("intent:chat"), `دکمه‌های تأیید: ${JSON.stringify(confirmKb)}`);
    check(world.calls.github.length === ghBefore, "قبل از تأیید نباید dispatch شود");
    check(Boolean(await env.STATE.get("intent:pending:4242")), "pending intent باید ذخیره شود");

    // تأیید → dispatch با همان prompt
    await sendTg(env, cbUpdate("intent:yes"));
    const dispatch2 = world.calls.github.filter((c) => c.url.includes("/actions/workflows/")).at(-1);
    check(dispatch2?.body?.inputs?.prompt === "worker", `dispatch بعد از تأیید: ${JSON.stringify(dispatch2?.body)}`);
    check((await env.STATE.get("intent:pending:4242")) === null, "pending بعد از تأیید پاک شود");

    // task بدون executor → پیام پیکربندی + دکمه‌ی چت
    await env.STATE.delete("dev:active:4242");
    const ghBeforeTask = world.calls.github.length;
    await sendTg(env, msgUpdate("convert this pdf to docx"));
    const taskMsg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(String(taskMsg?.payload?.text ?? "").includes("Task executor is not configured"), "پیام executor");
    const taskKb = taskMsg?.payload?.reply_markup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
    check(taskKb.includes("intent:chat"), "دکمه‌ی «فقط چت»");
    check(world.calls.github.length === ghBeforeTask, "task نباید GitHub dispatch بفرستد");

    // /intent off → prefs
    await sendTg(env, msgUpdate("/intent off"));
    const prefs = await env.STATE.get("tgprefs:4242", "json");
    check(prefs?.intent === false, `prefs.intent بعد از /intent off: ${JSON.stringify(prefs)}`);

    // /dev مستقیم → dispatch
    const ghBeforeDev = world.calls.github.length;
    await env.STATE.delete("dev:active:4242");
    await sendTg(env, msgUpdate("/dev add a /health endpoint to the worker"));
    check(world.calls.github.length === ghBeforeDev + 1, "/dev باید dispatch کند");

    check(world.calls.unexpected === 0, `fetch غیرمنتظره: ${world.calls.unexpected}`);
  } finally {
    world.restore();
  }
}

// ── 8) Approve / Reject callbacks ──────────────────────────────────────────
{
  const world = mockWorld();
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });

    await env.STATE.put("dev:active:4242", "1");
    await sendTg(env, cbUpdate("dev:approve:7"));
    const merge = world.calls.github.find((c) => c.method === "PUT" && c.url.endsWith("/merge"));
    check(Boolean(merge), "approve باید merge بزند");
    const approveMsg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(String(approveMsg?.payload?.text ?? "").includes("✅"), `پیام approve: ${JSON.stringify(approveMsg?.payload)}`);
    check((await env.STATE.get("dev:active:4242")) === null, "active بعد از approve پاک شود");

    await sendTg(env, cbUpdate("dev:reject:7"));
    const close = world.calls.github.find((c) => c.method === "PATCH" && /\/pulls\/7$/.test(c.url));
    check(Boolean(close), "reject باید PR را ببندد");
    const del = world.calls.github.find((c) => c.method === "DELETE" && c.url.includes("/git/refs/heads/"));
    check(Boolean(del), "reject باید شاخه‌ی dispatch را حذف کند");
    const rejectMsg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(String(rejectMsg?.payload?.text ?? "").includes("🗑"), `پیام reject: ${JSON.stringify(rejectMsg?.payload)}`);

    check(world.calls.unexpected === 0, `fetch غیرمنتظره در approve/reject: ${world.calls.unexpected}`);
  } finally {
    world.restore();
  }
}

// ── 9) Approve blocked by path guard ───────────────────────────────────────
{
  const world = mockWorld({ prFiles: [{ filename: ".github/workflows/x.yml" }] });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await sendTg(env, cbUpdate("dev:approve:7"));
    const merge = world.calls.github.find((c) => c.method === "PUT" && c.url.endsWith("/merge"));
    check(!merge, "approve با فایل ممنوع نباید merge بزند");
    const msg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(String(msg?.payload?.text ?? "").includes("Blocked"), `پیام blocked approve: ${JSON.stringify(msg?.payload)}`);
    check(world.calls.unexpected === 0, `fetch غیرمنتظره در approve ممنوع: ${world.calls.unexpected}`);
  } finally {
    world.restore();
  }
}

// ── 10) Approve blocked/allowed by CI state (new gate) ──────────────────────
const CI_TARGET_URL = "https://github.com/o/r/actions/runs/1";
const RUN_SUCCESS = { status: "completed", conclusion: "success", html_url: "https://runs.example/success", head_sha: "headsha123", run_number: 12, event: "push", created_at: "2026-01-01T00:00:00Z" };
const RUN_FAILURE = { status: "completed", conclusion: "failure", html_url: "https://runs.example/fail", head_sha: "headsha123", run_number: 13, event: "push", created_at: "2026-01-01T00:00:00Z" };
const RUN_CANCELLED = { status: "completed", conclusion: "cancelled", html_url: "https://runs.example/cancelled", head_sha: "headsha123", run_number: 14, event: "push", created_at: "2026-01-01T00:00:00Z" };
const RUN_IN_PROGRESS = { status: "in_progress", conclusion: null, html_url: "https://runs.example/ip", head_sha: "headsha123", run_number: 15, event: "push", created_at: "2026-01-01T00:00:00Z" };
const RUN_QUEUED = { status: "queued", conclusion: null, html_url: "https://runs.example/q", head_sha: "headsha123", run_number: 16, event: "push", created_at: "2026-01-01T00:00:00Z" };
const RUN_OTHER_SHA = { status: "completed", conclusion: "success", html_url: "https://runs.example/other", head_sha: "other123456", run_number: 17, event: "push", created_at: "2026-01-01T00:00:00Z" };

// status failure overrides a successful run
{
  const world = mockWorld({ ciState: "failure", ciTargetUrl: CI_TARGET_URL, ciRuns: [RUN_SUCCESS] });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await sendTg(env, cbUpdate("dev:approve:7"));
    const merge = world.calls.github.find((c) => c.method === "PUT" && c.url.endsWith("/merge"));
    check(!merge, "status failure باید merge را بلاک کند");
    const msg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(Boolean(msg), "پیام برای status failure");
    check(world.calls.unexpected === 0, `fetch غیرمنتظره status failure: ${world.calls.unexpected}`);
  } finally { world.restore(); }
}
// status missing but run success -> allowed
{
  const world = mockWorld({ ciState: "missing", ciRuns: [RUN_SUCCESS] });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await env.STATE.put("dev:active:4242", "1");
    await sendTg(env, cbUpdate("dev:approve:7"));
    const merge = world.calls.github.find((c) => c.method === "PUT" && c.url.endsWith("/merge"));
    check(Boolean(merge), "status missing + run success باید merge بزند");
    check((await env.STATE.get("dev:active:4242")) === null, "active بعد از approve پاک شود");
    const del = world.calls.github.find((c) => c.method === "DELETE" && c.url.includes("/git/refs/heads/"));
    check(Boolean(del), "approve باید شاخه‌ی head را حذف کند");
  } finally { world.restore(); }
}
// run with different head_sha -> no_ci
{
  const world = mockWorld({ ciState: "success", ciRuns: [RUN_OTHER_SHA] });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await sendTg(env, cbUpdate("dev:approve:7"));
    const merge = world.calls.github.find((c) => c.method === "PUT" && c.url.endsWith("/merge"));
    check(!merge, "sha متفاوت نباید merge بزند");
    const msg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(String(msg?.payload?.text ?? "").includes("/pull/7/checks"), `no_ci باید checks link داشته باشد: ${JSON.stringify(msg?.payload)}`);
  } finally { world.restore(); }
}
// failure run -> blocked with run URL
{
  const world = mockWorld({ ciState: "success", ciRuns: [RUN_FAILURE] });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await sendTg(env, cbUpdate("dev:approve:7"));
    const merge = world.calls.github.find((c) => c.method === "PUT" && c.url.endsWith("/merge"));
    check(!merge, "run failure نباید merge بزند");
    const msg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(String(msg?.payload?.text ?? "").includes("https://runs.example/fail"), `پیام باید run URL داشته باشد: ${JSON.stringify(msg?.payload)}`);
  } finally { world.restore(); }
}
// cancelled run -> blocked with run URL
{
  const world = mockWorld({ ciState: "success", ciRuns: [RUN_CANCELLED] });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await sendTg(env, cbUpdate("dev:approve:7"));
    const merge = world.calls.github.find((c) => c.method === "PUT" && c.url.endsWith("/merge"));
    check(!merge, "run cancelled نباید merge بزند");
    const msg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(String(msg?.payload?.text ?? "").includes("https://runs.example/cancelled"), `پیام باید run URL داشته باشد: ${JSON.stringify(msg?.payload)}`);
  } finally { world.restore(); }
}
// in_progress -> pending
{
  const world = mockWorld({ ciState: "success", ciRuns: [RUN_IN_PROGRESS] });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await sendTg(env, cbUpdate("dev:approve:7"));
    const merge = world.calls.github.find((c) => c.method === "PUT" && c.url.endsWith("/merge"));
    check(!merge, "run in_progress نباید merge بزند");
    const msg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(String(msg?.payload?.text ?? "").includes("CI"), `پیام pending: ${JSON.stringify(msg?.payload)}`);
  } finally { world.restore(); }
}
// queued -> pending
{
  const world = mockWorld({ ciState: "success", ciRuns: [RUN_QUEUED] });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await sendTg(env, cbUpdate("dev:approve:7"));
    const merge = world.calls.github.find((c) => c.method === "PUT" && c.url.endsWith("/merge"));
    check(!merge, "run queued نباید merge بزند");
  } finally { world.restore(); }
}
// no run -> no_ci
{
  const world = mockWorld({ ciState: "success", ciRuns: [] });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await sendTg(env, cbUpdate("dev:approve:7"));
    const merge = world.calls.github.find((c) => c.method === "PUT" && c.url.endsWith("/merge"));
    check(!merge, "بدون run نباید merge بزند");
    const msg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(String(msg?.payload?.text ?? "").includes("/pull/7/checks"), `no_ci باید checks link داشته باشد: ${JSON.stringify(msg?.payload)}`);
  } finally { world.restore(); }
}
// HTTP 403 on runs call -> forbidden
{
  const world = mockWorld({ ciState: "success", runsForbidden: true });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await sendTg(env, cbUpdate("dev:approve:7"));
    const merge = world.calls.github.find((c) => c.method === "PUT" && c.url.endsWith("/merge"));
    check(!merge, "runs 403 نباید merge بزند");
    const msg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(String(msg?.payload?.text ?? "").includes("Commit statuses"), `forbidden پیام: ${JSON.stringify(msg?.payload)}`);
  } finally { world.restore(); }
}
// HTTP 500 on runs call -> HTTP 500
{
  const world = mockWorld({ ciState: "success", ciRunsStatus: 500 });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await sendTg(env, cbUpdate("dev:approve:7"));
    const merge = world.calls.github.find((c) => c.method === "PUT" && c.url.endsWith("/merge"));
    check(!merge, "runs 500 نباید merge بزند");
    const msg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(String(msg?.payload?.text ?? "").includes("500"), `پیام CI error باید کد HTTP داشته باشد: ${JSON.stringify(msg?.payload)}`);
  } finally { world.restore(); }
}
// original ciState loop (commit status only) kept for getPRCiStatus parity
for (const st of ["failure", "pending", "missing", "error"]) {
  const world = mockWorld({ ciState: st, ciRuns: [] });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await sendTg(env, cbUpdate("dev:approve:7"));
    const merge = world.calls.github.find((c) => c.method === "PUT" && c.url.endsWith("/merge"));
    check(!merge, `approve با CI=${st} نباید merge بزند`);
    check(world.calls.unexpected === 0, `fetch غیرمنتظره در CI=${st}: ${world.calls.unexpected}`);
  } finally { world.restore(); }
}

// ── 11) CI refresh button re-renders message ────────────────────────────────
{
  const world = mockWorld({ ciState: "success" });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await sendTg(env, cbUpdate("dev:ci:7"));
    const edit = world.calls.telegram.find((c) => c.method === "editMessageText");
    check(Boolean(edit), "dev:ci باید editMessageText بزند");
    check(String(edit?.payload?.text ?? "").includes("✅"), `refresh text: ${JSON.stringify(edit?.payload)}`);
    check(world.calls.unexpected === 0, `fetch غیرمنتظره در refresh: ${world.calls.unexpected}`);
  } finally {
    world.restore();
  }
}

// ── 12) /health route ───────────────────────────────────────────────────────
{
  const world = mockWorld();
  try {
    const env = newEnv();
    const res = await workerDefault.fetch(new Request("https://test.local/health"), env, ctxNull);
    check(res.status === 200, `/health باید 200 (${res.status})`);
    const json = await res.json();
    check(json?.ok === true, `/health باید {ok:true}: ${JSON.stringify(json)}`);
    check(world.calls.unexpected === 0 && world.calls.github.length === 0, "health نباید fetch/outbound داشته باشد");
  } finally {
    world.restore();
  }
}

// ── safeGithubUrl ───────────────────────────────────────────────────────────
{
  check(safeGithubUrl("https://github.com/shadowwalker89/my-agent/pull/7") === "https://github.com/shadowwalker89/my-agent/pull/7", "valid github url passes");
  check(safeGithubUrl("http://github.com/x") === "", "http rejected");
  check(safeGithubUrl("https://evil.com/https://github.com/x") === "", "other host rejected");
  check(safeGithubUrl("https://github.com.evil.com/x") === "", "lookalike rejected");
  check(safeGithubUrl("") === "", "empty rejected");
  check(safeGithubUrl(42) === "", "non-string rejected");
  check(safeGithubUrl(null) === "", "null rejected");
}

// ── no literal backslash-n in outgoing messages ─────────────────────────────
{
  const world = mockWorld({ ciState: "success", ciRuns: [{ status: "in_progress", conclusion: null, html_url: "https://runs.example/ip", head_sha: "headsha123", run_number: 15, event: "push", created_at: "2026-01-01T00:00:00Z" }] });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake", DEV_CALLBACK_SECRET: "test-callback-secret" });
    await sendTg(env, msgUpdate("add a /health endpoint to the worker"));
    await sendTg(env, cbUpdate("dev:approve:7"));
    const world2 = mockWorld({ ciState: "success", ciRuns: [{ status: "completed", conclusion: "failure", html_url: "https://runs.example/fail", head_sha: "headsha123", run_number: 13, event: "push", created_at: "2026-01-01T00:00:00Z" }] });
    try {
      const env2 = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
      await sendTg(env2, cbUpdate("dev:approve:7"));
    } finally {
      world2.restore();
    }
    await sendTg(env, cbUpdate("dev:reject:7"));
    await sendTg(env, cbUpdate("dev:ci:7"));
    for (const c of world.calls.telegram) {
      const t = c.payload?.text;
      if (typeof t === "string") {
        check(!/\\n/.test(t), `literal backslash-n in message: ${JSON.stringify(t)}`);
      }
    }
  } finally {
    world.restore();
  }
}

// ── dev callback message has no literal backslash-n ─────────────────────────
{
  const world = mockWorld();
  try {
    const secret = "test-callback-secret";
    const env = newEnv({ DEV_CALLBACK_SECRET: secret });
    const body = { timestamp: Date.now(), nonce: "nonce-msg-0001", ok: true, pr: 7, url: "https://github.com/shadowwalker89/my-agent/pull/7", chat_id: "4242", user_id: "4242" };
    const raw = JSON.stringify(body);
    const sig = await hmacHex(secret, raw);
    await workerDefault.fetch(new Request("https://test.local/dev/callback", { method: "POST", headers: { "content-type": "application/json", "X-Signature": sig }, body: raw }), env, ctxNull);
    const sent = world.calls.telegram.find((c) => c.method === "sendMessage");
    check(!/\\n/.test(String(sent?.payload?.text ?? "")), `callback message literal backslash-n: ${JSON.stringify(sent?.payload?.text)}`);
  } finally {
    world.restore();
  }
}

// ── getPRCiStatus reasons ───────────────────────────────────────────────────
for (const [st, expected] of [["success", "success"], ["failure", "failure"], ["pending", "pending"], ["missing", "no_status"], ["forbidden", "forbidden"], ["error", "error"]]) {
  const world = mockWorld({ ciState: st });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    const ci = await getPRCiStatus(env, 7);
    check(ci.reason === expected, `getPRCiStatus(${st}) reason=${ci.reason} (expected ${expected})`);
    if (st === "forbidden") check(ci.status === 403, `forbidden status ${ci.status}`);
    if (st === "error") check(ci.status === 500, `error status ${ci.status}`);
  } finally {
    world.restore();
  }
}

// ── getCiRuns optional lookup ───────────────────────────────────────────────
{
  const world = mockWorld({ ciState: "missing", ciRuns: [{ status: "completed", conclusion: "success", html_url: "https://runs.example/2", head_sha: "headsha123", run_number: 12, created_at: "2026-01-01T00:00:00Z" }] });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    const runs = await getCiRuns(env, "headsha123");
    check(runs.ok === true && runs.found === true && runs.run?.conclusion === "success", `getCiRuns found: ${JSON.stringify(runs)}`);
  } finally {
    world.restore();
  }
}
{
  const world = mockWorld({ ciState: "missing", ciRuns: [] });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    const runs = await getCiRuns(env, "headsha123");
    check(runs.ok === true && runs.found === false, `getCiRuns empty: ${JSON.stringify(runs)}`);
  } finally {
    world.restore();
  }
}
{
  const world = mockWorld({ ciState: "missing", runsForbidden: true });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    const runs = await getCiRuns(env, "headsha123");
    check(runs.ok === false, `getCiRuns forbidden skipped: ${JSON.stringify(runs)}`);
  } finally {
    world.restore();
  }
}

// ── approve deletes head branch ──────────────────────────────────────────────
{
  const world = mockWorld({ ciState: "success" });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await sendTg(env, cbUpdate("dev:approve:7"));
    const del = world.calls.github.find((c) => c.method === "DELETE" && c.url.includes("/git/refs/heads/"));
    check(Boolean(del), "approve باید شاخه‌ی head را حذف کند");
    check(String(del?.url ?? "").includes("opencode%2Fdispatch-abc-123") || String(del?.url ?? "").includes("opencode/dispatch-abc-123"), `delete url: ${JSON.stringify(del)}`);
  } finally {
    world.restore();
  }
}

// ── closed/merged/not-found PR handling ──────────────────────────────────────
{
  const world = mockWorld({ prMissing: true });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await sendTg(env, cbUpdate("dev:approve:7"));
    const msg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(String(msg?.payload?.text ?? "").includes("was not found"), `not found approve: ${JSON.stringify(msg?.payload)}`);
  } finally { world.restore(); }
}
{
  const world = mockWorld({ prState: "closed", prMerged: true });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await sendTg(env, cbUpdate("dev:approve:7"));
    const msg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(String(msg?.payload?.text ?? "").includes("already merged"), `merged approve: ${JSON.stringify(msg?.payload)}`);
  } finally { world.restore(); }
}
{
  const world = mockWorld({ prState: "closed", prMerged: false });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await sendTg(env, cbUpdate("dev:reject:7"));
    const msg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(String(msg?.payload?.text ?? "").includes("already closed"), `closed reject: ${JSON.stringify(msg?.payload)}`);
  } finally { world.restore(); }
}

if (failures.length) {
  console.error("\nFailures found:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
  process.exit(1);
}
console.log("\n✓ assertهای pipeline 3i برقرار شد.");
