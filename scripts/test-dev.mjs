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
import { saveMessage, getLatestFileMessage, getChatMessages } from "../src/db.js";
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
import { buildInterpreterPrompt, parseInterpreterOutput, interpretText, callInterpreterModel, validateAmountText, validateDateTexts, matchProject, validateInterpreterAction, INTERPRETER_MAX_ACTIONS } from "../src/interpreter.js";
import { scoreEvalResults, mapOutcome, scoreSlots, runCaseEvaluation, iranNowIso, median } from "../scripts/eval-intent.mjs";

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
  // Declaration expense (live voice failure 2026-10-30): a "new expense"
  // declaration with خرید but no past-tense verb must reach expense,
  // never chat conf 1. Category is never invented.
  { const d = cl("یک هزینه جدید خرید نون 1500 تومن"); check(d.intent === "expense" && d.confidence === 1 && d.extraction?.amount === 1500 && d.extraction?.currency === "TOMAN" && d.extraction?.item === "نون" && d.extraction?.category === null, `declaration expense: exact voice wording: ${JSON.stringify(d)}`); }
  { const d = cl("خرج جدید خرید شیر 2000 تومان"); check(d.intent === "expense" && d.extraction?.amount === 2000 && d.extraction?.item === "شیر", `declaration expense: kharj variant: ${JSON.stringify(d)}`); }
  { const d = cl("هزینه‌ی جدید خرید نون ۱۵۰۰ تومان"); check(d.intent === "expense" && d.extraction?.amount === 1500 && d.extraction?.item === "نون", `declaration expense: ZWNJ + Persian digits: ${JSON.stringify(d)}`); }
  check(cl("هزینه جدید خرید 1500 تومن").intent === "ask" && cl("هزینه جدید خرید 1500 تومن").question === "expense-or-chat", "declaration without an item asks, never stores");
  check(cl("هزینه جدید خرید نون 1500 تومن و شیر 2000 تومان").intent === "ask" && cl("هزینه جدید خرید نون 1500 تومن و شیر 2000 تومان").question === "amount", "declaration with two amounts asks");
  check(cl("هزینه جدید چیست؟").intent !== "expense", "declaration question is not an expense");
  check(cl("امروز چقدر خرج کردم؟").intent === "expense-query", "declaration fix does not steal the today query");
  check(cl("خرج قبلی چی بود؟").intent === "last-expense", "declaration fix does not steal last-expense");
  check(cl("هزینه جدید خرید نون 1500 تومن نکردم").intent !== "expense", "negated declaration is not an expense");
  check(cl("۳۲ آبان چقدر خرج کردم؟").intent === "expense-query" && cl("۳۲ آبان چقدر خرج کردم؟").ask === "date", "invalid jalali in query asks, never weekRange(null)");
  // Normalisation first: Arabic letters, space/ZWNJ variants.
  check(normalizeText("يادداشت كتاب") === "یادداشت کتاب", "arabic letters normalised");
  check(cl("يادداشت کن فردا با علی تماس بگیرم").intent === "note", "arabic-letter note works");
  check(cl("یادداشت های امروز").intent === "note-query", "space variant note query");
  // Joined colloquial spellings (from speech transcription) reach
  // note-query; note creation and the bare-note ask are not stolen.
  check(cl("یادداشتهامو نشون بده").intent === "note-query", "joined note query: یادداشتهامو");
  check(cl("یادداشتهایم را نشان بده").intent === "note-query", "joined note query: یادداشتهایم");
  check(cl("یادداشتهام را نشان بده").intent === "note-query", "joined note query: یادداشتهام");
  check(cl("یادداشت کن فردا به علی زنگ بزنم").intent === "note", "joined query fix does not steal note creation");
  check(cl("یادداشت").intent === "ask" && cl("یادداشت").question === "note-text", "joined query fix does not steal bare note ask");
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
import { buildChatContext, mapQuestion, askText, ensureUserRow, handleDailyText, resolveDailyCallback, resolveInterpCallback, confirmExpenseDraft, runModelBranch, CHAT_CONTEXT_CHAR_LIMIT } from "../src/everyday.js";
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
    // Save-first fix: the translate request is saved as the entry row (kind
    // chat), so the chat call no longer carries it via saveText.
    check(modelText === "سلام دنیا" && saveText === "", `translate passes text + empty saveText: ${JSON.stringify({ modelText, saveText })}`);
    check(rows("SELECT COUNT(*) AS n FROM messages WHERE content = 'ترجمه کن به انگلیسی سلام دنیا' AND kind = 'chat'")[0].n === 1, "translate entry row saved as chat");
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
    check(copts?.saveText === "", "translate chat call carries empty saveText under save-first");
    check(rows("SELECT COUNT(*) AS n FROM messages WHERE content = 'ترجمه کن به انگلیسی: سلام دنیا' AND kind = 'chat'")[0].n === 1, "translate still saves the full request as chat (entry row)");
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
      // Save-first fix: a failed turn keeps only its entry row (kind chat);
      // no assistant row is stored for a turn that never answered.
      const beforeAssistant = rows("SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant'")[0].n;
      const beforeUser = rows("SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND content = 'سلام، چطوری؟'")[0].n;
      await sendTg(env, msgUpdate("سلام، چطوری؟"));
      check(rows("SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant'")[0].n === beforeAssistant, "failed model turn stores no assistant row");
      check(rows("SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND content = 'سلام، چطوری؟' AND kind = 'chat'")[0].n === beforeUser + 1, "failed model turn keeps only its save-first entry row");
    } finally { world.restore(); }
  }
}

import { transcribeWithGemini, handleVoice, handleVoiceRetry, VOICE_FAILED_TEXT, VOICE_TOO_LONG_TEXT } from "../src/voice.js";

// ── Voice input v1: Telegram voice -> Gemini 3.5-transcribe -> plain-text path ──
if (DatabaseSync) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  const d1 = { prepare(sql) { const stmt = sqlite.prepare(sql); return { bind(...params) { return { run: async () => { stmt.run(...params); return { success: true }; }, all: async () => ({ results: stmt.all(...params) }), first: async () => stmt.get(...params) ?? null }; } }; } };
  const rows = (sql, params = []) => sqlite.prepare(sql).all(...params);
  const mkEnv = (extra = {}) => ({ STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242", DB: d1, ROUTER_KEY: "k-test", GEMINI_API_KEY: "k-test", ...extra });
  const fakeSend = () => { const sent = []; return { sent, send: async (text, opts) => { sent.push({ text, replyMarkup: opts?.replyMarkup }); } }; };
  const o = (env, userId, text, extra = {}) => ({ chatId: userId, userId, text, source: extra.source, send: extra.send, chat: extra.chat ?? (async () => {}), nowMs: extra.nowMs, hasImage: false });
  const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
  const origFetch = global.fetch;
  const lastText = (s) => String(s.sent.at(-1)?.text ?? "");
  // Mock Telegram getFile/download + Google Files/Interactions, routed by URL.
  const mockVoiceFetch = (transcript, opts = {}) => {
    let googleCalls = 0; let interactionsBody = null; let deleted = false;
    global.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("generativelanguage.googleapis.com")) {
        googleCalls++;
        if (init?.method === "DELETE") { deleted = true; return { ok: true, json: async () => ({}) }; }
        if (u.includes("/upload/v1beta/files")) return { ok: true, json: async () => ({ file: { name: "files/abc" } }) };
        if (u.includes("/v1beta/files/abc")) return { ok: true, json: async () => ({ state: opts.pollState ?? "ACTIVE", uri: "https://example/audio" }) };
        if (u.includes("/v1beta/interactions")) {
          if (opts.failInteractions) throw new Error("boom");
          interactionsBody = JSON.parse(init.body);
          return { ok: true, json: async () => ({ output_text: transcript }) };
        }
        return { ok: true, json: async () => ({}) };
      }
      if (u.includes("/file/bot")) return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
      if (u.includes("api.telegram.org")) return { ok: true, json: async () => (opts.failGetFile ? { ok: false } : { ok: true, result: { file_path: "voice/file.ogg" } }) };
      throw new Error(`unexpected fetch: ${u}`);
    };
    return { googleCalls: () => googleCalls, interactionsBody: () => interactionsBody, deleted: () => deleted };
  };
  const voice = (duration = 42) => ({ file_id: "voice-1", duration, mime_type: "audio/ogg" });
  {
    const m = mockVoiceFetch("سلام دنیا");
    const r = await transcribeWithGemini(mkEnv(), new ArrayBuffer(8), "audio/ogg");
    const body = m.interactionsBody();
    check(r.ok === true && r.text === "سلام دنیا" && body?.model === "gemini-3.5-transcribe" && body?.generation_config?.transcription_config?.language_codes?.[0] === "fa-IR" && JSON.stringify(body?.generation_config?.transcription_config?.custom_vocabulary ?? []).includes("Cloudflare Workers") && m.deleted() === true, "voice: gemini transcribe returns text, fa-IR + vocab, uploaded file deleted");
  }
  {
    const env = mkEnv(), s = fakeSend(); const m = mockVoiceFetch("یادداشت کن فردا جلسه دارم");
    const r = await handleVoice(env, { userId: 4242, chatId: 4242, voice: voice(), send: s.send, route: async (t) => { await handleDailyText(env, o(env, 4242, t, { ...s, nowMs: NOW, source: "voice" })); } });
    check(r === "routed" && rows("SELECT COUNT(*) AS n FROM notes WHERE user_id = 4242")[0].n === 1 && rows("SELECT text, source FROM notes WHERE user_id = 4242")[0].text === "فردا جلسه دارم" && rows("SELECT source FROM notes WHERE user_id = 4242")[0].source === "voice", "voice: transcript -> note stored with voice source");
  }
  {
    const env = mkEnv(), s = fakeSend(); mockVoiceFetch("خرج کردم ۵۰۰ تومان نان");
    const r = await handleVoice(env, { userId: 4242, chatId: 4242, voice: voice(), send: s.send, route: async (t) => { await handleDailyText(env, o(env, 4242, t, { ...s, nowMs: NOW, source: "voice" })); } });
    check(r === "routed" && lastText(s).includes("تأیید می‌کنی؟") && rows("SELECT COUNT(*) AS n FROM expenses")[0].n === 0, "voice: transcript -> expense confirm, no row before Confirm");
  }
  {
    const env = mkEnv(), s = fakeSend(); let routed = false; mockVoiceFetch("");
    const r = await handleVoice(env, { userId: 4243, chatId: 4243, voice: voice(), send: s.send, route: async () => { routed = true; } });
    check(r === "failed" && routed === false && lastText(s) === VOICE_FAILED_TEXT && rows("SELECT COUNT(*) AS n FROM notes WHERE user_id = 4243")[0].n === 0, "voice: empty transcript -> resend reply, nothing stored");
  }
  {
    const env = mkEnv(), s = fakeSend(); let routed = false; mockVoiceFetch("سلام", { failInteractions: true });
    const r = await handleVoice(env, { userId: 4242, chatId: 4242, voice: voice(), send: s.send, route: async () => { routed = true; } });
    check(r === "failed" && routed === false && lastText(s) === VOICE_FAILED_TEXT, "voice: google failure -> fallback reply, nothing routed");
  }
  {
    const env = mkEnv({ GEMINI_API_KEY: undefined }), s = fakeSend(); let routed = false; const m = mockVoiceFetch("سلام");
    const r = await handleVoice(env, { userId: 4242, chatId: 4242, voice: voice(), send: s.send, route: async () => { routed = true; } });
    check(r === "failed" && routed === false && m.googleCalls() === 0 && lastText(s) === VOICE_FAILED_TEXT, "voice: missing key -> fallback reply, zero google fetches");
  }
  {
    const env = mkEnv(), s = fakeSend(); let routed = false; const m = mockVoiceFetch("سلام");
    const r = await handleVoice(env, { userId: 4242, chatId: 4242, voice: voice(601), send: s.send, route: async () => { routed = true; } });
    check(r === "too-long" && routed === false && m.googleCalls() === 0 && lastText(s) === VOICE_TOO_LONG_TEXT, "voice: over-cap duration -> short-voice reply, zero google fetches");
  }
  {
    const m = mockVoiceFetch("سلام", { pollState: "PROCESSING" });
    const r = await transcribeWithGemini(mkEnv(), new ArrayBuffer(8), "audio/ogg", { pollIntervalMs: 0, maxPolls: 2 });
    check(r.ok === false && r.reason === "not-active" && m.deleted() === true, "voice: file never ACTIVE -> failure, uploaded file still deleted");
  }
  // 0-b3 voice Retry: file id stashed at receipt (1h TTL, owner-scoped).
  {
    const env = mkEnv(), s = fakeSend(); mockVoiceFetch("سلام", { failInteractions: true });
    const r = await handleVoice(env, { userId: 4242, chatId: 4242, voice: voice(), send: s.send, route: async () => {} });
    const retryBtn = (s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []).find((d) => d.startsWith("voice:retry:"));
    check(r === "failed" && !!retryBtn, "0-b3 voice: failure message carries a Retry button");
    const stashId = retryBtn.slice("voice:retry:".length);
    const sF = fakeSend();
    const rF = await handleVoiceRetry(env, { userId: 4243, stashId, send: sF.send, route: async () => {}, editMarkup: async () => {} });
    check(rF === "forbidden" && sF.sent.length === 0, "0-b3 voice: Retry by another user is silent");
    mockVoiceFetch("یادداشت کن جلسه تازه");
    const r2 = await handleVoiceRetry(env, { userId: 4242, stashId, send: s.send, route: async (t) => { await handleDailyText(env, o(env, 4242, t, { ...s, nowMs: NOW, source: "voice" })); }, editMarkup: async () => {} });
    check(r2 === "routed" && rows("SELECT COUNT(*) AS n FROM notes WHERE text = 'جلسه تازه' AND source = 'voice'")[0].n === 1, "0-b3 voice: Retry re-transcribes and enters the normal path");
    const s2 = fakeSend();
    const r3 = await handleVoiceRetry(env, { userId: 4242, stashId, send: s2.send, route: async () => {}, editMarkup: async () => {} });
    check(r3 === "missing" && s2.sent.length === 1 && s2.sent[0].text === VOICE_FAILED_TEXT, "0-b3 voice: consumed stash yields the clear resend message");
  }
  // 0-b3 fix: a retry that fails again still offers a usable Retry button.
  {
    const env = mkEnv(), s = fakeSend(); mockVoiceFetch("سلام", { failInteractions: true });
    await handleVoice(env, { userId: 4242, chatId: 4242, voice: voice(), send: s.send, route: async () => {} });
    const retryBtn = (s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []).find((d) => d.startsWith("voice:retry:"));
    const stashId = retryBtn.slice("voice:retry:".length);
    const s2 = fakeSend();
    const r2 = await handleVoiceRetry(env, { userId: 4242, stashId, send: s2.send, route: async () => {}, editMarkup: async () => {} });
    const retryBtn2 = (s2.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []).find((d) => d.startsWith("voice:retry:"));
    check(r2 === "failed" && retryBtn2 === `voice:retry:${stashId}` && (await env.STATE.get(`voice:stash:${stashId}`, "json")) !== null, "0-b3 fix: transcription-failing retry yields a usable Retry button, stash kept");
    mockVoiceFetch("یادداشت کن جلسه دوباره");
    const r3 = await handleVoiceRetry(env, { userId: 4242, stashId, send: s.send, route: async (t) => { await handleDailyText(env, o(env, 4242, t, { ...s, nowMs: NOW, source: "voice" })); }, editMarkup: async () => {} });
    check(r3 === "routed" && rows("SELECT COUNT(*) AS n FROM notes WHERE text = 'جلسه دوباره' AND source = 'voice'")[0].n === 1, "0-b3 fix: retry succeeds after a failed retry");
  }
  {
    // Same for a download-failing retry.
    const env = mkEnv(), s = fakeSend(); mockVoiceFetch("سلام", { failGetFile: true });
    await handleVoice(env, { userId: 4242, chatId: 4242, voice: voice(), send: s.send, route: async () => {} });
    const retryBtn = (s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []).find((d) => d.startsWith("voice:retry:"));
    const stashId = retryBtn.slice("voice:retry:".length);
    const s2 = fakeSend();
    const r2 = await handleVoiceRetry(env, { userId: 4242, stashId, send: s2.send, route: async () => {}, editMarkup: async () => {} });
    const retryBtn2 = (s2.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []).find((d) => d.startsWith("voice:retry:"));
    check(r2 === "failed" && retryBtn2 === `voice:retry:${stashId}` && (await env.STATE.get(`voice:stash:${stashId}`, "json")) !== null, "0-b3 fix: download-failing retry yields a usable Retry button, stash kept");
  }
  global.fetch = origFetch;
}

// ── Phase 0-c: synthetic eval set + scorer (offline only, no network) ──
{
  const cases = JSON.parse(fs.readFileSync(new URL("../eval/intent-synthetic.json", import.meta.url), "utf8"));
  const ALLOW = ["task", "note", "expense", "income", "query", "translate", "setting", "correction", "dev_hint", "chat", "ask", "multi"];
  const NEEDS = ["none", "type", "project", "time", "amount"];
  check(Array.isArray(cases) && cases.length >= 60 && cases.length <= 80, `0-c: eval set has ${cases.length} cases (60-80)`);
  check(new Set(cases.map((c) => c.id)).size === cases.length, "0-c: eval case ids are unique");
  for (const c of cases) {
    check(ALLOW.includes(c.expected), `0-c: ${c.id} expected is allow-listed`);
    if (c.expected === "multi") check(Array.isArray(c.types) && c.types.length > 1 && c.types.every((t) => ALLOW.includes(t)), `0-c: ${c.id} multi has types`);
    if (c.expected === "ask") check(NEEDS.includes(c.needs), `0-c: ${c.id} ask states its need`);
    if (c.expected === "expense" || c.expected === "income") check(typeof c.slots?.amount_text === "string" && c.slots.amount_text, `0-c: ${c.id} money case has amount_text`);
    if (c.expected === "query") check(["expense", "note", "task"].includes(c.slots?.query?.kind), `0-c: ${c.id} query case has a query kind`);
    if (c.expected === "translate") check("target" in (c.slots ?? {}), `0-c: ${c.id} translate case has a target field`);
  }
  const fake = scoreEvalResults([
    { id: "f1", expected: "note", got: "note", validJson: true },
    { id: "f2", expected: "expense", got: "ask", validJson: true },
    { id: "f3", expected: "note", got: "invalid", validJson: false },
    { id: "f4", expected: "multi", expectedTypes: ["task", "note"], got: "multi", gotTypes: ["note", "task"], validJson: true },
  ]);
  check(fake.total === 4 && fake.correct === 2 && fake.accuracyPct === 50 && fake.validJson === 3 && fake.validJsonPct === 75, "0-c: scorer computes accuracy and valid-JSON % on a fake set");
  const mapped = mapOutcome(parseInterpreterOutput(JSON.stringify([{ type: "note", text: "x", project: null, due_text: null, remind_text: null, amount_text: null, query: null, target: null, confidence: 0.9, needs: "none" }])), [{ type: "note", text: "x", project: null, due_text: null, remind_text: null, amount_text: null, query: null, target: null, confidence: 0.9, needs: "none" }], { projects: [], nowMs: Date.now(), defaultCurrency: "TOMAN" });
  check(mapped.got === "note" && mapped.validJson, "0-c: outcome mapping passes a clean note action");
}

// ── Phase 0-c fix: slots, needs, strict counts, +03:30, error split, retry ──
{
  const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
  const CTX = { projects: [{ name: "گلبهار", aliases: ["گل"] }, { name: "قرارها و ملاقات‌ها", aliases: ["قرارها"] }, { name: "عمومی", aliases: [] }], nowMs: NOW, nowIso: iranNowIso(NOW), defaultCurrency: "TOMAN" };
  const act = (o) => ({ type: o.type, text: "x", project: o.project ?? null, due_text: o.due_text ?? null, remind_text: o.remind_text ?? null, amount_text: o.amount_text ?? null, query: o.query ?? null, target: o.target ?? null, confidence: o.confidence ?? 0.9, needs: o.needs ?? "none" });
  const slotsOf = (slots, a) => scoreSlots(slots, a, validateInterpreterAction(a, CTX), CTX);
  // Wrong amount despite correct expense type: slot fails, type passes.
  check(slotsOf({ amount_text: "پانصد هزار تومان" }, act({ type: "expense", amount_text: "۵۰۰ تومان" })).pass === 0, "0-c fix: wrong amount fails its slot");
  check(slotsOf({ amount_text: "پانصد هزار تومان" }, act({ type: "expense", amount_text: "پانصد هزار تومان" })).pass === 1, "0-c fix: same amount passes its slot");
  // Wrong project despite correct type; alias resolves to the canonical name.
  check(slotsOf({ project: "قرارها و ملاقات‌ها" }, act({ type: "note", project: "گلبهار" })).pass === 0, "0-c fix: wrong project fails its slot");
  check(slotsOf({ project: "گلبهار" }, act({ type: "note", project: "گل" })).pass === 1, "0-c fix: project alias passes its slot");
  // Wrong query kind / period; correct query passes.
  check(slotsOf({ query: { kind: "expense", period: "امروز", project: null } }, act({ type: "query", query: { kind: "note", periodText: "امروز", project: null } })).pass === 2, "0-c fix: wrong query kind fails only its field");
  check(slotsOf({ query: { kind: "expense", period: "امروز", project: null } }, act({ type: "query", query: { kind: "expense", periodText: "این هفته", project: null } })).pass === 2, "0-c fix: wrong query period fails only its field");
  check(slotsOf({ query: { kind: "expense", period: "امروز", project: null } }, act({ type: "query", query: { kind: "expense", periodText: "امروز", project: null } })).pass === 3, "0-c fix: correct query passes all its slots");
  // Wrong translation target.
  check(slotsOf({ target: "en" }, act({ type: "translate", target: "fa" })).pass === 0, "0-c fix: wrong target fails its slot");
  check(slotsOf({ target: "en" }, act({ type: "translate", target: "en" })).pass === 1, "0-c fix: correct target passes its slot");
  // Wrong due/remind resolution.
  check(slotsOf({ remind_text: "فردا ساعت ۹" }, act({ type: "task", remind_text: "فردا ساعت ۱۰" })).pass === 0, "0-c fix: wrong reminder time fails its slot");
  check(slotsOf({ remind_text: "فردا ساعت ۹" }, act({ type: "task", remind_text: "فردا ساعت ۹" })).pass === 1, "0-c fix: same reminder time passes its slot");
  // Null-expected fields require no claim; absent fields are not counted.
  check(slotsOf({ project: null }, act({ type: "note", project: null })).pass === 1, "0-c fix: null project expectation passes with no claim");
  check(slotsOf({ project: null }, act({ type: "note", project: "گلبهار" })).pass === 0, "0-c fix: null project expectation fails on a claim");
  check(slotsOf({}, act({ type: "note", project: "گلبهار" })).total === 0, "0-c fix: absent slot fields are not counted");
  // Correct ask, wrong need: ask accuracy yes, need accuracy and full no.
  const needSet = scoreEvalResults([
    { id: "n1", expected: "ask", expectedNeeds: "amount", got: "ask", gotNeeds: "type", gotActionCount: 1, validJson: true, outcome: "valid" },
    { id: "n2", expected: "ask", expectedNeeds: "amount", got: "ask", gotNeeds: "amount", gotActionCount: 1, validJson: true, outcome: "valid" },
  ]);
  check(needSet.askCorrect === 2 && needSet.needCorrect === 1 && needSet.correct === 1, "0-c fix: correct ask with wrong need is not fully correct");
  // Extra action in a single-action case: type fails.
  const extraSet = scoreEvalResults([
    { id: "e1", expected: "note", got: "note", gotTypes: ["note", "expense"], gotActionCount: 2, validJson: true, outcome: "valid" },
  ]);
  check(extraSet.typeCorrect === 0, "0-c fix: extra action fails a single-action case");
  // Multi set mismatch: extra type and duplicate padding both fail.
  const multiSet = scoreEvalResults([
    { id: "m1", expected: "multi", expectedTypes: ["task", "note"], got: "note", gotTypes: ["note", "task", "expense"], gotActionCount: 3, validJson: true, outcome: "valid" },
    { id: "m2", expected: "multi", expectedTypes: ["task", "note"], got: "note", gotTypes: ["note", "task"], gotActionCount: 3, validJson: true, outcome: "valid" },
    { id: "m3", expected: "multi", expectedTypes: ["task", "note"], got: "note", gotTypes: ["note", "task"], gotActionCount: 2, validJson: true, outcome: "valid" },
  ]);
  check(multiSet.typeCorrect === 1, "0-c fix: multi set mismatch and duplicate padding fail");
  // Standard median for even and odd counts.
  check(median([10, 20, 30, 40]) === 25 && median([5, 1, 3]) === 3 && median([]) === 0, "0-c fix: median is standard for even and odd counts");
  // Timestamp: explicit +03:30 offset, same instant round-trips.
  check(iranNowIso(NOW) === "2026-10-31T15:30:00.000+03:30" && Date.parse(iranNowIso(NOW)) === NOW, "0-c fix: Iran timestamp carries +03:30 for the same instant");
  // Request error is distinct from invalid JSON and excluded from accuracy.
  const errCase = { id: "r1", expected: "note", text: "یادداشت کن جلسه فردا" };
  const badCase = { id: "r2", expected: "note", text: "یادداشت کن جلسه فردا" };
  const okCase = { id: "r3", expected: "note", text: "یادداشت کن جلسه فردا" };
  const noteJson = JSON.stringify([act({ type: "note" })]);
  const rErr = await runCaseEvaluation(errCase, CTX, async () => { throw new Error("boom"); });
  const rBad = await runCaseEvaluation(badCase, CTX, async () => "not json at all");
  const rOk = await runCaseEvaluation(okCase, CTX, async () => noteJson);
  check(rErr.outcome === "request_error" && rBad.outcome === "invalid_json" && rOk.outcome === "valid", "0-c fix: request error is distinct from invalid JSON");
  const errSet = scoreEvalResults([rErr, rBad, rOk]);
  check(errSet.requestErrors === 1 && errSet.invalidJson === 1 && errSet.validJsonPct === 50 && errSet.scoredTotal === 2, "0-c fix: request errors do not distort valid-JSON % or scored totals");
  // Retry succeeds after an invalid first response; first attempt recorded.
  let calls = 0;
  const rRetry = await runCaseEvaluation(okCase, CTX, async () => (++calls === 1 ? "garbage" : noteJson));
  check(rRetry.outcome === "valid" && rRetry.retried && rRetry.recovered && rRetry.firstOutcome === "invalid_json", "0-c fix: retry succeeds after an invalid first response");
  // Retry succeeds after a request error (production interpretText retries any failure once).
  let calls2 = 0;
  const rRetryErr = await runCaseEvaluation(okCase, CTX, async () => { if (++calls2 === 1) throw new Error("boom"); return noteJson; });
  check(rRetryErr.outcome === "valid" && rRetryErr.retried && rRetryErr.requestRecovered, "0-c fix: retry succeeds after a request error");
}

// ── Phase 0-c fix2: query.project resolution, retry boundary, ms precision ──
{
  const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
  const CTX = { projects: [{ name: "گلبهار", aliases: ["گل"] }, { name: "قرارها و ملاقات‌ها", aliases: ["قرارها"] }, { name: "عمومی", aliases: [] }], nowMs: NOW, nowIso: iranNowIso(NOW), defaultCurrency: "TOMAN" };
  const act = (o) => ({ type: o.type, text: "x", project: o.project ?? null, due_text: o.due_text ?? null, remind_text: o.remind_text ?? null, amount_text: o.amount_text ?? null, query: o.query ?? null, target: o.target ?? null, confidence: o.confidence ?? 0.9, needs: o.needs ?? "none" });
  const slotsOf = (slots, a) => scoreSlots(slots, a, validateInterpreterAction(a, CTX), CTX);
  const qField = (r, field) => r.fields.find((f) => f.field === field)?.ok;
  const qSlots = { query: { kind: "expense", period: "امروز", project: "گلبهار" } };
  const qAct = (project) => act({ type: "query", query: { kind: "expense", periodText: "امروز", project } });
  // query.project: correct passes, wrong fails, alias passes — each only its field.
  check(qField(slotsOf(qSlots, qAct("گلبهار")), "query.project") === true, "0-c fix2: query.project correct passes");
  check(qField(slotsOf(qSlots, qAct("آفتاب")), "query.project") === false, "0-c fix2: query.project wrong fails");
  check(qField(slotsOf(qSlots, qAct("گل")), "query.project") === true, "0-c fix2: query.project alias passes");
  // Contamination guard: the action-level project matches, but the query's
  // own project is wrong — must fail (old code scored resolved.project,
  // which for a non-query action is the action-level match).
  const contam = act({ type: "note", project: "گلبهار", query: { kind: "expense", periodText: "امروز", project: "آفتاب" } });
  check(qField(slotsOf(qSlots, contam), "query.project") === false, "0-c fix2: query.project is scored on the query's own project, not the action-level project");
  // due_text correct and wrong; a wrong due_text fails only its field.
  check(slotsOf({ due_text: "فردا", project: "گلبهار" }, act({ type: "task", due_text: "فردا", project: "گلبهار" })).pass === 2, "0-c fix2: due_text correct passes");
  const dueWrong = slotsOf({ due_text: "فردا", project: "گلبهار" }, act({ type: "task", due_text: "پس‌فردا", project: "گلبهار" }));
  check(qField(dueWrong, "due_text") === false && qField(dueWrong, "project") === true, "0-c fix2: due_text wrong fails only its field");
  // Retry boundary: valid JSON with invalid validation is FINAL, no retry.
  let vAttempts = 0;
  const badAmountJson = JSON.stringify([act({ type: "expense", amount_text: "abc" })]);
  const rVal = await runCaseEvaluation({ id: "v1", expected: "expense", text: "خرج کردم" }, CTX, async () => { vAttempts++; return badAmountJson; });
  check(vAttempts === 1 && rVal.outcome === "valid" && rVal.got === "ask" && !rVal.retried && rVal.gotNeeds === "amount", "0-c fix2: valid JSON with invalid validation is final, no retry");
  // Two transport errors in a row: request_error, no valid result.
  let tCalls = 0;
  const rTwoErr = await runCaseEvaluation({ id: "t1", expected: "note", text: "یادداشت کن جلسه" }, CTX, async () => { tCalls++; throw new Error("boom"); });
  check(tCalls === 2 && rTwoErr.outcome === "request_error" && rTwoErr.retried && !rTwoErr.validJson, "0-c fix2: two transport errors -> request_error, no valid result");
  // Transport error, then invalid JSON: invalid_json after exactly one retry.
  let mCalls = 0;
  const rMix = await runCaseEvaluation({ id: "t2", expected: "note", text: "یادداشت کن جلسه" }, CTX, async () => { if (++mCalls === 1) throw new Error("boom"); return "garbage"; });
  check(mCalls === 2 && rMix.outcome === "invalid_json" && rMix.retried && rMix.firstOutcome === "request_error", "0-c fix2: transport error then invalid JSON -> invalid_json after exactly one retry");
  // Timestamp millisecond precision: same instant, exact string + round-trip.
  const MS = Date.UTC(2026, 9, 31, 12, 0, 0, 456);
  check(iranNowIso(MS) === "2026-10-31T15:30:00.456+03:30" && Date.parse(iranNowIso(MS)) === MS, "0-c fix2: Iran timestamp keeps milliseconds for the same instant");
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

// ── Model router Part 2: core wiring, no pending-ask ───────────────────────
// The model picks the branch; rule code re-validates the original text.
// fetch is mocked per case and restored at the end of the block.
{
  check(askText("note-text") === "چه چیزی را یادداشت کنم؟" && askText("language") === "به چه زبانی؟", "new ask keys: note-text, language");
}
if (DatabaseSync) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  const d1 = { prepare(sql) { const stmt = sqlite.prepare(sql); return { bind(...params) { return { run: async () => { stmt.run(...params); return { success: true }; }, all: async () => ({ results: stmt.all(...params) }), first: async () => stmt.get(...params) ?? null }; } }; } };
  const rows = (sql, params = []) => sqlite.prepare(sql).all(...params);
  const mkEnv = (extra = {}) => ({ STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242,4301,4302,4303,4304,4305,4306,4307,4308,4309,4310,4311,4312,4313,4314", DB: d1, ROUTER_KEY: "k-test", ...extra });
  const fakeSend = () => { const sent = []; return { sent, send: async (text, opts) => { sent.push({ text, replyMarkup: opts?.replyMarkup }); }, api: async () => ({ ok: true }) }; };
  const o = (env, userId, text, extra = {}) => ({ chatId: userId, userId, text, send: extra.send, chat: extra.chat ?? (async () => {}), nowMs: extra.nowMs, hasImage: extra.hasImage });
  const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
  const origFetch = global.fetch;
  let fetchCalls = 0;
  const mockModel = (content) => { fetchCalls = 0; global.fetch = async () => { fetchCalls++; return Response.json({ choices: [{ message: { content } }] }); }; };
  const mockModelFail = () => { fetchCalls = 0; global.fetch = async () => { fetchCalls++; throw new Error("boom"); }; };
  const modelJson = (intent, extra = {}) => JSON.stringify({ intent, followup: null, target: null, ...extra });
  const lastText = (s) => String(s.sent.at(-1)?.text ?? "");
  const hasConfirm = (s) => (s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []).some((d) => d.startsWith("daily:confirm:"));
  const hasAskBtn = (s) => (s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []).some((d) => d.startsWith("daily:ask:"));
  // Rule-confident messages never call the model.
  {
    const env = mkEnv(), s = fakeSend(); let chats = [];
    mockModel(modelJson("chat"));
    check((await handleDailyText(env, o(env, 4301, "امروز چقد خرج کردم؟", { ...s, nowMs: NOW }))) === "handled" && fetchCalls === 0, "confident query: no model call");
    check((await handleDailyText(env, o(env, 4301, "خرج قبلی چی بود؟", { ...s, nowMs: NOW }))) === "handled" && fetchCalls === 0, "confident last-expense: no model call");
    const r = await handleDailyText(env, o(env, 4301, "ترجمه کن به انگلیسی: سلام دنیا", { ...s, nowMs: NOW, chat: async (text, copts) => { chats.push({ text, copts }); } }));
    check(r === "handled" && fetchCalls === 0 && chats[0]?.copts?.noHistory === true, "confident translate: no model call, history-free");
  }
  // Ask tier + model expense -> confirm, no row before confirm.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("expense"));
    const r = await handleDailyText(env, o(env, 4302, "۵۰۰ تومان نان", { ...s, nowMs: NOW }));
    check(r === "handled" && fetchCalls === 1 && hasConfirm(s) && lastText(s).includes("500") && rows("SELECT COUNT(*) AS n FROM expenses")[0].n === 0, "ask-tier model expense -> confirm, no row yet");
  }
  // Ask tier + model chat -> expense-or-chat buttons, not silent chat.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("chat"));
    const r = await handleDailyText(env, o(env, 4303, "۵۰۰ تومان نان", { ...s, nowMs: NOW }));
    check(r === "handled" && fetchCalls === 1 && hasAskBtn(s) && lastText(s).includes("این خرج است یا چت؟"), "ask-tier model chat -> buttons, not silent chat");
  }
  // Ask tier + model failure -> the SAME ask again, no record.
  {
    const env = mkEnv(), s = fakeSend(); mockModelFail();
    const r = await handleDailyText(env, o(env, 4304, "۵۰۰ تومان نان", { ...s, nowMs: NOW }));
    check(r === "handled" && fetchCalls === 1 && lastText(s).includes("این خرج است یا چت؟") && rows("SELECT COUNT(*) AS n FROM expenses")[0].n === 0, "ask-tier failure -> same ask, no record");
  }
  // Model amount/date fields are ignored: the confirm shows the rule amount.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("expense", { amount: 999, currency: "USD", date: "2026-01-01" }));
    await handleDailyText(env, o(env, 4305, "۵۰۰ تومان نان", { ...s, nowMs: NOW }));
    check(lastText(s).includes("500") && !lastText(s).includes("999"), "model amount field ignored, rule amount used");
  }
  // Chat tier + model expense without an amount -> amount ask, no record.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("expense"));
    const r = await handleDailyText(env, o(env, 4306, "خرج", { ...s, nowMs: NOW }));
    check(r === "handled" && fetchCalls === 1 && lastText(s).includes("مبلغ چقدر بود؟") && rows("SELECT COUNT(*) AS n FROM expenses")[0].n === 0, "chat-tier model expense, no amount -> amount ask");
  }
  // Chat tier + model note (bare) -> note-text ask, nothing stored.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("note"));
    const r = await handleDailyText(env, o(env, 4307, "یادداشت", { ...s, nowMs: NOW }));
    check(r === "handled" && fetchCalls === 0 && lastText(s).includes("چه چیزی را یادداشت کنم؟") && rows("SELECT COUNT(*) AS n FROM notes")[0].n === 0, "rule bare note -> note-text ask, zero model fetches");
  }
  // Chat tier + model chat: text -> chat-direct, image -> today's chat path.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("chat"));
    check((await handleDailyText(env, o(env, 4308, "سلام، چطوری؟", { ...s, nowMs: NOW }))) === "chat-direct" && fetchCalls === 1, "chat-tier model chat, text -> chat-direct");
    check((await handleDailyText(env, o(env, 4308, "سلام، چطوری؟", { ...s, nowMs: NOW, hasImage: true }))) === "chat" && fetchCalls === 2, "chat-tier model chat, image -> chat (classifyIntent still runs)");
  }
  // Chat tier + model failure -> chat path, no ask spam.
  {
    const env = mkEnv(), s = fakeSend(); mockModelFail();
    check((await handleDailyText(env, o(env, 4309, "سلام، چطوری؟", { ...s, nowMs: NOW }))) === "chat" && fetchCalls === 1, "chat-tier failure -> chat path");
  }
  // Chat tier + model dev -> suggestion only, never a dispatch (no github fetch).
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("dev"));
    const r = await handleDailyText(env, o(env, 4310, "پروژه", { ...s, nowMs: NOW }));
    check(r === "handled" && lastText(s).includes("/dev") && fetchCalls === 1, "model dev -> suggestion only");
  }
  // Chat tier + model translate: history-free, colon body, model target wins.
  {
    const env = mkEnv(), s = fakeSend(); let chats = [];
    mockModel(modelJson("translate", { target: "en" }));
    const r = await handleDailyText(env, o(env, 4311, "اینو انگلیسیش کن: سلام دنیا", { ...s, nowMs: NOW, chat: async (text, copts) => { chats.push({ text, copts }); } }));
    check(r === "handled" && chats[0]?.text === "سلام دنیا" && chats[0]?.copts?.noHistory === true && String(chats[0]?.copts?.systemPrompt ?? "").includes("English"), "model translate: history-free, colon body, en target");
  }
  // Model translate with an invalid target -> language ask, never a guess.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("translate", { target: "de" }));
    await handleDailyText(env, o(env, 4312, "اینو انگلیسیش کن: سلام دنیا", { ...s, nowMs: NOW }));
    check(lastText(s).includes("به چه زبانی؟"), "invalid model target -> language ask");
  }
  // Chat tier + model reminder without a trigger verb -> stored from the rule parse.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("reminder"));
    const r = await handleDailyText(env, o(env, 4313, "فردا جلسه دارم ساعت ۹", { ...s, nowMs: NOW }));
    check(r === "handled" && lastText(s).includes("2026-10-29T09:00:00+03:30") && rows("SELECT COUNT(*) AS n FROM reminders WHERE user_id = 4313")[0].n === 1, "model reminder stored with rule-parsed due");
  }
  // Chat tier + model expense-query without a period -> period ask.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("expense-query"));
    await handleDailyText(env, o(env, 4314, "خرج‌ها رو بگو", { ...s, nowMs: NOW }));
    check(lastText(s).includes("برای کدام دوره؟"), "model expense-query, no period -> period ask");
  }
  // Model file-reference: in-window finds the file, out-of-window asks.
  {
    const env = mkEnv(), s = fakeSend();
    await handleDailyFile(env, { userId: 4315, tgFileId: "file-1", fileName: "doc.pdf", fileMime: "application/pdf", send: s.send });
    mockModel(modelJson("file-reference"));
    await handleDailyText(env, o(env, 4315, "اون فایل رو خلاصه کن", { ...s, nowMs: NOW }));
    check(lastText(s).includes("doc.pdf"), "model file-reference in window finds the file");
    const env2 = mkEnv(), s2 = fakeSend(); mockModel(modelJson("file-reference"));
    await handleDailyText(env2, o(env2, 4316, "اون فایل رو خلاصه کن", { ...s2, nowMs: NOW }));
    check(lastText(s2).includes("کدام فایل؟"), "model file-reference out of window asks");
  }
  // D1 unavailable: model step off, no fetch, chat keeps working.
  {
    const env = mkEnv({ DB: null }), s = fakeSend(); mockModel(modelJson("expense"));
    check((await handleDailyText(env, o(env, 4317, "۵۰۰ تومان نان", { ...s, nowMs: NOW }))) === "chat" && fetchCalls === 0, "D1 unavailable: no model call, chat path");
  }
  // Missing ROUTER_KEY: model step skipped, today's behaviour remains.
  {
    const env = mkEnv({ ROUTER_KEY: undefined }), s = fakeSend(); mockModel(modelJson("expense"));
    check((await handleDailyText(env, o(env, 4318, "۵۰۰ تومان نان", { ...s, nowMs: NOW }))) === "handled" && fetchCalls === 0 && lastText(s).includes("این خرج است یا چت؟"), "missing key, ask tier -> same ask, no fetch");
    check((await handleDailyText(env, o(env, 4318, "سلام، چطوری؟", { ...s, nowMs: NOW }))) === "chat" && fetchCalls === 0, "missing key, chat tier -> chat, no fetch");
  }
  // Timing log: combo, tier, ms, outcome — never the message text.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("chat"));
    const origLog = console.log; const lines = []; console.log = (...a) => { lines.push(a.join(" ")); };
    await handleDailyText(env, o(env, 4319, "سلام، چطوری؟", { ...s, nowMs: NOW }));
    console.log = origLog;
    const entry = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j && j.modelIntent);
    check(Boolean(entry) && entry.modelIntent === "chat" && entry.tier === "chat" && typeof entry.ms === "number" && entry.outcome === "chat" && !lines.some((l) => l.includes("سلام، چطوری؟")), "timing log: combo/tier/ms/outcome, no message text");
  }
  // Full flow: model chat verdict skips classifyIntent (a dev-looking
  // message must NOT get the /dev suggestion; the chat answer is attempted).
  {
    const world = mockWorld();
    const prevFetch = global.fetch;
    global.fetch = async (url, init) => String(url).startsWith(workerBaseUrl()) ? Response.json({ choices: [{ message: { content: modelJson("chat") } }] }) : prevFetch(url, init);
    try {
      const env = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242", DB: d1, ROUTER_KEY: "k-test", GITHUB_DISPATCH_TOKEN: "gh-fake" };
      await sendTg(env, msgUpdate("پروژه"));
      const texts = world.calls.telegram.filter((c) => c.method === "sendMessage").map((c) => String(c.payload?.text ?? ""));
      check(texts.some((x) => x.includes("همه‌ی مدل‌ها شکست خوردند")) && !texts.some((x) => x.includes("با /dev بفرست")), "full flow: model chat skips classifyIntent, no dev suggestion");
    } finally { global.fetch = prevFetch; world.restore(); }
  }
  global.fetch = origFetch;
}

// ── Model router Part 3: pending-ask slot + follow-up ──────────────────────
// Slot: one per user in KV, 600s TTL (platform behaviour; fakeKV does not expire, so TTL expiry is not unit-tested).
// followup is consumed ONLY when a slot exists; without one it is ignored.
if (DatabaseSync) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  const d1 = { prepare(sql) { const stmt = sqlite.prepare(sql); return { bind(...params) { return { run: async () => { stmt.run(...params); return { success: true }; }, all: async () => ({ results: stmt.all(...params) }), first: async () => stmt.get(...params) ?? null }; } }; } };
  const rows = (sql, params = []) => sqlite.prepare(sql).all(...params);
  const mkEnv = (extra = {}) => ({ STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242,4401,4402,4403,4404,4405,4406,4407,4408,4409,4410,4411,4412,4413,4414,4415,4416,4417", DB: d1, ROUTER_KEY: "k-test", ...extra });
  const fakeSend = () => { const sent = []; return { sent, send: async (text, opts) => { sent.push({ text, replyMarkup: opts?.replyMarkup }); }, api: async () => ({ ok: true }) }; };
  const o = (env, userId, text, extra = {}) => ({ chatId: userId, userId, text, send: extra.send, chat: extra.chat ?? (async () => {}), nowMs: extra.nowMs, hasImage: extra.hasImage });
  const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
  const origFetch = global.fetch;
  let fetchCalls = 0;
  const mockModel = (content) => { fetchCalls = 0; global.fetch = async () => { fetchCalls++; return Response.json({ choices: [{ message: { content } }] }); }; };
  const mockModelFail = () => { fetchCalls = 0; global.fetch = async () => { fetchCalls++; throw new Error("boom"); }; };
  const modelJson = (intent, extra = {}) => JSON.stringify({ intent, followup: null, target: null, ...extra });
  const lastText = (s) => String(s.sent.at(-1)?.text ?? "");
  const hasConfirm = (s) => (s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []).some((d) => d.startsWith("daily:confirm:"));
  const hasAskBtn = (s) => (s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []).some((d) => d.startsWith("daily:ask:"));
  const slotOf = async (env, uid) => env.STATE.get(`daily:pending-ask:${uid}`, "json");
  const askIdOf = (s) => (s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []).find((d) => d.startsWith("daily:ask:"))?.split(":")[2] ?? null;
  const amountAsk = async (env, s, uid) => { mockModel(modelJson("expense")); await handleDailyText(env, o(env, uid, "خرج", { ...s, nowMs: NOW })); };
  const chatButtons = async (env, s, uid) => { mockModel(modelJson("chat")); await handleDailyText(env, o(env, uid, "۵۰۰ تومان نان", { ...s, nowMs: NOW })); return askIdOf(s); };
  const incomeButtons = async (env, s, uid) => { mockModelFail(); await handleDailyText(env, o(env, uid, "۵۰۰ تومان نان گرفتم", { ...s, nowMs: NOW })); return askIdOf(s); };
  // Follow-up amount answer -> confirm, slot cleared, timing logged (no text).
  {
    const env = mkEnv(), s = fakeSend();
    await amountAsk(env, s, 4401);
    check(lastText(s).includes("مبلغ چقدر بود؟") && (await slotOf(env, 4401))?.question === "مبلغ چقدر بود؟", "amount ask sets plain slot");
    mockModel(modelJson("expense", { followup: "yes" }));
    const origLog = console.log; const lines = []; console.log = (...a) => { lines.push(a.join(" ")); };
    const r = await handleDailyText(env, o(env, 4401, "۵۰۰ تومان نان", { ...s, nowMs: NOW }));
    console.log = origLog;
    const entry = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j && j.modelIntent);
    check(r === "handled" && fetchCalls === 1 && hasConfirm(s) && lastText(s).includes("500") && rows("SELECT COUNT(*) AS n FROM expenses")[0].n === 0 && (await slotOf(env, 4401)) === null && entry?.outcome === "routed" && !lines.some((l) => l.includes("۵۰۰ تومان نان")), "follow-up amount -> confirm, slot cleared, timing logged without text");
  }
  // Follow-up call carries the bot ask text as one labelled line.
  {
    const env = mkEnv(), s = fakeSend();
    await amountAsk(env, s, 4402);
    let body = null;
    global.fetch = async (url, init) => { body = JSON.parse(init.body); return Response.json({ choices: [{ message: { content: modelJson("expense", { followup: "yes" }) } }] }); };
    await handleDailyText(env, o(env, 4402, "۵۰۰ تومان نان", { ...s, nowMs: NOW }));
    const userMsg = body?.messages?.[1]?.content ?? "";
    check(userMsg.includes("پرسش قبلی بات") && userMsg.includes("مبلغ چقدر بود؟") && userMsg.includes("۵۰۰ تومان نان"), "follow-up call carries bot ask text + user message");
  }
  // Bare "yes" after an amount ask -> same amount ask, slot refreshed.
  {
    const env = mkEnv(), s = fakeSend();
    await amountAsk(env, s, 4403);
    mockModel(modelJson("chat", { followup: "yes" }));
    const r = await handleDailyText(env, o(env, 4403, "اره", { ...s, nowMs: NOW }));
    check(r === "handled" && lastText(s).includes("مبلغ چقدر بود؟") && rows("SELECT COUNT(*) AS n FROM expenses")[0].n === 0 && (await slotOf(env, 4403))?.question === "مبلغ چقدر بود؟", "bare yes after amount ask -> same amount ask, slot refreshed");
  }
  // "No" after a plain ask -> cancelled, nothing stored, no chat.
  {
    const env = mkEnv(), s = fakeSend(); let chats = [];
    await amountAsk(env, s, 4404);
    mockModel(modelJson("chat", { followup: "no" }));
    const r = await handleDailyText(env, o(env, 4404, "نه", { ...s, nowMs: NOW, chat: async (t) => { chats.push(t); } }));
    check(r === "handled" && lastText(s).includes("باشه، ثبت نشد.") && rows("SELECT COUNT(*) AS n FROM expenses")[0].n === 0 && chats.length === 0 && (await slotOf(env, 4404)) === null, "no after plain ask -> cancelled, no chat, no record");
  }
  // Button follow-ups (test 15): expense-or-chat yes -> expense, no -> chat.
  {
    const env = mkEnv(), s = fakeSend(); const id = await chatButtons(env, s, 4405);
    check(id && (await slotOf(env, 4405))?.askId === id, "expense-or-chat buttons set button slot");
    mockModel(modelJson("chat", { followup: "yes" }));
    const r = await handleDailyText(env, o(env, 4405, "اره", { ...s, nowMs: NOW }));
    check(r === "handled" && hasConfirm(s) && lastText(s).includes("500") && rows("SELECT COUNT(*) AS n FROM expenses")[0].n === 0 && (await slotOf(env, 4405)) === null, "button yes, expense-or-chat -> expense confirm");
  }
  {
    const env = mkEnv(), s = fakeSend(); await chatButtons(env, s, 4406); let chats = [];
    mockModel(modelJson("chat", { followup: "no" }));
    const r = await handleDailyText(env, o(env, 4406, "اره", { ...s, nowMs: NOW, chat: async (t) => { chats.push(t); } }));
    check(r === "handled" && chats[0] === "۵۰۰ تومان نان" && !hasConfirm(s) && (await slotOf(env, 4406)) === null, "button no, expense-or-chat -> original to chat, no confirm");
  }
  // Button follow-ups (test 15): expense-or-income yes -> expense, no -> income.
  {
    const env = mkEnv(), s = fakeSend(); const id = await incomeButtons(env, s, 4407);
    check(id && (await slotOf(env, 4407))?.askId === id, "expense-or-income buttons set button slot");
    mockModel(modelJson("chat", { followup: "yes" }));
    await handleDailyText(env, o(env, 4407, "اره", { ...s, nowMs: NOW }));
    check(hasConfirm(s) && lastText(s).includes("500") && (await slotOf(env, 4407)) === null, "button yes, expense-or-income -> expense confirm");
  }
  {
    const env = mkEnv(), s = fakeSend(); await incomeButtons(env, s, 4408);
    mockModel(modelJson("chat", { followup: "no" }));
    await handleDailyText(env, o(env, 4408, "اره", { ...s, nowMs: NOW }));
    check(hasConfirm(s) && lastText(s).includes("درآمد") && lastText(s).includes("500") && (await slotOf(env, 4408)) === null, "button no, expense-or-income -> income confirm");
  }
  // Chat fall-through clears the slot; a later "yes" is fresh, not followup (test 16).
  {
    const env = mkEnv(), s = fakeSend();
    await amountAsk(env, s, 4409);
    mockModel(modelJson("chat"));
    check((await handleDailyText(env, o(env, 4409, "سلام، چطوری؟", { ...s, nowMs: NOW }))) === "chat-direct" && (await slotOf(env, 4409)) === null, "chat fall-through clears slot");
    mockModel(modelJson("chat", { followup: "yes" }));
    const n = s.sent.length;
    const r = await handleDailyText(env, o(env, 4409, "اره", { ...s, nowMs: NOW }));
    check(r === "chat-direct" && s.sent.length === n, "later yes without slot is fresh chat, not followup");
  }
  // Button tap clears the slot and resolves the ask.
  {
    const env = mkEnv(), s = fakeSend(); const id = await chatButtons(env, s, 4410); let chats = [];
    const r = await resolveDailyCallback(env, { fromId: 4410, chatId: 4410, data: `daily:ask:${id}:chat`, send: s.send, editMarkup: async () => {}, chat: async (t) => { chats.push(t); } });
    check(r === true && chats[0] === "۵۰۰ تومان نان" && (await slotOf(env, 4410)) === null, "button tap clears slot, original to chat");
  }
  // followup without a slot is ignored.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("chat", { followup: "yes" }));
    const r = await handleDailyText(env, o(env, 4411, "اره", { ...s, nowMs: NOW }));
    check(r === "chat-direct" && s.sent.length === 0, "followup without slot ignored, fresh chat");
  }
  // Fresh intent from a follow-up replaces the old slot with its own ask.
  {
    const env = mkEnv(), s = fakeSend();
    await amountAsk(env, s, 4412);
    mockModel(modelJson("note"));
    await handleDailyText(env, o(env, 4412, "یادداشت", { ...s, nowMs: NOW }));
    check(lastText(s).includes("چه چیزی را یادداشت کنم؟") && (await slotOf(env, 4412))?.question === "چه چیزی را یادداشت کنم؟" && rows("SELECT COUNT(*) AS n FROM notes")[0].n === 0, "fresh note intent replaces amount slot with note-text ask");
  }
  // Model failure with a slot -> the SAME question re-asked (plain + button).
  {
    const env = mkEnv(), s = fakeSend();
    await amountAsk(env, s, 4413);
    mockModelFail();
    await handleDailyText(env, o(env, 4413, "۵۰۰ تومان", { ...s, nowMs: NOW }));
    check(lastText(s).includes("مبلغ چقدر بود؟") && (await slotOf(env, 4413))?.question === "مبلغ چقدر بود؟", "failure with plain slot -> same amount ask, slot refreshed");
  }
  {
    const env = mkEnv(), s = fakeSend(); const id = await chatButtons(env, s, 4414);
    mockModelFail();
    await handleDailyText(env, o(env, 4414, "اره", { ...s, nowMs: NOW }));
    check(hasAskBtn(s) && lastText(s).includes("این خرج است یا چت؟") && (await slotOf(env, 4414))?.askId === id, "failure with button slot -> same buttons, same ask id");
  }
  // Carried-over from the Part 2 review: model income -> income confirm, no row yet.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("income"));
    const r = await handleDailyText(env, o(env, 4415, "۵۰۰ تومان نان", { ...s, nowMs: NOW }));
    check(r === "handled" && hasConfirm(s) && lastText(s).includes("درآمد") && lastText(s).includes("500") && rows("SELECT COUNT(*) AS n FROM expenses")[0].n === 0, "ask-tier model income -> income confirm, no row yet");
  }
  // Carried-over, branch-level: model note + rule-note reclassification ->
  // note stored. (End-to-end such a text is rule-confident and never reaches the model.)
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("note"));
    const r = await runModelBranch(env, { userId: 4416, text: "یادداشت کن فردا جلسه دارم", send: s.send, chat: async () => {} }, { intent: "ask", question: "amount" }, { now: NOW, remembered: "TOMAN" });
    check(r.ret === "handled" && rows("SELECT COUNT(*) AS n FROM notes WHERE user_id = 4416")[0].n === 1 && rows("SELECT text FROM notes WHERE user_id = 4416")[0].text === "فردا جلسه دارم", "model-branch note + rule-note reclassification -> note stored");
  }
  // Confident message after an ask resolves the ask and clears the slot.
  {
    const env = mkEnv(), s = fakeSend();
    await amountAsk(env, s, 4417);
    await handleDailyText(env, o(env, 4417, "خرج کردم ۵۰۰ تومان نان", { ...s, nowMs: NOW }));
    check(hasConfirm(s) && (await slotOf(env, 4417)) === null, "confident expense after ask clears slot, confirm shown");
  }
  global.fetch = origFetch;
}



// ── Model router Part 3b: slot-aware body consumption (stacks on Part 3) ──
// Fixes the Part 3 loop: a model note/translate verdict re-gated on rule
// reclassification could never store/translate a follow-up body. Slot kind
// (never a Persian-text comparison) decides the slot cases below.
if (DatabaseSync) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  const d1 = { prepare(sql) { const stmt = sqlite.prepare(sql); return { bind(...params) { return { run: async () => { stmt.run(...params); return { success: true }; }, all: async () => ({ results: stmt.all(...params) }), first: async () => stmt.get(...params) ?? null }; } }; } };
  const rows = (sql, params = []) => sqlite.prepare(sql).all(...params);
  const mkEnv = (extra = {}) => ({ STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242,4501,4502,4503,4504,4505,4506,4507,4508,4509,4510", DB: d1, ROUTER_KEY: "k-test", ...extra });
  const fakeSend = () => { const sent = []; return { sent, send: async (text, opts) => { sent.push({ text, replyMarkup: opts?.replyMarkup }); }, api: async () => ({ ok: true }) }; };
  const o = (env, userId, text, extra = {}) => ({ chatId: userId, userId, text, send: extra.send, chat: extra.chat ?? (async () => {}), nowMs: extra.nowMs, hasImage: extra.hasImage });
  const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
  const origFetch = global.fetch;
  let fetchCalls = 0;
  const mockModel = (content) => { fetchCalls = 0; global.fetch = async () => { fetchCalls++; return Response.json({ choices: [{ message: { content } }] }); }; };
  const mockModelFail = () => { fetchCalls = 0; global.fetch = async () => { fetchCalls++; throw new Error("boom"); }; };
  const modelJson = (intent, extra = {}) => JSON.stringify({ intent, followup: null, target: null, ...extra });
  const lastText = (s) => String(s.sent.at(-1)?.text ?? "");
  const slotOf = async (env, uid) => env.STATE.get(`daily:pending-ask:${uid}`, "json");
  const noteAsk = async (env, s, uid) => { mockModel(modelJson("note")); await handleDailyText(env, o(env, uid, "یادداشت", { ...s, nowMs: NOW })); };
  // (a) Bare note, end to end: bare note -> note-text ask -> body -> note stored, slot cleared.
  {
    const env = mkEnv(), s = fakeSend();
    await noteAsk(env, s, 4501);
    check(lastText(s).includes("چه چیزی را یادداشت کنم؟") && (await slotOf(env, 4501))?.kind === "note-text", "3b: bare note sets note-text slot with kind");
    mockModel(modelJson("note"));
    const r = await handleDailyText(env, o(env, 4501, "فردا به علی زنگ بزنم", { ...s, nowMs: NOW }));
    check(r === "handled" && lastText(s).includes("یادداشت ذخیره شد") && rows("SELECT COUNT(*) AS n FROM notes WHERE user_id = 4501")[0].n === 1 && rows("SELECT text FROM notes WHERE user_id = 4501")[0].text === "فردا به علی زنگ بزنم" && (await slotOf(env, 4501)) === null, "3b: note body follow-up stored end to end, slot cleared");
  }
  // (b) Translate, end to end: translate with no body -> text ask -> body + target -> translated.
  {
    const env = mkEnv(), s = fakeSend(); let chats = [];
    mockModel(modelJson("translate", { target: "en" }));
    await handleDailyText(env, o(env, 4502, "ترجمه کن", { ...s, nowMs: NOW }));
    check(lastText(s).includes("چه متنی را ترجمه کنم؟") && (await slotOf(env, 4502))?.kind === "translate-text", "3b: translate with no body sets translate-text slot with kind");
    mockModel(modelJson("translate", { target: "en" }));
    const r = await handleDailyText(env, o(env, 4502, "سلام دنیا", { ...s, nowMs: NOW, chat: async (text, copts) => { chats.push({ text, copts }); } }));
    check(r === "handled" && chats[0]?.text === "سلام دنیا" && String(chats[0]?.copts?.systemPrompt ?? "").includes("English") && chats[0]?.copts?.noHistory === true && (await slotOf(env, 4502)) === null, "3b: translate body follow-up executed end to end with target");
  }
  // (c) Translate + language, end to end: body without target -> language ask (body kept) -> language answer -> original body translated.
  {
    const env = mkEnv(), s = fakeSend(); let chats = [];
    mockModel(modelJson("translate", { target: "en" }));
    await handleDailyText(env, o(env, 4503, "ترجمه کن", { ...s, nowMs: NOW }));
    mockModel(modelJson("translate"));
    await handleDailyText(env, o(env, 4503, "سلام دنیا", { ...s, nowMs: NOW }));
    const slot = await slotOf(env, 4503);
    check(lastText(s).includes("به چه زبانی؟") && slot?.kind === "language" && slot?.pendingBody === "سلام دنیا", "3b: body without target -> language ask keeps body in slot");
    mockModel(modelJson("translate", { target: "en" }));
    const r = await handleDailyText(env, o(env, 4503, "انگلیسی", { ...s, nowMs: NOW, chat: async (text, copts) => { chats.push({ text, copts }); } }));
    check(r === "handled" && chats[0]?.text === "سلام دنیا" && String(chats[0]?.copts?.systemPrompt ?? "").includes("English") && (await slotOf(env, 4503)) === null, "3b: language answer translates the ORIGINAL body end to end");
  }
  // (c2) Invalid model target with a translate-text slot -> language ask keeps the body.
  {
    const env = mkEnv(), s = fakeSend();
    mockModel(modelJson("translate", { target: "en" }));
    await handleDailyText(env, o(env, 4504, "ترجمه کن", { ...s, nowMs: NOW }));
    mockModel(modelJson("translate", { target: "de" }));
    await handleDailyText(env, o(env, 4504, "سلام دنیا", { ...s, nowMs: NOW }));
    const slot = await slotOf(env, 4504);
    check(lastText(s).includes("به چه زبانی؟") && slot?.kind === "language" && slot?.pendingBody === "سلام دنیا", "3b: invalid target with translate-text slot -> language ask keeps body");
  }
  // (d1) Model failure with a note-text slot -> fallback stores the body, slot cleared.
  {
    const env = mkEnv(), s = fakeSend();
    await noteAsk(env, s, 4505);
    mockModelFail();
    const r = await handleDailyText(env, o(env, 4505, "فردا به علی زنگ بزنم", { ...s, nowMs: NOW }));
    const slot = await slotOf(env, 4505);
    check(r === "handled" && fetchCalls === 1 && lastText(s).includes("یادداشت ذخیره شد") && rows("SELECT COUNT(*) AS n FROM notes WHERE user_id = 4505")[0].n === 1 && rows("SELECT text FROM notes WHERE user_id = 4505")[0].text === "فردا به علی زنگ بزنم" && slot === null, "3b: failure with note-text slot -> fallback stores body, slot cleared");
  }
  // (d2) Missing key with a note-text slot -> fallback stores the body (NOT dropped), nothing re-asked.
  {
    const env = mkEnv(), s = fakeSend(); let chats = [];
    await noteAsk(env, s, 4506);
    const env2 = { ...env, ROUTER_KEY: undefined };
    mockModel(modelJson("note"));
    const r = await handleDailyText(env2, o(env2, 4506, "فردا به علی زنگ بزنم", { ...s, nowMs: NOW, chat: async (t) => { chats.push(t); } }));
    const slot = await slotOf(env, 4506);
    check(r === "handled" && fetchCalls === 0 && lastText(s).includes("یادداشت ذخیره شد") && chats.length === 0 && rows("SELECT COUNT(*) AS n FROM notes WHERE user_id = 4506")[0].n === 1 && rows("SELECT text FROM notes WHERE user_id = 4506")[0].text === "فردا به علی زنگ بزنم" && slot === null, "3b: missing key with note-text slot -> fallback stores body, not dropped");
  }
  // (d3) Model failure with a language slot -> fallback translates the kept body, slot cleared.
  {
    const env = mkEnv(), s = fakeSend();
    mockModel(modelJson("translate", { target: "en" }));
    await handleDailyText(env, o(env, 4507, "ترجمه کن", { ...s, nowMs: NOW }));
    mockModel(modelJson("translate"));
    await handleDailyText(env, o(env, 4507, "سلام دنیا", { ...s, nowMs: NOW }));
    mockModelFail();
    let chats = [];
    const r = await handleDailyText(env, o(env, 4507, "انگلیسی", { ...s, nowMs: NOW, chat: async (text, copts) => { chats.push({ text, copts }); } }));
    const slot = await slotOf(env, 4507);
    check(r === "handled" && fetchCalls === 1 && chats[0]?.text === "سلام دنیا" && String(chats[0]?.copts?.systemPrompt ?? "").includes("English") && chats[0]?.copts?.noHistory === true && slot === null, "3b: failure with language slot -> fallback translates kept body, slot cleared");
  }
  // (e) >300-char note body is stored in full; the classification payload stays capped.
  {
    const env = mkEnv(), s = fakeSend(); let payload = null;
    await noteAsk(env, s, 4508);
    const body = "فردا به علی زنگ بزنم. ".repeat(20);
    check(body.length > 300, "3b fixture: body is over 300 chars");
    global.fetch = async (url, init) => { payload = JSON.parse(init.body); return Response.json({ choices: [{ message: { content: modelJson("note") } }] }); };
    await handleDailyText(env, o(env, 4508, body, { ...s, nowMs: NOW }));
    const stored = rows("SELECT text FROM notes WHERE user_id = 4508")[0]?.text;
    const sentMsg = payload?.messages?.[1]?.content ?? "";
    const sentUserText = sentMsg.includes("پیام کاربر: ") ? sentMsg.split("پیام کاربر: ")[1] : sentMsg;
    check(stored === body && sentUserText.length <= 300, "3b: >300-char body stored in full, classification user text capped at 300");
  }
  // (f) Empty note body -> re-ask, nothing stored.
  {
    const env = mkEnv(), s = fakeSend();
    await noteAsk(env, s, 4509);
    mockModel(modelJson("note"));
    await handleDailyText(env, o(env, 4509, "   ", { ...s, nowMs: NOW }));
    check(lastText(s).includes("چه چیزی را یادداشت کنم؟") && rows("SELECT COUNT(*) AS n FROM notes WHERE user_id = 4509")[0].n === 0, "3b: empty note body -> re-ask, nothing stored");
  }
  // (g) Kind fallback: a slot built without kind still resolves by its ask text.
  {
    const env = mkEnv(), s = fakeSend();
    await env.STATE.put("daily:pending-ask:4510", JSON.stringify({ question: "چه چیزی را یادداشت کنم؟" }));
    mockModel(modelJson("note"));
    await handleDailyText(env, o(env, 4510, "فردا به علی زنگ بزنم", { ...s, nowMs: NOW }));
    check(rows("SELECT COUNT(*) AS n FROM notes WHERE user_id = 4510")[0].n === 1 && rows("SELECT text FROM notes WHERE user_id = 4510")[0].text === "فردا به علی زنگ بزنم", "3b: kind-less slot falls back to ask-text kind, body stored");
  }
  // (h) Abandonment with a note-text slot: model chat -> chat-direct, slot cleared, no expense-or-chat ask.
  {
    const env = mkEnv(), s = fakeSend();
    await noteAsk(env, s, 4511);
    const before = await slotOf(env, 4511);
    mockModel(modelJson("chat"));
    const r = await handleDailyText(env, o(env, 4511, "فردا به علی زنگ بزنم", { ...s, nowMs: NOW }));
    check(before?.kind === "note-text" && r === "chat-direct" && (await slotOf(env, 4511)) === null && !s.sent.some((m) => String(m.text ?? "").includes("این خرج است یا چت؟")) && fetchCalls === 1, "3b: note-text slot + model chat -> chat-direct, slot cleared, no expense-or-chat ask");
  }
  // (i) Abandonment with a translate-text slot: model chat -> chat-direct, slot cleared, no expense-or-chat ask.
  {
    const env = mkEnv(), s = fakeSend();
    mockModel(modelJson("translate", { target: "en" }));
    await handleDailyText(env, o(env, 4512, "ترجمه کن", { ...s, nowMs: NOW }));
    const before = await slotOf(env, 4512);
    mockModel(modelJson("chat"));
    const r = await handleDailyText(env, o(env, 4512, "سلام دنیا", { ...s, nowMs: NOW }));
    check(before?.kind === "translate-text" && r === "chat-direct" && (await slotOf(env, 4512)) === null && !s.sent.some((m) => String(m.text ?? "").includes("این خرج است یا چت؟")) && fetchCalls === 1, "3b: translate-text slot + model chat -> chat-direct, slot cleared, no expense-or-chat ask");
  }
  global.fetch = origFetch;
}

// ── Bare-note fix: bare note asks for the text at rule level, no model ──
// Live 2026-10-30 a bare note fell through to chat and the chat model
// hallucinated a stored note; the 3b slot never ran because no note-text
// slot was created. This fix asks directly, then reuses the 3b path.
if (DatabaseSync) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  const d1 = { prepare(sql) { const stmt = sqlite.prepare(sql); return { bind(...params) { return { run: async () => { stmt.run(...params); return { success: true }; }, all: async () => ({ results: stmt.all(...params) }), first: async () => stmt.get(...params) ?? null }; } }; } };
  const rows = (sql, params = []) => sqlite.prepare(sql).all(...params);
  const mkEnv = (extra = {}) => ({ STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242,4521,4522,4523,4524,4525,4526,4527", DB: d1, ROUTER_KEY: "k-test", ...extra });
  const fakeSend = () => { const sent = []; return { sent, send: async (text, opts) => { sent.push({ text, replyMarkup: opts?.replyMarkup }); }, api: async () => ({ ok: true }) }; };
  const o = (env, userId, text, extra = {}) => ({ chatId: userId, userId, text, send: extra.send, chat: extra.chat ?? (async () => {}), nowMs: extra.nowMs, hasImage: extra.hasImage });
  const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
  const origFetch = global.fetch;
  let fetchCalls = 0;
  const mockModel = (content) => { fetchCalls = 0; global.fetch = async () => { fetchCalls++; return Response.json({ choices: [{ message: { content } }] }); }; };
  const modelJson = (intent, extra = {}) => JSON.stringify({ intent, followup: null, target: null, ...extra });
  const lastText = (s) => String(s.sent.at(-1)?.text ?? "");
  const slotOf = async (env, uid) => env.STATE.get(`daily:pending-ask:${uid}`, "json");
  const cl = (s) => classifyDaily(s, { nowMs: NOW });
  // Classifier: bare forms ask for the note text, never chat.
  {
    const forms = ["یادداشت", "یادداشت کن", "یادداشت کن.", "یادداشت جدید", "لطفا یادداشت کن", "لطفاً یادداشت", "یادداشت:", "می‌خوام یک یادداشت جدید و جداگانه ثبت کنم", "می‌خوام یادداشت بنویسم"];
    check(forms.every((f) => { const c = cl(f); return c.intent === "ask" && c.question === "note-text"; }), "bare-note: classifyDaily bare forms -> ask note-text");
  }
  // End to end: bare note asks directly with zero model calls and a
  // note-text slot, replacing any stale slot.
  {
    const env = mkEnv(), s = fakeSend();
    await env.STATE.put("daily:pending-ask:4521", JSON.stringify({ question: "مبلغ چقدر بود؟", kind: "amount" }));
    fetchCalls = 0; global.fetch = async () => { fetchCalls++; throw new Error("model must not be called"); };
    const r = await handleDailyText(env, o(env, 4521, "یادداشت", { ...s, nowMs: NOW }));
    const slot = await slotOf(env, 4521);
    check(r === "handled" && fetchCalls === 0 && lastText(s) === "چه چیزی را یادداشت کنم؟" && slot?.kind === "note-text" && slot?.question === "چه چیزی را یادداشت کنم؟", "bare-note: e2e bare note -> note-text ask, slot kind, zero model fetches");
  }
  // End to end: body follow-up after the rule ask stores via the 3b path.
  {
    const env = mkEnv(), s = fakeSend();
    global.fetch = async () => { throw new Error("model must not be called"); };
    await handleDailyText(env, o(env, 4522, "یادداشت کن", { ...s, nowMs: NOW }));
    check(lastText(s) === "چه چیزی را یادداشت کنم؟" && (await slotOf(env, 4522))?.kind === "note-text", "bare-note: rule ask sets note-text slot");
    mockModel(modelJson("note"));
    const r = await handleDailyText(env, o(env, 4522, "بررسی اتصال Supabase به داشبورد و تست ورود کاربران در نسخه آزمایشی.", { ...s, nowMs: NOW }));
    check(r === "handled" && lastText(s).includes("یادداشت ذخیره شد") && rows("SELECT COUNT(*) AS n FROM notes WHERE user_id = 4522")[0].n === 1 && rows("SELECT text FROM notes WHERE user_id = 4522")[0].text === "بررسی اتصال Supabase به داشبورد و تست ورود کاربران در نسخه آزمایشی." && (await slotOf(env, 4522)) === null, "bare-note: body follow-up stored end to end, slot cleared");
  }
  // Non-stealing: note with a body stays a confident note, stored at once.
  {
    const env = mkEnv(), s = fakeSend();
    const c1 = cl("یادداشت کن فردا به علی زنگ بزنم"), c2 = cl("یادداشت: فردا به علی زنگ بزنم");
    check(c1.intent === "note" && c1.text === "فردا به علی زنگ بزنم" && c2.intent === "note" && c2.text === "فردا به علی زنگ بزنم", "bare-note: note with body stays confident note");
    const r = await handleDailyText(env, o(env, 4523, "یادداشت کن فردا به علی زنگ بزنم", { ...s, nowMs: NOW }));
    check(r === "handled" && lastText(s) === "✅ یادداشت ذخیره شد." && rows("SELECT COUNT(*) AS n FROM notes WHERE user_id = 4523")[0].n === 1, "bare-note: note with body stored at once, no ask");
  }
  // Non-stealing: note-query stays note-query, and lists the stored note.
  {
    const c1 = cl("یادداشت‌هایم"), c2 = cl("یادداشت‌های امروز");
    check(c1.intent === "note-query" && c2.intent === "note-query", "bare-note: note-query unchanged");
    const env = mkEnv(), s = fakeSend();
    await handleDailyText(env, o(env, 4524, "یادداشت کن فردا به علی زنگ بزنم", { ...s, nowMs: NOW }));
    await handleDailyText(env, o(env, 4524, "یادداشت‌هایم", { ...s, nowMs: NOW }));
    check(lastText(s).includes("فردا به علی زنگ بزنم"), "bare-note: note-query lists the stored note");
  }
  // Non-stealing: longer phrasing with a trailing body is not an ask.
  {
    const c1 = cl("می‌خوام یک یادداشت جدید و جداگانه ثبت کنم: خرید نان"), c2 = cl("می‌خوام یک یادداشت ثبت کنم فردا به علی زنگ بزنم");
    check(!(c1.intent === "ask" && c1.question === "note-text") && !(c2.intent === "ask" && c2.question === "note-text"), "bare-note: longer phrasing with trailing body not stolen");
  }
  global.fetch = origFetch;
}

// ── Fallback body-slot follow-ups: model tried first, slot decides on null ──
// Live 2026-10-30 the free model rambles past the 80-token cap instead of
// returning JSON, so a model-mediated body follow-up loops on re-ask when
// the model gives nothing. The model is still tried first (chat tier only);
// only when it returns null does the slot kind decide. The key proof below
// is exactly one failed fetch attempt followed by the deterministic outcome.
if (DatabaseSync) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  const d1 = { prepare(sql) { const stmt = sqlite.prepare(sql); return { bind(...params) { return { run: async () => { stmt.run(...params); return { success: true }; }, all: async () => ({ results: stmt.all(...params) }), first: async () => stmt.get(...params) ?? null }; } }; } };
  const rows = (sql, params = []) => sqlite.prepare(sql).all(...params);
  const mkEnv = (extra = {}) => ({ STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242,4531,4532,4533,4534,4535,4536", DB: d1, ROUTER_KEY: "k-test", ...extra });
  const fakeSend = () => { const sent = []; return { sent, send: async (text, opts) => { sent.push({ text, replyMarkup: opts?.replyMarkup }); }, api: async () => ({ ok: true }) }; };
  const o = (env, userId, text, extra = {}) => ({ chatId: userId, userId, text, send: extra.send, chat: extra.chat ?? (async () => {}), nowMs: extra.nowMs, hasImage: extra.hasImage });
  const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
  const origFetch = global.fetch;
  let fetchCalls = 0;
  const mockModel = (content) => { fetchCalls = 0; global.fetch = async () => { fetchCalls++; return Response.json({ choices: [{ message: { content } }] }); }; };
  const mockModelFail = () => { fetchCalls = 0; global.fetch = async () => { fetchCalls++; throw new Error("boom"); }; };
  const modelJson = (intent, extra = {}) => JSON.stringify({ intent, followup: null, target: null, ...extra });
  const lastText = (s) => String(s.sent.at(-1)?.text ?? "");
  const slotOf = async (env, uid) => env.STATE.get(`daily:pending-ask:${uid}`, "json");
  // Note-text body stored via fallback after a failing model attempt.
  {
    const env = mkEnv(), s = fakeSend();
    await handleDailyText(env, o(env, 4531, "یادداشت", { ...s, nowMs: NOW }));
    const before = await slotOf(env, 4531);
    mockModelFail();
    const r = await handleDailyText(env, o(env, 4531, "فردا به علی زنگ بزنم", { ...s, nowMs: NOW }));
    check(before?.kind === "note-text" && r === "handled" && fetchCalls === 1 && lastText(s).includes("یادداشت ذخیره شد") && rows("SELECT COUNT(*) AS n FROM notes WHERE user_id = 4531")[0].n === 1 && rows("SELECT text FROM notes WHERE user_id = 4531")[0].text === "فردا به علی زنگ بزنم" && (await slotOf(env, 4531)) === null, "slot-fallback: note-text body stored after failed model attempt");
  }
  // Empty note body re-asks via fallback, nothing stored.
  {
    const env = mkEnv(), s = fakeSend();
    await handleDailyText(env, o(env, 4532, "یادداشت", { ...s, nowMs: NOW }));
    mockModelFail();
    const r = await handleDailyText(env, o(env, 4532, "   ", { ...s, nowMs: NOW }));
    check(r === "handled" && fetchCalls === 1 && lastText(s).includes("چه چیزی را یادداشت کنم؟") && rows("SELECT COUNT(*) AS n FROM notes WHERE user_id = 4532")[0].n === 0 && (await slotOf(env, 4532))?.kind === "note-text", "slot-fallback: note-text empty body re-asks, nothing stored");
  }
  // Translate-text body asks for the language via fallback, body kept.
  {
    const env = mkEnv(), s = fakeSend();
    await handleDailyText(env, o(env, 4533, "ترجمه کن", { ...s, nowMs: NOW }));
    const before = await slotOf(env, 4533);
    mockModelFail();
    const r = await handleDailyText(env, o(env, 4533, "سلام دنیا", { ...s, nowMs: NOW }));
    const slot = await slotOf(env, 4533);
    check(before?.kind === "translate-text" && r === "handled" && fetchCalls === 1 && lastText(s).includes("به چه زبانی؟") && slot?.kind === "language" && slot?.pendingBody === "سلام دنیا", "slot-fallback: translate-text body -> language ask keeps body");
  }
  // Language answer translates the KEPT body via fallback after a failing model attempt.
  {
    const env = mkEnv(), s = fakeSend(); let chats = [];
    await handleDailyText(env, o(env, 4534, "ترجمه کن", { ...s, nowMs: NOW }));
    mockModelFail();
    await handleDailyText(env, o(env, 4534, "سلام دنیا", { ...s, nowMs: NOW }));
    const mid = await slotOf(env, 4534);
    mockModelFail();
    const r = await handleDailyText(env, o(env, 4534, "انگلیسی", { ...s, nowMs: NOW, chat: async (text, copts) => { chats.push({ text, copts }); } }));
    check(mid?.kind === "language" && mid?.pendingBody === "سلام دنیا" && r === "handled" && fetchCalls === 1 && chats[0]?.text === "سلام دنیا" && String(chats[0]?.copts?.systemPrompt ?? "").includes("English") && chats[0]?.copts?.noHistory === true && (await slotOf(env, 4534)) === null, "slot-fallback: language answer translates kept body after failed model attempt");
  }
  // Unmapped language answer re-asks via fallback with the body kept.
  {
    const env = mkEnv(), s = fakeSend();
    await handleDailyText(env, o(env, 4535, "ترجمه کن", { ...s, nowMs: NOW }));
    mockModelFail();
    await handleDailyText(env, o(env, 4535, "سلام دنیا", { ...s, nowMs: NOW }));
    mockModelFail();
    const r = await handleDailyText(env, o(env, 4535, "German", { ...s, nowMs: NOW }));
    const slot = await slotOf(env, 4535);
    check(r === "handled" && fetchCalls === 1 && lastText(s).includes("به چه زبانی؟") && slot?.kind === "language" && slot?.pendingBody === "سلام دنیا", "slot-fallback: language answer unmapped -> language re-ask, body kept");
  }
  // Non-body slots still go through the model: amount slot, one fetch.
  {
    const env = mkEnv(), s = fakeSend();
    await env.STATE.put("daily:pending-ask:4536", JSON.stringify({ question: "مبلغ چقدر بود؟", kind: "amount" }));
    mockModel(modelJson("expense"));
    const r = await handleDailyText(env, o(env, 4536, "۵۰۰ تومان نان", { ...s, nowMs: NOW }));
    check(r === "handled" && fetchCalls === 1 && (await slotOf(env, 4536)) === null, "slot-fallback: button/amount slots still use the model path");
  }
  global.fetch = origFetch;
}



// ── Phase 0-a interpreter layer (no wiring: these tests only touch src/interpreter.js) ──
{
  const projects = [{ name: "گلبهار", aliases: ["گل"] }, { name: "عمومی", aliases: [] }];
  const prompt = buildInterpreterPrompt({
    text: "فردا ساعت ۹ به علی زنگ بزنم",
    source: "voice",
    recentTurns: ["user: سلام"],
    openQuestion: null,
    projects,
    nowIso: "2026-10-31T15:30:00+03:30",
    defaultCurrency: "TOMAN",
  });
  check(prompt.user.includes("[BEGIN USER MESSAGE") && prompt.user.includes("فردا ساعت ۹ به علی زنگ بزنم") && prompt.user.includes("[END USER MESSAGE]") && prompt.user.includes("گلبهار") && prompt.user.includes("گل") && prompt.user.includes("2026-10-31T15:30:00+03:30"), "0-a: prompt delimits user text and carries projects and Iran now");
  check(prompt.system.includes("JSON array") && prompt.system.includes("at most 6 actions"), "0-a: prompt states JSON-only, max 6 actions");

  const good = JSON.stringify([
    { type: "task", text: "به علی زنگ بزنم", project: "گلبهار", due_text: null, remind_text: "فردا ساعت ۹", amount_text: null, query: null, target: null, confidence: 0.9, needs: "none" },
    { type: "expense", text: "نون خریدم", project: null, due_text: null, remind_text: null, amount_text: "۵۰۰ تومان", query: null, target: null, confidence: 0.8, needs: "none" },
  ]);
  const parsed = parseInterpreterOutput(good);
  check(parsed.ok && parsed.actions.length === 2 && parsed.actions[0].type === "task" && parsed.actions[1].amount_text === "۵۰۰ تومان", "0-a: valid JSON parses with all fields");
  const minimal = parseInterpreterOutput(JSON.stringify([{ type: "chat", text: "سلام", confidence: 0.7, needs: "none" }]));
  check(minimal.ok && minimal.actions[0].project === null && minimal.actions[0].query === null, "0-a: missing optional fields normalise to null");

  const badType = parseInterpreterOutput(JSON.stringify([
    { type: "task", text: "کاری", confidence: 0.9, needs: "none" },
    { type: "teleport", text: "چیزی", confidence: 0.9, needs: "none" },
  ]));
  check(!badType.ok, "0-a: unknown type invalidates the whole output, no silent drop");
  const tooMany = parseInterpreterOutput(JSON.stringify(Array.from({ length: INTERPRETER_MAX_ACTIONS + 1 }, (_, i) => ({ type: "chat", text: `متن ${i}`, confidence: 0.5, needs: "none" }))));
  check(!tooMany.ok, "0-a: over-long array (>6) invalid");
  check(!parseInterpreterOutput("this is not json at all").ok, "0-a: unparseable output invalid");
  check(!parseInterpreterOutput("").ok, "0-a: empty output invalid");
  const wrapped = parseInterpreterOutput(`here you go: ${good} done`);
  check(wrapped.ok && wrapped.actions.length === 2, "0-a: bracket-extracted fallback parses fenced JSON");

  // Retry: invalid once, then valid -> exactly 2 model calls, success.
  let calls = 0;
  const flaky = async () => { calls++; return calls === 1 ? "garbage" : good; };
  const retried = await interpretText({}, "candidate-model", prompt, flaky);
  check(retried.ok && retried.calls === 2 && calls === 2, "0-a: retry once on invalid JSON, then success with 2 calls");
  // Invalid twice -> failure with exactly 2 model calls.
  let calls2 = 0;
  const alwaysBad = async () => { calls2++; return "garbage"; };
  const failed = await interpretText({}, "candidate-model", prompt, alwaysBad);
  check(!failed.ok && failed.calls === 2 && calls2 === 2, "0-a: invalid twice returns failure with 2 calls");

  // Model id is a parameter, not hardcoded: the fake binding sees the passed id.
  let seenModel = null, seenTemp = null;
  const fakeEnv = { AI: { run: async (m, opts) => { seenModel = m; seenTemp = opts.temperature; return { response: good }; } } };
  const raw = await callInterpreterModel(fakeEnv, "some-candidate-model", prompt);
  check(seenModel === "some-candidate-model" && seenTemp === 0 && raw === good, "0-a: model id passed through as a parameter, temperature 0");

  // Validators reuse daily.js.
  const amt = validateAmountText("۵۰۰ هزار تومان", "TOMAN");
  check(amt.ok && amt.amount === 500000 && amt.currency === "TOMAN", "0-a: amount validator resolves a Persian amount phrase");
  check(!validateAmountText("مبلغی نامشخص", "TOMAN").ok, "0-a: amount validator rejects an unparsable phrase");
  check(validateAmountText(null, "TOMAN").ok, "0-a: null amount_text is valid with no resolution");
  const NOW = Date.UTC(2026, 9, 31, 12, 0, 0); // 2026-10-31 15:30 +03:30
  const past = validateDateTexts(null, "امروز ساعت ۹ صبح", NOW);
  check(!past.ok && past.errors.includes("past"), "0-a: date validator rejects a past reminder");
  const future = validateDateTexts(null, "فردا ساعت ۹ صبح", NOW);
  check(future.ok && future.remind_at === "2026-11-01T09:00:00+03:30", "0-a: date validator resolves a future reminder to ISO +03:30");
  const dueOnly = validateDateTexts("فردا", null, NOW);
  check(dueOnly.ok && dueOnly.due_at === "2026-11-01T00:00:00+03:30", "0-a: date-only due resolves to midnight");
  check(matchProject("گل", projects)?.name === "گلبهار" && matchProject("گلبهار", projects)?.name === "گلبهار", "0-a: project matcher matches an alias and a canonical name");
  check(matchProject("ناشناخته", projects) === null, "0-a: project matcher returns null for unknown, never auto-creates");
  const vAction = validateInterpreterAction({ type: "expense", text: "نون", project: null, amount_text: "۵۰۰ تومان", confidence: 0.9, needs: "none" }, { projects, nowMs: NOW, defaultCurrency: "TOMAN" });
  check(vAction.ok && vAction.resolved.amount === 500 && vAction.resolved.currency === "TOMAN", "0-a: action validator composes amount resolution");
  const vBadProject = validateInterpreterAction({ type: "task", text: "کاری", project: "ناشناخته", confidence: 0.9, needs: "none" }, { projects, nowMs: NOW, defaultCurrency: "TOMAN" });
  check(!vBadProject.ok && vBadProject.errors.includes("project"), "0-a: action validator flags an unknown project");
}

// ── Phase 0-b interpreter wiring (store-first + core policy; cards in 0-b2) ──
if (DatabaseSync) {
  const sqlite0b = new DatabaseSync(":memory:");
  sqlite0b.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite0b.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  const d1b = { prepare(sql) { const stmt = sqlite0b.prepare(sql); return { bind(...params) { return { run: async () => { stmt.run(...params); return { success: true }; }, all: async () => ({ results: stmt.all(...params) }), first: async () => stmt.get(...params) ?? null }; } }; } };
  const rows0b = (sql, params = []) => sqlite0b.prepare(sql).all(...params);
  const mkEnv0b = (extra = {}) => ({ STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242,4243", DB: d1b, ...extra });
  const NOW0b = Date.UTC(2026, 9, 31, 12, 0, 0); // 2026-10-31 15:30 Iran time
  const act = (type, extra = {}) => ({ type, text: extra.text ?? "متن", project: extra.project ?? null, due_text: extra.due_text ?? null, remind_text: extra.remind_text ?? null, amount_text: extra.amount_text ?? null, query: extra.query ?? null, target: extra.target ?? null, confidence: extra.confidence ?? 0.9, needs: extra.needs ?? "none" });
  const fakeInterp = (actions) => async () => JSON.stringify(actions);
  const mkS = () => { const sent = []; const chats = []; return { sent, chats, send: async (text, opts) => { sent.push({ text, replyMarkup: opts?.replyMarkup }); }, chat: async (text, copts) => { chats.push({ text, copts }); } }; };
  const mkO = (s, text, extra = {}) => ({ chatId: 4242, userId: 4242, text, send: s.send, chat: s.chat, nowMs: NOW0b, ...extra });
  const btnData = (s) => s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
  // Fast money: confirm card, zero interpreter calls, nothing stored yet.
  {
    const env = mkEnv0b(), s = mkS();
    let calls = 0;
    const counting = async () => { calls++; return JSON.stringify([act("chat")]); };
    const r = await handleDailyText(env, mkO(s, "خرج کردم ۵۰۰ تومان نان", { interpreterCallFn: counting }));
    check(r === "handled", "0-b: fast money handled");
    check(btnData(s).some((d) => d.startsWith("daily:confirm:")), "0-b: fast money reaches confirm");
    check(calls === 0, "0-b: fast money makes zero interpreter calls");
    check(rows0b("SELECT COUNT(*) AS n FROM expenses")[0].n === 0, "0-b: money never stored before confirm");
  }
  // Interpreter note: stored with a cancel button, row finalised daily,
  // no pending row left. (Change-type and correction are 0-b2.)
  {
    const env = mkEnv0b(), s = mkS();
    const r = await handleDailyText(env, mkO(s, "سلام، یک چیزی به ذهنم رسید", { interpreterCallFn: fakeInterp([act("note", { text: "متن یادداشت" })]) }));
    check(r === "handled", "0-b: interpreter note handled");
    check(s.sent.at(-1)?.text === "✅ یادداشت ذخیره شد.", "0-b: note confirmation text");
    check(btnData(s).some((d) => d.startsWith("interp:del:")), "0-b: note stores with a cancel button");
    check(rows0b("SELECT COUNT(*) AS n FROM notes WHERE text = 'متن یادداشت'")[0].n === 1, "0-b: note row stored");
    check(rows0b("SELECT COUNT(*) AS n FROM messages WHERE kind = 'pending'")[0].n === 0, "0-b: no pending row left behind");
    check(rows0b("SELECT kind FROM messages WHERE content = 'سلام، یک چیزی به ذهنم رسید'")[0]?.kind === "daily", "0-b: store-first row finalised to daily");
  }
  // Interpreter chat: chat path only, row finalised to chat; a stray pending
  // row is invisible to chat context (the SQL kind='chat' filter).
  {
    const env = mkEnv0b(), s = mkS();
    const r = await handleDailyText(env, mkO(s, "سلام، چطوری؟", { interpreterCallFn: fakeInterp([act("chat", { text: "سلام، چطوری؟" })]) }));
    check(r === "handled", "0-b: interpreter chat handled");
    check(s.chats.length === 1 && s.chats[0].copts?.saveText === "", "0-b: chat action goes to chat path with no user-row save");
    check(rows0b("SELECT kind FROM messages WHERE content = 'سلام، چطوری؟'")[0]?.kind === "chat", "0-b: chat action finalises to chat");
    sqlite0b.prepare("INSERT INTO messages (user_id, role, content, kind) VALUES (4242, 'user', 'پیام ناتمام', 'pending')").run();
    const ctxRows = await getChatMessages(d1b, 4242, 50);
    check(!ctxRows.some((m) => m.content === "پیام ناتمام"), "0-b: pending rows excluded from chat context");
  }
  // Low confidence: type buttons, nothing stored.
  {
    const env = mkEnv0b(), s = mkS();
    const before = rows0b("SELECT COUNT(*) AS n FROM notes")[0].n;
    await handleDailyText(env, mkO(s, "چیزی مبهم", { interpreterCallFn: fakeInterp([act("chat", { confidence: 0.3 })]) }));
    check(btnData(s).filter((d) => d.startsWith("interp:type:")).length === 4, "0-b: low confidence yields all four type buttons");
    check(rows0b("SELECT COUNT(*) AS n FROM notes")[0].n === before, "0-b: low confidence stores nothing");
  }
  // Query: answered from D1, no chat model call.
  {
    const env = mkEnv0b(), s = mkS();
    sqlite0b.prepare("INSERT INTO expenses (user_id, type, amount, currency_code, date) VALUES (4242, 'expense', 400, 'TOMAN', '2026-10-31')").run();
    await handleDailyText(env, mkO(s, "وضعیت مالی امروز چطوره؟", { interpreterCallFn: fakeInterp([act("query", { query: { kind: "expense", periodText: "امروز", project: null } })]) }));
    check(String(s.sent.at(-1)?.text ?? "").includes("TOMAN: 400"), "0-b: query answers from D1");
    check(s.chats.length === 0, "0-b: query makes no chat model call");
  }
  // Interpreter failure: unavailable message with type buttons + Retry, and
  // no domain action stored — the message row itself stays pending.
  {
    const env = mkEnv0b(), s = mkS();
    const before = rows0b("SELECT COUNT(*) AS n FROM notes")[0].n;
    const failing = async () => { throw new Error("boom"); };
    await handleDailyText(env, mkO(s, "سلام، یک چیزی به ذهنم رسید", { interpreterCallFn: failing }));
    check(String(s.sent.at(-1)?.text ?? "").includes("تفسیر خودکار الان در دسترس نیست"), "0-b: failure yields the unavailable message");
    check(btnData(s).filter((d) => d.startsWith("interp:type:")).length === 4, "0-b: failure yields all four type buttons");
    check(btnData(s).some((d) => d.startsWith("retry:")), "0-b fix: failure yields a Retry button");
    check(rows0b("SELECT COUNT(*) AS n FROM notes")[0].n === before, "0-b fix: failure stores no domain action");
    check(rows0b("SELECT COUNT(*) AS n FROM messages WHERE content = 'سلام، یک چیزی به ذهنم رسید' AND kind = 'pending'")[0].n === 1, "0-b fix: failure leaves the row pending");
  }
  // Unknown project in 0-b: type buttons, never an auto-created project.
  // (The choice card and its re-entry are 0-b2.)
  {
    const env = mkEnv0b(), s = mkS();
    await handleDailyText(env, mkO(s, "کاری برای پروژه‌ی تازه", { interpreterCallFn: fakeInterp([act("task", { text: "کاری برای پروژه‌ی تازه", project: "پروژه‌ی تازه" })]) }));
    check(btnData(s).some((d) => d.startsWith("interp:proj:")), "0-b3: unknown project yields the project-choice card, never auto-create");
    check(rows0b("SELECT COUNT(*) AS n FROM notes WHERE text = 'کاری برای پروژه‌ی تازه'")[0].n === 0, "0-b: task is not silently stored as a note");
  }
  // Multi-action: one summary with both items. (Per-note delete buttons: 0-b2.)
  {
    const env = mkEnv0b(), s = mkS();
    await handleDailyText(env, mkO(s, "دو تا یادداشت", { interpreterCallFn: fakeInterp([act("note", { text: "مورد یک" }), act("note", { text: "مورد دو" })]) }));
    check(String(s.sent.at(-1)?.text ?? "").includes("مورد یک") && String(s.sent.at(-1)?.text ?? "").includes("مورد دو"), "0-b: multi-action summary lists every item");
  }
  // Rollout gate: interpreter unconfigured -> today's path, returns chat.
  {
    const env = mkEnv0b(), s = mkS();
    const r = await handleDailyText(env, mkO(s, "سلام، چطوری؟"));
    check(r === "chat", "0-b: unconfigured interpreter falls back to today's path");
  }
  // ── Phase 0-b fix: save-first ordering + failure retry (request changes) ──
  // (a) Fast money: the entry row is saved pending BEFORE classification,
  // and the expense row count is still 0 before Confirm.
  {
    const sqliteFix = new DatabaseSync(":memory:");
    sqliteFix.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
    sqliteFix.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    const log = [];
    const d1log = { prepare(sql) { const stmt = sqliteFix.prepare(sql); return { bind(...params) { return { run: async () => { log.push({ sql, params }); stmt.run(...params); return { success: true }; }, all: async () => ({ results: stmt.all(...params) }), first: async () => stmt.get(...params) ?? null }; } }; } };
    const env = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242,4243", DB: d1log };
    const s = mkS();
    let calls = 0;
    const counting = async () => { calls++; return JSON.stringify([act("chat")]); };
    const r = await handleDailyText(env, mkO(s, "خرج کردم ۵۰۰ تومان نان", { interpreterCallFn: counting }));
    check(r === "handled", "0-b fix: fast money handled");
    check(btnData(s).some((d) => d.startsWith("daily:confirm:")), "0-b fix: fast money reaches confirm");
    check(calls === 0, "0-b fix: fast money makes zero interpreter calls");
    const firstMsgInsert = log.find((e) => e.sql.startsWith("INSERT INTO messages"));
    check(firstMsgInsert?.params?.includes("pending") === true, "0-b fix: entry row saved pending before classification");
    check(sqliteFix.prepare("SELECT COUNT(*) AS n FROM expenses").all()[0].n === 0, "0-b fix: expense row count is 0 before Confirm");
    check(sqliteFix.prepare("SELECT kind FROM messages WHERE content = 'خرج کردم ۵۰۰ تومان نان'").all()[0]?.kind === "daily", "0-b fix: fast money entry row finalised to daily");
    check(sqliteFix.prepare("SELECT COUNT(*) AS n FROM messages WHERE content = 'خرج کردم ۵۰۰ تومان نان'").all()[0].n === 1, "0-b fix: fast money saves exactly one message row");
  }
  // (c) Retry with the stored text succeeds and finalises kind, with no
  // second row. (b) is the updated failure test above: pending + Retry.
  {
    const env = mkEnv0b(), s = mkS();
    const failing = async () => { throw new Error("boom"); };
    await handleDailyText(env, mkO(s, "متن قابل بازیابی", { interpreterCallFn: failing }));
    const retryBtn = btnData(s).find((d) => d.startsWith("retry:"));
    check(!!retryBtn, "0-b fix: failure reply carries a retry button");
    const rowId = Number(retryBtn.split(":")[1]);
    check(rows0b("SELECT kind FROM messages WHERE id = ?", [rowId])[0]?.kind === "pending", "0-b fix: retry target row is pending");
    const s2 = mkS();
    const ok = await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: retryBtn, send: s2.send, editMarkup: async () => {}, chat: s2.chat, nowMs: NOW0b, interpreterCallFn: fakeInterp([act("note", { text: "متن قابل بازیابی" })]) });
    check(ok === true, "0-b fix: retry callback handled");
    check(s2.sent.at(-1)?.text === "✅ یادداشت ذخیره شد.", "0-b fix: retry success stores the note");
    check(rows0b("SELECT kind FROM messages WHERE id = ?", [rowId])[0]?.kind === "daily", "0-b fix: retry success finalises kind");
    check(rows0b("SELECT COUNT(*) AS n FROM messages WHERE content = 'متن قابل بازیابی'")[0].n === 1, "0-b fix: retry saves no second row");
  }
  // (d) Retry with a missing row yields a clear message + type buttons.
  {
    const env = mkEnv0b(), s = mkS();
    const ok = await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: "retry:999999", send: s.send, editMarkup: async () => {}, chat: s.chat, nowMs: NOW0b });
    check(ok === true, "0-b fix: missing retry row handled");
    check(String(s.sent.at(-1)?.text ?? "").includes("پیدا نشد"), "0-b fix: missing retry row yields a clear message");
    check(btnData(s).filter((d) => d.startsWith("interp:type:")).length === 4, "0-b fix: missing retry row yields type buttons");
  }
  // ── Phase 0-b2: external backup + circuit breaker (v3 3.7) ──
  // (a) The failure message carries the external button next to the four
  // type buttons and Retry; nothing is stored by the failure itself.
  {
    const env = mkEnv0b(), s = mkS();
    const failing = async () => { throw new Error("boom"); };
    await handleDailyText(env, mkO(s, "متن خراب", { interpreterCallFn: failing }));
    check(btnData(s).some((d) => d.startsWith("interp:backup:")), "0-b2: failure message carries the external backup button");
    check(btnData(s).filter((d) => d.startsWith("interp:type:")).length === 4, "0-b2: failure message still carries all four type buttons");
    check(btnData(s).some((d) => d.startsWith("retry:")), "0-b2: failure message still carries Retry");
  }
  // (b) Backup with masked input: the backup model sees only placeholders
  // (no link, phone, or amount), the restored note stores the real values,
  // and the pending row finalises — same policy as the Workers AI path.
  {
    const env = mkEnv0b(), s = mkS();
    const orig = "یادداشت https://example.com و ۵۰۰ تومان برای 09123456789";
    const failing = async () => { throw new Error("boom"); };
    await handleDailyText(env, mkO(s, orig, { interpreterCallFn: failing }));
    const backupBtn = btnData(s).find((d) => d.startsWith("interp:backup:"));
    const rowId = Number(btnData(s).find((d) => d.startsWith("retry:"))?.split(":")[1]);
    let seenMasked = "";
    const backupFn = async (masked) => { seenMasked = masked; return JSON.stringify([act("note", { text: "یادداشت {U1} و {A1} تومان برای {P1}" })]); };
    const s2 = mkS();
    const ok = await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: backupBtn, send: s2.send, editMarkup: async () => {}, chat: s2.chat, nowMs: NOW0b, backupCallFn: backupFn });
    check(ok === true, "0-b2: backup callback handled");
    check(!seenMasked.includes("https://example.com") && !seenMasked.includes("۵۰۰") && !seenMasked.includes("09123456789"), "0-b2: backup input masks link, amount, and phone");
    check(seenMasked.includes("{U1}") && seenMasked.includes("{A1}") && seenMasked.includes("{P1}"), "0-b2: backup input carries all three placeholder classes");
    check(s2.sent.at(-1)?.text === "✅ یادداشت ذخیره شد.", "0-b2: backup note stored via the same policy");
    check(rows0b("SELECT COUNT(*) AS n FROM notes WHERE text = ?", [orig])[0].n === 1, "0-b2: backup restores placeholders to the real values");
    check(rows0b("SELECT kind FROM messages WHERE id = ?", [rowId])[0]?.kind === "daily", "0-b2: backup success finalises the pending row");
  }
  // (c) Backup without key/model: clear message + type buttons, never chat.
  {
    const env = mkEnv0b(), s = mkS();
    await handleDailyText(env, mkO(s, "متن خراب", { interpreterCallFn: async () => { throw new Error("boom"); } }));
    const backupBtn = btnData(s).find((d) => d.startsWith("interp:backup:"));
    const s2 = mkS();
    await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: backupBtn, send: s2.send, editMarkup: async () => {}, chat: s2.chat, nowMs: NOW0b });
    check(String(s2.sent.at(-1)?.text ?? "").includes("وصل نیست"), "0-b2: unconfigured backup yields a clear message");
    check(btnData(s2).filter((d) => d.startsWith("interp:type:")).length === 4, "0-b2: unconfigured backup yields type buttons");
    check(s2.chats.length === 0, "0-b2: unconfigured backup never falls back to chat");
  }
  // (d) Backup failure: type buttons only, never chat by default.
  {
    const env = mkEnv0b(), s = mkS();
    await handleDailyText(env, mkO(s, "متن خراب", { interpreterCallFn: async () => { throw new Error("boom"); } }));
    const backupBtn = btnData(s).find((d) => d.startsWith("interp:backup:"));
    const s2 = mkS();
    const badBackup = async () => { throw new Error("backup down"); };
    await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: backupBtn, send: s2.send, editMarkup: async () => {}, chat: s2.chat, nowMs: NOW0b, backupCallFn: badBackup });
    check(String(s2.sent.at(-1)?.text ?? "").includes("هم نشد"), "0-b2: backup failure yields a clear message");
    check(btnData(s2).filter((d) => d.startsWith("interp:type:")).length === 4, "0-b2: backup failure yields type buttons only");
    check(s2.chats.length === 0, "0-b2: backup failure never falls back to chat");
  }
  // (e) Circuit breaker: 3 errors in 2 minutes suppress Workers AI calls;
  // deleting the flag (what real KV expiry does at TTL end) lifts it.
  {
    const env = mkEnv0b(), s = mkS();
    let calls = 0;
    const failing = async () => { calls++; throw new Error("boom"); };
    for (let i = 0; i < 3; i++) await handleDailyText(env, mkO(s, `خرابی ${i}`, { interpreterCallFn: failing }));
    const flag = await env.STATE.get("interp:breaker:flag", "json");
    check(flag !== null && typeof flag.until === "number", "0-b2: three errors set the breaker flag");
    calls = 0;
    const errsBefore = await env.STATE.get("interp:breaker:errors", "json");
    const countingOk = async () => { calls++; return JSON.stringify([act("note", { text: "نباید برسد" })]); };
    await handleDailyText(env, mkO(s, "پیام بعد از مدارشکن", { interpreterCallFn: countingOk }));
    check(calls === 0, "0-b2: breaker suppresses Workers AI calls while flagged");
    check(String(s.sent.at(-1)?.text ?? "").includes("تفسیر خودکار الان در دسترس نیست"), "0-b2: suppressed call still yields the unavailable message");
    check(btnData(s).some((d) => d.startsWith("interp:backup:")), "0-b2: suppressed call still offers the backup button");
    const errsAfter = await env.STATE.get("interp:breaker:errors", "json");
    check(JSON.stringify(errsAfter) === JSON.stringify(errsBefore), "0-b2: suppressed attempt records no new breaker error");
    const supBtn = btnData(s).filter((d) => d.startsWith("interp:backup:")).at(-1);
    const supRec = await env.STATE.get(`interp:${supBtn.split(":")[2]}`, "json");
    check(supRec?.text === "پیام بعد از مدارشکن", "0-b2: suppressed attempt still creates the failure record for Retry/Backup");
    await env.STATE.delete("interp:breaker:flag");
    await handleDailyText(env, mkO(s, "پیام بعد از رفع مدارشکن", { interpreterCallFn: fakeInterp([act("note", { text: "بعد از رفع" })]) }));
    check(String(s.sent.at(-1)?.text ?? "").includes("یادداشت ذخیره شد"), "0-b2: lifting the flag resumes interpretation");
    // (g) Backup still works while the breaker is flagged (the escape hatch).
    for (let i = 0; i < 3; i++) await handleDailyText(env, mkO(s, `خرابی دوم ${i}`, { interpreterCallFn: failing }));
    await handleDailyText(env, mkO(s, "پیام مسدود", { interpreterCallFn: fakeInterp([act("note", { text: "نباید برسد" })]) }));
    const backupBtn = btnData(s).find((d) => d.startsWith("interp:backup:"));
    check(!!backupBtn, "0-b2: suppressed message still offers the backup button for the tap");
    const s2 = mkS();
    await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: backupBtn, send: s2.send, editMarkup: async () => {}, chat: s2.chat, nowMs: NOW0b, backupCallFn: fakeInterp([act("note", { text: "از بکاپ" })]) });
    check(s2.sent.at(-1)?.text === "✅ یادداشت ذخیره شد.", "0-b2: backup works while the breaker is flagged");
  }
  // (f) A quota error flags immediately (no 3-error wait) until UTC reset.
  {
    const env = mkEnv0b(), s = mkS();
    const quotaFail = async () => { throw new Error("429 quota exceeded"); };
    await handleDailyText(env, mkO(s, "پیام سهمیه", { interpreterCallFn: quotaFail }));
    const flag = await env.STATE.get("interp:breaker:flag", "json");
    check(flag !== null && flag.until === "quota", "0-b2: quota error sets the quota flag at once");
    let calls = 0;
    const counting = async () => { calls++; return JSON.stringify([act("note", { text: "نباید برسد" })]); };
    await handleDailyText(env, mkO(s, "پیام بعد از سهمیه", { interpreterCallFn: counting }));
    check(calls === 0, "0-b2: quota flag suppresses Workers AI calls");
  }
  // ── Phase 0-b3: change-type, task card, project choice, correction, multi delete ──
  {
    const env = mkEnv0b(), s = mkS();
    await handleDailyText(env, mkO(s, "پیام یادداشت", { interpreterCallFn: fakeInterp([act("note", { text: "خرج کردم ۵۰۰ تومان نان" })]) }));
    const changeBtn = btnData(s).find((d) => d.startsWith("interp:change:"));
    check(!!changeBtn, "0-b3: note card carries a change-type button");
    const s2 = mkS();
    await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: changeBtn, send: s2.send, editMarkup: async () => {}, chat: s2.chat, nowMs: NOW0b });
    const expBtn = btnData(s2).find((d) => d.startsWith("interp:type:expense:"));
    check(!!expBtn, "0-b3: change-type offers the type choices");
    const expBefore = rows0b("SELECT COUNT(*) AS n FROM expenses")[0].n;
    const s3 = mkS();
    await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: expBtn, send: s3.send, editMarkup: async () => {}, chat: s3.chat, nowMs: NOW0b });
    check(btnData(s3).some((d) => d.startsWith("daily:confirm:")), "0-b3: change-type note->expense reaches confirm");
    check(rows0b("SELECT COUNT(*) AS n FROM expenses")[0].n === expBefore, "0-b3: change-type expense never stored before Confirm");
  }
  {
    const env = mkEnv0b(), s = mkS();
    await handleDailyText(env, mkO(s, "پیام یادداشت دو", { interpreterCallFn: fakeInterp([act("note", { text: "یادداشت نگه‌داشتنی" })]) }));
    const changeBtn = btnData(s).find((d) => d.startsWith("interp:change:"));
    const s2 = mkS();
    await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: changeBtn, send: s2.send, editMarkup: async () => {}, chat: s2.chat, nowMs: NOW0b });
    const taskBtn = btnData(s2).find((d) => d.startsWith("interp:type:task:"));
    await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: taskBtn, send: s2.send, editMarkup: async () => {}, chat: s2.chat, nowMs: NOW0b });
    check(String(s2.sent.at(-1)?.text ?? "").includes("فاز ۱"), "0-b3: change-type note->task yields the honesty line");
    check(rows0b("SELECT COUNT(*) AS n FROM notes WHERE text = 'یادداشت نگه‌داشتنی'")[0].n === 1, "0-b3: change-type task choice stores no note-as-task");
  }
  {
    const env = mkEnv0b(), s = mkS();
    await handleDailyText(env, mkO(s, "کاری برای پروژه‌ی تازه", { interpreterCallFn: fakeInterp([act("note", { text: "یادداشت پروژه‌ای", project: "پروژه‌ی تازه" })]) }));
    const projBtn = btnData(s).find((d) => d.startsWith("interp:proj:2:"));
    check(!!projBtn && String(s.sent.at(-1)?.text ?? "").includes("پروژه‌ی تازه"), "0-b3: unknown project yields the project-choice card");
    const s2 = mkS();
    await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: projBtn, send: s2.send, editMarkup: async () => {}, chat: s2.chat, nowMs: NOW0b });
    check(rows0b("SELECT COUNT(*) AS n FROM notes WHERE text = 'یادداشت پروژه‌ای'")[0].n === 1, "0-b3: project-choice re-entry stores with the chosen project");
  }
  {
    const env = mkEnv0b(), s = mkS();
    await handleDailyText(env, mkO(s, "یادداشت اول", { interpreterCallFn: fakeInterp([act("note", { text: "متن اول" })]) }));
    await handleDailyText(env, mkO(s, "اصلاحش کن", { interpreterCallFn: fakeInterp([act("correction", { text: "متن اصلاح‌شده" })]) }));
    check(rows0b("SELECT COUNT(*) AS n FROM notes WHERE text = 'متن اصلاح‌شده'")[0].n === 1 && rows0b("SELECT COUNT(*) AS n FROM notes WHERE text = 'متن اول'")[0].n === 0, "0-b3: correction within TTL edits the note");
    const env2 = mkEnv0b(), s2 = mkS();
    await handleDailyText(env2, mkO(s2, "اصلاح بدون مورد", { interpreterCallFn: fakeInterp([act("correction", { text: "متن تازه" })]) }));
    check(String(s2.sent.at(-1)?.text ?? "").includes("۱۰ دقیقه") && rows0b("SELECT COUNT(*) AS n FROM notes WHERE text = 'متن تازه'")[0].n === 0, "0-b3: correction outside TTL edits nothing");
  }
  {
    const env = mkEnv0b(), s = mkS();
    await handleDailyText(env, mkO(s, "دو تا یادداشت", { interpreterCallFn: fakeInterp([act("note", { text: "مورد الف" }), act("note", { text: "مورد ب" })]) }));
    const delBtns = btnData(s).filter((d) => d.startsWith("interp:del:"));
    check(delBtns.length === 2, "0-b3: multi-action summary carries one delete button per note");
    const s2 = mkS();
    await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: delBtns[0], send: s2.send, editMarkup: async () => {}, chat: s2.chat, nowMs: NOW0b });
    check(rows0b("SELECT COUNT(*) AS n FROM notes WHERE text = 'مورد الف'")[0].n === 0 && rows0b("SELECT COUNT(*) AS n FROM notes WHERE text = 'مورد ب'")[0].n === 1, "0-b3: multi delete removes only that note");
    await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: delBtns[0], send: s2.send, editMarkup: async () => {}, chat: s2.chat, nowMs: NOW0b });
    check(String(s2.sent.at(-1)?.text ?? "") === "قبلاً ثبت شد یا مهلتش گذشته", "0-b3: double delete is a no-op with the fixed message");
  }
  {
    const env = mkEnv0b(), s = mkS();
    await handleDailyText(env, mkO(s, "تسک من", { interpreterCallFn: fakeInterp([act("task", { text: "گزارش را بفرستم", project: "گلبهار" })]) }));
    check(String(s.sent.at(-1)?.text ?? "").includes("ذخیره با فاز ۱ می‌آید") && btnData(s).some((d) => d.startsWith("interp:taskdismiss:")), "0-b3: task action yields a presentation-only card");
    const disBtn = btnData(s).find((d) => d.startsWith("interp:taskdismiss:"));
    const s2 = mkS();
    await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: disBtn, send: s2.send, editMarkup: async () => {}, chat: s2.chat, nowMs: NOW0b });
    check(String(s2.sent.at(-1)?.text ?? "").includes("کنار گذاشته شد"), "0-b3: task card dismiss stores nothing");
  }
  // ── Phase 0-b3 fix: correction never INSERTs, note-delete checked ──
  {
    // Fix 1: update failure -> failed, read failure -> failed, deleted
    // target -> missing; none of them inserts a new expense.
    const env = mkEnv0b(), s = mkS();
    await handleDailyText(env, mkO(s, "خرج کردم ۵۰۰ تومان کتاب اصلاحی"));
    const cBtn = btnData(s).find((d) => d.startsWith("daily:confirm:"));
    await resolveDailyCallback(env, { fromId: 4242, chatId: 4242, data: cBtn, send: s.send, editMarkup: async () => {}, chat: s.chat, nowMs: NOW0b });
    const target = rows0b("SELECT id FROM expenses WHERE item = 'کتاب اصلاحی'")[0].id;
    const sC = mkS();
    await handleDailyText(env, mkO(sC, "اصلاحش کن", { interpreterCallFn: fakeInterp([act("correction", { text: "خرج کردم ۸۰۰ تومان کتاب اصلاحی" })]) }));
    const corrId = sC.sent.flatMap((m) => m.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []).find((d) => d.startsWith("daily:confirm:"))?.split(":")[2];
    check(!!corrId, "0-b3 fix: correction yields a confirm card");
    const updFailEnv = { ...env, DB: { prepare(sql) { if (String(sql).includes("UPDATE expenses")) throw new Error("boom"); return d1b.prepare(sql); } } };
    const rUpd = await confirmExpenseDraft(updFailEnv, 4242, corrId);
    check(rUpd.status === "failed" && rows0b("SELECT amount FROM expenses WHERE id = ?", [target])[0].amount === 500 && (await env.STATE.get(`daily:draft:${corrId}`, "json")) !== null, "0-b3 fix: correction update failure -> failed, original kept, draft kept");
    const readFailEnv = { ...env, DB: { prepare() { throw new Error("boom"); } } };
    const rRead = await confirmExpenseDraft(readFailEnv, 4242, corrId);
    check(rRead.status === "failed" && rows0b("SELECT COUNT(*) AS n FROM expenses WHERE item = 'کتاب اصلاحی'")[0].n === 1, "0-b3 fix: correction read failure -> failed, no new expense");
    sqlite0b.prepare("DELETE FROM expenses WHERE id = ?").run(target);
    const rMiss = await confirmExpenseDraft(env, 4242, corrId);
    check(rMiss.status === "missing" && rows0b("SELECT COUNT(*) AS n FROM expenses WHERE item = 'کتاب اصلاحی'")[0].n === 0, "0-b3 fix: deleted correction target -> missing, no new expense");
    // Malformed corrects: table set but id missing/invalid -> missing,
    // never the normal INSERT path.
    await env.STATE.put("daily:draft:badnull", JSON.stringify({ owner: 4242, type: "expense", amount: 100, currency: "TOMAN", item: "بدون شناسه", date: "2026-10-31", corrects: { table: "expenses", id: null } }));
    await env.STATE.put("daily:draft:badstr", JSON.stringify({ owner: 4242, type: "expense", amount: 100, currency: "TOMAN", item: "بدون شناسه", date: "2026-10-31", corrects: { table: "expenses", id: "abc" } }));
    const rBadNull = await confirmExpenseDraft(env, 4242, "badnull");
    const rBadStr = await confirmExpenseDraft(env, 4242, "badstr");
    check(rBadNull.status === "missing" && rBadStr.status === "missing" && rows0b("SELECT COUNT(*) AS n FROM expenses WHERE item = 'بدون شناسه'")[0].n === 0, "0-b3 fix: malformed corrects id -> missing, no INSERT");
  }
  {
    // Fix 2a: note DELETE failure at Confirm -> failed, draft kept,
    // expense kept once; retry succeeds once, note gone, no duplicate.
    const env = mkEnv0b(), s = mkS();
    await handleDailyText(env, mkO(s, "پیام یادداشت سه", { interpreterCallFn: fakeInterp([act("note", { text: "خرج کردم ۷۰۰ تومان چای اصلاحی" })]) }));
    const changeBtn = btnData(s).find((d) => d.startsWith("interp:change:"));
    const s2 = mkS();
    await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: changeBtn, send: s2.send, editMarkup: async () => {}, chat: s2.chat, nowMs: NOW0b });
    const expBtn = btnData(s2).find((d) => d.startsWith("interp:type:expense:"));
    const s3 = mkS();
    await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: expBtn, send: s3.send, editMarkup: async () => {}, chat: s3.chat, nowMs: NOW0b });
    const confId = btnData(s3).find((d) => d.startsWith("daily:confirm:"))?.split(":")[2];
    const failDelEnv = { ...env, DB: { prepare(sql) { if (String(sql).includes("DELETE FROM notes")) throw new Error("boom"); return d1b.prepare(sql); } } };
    const rFail = await confirmExpenseDraft(failDelEnv, 4242, confId);
    check(rFail.status === "failed" && rows0b("SELECT COUNT(*) AS n FROM expenses WHERE item = 'چای اصلاحی'")[0].n === 1 && rows0b("SELECT COUNT(*) AS n FROM notes WHERE text = 'خرج کردم ۷۰۰ تومان چای اصلاحی'")[0].n === 1 && (await env.STATE.get(`daily:draft:${confId}`, "json")) !== null, "0-b3 fix: note DELETE failure -> failed, draft kept, expense once, note kept");
    const rOk = await confirmExpenseDraft(env, 4242, confId);
    check(rOk.status === "ok" && rows0b("SELECT COUNT(*) AS n FROM expenses WHERE item = 'چای اصلاحی'")[0].n === 1 && rows0b("SELECT COUNT(*) AS n FROM notes WHERE text = 'خرج کردم ۷۰۰ تومان چای اصلاحی'")[0].n === 0 && (await env.STATE.get(`daily:draft:${confId}`, "json")) === null, "0-b3 fix: retry after DELETE failure succeeds once, note gone");
  }
  {
    // Fix 2b: note DELETE failure on note->chat -> no chat, clear failure.
    const env = mkEnv0b(), s = mkS();
    await handleDailyText(env, mkO(s, "پیام یادداشت چهار", { interpreterCallFn: fakeInterp([act("note", { text: "یادداشت چتی" })]) }));
    const changeBtn = btnData(s).find((d) => d.startsWith("interp:change:"));
    const s2 = mkS();
    await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: changeBtn, send: s2.send, editMarkup: async () => {}, chat: s2.chat, nowMs: NOW0b });
    const chatBtn = btnData(s2).find((d) => d.startsWith("interp:type:chat:"));
    const failDelEnv = { ...env, DB: { prepare(sql) { if (String(sql).includes("DELETE FROM notes")) throw new Error("boom"); return d1b.prepare(sql); } } };
    const s3 = mkS();
    await resolveInterpCallback(failDelEnv, { fromId: 4242, chatId: 4242, data: chatBtn, send: s3.send, editMarkup: async () => {}, chat: s3.chat, nowMs: NOW0b });
    check(s3.chats.length === 0 && String(s3.sent.at(-1)?.text ?? "").includes("ذخیره نشد") && rows0b("SELECT COUNT(*) AS n FROM notes WHERE text = 'یادداشت چتی'")[0].n === 1, "0-b3 fix: note->chat DELETE failure -> no chat, note kept, clear failure");
  }
  {
    // Fix 3: unextractable amount stops the conversion, note untouched.
    const env = mkEnv0b(), s = mkS();
    await handleDailyText(env, mkO(s, "پیام یادداشت پنج", { interpreterCallFn: fakeInterp([act("note", { text: "یادداشت بدون مبلغ" })]) }));
    const changeBtn = btnData(s).find((d) => d.startsWith("interp:change:"));
    const s2 = mkS();
    await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: changeBtn, send: s2.send, editMarkup: async () => {}, chat: s2.chat, nowMs: NOW0b });
    const expBtn = btnData(s2).find((d) => d.startsWith("interp:type:expense:"));
    const s3 = mkS();
    await resolveInterpCallback(env, { fromId: 4242, chatId: 4242, data: expBtn, send: s3.send, editMarkup: async () => {}, chat: s3.chat, nowMs: NOW0b });
    check(String(s3.sent.at(-1)?.text ?? "").includes("قابل استخراج نیست") && !btnData(s3).some((d) => d.startsWith("daily:confirm:")) && rows0b("SELECT COUNT(*) AS n FROM notes WHERE text = 'یادداشت بدون مبلغ'")[0].n === 1, "0-b3 fix: unextractable amount stops conversion, note kept, no confirm");
  }
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
