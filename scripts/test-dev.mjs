// تست آفلاین pipeline 3i: intent router، executor، dev dispatch/HMAC، path guard
// و مسیرهای Telegram. بدون شبکه/KV/راز — fetch و KV شبیه‌سازی می‌شوند.
// اجرا: node scripts/test-dev.mjs
import {
  classifyIntentSync,
  classifyIntent,
  needsConfirmation,
  parseModelIntent,
  classifyDailyWithModel,
  workerBaseUrl,
  MODEL_INTENT_ALLOW,
  MODEL_INTENT_COMBO,
  MODEL_INTENT_MAX_TOKENS,
  MODEL_INTENT_TIMEOUT_MS,
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
import fs from "node:fs";
import { saveMessage, getLatestFileMessage } from "../src/db.js";
import {
  getChatContext,
  getSetting,
  setSetting,
  getDefaultCurrency,
  CHAT_CONTEXT_LIMIT,
  DEFAULT_CURRENCY,
} from "../src/memory.js";
import { iranDate, weekRange, monthRange, jalaliToGregorian, gregorianToJalali, formatJalali, parseRelativeDate, parseHour, parseReminder } from "../src/daily.js";
import { classifyDaily, parseAmount, parseNumberPhrase, normalizeText, bareDigits, resolveDefaultCurrency, sumByCurrency } from "../src/daily.js";

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

    // 1b-2: free-text dev only SUGGESTS /dev now, at any confidence.
    // It never dispatches and never stores a pending dev intent.
    await sendTg(env, msgUpdate("add a /health endpoint to the worker"));
    check(world.calls.github.filter((c) => c.url.includes("/actions/workflows/")).length === 0, "free-text dev must not dispatch");
    const devMsg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(String(devMsg?.payload?.text ?? "").includes("/dev"), "free-text dev must suggest /dev");
    check((await env.STATE.get("dev:active:4242")) === null, "free-text dev must not set active");
    check((await env.STATE.get("intent:pending:4242")) === null, "free-text dev must not store pending");
    const ghBefore = world.calls.github.length;
    await sendTg(env, msgUpdate("worker"));
    check(world.calls.github.length === ghBefore, "low-confidence dev must not dispatch either");
    check((await env.STATE.get("intent:pending:4242")) === null, "low-confidence dev must not store pending either");
    await sendTg(env, cbUpdate("intent:yes"));
    const expiredMsg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(String(expiredMsg?.payload?.text ?? "").includes("منقضی"), "stale intent:yes must say expired");

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

// ── getPRCiState: pull_request failure is not masked by workflow_dispatch success ─
{
  const world = mockWorld({ ciState: "missing", ciRuns: [
    { status: "completed", conclusion: "failure", html_url: "https://runs.example/pr", head_sha: "headsha123", run_number: 16, event: "pull_request", created_at: "2026-01-01T00:00:00Z" },
    { status: "completed", conclusion: "success", html_url: "https://runs.example/wd", head_sha: "headsha123", run_number: 17, event: "workflow_dispatch", created_at: "2026-01-01T00:01:00Z" },
  ] });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "x" });
    const ci = await getPRCiState(env, 7);
    check(ci.state === "failure", `getPRCiState pull_request failure masked: ${ci.state}`);
  } finally {
    world.restore();
  }
}

// ── getPRCiState: pull_request action_required does not block when Trigger CI tested this SHA ─
{
  const world = mockWorld({ ciState: "success", ciRuns: [
    { status: "completed", conclusion: "action_required", html_url: "https://runs.example/pr", head_sha: "headsha123", run_number: 23, event: "pull_request", created_at: "2026-01-01T00:00:00Z" },
    { status: "completed", conclusion: "success", html_url: "https://runs.example/wd", head_sha: "headsha123", run_number: 24, event: "workflow_dispatch", created_at: "2026-01-01T00:01:00Z" },
  ] });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "x" });
    const ci = await getPRCiState(env, 7);
    check(ci.state === "success", `getPRCiState action_required with wd success should be success: ${ci.state}`);
  } finally {
    world.restore();
  }
}
{
  // Same runs, but no successful commit status: action_required still blocks.
  const world = mockWorld({ ciState: "missing", ciRuns: [
    { status: "completed", conclusion: "action_required", html_url: "https://runs.example/pr", head_sha: "headsha123", run_number: 23, event: "pull_request", created_at: "2026-01-01T00:00:00Z" },
    { status: "completed", conclusion: "success", html_url: "https://runs.example/wd", head_sha: "headsha123", run_number: 24, event: "workflow_dispatch", created_at: "2026-01-01T00:01:00Z" },
  ] });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "x" });
    const ci = await getPRCiState(env, 7);
    check(ci.state === "pending", `getPRCiState action_required without status success should be pending: ${ci.state}`);
  } finally {
    world.restore();
  }
}
{
  // Narrow scope: a pull_request run actually in progress still blocks, even with wd success.
  const world = mockWorld({ ciState: "success", ciRuns: [
    { status: "in_progress", conclusion: null, html_url: "https://runs.example/pr", head_sha: "headsha123", run_number: 23, event: "pull_request", created_at: "2026-01-01T00:00:00Z" },
    { status: "completed", conclusion: "success", html_url: "https://runs.example/wd", head_sha: "headsha123", run_number: 24, event: "workflow_dispatch", created_at: "2026-01-01T00:01:00Z" },
  ] });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "x" });
    const ci = await getPRCiState(env, 7);
    check(ci.state === "pending", `getPRCiState pull_request in_progress should be pending: ${ci.state}`);
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

// ── Step 1a: D1 layer + memory layer (real SQLite, real migration SQL) ─────
// D1-compatible adapter over node:sqlite: db.js talks D1 (.prepare/.bind/
// .run/.all/.first); the adapter translates that to SQLite. This tests the
// real SQL (kind filter, LIMIT, ON CONFLICT) — the only simulation is the
// adapter itself, not the queries. Live D1 verification is still a 1b job.
let DatabaseSync = null;
try { DatabaseSync = (await import("node:sqlite")).DatabaseSync; } catch { console.warn("\u26a0 node:sqlite در دسترس نیست \u2014 تست‌های ۱الف رد شد."); }
if (DatabaseSync) {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
    sqlite.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    const db = {
      prepare(sql) {
        const stmt = sqlite.prepare(sql);
        return {
          bind(...params) {
            return {
              run: async () => {
                stmt.run(...params);
                return { success: true };
              },
              all: async () => ({ results: stmt.all(...params) }),
              first: async () => stmt.get(...params) ?? null,
            };
          },
        };
      },
    };
    const failingDb = { prepare() { throw new Error("boom"); } };

    // kind defaults to chat; daily rows are excluded from chat context.
    await saveMessage(db, { userId: 1, role: "user", content: "hello" });
    await saveMessage(db, { userId: 1, role: "assistant", content: "hi back" });
    await saveMessage(db, { userId: 1, role: "user", content: "spent 1000", kind: "daily" });
    await saveMessage(db, { userId: 1, role: "user", content: "bogus-kind", kind: "bogus" });
    const ctx = await getChatContext(db, 1);
    check(ctx.length === 3, `chat-only context: ${JSON.stringify(ctx.map((m) => m.content))}`);
    check(!ctx.some((m) => m.content === "spent 1000"), "daily message must not be in chat context");
    check(ctx[0].content === "hello" && ctx[1].role === "assistant", "context is oldest-first, roles kept");

    // Fixed date: a supplied ISO created_at is stored verbatim.
    await saveMessage(db, { userId: 2, role: "user", content: "dated", createdAt: "2026-10-28T00:00:00.000Z" });
    const dated = sqlite.prepare("SELECT created_at FROM messages WHERE user_id = 2").get();
    check(dated?.created_at === "2026-10-28T00:00:00.000Z", `fixed created_at: ${dated?.created_at}`);

    // Latest Telegram file reference (messages only; files table untouched).
    await saveMessage(db, { userId: 3, role: "user", content: "file", tgFileId: "AgACabc", fileName: "a.pdf", fileMime: "application/pdf" });
    const latest = await getLatestFileMessage(db, 3);
    check(latest?.tg_file_id === "AgACabc" && latest?.file_name === "a.pdf", `latest file: ${JSON.stringify(latest)}`);
    check((await getLatestFileMessage(db, 99)) === null, "no file for unknown user -> null");

    // Limit: 60 chat rows -> exactly the last 50, in order.
    for (let i = 1; i <= 60; i++) await saveMessage(db, { userId: 4, role: "user", content: `m${i}` });
    const ctx60 = await getChatContext(db, 4);
    check(ctx60.length === CHAT_CONTEXT_LIMIT, `limit 50: got ${ctx60.length}`);
    check(ctx60[0].content === "m11" && ctx60[49].content === "m60", "limit keeps newest 50 in order");

    // DB unavailable or failing: no throw, empty/false results, chat continues.
    check(JSON.stringify(await getChatContext(null, 1)) === "[]", "null DB -> empty context");
    check(JSON.stringify(await getChatContext({}, 1)) === "[]", "no-DB env -> empty context");
    check(JSON.stringify(await getChatContext(failingDb, 1)) === "[]", "failing DB -> empty context");
    check((await saveMessage(failingDb, { userId: 1, content: "x" })).ok === false, "failing DB save -> ok:false");
    check((await getSetting(null, 1, "currency")) === null, "null DB setting -> null");
    check((await getDefaultCurrency(null, 1)) === DEFAULT_CURRENCY, "null DB currency -> TOMAN");

    // Explicit settings only: unknown key refused, value upserts, no auto writer.
    check((await setSetting(db, 5, "mood", "happy")).ok === false, "unknown setting key refused");
    check((await setSetting(db, 5, "currency", "")).ok === false, "empty setting refused");
    await setSetting(db, 5, "currency", "USD");
    check((await getDefaultCurrency(db, 5)) === "USD", "explicit currency remembered");
    await setSetting(db, 5, "currency", "EUR");
    check((await getDefaultCurrency(db, 5)) === "EUR", "setting upserts to new value");
    check((await getDefaultCurrency(db, 6)) === "TOMAN", "fresh user -> fixed TOMAN, never inferred");
}


// ── Step 1b-1a: pure date/time functions (no Telegram, no D1, no model) ──
{
  const NOW = Date.UTC(2026, 9, 28, 12, 0, 0); // Wed 2026-10-28, 15:30 Iran time
  check(iranDate(Date.UTC(2026, 9, 28, 22, 0, 0)) === "2026-10-29", "iran midnight boundary");
  const wk = weekRange("2026-10-28"); check(wk.start === "2026-10-24" && wk.end === "2026-10-30", `week saturday: ${JSON.stringify(wk)}`);
  check(weekRange(null) === null && weekRange("2026-02-30") === null, "weekRange never crashes on invalid date");
  const mo = monthRange("2026-10-28"); check(mo.start === "2026-10-01" && mo.end === "2026-10-31", "month range is the whole month");
  check(jalaliToGregorian(1405, 8, 7) === "2026-10-29", "jalali to gregorian");
  const gj = gregorianToJalali("2026-10-29"); check(gj.jy === 1405 && gj.jm === 8 && gj.jd === 7, `gregorian to jalali: ${JSON.stringify(gj)}`);
  check(formatJalali("2026-10-29").includes("آبان"), "jalali display");
  check(parseRelativeDate("1405/8/7", NOW) === "2026-10-29", "jalali slash date");
  check(parseRelativeDate("2026-10-29", NOW) === "2026-10-29" && parseRelativeDate("2026-02-30", NOW) === null, "iso date validated");
  check(parseRelativeDate("۷ آبان، ۵۰۰ تومان نان", NOW) === "2026-10-29", "month found despite ، after it");
  check(parseRelativeDate("۷ آبان ۱۴۵۰۰۰ تومان", NOW) === "2026-10-29", "year not taken from 145000");
  check(parseRelativeDate("پس فردا", NOW) === "2026-10-30" && parseRelativeDate("پس‌فردا", NOW) === "2026-10-30", "day after tomorrow, with and without space");
  check(parseHour("ساعت ۳ بعد از ظهر").hour === 15, "afternoon checked before noon");
  check(parseHour("ساعت ۲ ظهر").hour === 14 && parseHour("ساعت ۱۲ ظهر").hour === 12 && parseHour("ساعت ۸ ظهر").ask === "hour-ambiguous", "noon rules: 12 stays, 1-4 +12, rest asks");
  check(parseHour("ساعت دوازده").hour === 12, "hour twelve, not two");
  check(parseHour("ساعت ۸ جلسه شبکه").hour === 8 && parseHour("ساعت ۸ صبحانه").hour === 8, "qualifiers inside other words do not count");
  check(parseHour("ساعت نه").hour === 9 && parseHour("ساعت پنج").ask === "hour-ambiguous", "hour nine morning, hour five asks");
  check(parseHour("ساعت دوازده شب").ask === "hour-ambiguous" && parseHour("ساعت یک شب").ask === "hour-ambiguous" && parseHour("ساعت ۸ شب").hour === 20, "night rules");
  check(parseHour("ساعت نه و ربع").hour === 9 && parseHour("ساعت نه و ربع").minute === 15, "quarter hour");
  check(parseReminder("یادم بینداز فردا ساعت نه جلسه دارم", NOW).due === "2026-10-29T09:00:00+03:30", "tomorrow 09:00 reminder");
  const rb = parseReminder("یادم بینداز فردا ساعت ۹ صبح جلسه دارم", NOW); check(rb.text === "جلسه دارم" && !rb.text.includes("صبح"), `reminder body drops qualifier: ${JSON.stringify(rb)}`);
  check(parseReminder("یادم بینداز فردا ساعت ۹", NOW).ask === "empty", "empty reminder asks for what");
  check(parseReminder("یادم بینداز فردا جلسه دارم", NOW).ask === "no-time", "reminder without time asks");
  check(parseReminder("یادم بینداز امروز ساعت نه جلسه دارم", NOW).ask === "past", "past reminder asks");
  check(parseReminder("یادم بینداز ۳۲ آبان ساعت ۹ جلسه", NOW).ask === "date", "invalid jalali day asks, never null date");
}

// ── Step 1b-1b: amount and classifier, on top of 1b-1a (still no wiring) ──
{
  const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
  const cl = (s) => classifyDaily(s, { nowMs: NOW });
  const ex = (s) => cl(s).extraction;
  // Word-number parser: 13-19, hundreds, "and" joins, multipliers.
  check(ex("خرج کردم بیست و پنج هزار تومان نان").amount === 25000, "twenty-five thousand");
  check(ex("خرج کردم دویست هزار تومان نان").amount === 200000, "two hundred thousand");
  check(ex("خرج کردم پانزده هزار تومان نان").amount === 15000, "fifteen thousand");
  check(ex("خرج کردم دو میلیون و پانصد هزار تومان نان").amount === 2500000, "two million and five hundred thousand");
  check(ex("خرج کردم بیست هزار تومان").amount === 20000 && ex("خرج کردم سی هزار تومان").amount === 30000 && ex("خرج کردم پنجاه هزار تومان").amount === 50000 && ex("خرج کردم صد هزار تومان").amount === 100000, "tens/hundred thousands");
  check(cl("خرج کردم فلان هزار تومان نان").intent === "ask", "unknown word before thousand asks, never 1000");
  check(parseNumberPhrase(["دو", "میلیون", "و", "پانصد", "هزار"]).value === 2500000, "phrase parser");
  // Bare digits with a verb: month/counting neighbours are not money.
  check(cl("خرج کردم ۷ آبان نان").intent === "ask", "digit next to a month is not an amount");
  check(cl("۳ تا کتاب خریدم").intent === "ask" && cl("۳ تا کتاب خریدم").question === "expense-or-chat", "counting word digit is not an amount");
  check(cl("خرج کردم ۵۰۰ و ۳۰۰ نان").intent === "ask", "several bare numbers ask");
  check(cl("خرج کردم ۵۰۰ نان").intent === "expense" && ex("خرج کردم ۵۰۰ نان").amount === 500, "single bare digit with verb is an amount");
  check(cl("گوشی خریدم، نظرت چیه؟").intent === "ask" && cl("گوشی خریدم، نظرت چیه؟").question === "expense-or-chat", "weak buy without amount asks expense-or-chat");
  // Strict translate: verb required, checked first, empty text asks.
  check(cl("خرج کردم ۵۰۰ تومان برای ترجمه کتاب").intent === "expense", "bare word translate does not steal an expense");
  check(cl("این ترجمه خوب نیست").intent === "chat", "bare word translate is chat");
  check(cl("ترجمه کن: سلام").intent === "translate", "translate verb works");
  check(cl("لطفا این را ترجمه کن به انگلیسی: سلام").intent === "translate" && cl("لطفا این را ترجمه کن به انگلیسی: سلام").target === "en", "translate with target");
  check(cl("ترجمه کن:").intent === "translate" && cl("ترجمه کن:").ask === "text", "empty translate asks");
  // Expense query: whole month, unknown period asks, strict pattern.
  const mq = cl("خرج این ماه چقدر شد؟"); check(mq.intent === "expense-query" && mq.range.start === "2026-10-01" && mq.range.end === "2026-10-31", `month range is whole month: ${JSON.stringify(mq.range)}`);
  check(cl("هفته‌ی پیش چقدر خرج کردم؟").intent === "expense-query" && cl("هفته‌ی پیش چقدر خرج کردم؟").ask === "period", "last week asks, never today");
  check(cl("چرا اینقدر خرج می‌کنم؟").intent === "chat", "bare question about spending is chat");
  check(cl("امروز چقدر خرج کردم؟").intent === "expense-query", "today query still works");
  // Fix 1: colloquial query word.
  { const q = cl("امروز چقد خرج کردم؟"); check(q.intent === "expense-query" && q.range?.start === "2026-10-28" && q.range?.end === "2026-10-28", `colloquial chaghad query: ${JSON.stringify(q)}`); }
  // Fix 2: last-expense forms, each tested separately.
  check(cl("خرج قبلی چی بود؟").intent === "last-expense", "last-expense: kharj ghabli");
  check(cl("آخرین خرج چی بود؟").intent === "last-expense", "last-expense: akharin kharj");
  check(cl("خرج آخر چی بود؟").intent === "last-expense", "last-expense: kharj akhar");
  check(cl("آخرین خرج چقدر بود؟").intent === "last-expense", "last-expense beats period ask");
  check(cl("خرج کردم ۵۰۰ تومان نان").intent === "expense", "last-expense does not steal a real expense");
  check(cl("۳۲ آبان چقدر خرج کردم؟").intent === "expense-query" && cl("۳۲ آبان چقدر خرج کردم؟").ask === "date", "invalid jalali in query asks, never weekRange(null)");
  // Normalisation first: Arabic letters, space/ZWNJ variants.
  check(normalizeText("يادداشت كتاب") === "یادداشت کتاب", "arabic letters normalised");
  check(cl("يادداشت کن فردا با علی تماس بگیرم").intent === "note", "arabic-letter note works");
  check(cl("یادداشت های امروز").intent === "note-query", "space variant note query");
  check(cl("خلاصه اش کن").intent === "file-reference", "space variant file reference");
  // Colloquial forms and unanchored reminder.
  check(cl("یادت باشه ارزم تومانه").intent === "remember" && cl("یادت باشه ارزم تومانه").setting?.value === "TOMAN", "colloquial remember + currency with trailing ه");
  check(cl("یادت باشد اسمم سمیه").setting?.value === "سمیه" && cl("یادت باشد اسمم مرضیه").setting?.value === "مرضیه" && cl("یادت باشد اسمم آسیه").setting?.value === "آسیه", "names ending in یه are stored as written");
  check(cl("یادت باشد اسمم فاطمه").setting?.value === "فاطمه", "legitimate final ه is kept");
  const late = cl("فردا ساعت ۹ یادم بینداز جلسه دارم"); check(late.intent === "reminder" && late.due === "2026-10-29T09:00:00+03:30", `reminder at end of message: ${JSON.stringify(late)}`);
  // Object-key safety: constructor must not return a function.
  check(cl("یادت باشد ارزم constructor").refused === true, "constructor is not a currency");
  check(cl("خرج کردم constructor هزار تومان نان").intent === "ask", "constructor before thousand asks");
  // First-round non-regressions (spot checks).
  check(cl("یک سوال دارم").intent === "chat" && cl("هزار و یک شب").intent === "chat" && cl("۲+۲ چند می‌شود؟").intent === "chat", "normal chat stays chat");
  check(cl("نه هزار تومان خرج کردم").intent === "ask", "nine is not a number in amounts");
  check(cl("خرج کردم ۱۰٫۵ تومان نان").question === "decimal", "decimal question is decimal");
  check(ex("خرج کردم 1,000 تومان نان").amount === 1000, "comma thousands separator");
  check(ex("خرج کردم ۵۰ € نان").currency === "EUR", "euro symbol is EUR");
  const jex = ex("خرج کردم ۷ آبان ۱۰۰۰ تومان نان"); check(jex.amount === 1000 && jex.date === "2026-10-29", "jalali amount + date");
  check(cl("یادداشت کن خط اول\nخط دوم").text.includes("خط دوم"), "multiline note");
  check(cl("این متن را خلاصه کن: سلام دنیا").intent === "chat", "text summary request is chat");
  check(resolveDefaultCurrency(null) === "TOMAN" && resolveDefaultCurrency("USD") === "USD", "default currency from setting only");
  check(sumByCurrency([{ amount: 1000, currency_code: "TOMAN" }, { amount: 5, currency_code: "USD" }]).TOMAN === 1000, "sums by currency");
  check(!fs.readFileSync(new URL("../src/daily.js", import.meta.url), "utf8").includes("users.currency"), "1b currency path never reads the users currency column");
}
// ── Step 1b-1b, third-round fixes (amount/query/parser, in the 1b-1b diff) ──
{
  const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
  const cl = (s) => classifyDaily(s, { nowMs: NOW });
  const ex = (s) => cl(s).extraction;
  // Query requires the expense/cost word.
  check(cl("فاصله‌ی تهران تا شیراز چقدر است؟").intent === "chat", "distance question is chat, not an expense query");
  check(cl("این کتاب چقدر است؟").intent === "chat", "price question is chat");
  check(cl("امروز هوا چطور است؟").intent === "chat", "weather question is chat");
  check(cl("هزینه‌ی این ماه چقدر شد؟").intent === "expense-query", "cost word also opens a query");
  // Verb word boundaries: first-person verb forms do not match.
  check(cl("نمی‌توانم ترجمه کنم").intent === "chat", "first-person translate form is chat");
  check(cl("ترجمه کنی این متن را").intent !== "translate", "second-person translate form is not translate");
  check(cl("می‌خواهم یادداشت کنم که فردا جلسه دارم").intent === "chat", "first-person note form is not a note");
  check(cl("یادآوری کنی جلسه را").intent !== "reminder", "first-person reminder form is not a reminder");
  // One amount parser for digits and words.
  check(ex("خرج کردم هزار و پانصد تومان نان").amount === 1500, "thousand and five hundred is 1500, not 500");
  check(ex("خرج کردم ۲ میلیون و ۵۰۰ هزار تومان نان").amount === 2500000, "digit million plus digit thousand");
  check(cl("خرج کردم دو میلیون و پانصد تومان نان").intent === "ask" && cl("خرج کردم دو میلیون و پانصد تومان نان").question === "amount", "million plus bare number asks, never 2000500 or 2500000");
  check(parseNumberPhrase(["2", "میلیون", "و", "500", "هزار"]).value === 2500000, "digit tokens in the phrase parser");
  // Bare "got" alone is not income when a product remains.
  check(cl("۵۰۰۰ تومان گرفتم").intent === "income", "got with no product stays income");
  check(cl("حقوق گرفتم ۵۰۰۰ تومان").intent === "income", "salary verb stays income");
  // Bare thousand without a verb is chat; with a verb it is intentionally 1000.
  check(cl("این کتاب هزار تومان است").intent === "chat", "bare thousand without a verb is chat");
  check(cl("برای نان هزار تومان").intent === "chat", "bare thousand phrase without a verb is chat");
  check(cl("خرج کردم هزار تومان نان").intent === "expense" && ex("خرج کردم هزار تومان نان").amount === 1000, "bare thousand with a verb is intentionally 1000");
  // Normalisation is one-to-one: newlines survive, ZWNJ becomes a space only in the normalised form.
  check(normalizeText("خط اول\nخط دوم") === "خط اول\nخط دوم", "normalisation does not flatten newlines");
  check(normalizeText("می‌شود") === "می شود", "ZWNJ becomes a space in the normalised form only");
  // Day-after-tomorrow through the classifier, ZWNJ-safe.
  check(ex("خرج کردم پس‌فردا ۵۰۰ تومان نان").date === "2026-10-30", "day-after-tomorrow via classifier, ZWNJ form");
  check(ex("خرج کردم پس فردا ۵۰۰ تومان نان").date === "2026-10-30", "day-after-tomorrow via classifier, space form");
  check(cl("۱,۵ میلیون تومان").intent === "ask", "fourth round: comma decimal asks");
  check(cl("خرج کردم ۱٫۵ میلیون تومان نان").intent === "ask", "fourth round: decimal with million asks");
  check(cl("۱.۵ میلیون تومان").intent === "ask", "fourth round: dot decimal asks");
  check(cl("خرج کردم دو سه هزار تومان نان").intent === "ask", "fourth round: two numbers without و ask");
  check(cl("۲،۳ تومان").intent === "ask", "fourth round: Arabic comma is not a separator");
  check(ex("خرج کردم 1,000 تومان نان").amount === 1000, "fourth round: comma thousands separator still works");
  check(cl("نمره‌ی ۲۰ گرفتم").intent === "chat", "fourth round: grade is chat");
  check(cl("یادت باشد ارز پیش‌فرضم تومان است").setting?.value === "TOMAN", "fourth round: default currency setting");
  check(cl("۵۰۰۰ تومان نگرفتم").intent === "chat", "fourth round: negated got is chat");
  check(cl("نخریدم").intent === "chat", "fourth round: negated buy is chat");
  for (const q of ["هفته‌ی گذشته چقدر خرج کردم؟", "ماه گذشته چقدر خرج کردم؟", "پریروز چقدر خرج کردم؟", "امسال چقدر خرج کردم؟", "سه روز پیش چقدر خرج کردم؟", "آبان چقدر خرج کردم؟"]) check(cl(q).intent === "expense-query" && cl(q).ask === "period", `unknown period asks: ${q}`);
  check(cl("۵۰۰ تومان خرج کردم، دیگه چقدر مونده؟").intent === "expense", "fourth round: amount plus past verb is an expense");
  check(cl("امروز چقدر خرج کردم؟").intent === "expense-query", "fourth round: amount-less question stays a query");
  check(ex("خرج کردم پس‌فردا ۵۰۰ تومان نان").item === "نان", "fourth round: day-after-tomorrow is not part of the item");
  check(ex("خرج کردم ۵۰۰ تومان کرایه‌ی تاکسی").item === "کرایه‌ی تاکسی", "fourth round: item keeps its ZWNJ");
  check(ex("خرج کردم ۵۰۰ هزار تومن نان").amount === 500000 && ex("خرج کردم ۵۰۰ هزار تومن نان").currency === "TOMAN", "fifth: تومن is a currency, 500 thousand تومن is 500000");
  check(cl("خرج کردم ۵۰۰ هزار نان").intent === "ask" && cl("خرج کردم ۵۰۰ هزار نان").question === "amount", "fifth: multiplier without currency asks, never bare 500");
  check(cl("خرج کردم ۲ میلیارد تومان خانه").intent === "ask" && cl("خرج کردم ۲ میلیارد تومان خانه").question === "amount", "fifth: میلیارد is not a parsed multiplier, asks");
  const lq = cl("7 آبان چقدر خرج کردم؟"); check(lq.intent === "expense-query" && !lq.ask && lq.range.start === "2026-10-29", "fifth: Latin-digit date takes the date path, not period");
  check(cl("تا حالا چقدر خرج کردم؟").intent === "expense-query" && cl("تا حالا چقدر خرج کردم؟").ask === "period", "fifth: query without period asks period");
  check(cl("مجموع خرج‌هایم چقدر است؟").intent === "expense-query" && cl("مجموع خرج‌هایم چقدر است؟").ask === "period", "fifth: total without period asks period");
  check(ex("خرج کردم ۵۰۰ تومان پس انداز").item === "پس انداز", "fifth: پس انداز survives intact");
}

// ── Step 1b-2a: wiring (routing, storage, callbacks, money) ───────────────
import { buildChatContext, mapQuestion, askText, ensureUserRow, handleDailyText, resolveDailyCallback, confirmExpenseDraft, CHAT_CONTEXT_CHAR_LIMIT } from "../src/everyday.js";
{
  check(mapQuestion("ambiguous") === "amount" && mapQuestion("period") === "period", "ambiguous maps to amount in wiring");
  check(askText("period").includes("دوره") && askText("expense-or-income").includes("درآمد"), "ask texts");
  const many = Array.from({ length: 60 }, (_, i) => ({ role: "user", content: `m${i} ` + "x".repeat(200) }));
  const capped = buildChatContext(many);
  const cappedChars = capped.reduce((a, m) => a + m.content.length, 0);
  check(capped.length <= 50 && cappedChars <= CHAT_CONTEXT_CHAR_LIMIT, `context capped: ${capped.length} msgs, ${cappedChars} chars`);
  check(capped[capped.length - 1].content.startsWith("m59"), "char cap keeps newest, drops oldest first");
  const short = Array.from({ length: 60 }, (_, i) => ({ role: "user", content: `m${i}` }));
  const shortCapped = buildChatContext(short);
  check(shortCapped.length === 50 && shortCapped[0].content === "m10", "count cap keeps newest 50");
}
if (DatabaseSync) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  const d1 = { prepare(sql) { const stmt = sqlite.prepare(sql); return { bind(...params) { return { run: async () => { stmt.run(...params); return { success: true }; }, all: async () => ({ results: stmt.all(...params) }), first: async () => stmt.get(...params) ?? null }; } }; } };
  const rows = (sql, params = []) => sqlite.prepare(sql).all(...params);
  const mkEnv = (extra = {}) => ({ STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242,4243", DB: d1, ...extra });
  const fakeSend = () => { const sent = []; return { sent, send: async (text, opts) => { sent.push({ text, replyMarkup: opts?.replyMarkup }); }, api: async () => ({ ok: true }) }; };
  const o = (env, userId, text, extra = {}) => ({ chatId: userId, userId, text, send: extra.send, api: extra.api, chat: extra.chat ?? (async () => {}), nowMs: extra.nowMs });
  const NOW = Date.UTC(2026, 9, 28, 12, 0, 0); // Wed 2026-10-28, 15:30 Iran time
  // User row: created once, never twice; a stranger has no row.
  {
    const env = mkEnv();
    check((await ensureUserRow(env, 4242)).ok === true, "user row created");
    await ensureUserRow(env, 4242);
    check(rows("SELECT COUNT(*) AS n FROM users WHERE id = 4242")[0].n === 1, "user row never twice");
    check(rows("SELECT COUNT(*) AS n FROM users WHERE id = 9999")[0].n === 0, "stranger has no row");
  }
  // Expense confirm flow, direct: draft -> confirm -> row -> second tap fixed.
  {
    const env = mkEnv(), s = fakeSend();
    const r = await handleDailyText(env, o(env, 4242, "خرج کردم ۵۰۰ تومان نان", { ...s, nowMs: NOW }));
    check(r === "handled", "expense handled by everyday");
    const btn = s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
    const confirmData = btn.find((d) => d.startsWith("daily:confirm:"));
    check(Boolean(confirmData), `confirm button: ${JSON.stringify(btn)}`);
    check(confirmData.length <= 64, "callback_data at most 64 bytes");
    check(rows("SELECT COUNT(*) AS n FROM expenses")[0].n === 0, "money never stored before confirm");
    const id = confirmData.split(":")[2];
    const edits = [];
    const cb = { fromId: 4242, chatId: 4242, messageId: 11, data: confirmData, send: s.send, editMarkup: async () => { edits.push(1); }, chat: async () => {} };
    check((await resolveDailyCallback(env, cb)) === true, "confirm callback handled");
    check(rows("SELECT COUNT(*) AS n FROM expenses")[0].n === 1, "one expense row after confirm");
    check(edits.length === 1, "buttons removed after confirm");
    await resolveDailyCallback(env, cb);
    check(rows("SELECT COUNT(*) AS n FROM expenses")[0].n === 1, "second tap creates no second row");
    check(String(s.sent.at(-1)?.text ?? "").includes("قبلاً ثبت شد"), "second tap gets the fixed message");
  }
  // Callback from someone else's draft and from a stranger: silent.
  {
    const env = mkEnv(), s = fakeSend();
    await handleDailyText(env, o(env, 4242, "خرج کردم ۷۰۰ تومان کتاب", { ...s, nowMs: NOW }));
    const btn = s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
    const confirmData = btn.find((d) => d.startsWith("daily:confirm:"));
    const before = s.sent.length;
    const rowsBefore = rows("SELECT COUNT(*) AS n FROM expenses")[0].n;
    const mkCb = (fromId) => ({ fromId, chatId: fromId, messageId: 11, data: confirmData, send: s.send, editMarkup: async () => { throw new Error("must not edit"); }, chat: async () => {} });
    check((await resolveDailyCallback(env, mkCb(4243))) === true, "other's draft callback handled");
    check(s.sent.length === before, "other's draft sends nothing");
    check(rows("SELECT COUNT(*) AS n FROM expenses")[0].n === rowsBefore, "other's draft stores nothing");
    check((await resolveDailyCallback(env, mkCb(9999))) === true, "stranger callback handled");
    check(s.sent.length === before, "stranger callback sends nothing");
  }
  // D1 failure mid-confirm: draft kept, "not saved" reply.
  {
    const env = mkEnv(), s = fakeSend();
    await handleDailyText(env, o(env, 4242, "خرج کردم ۳۰۰ تومان چای", { ...s, nowMs: NOW }));
    const btn = s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
    const id = btn.find((d) => d.startsWith("daily:confirm:"))?.split(":")[2];
    const failingEnv = { ...env, DB: { prepare() { throw new Error("boom"); } } };
    const r = await confirmExpenseDraft(failingEnv, 4242, id);
    check(r.status === "failed", `D1 failure mid-confirm: ${JSON.stringify(r)}`);
    check((await env.STATE.get(`daily:draft:${id}`, "json")) !== null, "draft kept after D1 failure");
    const cb = { fromId: 4242, chatId: 4242, messageId: 11, data: `daily:confirm:${id}`, send: s.send, editMarkup: async () => {}, chat: async () => {} };
    await resolveDailyCallback(failingEnv, cb);
    check(String(s.sent.at(-1)?.text ?? "").includes("ذخیره نشد"), "D1 failure replies not saved");
  }
  // Full Telegram flow: expense priority over dev, user row created.
  {
    const world = mockWorld();
    try {
      const env = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242", DB: d1, GITHUB_DISPATCH_TOKEN: "gh-fake" };
      await sendTg(env, msgUpdate("خرج کردم ۵۰۰ تومان نان"));
      const kb = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1)?.payload?.reply_markup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
      check(kb.some((d) => d.startsWith("daily:confirm:")), "expense beats dev/task routing");
      check(world.calls.github.filter((c) => c.url.includes("/actions/workflows/")).length === 0, "expense sends no dispatch");
      check(rows("SELECT COUNT(*) AS n FROM users WHERE id = 4242")[0].n === 1, "full flow creates the user row");
    } finally { world.restore(); }
  }
}



// ── Step 1b-2b: remaining intents + file branch ────────────────────────────
import { handleDailyFile } from "../src/everyday.js";
if (DatabaseSync) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  const d1 = { prepare(sql) { const stmt = sqlite.prepare(sql); return { bind(...params) { return { run: async () => { stmt.run(...params); return { success: true }; }, all: async () => ({ results: stmt.all(...params) }), first: async () => stmt.get(...params) ?? null }; } }; } };
  const rows = (sql, params = []) => sqlite.prepare(sql).all(...params);
  const mkEnv = (extra = {}) => ({ STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242,4243", DB: d1, ...extra });
  const fakeSend = () => { const sent = []; return { sent, send: async (text, opts) => { sent.push({ text, replyMarkup: opts?.replyMarkup }); }, api: async () => ({ ok: true }) }; };
  const o = (env, userId, text, extra = {}) => ({ chatId: userId, userId, text, send: extra.send, api: extra.api, chat: extra.chat ?? (async () => {}), nowMs: extra.nowMs });
  const NOW = Date.UTC(2026, 9, 28, 12, 0, 0); // Wed 2026-10-28, 15:30 Iran time
  // Midnight boundary: a message at 2026-10-28T22:00Z is 2026-10-29 in Iran.
  {
    const env = mkEnv(), s = fakeSend();
    const late = Date.UTC(2026, 9, 28, 22, 0, 0);
    const r = await handleDailyText(env, o(env, 4242, "خرج کردم ۱۰۰ تومان چای", { ...s, nowMs: late }));
    check(r === "handled", "late-night expense handled");
    const btn = s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
    const confirmData = btn.find((d) => d.startsWith("daily:confirm:"));
    const cb = { fromId: 4242, chatId: 4242, messageId: 11, data: confirmData, send: s.send, editMarkup: async () => {}, chat: async () => {} };
    await resolveDailyCallback(env, cb);
    const row = rows("SELECT date FROM expenses ORDER BY id DESC LIMIT 1")[0];
    check(row?.date === "2026-10-29", `Iran midnight date: ${JSON.stringify(row)}`);
  }
  // Reminder hours: "ساعت نه" and "ساعت پنج" without qualifier ASK; missing time ASKS, never stores.
  {
    const env = mkEnv(), s = fakeSend();
    // "ساعت نه" proves نه = 9 after ساعت: morning NOW -> stored for 09:00 today.
    const morning = Date.UTC(2026, 9, 28, 4, 0, 0); // 07:30 Iran time
    await handleDailyText(env, o(env, 4242, "یادم بنداز ساعت نه تمرین", { ...s, nowMs: morning }));
    check(String(s.sent.at(-1)?.text ?? "").includes("فقط ذخیره شد"), `nine stores: ${JSON.stringify(s.sent.at(-1))}`);
    check(rows("SELECT due_at FROM reminders ORDER BY id DESC LIMIT 1")[0].due_at === "2026-10-28T09:00:00+03:30", "nine means 09:00");
    await handleDailyText(env, o(env, 4242, "یادم بنداز ساعت پنج تماس بگیر", { ...s, nowMs: NOW }));
    check(String(s.sent.at(-1)?.text ?? "").includes("صبح یا عصر"), "ساعت پنج also asks");
    await handleDailyText(env, o(env, 4242, "یادم بنداز که تمرین کنم", { ...s, nowMs: NOW }));
    check(String(s.sent.at(-1)?.text ?? "").includes("ساعت"), `no-time asks: ${JSON.stringify(s.sent.at(-1))}`);
    check(rows("SELECT COUNT(*) AS n FROM reminders")[0].n === 1, "nine stored, ambiguous/no-time stored nothing more");
    await handleDailyText(env, o(env, 4242, "یادم بنداز فردا ساعت نه صبح تمرین", { ...s, nowMs: NOW }));
    check(String(s.sent.at(-1)?.text ?? "").includes("فقط ذخیره شد"), `reminder stored-only reply: ${JSON.stringify(s.sent.at(-1))}`);
    check(rows("SELECT COUNT(*) AS n FROM reminders")[0].n === 2, "tomorrow reminder stored as second row");
    check(rows("SELECT due_at FROM reminders ORDER BY id DESC LIMIT 1")[0].due_at === "2026-10-29T09:00:00+03:30", `due_at: ${JSON.stringify(rows("SELECT due_at FROM reminders ORDER BY id DESC LIMIT 1"))}`);
  }
  // Note, remember, translate, queries (expense sum split by currency).
  {
    const env = mkEnv(), s = fakeSend();
    await handleDailyText(env, o(env, 4242, "یادداشت کن ایده‌ی ربات آشپزی", { ...s, nowMs: NOW }));
    check(String(s.sent.at(-1)?.text ?? "").includes("یادداشت ذخیره شد"), `note reply: ${JSON.stringify(s.sent.at(-1))}`);
    check(rows("SELECT COUNT(*) AS n FROM notes")[0].n === 1, "one note row");
    const noteRow = rows("SELECT text FROM notes")[0];
    check(noteRow?.text === "ایده‌ی ربات آشپزی", `note text: ${JSON.stringify(noteRow)}`);
    await handleDailyText(env, o(env, 4242, "یادداشت‌هایم را بگو", { ...s, nowMs: NOW }));
    check(String(s.sent.at(-1)?.text ?? "").includes("ایده‌ی ربات آشپزی"), "note-query returns the note");
    await handleDailyText(env, o(env, 4242, "یادت باشد ارزم بیت‌کوین است", { ...s, nowMs: NOW }));
    check(String(s.sent.at(-1)?.text ?? "").includes("فقط تنظیم‌ها"), `invalid setting refused: ${JSON.stringify(s.sent.at(-1))}`);
    let modelText = null, saveText = null;
    const chatSpy = async (mt, copts) => { modelText = mt; saveText = copts?.saveText; };
    await handleDailyText(env, o(env, 4242, "ترجمه کن به انگلیسی سلام دنیا", { ...s, chat: chatSpy, nowMs: NOW }));
    check(modelText === "سلام دنیا" && saveText === "ترجمه کن به انگلیسی سلام دنیا", `translate passes text + saveText: ${JSON.stringify({ modelText, saveText })}`);
    await handleDailyText(env, o(env, 4242, "خرج کردم ۵۰۰ تومان نان", { ...s, nowMs: NOW }));
    const btn = s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
    await resolveDailyCallback(env, { fromId: 4242, chatId: 4242, messageId: 11, data: btn.find((d) => d.startsWith("daily:confirm:")), send: s.send, editMarkup: async () => {}, chat: async () => {} });
    await handleDailyText(env, o(env, 4242, "امروز چقدر خرج کردم؟", { ...s, nowMs: NOW }));
    check(String(s.sent.at(-1)?.text ?? "").includes("TOMAN: 500"), `expense-query sum: ${JSON.stringify(s.sent.at(-1))}`);
  }
  // File reference: inside the window names the file; outside asks; plain-text previous -> chat.
  {
    const env = mkEnv(), s = fakeSend();
    await handleDailyFile(env, { userId: 4242, chatId: 4242, tgFileId: "file-1", fileName: "doc.pdf", fileMime: "application/pdf", caption: null, send: s.send });
    check(String(s.sent.at(-1)?.text ?? "").includes("فایل ذخیره شد"), "file saved reply");
    check(rows("SELECT COUNT(*) AS n FROM messages WHERE tg_file_id = 'file-1'")[0].n === 1, "file row kind daily saved");
    await handleDailyText(env, o(env, 4242, "خلاصه‌اش کن", { ...s, nowMs: NOW }));
    check(String(s.sent.at(-1)?.text ?? "").includes("فایل پیدا شد"), `file found reply: ${JSON.stringify(s.sent.at(-1))}`);
    for (let i = 0; i < 12; i++) await saveMessage(env, { userId: 4242, role: "user", content: `پرکننده‌ی ${i}`, kind: "daily" });
    await handleDailyText(env, o(env, 4242, "خلاصه‌اش کن", { ...s, nowMs: NOW }));
    check(String(s.sent.at(-1)?.text ?? "").includes("کدام فایل"), "outside window asks which file");
    const r = await handleDailyText(env, o(env, 4242, "سلام، چطوری؟", { ...s, nowMs: NOW }));
    check(r === "chat", "plain chat is not a file reference");
  }
  // Everyday fix 1: last-expense query, after a recorded expense and with none.
  {
    const env = mkEnv(), s = fakeSend();
    // The section shares one in-memory DB, so "none" is tested with a
    // fresh user id (4243) that has no expense rows yet.
    await handleDailyText(env, o(env, 4243, "خرج قبلی چی بود؟", { ...s, nowMs: NOW }));
    check(String(s.sent.at(-1)?.text ?? "").includes("هنوز خرجی ثبت نشده"), `last-expense with none: ${JSON.stringify(s.sent.at(-1))}`);
    await handleDailyText(env, o(env, 4242, "خرج کردم ۵۰۰ تومان نان", { ...s, nowMs: NOW }));
    const btn = s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
    await resolveDailyCallback(env, { fromId: 4242, chatId: 4242, messageId: 11, data: btn.find((d) => d.startsWith("daily:confirm:")), send: s.send, editMarkup: async () => {}, chat: async () => {} });
    await handleDailyText(env, o(env, 4242, "خرج قبلی چی بود؟", { ...s, nowMs: NOW }));
    const last = String(s.sent.at(-1)?.text ?? "");
    check(last.includes("500") && last.includes("TOMAN") && last.includes("نان"), `last-expense returns the recorded expense: ${JSON.stringify(s.sent.at(-1))}`);
    check(!last.includes("ثبت نشده"), "last-expense does not claim nothing was recorded");
    await handleDailyText(env, o(env, 4242, "آخرین خرج چی بود؟", { ...s, nowMs: NOW }));
    check(String(s.sent.at(-1)?.text ?? "").includes("500"), "last-expense: akharin form works in wiring");
  }
  // Everyday fix 2: history-free translate, even with chat history present.
  {
    const env = mkEnv(), s = fakeSend();
    await saveMessage(env, { userId: 4242, role: "user", content: "یادداشت", kind: "chat" });
    await saveMessage(env, { userId: 4242, role: "assistant", content: "باشه، یادداشت را بفرستید", kind: "chat" });
    let modelText = null, copts = null;
    const chatSpy = async (mt, c) => { modelText = mt; copts = c; };
    await handleDailyText(env, o(env, 4242, "ترجمه کن به انگلیسی: سلام دنیا", { ...s, chat: chatSpy, nowMs: NOW }));
    check(modelText === "سلام دنیا", `translate text: ${JSON.stringify(modelText)}`);
    check(copts?.noHistory === true, `translate carries noHistory: ${JSON.stringify(copts)}`);
    check(copts?.saveText === "ترجمه کن به انگلیسی: سلام دنیا", "translate still saves the full request as chat");
  }
  // Everyday fix 3: photo reference shows "عکس", a named document keeps its name.
  {
    const env = mkEnv(), s = fakeSend();
    await handleDailyFile(env, { userId: 4242, chatId: 4242, tgFileId: "photo-1", fileName: null, fileMime: "image/jpeg", caption: null, send: s.send });
    await handleDailyText(env, o(env, 4242, "خلاصه‌اش کن", { ...s, nowMs: NOW }));
    const photoReply = String(s.sent.at(-1)?.text ?? "");
    check(photoReply.includes("عکس") && !photoReply.includes("photo-1"), `photo reference label: ${JSON.stringify(s.sent.at(-1))}`);
    await handleDailyFile(env, { userId: 4242, chatId: 4242, tgFileId: "file-2", fileName: "doc.pdf", fileMime: "application/pdf", caption: null, send: s.send });
    await handleDailyText(env, o(env, 4242, "خلاصه‌اش کن", { ...s, nowMs: NOW }));
    check(String(s.sent.at(-1)?.text ?? "").includes("doc.pdf"), "named document keeps its name");
  }
  // Full Telegram flow: file message saved, /ping not stored, failed chat turn stores nothing.
  {
    const world = mockWorld();
    try {
      const env = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242", DB: d1 };
      const fileUpdate = { update_id: 2000, message: { message_id: 50, from: { id: 4242 }, chat: { id: 4242 }, date: 1790000000, document: { file_id: "file-9", file_name: "doc.pdf", mime_type: "application/pdf" } } };
      await sendTg(env, fileUpdate);
      const fileMsg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
      check(String(fileMsg?.payload?.text ?? "").includes("فایل ذخیره شد"), "file message gets the saved reply");
      check(rows("SELECT COUNT(*) AS n FROM messages WHERE tg_file_id = 'file-9'")[0].n === 1, "file message row saved");
      await sendTg(env, msgUpdate("/ping"));
      check(rows("SELECT COUNT(*) AS n FROM messages WHERE content = '/ping'")[0].n === 0, "command messages not in history");
      const before = rows("SELECT COUNT(*) AS n FROM messages WHERE kind = 'chat'")[0].n;
      await sendTg(env, msgUpdate("سلام، چطوری؟"));
      check(rows("SELECT COUNT(*) AS n FROM messages WHERE kind = 'chat'")[0].n === before, "failed model turn stores nothing");
    } finally { world.restore(); }
  }
}

if (failures.length) {
  console.error("\nFailures found:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
  process.exit(1);
}
console.log("\n✓ assertهای pipeline 3i برقرار شد.");

// ── Step 1b-1c: note/translate/remember branches, on top of 1b-1b ──
{
  const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
  const cl = (s) => classifyDaily(s, { nowMs: NOW });
  // Note is anchored again (it stores without confirmation) or after a short prefix.
  check(cl("لطفا یادداشت کن خرید نان").intent === "note" && cl("لطفا یادداشت کن خرید نان").text === "خرید نان", "note after short prefix");
  check(cl("ببین یادداشت کن تماس با علی").intent === "note", "note after look prefix");
  check(cl("یادداشت کن خط اول\nمی‌شود خط دوم").text === "خط اول\nمی‌شود خط دوم", "multiline note body is exact, newline and ZWNJ preserved");
  // Translate body is sliced from the original text; destination passes through.
  check(cl("ترجمه کن خط اول\nخط دوم").text === "خط اول\nخط دوم", "multiline translate body is exact");
  const ar = cl("ترجمه کن به عربی: سلام"); check(ar.intent === "translate" && ar.target === "عربی" && ar.text === "سلام", `arabic destination passes through: ${JSON.stringify(ar)}`);
  check(cl("ترجمه کن به انگلیسی: سلام").target === "en", "known destination still maps to a code");
  // Colloquial remember with a time is a reminder, not a refused setting.
  const late = cl("فردا ساعت ۹ یادت باشه جلسه دارم"); check(late.intent === "reminder" && late.due === "2026-10-29T09:00:00+03:30", `colloquial remember with time is a reminder: ${JSON.stringify(late)}`);
  check(cl("یادت باشد ارز پیش‌فرضم دلار است").intent === "remember" && cl("یادت باشد ارز پیش‌فرضم دلار است").setting?.value === "USD", "default-currency setting, ZWNJ form");
  check(cl("یادت باشد ارزم constructor").refused === true, "genuine invalid setting still refused");
  check(cl("۵۰۰۰ تومان بستنی گرفتم").intent === "ask" && cl("۵۰۰۰ تومان بستنی گرفتم").question === "expense-or-income", "got with a product asks expense-or-income (moved from B)");
  // Reminder body is sliced from the original text, ZWNJ preserved.
  const rb = cl("یادم بینداز فردا ساعت ۹ زنگ بزن به می‌شود"); check(rb.intent === "reminder" && rb.text === "زنگ بزن به می‌شود", `reminder body preserves ZWNJ: ${JSON.stringify(rb)}`);
}

// ── Model router Part 1: pure model-intent function + call, NO wiring ───────
// Part 1 changes no bot behaviour: nothing here calls handleDailyText or any
// routing path. The new function is exercised directly, with fetch mocked.
{
  // Parse: valid JSON for every allow-list intent.
  for (const intent of MODEL_INTENT_ALLOW) {
    const r = parseModelIntent(JSON.stringify({ intent, followup: null, target: null }));
    check(r && r.intent === intent && r.followup === null && r.target === null, `model intent parses: ${intent}`);
  }
  check(MODEL_INTENT_ALLOW.length === 12 && !MODEL_INTENT_ALLOW.includes("task"), "allow-list has 12 intents, task excluded");
  check(MODEL_INTENT_COMBO === "chat" && MODEL_INTENT_MAX_TOKENS === 80 && MODEL_INTENT_TIMEOUT_MS === 8000, "classifier constants: combo chat, 80 tokens, 8000ms");
  // followup: yes/no preserved, anything else becomes null (never invalidates).
  check(parseModelIntent('{"intent":"expense","followup":"yes"}').followup === "yes", "followup yes preserved");
  check(parseModelIntent('{"intent":"expense","followup":"no"}').followup === "no", "followup no preserved");
  check(parseModelIntent('{"intent":"expense","followup":"maybe"}').followup === null, "followup other value becomes null");
  // Brace-extraction fallback, same pattern as callFastCombo.
  check(parseModelIntent('Here: {"intent":"note","followup":null,"target":null} done').intent === "note", "brace extraction fallback");
  check(parseModelIntent('{"intent":"note","followup":null,"target":null} extra')?.intent === "note", "trailing text after JSON still parses");
  // Failure: never a guessed intent.
  check(parseModelIntent("hello") === null, "plain text -> null");
  check(parseModelIntent("") === null, "empty -> null");
  check(parseModelIntent(null) === null, "null input -> null");
  check(parseModelIntent("[1,2]") === null, "array JSON -> null");
  check(parseModelIntent('{"intent":"unknown"}') === null, "out-of-allow-list intent -> null");
  check(parseModelIntent('{"intent":"task"}') === null, "task intent -> null");
  check(parseModelIntent('{"intent":123}') === null, "non-string intent -> null");
  check(parseModelIntent('{"intent":"expense"') === null, "truncated JSON -> null");
  // Confidence and amount/date/currency fields are ignored, never read back.
  const rich = parseModelIntent('{"intent":"expense","confidence":0.99,"amount":500,"date":"2026-10-30","currency":"TOMAN","followup":null,"target":null}');
  check(rich && rich.intent === "expense" && !("confidence" in rich) && !("amount" in rich) && !("date" in rich) && !("currency" in rich), "extra model fields ignored, never returned");
  // Translate targets: listed codes pass, missing target is valid-but-null,
  // out-of-list target is reported as invalid, never guessed.
  check(parseModelIntent('{"intent":"translate","target":"fa"}').target === "fa", "translate target fa passes");
  check(parseModelIntent('{"intent":"translate","target":"ar"}').target === "ar", "translate target ar passes");
  check(parseModelIntent('{"intent":"translate"}').target === null, "translate without target is valid with null target");
  const badTarget = parseModelIntent('{"intent":"translate","target":"de"}');
  check(badTarget && badTarget.invalid === "target" && !("intent" in badTarget), "invalid translate target reported, not guessed");
  check(parseModelIntent('{"intent":"note","target":"en"}').target === null, "target on a non-translate intent is ignored");
  // Shared URL: the one resolution point, and both call sites use it.
  check(workerBaseUrl() === "https://my-agent.nova-02aa82bffef8.workers.dev", "shared worker base URL");
  // Call: fetch is mocked, following the mockWorld pattern (save + restore).
  const origFetch = global.fetch;
  let captured = null;
  const mockOk = (content) => {
    global.fetch = async (url, init = {}) => {
      captured = { url: String(url), body: JSON.parse(String(init.body ?? "{}")), headers: init.headers ?? {}, signal: init.signal };
      return Response.json({ choices: [{ message: { content } }] });
    };
  };
  mockOk('{"intent":"reminder","followup":null,"target":null}');
  const ok = await classifyDailyWithModel({ ROUTER_KEY: "k-test" }, "یادم بینداز فردا جلسه");
  check(ok && ok.intent === "reminder", `model call returns parsed intent: ${JSON.stringify(ok)}`);
  check(captured.url === `${workerBaseUrl()}/v1/chat/completions`, "model call goes to the shared worker base");
  check(captured.body.model === "combo/chat", "model call uses combo/chat, never fast or a user pref");
  check(captured.body.max_tokens === 80 && captured.body.temperature === 0, "model call: 80 tokens, temperature 0");
  check(captured.body.messages.length === 2 && captured.body.messages[0].role === "system" && captured.body.messages[1].role === "user" && captured.body.messages[1].content === "یادم بینداز فردا جلسه", "payload is system instruction + current message only");
  check(captured.signal instanceof AbortSignal, "model call carries an abort signal");
  check(!JSON.stringify(captured.body).includes("k-test"), "request body never carries the key");
  // 300-char cap applies to classification only.
  mockOk('{"intent":"chat","followup":null,"target":null}');
  await classifyDailyWithModel({ ROUTER_KEY: "k-test" }, "x".repeat(500));
  check(captured.body.messages[1].content.length === 300, "user text capped at 300 chars for classification");
  // Existing callFastCombo path still works through the same shared base
  // (project-ref-only message -> dev 0.55 -> LLM fallback), model combo/fast.
  mockOk('{"intent":"dev","confidence":0.9,"reason":"llm"}');
  const dev = await classifyIntent("پروژه", { callLLM: true, env: { ROUTER_KEY: "k-test" } });
  check(dev && dev.intent === "dev", `callFastCombo still routes: ${JSON.stringify(dev)}`);
  check(captured.url === `${workerBaseUrl()}/v1/chat/completions` && captured.body.model === "combo/fast", "callFastCombo uses the same shared base, still combo/fast");
  // Failure paths: non-OK, throw (network/abort), missing key (no fetch at all).
  global.fetch = async () => new Response("", { status: 500 });
  check(await classifyDailyWithModel({ ROUTER_KEY: "k-test" }, "x") === null, "non-OK response -> null");
  global.fetch = async () => { throw new Error("boom"); };
  check(await classifyDailyWithModel({ ROUTER_KEY: "k-test" }, "x") === null, "fetch throw -> null");
  let called = false;
  global.fetch = async () => { called = true; return Response.json({}); };
  check(await classifyDailyWithModel({}, "x") === null && called === false, "missing ROUTER_KEY skips the call entirely");
  check(await classifyDailyWithModel(null, "x") === null && called === false, "null env skips the call entirely");
  global.fetch = origFetch;
}

if (failures.length) {
  console.error("\nFailures found:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
  process.exit(1);
}
console.log("\n✓ assertهای pipeline 3i برقرار شد.");

// ── Step 1b-1c additions moved from B: negation gate, verb-gated two amounts ──
{
  const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
  const cl = (s) => classifyDaily(s, { nowMs: NOW });
  check(cl("امروز ۵۰۰ تومان خرج نکردم").intent === "chat", "negation gate: خرج نکردم is chat, not an expense");
  check(cl("دلار ۶۰۰۰۰ تومان و یورو ۷۰۰۰۰ تومان شده").intent === "chat", "price list without a verb reaches chat");
  check(cl("خرج کردم ۵۰۰ تومان نان و ۲۰۰ تومان آب").intent === "ask" && cl("خرج کردم ۵۰۰ تومان نان و ۲۰۰ تومان آب").question === "amount", "two amounts with a verb ask");
}
