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
  DEFAULT_INTERPRETER_MODEL,
  resolveInterpreterModel,
  extractJsonObject,
  classifyIntentNlu,
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
import { saveMessage, getLatestFileMessage, getChatMessages, listProjects, listProjectsResult, getProject, getMessageRow, insertTask, insertProject, listNotesResult, deleteNote, listOpenTasks, listOpenTasksResult, listDoneTasks, listDoneTasksResult, getTask, addProjectAlias, setTaskStatus, updateTaskFields, insertIntentFeedback, claimDueReminders, releaseReminderClaim, snoozeTaskReminder, purgeOldClosedTasks, saveVaultItem, listVaultItems, getVaultItem, deleteVaultItem, setVaultSyncStatus, saveVaultFile, listVaultFiles, getVaultFile, resolvePendingVaultFile, setFileSyncStatus, ensureVaultFilesTable, ensureVaultTable } from "../src/db.js";
import { encryptVaultValue, decryptVaultValue, isEncryptedVaultValue, getGoogleVaultConfig, googleVaultStatus, syncVaultItemToGoogle, syncVaultFileToGoogle, fetchVaultFromGoogle } from "../src/vault.js";
import {
  getChatContext,
  getSetting,
  setSetting,
  getDefaultCurrency,
  CHAT_CONTEXT_LIMIT,
  DEFAULT_CURRENCY,
} from "../src/memory.js";
import { iranDate, weekRange, monthRange, jalaliToGregorian, gregorianToJalali, formatJalali, parseRelativeDate, parseHour, parseReminder, extractFolderTag, resolveProjectName, matchKnownProjectAt, parseNoteQuery, parseSummaryQuery, parseDaypartReply, hasDaypartReply, mergeHourAmbiguousFollowup, stripMiddleFolderTag, normalizeDaypartToken } from "../src/daily.js";
import { callRouter, runCombo, resetRouterHealthForTests, getRouterHealthSnapshotForTests, extractAssistantText, extractFinalText, getComboTargets, classifyFailure, getEmptyFinalCounts, resetEmptyFinalCountsForTests } from "../src/router.js";
import { recordProviderCircuitFailure, recordProviderCircuitSuccess, getOpenProviderCircuits, recordVerifiedModel, getVerifiedLatencies } from "../src/circuit.js";
import { PROVIDERS } from "../src/providers.js";
import { sendProgressMessage, finalizeProgressMessage, splitTelegramText, escapeHtml, formatTelegramHtml, sendMessage, editMessage, sendDocument, sendPhoto, getFileDownloadData } from "../src/telegram.js";
import { answerChatText, adminApi, handleUpdate, resetSeenUpdateIdsForTests, CHAT_SYSTEM_PROMPT } from "../src/index.js";
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

// Phase 2-d: webhook updates carry globally unique, increasing ids in
// production, so the factories allocate a fresh id per update (the old
// fixed 1/2 collided with handleUpdate's update_id dedup: after the
// first scenario, every later scenario was ignored as a redelivery).
// No test posts the same update twice, so no assertion changes.
let nextTestUpdateId = 100000;
function msgUpdate(text, userId = 4242) {
  return {
    update_id: nextTestUpdateId++,
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
    update_id: nextTestUpdateId++,
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

    // 1-d-1 (intentional expectation upgrade, spec-required): free-text
    // dev is NEVER blocked by the /dev suggestion any more — it flows
    // to normal chat (here the mock combo fails, so the reply is the
    // chat failure notice, not the suggestion). It still never
    // dispatches and never stores a pending dev intent.
    // 1-d-5 (intentional expectation upgrade, spec-required): the chat
    // failure notice now names the failed stage (stage-specific notice).
    await sendTg(env, msgUpdate("add a /health endpoint to the worker"));
    check(world.calls.github.filter((c) => c.url.includes("/actions/workflows/")).length === 0, "free-text dev must not dispatch");
    // Phase 1-e Pillar 1 (intentional expectation upgrade, spec-required):
    // the chat failure notice is now DELIVERED by finalizing the ⏳
    // placeholder (editMessageText on the progress message), not by a
    // second sendMessage — so the delivered text is the last edit, with
    // the last sendMessage as the no-progress fallback.
    const devEdit = world.calls.telegram.filter((c) => c.method === "editMessageText").at(-1);
    const devMsg = devEdit ?? world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(!String(devMsg?.payload?.text ?? "").includes("با /dev بفرست"), "1-d-1: free-text dev must not get the /dev suggestion");
    check(String(devMsg?.payload?.text ?? "").includes("مرحله‌ی چت شکست خورد"), "1-d-1: free-text dev flows to the chat path");
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
try { DatabaseSync = (await import('node:sqlite').catch(() => ({}))).DatabaseSync; } catch { console.warn("\u26a0 node:sqlite در دسترس نیست \u2014 تست‌های ۱الف رد شد."); }
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
import { buildChatContext, mapQuestion, askText, ensureUserRow, handleDailyText, resolveDailyCallback, resolveInterpCallback, resolveTaskCallback, resolveNoteCallback, resolveQuickConvertCallback, resolveChatRetryCallback, resolveAskCallback, hourAmbiguousKeyboard, chatFailureNotice, formatFailureDetail, stripLeadingNotePunct, deriveNoteTitle, renderNoteList, renderTaskList, confirmExpenseDraft, runModelBranch, resolveProjects, CHAT_CONTEXT_CHAR_LIMIT, runReminderTick, quickConvertKeyboard, isUnambiguousQuestion, SUMMARY_SYSTEM, handleVaultFile, resolveVaultCallback, runNluBranch } from "../src/everyday.js";
import { markFailure, isModelHealthy } from "../src/health.js";
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
  sqlite.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
    // 1-b-3 (INTENDED BEHAVIOUR CHANGE, decision 2): a reminder is
    // stored as a task with the exact decision-2 reply; the legacy
    // reminders table gains no rows.
    check(String(s.sent.at(-1)?.text ?? "") === "⏰ یادآوری به‌عنوان تسک ذخیره شد.", `nine stores as task: ${JSON.stringify(s.sent.at(-1))}`);
    check(rows("SELECT remind_at, due_at FROM tasks ORDER BY id DESC LIMIT 1")[0].remind_at === "2026-10-28T09:00:00+03:30" && rows("SELECT due_at FROM tasks ORDER BY id DESC LIMIT 1")[0].due_at === null, "nine means 09:00 as task remind_at, due_at null");
    await handleDailyText(env, o(env, 4242, "یادم بنداز ساعت پنج تماس بگیر", { ...s, nowMs: NOW }));
    check(String(s.sent.at(-1)?.text ?? "").includes("صبح یا عصر"), "ساعت پنج also asks");
    await handleDailyText(env, o(env, 4242, "یادم بنداز که تمرین کنم", { ...s, nowMs: NOW }));
    check(String(s.sent.at(-1)?.text ?? "").includes("ساعت"), `no-time asks: ${JSON.stringify(s.sent.at(-1))}`);
    check(rows("SELECT COUNT(*) AS n FROM tasks")[0].n === 1 && rows("SELECT COUNT(*) AS n FROM reminders")[0].n === 0, "nine stored as task, ambiguous/no-time stored nothing more, zero legacy rows");
    await handleDailyText(env, o(env, 4242, "یادم بنداز فردا ساعت نه صبح تمرین", { ...s, nowMs: NOW }));
    check(String(s.sent.at(-1)?.text ?? "") === "⏰ یادآوری به‌عنوان تسک ذخیره شد.", `reminder task reply: ${JSON.stringify(s.sent.at(-1))}`);
    check(rows("SELECT COUNT(*) AS n FROM tasks")[0].n === 2 && rows("SELECT COUNT(*) AS n FROM reminders")[0].n === 0, "tomorrow reminder stored as second task, zero legacy rows");
    check(rows("SELECT remind_at FROM tasks ORDER BY id DESC LIMIT 1")[0].remind_at === "2026-10-29T09:00:00+03:30", `remind_at: ${JSON.stringify(rows("SELECT remind_at FROM tasks ORDER BY id DESC LIMIT 1"))}`);
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
       check(String(fileMsg?.payload?.text ?? "").includes("تصویر/فایل دریافت شد. چه کاری انجام دهم؟"), "file upload without caption shows choice buttons");
      check(rows("SELECT COUNT(*) AS n FROM vault_files WHERE tg_file_id = 'file-9'")[0].n === 1, "pending vault file row saved");
      check(rows("SELECT COUNT(*) AS n FROM messages WHERE tg_file_id = 'file-9'")[0].n === 0, "no messages row for vault upload");
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

// Voice API contract regressions run on Node 20 too (no SQLite required).
{
  const originalFetch = global.fetch, originalLog = console.log, originalWarn = console.warn;
  const env = { GEMINI_API_KEY: "voice-test-secret", GEMINI_VOICE_MODEL: "custom-voice-model" };
  let mode, calls, logs, deleted;
  const reset = (next) => { mode = next; calls = []; logs = []; deleted = 0; };
  console.log = console.warn = (...args) => logs.push(JSON.stringify(args));
  global.fetch = async (url, init) => {
    const u = new URL(url);
    check(u.origin === "https://generativelanguage.googleapis.com", "voice contract: only Google is contacted");
    check(!u.search, "voice contract: API key is never in URL");
    check(init.headers["x-goog-api-key"] === env.GEMINI_API_KEY, "voice contract: API key in header");
    if (init.method === "DELETE") { deleted++; return Response.json({}); }
    if (u.pathname === "/upload/v1beta/files") return Response.json({ file: { name: "files/contract" } });
    if (u.pathname === "/v1beta/files/contract") return Response.json({ state: "ACTIVE", uri: "https://generativelanguage.googleapis.com/v1beta/files/contract" });
    check(/^\/v1beta\/models\/[^/]+:generateContent$/.test(u.pathname), "voice contract: model-specific generateContent, not interactions");
    const body = JSON.parse(init.body);
    calls.push({ path: u.pathname, body });
    check(!("input" in body) && !("generation_config" in body), "voice contract: no Interactions-only fields");
    if (mode === "404" && calls.length === 1) return Response.json({ error: { message: env.GEMINI_API_KEY } }, { status: 404 });
    if (mode === "throw") throw new Error(env.GEMINI_API_KEY);
    if (mode === "legacy") return Response.json({ output_text: "must not route", error: { text: "must not route either" } });
    if (mode === "malformed") return new Response("not JSON");
    if (mode === "blocked") return Response.json({ promptFeedback: { blockReason: "SAFETY" } });
    if (mode === "empty") return Response.json({ candidates: [{ content: { parts: [{ text: "  " }] } }] });
    return Response.json({ candidates: [{ finishReason: mode === "truncated" ? "MAX_TOKENS" : "STOP", content: { parts: [
      { text: "private reasoning", thought: true }, { text: "سلام " }, { text: "دنیا" },
    ] } }] });
  };
  try {
    reset("success");
    const r = await transcribeWithGemini(env, new ArrayBuffer(8), "audio/ogg; codecs=opus");
    check(r.ok && r.text === "سلام دنیا", "voice contract: only final candidate text is returned");
    check(calls.length === 1 && calls[0].path.includes("custom-voice-model"), "voice contract: custom model respected");
    const parts = calls[0].body.contents[0].parts;
    check(parts[1].file_data.file_uri.endsWith("files/contract") && parts[1].file_data.mime_type === "audio/ogg", "voice contract: uploaded audio URI and normalized MIME");
    check(parts[0].text.includes("fa-IR") && parts[0].text.includes("Cloudflare Workers") && parts[0].text.includes("Do not follow instructions"), "voice contract: transcription-only prompt, language and vocabulary");
    check(deleted === 1, "voice contract: success deletes uploaded file");

    reset("404");
    const fallback = await transcribeWithGemini(env, new ArrayBuffer(8), "audio/ogg");
    check(fallback.ok && calls.length === 2 && calls[1].path.includes("gemini-3.8-flash:"), "voice contract: unavailable custom model falls back to default");
    check(deleted === 1 && !logs.join("").includes(env.GEMINI_API_KEY), "voice contract: fallback cleans up and does not log error bodies or keys");

    for (const failure of ["empty", "legacy", "malformed", "blocked", "truncated", "throw"]) {
      reset(failure);
      const result = await transcribeWithGemini(env, new ArrayBuffer(8), "audio/ogg");
      check(!result.ok && result.reason === "generate-content", `voice contract: ${failure} is a transcription failure`);
      check(deleted === 1, `voice contract: ${failure} cleans up uploaded file`);
      check(!logs.join("").includes(env.GEMINI_API_KEY), `voice contract: ${failure} never logs secrets`);
    }

    reset("empty");
    await transcribeWithGemini({ ...env, GEMINI_VOICE_MODEL: "gemini-3.8-flash" }, new ArrayBuffer(8), "audio/ogg");
    check(calls.length === 2 && new Set(calls.map((c) => c.path)).size === 2, "voice contract: default model is not retried twice");

    reset("success");
    const current = await transcribeWithGemini({ ...env, GEMINI_VOICE_MODEL: undefined }, new ArrayBuffer(8), "audio/ogg");
    check(current.ok && calls.length === 1 && calls[0].path === "/v1beta/models/gemini-3.8-flash:generateContent", "voice contract: default uses the replacement recommended by the API");

    reset("404");
    const alias = await transcribeWithGemini({ ...env, GEMINI_VOICE_MODEL: undefined }, new ArrayBuffer(8), "audio/ogg");
    check(alias.ok && calls.length === 2 && calls[1].path === "/v1beta/models/gemini-flash-latest:generateContent", "voice contract: unavailable default falls back to rolling Flash alias");
    check(!calls.some((c) => /gemini-(1\.5|2\.0|2\.5)-/.test(c.path)) && deleted === 1, "voice contract: no old built-in fallbacks; uploaded file cleaned up");

    reset("404");
    const retiredOverride = await transcribeWithGemini({ ...env, GEMINI_VOICE_MODEL: "gemini-2.5-flash" }, new ArrayBuffer(8), "audio/ogg");
    check(retiredOverride.ok && calls.length === 2 && calls[1].path.includes("gemini-3.8-flash:"), "voice contract: stale custom 2.5 model recovers using recommended replacement");
  } finally {
    global.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

// ── Voice input v1: Telegram voice -> Gemini generateContent -> plain-text path ──
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
  // Mock Telegram getFile/download + Google Files/generateContent, routed by URL.
  const mockVoiceFetch = (transcript, opts = {}) => {
    let googleCalls = 0; let generationBody = null; let deleted = false;
    global.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("generativelanguage.googleapis.com")) {
        googleCalls++;
        if (init?.method === "DELETE") { deleted = true; return { ok: true, json: async () => ({}) }; }
        if (u.includes("/upload/v1beta/files")) return { ok: true, json: async () => ({ file: { name: "files/abc" } }) };
        if (u.includes("/v1beta/files/abc")) return { ok: true, json: async () => ({ state: opts.pollState ?? "ACTIVE", uri: "https://example/audio" }) };
        if (u.includes(":generateContent")) {
          if (opts.failGeneration) throw new Error("boom");
          generationBody = JSON.parse(init.body);
          return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: transcript }] }, finishReason: "STOP" }] }) };
        }
        return { ok: true, json: async () => ({}) };
      }
      if (u.includes("/file/bot")) return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
      if (u.includes("api.telegram.org")) return { ok: true, json: async () => (opts.failGetFile ? { ok: false } : { ok: true, result: { file_path: "voice/file.ogg" } }) };
      throw new Error(`unexpected fetch: ${u}`);
    };
    return { googleCalls: () => googleCalls, generationBody: () => generationBody, deleted: () => deleted };
  };
  const voice = (duration = 42) => ({ file_id: "voice-1", duration, mime_type: "audio/ogg" });
  {
    const m = mockVoiceFetch("سلام دنیا");
    const r = await transcribeWithGemini(mkEnv(), new ArrayBuffer(8), "audio/ogg");
    const body = m.generationBody();
    check(r.ok === true && r.text === "سلام دنیا" && body?.contents?.[0]?.parts?.[0]?.text.includes("fa-IR") && body?.contents?.[0]?.parts?.[0]?.text.includes("Cloudflare Workers") && body?.contents?.[0]?.parts?.[1]?.file_data?.mime_type === "audio/ogg" && m.deleted() === true, "voice: generateContent returns text, Persian + vocab prompt, uploaded file deleted");
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
    const env = mkEnv(), s = fakeSend(); let routed = false; mockVoiceFetch("سلام", { failGeneration: true });
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
    const env = mkEnv(), s = fakeSend(); mockVoiceFetch("سلام", { failGeneration: true });
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
    const env = mkEnv(), s = fakeSend(); mockVoiceFetch("سلام", { failGeneration: true });
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

// ── Phase 1-e & Phase 2: zero-drop engine, NLU interpreter, disambiguation ──
// (Autonomous directive §4 — every case below is a directive case.
// Tests sit BEFORE the final enforced failure check, so failures report.)
// ── P4.1: telegram progress helpers + JSON extraction + model resolution ──
{
  check(JSON.stringify(splitTelegramText("a".repeat(5000))) === JSON.stringify(["a".repeat(4096), "a".repeat(904)]), "1-e: splitTelegramText slices at the 4096-char cap");
  check(JSON.stringify(splitTelegramText("")) === JSON.stringify([""]), "1-e: splitTelegramText of empty text is one empty chunk");
  check(await sendProgressMessage({}, 1) === null, "1-e: sendProgressMessage without TG_TOKEN returns null and never fetches");
  {
    const calls = [];
    const prev = global.fetch;
    global.fetch = async (url, init = {}) => {
      const m = /\/bot[^/]+\/(\w+)$/.exec(String(url));
      let payload = {};
      try { payload = JSON.parse(String(init.body ?? "{}")); } catch {}
      calls.push({ method: m ? m[1] : "", payload });
      if (m?.[1] === "sendMessage") return Response.json({ ok: true, result: { message_id: 99 } });
      if (m?.[1] === "editMessageText") return Response.json({ ok: true, result: true });
      return Response.json({ ok: true, result: true });
    };
    try {
      const env = { TG_TOKEN: "x" };
      const id = await sendProgressMessage(env, 7);
      check(id === 99, "1-e: sendProgressMessage returns the numeric message_id");
      await finalizeProgressMessage(env, 7, id, "hello", { replyMarkup: { inline_keyboard: [[{ text: "b", callback_data: "x" }]] } });
      const edit = calls.find((c) => c.method === "editMessageText");
      check(edit?.payload?.message_id === 99 && edit?.payload?.text === "hello" && JSON.stringify(edit?.payload?.reply_markup) === JSON.stringify({ inline_keyboard: [[{ text: "b", callback_data: "x" }]] }), "1-e: finalizeProgressMessage edits the exact progress message_id with markup on the single chunk");
      calls.length = 0;
      await finalizeProgressMessage(env, 7, id, "z".repeat(5000), {});
      const edit2 = calls.find((c) => c.method === "editMessageText");
      const sends = calls.filter((c) => c.method === "sendMessage");
      check(edit2?.payload?.text?.length === 4096 && sends.length === 1 && sends[0].payload.text.length === 904, "1-e: finalizeProgressMessage edits the first chunk and sends the rest sequentially");
    } finally { global.fetch = prev; }
  }
  {
    const calls = [];
    const prev = global.fetch;
    global.fetch = async (url, init = {}) => {
      const m = /\/bot[^/]+\/(\w+)$/.exec(String(url));
      let payload = {};
      try { payload = JSON.parse(String(init.body ?? "{}")); } catch {}
      calls.push({ method: m ? m[1] : "", payload });
      if (m?.[1] === "sendMessage") return Response.json({ ok: true, result: { message_id: 5 } });
      if (m?.[1] === "editMessageText") return Response.json({ ok: false, description: "gone" });
      return Response.json({ ok: true, result: true });
    };
    try {
      const env = { TG_TOKEN: "x" };
      const id = await sendProgressMessage(env, 7, "⏳ در حال پردازش...");
      await finalizeProgressMessage(env, 7, id, "fallback answer", {});
      const sends = calls.filter((c) => c.method === "sendMessage");
      check(sends.length === 2 && sends[1].payload.text === "fallback answer", "1-e: finalizeProgressMessage falls back to sendMessage when the edit returns { ok: false }");
      await finalizeProgressMessage(env, 7, null, "no-id answer", {});
      check(calls.filter((c) => c.method === "sendMessage").at(-1)?.payload?.text === "no-id answer", "1-e: finalizeProgressMessage without a progress id sends plainly");
    } finally { global.fetch = prev; }
  }
  check(JSON.stringify(extractJsonObject("<think>reasoning {\"x\":1}</think>\n```json\n{\"intent\":\"note\",\"confidence\":0.9}\n```")) === JSON.stringify({ intent: "note", confidence: 0.9 }), "1-e: extractJsonObject strips closed <think> blocks and ```json fences");
  check(JSON.stringify(extractJsonObject("```\n{\"intent\":\"task\",\"confidence\":0.8}\n```")) === JSON.stringify({ intent: "task", confidence: 0.8 }), "1-e: extractJsonObject strips bare fences");
  check(JSON.stringify(extractJsonObject("pre {\"intent\":\"note\",\"body\":\"a {b} c\"} post")) === JSON.stringify({ intent: "note", body: "a {b} c" }), "1-e: extractJsonObject parses the first balanced object, braces inside strings ignored");
  {
    check(escapeHtml("<b>&") === "&lt;b&gt;&amp;", "3-a: escapeHtml escapes &, <, >");
    check(
      formatTelegramHtml("**bold** `<x>`\n```js\nconst a = 1 < 2;\n```") === "<b>bold</b> <code>&lt;x&gt;</code>\n<pre>const a = 1 &lt; 2;</pre>",
      "3-a: formatTelegramHtml escapes HTML and converts the supported markdown subset",
    );
    check(formatTelegramHtml("plain text") === "plain text", "3-a: formatTelegramHtml leaves plain text unchanged");
    const calls = [];
    const prev = global.fetch;
    global.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = /\/bot[^/]+\/(\w+)$/.exec(u);
      calls.push({ url: u, method: m?.[1] ?? "", body: init.body });
      if (m?.[1] === "sendMessage" && calls.filter((c) => c.method === "sendMessage").length === 1) {
        return Response.json({ ok: false, description: "can't parse entities" });
      }
      if (m?.[1] === "getFile") return Response.json({ ok: true, result: { file_path: "docs/x.txt" } });
      if (u.includes("/file/bot")) return new Response("hello", { headers: { "content-type": "text/plain" } });
      return Response.json({ ok: true, result: { message_id: 1 } });
    };
    try {
      const env = { TG_TOKEN: "x" };
      await sendMessage(env, 1, "**bold**");
      const sends = calls.filter((c) => c.method === "sendMessage");
      const first = JSON.parse(String(sends[0]?.body ?? "{}"));
      const second = JSON.parse(String(sends[1]?.body ?? "{}"));
      check(
        sends.length === 2 && first.parse_mode === "HTML" && first.text === "<b>bold</b>" && second.text === "**bold**" && second.parse_mode === undefined,
        "3-a: sendMessage retries plain text when Telegram rejects HTML",
      );
      calls.length = 0;
      await editMessage(env, 1, 9, "**bold**");
      const edit = JSON.parse(String(calls[0]?.body ?? "{}"));
      check(calls[0]?.method === "editMessageText" && edit.message_id === 9 && edit.parse_mode === "HTML", "3-a: editMessage sends HTML with the message_id");
      calls.length = 0;
      await sendDocument(env, 1, "a.txt", new TextEncoder().encode("hi"), { caption: "c" });
      const doc = calls[0]?.body;
      check(calls[0]?.method === "sendDocument" && doc?.get("chat_id") === "1" && doc?.get("document")?.name === "a.txt" && doc?.get("caption") === "c", "3-a: sendDocument posts multipart form data");
      calls.length = 0;
      await sendPhoto(env, 1, "p.jpg", new Uint8Array([1, 2]), {});
      const photo = calls[0]?.body;
      check(calls[0]?.method === "sendPhoto" && photo?.get("photo")?.name === "p.jpg", "3-a: sendPhoto posts multipart form data");
      calls.length = 0;
      const file = await getFileDownloadData(env, "f1");
      check(
        file?.filePath === "docs/x.txt" && file?.contentType === "text/plain" && new TextDecoder().decode(file?.data) === "hello",
        "3-a: getFileDownloadData resolves file_path then downloads the bytes",
      );
    } finally { global.fetch = prev; }
  }
  check(extractJsonObject("just prose, no json") === null && extractJsonObject("<think>unclosed, nothing after") === null, "1-e: extractJsonObject returns null when no object exists");
  check(DEFAULT_INTERPRETER_MODEL === "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "1-e: DEFAULT_INTERPRETER_MODEL is the directive model");
  check(resolveInterpreterModel({ INTERPRETER_MODEL: "off", AI: { run() {} } }) === null, "1-e: resolveInterpreterModel off disables");
  check(resolveInterpreterModel({ INTERPRETER_MODEL: "none", AI: { run() {} } }) === null, "1-e: resolveInterpreterModel none disables");
  check(resolveInterpreterModel({ INTERPRETER_MODEL: "  @cf/foo  ", AI: { run() {} } }) === "@cf/foo", "1-e: resolveInterpreterModel trims an explicit model");
  check(resolveInterpreterModel({ AI: { run() {} } }) === DEFAULT_INTERPRETER_MODEL, "1-e: resolveInterpreterModel defaults to Workers AI when the binding exists and INTERPRETER_MODEL is unset");
  check(resolveInterpreterModel({}) === null, "1-e: resolveInterpreterModel is null without a binding or setting");
  check(normalizeDaypartToken("صبخ") === "صبح" && normalizeDaypartToken("واسه صبح") === "صبح" && normalizeDaypartToken("برای عصر") === "عصر" && normalizeDaypartToken("عصری") === "عصر" && normalizeDaypartToken("ظهر") === "عصر" && normalizeDaypartToken("شبی") === "شب" && normalizeDaypartToken("کنسل") === "cancel" && normalizeDaypartToken("انصراف") === "cancel" && normalizeDaypartToken("نیمه") === null, "1-e: normalizeDaypartToken maps the full typo/phrase map");
  check(JSON.stringify(hourAmbiguousKeyboard()) === JSON.stringify([[{ text: "☀️ صبح", callback_data: "ask:dp:صبح" }, { text: "🌇 عصر", callback_data: "ask:dp:عصر" }], [{ text: "❌ انصراف", callback_data: "ask:cancel" }]]), "1-e: hourAmbiguousKeyboard is exactly the directive keyboard");
  {
    const rows = [
      { role: "user", content: "سلام" },
      { role: "assistant", content: "✅ **یادداشت جدید: سیمان و گچ" },
      { role: "assistant", content: "✅ یادداشت ذخیره شد." },
      { role: "assistant", content: "⏰ یادآوری ثبت شد." },
      { role: "assistant", content: "این یک جواب واقعی است." },
    ];
    const ctxRows = buildChatContext(rows);
    check(ctxRows.length === 2 && ctxRows[0].content === "سلام" && ctxRows[1].content === "این یک جواب واقعی است.", "1-e: buildChatContext excludes fake ✅/⏰ confirmation headers from history");
  }
  {
    const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
    const cl = (s) => classifyDaily(s, { nowMs: NOW });
    check(cl("یادداشت کن که خرید نان").intent === "note" && cl("یادداشت کن که خرید نان").text === "خرید نان", "1-e: natural note strips که from the body");
    check(cl("اینو یادداشت کن قرارداد را بررسی کن").intent === "note" && cl("بنویس توی یادداشت‌هام خرید نان").intent === "note", "1-e: natural note اینو/بنویس forms");
    check(cl("یه تسک بذار ادیت ویدیوی جدید").intent === "task-create" && cl("یه تسک بذار ادیت ویدیوی جدید").text === "ادیت ویدیوی جدید", "1-e: natural task form without a colon");
    check(cl("یه خلاصه از یادداشت‌هام بده").intent === "summary" && cl("یه خلاصه از یادداشت‌هام بده").kind === "note", "1-e: flexible note summary without a trailing verb");
    check(cl("تسک‌هام رو جدول کن").intent !== "summary", "1-e: bare task form stays excluded from summaries (1-d-4 pin preserved)");
  }
}
// ── P4.1: router timeout contract ──
{
  const hungFetch = async (url, init = {}) => new Promise((_, rej) => { init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); });
  const prev = global.fetch;
  try {
    global.fetch = hungFetch;
    const env = { STATE: fakeKV(), XKIRO_API_KEY: "k" };
    const t0 = Date.now();
    const r = await callRouter(env, "xkiro/test-model", { messages: [{ role: "user", content: "hi" }] }, { attemptTimeoutMs: 200, totalTimeoutMs: 20000 });
    const elapsed = Date.now() - t0;
    check(r.ok === false && r.text === "" && r.model === null && r.error === "timeout" && elapsed < 5000, `1-e: hung fetch in callRouter aborts within budget returning { ok: false, error: timeout } (elapsed ${elapsed}ms)`);
    const r2 = await runCombo(env, "xkiro/test-model", { messages: [{ role: "user", content: "hi" }] }, { attemptTimeoutMs: 200, totalTimeoutMs: 20000 });
    check(r2.ok === false && Array.isArray(r2.errors) && r2.errors[0]?.reason === "timeout", "1-e: runCombo keeps its established { ok: false, errors } shape on timeout");
    const t1 = Date.now();
    const r3 = await callRouter(env, "xkiro/test-model", { messages: [{ role: "user", content: "hi" }] }, { attemptTimeoutMs: 200, totalTimeoutMs: 1000 });
    check(r3.ok === false && r3.error === "timeout" && Date.now() - t1 < 1500, "1-e: a total budget under the 1500ms floor stops before any attempt");
  } finally { global.fetch = prev; }
  {
    const prev2 = global.fetch;
    global.fetch = async (url) => String(url).includes("api.xkiro.com") ? Response.json({ choices: [{ message: { content: "hello back" } }] }) : new Response("unexpected", { status: 500 });
    try {
      const env = { STATE: fakeKV(), XKIRO_API_KEY: "k" };
      const r = await callRouter(env, "xkiro/test-model", { messages: [{ role: "user", content: "hi" }] }, {});
      check(r.ok === true && r.text === "hello back" && r.model === "xkiro/test-model" && r.error === null, "1-e: callRouter returns text + model on success");
    } finally { global.fetch = prev2; }
  }
}

// ── P4.1: answerChatText sends ⏳ and finalizes that exact message ──
if (DatabaseSync) {
  const freshChat = () => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
    const base = (sql) => { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
    return { sq, db: { prepare(sql) { return base(sql); } } };
  };
  const tgStub = (calls, msgId) => async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://api.telegram.org/")) {
      const m = /\/bot[^/]+\/(\w+)$/.exec(u);
      let payload = {};
      try { payload = JSON.parse(String(init.body ?? "{}")); } catch {}
      calls.push({ method: m ? m[1] : "", payload });
      return Response.json({ ok: true, result: { message_id: msgId } });
    }
    return Response.json({ choices: [{ message: { content: "سلام! این جواب است." } }] });
  };
  // Failure: no provider keys -> stage notice finalizes the ⏳ message.
  {
    const { db } = freshChat();
    const calls = [];
    const prev = global.fetch;
    global.fetch = tgStub(calls, 99);
    try {
      await answerChatText({ STATE: fakeKV(), DB: db, TG_TOKEN: "x", ALLOWED_TG_IDS: "1" }, 1, 1, "سلام", false, { saveText: "", retryEntryId: 42, quickConvertId: 42 });
    } finally { global.fetch = prev; }
    const send = calls.find((c) => c.method === "sendMessage");
    const edit = calls.find((c) => c.method === "editMessageText");
    check(send?.payload?.text === "⏳ در حال پردازش...", "1-e: answerChatText sends the ⏳ placeholder first");
    check(edit?.payload?.message_id === 99 && String(edit?.payload?.text ?? "").includes("مرحله‌ی چت شکست خورد"), "1-e: answerChatText failure edits that exact progress message_id with the stage notice");
    const kb = edit?.payload?.reply_markup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
    check(kb.includes("chat:retry:42") && kb.includes("qconv:note:42") && kb.includes("qconv:task:42"), "1-e: answerChatText failure notice carries retry + quick-convert buttons on the edit");
  }
  // Success: seeded catalog + key -> the answer edits the same message.
  {
    const { db } = freshChat();
    const calls = [];
    const prev = global.fetch;
    global.fetch = tgStub(calls, 99);
    try {
      const kv = fakeKV();
      await kv.put("catalog:xkiro", JSON.stringify({ models: [{ id: "qwen3-32b", provider: "xkiro", context: 131072 }] }));
      await answerChatText({ STATE: kv, DB: db, TG_TOKEN: "x", ALLOWED_TG_IDS: "1", XKIRO_API_KEY: "k" }, 1, 1, "سلام", false, { saveText: "" });
    } finally { global.fetch = prev; }
    const edit = calls.find((c) => c.method === "editMessageText");
    check(edit?.payload?.message_id === 99 && edit?.payload?.text === "سلام! این جواب است.", "1-e: answerChatText success edits the exact ⏳ message_id with the answer");
    check(calls.filter((c) => c.method === "sendMessage").length === 1, "1-e: answerChatText success sends no second message");
  }
  // Caller-sent progress id is reused, not replaced.
  {
    const { db } = freshChat();
    const calls = [];
    const prev = global.fetch;
    global.fetch = tgStub(calls, 77);
    try {
      await answerChatText({ STATE: fakeKV(), DB: db, TG_TOKEN: "x", ALLOWED_TG_IDS: "1" }, 1, 1, "سلام", false, { saveText: "", progressMsgId: 1234, retryEntryId: 42, quickConvertId: 42 });
    } finally { global.fetch = prev; }
    check(!calls.some((c) => c.method === "sendMessage" && c.payload?.text === "⏳ در حال پردازش..."), "1-e: answerChatText with opts.progressMsgId sends no second ⏳");
    const edit = calls.find((c) => c.method === "editMessageText");
    check(edit?.payload?.message_id === 1234, "1-e: answerChatText finalizes the caller-supplied progressMsgId");
  }
}

// ── P4.2/P4.3: disambiguation + NLU interpreter, end to end ──
if (DatabaseSync) {
  const fresh1e = () => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
    const base = (sql) => { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
    return { sq, db: { prepare(sql) { return base(sql); } }, rows: (sql, params = []) => sq.prepare(sql).all(...params) };
  };
  const seedProjE = (sq, uid, name, aliases = [], isDefault = 0) => { sq.prepare("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (?, ?, ?, 'active', ?, '2026-10-01T00:00:00.000Z')").run(uid, name, JSON.stringify(aliases), isDefault); return sq.prepare("SELECT id FROM projects WHERE user_id = ? AND name = ?").all(uid, name)[0].id; };
  const mkSE = () => { const sent = []; const chats = []; const edits = []; return { sent, chats, edits, send: async (t, opts) => { sent.push({ text: t, opts }); }, chat: async (t, copts) => { chats.push({ text: t, opts: copts }); }, editMarkup: async () => { edits.push(1); } }; };
  const convoE = (sc, extraEnv = {}) => { const s = mkSE(); const env = { STATE: fakeKV(), DB: sc.db, ...extraEnv }; const say = async (text, nowMs) => handleDailyText(env, { chatId: 1, userId: 1, text, send: s.send, chat: s.chat, editMarkup: s.editMarkup, nowMs }); const slot = async () => env.STATE.get("daily:pending-ask:1", "json"); return { s, env, say, slot }; };
  const tapE = (c, data, nowMs) => resolveAskCallback(c.env, { fromId: 1, chatId: 1, data, nowMs, send: c.s.send, editMarkup: c.s.editMarkup });
  const MORNING = Date.UTC(2026, 9, 28, 5, 0, 0); // 08:30 Tehran
  const REM_TOMORROW = "یادآوری کن فردا ساعت ۰۳:۳۰ تست یادآور";
  const aiJson = (obj) => ({ run: async () => ({ response: JSON.stringify(obj) }) });
  const askKb = (sentEntry) => sentEntry?.opts?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
  // P4.2a: the ask carries the exact ☀️/🌇/❌ buttons.
  {
    const sc = fresh1e(); const c = convoE(sc);
    await c.say(REM_TOMORROW, MORNING);
    const last = c.s.sent.at(-1);
    const kb = askKb(last);
    check(last?.text === "ساعت را با صبح یا عصر مشخص کن." && kb.includes("ask:dp:صبح") && kb.includes("ask:dp:عصر") && kb.includes("ask:cancel"), "1-e: hour-ambiguous ask sends WITH ask:dp:صبح/عصر/cancel buttons");
    check((await c.slot())?.kind === "hour-ambiguous", "1-e: hour-ambiguous slot stored");
  }
  // P4.2b: صبخ resolves to 03:30 tomorrow + D1 save, never chat.
  {
    const sc = fresh1e(); const c = convoE(sc);
    await c.say(REM_TOMORROW, MORNING);
    const r = await c.say("صبخ", MORNING);
    const task = sc.rows("SELECT title, remind_at FROM tasks WHERE user_id = 1 ORDER BY id DESC LIMIT 1")[0];
    check(r === "handled" && task?.title === "تست یادآور" && task?.remind_at === "2026-10-29T03:30:00+03:30" && c.s.chats.length === 0 && (await c.slot()) === null, "1-e: صبخ resolves to 03:30 tomorrow + D1 save, never chat, typo stripped from title");
  }
  // P4.2c: ask:dp:عصر tap resolves 15:30 tomorrow + D1 save + slot cleared + markup removed.
  {
    const sc = fresh1e(); const c = convoE(sc);
    await c.say(REM_TOMORROW, MORNING);
    await tapE(c, "ask:dp:عصر", MORNING);
    const task = sc.rows("SELECT title, remind_at FROM tasks WHERE user_id = 1 ORDER BY id DESC LIMIT 1")[0];
    check(task?.remind_at === "2026-10-29T15:30:00+03:30" && c.s.sent.at(-1)?.text === "⏰ یادآوری به‌عنوان تسک ذخیره شد." && (await c.slot()) === null && c.s.edits.length === 1, "1-e: ask:dp:عصر tap resolves 15:30 tomorrow + D1 save + slot cleared + keyboard removed");
  }
  // P4.2d: ask:cancel tap clears + confirms cancellation.
  {
    const sc = fresh1e(); const c = convoE(sc);
    await c.say(REM_TOMORROW, MORNING);
    await tapE(c, "ask:cancel", MORNING);
    check(c.s.sent.at(-1)?.text === "❌ یادآوری لغو شد." && (await c.slot()) === null && sc.rows("SELECT id FROM tasks WHERE user_id = 1").length === 0, "1-e: ask:cancel tap clears + ❌ یادآوری لغو شد., no task stored");
  }
  // P4.2e: انصراف reply clears + confirms cancellation, never chat.
  {
    const sc = fresh1e(); const c = convoE(sc);
    await c.say(REM_TOMORROW, MORNING);
    const r = await c.say("انصراف", MORNING);
    check(r === "handled" && c.s.sent.at(-1)?.text === "❌ یادآوری لغو شد." && (await c.slot()) === null && c.s.chats.length === 0, "1-e: انصراف reply clears + ❌ یادآوری لغو شد., never chat");
  }
  // P4.2f: a real question while hour-ambiguous clears the slot and answers in chat.
  {
    const sc = fresh1e(); const c = convoE(sc);
    await c.say(REM_TOMORROW, MORNING);
    const n = c.s.sent.length;
    const r = await c.say("تفاوت Cloudflare D1 و KV چیه و کدوم برای ذخیره پیام‌ها بهتره؟", MORNING);
    check(r === "chat" && c.s.sent.length === n && (await c.slot()) === null, "1-e: real question while hour-ambiguous clears pending_ask and routes to chat");
  }
  // P4.2g: short unknown token holds the slot + buttons, then عصر still resolves.
  {
    const sc = fresh1e(); const c = convoE(sc);
    await c.say(REM_TOMORROW, MORNING);
    const r = await c.say("xyz", MORNING);
    const held = c.s.sent.at(-1);
    check(r === "handled" && String(held?.text ?? "").startsWith("متوجه نشدم؛") && askKb(held).includes("ask:dp:صبح") && (await c.slot())?.kind === "hour-ambiguous" && c.s.chats.length === 0, "1-e: short unknown token holds pending_ask + re-asks with buttons, never chat");
    await c.say("عصر", MORNING);
    const task = sc.rows("SELECT title, remind_at FROM tasks WHERE user_id = 1 ORDER BY id DESC LIMIT 1")[0];
    check(task?.remind_at === "2026-10-29T15:30:00+03:30" && (await c.slot()) === null, "1-e: held slot still resolves on the next daypart reply");
  }
  // P4.2h: short token consults the NLU first when the AI binding exists.
  {
    const sc = fresh1e(); const c = convoE(sc, { AI: aiJson({ intent: "daypart_reply", confidence: 0.9, daypart: "عصر" }) });
    await c.say(REM_TOMORROW, MORNING);
    await c.say("xyzq", MORNING);
    const task = sc.rows("SELECT title, remind_at FROM tasks WHERE user_id = 1 ORDER BY id DESC LIMIT 1")[0];
    check(task?.remind_at === "2026-10-29T15:30:00+03:30" && (await c.slot()) === null, "1-e: short token resolved by the NLU daypart_reply instead of holding");
  }
  // P4.3a: NLU note — natural tag-free sentence, INTERPRETER_MODEL unset, project resolved + badge.
  {
    const sc = fresh1e(); const gol = seedProjE(sc.sq, 1, "گلبهار", ["گل"]); seedProjE(sc.sq, 1, "عمومی", [], 1);
    const c = convoE(sc, { AI: aiJson({ intent: "note", confidence: 0.92, project: "گلبهار", body: "سیمان و گچ فردا صبح تحویل گرفته میشه" }) });
    const r = await c.say("فردا سیمان و گچ برای پروژه گلبهار تحویل گرفته میشه", MORNING);
    const note = sc.rows("SELECT text, project_id FROM notes WHERE user_id = 1 ORDER BY id DESC LIMIT 1")[0];
    check(r === "handled" && note?.text === "سیمان و گچ فردا صبح تحویل گرفته میشه" && note?.project_id === gol && c.s.sent.at(-1)?.text === "✅ یادداشت ذخیره شد. [📁 گلبهار]", "1-e: NLU note saves to گلبهار with [📁 گلبهار] reply, INTERPRETER_MODEL unset");
  }
  // 2-l: the NLU branch still activates when INTERPRETER_MODEL is set
  // (production sets it) as long as the Workers AI binding exists and no
  // legacy interpreterCallFn/interpreterModel is supplied on the call.
  {
    const sc = fresh1e(); const gol = seedProjE(sc.sq, 1, "گلبهار", ["گل"]); seedProjE(sc.sq, 1, "عمومی", [], 1);
    const c = convoE(sc, { AI: aiJson({ intent: "note", confidence: 0.92, project: "گلبهار", body: "سیمان و گچ فردا صبح تحویل گرفته میشه" }), INTERPRETER_MODEL: DEFAULT_INTERPRETER_MODEL });
    const r = await c.say("فردا سیمان و گچ برای پروژه گلبهار تحویل گرفته میشه", MORNING);
    const note = sc.rows("SELECT text, project_id FROM notes WHERE user_id = 1 ORDER BY id DESC LIMIT 1")[0];
    check(r === "handled" && note?.text === "سیمان و گچ فردا صبح تحویل گرفته میشه" && note?.project_id === gol, "2-l: NLU handles a note even when INTERPRETER_MODEL is set and the AI binding exists");
  }
  // P4.3b: NLU task — natural tag-free sentence, project یوتیوب.
  {
    const sc = fresh1e(); const yt = seedProjE(sc.sq, 1, "یوتیوب", []); seedProjE(sc.sq, 1, "عمومی", [], 1);
    const c = convoE(sc, { AI: aiJson({ intent: "task", confidence: 0.9, project: "یوتیوب", body: "ادیت ویدیوی جدید" }) });
    const r = await c.say("یه تسک برای پروژه یوتیوب بذار ادیت ویدیوی جدید", MORNING);
    const task = sc.rows("SELECT title, project_id FROM tasks WHERE user_id = 1 ORDER BY id DESC LIMIT 1")[0];
    check(r === "handled" && task?.title === "ادیت ویدیوی جدید" && task?.project_id === yt && c.s.sent.at(-1)?.text === "✅ تسک ثبت شد. [📁 یوتیوب]", "1-e: NLU task saves to یوتیوب with [📁 یوتیوب] reply");
  }
  // P4.3c: NLU reminder — deterministic re-parse decides the due time.
  {
    const sc = fresh1e(); seedProjE(sc.sq, 1, "عمومی", [], 1);
    const c = convoE(sc, { AI: aiJson({ intent: "reminder", confidence: 0.91, body: "به علی زنگ بزنم", date_ref: "فردا", time_ref: "5", daypart: "عصر" }) });
    const r = await c.say("فردا ساعت ۵ عصر به علی زنگ بزنم", MORNING);
    const task = sc.rows("SELECT title, remind_at FROM tasks WHERE user_id = 1 ORDER BY id DESC LIMIT 1")[0];
    check(r === "handled" && task?.title === "به علی زنگ بزنم" && task?.remind_at === "2026-10-29T17:00:00+03:30", "1-e: NLU reminder re-parsed deterministically to tomorrow 17:00");
  }
  // P4.3d: NLU reminder without a daypart asks WITH buttons.
  {
    const sc = fresh1e(); seedProjE(sc.sq, 1, "عمومی", [], 1);
    const c = convoE(sc, { AI: aiJson({ intent: "reminder", confidence: 0.88, body: "به علی زنگ بزنم", date_ref: "فردا", time_ref: "5", daypart: null }) });
    await c.say("فردا ساعت ۵ به علی زنگ بزنم", MORNING);
    const last = c.s.sent.at(-1);
    const slot = await c.slot();
    check(last?.text === "ساعت را با صبح یا عصر مشخص کن." && askKb(last).includes("ask:dp:صبح") && slot?.kind === "hour-ambiguous", "1-e: NLU hour-ambiguous reminder asks WITH buttons");
  }
  // P4.3e: NLU summary routes to the verified D1 handler (2200 tokens).
  {
    const sc = fresh1e(); const yt = seedProjE(sc.sq, 1, "یوتیوب", []); seedProjE(sc.sq, 1, "عمومی", [], 1);
    sc.sq.prepare("INSERT INTO tasks (user_id, title, status, project_id, created_at) VALUES (1, 'ادیت ویدیو', 'open', ?, '2026-10-28T00:00:00.000Z')").run(yt);
    const c = convoE(sc, { AI: aiJson({ intent: "summary", confidence: 0.9, project: "یوتیوب", summary_target: "tasks" }) });
    const r = await c.say("تسک‌های یوتیوب رو برام جمع‌بندی کن", MORNING);
    check(r === "handled" && c.s.chats.length === 1 && c.s.chats[0].opts.maxTokens === 2200 && c.s.chats[0].text.includes("ادیت ویدیو"), "1-e: NLU summary routes to the verified D1 handler with 2200 tokens (Phase 2-f: 900 -> 2200 reasoning-model headroom)");
  }
  // P4.3f: NLU expense executes ONLY on a deterministic integer amount (draft, never a direct insert).
  {
    const sc = fresh1e(); seedProjE(sc.sq, 1, "عمومی", [], 1);
    const c = convoE(sc, { AI: aiJson({ intent: "expense", confidence: 0.9 }) });
    await c.say("برای نون ۵۰۰ تومان دادم", MORNING);
    const draftKeys = [...c.env.STATE.store.keys()].filter((k) => k.startsWith("daily:draft:"));
    check(draftKeys.length === 1 && String(c.s.sent.at(-1)?.text ?? "").includes("💰 خرج: 500") && sc.rows("SELECT id FROM expenses WHERE user_id = 1").length === 0, "1-e: NLU expense creates the 10-minute confirm draft on a deterministic amount, no direct insert");
  }
  // P4.3g: NLU expense with no deterministic amount falls through to chat — the model number is never trusted.
  {
    const sc = fresh1e(); seedProjE(sc.sq, 1, "عمومی", [], 1);
    const c = convoE(sc, { AI: aiJson({ intent: "expense", confidence: 0.95, body: "خرید بزرگ" }) });
    const r = await c.say("یه خرج داشتم", MORNING);
    const draftKeys = [...c.env.STATE.store.keys()].filter((k) => k.startsWith("daily:draft:"));
    check(r === "chat" && draftKeys.length === 0 && c.s.sent.length === 0, "1-e: NLU expense without a deterministic amount falls through to chat, no draft");
  }
  // P4.3h: low confidence falls through to chat, nothing stored.
  {
    const sc = fresh1e(); seedProjE(sc.sq, 1, "عمومی", [], 1);
    const c = convoE(sc, { AI: aiJson({ intent: "note", confidence: 0.4, body: "چیزی" }) });
    const r = await c.say("فردا سیمان و گچ برای پروژه گلبهار تحویل گرفته میشه", MORNING);
    check(r === "chat" && sc.rows("SELECT id FROM notes WHERE user_id = 1").length === 0, "1-e: NLU confidence < 0.75 falls through to chat, nothing stored");
  }
  // P4.3i: AI timeout falls through to chat without dropping (direct unit: fast timeoutMs; integration: full 4500ms race).
  {
    const fast = await classifyIntentNlu({ AI: { run: () => new Promise(() => {}) } }, "hi", {}, { timeoutMs: 50 });
    check(fast.ok === false && fast.reason === "timeout", "1-e: classifyIntentNlu times out cleanly with { ok: false, reason: timeout }");
    const sc = fresh1e(); seedProjE(sc.sq, 1, "عمومی", [], 1);
    const c = convoE(sc, { AI: { run: () => new Promise(() => {}) } });
    const t0 = Date.now();
    const r = await c.say("فردا سیمان و گچ برای پروژه گلبهار تحویل گرفته میشه", MORNING);
    check(r === "chat" && Date.now() - t0 >= 4400 && sc.rows("SELECT id FROM notes WHERE user_id = 1").length === 0, "1-e: hanging AI.run falls through to chat after the 4500ms race, nothing dropped");
  }
  // P4.3j: <think>/fenced interpreter output parses cleanly through the NLU path.
  {
    const sc = fresh1e(); const gol = seedProjE(sc.sq, 1, "گلبهار", ["گل"]); seedProjE(sc.sq, 1, "عمومی", [], 1);
    const c = convoE(sc, { AI: { run: async () => ({ response: "<think>reasoning</think>\n```json\n{\"intent\":\"note\",\"confidence\":0.93,\"project\":\"گلبهار\",\"body\":\"سیمان و گچ\"}\n```" }) } });
    const r = await c.say("فردا سیمان و گچ برای پروژه گلبهار تحویل گرفته میشه", MORNING);
    const note = sc.rows("SELECT text, project_id FROM notes WHERE user_id = 1 ORDER BY id DESC LIMIT 1")[0];
    check(r === "handled" && note?.text === "سیمان و گچ" && note?.project_id === gol, "1-e: <think>-wrapped + fenced NLU output parses and executes");
  }
  // P4.1 (summary side): rows verified -> ⏳ summary placeholder sent, id plumbed to o.chat, 2200 tokens.
  {
    const sc = fresh1e(); const gol = seedProjE(sc.sq, 1, "گلبهار", ["گل"]); seedProjE(sc.sq, 1, "عمومی", [], 1);
    sc.sq.prepare("INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (1, 'صبحانه گلبهار', 'text', '2026-10-28T01:24:00+03:30', ?)").run(gol);
    const tgCalls = [];
    const prev = global.fetch;
    global.fetch = async (url, init = {}) => {
      const m = /\/bot[^/]+\/(\w+)$/.exec(String(url));
      let payload = {};
      try { payload = JSON.parse(String(init.body ?? "{}")); } catch {}
      tgCalls.push({ method: m ? m[1] : "", payload });
      return Response.json({ ok: true, result: { message_id: 555 } });
    };
    try {
      const c = convoE(sc, { TG_TOKEN: "x" });
      await c.say("یادداشت‌های گلبهار رو خلاصه کن", MORNING);
      const prog = tgCalls.find((x) => x.method === "sendMessage");
      check(prog?.payload?.text === "⏳ در حال آماده‌سازی خلاصه و جدول..." && c.s.chats.length === 1 && c.s.chats[0].opts.progressMsgId === 555 && c.s.chats[0].opts.maxTokens === 2200, "1-e: summary sends the ⏳ placeholder after D1 verification and plumbs its id + 2200 tokens to o.chat (Phase 2-f: 900 -> 2200)");
    } finally { global.fetch = prev; }
  }
}

if (failures.length) {
  console.error("\nFailures found:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
  process.exit(1);
}

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
   check(cl("۵۰۰۰ تومان بستنی گرفتم").intent === "expense", "got with a product is spend");
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
  sqlite.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
  // 1-d-1 (intentional expectation upgrade, spec-required): chat tier
  // no longer consults the model at all — "خرج" goes straight to chat
  // with zero model calls, no amount ask, no record.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("expense"));
    const r = await handleDailyText(env, o(env, 4306, "خرج", { ...s, nowMs: NOW }));
    check(r === "chat" && fetchCalls === 0 && s.sent.length === 0 && rows("SELECT COUNT(*) AS n FROM expenses")[0].n === 0, "1-d-1: chat-tier goes straight to chat, zero model calls");
  }
  // Chat tier + model note (bare) -> note-text ask, nothing stored.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("note"));
    const r = await handleDailyText(env, o(env, 4307, "یادداشت", { ...s, nowMs: NOW }));
    check(r === "handled" && fetchCalls === 0 && lastText(s).includes("چه چیزی را یادداشت کنم؟") && rows("SELECT COUNT(*) AS n FROM notes")[0].n === 0, "rule bare note -> note-text ask, zero model fetches");
  }
  // 1-d-1 (upgrade): chat tier goes straight to chat for text and
  // image alike, zero model calls; the caller still runs classifyIntent
  // on a "chat" return (the normal path).
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("chat"));
    check((await handleDailyText(env, o(env, 4308, "سلام، چطوری؟", { ...s, nowMs: NOW }))) === "chat" && fetchCalls === 0, "1-d-1: chat-tier text goes straight to chat, zero model calls");
    check((await handleDailyText(env, o(env, 4308, "سلام، چطوری؟", { ...s, nowMs: NOW, hasImage: true }))) === "chat" && fetchCalls === 0, "1-d-1: chat-tier image goes straight to chat, zero model calls");
  }
  // 1-d-1 (upgrade): chat tier never calls the model, so there is no
  // failure to fall back from — still the chat path, zero fetches.
  {
    const env = mkEnv(), s = fakeSend(); mockModelFail();
    check((await handleDailyText(env, o(env, 4309, "سلام، چطوری؟", { ...s, nowMs: NOW }))) === "chat" && fetchCalls === 0, "1-d-1: chat-tier never calls the model, chat path with zero fetches");
  }
  // 1-d-1 (upgrade, spec core): chat tier never reaches the model dev
  // verdict, so no /dev suggestion is ever sent — straight to chat.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("dev"));
    const r = await handleDailyText(env, o(env, 4310, "پروژه", { ...s, nowMs: NOW }));
    check(r === "chat" && fetchCalls === 0 && s.sent.length === 0, "1-d-1: chat-tier dev-looking text goes straight to chat, no suggestion");
  }
  // 1-d-1 (upgrade): chat tier no longer routes via the model translate
  // verdict — the message goes straight to chat (the chat combo itself
  // can translate conversationally); no history-free translate call.
  {
    const env = mkEnv(), s = fakeSend(); let chats = [];
    mockModel(modelJson("translate", { target: "en" }));
    const r = await handleDailyText(env, o(env, 4311, "اینو انگلیسیش کن: سلام دنیا", { ...s, nowMs: NOW, chat: async (text, copts) => { chats.push({ text, copts }); } }));
    check(r === "chat" && fetchCalls === 0 && chats.length === 0 && s.sent.length === 0, "1-d-1: chat-tier translate-looking text goes straight to chat, zero model calls");
  }
  // 1-d-1 (upgrade): chat tier never reaches the model, so an invalid
  // model target cannot arise here — straight to chat, no language ask.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("translate", { target: "de" }));
    const r = await handleDailyText(env, o(env, 4312, "اینو انگلیسیش کن: سلام دنیا", { ...s, nowMs: NOW }));
    check(r === "chat" && fetchCalls === 0 && s.sent.length === 0, "1-d-1: chat-tier never reaches the model, no language ask");
  }
  // 1-d-1 (upgrade): chat tier no longer routes via the model reminder
  // verdict — "فردا جلسه دارم ساعت ۹" has no reminder trigger verb, so
  // it goes straight to chat and stores nothing.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("reminder"));
    const r = await handleDailyText(env, o(env, 4313, "فردا جلسه دارم ساعت ۹", { ...s, nowMs: NOW }));
    check(r === "chat" && fetchCalls === 0 && s.sent.length === 0 && rows("SELECT COUNT(*) AS n FROM tasks WHERE user_id = 4313")[0].n === 0, "1-d-1: chat-tier reminder-looking text goes straight to chat, nothing stored");
  }
  // 1-d-1 (upgrade): chat tier no longer routes via the model
  // expense-query verdict — straight to chat, no period ask.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("expense-query"));
     const r = await handleDailyText(env, o(env, 4314, "پول‌هایم را بگو", { ...s, nowMs: NOW }));
    check(r === "chat" && fetchCalls === 0 && s.sent.length === 0, "1-d-1: chat-tier expense-query-looking text goes straight to chat, no period ask");
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
  // 1-d-1 (upgrade): the surviving model path is ask-tier (chat tier
  // no longer calls the model), so the timing proof moves to an
  // ask-tier message: model chat verdict -> expense-or-chat ask.
  {
    const env = mkEnv(), s = fakeSend(); mockModel(modelJson("chat"));
    const origLog = console.log; const lines = []; console.log = (...a) => { lines.push(a.join(" ")); };
    await handleDailyText(env, o(env, 4319, "۵۰۰ تومان نان", { ...s, nowMs: NOW }));
    console.log = origLog;
    const entry = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j && j.modelIntent);
    check(Boolean(entry) && entry.modelIntent === "chat" && entry.tier === "ask" && typeof entry.ms === "number" && entry.outcome === "asked" && !lines.some((l) => l.includes("۵۰۰ تومان نان")), "1-d-1: timing log on the ask-tier model path: combo/tier/ms/outcome, no message text");
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
      // Phase 1-e Pillar 1: delivered text may arrive via the ⏳
      // placeholder's edit, not a second sendMessage.
      const texts = world.calls.telegram.filter((c) => c.method === "sendMessage" || c.method === "editMessageText").map((c) => String(c.payload?.text ?? ""));
      check(texts.some((x) => x.includes("مرحله‌ی چت شکست خورد")) && !texts.some((x) => x.includes("با /dev بفرست")), "full flow: model chat skips classifyIntent, no dev suggestion");
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
   const askIdOf = (s) => {
     const datas = (s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []);
     const d = datas.find((x) => x.startsWith("daily:ask:") || x.startsWith("money:dir:"));
     if (!d) return null;
     const parts = d.split(":");
     // daily:ask:<id> or daily:ask:<id>:choice ; money:dir:<dir>:<id>
     if (d.startsWith("money:dir:")) return parts[3];
     return parts[2];
   };
  // 1-d-1 (setup upgrade): the amount slot is now built from "خرج
  // کردم" (ask amount) with a pinned model-expense mock — the old
  // setup rode the retired chat-tier model path ("خرج" -> model
  // expense). Pinning the mock matters: ask-tier still consults the
  // model, so an unpinned leftover mock verdict would hijack the slot
  // (model note -> note-text ask). The expense verdict re-derives the
  // amount ask from rule code (ambiguous -> amount), so the resulting
  // slot shape is identical (question + kind "amount") and every
  // follow-up assertion below is unchanged.
  const amountAsk = async (env, s, uid) => { mockModel(modelJson("expense")); await handleDailyText(env, o(env, uid, "خرج کردم", { ...s, nowMs: NOW })); };
  const chatButtons = async (env, s, uid) => { mockModel(modelJson("chat")); await handleDailyText(env, o(env, uid, "۵۰۰ تومان نان", { ...s, nowMs: NOW })); return askIdOf(s); };
   const incomeButtons = async (env, s, uid) => { mockModelFail(); await handleDailyText(env, o(env, uid, "۵۰۰ تومان سود بستنی گرفتم", { ...s, nowMs: NOW })); return askIdOf(s); };
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
    check(r === "chat" && s.sent.length === n, "later yes without slot is fresh chat, not followup");
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
    check(r === "chat" && s.sent.length === 0, "followup without slot ignored, fresh chat");
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
  sqlite.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
  // Phase 2-l: conversational note forms with the framing stripped.
  {
    const lead = cl("سلام یه یادداشت برام ثبت کن که فردا سیمان میرسه");
    const modal = cl("میخوام یه یادداشت ثبت کنی فردا جلسه با مهندس ناظر ساعت ۱۰");
    const tail = cl("فردا باید قرارداد رو امضا کنیم، اینو برام یادداشت کن");
    check(lead.intent === "note" && lead.text === "فردا سیمان میرسه", "2-l: greeting+polite note strips framing");
    check(modal.intent === "note" && modal.text === "فردا جلسه با مهندس ناظر ساعت ۱۰", "2-l: modal opener note strips framing");
    check(tail.intent === "note" && tail.text === "فردا باید قرارداد رو امضا کنیم", "2-l: trailing اینو برام یادداشت کن strips framing");
    check(cl("می‌خواهم یادداشت کنم که فردا جلسه دارم").intent === "chat", "2-l: first-person note form still chat");
    check(cl("میتونی اینو برام یادداشت کنی؟").intent !== "note", "2-l: framing-only trailing form is not a note");
  }
  // Phase 2-l: the deterministic path stores the stripped body with zero
  // model calls (no NLU needed for a conversational note).
  {
    const env = mkEnv(), s = fakeSend();
    global.fetch = async () => { fetchCalls++; throw new Error("model must not be called"); };
    const r = await handleDailyText(env, o(env, 4525, "سلام یه یادداشت برام ثبت کن که فردا سیمان میرسه", { ...s, nowMs: NOW }));
    check(r === "handled" && lastText(s).includes("یادداشت ذخیره شد") && rows("SELECT text FROM notes WHERE user_id = 4525")[0].text === "فردا سیمان میرسه" && fetchCalls === 0, "2-l: conversational note stored deterministically with framing stripped, zero model calls");
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
  const raw = await callInterpreterModel(fakeEnv, "@cf/some-candidate-model", prompt);
  check(seenModel === "@cf/some-candidate-model" && seenTemp === 0 && raw === good, "0-a: model id passed through as a parameter, temperature 0");

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
  // 1-b-1: the shared Phase 0-b DB now also carries migration 0003 (the
  // schema production already has). No users rows exist yet, so the
  // migration seeds nothing and the fallback seed list still governs.
  sqlite0b.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
  const d1b = { prepare(sql) { const stmt = sqlite0b.prepare(sql); return { bind(...params) { return { run: async () => { const r = stmt.run(...params); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: stmt.all(...params) }), first: async () => stmt.get(...params) ?? null }; } }; } };
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
    // 1-b-1 (INTENDED BEHAVIOUR CHANGE, Plan v2 §5.5): the task card is
    // no longer presentation-only — the task is stored, delete button only.
    const env = mkEnv0b(), s = mkS();
    await handleDailyText(env, mkO(s, "تسک من", { interpreterCallFn: fakeInterp([act("task", { text: "گزارش را بفرستم", project: "گلبهار" })]) }));
    check(String(s.sent.at(-1)?.text ?? "").includes("گزارش را بفرستم") && !String(s.sent.at(-1)?.text ?? "").includes("ذخیره با فاز ۱"), "1-b-1: task action stores a real task (no longer presentation-only)");
    const delBtn = btnData(s).find((d) => d.startsWith("task:del:"));
    check(!!delBtn && !btnData(s).some((d) => d.startsWith("interp:changetask:") || d.startsWith("interp:taskdismiss:")), "1-b-1: stored-task card carries only the id-carrying delete button");
    check(rows0b("SELECT COUNT(*) AS n FROM tasks WHERE title = 'گزارش را بفرستم'")[0].n === 1, "1-b-1: task row stored");
    const s2 = mkS();
    let markupRemoved = false;
    await resolveTaskCallback(env, { fromId: 4242, chatId: 4242, data: delBtn, send: s2.send, editMarkup: async () => { markupRemoved = true; }, chat: s2.chat, nowMs: NOW0b });
    check(rows0b("SELECT status FROM tasks WHERE title = 'گزارش را بفرستم'")[0].status === "deleted" && markupRemoved && String(s2.sent.at(-1)?.text ?? "").includes("حذف شد"), "1-b-1: task delete tap deletes and removes markup");
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

// ── Phase 1-a: migration 0003 + task/project D1 functions (no wiring) ───
// Fresh in-memory DB: user + note rows exist BEFORE 0003, so the migration
// itself must seed projects and attach old notes to عمومی.
if (DatabaseSync) {
  const sqlite1a = new DatabaseSync(":memory:");
  sqlite1a.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite1a.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqlite1a.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
  sqlite1a.exec("INSERT INTO notes (user_id, text, source, created_at) VALUES (1, 'old note', 'text', '2026-10-30T00:00:00.000Z')");
  sqlite1a.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
  const db1a = {
    prepare(sql) {
      const stmt = sqlite1a.prepare(sql);
      return {
        bind(...params) {
          return {
            // Mirror D1's run() shape (meta.changes) so the atomic
            // setTaskStatus transition can be decided from it.
            run: async () => { const r = stmt.run(...params); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; },
            all: async () => ({ results: stmt.all(...params) }),
            first: async () => stmt.get(...params) ?? null,
          };
        },
      };
    },
  };
  const failing1a = { prepare() { throw new Error("boom"); } };

  // Seed: four projects, عمومی default, aliases match SEED_PROJECTS.
  const seeds = await listProjects(db1a, 1);
  check(seeds.length === 4, `seed projects: ${JSON.stringify(seeds.map((p) => p.name))}`);
  check(seeds[0].name === "عمومی" && seeds[0].is_default === 1, "عمومی is default");
  check(seeds[2].name === "گلبهار" && seeds[2].aliases === '["گل"]', "گلبهار alias kept");
  check(seeds[3].name === "قرارها و ملاقات‌ها" && seeds[3].aliases === '["قرارها"]', "قرارها alias kept");
  check((await listProjects(db1a, 99)).length === 0, "unknown user -> no projects");
  check((await getProject(db1a, 1, seeds[0].id))?.name === "عمومی", "getProject by id");
  check((await getProject(db1a, 1, 9999)) === null && (await getProject(db1a, 99, seeds[0].id)) === null, "getProject wrong id/owner -> null");

  // Old note attached to عمومی by the migration itself.
  const oldNote = sqlite1a.prepare("SELECT project_id FROM notes WHERE text = 'old note'").get();
  check(oldNote?.project_id === seeds[0].id, `old note -> عمومی: ${JSON.stringify(oldNote)}`);

  // Task insert/list: open only, project filter, due/remind kept separate.
  const t1 = await insertTask(db1a, { userId: 1, title: "buy milk", projectId: seeds[0].id, dueAt: "2026-11-02", remindAt: "2026-11-01T09:00:00+03:30", source: "text" });
  const t2 = await insertTask(db1a, { userId: 1, title: "call Ali", projectId: seeds[2].id, source: "voice" });
  check(t1.ok === true && t1.id !== null && t2.ok === true, "task inserts ok");
  check((await insertTask(db1a, { userId: 1, title: "   " })).ok === false, "empty title refused");
  check((await insertTask(db1a, { userId: 99, title: "x" })).ok === true, "insert does not check user existence (caller allow-lists)");
  const openAll = await listOpenTasks(db1a, 1);
  check(openAll.length === 2 && openAll[0].title === "buy milk" && openAll[0].remindAt === undefined && openAll[0].remind_at === "2026-11-01T09:00:00+03:30" && openAll[0].due_at === "2026-11-02", "open list keeps due/remind separate");
  check((await listOpenTasks(db1a, 1, seeds[2].id)).length === 1, "project filter works");
  check((await listOpenTasks(db1a, 1, seeds[0].id, 1)).length === 1, "limit applies");

  // Status: open -> done sets completed_at and leaves the open list;
  // a second transition, a bad status, and a wrong owner all fail.
  check((await setTaskStatus(db1a, 1, t1.id, "done")).ok === true, "done ok");
  const doneRow = sqlite1a.prepare("SELECT status, completed_at FROM tasks WHERE id = ?").get(t1.id);
  check(doneRow?.status === "done" && typeof doneRow?.completed_at === "string" && doneRow.completed_at !== "", "done sets completed_at");
  check((await listOpenTasks(db1a, 1)).length === 1, "done task leaves open list");
  check((await setTaskStatus(db1a, 1, t1.id, "done")).ok === false, "done -> done refused");
  check((await setTaskStatus(db1a, 1, t2.id, "archived")).ok === false, "unknown status refused");
  check((await setTaskStatus(db1a, 99, t2.id, "done")).ok === false, "wrong owner refused");
  check((await setTaskStatus(db1a, 1, t2.id, "deleted")).ok === true, "deleted ok");
  const delRow = sqlite1a.prepare("SELECT status, completed_at FROM tasks WHERE id = ?").get(t2.id);
  check(delRow?.status === "deleted" && delRow?.completed_at === null, "deleted keeps completed_at null");
  check((await listOpenTasks(db1a, 1)).length === 0, "deleted task leaves open list");

  // Fix delta 1: project ownership is validated in the DB layer.
  sqlite1a.exec("INSERT INTO users (id, telegram_id) VALUES (99, '99')");
  sqlite1a.exec("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (99, 'other', '[]', 'active', 1, '2026-10-30T00:00:00.000Z')");
  const otherProj = sqlite1a.prepare("SELECT id FROM projects WHERE user_id = 99").get();
  check((await insertTask(db1a, { userId: 1, title: "own project", projectId: seeds[0].id })).ok === true, "fix: own project accepted");
  const fixCount = () => sqlite1a.prepare("SELECT COUNT(*) AS n FROM tasks").get().n;
  const countBefore = fixCount();
  check((await insertTask(db1a, { userId: 1, title: "other user project", projectId: otherProj.id })).ok === false, "fix: other user's project rejected");
  check((await insertTask(db1a, { userId: 1, title: "ghost project", projectId: 9999 })).ok === false, "fix: nonexistent project rejected");
  check(fixCount() === countBefore, "fix: rejected project inserts add zero tasks");
  check((await insertTask(db1a, { userId: 1, title: "no project" })).ok === true, "fix: null project accepted");

  // Fix delta 3: omitted status -> open; provided invalid status rejected.
  const omitted = await insertTask(db1a, { userId: 1, title: "omitted status" });
  check(omitted.ok === true && sqlite1a.prepare("SELECT status FROM tasks WHERE id = ?").get(omitted.id).status === "open", "fix: omitted status -> open");
  check((await insertTask(db1a, { userId: 1, title: "bad status", status: "banana" })).ok === false, "fix: invalid status rejected");
  check(fixCount() === countBefore + 2, "fix: invalid status adds zero tasks");
  const explicit = await insertTask(db1a, { userId: 1, title: "explicit deleted", status: "deleted" });
  check(explicit.ok === true && sqlite1a.prepare("SELECT status FROM tasks WHERE id = ?").get(explicit.id).status === "deleted", "fix: valid explicit status accepted");

  // Fix2: omitted/null projectId -> no project (accepted); an explicitly
  // supplied non-integer projectId -> rejected, never silently null.
  // Placed after the fix-delta-3 count check so its count is untouched.
  check((await insertTask(db1a, { userId: 1, title: "explicit null project", projectId: null })).ok === true, "fix2: explicit null project accepted");
  const countBeforeBanana = fixCount();
  check((await insertTask(db1a, { userId: 1, title: "banana project", projectId: "banana" })).ok === false, "fix2: invalid projectId rejected");
  check((await insertTask(db1a, { userId: 1, title: "float project", projectId: 1.5 })).ok === false, "fix2: non-integer projectId rejected");
  check(fixCount() === countBeforeBanana, "fix2: rejected projectId inserts add zero tasks");

  // Fix3: parseProjectId contract — positive safe integers only.
  const spaced = await insertTask(db1a, { userId: 1, title: "spaced string id", projectId: ` ${seeds[0].id} ` });
  check(spaced.ok === true && sqlite1a.prepare("SELECT project_id FROM tasks WHERE id = ?").get(spaced.id).project_id === seeds[0].id, "fix3: trimmed digit string accepted");
  const strId = await insertTask(db1a, { userId: 1, title: "string id", projectId: String(seeds[0].id) });
  check(strId.ok === true && sqlite1a.prepare("SELECT project_id FROM tasks WHERE id = ?").get(strId.id).project_id === seeds[0].id, "fix3: digit string accepted");
  const countBeforeFix3 = fixCount();
  check((await insertTask(db1a, { userId: 1, title: "unsafe id", projectId: 9007199254740992 })).ok === false, "fix3: unsafe integer rejected");
  check((await insertTask(db1a, { userId: 1, title: "infinity id", projectId: Infinity })).ok === false, "fix3: Infinity rejected");
  check((await insertTask(db1a, { userId: 1, title: "object id", projectId: {} })).ok === false, "fix3: object projectId rejected");
  check((await insertTask(db1a, { userId: 1, title: "empty id", projectId: "" })).ok === false, "fix3: empty string rejected");
  check((await insertTask(db1a, { userId: 1, title: "negative id", projectId: -5 })).ok === false, "fix3: negative id rejected");
  check((await insertTask(db1a, { userId: 1, title: "zero id", projectId: 0 })).ok === false, "fix3: zero id rejected");
  check(fixCount() === countBeforeFix3, "fix3: rejected projectId inserts add zero tasks");

  // Fix4: defensive null-task access in insertTask (task?.projectId).
  check((await insertTask(db1a, null)).ok === false, "fix4: null task rejected without throw");
  check((await insertTask(db1a, undefined)).ok === false, "fix4: undefined task rejected without throw");

  // Fix delta 2: atomic transition — after one success, no second
  // transition from open may succeed, and the row is unchanged by it.
  const t3 = await insertTask(db1a, { userId: 1, title: "atomic task" });
  check((await setTaskStatus(db1a, 1, t3.id, "done")).ok === true, "fix: atomic first transition ok");
  check((await setTaskStatus(db1a, 1, t3.id, "deleted")).ok === false, "fix: atomic second transition refused");
  check(sqlite1a.prepare("SELECT status FROM tasks WHERE id = ?").get(t3.id).status === "done", "fix: refused transition leaves row done");

  // intent_feedback: insert ok, counted in D1, never in logs (no log here).
  check((await insertIntentFeedback(db1a, { userId: 1, text: "note text", predictedType: "note", correctType: "task", project: "عمومی" })).ok === true, "feedback insert ok");
  check(sqlite1a.prepare("SELECT COUNT(*) AS n FROM intent_feedback").get().n === 1, "feedback row in D1");
  check((await insertIntentFeedback(db1a, { userId: 1, text: "", predictedType: "note", correctType: "task" })).ok === false, "empty feedback text refused");

  // DB unavailable or failing: safe empty/false, never a throw.
  check(JSON.stringify(await listProjects(null, 1)) === "[]" && (await getProject(null, 1, 1)) === null, "null DB projects safe");
  check(JSON.stringify(await listOpenTasks(null, 1)) === "[]" && (await insertTask(null, { userId: 1, title: "x" })).ok === false, "null DB tasks safe");
  check((await setTaskStatus(null, 1, 1, "done")).ok === false && (await insertIntentFeedback(null, { userId: 1, text: "x", predictedType: "a", correctType: "b" })).ok === false, "null DB status/feedback safe");
  check(JSON.stringify(await listProjects(failing1a, 1)) === "[]" && (await insertTask(failing1a, { userId: 1, title: "x" })).ok === false, "failing DB safe");
}

// ── Phase 1-b-0a: result-shaped reads + resolveProjects (Fix A) ───────────
// New functions only; resolveProjects is exported for tests but NOT yet
// called by any runtime path in this slice (pure functions + tests).
if (DatabaseSync) {
  const sqlite0a = new DatabaseSync(":memory:");
  sqlite0a.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite0a.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqlite0a.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
  sqlite0a.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
  const db0a = {
    prepare(sql) {
      const stmt = sqlite0a.prepare(sql);
      return {
        bind(...params) {
          return {
            run: async () => { const r = stmt.run(...params); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; },
            all: async () => ({ results: stmt.all(...params) }),
            first: async () => stmt.get(...params) ?? null,
          };
        },
      };
    },
  };
  const failing0a = { prepare() { throw new Error("boom"); } };
  // listProjectsResult: rows ok, empty ok, failures ok:false (never []-as-empty).
  const pr = await listProjectsResult(db0a, 1);
  check(pr.ok === true && pr.projects.length === 4 && pr.projects[0].name === "عمومی" && pr.projects[0].is_default === 1, `0a: projects ok with rows: ${JSON.stringify(pr.projects.map((p) => p.name))}`);
  const prEmpty = await listProjectsResult(db0a, 99);
  check(prEmpty.ok === true && prEmpty.projects.length === 0, "0a: empty success is ok:true with []");
  check((await listProjectsResult(null, 1)).ok === false && (await listProjectsResult(failing0a, 1)).ok === false && (await listProjectsResult(db0a, "banana")).ok === false, "0a: null/throwing/bad-user projects -> ok:false");
  // Delegation: existing listProjects behaviour unchanged.
  check((await listProjects(db0a, 1)).length === 4 && JSON.stringify(await listProjects(null, 1)) === "[]", "0a: listProjects delegate unchanged");
  // listOpenTasksResult: rows, offset paging, beyond-end, failures; delegate unchanged.
  await insertTask(db0a, { userId: 1, title: "t1" });
  await insertTask(db0a, { userId: 1, title: "t2" });
  await insertTask(db0a, { userId: 1, title: "t3" });
  const or1 = await listOpenTasksResult(db0a, 1, null, 2, 1);
  check(or1.ok === true && or1.tasks.length === 2 && or1.tasks[0].title === "t2" && or1.tasks[1].title === "t3", `0a: offset page: ${JSON.stringify(or1.tasks.map((t) => t.title))}`);
  const orEnd = await listOpenTasksResult(db0a, 1, null, 50, 99);
  check(orEnd.ok === true && orEnd.tasks.length === 0, "0a: offset beyond end -> empty ok");
  check((await listOpenTasksResult(null, 1)).ok === false && (await listOpenTasksResult(failing0a, 1)).ok === false, "0a: null/throwing tasks -> ok:false");
  check((await listOpenTasks(db0a, 1)).length === 3, "0a: listOpenTasks delegate unchanged");
  // resolveProjects: D1 rows map to ids with parsed aliases + is_default kept.
  const rp = await resolveProjects({ DB: db0a }, 1);
  check(rp.ok === true && rp.fallback === false && rp.projects[2].name === "گلبهار" && JSON.stringify(rp.projects[2].aliases) === '["گل"]' && rp.projects[0].is_default === 1, `0a: resolveProjects D1 rows: ${JSON.stringify(rp.projects.map((p) => p.name))}`);
  // Malformed stored aliases JSON degrades to [], never a throw.
  sqlite0a.exec("UPDATE projects SET aliases = 'not-json' WHERE user_id = 1 AND name = 'گلبهار'");
  const rpBad = await resolveProjects({ DB: db0a }, 1);
  check(rpBad.ok === true && rpBad.projects[2].aliases.length === 0, "0a: malformed aliases JSON -> []");
  // Genuine empty success -> marked seed fallback, seed shape preserved (no D1 id).
  const rpEmpty = await resolveProjects({ DB: db0a }, 99);
  check(rpEmpty.ok === true && rpEmpty.fallback === true && rpEmpty.projects[0].name === "عمومی" && rpEmpty.projects[0].id === undefined, "0a: genuine empty -> marked seed fallback");
  // D1 failure -> ok:false with NO fallback list (failure never reads as empty).
  const rpFail = await resolveProjects({ DB: failing0a }, 1);
  check(rpFail.ok === false && rpFail.projects.length === 0 && rpFail.fallback !== true, "0a: D1 failure -> ok:false, no fallback");
  // is_default survives: non-default first row, default second row (fresh user, no seeds).
  sqlite0a.exec("INSERT INTO users (id, telegram_id) VALUES (3, '3')");
  sqlite0a.exec("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (3, 'first', '[]', 'active', 0, '2026-10-30T00:00:00.000Z'), (3, 'second', '[]', 'active', 1, '2026-10-30T00:00:00.000Z')");
  const rp2 = await resolveProjects({ DB: db0a }, 3);
  check(rp2.projects.length === 2 && rp2.projects[0].name === "first" && rp2.projects.find((p) => p.is_default === 1)?.name === "second", "0a: is_default lookup reads the field, not the first row");
}

// ── Phase 1-b-0b: offset, archive, alias, ownership (Fix B) ────────────
// New helpers only; no runtime path calls them yet in this slice. (The
// result-shaped open-task core already carried offset from 0a, so this
// slice only adds it to the listOpenTasks delegate.)
if (DatabaseSync) {
  const sqlite0b = new DatabaseSync(":memory:");
  sqlite0b.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite0b.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqlite0b.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
  sqlite0b.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
  const db0b = {
    prepare(sql) {
      const stmt = sqlite0b.prepare(sql);
      return {
        bind(...params) {
          return {
            run: async () => { const r = stmt.run(...params); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; },
            all: async () => ({ results: stmt.all(...params) }),
            first: async () => stmt.get(...params) ?? null,
          };
        },
      };
    },
  };
  const failing0b = { prepare() { throw new Error("boom"); } };
  // Seed projects for user 1: ids 1..4 (عمومی, ایجنت, گلبهار, قرارها).
  await insertTask(db0b, { userId: 1, title: "t1" });
  await insertTask(db0b, { userId: 1, title: "t2" });
  await insertTask(db0b, { userId: 1, title: "t3" });
  await insertTask(db0b, { userId: 1, title: "t4", projectId: 3 });
  // Offset: default identical, pages disjoint, beyond end empty.
  check(JSON.stringify((await listOpenTasks(db0b, 1)).map((t) => t.title)) === '["t1","t2","t3","t4"]', "0b: open default order");
  check(JSON.stringify((await listOpenTasks(db0b, 1, null, 2, 1)).map((t) => t.title)) === '["t2","t3"]' && JSON.stringify((await listOpenTasks(db0b, 1, null, 2, 3)).map((t) => t.title)) === '["t4"]', "0b: offset pages disjoint");
  check((await listOpenTasks(db0b, 1, null, 50, 99)).length === 0, "0b: offset beyond end -> []");
  // Archive: done-only, newest-first, project filter, failure != empty.
  await setTaskStatus(db0b, 1, 2, "done");
  await setTaskStatus(db0b, 1, 4, "done");
  await setTaskStatus(db0b, 1, 3, "deleted");
  const doneAll = await listDoneTasksResult(db0b, 1);
  check(doneAll.ok === true && JSON.stringify(doneAll.tasks.map((t) => t.title)) === '["t4","t2"]', "0b: done newest-first, never open/deleted");
  const doneProj = await listDoneTasksResult(db0b, 1, 3);
  check(doneProj.ok === true && doneProj.tasks.length === 1 && doneProj.tasks[0].title === "t4", "0b: done project filter");
  check((await listDoneTasksResult(null, 1)).ok === false && (await listDoneTasksResult(failing0b, 1)).ok === false && JSON.stringify(await listDoneTasks(null, 1)) === "[]", "0b: done failure distinct from empty (core ok:false, wrapper [])");
  const doneEmpty = await listDoneTasksResult(db0b, 99);
  check(doneEmpty.ok === true && doneEmpty.tasks.length === 0, "0b: genuine empty archive is ok:true");
  // getTask: any status whole; foreign/missing/invalid -> null ok; DB failure -> ok:false.
  const gOpen = await getTask(db0b, 1, 1);
  const gDone = await getTask(db0b, 1, 2);
  const gDel = await getTask(db0b, 1, 3);
  check(gOpen.ok === true && gOpen.task?.status === "open" && gDone.task?.status === "done" && gDel.task?.status === "deleted", "0b: getTask returns own rows in any status");
  sqlite0b.exec("INSERT INTO users (id, telegram_id) VALUES (2, '2')");
  const foreignTask = await insertTask(db0b, { userId: 2, title: "fx" });
  check((await getTask(db0b, 1, foreignTask.id)).ok === true && (await getTask(db0b, 1, foreignTask.id)).task === null, "0b: getTask foreign -> null ok");
  check((await getTask(db0b, 1, 9999)).task === null && (await getTask(db0b, 1, "banana")).task === null && (await getTask(db0b, 1, 1.5)).task === null && (await getTask(db0b, 1, 0)).task === null && (await getTask(db0b, 1, " 2 ")).task?.status === "done", "0b: getTask missing/invalid -> null ok, digit string ok");
  check((await getTask(null, 1, 1)).ok === false && (await getTask(failing0b, 1, 1)).ok === false && (await getTask(db0b, "banana", 1)).ok === false, "0b: getTask DB/user failure -> ok:false");
  // addProjectAlias: add, dedupe vs name/alias, normalization, rejects.
  const gol = 3;
  const a1 = await addProjectAlias(db0b, 1, gol, "کارهای سایت");
  check(a1.ok === true && a1.added === true, "0b: alias added");
  const aDup = await addProjectAlias(db0b, 1, gol, "کارهای سایت");
  check(aDup.ok === true && aDup.added === false, "0b: alias dedupe same");
  const aName = await addProjectAlias(db0b, 1, gol, "گلبهار");
  check(aName.ok === true && aName.added === false, "0b: alias == name no-op");
  const aOld = await addProjectAlias(db0b, 1, gol, "گل");
  check(aOld.ok === true && aOld.added === false, "0b: alias dedupe vs existing");
  const aAr = await addProjectAlias(db0b, 1, gol, "كارهای سايت");
  check(aAr.ok === true && aAr.added === false, "0b: alias dedupe across Arabic-letter folding");
  const projAfter = await getProject(db0b, 1, gol);
  check(JSON.stringify(JSON.parse(projAfter.aliases)) === '["گل","کارهای سایت"]', "0b: aliases stored once, normalized");
  check(matchProject("كارهای سايت", (await resolveProjects({ DB: db0b }, 1)).projects)?.name === "گلبهار", "0b: matchProject finds the new alias");
  check((await addProjectAlias(db0b, 1, 9999, "x")).ok === false && (await addProjectAlias(db0b, 1, gol, "")).ok === false && (await addProjectAlias(db0b, 1, gol, "   ")).ok === false && (await addProjectAlias(null, 1, gol, "x")).ok === false, "0b: alias rejects missing/empty/null-DB");
  sqlite0b.exec("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (2, 'other', '[]', 'active', 0, '2026-10-30T00:00:00.000Z')");
  const otherId = sqlite0b.prepare("SELECT id FROM projects WHERE user_id = 2 AND name = 'other'").get().id;
  check((await addProjectAlias(db0b, 1, otherId, "x")).ok === false, "0b: alias rejects foreign project");
  // Malformed stored JSON: honest failure, value never overwritten.
  sqlite0b.exec("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (1, 'broken', 'not-json', 'active', 0, '2026-10-30T00:00:00.000Z')");
  const brokenId = sqlite0b.prepare("SELECT id FROM projects WHERE user_id = 1 AND name = 'broken'").get().id;
  check((await addProjectAlias(db0b, 1, brokenId, "x")).ok === false && sqlite0b.prepare("SELECT aliases FROM projects WHERE id = ?").get(brokenId).aliases === "not-json", "0b: malformed aliases -> honest failure, value kept");
  // Concurrency: different aliases both survive; same alias once.
  const conc = await Promise.all([addProjectAlias(db0b, 1, gol, "هم‌زمان یک"), addProjectAlias(db0b, 1, gol, "هم‌زمان دو")]);
  check(conc.every((r) => r.ok === true && r.added === true), "0b: concurrent different aliases both added");
  await Promise.all([addProjectAlias(db0b, 1, gol, "تکراری"), addProjectAlias(db0b, 1, gol, "تکراری")]);
  const golAfter = JSON.parse((await getProject(db0b, 1, gol)).aliases);
  check(golAfter.filter((a) => a === "تکراری").length === 1 && golAfter.includes("هم زمان یک") && golAfter.includes("هم زمان دو"), "0b: concurrent same alias stored once");
  // One-UPDATE proof: the primary path issues exactly one UPDATE.
  let updates = 0;
  const countingDb = { prepare(sql) { if (/^\s*UPDATE\s+projects\s+SET\s+aliases\s*=\s*json_insert/i.test(sql)) updates++; return db0b.prepare(sql); } };
  await addProjectAlias(countingDb, 1, gol, "شمارشی");
  check(updates === 1, "0b: alias append is one UPDATE, not read-modify-write");
  // Fallback path: no JSON functions + first conditional UPDATE loses -> retry converges.
  let lostOnce = false;
  const fallbackDb = { prepare(sql) {
    const stmt = db0b.prepare(sql);
    return { bind(...params) { const bound = stmt.bind(...params); return {
      run: async () => {
        if (/json_insert/i.test(sql)) throw new Error("no such function: json_insert");
        if (/COALESCE\(aliases, '\[\]'\) = \?/i.test(sql) && !lostOnce) { lostOnce = true; return { success: true, meta: { changes: 0 } }; }
        return bound.run();
      },
      all: async () => bound.all(),
      first: async () => bound.first(),
    }; }, };
  } };
  const fb = await addProjectAlias(fallbackDb, 1, gol, "پس‌رو");
  check(fb.ok === true && fb.added === true && lostOnce === true && JSON.parse((await getProject(db0b, 1, gol)).aliases).includes("پس رو"), "0b: fallback retry converges after a lost first attempt");
  const fbBad = await addProjectAlias(fallbackDb, 1, brokenId, "x");
  check(fbBad.ok === false, "0b: fallback malformed -> honest failure");
}

// ── Phase 1-b-1: task/project saving + initial list wiring ─────────────
// Fresh DB; migration 0003 runs BEFORE any users rows, so it seeds
// nothing — projects are explicit: user 1 has default عمومی + کار, user 2
// has شخصی with NO default, user 3 has none (seed fallback). Unique titles
// keep the shared-DB tests from interfering.
if (DatabaseSync) {
  const sqlite1b1 = new DatabaseSync(":memory:");
  sqlite1b1.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite1b1.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqlite1b1.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
  sqlite1b1.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1'), (2, '2'), (3, '3')");
  sqlite1b1.exec("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (1, 'عمومی', '[]', 'active', 1, '2026-10-30T00:00:00.000Z'), (1, 'کار', '[\"کاری\"]', 'active', 0, '2026-10-30T00:00:00.000Z'), (2, 'شخصی', '[]', 'active', 0, '2026-10-30T00:00:00.000Z')");
  const db1b1 = { prepare(sql) { const stmt = sqlite1b1.prepare(sql); return { bind(...params) { return { run: async () => { const r = stmt.run(...params); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: stmt.all(...params) }), first: async () => stmt.get(...params) ?? null }; } }; } };
  const rows1b1 = (sql, params = []) => sqlite1b1.prepare(sql).all(...params);
  const mkEnv1b1 = (extra = {}) => ({ STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "1,2,3", DB: db1b1, ...extra });
  const NOW1b1 = Date.UTC(2026, 9, 31, 12, 0, 0); // 2026-10-31 15:30 Iran time
  const act = (type, extra = {}) => ({ type, text: extra.text ?? "متن", project: extra.project ?? null, due_text: extra.due_text ?? null, remind_text: extra.remind_text ?? null, amount_text: extra.amount_text ?? null, query: extra.query ?? null, target: extra.target ?? null, confidence: extra.confidence ?? 0.9, needs: extra.needs ?? "none" });
  const fakeInterp = (actions) => async () => JSON.stringify(actions);
  const mkS = () => { const sent = []; const chats = []; let markup = 0; return { sent, chats, send: async (text, opts) => { sent.push({ text, replyMarkup: opts?.replyMarkup }); }, chat: async (text, copts) => { chats.push({ text, copts }); }, editMarkup: async () => { markup++; }, markup: () => markup }; };
  const mkO1 = (s, text, userId, extra = {}) => ({ chatId: userId, userId, text, send: s.send, chat: s.chat, nowMs: NOW1b1, ...extra });
  const btnData = (s) => s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
  const karId = rows1b1("SELECT id FROM projects WHERE user_id = 1 AND name = 'کار'")[0].id;
  const omumiId = rows1b1("SELECT id FROM projects WHERE user_id = 1 AND name = 'عمومی'")[0].id;
  // Classifier: closed list matches, bare/creation/body forms do not.
  for (const t of ["تسک هام", "تسکهام", "تسک هایم", "تسکهایم", "تسک هامو", "تسک\u200cهام", "تسک\u200cهایم را نشان بده", "تسک هام را نشان بده", "تسک هامو نشون بده", "تسکهایم را نمایش بده"]) { const c = classifyDaily(t, { nowMs: NOW1b1, rememberedCurrency: "TOMAN" }); check(c.intent === "task-list" && c.confidence === 1, `1-b-1: task-list closed form ${t}`); }
  for (const t of ["تسک", "تسک جدید", "تسک بساز", "تسک هام شیر بخرم", "تسک هام را ببینم"]) { check(classifyDaily(t, { nowMs: NOW1b1, rememberedCurrency: "TOMAN" }).intent !== "task-list", `1-b-1: no task-list for ${t}`); }
  // Rule list: first page of 8, open only, project names, zero model calls. The project task is inserted FIRST so it lands on page 1 (id ASC).
  {
    sqlite1b1.exec(`INSERT INTO tasks (user_id, title, project_id, status, source, created_at) VALUES (1, 'پروژه‌دار', ${karId}, 'open', 'text', '2026-10-30T00:00:00.000Z')`);
    for (let i = 1; i <= 10; i++) sqlite1b1.exec(`INSERT INTO tasks (user_id, title, status, source, created_at) VALUES (1, 'باز ${i}', 'open', 'text', '2026-10-30T00:00:00.000Z')`);
    sqlite1b1.exec("INSERT INTO tasks (user_id, title, status, source, created_at) VALUES (1, 'انجام‌شده', 'done', 'text', '2026-10-30T00:00:00.000Z'), (1, 'حذف‌شده', 'deleted', 'text', '2026-10-30T00:00:00.000Z')");
    const env = mkEnv1b1(), s = mkS();
    let calls = 0;
    await handleDailyText(env, mkO1(s, "تسک هام", 1, { interpreterCallFn: async () => { calls++; return "[]"; } }));
    const listText = String(s.sent.at(-1)?.text ?? "");
    check(calls === 0, "1-b-1: rule list makes zero model calls");
    check(listText.split("\n").length === 8, "1-b-1: list shows first page of 8");
    check(listText.includes("پروژه‌دار — کار"), "1-b-1: list shows project names");
    check(!listText.includes("انجام‌شده") && !listText.includes("حذف‌شده"), "1-b-1: list shows open only");
    const sE = mkS();
    await handleDailyText(mkEnv1b1(), mkO1(sE, "تسکهایم", 3));
    check(String(sE.sent.at(-1)?.text ?? "") === "تسک بازی پیدا نشد.", "1-b-1: empty list is honest");
    const failTasksEnv = { ...mkEnv1b1(), DB: { prepare(sql) { if (/FROM tasks/i.test(sql)) throw new Error("boom"); return db1b1.prepare(sql); } } }, sF = mkS();
    await handleDailyText(failTasksEnv, mkO1(sF, "تسک هام", 1));
    check(String(sF.sent.at(-1)?.text ?? "") === "تسک‌ها خوانده نشد؛ دوباره تلاش کن", "1-b-1: task-read failure is honest, never an empty list");
    // Stale slot cleared by the rule list.
    const envS = mkEnv1b1(), sS = mkS();
    await handleDailyText(envS, mkO1(sS, "یادداشت کن", 1));
    check(await envS.STATE.get("daily:pending-ask:1", "json") !== null, "1-b-1: bare-note ask sets a slot (precondition)");
    await handleDailyText(envS, mkO1(sS, "تسک هام", 1));
    check(await envS.STATE.get("daily:pending-ask:1", "json") === null, "1-b-1: rule list clears a stale slot");
  }
  // Interpreter task storage: D1 project id, due ISO, voice source, source message id, pointer, delete-only card.
  {
    const env = mkEnv1b1(), s = mkS();
    await handleDailyText(env, mkO1(s, "تسک گزارش", 1, { interpreterCallFn: fakeInterp([act("task", { text: "گزارش هفتگی", project: "کار", due_text: "فردا" })]) }));
    const row = rows1b1("SELECT * FROM tasks WHERE title = 'گزارش هفتگی'")[0];
    check(row && row.project_id === karId && row.status === "open" && row.source === "text", "1-b-1: task stored with D1 project id and text source");
    check(row && row.due_at === "2026-11-01T00:00:00+03:30" && row.remind_at === null, "1-b-1: validated due ISO stored, remind stays null");
    check(row && row.source_message_id === rows1b1("SELECT id FROM messages WHERE user_id = 1 AND content = 'تسک گزارش' ORDER BY id DESC LIMIT 1")[0].id, "1-b-1: task carries its source message id");
    const ptr = await env.STATE.get("interp:last-item:1", "json");
    check(ptr?.table === "tasks" && ptr?.id === row.id, "1-b-1: task storage sets the correction pointer");
    // 1-b-3 (INTENDED BEHAVIOUR CHANGE, Plan v2 §3.3): the stored-task
    // card gains the change-type button next to delete (it must NOT
    // have appeared in 1-b-1); delete still works via task:del.
    check(btnData(s).length === 2 && btnData(s)[0] === `task:del:${row.id}` && btnData(s)[1].startsWith("interp:change:"), "1-b-3: stored-task card carries delete + change-type buttons");
    await handleDailyText(mkEnv1b1(), mkO1(s, "تسک صوتی", 1, { source: "voice", interpreterCallFn: fakeInterp([act("task", { text: "یادداشت صوتی" })]) }));
    check(rows1b1("SELECT source FROM tasks WHERE title = 'یادداشت صوتی'")[0].source === "voice", "1-b-1: voice task stores voice source");
    await handleDailyText(mkEnv1b1(), mkO1(s, "تسک بی‌زمان", 1, { interpreterCallFn: fakeInterp([act("task", { text: "تسک بی‌زمان" })]) }));
    const timeless = rows1b1("SELECT due_at, remind_at FROM tasks WHERE title = 'تسک بی‌زمان'")[0];
    check(timeless && timeless.due_at === null && timeless.remind_at === null, "1-b-1: timeless task never invents dates");
    const failInsEnv = { ...mkEnv1b1(), DB: { prepare(sql) { if (/INSERT INTO tasks/i.test(sql)) throw new Error("boom"); return db1b1.prepare(sql); } } }, sI = mkS();
    await handleDailyText(failInsEnv, mkO1(sI, "تسک خراب", 1, { interpreterCallFn: fakeInterp([act("task", { text: "تسک خراب" })]) }));
    check(String(sI.sent.at(-1)?.text ?? "") === "ذخیره نشد، دوباره تلاش کن" && rows1b1("SELECT COUNT(*) AS n FROM tasks WHERE title = 'تسک خراب'")[0].n === 0, "1-b-1: insert failure is honest and stores nothing");
    check(await failInsEnv.STATE.get("interp:last-item:1", "json") === null, "1-b-1: no pointer on insert failure");
  }
  // Stored-card delete matrix: owned, consumed, foreign, D1 failure.
  {
    sqlite1b1.exec("INSERT INTO tasks (user_id, title, status, source, created_at) VALUES (1, 'حذف‌پذیر', 'open', 'text', '2026-10-30T00:00:00.000Z')");
    const tid = rows1b1("SELECT id FROM tasks WHERE title = 'حذف‌پذیر'")[0].id;
    const env = mkEnv1b1(), sD = mkS();
    await resolveTaskCallback(env, { fromId: 1, chatId: 1, data: `task:del:${tid}`, send: sD.send, editMarkup: sD.editMarkup, chat: sD.chat, nowMs: NOW1b1 });
    check(rows1b1("SELECT status FROM tasks WHERE id = ?", [tid])[0].status === "deleted" && sD.markup() === 1 && String(sD.sent.at(-1)?.text ?? "").includes("حذف شد"), "1-b-1: owned delete deletes and removes markup");
    const sD2 = mkS();
    await resolveTaskCallback(env, { fromId: 1, chatId: 1, data: `task:del:${tid}`, send: sD2.send, editMarkup: sD2.editMarkup, chat: sD2.chat, nowMs: NOW1b1 });
    check(String(sD2.sent.at(-1)?.text ?? "") === "قبلاً ثبت شد یا مهلتش گذشته" && sD2.markup() === 1, "1-b-1: consumed tap gets the fixed message and removes markup");
    sqlite1b1.exec("INSERT INTO tasks (user_id, title, status, source, created_at) VALUES (1, 'مال دیگری', 'open', 'text', '2026-10-30T00:00:00.000Z')");
    const foreignId = rows1b1("SELECT id FROM tasks WHERE title = 'مال دیگری'")[0].id;
    const sD3 = mkS();
    await resolveTaskCallback(env, { fromId: 2, chatId: 2, data: `task:del:${foreignId}`, send: sD3.send, editMarkup: sD3.editMarkup, chat: sD3.chat, nowMs: NOW1b1 });
    check(sD3.sent.length === 0 && sD3.markup() === 0 && rows1b1("SELECT status FROM tasks WHERE id = ?", [foreignId])[0].status === "open", "1-b-1: foreign tap is silent");
    const failGetEnv = { ...mkEnv1b1(), DB: { prepare(sql) { if (/FROM tasks WHERE id/i.test(sql)) throw new Error("boom"); return db1b1.prepare(sql); } } }, sD4 = mkS();
    await resolveTaskCallback(failGetEnv, { fromId: 1, chatId: 1, data: `task:del:${foreignId}`, send: sD4.send, editMarkup: sD4.editMarkup, chat: sD4.chat, nowMs: NOW1b1 });
    check(String(sD4.sent.at(-1)?.text ?? "") === "ذخیره نشد، دوباره تلاش کن" && sD4.markup() === 0, "1-b-1: D1 failure keeps the buttons");
    check(await resolveTaskCallback(env, { fromId: 1, chatId: 1, data: "task:del:abc", send: sD.send, editMarkup: async () => {}, chat: sD.chat, nowMs: NOW1b1 }) === false, "1-b-1: non-numeric del is not a task callback");
    const beforeMore = sD.sent.length;
    check(await resolveTaskCallback(env, { fromId: 1, chatId: 1, data: "task:more:0", send: sD.send, editMarkup: async () => {}, chat: sD.chat, nowMs: NOW1b1 }) === true && sD.sent.length > beforeMore, "1-b-2 (INTENDED BEHAVIOUR CHANGE): pagination is handled now");
  }
  // Note assignment: D1 project id, seed-fallback NULL, rule-note default.
  {
    const env = mkEnv1b1(), s = mkS();
    await handleDailyText(env, mkO1(s, "یادداشت کاری", 1, { interpreterCallFn: fakeInterp([act("note", { text: "یادداشت کاری", project: "کار" })]) }));
    check(rows1b1("SELECT project_id FROM notes WHERE text = 'یادداشت کاری'")[0].project_id === karId, "1-b-1: interp note stores the D1 project id");
    await handleDailyText(mkEnv1b1(), mkO1(s, "یادداشت سه", 3, { interpreterCallFn: fakeInterp([act("note", { text: "یادداشت بدون پروژه", project: "گلبهار" })]) }));
    check(rows1b1("SELECT project_id FROM notes WHERE text = 'یادداشت بدون پروژه'")[0].project_id === null, "1-b-1: seed-fallback note stores NULL, never a fake id");
    await handleDailyText(mkEnv1b1(), mkO1(s, "یادداشت کن متن قانون", 1));
    check(rows1b1("SELECT project_id FROM notes WHERE text = 'متن قانون'")[0].project_id === omumiId, "1-b-1: rule note takes the D1 default project id");
    await handleDailyText(mkEnv1b1(), mkO1(s, "یادداشت کن متن بی‌پیش‌فرض", 2));
    check(rows1b1("SELECT project_id FROM notes WHERE text = 'متن بی‌پیش‌فرض'")[0].project_id === null, "1-b-1: rule note with no default still stores, with NULL");
    const failProjNoteEnv = { ...mkEnv1b1(), DB: { prepare(sql) { if (/FROM projects/i.test(sql)) throw new Error("boom"); return db1b1.prepare(sql); } } }, sRN = mkS();
    await handleDailyText(failProjNoteEnv, mkO1(sRN, "یادداشت کن متن خراب‌پروژه", 1));
    check(String(sRN.sent.at(-1)?.text ?? "") === "✅ یادداشت ذخیره شد." && rows1b1("SELECT project_id FROM notes WHERE text = 'متن خراب‌پروژه'")[0].project_id === null, "1-b-1: project-read failure still stores the rule note with NULL");
  }
  // Project-choice tap: resolved rows, tap-only alias, model-only silence.
  {
    const env = mkEnv1b1(), s = mkS();
    await handleDailyText(env, mkO1(s, "یادداشت تازه", 1, { interpreterCallFn: fakeInterp([act("note", { text: "یادداشت تازه", project: "پروژه جدید" })]) }));
    const projBtns = btnData(s).filter((d) => d.startsWith("interp:proj:"));
    check(projBtns.length === 3, "1-b-1: project-choice rows are the resolved list plus new");
    const sA = mkS();
    await resolveInterpCallback(env, { fromId: 1, chatId: 1, data: projBtns[1], send: sA.send, editMarkup: async () => {}, chat: sA.chat, nowMs: NOW1b1 });
    check(rows1b1("SELECT project_id FROM notes WHERE text = 'یادداشت تازه'")[0].project_id === karId, "1-b-1: chosen project stores the note");
    check(JSON.parse(rows1b1("SELECT aliases FROM projects WHERE id = ?", [karId])[0].aliases).includes("پروژه جدید"), "1-b-1: alias written on the explicit tap only");
    const sA2 = mkS();
    await resolveInterpCallback(env, { fromId: 1, chatId: 1, data: projBtns[1], send: sA2.send, editMarkup: async () => {}, chat: sA2.chat, nowMs: NOW1b1 });
    check(String(sA2.sent.at(-1)?.text ?? "") === "قبلاً ثبت شد یا مهلتش گذشته", "1-b-1: second project tap is consumed");
    const before = rows1b1("SELECT aliases FROM projects WHERE id = ?", [karId])[0].aliases;
    const sM = mkS();
    await handleDailyText(mkEnv1b1(), mkO1(sM, "یادداشت دوم", 1, { interpreterCallFn: fakeInterp([act("note", { text: "یادداشت دوم", project: "کار" })]) }));
    check(rows1b1("SELECT aliases FROM projects WHERE id = ?", [karId])[0].aliases === before, "1-b-1: model-matched project writes no alias");
    const envF = { ...mkEnv1b1(), DB: { prepare(sql) { if (/UPDATE projects SET aliases/i.test(sql)) throw new Error("boom"); return db1b1.prepare(sql); } } }, sF = mkS();
    await handleDailyText(envF, mkO1(sF, "یادداشت سوم", 1, { interpreterCallFn: fakeInterp([act("note", { text: "یادداشت سوم", project: "پروژه سوم" })]) }));
    const projBtnsF = btnData(sF).filter((d) => d.startsWith("interp:proj:"));
    const sF2 = mkS();
    await resolveInterpCallback(envF, { fromId: 1, chatId: 1, data: projBtnsF[1], send: sF2.send, editMarkup: async () => {}, chat: sF2.chat, nowMs: NOW1b1 });
    check(sF2.sent.some((m) => String(m.text ?? "").includes("نام مستعار پروژه ذخیره نشد")) && rows1b1("SELECT COUNT(*) AS n FROM notes WHERE text = 'یادداشت سوم'")[0].n === 1, "1-b-1: alias failure is honest and the domain action still runs");
  }
  // Interpreter failure path on project-read failure: no seed names, no store.
  {
    const failProjEnv = { ...mkEnv1b1(), DB: { prepare(sql) { if (/FROM projects/i.test(sql)) throw new Error("boom"); return db1b1.prepare(sql); } } }, sG = mkS();
    let gCalls = 0;
    await handleDailyText(failProjEnv, mkO1(sG, "تسک خراب پروژه", 1, { interpreterCallFn: async () => { gCalls++; return "[]"; } }));
    const gText = sG.sent.map((m) => String(m.text ?? "")).join("\n");
    check(gCalls === 0 && gText.includes("تفسیر خودکار الان در دسترس نیست") && !gText.includes("پروژه‌ی «") && !gText.includes("عمومی") && !btnData(sG).some((d) => d.startsWith("interp:proj:")), "1-b-1: project-read failure takes the failure path, no seed names");
    check(rows1b1("SELECT COUNT(*) AS n FROM tasks WHERE title = 'تسک خراب پروژه'")[0].n === 0, "1-b-1: failure path stores nothing");
  }
  // Multi-action: both stored; no task buttons in the summary in 1-b-1 (those arrive with 1-b-2).
  {
    const env = mkEnv1b1(), s = mkS();
    await handleDailyText(env, mkO1(s, "چند مورد", 1, { interpreterCallFn: fakeInterp([act("task", { text: "تسک چندگانه" }), act("note", { text: "یادداشت چندگانه" })]) }));
    check(rows1b1("SELECT COUNT(*) AS n FROM tasks WHERE title = 'تسک چندگانه'")[0].n === 1 && rows1b1("SELECT COUNT(*) AS n FROM notes WHERE text = 'یادداشت چندگانه'")[0].n === 1, "1-b-1: multi-action stores both items");
    check(btnData(s).some((d) => d.startsWith("task:del:")), "1-b-2 (INTENDED BEHAVIOUR CHANGE, 1-b-1 boundary closed): multi summary now carries task delete buttons");
    check(btnData(s).some((d) => d.startsWith("interp:del:")), "1-b-1: multi summary still carries the note delete button");
  }
}

// ── Phase 1-b-2: full list, pagination, ✅, delete, archive, filter ──
// Fresh DB; user 1 has default عمومی + کار; user 2 has شخصی.
if (DatabaseSync) {
  const sqlite1b2 = new DatabaseSync(":memory:");
  sqlite1b2.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite1b2.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqlite1b2.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
  sqlite1b2.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1'), (2, '2')");
  sqlite1b2.exec("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (1, 'عمومی', '[]', 'active', 1, '2026-10-30T00:00:00.000Z'), (1, 'کار', '[]', 'active', 0, '2026-10-30T00:00:00.000Z'), (2, 'شخصی', '[]', 'active', 0, '2026-10-30T00:00:00.000Z')");
  const db1b2 = { prepare(sql) { const stmt = sqlite1b2.prepare(sql); return { bind(...params) { return { run: async () => { const r = stmt.run(...params); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: stmt.all(...params) }), first: async () => stmt.get(...params) ?? null }; } }; } };
  const rows1b2 = (sql, params = []) => sqlite1b2.prepare(sql).all(...params);
  const mkEnv1b2 = (extra = {}) => ({ STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "1,2", DB: db1b2, ...extra });
  const NOW1b2 = Date.UTC(2026, 9, 31, 12, 0, 0);
  const mkS2 = () => { const sent = []; const chats = []; let markup = 0; return { sent, chats, send: async (text, opts) => { sent.push({ text, replyMarkup: opts?.replyMarkup }); }, chat: async (text, copts) => { chats.push({ text, copts }); }, editMarkup: async () => { markup++; }, markup: () => markup }; };
  const mkO2 = (s, text, userId, extra = {}) => ({ chatId: userId, userId, text, send: s.send, chat: s.chat, nowMs: NOW1b2, ...extra });
  const btnData2 = (s) => s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
  const cbO2 = (s, data, userId) => ({ fromId: userId, chatId: userId, data, send: s.send, editMarkup: s.editMarkup, chat: s.chat, nowMs: NOW1b2 });
  const act2 = (type, extra = {}) => ({ type, text: extra.text ?? "متن", project: extra.project ?? null, due_text: extra.due_text ?? null, remind_text: extra.remind_text ?? null, amount_text: extra.amount_text ?? null, query: extra.query ?? null, target: extra.target ?? null, confidence: extra.confidence ?? 0.9, needs: extra.needs ?? "none" });
  const fakeInterp2 = (actions) => async () => JSON.stringify(actions);
  const karId2 = rows1b2("SELECT id FROM projects WHERE user_id = 1 AND name = 'کار'")[0].id;
  const seedTasks = () => { for (let i = 1; i <= 10; i++) sqlite1b2.exec(`INSERT INTO tasks (user_id, title, status, source, created_at) VALUES (1, 'صفحه ${i}', 'open', 'text', '2026-10-30T00:00:00.000Z')`); sqlite1b2.exec(`INSERT INTO tasks (user_id, title, project_id, status, source, created_at) VALUES (1, 'کاری ۱', ${karId2}, 'open', 'text', '2026-10-30T00:00:00.000Z'), (1, 'کاری ۲', ${karId2}, 'open', 'text', '2026-10-30T00:00:00.000Z')`); sqlite1b2.exec("INSERT INTO tasks (user_id, title, status, source, created_at) VALUES (1, 'قدیمی تمام', 'done', 'text', '2026-10-29T00:00:00.000Z'), (1, 'تازه تمام', 'done', 'text', '2026-10-30T00:00:00.000Z'), (1, 'حذف‌شده', 'deleted', 'text', '2026-10-30T00:00:00.000Z'), (2, 'دیگری', 'open', 'text', '2026-10-30T00:00:00.000Z')"); };
  seedTasks();
  const openId = (title) => rows1b2("SELECT id FROM tasks WHERE title = ?", [title])[0].id;
  // Pagination: page 1 of 8 with a more button; page 2 disjoint; beyond-end no-more, no repeat.
  {
    const env = mkEnv1b2(), s = mkS2();
    await handleDailyText(env, mkO2(s, "تسک هام", 1));
    const p1 = String(s.sent.at(-1)?.text ?? "");
    check(p1.split("\n").length === 8 && p1.includes("صفحه 1") && p1.includes("صفحه 8") && !p1.includes("صفحه 9"), "1-b-2: page 1 has 8 rows");
    check(btnData2(s).includes("task:more:8"), "1-b-2: full page carries a more button");
    check(btnData2(s).some((d) => d === `task:done:${openId("صفحه 1")}`) && btnData2(s).some((d) => d === `task:del:${openId("صفحه 1")}`), "1-b-2: list rows carry done/delete buttons");
    check(btnData2(s).some((d) => d === "task:arch:0") && btnData2(s).some((d) => d === `task:proj:${karId2}:0`), "1-b-2: list carries archive + project filter buttons");
    const s2 = mkS2();
    await resolveTaskCallback(env, cbO2(s2, "task:more:8", 1));
    const p2 = String(s2.sent.at(-1)?.text ?? "");
    check(p2.includes("صفحه 9") && p2.includes("صفحه 10") && !p2.includes("صفحه 1\n") && !btnData2(s2).some((d) => d.startsWith("task:more:")), "1-b-2: page 2 disjoint, partial page has no more button");
    const s3 = mkS2();
    await resolveTaskCallback(env, cbO2(s3, "task:more:16", 1));
    check(String(s3.sent.at(-1)?.text ?? "") === "صفحه‌ی دیگری نیست." && btnData2(s3).includes("task:more:0"), "1-b-2: beyond-end renders no-more with a back button, no repeat of page 1");
    const s4 = mkS2();
    await resolveTaskCallback(env, cbO2(s4, "task:more:abc", 1));
    check(String(s4.sent.at(-1)?.text ?? "").split("\n").length === 8, "1-b-2: unparseable offset falls back to page 1");
    const s5 = mkS2();
    await resolveTaskCallback(env, cbO2(s5, "task:more:-3", 1));
    check(String(s5.sent.at(-1)?.text ?? "").split("\n").length === 8, "1-b-2: negative offset clamps to page 1");
  }
  // ✅: done + completed_at, leaves open list, appears in archive; markup removed.
  {
    const env = mkEnv1b2(), s = mkS2(), id = openId("صفحه 2");
    await resolveTaskCallback(env, cbO2(s, `task:done:${id}`, 1));
    const row = rows1b2("SELECT status, completed_at FROM tasks WHERE id = ?", [id])[0];
    check(row.status === "done" && !!row.completed_at && s.markup() === 1 && String(s.sent.at(-1)?.text ?? "").includes("انجام شد"), "1-b-2: done sets status + completed_at, removes markup");
    const sL = mkS2();
    await handleDailyText(env, mkO2(sL, "تسک هام", 1));
    check(!String(sL.sent.at(-1)?.text ?? "").includes("صفحه 2"), "1-b-2: done task leaves the open list");
    const sA = mkS2();
    await resolveTaskCallback(env, cbO2(sA, "task:arch:0", 1));
    check(String(sA.sent.at(-1)?.text ?? "").includes("صفحه 2"), "1-b-2: done task appears in the archive");
  }
  // Delete: deleted, leaves both lists; markup removed.
  {
    const env = mkEnv1b2(), s = mkS2(), id = openId("صفحه 3");
    await resolveTaskCallback(env, cbO2(s, `task:del:${id}`, 1));
    check(rows1b2("SELECT status FROM tasks WHERE id = ?", [id])[0].status === "deleted" && s.markup() === 1, "1-b-2: delete sets deleted, removes markup");
    const sA = mkS2();
    await resolveTaskCallback(env, cbO2(sA, "task:arch:0", 1));
    check(!String(sA.sent.at(-1)?.text ?? "").includes("صفحه 3"), "1-b-2: deleted task is in neither list");
  }
  // Archive: done-only, newest-first, never open/deleted; genuine empty vs failure distinct.
  {
    const env = mkEnv1b2(), s = mkS2();
    await resolveTaskCallback(env, cbO2(s, "task:arch:0", 1));
    const t = String(s.sent.at(-1)?.text ?? "");
    check(t.indexOf("تازه تمام") < t.indexOf("قدیمی تمام") && !t.includes("صفحه 1") && !t.includes("حذف‌شده"), "1-b-2: archive is done-only, newest-first");
    const failEnv = { ...mkEnv1b2(), DB: { prepare(sql) { if (/FROM tasks/i.test(sql)) throw new Error("boom"); return db1b2.prepare(sql); } } }, sF = mkS2();
    await resolveTaskCallback(failEnv, cbO2(sF, "task:arch:0", 1));
    check(String(sF.sent.at(-1)?.text ?? "") === "تسک‌ها خوانده نشد؛ دوباره تلاش کن" && !String(sF.sent.at(-1)?.text ?? "").includes("تمام"), "1-b-2: archive failure is honest, never an empty archive");
  }
  // Filter: only the chosen project's tasks; filtered more keeps the project; "همه" returns.
  {
    const env = mkEnv1b2(), s = mkS2();
    await resolveTaskCallback(env, cbO2(s, `task:proj:${karId2}:0`, 1));
    const t = String(s.sent.at(-1)?.text ?? "");
    check(t.includes("کاری ۱") && t.includes("کاری ۲") && !t.includes("صفحه 1"), "1-b-2: filter shows only the chosen project");
    check(btnData2(s).some((d) => d === "task:more:0"), "1-b-2: filtered page carries an all button");
    const sF = mkS2();
    await resolveTaskCallback(env, cbO2(sF, "task:proj:999999:0", 1));
    check(sF.sent.length === 0, "1-b-2: foreign/missing project filter is silent, no data, no filter");
    const sG = mkS2();
    await resolveTaskCallback(env, cbO2(sG, "task:proj:abc:0", 1));
    check(sG.sent.length === 0, "1-b-2: invalid project filter is silent");
  }
  // Callback ownership: foreign silent, consumed fixed-message, D1 failure keeps buttons, double-tap one transition.
  {
    const env = mkEnv1b2(), s = mkS2(), id = openId("صفحه 4"), other = openId("دیگری");
    await resolveTaskCallback(env, cbO2(s, `task:done:${id}`, 2));
    check(s.sent.length === 0 && s.markup() === 0 && rows1b2("SELECT status FROM tasks WHERE id = ?", [id])[0].status === "open", "1-b-2: foreign tap silent, no status change");
    check(rows1b2("SELECT status FROM tasks WHERE id = ?", [other])[0].status === "open", "1-b-2: other user's own task untouched by the foreign test");
    const sC = mkS2();
    await resolveTaskCallback(env, cbO2(sC, `task:done:${id}`, 1));
    await resolveTaskCallback(env, cbO2(sC, `task:done:${id}`, 1));
    check(rows1b2("SELECT status FROM tasks WHERE id = ?", [id])[0].status === "done" && sC.markup() === 2, "1-b-2: double-tap yields exactly one transition, second tap consumes");
    const failEnv = { ...mkEnv1b2(), DB: { prepare(sql) { if (/^UPDATE tasks/i.test(sql)) throw new Error("boom"); return db1b2.prepare(sql); } } }, sF = mkS2(), idF = openId("صفحه 5");
    await resolveTaskCallback(failEnv, cbO2(sF, `task:done:${idF}`, 1));
    check(String(sF.sent.at(-1)?.text ?? "").includes("ذخیره نشد") && sF.markup() === 0 && rows1b2("SELECT status FROM tasks WHERE id = ?", [idF])[0].status === "open", "1-b-2: D1 failure keeps buttons, failure reply, no change");
  }
  // 4096 split: page 2 holds a 5000-char title -> 3 sends, each <= 4096, keyboard on the last only.
  {
    sqlite1b2.exec(`INSERT INTO tasks (user_id, title, status, source, created_at) VALUES (1, '${"x".repeat(5000)}', 'open', 'text', '2026-10-30T00:00:00.000Z')`);
    const env = mkEnv1b2(), s = mkS2();
    await resolveTaskCallback(env, cbO2(s, "task:more:8", 1));
    check(s.sent.length === 3 && s.sent.every((m) => String(m.text ?? "").length <= 4096), "1-b-2: long list splits at 4096");
    check(!!s.sent.at(-1)?.replyMarkup && !s.sent.slice(0, -1).some((m) => m.replyMarkup), "1-b-2: keyboard rides on the last chunk only");
  }
  // Interpreter task query: bare -> open list with buttons; resolved project -> pre-filtered; period ignored, never claimed.
  {
    const env = mkEnv1b2(), s = mkS2();
    await handleDailyText(env, mkO2(s, "تسک‌هایم در هفته", 1, { interpreterCallFn: fakeInterp2([act2("query", { query: { kind: "task", periodText: "هفته", project: null } })]) }));
    const t = String(s.sent.at(-1)?.text ?? "");
    check(t.includes("صفحه 1") && !t.includes("هفته") && btnData2(s).some((d) => d.startsWith("task:done:")), "1-b-2: task query renders the list with buttons, period ignored and never claimed");
    const sP = mkS2();
    await handleDailyText(env, mkO2(sP, "تسک‌های کار", 1, { interpreterCallFn: fakeInterp2([act2("query", { query: { kind: "task", periodText: null, project: "کار" } })]) }));
    const tP = String(sP.sent.at(-1)?.text ?? "");
    check(tP.includes("کاری ۱") && !tP.includes("صفحه 1"), "1-b-2: task query with a resolved project pre-filters");
  }
  // Multi-action summary now carries task delete buttons (1-b-1 boundary closed); tap deletes.
  {
    const env = mkEnv1b2(), s = mkS2();
    await handleDailyText(env, mkO2(s, "چند مورد ۲", 1, { interpreterCallFn: fakeInterp2([act2("task", { text: "تسک چندگانه ۲" }), act2("note", { text: "یادداشت چندگانه ۲" })]) }));
    const delBtn = btnData2(s).find((d) => d.startsWith("task:del:"));
    check(!!delBtn && btnData2(s).some((d) => d.startsWith("interp:del:")), "1-b-2: multi summary carries task + note delete buttons");
    const sD = mkS2();
    await resolveTaskCallback(env, cbO2(sD, delBtn, 1));
    check(rows1b2("SELECT status FROM tasks WHERE title = 'تسک چندگانه ۲'")[0].status === "deleted", "1-b-2: multi summary task button deletes");
  }
  // ── Phase 1-b-3: task conversions, feedback, retry ──
  if (DatabaseSync) {
    const sqlite1b3 = new DatabaseSync(":memory:");
    sqlite1b3.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
    sqlite1b3.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sqlite1b3.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sqlite1b3.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1'), (2, '2')");
    sqlite1b3.exec("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (1, 'عمومی', '[]', 'active', 1, '2026-10-30T00:00:00.000Z'), (1, 'کار', '[]', 'active', 0, '2026-10-30T00:00:00.000Z')");
    const F3 = { notes: false, status: false, fb: false, batch: null, raceId: null };
    const base3 = (sql) => { const st = sqlite1b3.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
    const boom3 = () => ({ bind: () => ({ run: async () => { throw new Error("boom"); }, all: async () => { throw new Error("boom"); }, first: async () => { throw new Error("boom"); } }) });
    const db1b3 = { prepare(sql) { if (F3.notes && /INSERT INTO notes/i.test(sql)) return boom3(); if (F3.status && /UPDATE tasks SET status/i.test(sql)) return boom3(); if (F3.fb && /INSERT INTO intent_feedback/i.test(sql)) return boom3(); return base3(sql); }, batch: async (stmts) => { if (F3.batch === "all") throw new Error("boom"); const out = []; for (let i = 0; i < stmts.length; i++) { if (F3.batch === "stmt2" && i === 1) throw new Error("boom"); if (F3.raceId && i === 1) sqlite1b3.prepare("UPDATE tasks SET status = 'done', completed_at = '2026-10-31T00:00:00.000Z' WHERE id = ?").run(F3.raceId); out.push(await stmts[i].run()); } return out; } };
    const rows3 = (sql, params = []) => sqlite1b3.prepare(sql).all(...params);
    const NOW3 = Date.UTC(2026, 9, 31, 12, 0, 0);
    const mkEnv3 = (extra = {}) => ({ STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "1,2", DB: db1b3, ...extra });
    const mkS3 = () => { const sent = []; const chats = []; let markup = 0, chatFail = false; return { sent, chats, markup: () => markup, setChatFail: (v) => { chatFail = v; }, send: async (text, opts) => { sent.push({ text, replyMarkup: opts?.replyMarkup }); }, chat: async (text) => { if (chatFail) throw new Error("boom"); chats.push(text); }, editMarkup: async () => { markup++; } }; };
    const btn3 = (s) => s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
    const cbI3 = (s, data, userId) => ({ fromId: userId, userId, chatId: userId, data, send: s.send, editMarkup: s.editMarkup, chat: s.chat, nowMs: NOW3 });
    const cbD3 = (s, data, userId) => ({ fromId: userId, chatId: userId, data, send: s.send, editMarkup: s.editMarkup, chat: s.chat, nowMs: NOW3 });
    const mkO3 = (s, text, userId, extra = {}) => ({ chatId: userId, userId, text, send: s.send, chat: s.chat, nowMs: NOW3, ...extra });
    const act3 = (type, extra = {}) => ({ type, text: extra.text ?? "متن", project: extra.project ?? null, due_text: extra.due_text ?? null, remind_text: extra.remind_text ?? null, amount_text: extra.amount_text ?? null, query: extra.query ?? null, target: extra.target ?? null, confidence: extra.confidence ?? 0.9, needs: extra.needs ?? "none" });
    const fakeInterp3 = (actions) => async () => JSON.stringify(actions);
    const karId3 = rows3("SELECT id FROM projects WHERE user_id = 1 AND name = 'کار'")[0].id;
    const task3 = (title, userId = 1, projectId = null) => { sqlite1b3.prepare("INSERT INTO tasks (user_id, title, project_id, status, source, created_at) VALUES (?, ?, ?, 'open', 'text', '2026-10-30T00:00:00.000Z')").run(userId, title, projectId); return rows3("SELECT id FROM tasks WHERE title = ? AND user_id = ?", [title, userId])[0].id; };
    const tstatus3 = (id) => rows3("SELECT status FROM tasks WHERE id = ?", [id])[0]?.status;
    const conv3 = async (env, s, recId, choice) => { await resolveInterpCallback(env, cbI3(s, `interp:type:${choice}:${recId}`, 1)); };
    const seedConv3 = async (env, id, title, taskId, extra = {}) => { await env.STATE.put(`interp:${id}`, JSON.stringify({ owner: 1, text: title, changeTaskId: taskId, startedAtMs: Date.now() - 60000, ...extra })); };
    const retry3 = (s) => btn3(s).find((d) => d.startsWith("interp:retrytask:"));
    const lastText3 = (s) => String(s.sent.at(-1)?.text ?? "");
    // Stored-card change-type button end to end: card -> change -> note.
    {
      const env = mkEnv3(), s = mkS3();
      await handleDailyText(env, mkO3(s, "تسک یادداشتی", 1, { interpreterCallFn: fakeInterp3([act3("task", { text: "یادداشت تبدیلی" })]) }));
      const chg = btn3(s).find((d) => d.startsWith("interp:change:"));
      check(!!chg && btn3(s).some((d) => d.startsWith("task:del:")), "1-b-3: stored-task card carries change-type button");
      const s2 = mkS3();
      await resolveInterpCallback(env, cbI3(s2, chg, 1));
      const noteBtn = btn3(s2).find((d) => d.startsWith("interp:type:note:"));
      check(!!noteBtn && lastText3(s2).includes("نوعش را بگو"), "1-b-3: change tap offers type choices");
      const s3 = mkS3();
      await resolveInterpCallback(env, cbI3(s3, noteBtn, 1));
      check(lastText3(s3).includes("به یادداشت تبدیل شد") && rows3("SELECT COUNT(*) AS n FROM notes WHERE text = 'یادداشت تبدیلی'")[0].n === 1 && rows3("SELECT status FROM tasks WHERE title = 'یادداشت تبدیلی'")[0].status === "deleted", "1-b-3: card change to note stores note and deletes task");
    }
    // task->note: insert failure keeps task, retry stores once.
    {
      const env = mkEnv3(), s = mkS3(); const tid = task3("یادداشت خراب");
      await seedConv3(env, "n1", "یادداشت خراب", tid);
      F3.notes = true;
      await conv3(env, s, "n1", "note");
      check(lastText3(s).includes("ذخیره نشد") && !!retry3(s) && tstatus3(tid) === "open" && rows3("SELECT COUNT(*) AS n FROM notes WHERE text = 'یادداشت خراب'")[0].n === 0, "1-b-3: note insert failure keeps task, retry offered, nothing stored");
      F3.notes = false; const s2 = mkS3();
      await resolveInterpCallback(env, cbI3(s2, retry3(s), 1));
      check(lastText3(s2).includes("به یادداشت تبدیل شد") && rows3("SELECT COUNT(*) AS n FROM notes WHERE text = 'یادداشت خراب'")[0].n === 1 && tstatus3(tid) === "deleted", "1-b-3: note retry after insert failure stores once and deletes task");
    }
    // task->note: delete failure keeps both records, retry deletes only.
    {
      const env = mkEnv3(), s = mkS3(); const tid = task3("یادداشت حذف‌نشدنی");
      await seedConv3(env, "n2", "یادداشت حذف‌نشدنی", tid);
      F3.status = true;
      await conv3(env, s, "n2", "note");
      check(lastText3(s).includes("ذخیره نشد") && !!retry3(s) && tstatus3(tid) === "open" && rows3("SELECT COUNT(*) AS n FROM notes WHERE text = 'یادداشت حذف‌نشدنی'")[0].n === 1, "1-b-3: note delete failure keeps both records, retry offered");
      F3.status = false; const s2 = mkS3();
      await resolveInterpCallback(env, cbI3(s2, retry3(s), 1));
      check(lastText3(s2).includes("به یادداشت تبدیل شد") && rows3("SELECT COUNT(*) AS n FROM notes WHERE text = 'یادداشت حذف‌نشدنی'")[0].n === 1 && tstatus3(tid) === "deleted", "1-b-3: note retry deletes only, no duplicate note");
    }
    // task->note: concurrent delete before retry finalises as converted.
    {
      const env = mkEnv3(), s = mkS3(); const tid = task3("یادداشت رقابتی");
      await seedConv3(env, "n3", "یادداشت رقابتی", tid);
      F3.status = true;
      await conv3(env, s, "n3", "note");
      F3.status = false;
      sqlite1b3.prepare("UPDATE tasks SET status = 'deleted' WHERE id = ?").run(tid);
      const s2 = mkS3();
      await resolveInterpCallback(env, cbI3(s2, retry3(s), 1));
      check(lastText3(s2).includes("قبلاً ثبت شد یا مهلتش گذشته") && rows3("SELECT COUNT(*) AS n FROM notes WHERE text = 'یادداشت رقابتی'")[0].n === 1 && tstatus3(tid) === "deleted", "1-b-3: concurrent delete before note retry finalises as converted, no duplicate");
    }
    {
      const env = mkEnv3(), s = mkS3(); const tid = task3("یادداشت پذیرش");
      sqlite1b3.prepare("INSERT INTO notes (user_id, text, source, created_at) VALUES (1, 'یادداشت پذیرش', 'text', ?)").run(new Date().toISOString());
      await seedConv3(env, "n4", "یادداشت پذیرش", tid, { target: "note" });
      await resolveInterpCallback(env, cbI3(s, "interp:retrytask:n4", 1));
      check(lastText3(s).includes("به یادداشت تبدیل شد") && rows3("SELECT COUNT(*) AS n FROM notes WHERE text = 'یادداشت پذیرش'")[0].n === 1 && tstatus3(tid) === "deleted", "1-b-3: retry adopts the already-inserted note, no duplicate");
    }
    // task->chat: send failure keeps task, retry sends once.
    {
      const env = mkEnv3(), s = mkS3(); const tid = task3("چت خراب");
      await seedConv3(env, "c1", "چت خراب", tid);
      s.setChatFail(true);
      await conv3(env, s, "c1", "chat");
      check(lastText3(s).includes("ذخیره نشد") && !!retry3(s) && s.chats.length === 0 && tstatus3(tid) === "open", "1-b-3: chat send failure keeps task, retry offered, nothing sent");
      s.setChatFail(false); const s2 = mkS3();
      await resolveInterpCallback(env, cbI3(s2, retry3(s), 1));
      check(s2.chats.length === 1 && lastText3(s2).includes("به چت تبدیل شد") && tstatus3(tid) === "deleted", "1-b-3: chat retry after send failure sends once and deletes task");
    }
    // task->chat: delete failure keeps task, retry deletes only.
    {
      const env = mkEnv3(), s = mkS3(); const tid = task3("چت حذف‌نشدنی");
      await seedConv3(env, "c2", "چت حذف‌نشدنی", tid);
      F3.status = true;
      await conv3(env, s, "c2", "chat");
      check(lastText3(s).includes("فقط حذف انجام می‌شود") && !!retry3(s) && s.chats.length === 1 && tstatus3(tid) === "open", "1-b-3: chat delete failure keeps task, chat sent once, retry offered");
      F3.status = false; const s2 = mkS3();
      await resolveInterpCallback(env, cbI3(s2, retry3(s), 1));
      check(s2.chats.length === 0 && lastText3(s2).includes("به چت تبدیل شد") && tstatus3(tid) === "deleted", "1-b-3: chat retry deletes only, no re-send");
    }
    // task->chat: already deleted before retry finalises without re-sending.
    {
      const env = mkEnv3(), s = mkS3(); const tid = task3("چت رقابتی");
      await seedConv3(env, "c3", "چت رقابتی", tid);
      F3.status = true;
      await conv3(env, s, "c3", "chat");
      F3.status = false;
      sqlite1b3.prepare("UPDATE tasks SET status = 'deleted' WHERE id = ?").run(tid);
      const s2 = mkS3();
      await resolveInterpCallback(env, cbI3(s2, retry3(s), 1));
      check(s2.chats.length === 0 && lastText3(s2).includes("قبلاً ثبت شد یا مهلتش گذشته") && tstatus3(tid) === "deleted", "1-b-3: already-deleted chat retry finalises without re-sending");
    }
    // task->expense: confirm card, then Confirm stores once, task deleted.
    {
      const env = mkEnv3(), s = mkS3(); const tid = task3("نان خریدم 1500 تومن");
      await seedConv3(env, "e1", "نان خریدم 1500 تومن", tid);
      await conv3(env, s, "e1", "expense");
      const conf = btn3(s).find((d) => d.startsWith("daily:confirm:"));
      check(!!conf && lastText3(s).includes("1500"), "1-b-3: task to expense shows a confirm card with the rule amount");
      const s2 = mkS3();
      await resolveDailyCallback(env, cbD3(s2, conf, 1));
      check(lastText3(s2).includes("ثبت شد") && rows3("SELECT COUNT(*) AS n FROM expenses WHERE item = 'نان'")[0].n === 1 && tstatus3(tid) === "deleted", "1-b-3: expense confirm stores once and deletes task");
    }
    // task->expense: batch throw fails cleanly, retry stores once.
    {
      const env = mkEnv3(); const tid = task3("شیر خریدم 2000 تومن");
      await env.STATE.put("daily:draft:pd1", JSON.stringify({ owner: 1, type: "expense", amount: 2000, currency: "TOMAN", item: "شیر", date: "2026-10-31", taskId: tid }));
      F3.batch = "all";
      const r1 = await confirmExpenseDraft(env, 1, "pd1");
      check(r1.status === "failed" && rows3("SELECT COUNT(*) AS n FROM expenses WHERE item = 'شیر'")[0].n === 0 && (await env.STATE.get("daily:draft:pd1", "json")) !== null, "1-b-3: batch throw fails cleanly, draft kept, nothing stored");
      F3.batch = null;
      const r2 = await confirmExpenseDraft(env, 1, "pd1");
      check(r2.status === "ok" && rows3("SELECT COUNT(*) AS n FROM expenses WHERE item = 'شیر'")[0].n === 1 && tstatus3(tid) === "deleted" && (await env.STATE.get("daily:draft:pd1", "json")) === null, "1-b-3: retry after batch throw stores once and deletes task");
    }
    // task->expense: staged race (concurrent done inside batch) compensates.
    {
      const env = mkEnv3(), s = mkS3(); const tid = task3("کتاب خریدم 3000 تومن");
      await env.STATE.put("daily:draft:pd2", JSON.stringify({ owner: 1, type: "expense", amount: 3000, currency: "TOMAN", item: "کتاب", date: "2026-10-31", taskId: tid }));
      F3.raceId = tid;
      await resolveDailyCallback(env, cbD3(s, "daily:confirm:pd2", 1));
      F3.raceId = null;
      check(lastText3(s).includes("پیش‌تر جداگانه انجام شده بود") && rows3("SELECT COUNT(*) AS n FROM expenses WHERE item = 'کتاب'")[0].n === 1 && tstatus3(tid) === "done" && (await env.STATE.get("daily:draft:pd2", "json")) === null, "1-b-3: staged race compensates as converted-done, task stays done, expense once");
    }
    // task->expense: consumed before Confirm is missing; kept draft retries.
    {
      const env = mkEnv3(); const tid = task3("آب خریدم 500 تومن");
      await env.STATE.put("daily:draft:pd3", JSON.stringify({ owner: 1, type: "expense", amount: 500, currency: "TOMAN", item: "آب", date: "2026-10-31", taskId: tid }));
      sqlite1b3.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(tid);
      const r1 = await confirmExpenseDraft(env, 1, "pd3");
      check(r1.status === "missing" && rows3("SELECT COUNT(*) AS n FROM expenses WHERE item = 'آب'")[0].n === 0 && (await env.STATE.get("daily:draft:pd3", "json")) !== null, "1-b-3: consumed-before-confirm is missing, nothing inserted, draft kept");
      sqlite1b3.prepare("UPDATE tasks SET status = 'open' WHERE id = ?").run(tid);
      const r2 = await confirmExpenseDraft(env, 1, "pd3");
      check(r2.status === "ok" && rows3("SELECT COUNT(*) AS n FROM expenses WHERE item = 'آب'")[0].n === 1 && tstatus3(tid) === "deleted", "1-b-3: kept draft confirms after reopen");
    }
    // task->expense: foreign task draft is missing, nothing inserted.
    {
      const env = mkEnv3(); const tid2 = task3("مال دیگری", 2);
      await env.STATE.put("daily:draft:pd4", JSON.stringify({ owner: 1, type: "expense", amount: 700, currency: "TOMAN", item: "بیگانه", date: "2026-10-31", taskId: tid2 }));
      const r = await confirmExpenseDraft(env, 1, "pd4");
      check(r.status === "missing" && rows3("SELECT COUNT(*) AS n FROM expenses WHERE item = 'بیگانه'")[0].n === 0 && (await env.STATE.get("daily:draft:pd4", "json")) !== null, "1-b-3: foreign task draft is missing, nothing inserted, draft kept");
    }
    // task->expense: unextractable amount stops, task kept, no confirm, no feedback.
    {
      const env = mkEnv3(), s = mkS3(); const tid = task3("بدون مبلغ");
      await seedConv3(env, "e2", "بدون مبلغ", tid);
      await conv3(env, s, "e2", "expense");
      check(lastText3(s).includes("قابل استخراج نیست") && !btn3(s).some((d) => d.startsWith("daily:confirm:")) && tstatus3(tid) === "open" && rows3("SELECT COUNT(*) AS n FROM intent_feedback WHERE text = 'بدون مبلغ'")[0].n === 0, "1-b-3: unextractable task amount stops, task kept, no confirm, no feedback");
    }
    // task->expense: double Confirm stores one expense, second tap expired.
    {
      const env = mkEnv3(), s = mkS3(); const tid = task3("چای خریدم 800 تومن");
      await seedConv3(env, "e3", "چای خریدم 800 تومن", tid);
      await conv3(env, s, "e3", "expense");
      const conf = btn3(s).find((d) => d.startsWith("daily:confirm:"));
      const s2 = mkS3();
      await resolveDailyCallback(env, cbD3(s2, conf, 1));
      const s3 = mkS3();
      await resolveDailyCallback(env, cbD3(s3, conf, 1));
      check(rows3("SELECT COUNT(*) AS n FROM expenses WHERE item = 'چای'")[0].n === 1 && lastText3(s3).includes("قبلاً ثبت شد یا مهلتش گذشته") && tstatus3(tid) === "deleted", "1-b-3: double Confirm stores one expense, second tap expired");
    }
    // task->expense: removal failure keeps draft and task, retry deletes once.
    {
      const env = mkEnv3(); const tid = task3("قهوه خریدم 1200 تومن");
      await env.STATE.put("daily:draft:pd5", JSON.stringify({ owner: 1, type: "expense", amount: 1200, currency: "TOMAN", item: "قهوه", date: "2026-10-31", taskId: tid }));
      F3.batch = "stmt2";
      const r1 = await confirmExpenseDraft(env, 1, "pd5");
      check(r1.status === "failed" && rows3("SELECT COUNT(*) AS n FROM expenses WHERE item = 'قهوه'")[0].n === 1 && tstatus3(tid) === "open" && (await env.STATE.get("daily:draft:pd5", "json")) !== null, "1-b-3: removal failure keeps draft and task, expense already once");
      F3.batch = null;
      const r2 = await confirmExpenseDraft(env, 1, "pd5");
      check(r2.status === "ok" && rows3("SELECT COUNT(*) AS n FROM expenses WHERE item = 'قهوه'")[0].n === 1 && tstatus3(tid) === "deleted", "1-b-3: retry after removal failure deletes task, expense still once");
    }
    // Feedback: correct predicted/correct/project; failure leaves reply unchanged.
    {
      const env = mkEnv3(), s = mkS3(); const tid = task3("گزارش تبدیلی", 1, karId3);
      await seedConv3(env, "f1", "گزارش تبدیلی", tid);
      await conv3(env, s, "f1", "note");
      const fb = rows3("SELECT * FROM intent_feedback WHERE text = 'گزارش تبدیلی'");
      check(fb.length === 1 && fb[0].predicted_type === "task" && fb[0].correct_type === "note" && fb[0].project === "کار", "1-b-3: completed re-type records predicted/correct/project feedback");
      const s2 = mkS3(); const tid2 = task3("گزارش بی‌بازخورد");
      await seedConv3(env, "f2", "گزارش بی‌بازخورد", tid2);
      F3.fb = true;
      await conv3(env, s2, "f2", "note");
      F3.fb = false;
      check(lastText3(s2).includes("به یادداشت تبدیل شد") && tstatus3(tid2) === "deleted" && rows3("SELECT COUNT(*) AS n FROM intent_feedback WHERE text = 'گزارش بی‌بازخورد'")[0].n === 0, "1-b-3: feedback failure leaves the reply and conversion unchanged");
    }
    {
      const env = mkEnv3(), s = mkS3(); const tid = task3("تسک ماندنی");
      await seedConv3(env, "f3", "تسک ماندنی", tid);
      await conv3(env, s, "f3", "task");
      check(lastText3(s).includes("همین حالا تسک است") && tstatus3(tid) === "open" && rows3("SELECT COUNT(*) AS n FROM intent_feedback WHERE text = 'تسک ماندنی'")[0].n === 0, "1-b-3: task to task is a no-op, task kept, nothing recorded");
    }
    // Pre-storage taskdismiss drops the card only, never touches tasks.
    {
      const env = mkEnv3(), s = mkS3();
      await env.STATE.put("interp:td1", JSON.stringify({ owner: 1, text: "تسک قدیمی" }));
      await resolveInterpCallback(env, cbI3(s, "interp:taskdismiss:td1", 1));
      const s2 = mkS3();
      await resolveInterpCallback(env, cbI3(s2, "interp:taskdismiss:td1", 1));
      check(lastText3(s).includes("کنار گذاشته شد") && rows3("SELECT COUNT(*) AS n FROM tasks WHERE title = 'تسک قدیمی'")[0].n === 0 && rows3("SELECT status FROM tasks WHERE title = 'تسک ماندنی'")[0].status === "open" && lastText3(s2).includes("قبلاً ثبت شد یا مهلتش گذشته"), "1-b-3: pre-storage taskdismiss drops card only, tasks untouched, record consumed");
    }
    {
      const env = mkEnv3(), s = mkS3();
      await resolveInterpCallback(env, cbI3(s, "interp:retrytask:nosuch", 1));
      check(lastText3(s).includes("قبلاً ثبت شد یا مهلتش گذشته"), "1-b-3: missing conversion retry is expired");
      const tid = task3("تسک خارجی");
      await seedConv3(env, "r9", "تسک خارجی", tid, { target: "note" });
      const s2 = mkS3();
      await resolveInterpCallback(env, cbI3(s2, "interp:retrytask:r9", 2));
      check(s2.sent.length === 0 && tstatus3(tid) === "open", "1-b-3: foreign conversion retry is silent, task untouched");
    }
  }
  // ── Phase 1-b-4: task correction (UPDATE-only) ──
  if (DatabaseSync) {
    const sqlite1b4 = new DatabaseSync(":memory:");
    sqlite1b4.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
    sqlite1b4.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sqlite1b4.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sqlite1b4.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1'), (2, '2')");
    const base4 = (sql) => { const st = sqlite1b4.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
    const db1b4 = { prepare(sql) { return base4(sql); } };
    const rows4 = (sql, params = []) => sqlite1b4.prepare(sql).all(...params);
    const NOW4 = Date.UTC(2026, 9, 31, 12, 0, 0);
    const mkEnv4 = (extra = {}) => ({ STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "1,2", DB: db1b4, ...extra });
    const mkS4 = () => { const sent = []; const chats = []; let markup = 0; return { sent, chats, markup: () => markup, send: async (text, opts) => { sent.push({ text, replyMarkup: opts?.replyMarkup }); }, chat: async (text) => { chats.push(text); }, editMarkup: async () => { markup++; } }; };
    const mkO4 = (s, text, userId, extra = {}) => ({ chatId: userId, userId, text, send: s.send, chat: s.chat, nowMs: NOW4, ...extra });
    const act4 = (type, extra = {}) => ({ type, text: extra.text ?? "متن", project: extra.project ?? null, due_text: extra.due_text ?? null, remind_text: extra.remind_text ?? null, amount_text: extra.amount_text ?? null, query: extra.query ?? null, target: extra.target ?? null, confidence: extra.confidence ?? 0.9, needs: extra.needs ?? "none" });
    const fakeInterp4 = (actions) => async () => JSON.stringify(actions);
    const task4 = (title, userId = 1, extra = {}) => { sqlite1b4.prepare("INSERT INTO tasks (user_id, title, status, source, created_at, due_at, remind_at) VALUES (?, ?, ?, ?, '2026-10-30T00:00:00.000Z', ?, ?)").run(userId, title, extra.status ?? "open", extra.source ?? "text", extra.dueAt ?? null, extra.remindAt ?? null); return rows4("SELECT id FROM tasks WHERE title = ? AND user_id = ?", [title, userId])[0].id; };
    const lastText4 = (s) => String(s.sent.at(-1)?.text ?? "");
    const corr4 = async (env, s, text, extra = {}) => { await handleDailyText(env, mkO4(s, "اصلاحش کن", 1, { interpreterCallFn: fakeInterp4([act4("correction", { text, ...extra })]) })); };
    // Correction edits title/due/remind in place, id preserved, pointer refreshed.
    {
      const env = mkEnv4(), s = mkS4(); const tid = task4("تسک قدیمی");
      await env.STATE.put("interp:last-item:1", JSON.stringify({ table: "tasks", id: tid }));
      await corr4(env, s, "تسک تازه", { due_text: "فردا", remind_text: "فردا ساعت ۹" });
      const row = rows4("SELECT * FROM tasks WHERE id = ?", [tid])[0];
      const ptr = await env.STATE.get("interp:last-item:1", "json");
      check(lastText4(s).includes("تسک اصلاح شد") && row.title === "تسک تازه" && row.due_at === "2026-11-01T00:00:00+03:30" && row.remind_at === "2026-11-01T09:00:00+03:30" && row.status === "open" && ptr?.table === "tasks" && ptr?.id === tid && rows4("SELECT COUNT(*) AS n FROM tasks")[0].n === 1, "1-b-4: correction edits title/due/remind, id preserved, pointer refreshed");
    }
    // Foreign task: no edit, honest message.
    {
      const env = mkEnv4(), s = mkS4(); const tid = task4("مال دیگری", 2);
      await env.STATE.put("interp:last-item:1", JSON.stringify({ table: "tasks", id: tid }));
      await corr4(env, s, "دست‌کاری");
      check(lastText4(s).includes("۱۰ دقیقه") && rows4("SELECT title FROM tasks WHERE id = ?", [tid])[0].title === "مال دیگری", "1-b-4: foreign task correction edits nothing, honest message");
    }
    // Missing task: honest message, nothing written.
    {
      const env = mkEnv4(), s = mkS4();
      await env.STATE.put("interp:last-item:1", JSON.stringify({ table: "tasks", id: 99999 }));
      await corr4(env, s, "دست‌کاری");
      check(lastText4(s).includes("۱۰ دقیقه") && rows4("SELECT COUNT(*) AS n FROM tasks WHERE title = 'دست‌کاری'")[0].n === 0, "1-b-4: missing task correction writes nothing, honest message");
    }
    // Non-open task: no edit, honest message.
    {
      const env = mkEnv4(), s = mkS4(); const tid = task4("تسک تمام‌شده", 1, { status: "done" });
      await env.STATE.put("interp:last-item:1", JSON.stringify({ table: "tasks", id: tid }));
      await corr4(env, s, "دست‌کاری");
      const row = rows4("SELECT title, status FROM tasks WHERE id = ?", [tid])[0];
      check(lastText4(s).includes("باز نیست") && row.title === "تسک تمام‌شده" && row.status === "done", "1-b-4: non-open task correction edits nothing");
    }
    // Correction without time phrases preserves stored due/remind.
    {
      const env = mkEnv4(), s = mkS4(); const tid = task4("تسک زمان‌دار", 1, { dueAt: "2026-11-02T00:00:00+03:30", remindAt: "2026-11-02T09:00:00+03:30" });
      await env.STATE.put("interp:last-item:1", JSON.stringify({ table: "tasks", id: tid }));
      await corr4(env, s, "تسک زمان‌دار تازه");
      const row = rows4("SELECT title, due_at, remind_at FROM tasks WHERE id = ?", [tid])[0];
      check(row.title === "تسک زمان‌دار تازه" && row.due_at === "2026-11-02T00:00:00+03:30" && row.remind_at === "2026-11-02T09:00:00+03:30", "1-b-4: correction without time phrases preserves stored due/remind");
    }
    // Voice-created task corrects in place, source preserved.
    {
      const env = mkEnv4(), s = mkS4();
      await handleDailyText(env, mkO4(s, "تسک صوتی", 1, { source: "voice", interpreterCallFn: fakeInterp4([act4("task", { text: "تسک صوتی" })]) }));
      const row0 = rows4("SELECT id, source FROM tasks WHERE title = 'تسک صوتی'")[0];
      const s2 = mkS4();
      await corr4(env, s2, "تسک صوتی اصلاح‌شده");
      const row = rows4("SELECT title, source FROM tasks WHERE id = ?", [row0.id])[0];
      check(row0.source === "voice" && row.title === "تسک صوتی اصلاح‌شده" && row.source === "voice", "1-b-4: voice-created task corrects in place, source preserved");
    }
    // updateTaskFields validation: rejections leave the row byte-unchanged.
    {
      const tid = task4("تسک اعتبارسنجی", 1, { dueAt: "2026-11-02T00:00:00+03:30" });
      const before = JSON.stringify(rows4("SELECT * FROM tasks WHERE id = ?", [tid])[0]);
      check((await updateTaskFields(db1b4, 1, tid, { status: "done" })).ok === false, "1-b-4: unknown field rejected");
      check((await updateTaskFields(db1b4, 1, tid, { title: "   " })).ok === false, "1-b-4: empty title rejected");
      check((await updateTaskFields(db1b4, 1, tid, { dueAt: "tomorrow" })).ok === false, "1-b-4: non-ISO due rejected");
      check((await updateTaskFields(db1b4, 1, tid, { remindAt: "2026-13-99T99:99:99Z" })).ok === false, "1-b-4: impossible remind datetime rejected");
      check((await updateTaskFields(db1b4, 1, tid, {})).ok === false, "1-b-4: empty fields rejected");
      check((await updateTaskFields(db1b4, 2, tid, { title: "بیگانه" })).ok === false, "1-b-4: foreign user update rejected");
      check((await updateTaskFields(db1b4, 1, 99999, { title: "بیگانه" })).ok === false, "1-b-4: missing task update rejected");
      check(JSON.stringify(rows4("SELECT * FROM tasks WHERE id = ?", [tid])[0]) === before, "1-b-4: all rejected updates leave the row byte-unchanged");
      check((await updateTaskFields(db1b4, 1, tid, { title: "تسک اعتبارسنجی", dueAt: null })).ok === true, "1-b-4: null due clears the field");
      const after = rows4("SELECT title, due_at FROM tasks WHERE id = ?", [tid])[0];
      check(after.title === "تسک اعتبارسنجی" && after.due_at === null, "1-b-4: valid update applies, only the cleared field changes");
    }
    // D1 failure on correction: honest reply, row unchanged.
    {
      const env = mkEnv4(), s = mkS4(); const tid = task4("تسک خراب");
      await env.STATE.put("interp:last-item:1", JSON.stringify({ table: "tasks", id: tid }));
      const failEnv = { ...env, DB: { prepare(sql) { if (/UPDATE tasks SET/i.test(sql)) throw new Error("boom"); return db1b4.prepare(sql); } } };
      await corr4(failEnv, s, "دست‌کاری");
      check(lastText4(s).includes("ذخیره نشد") && rows4("SELECT title FROM tasks WHERE id = ?", [tid])[0].title === "تسک خراب", "1-b-4: D1 failure on correction is honest, row unchanged");
    }
  }
}

// ── Phase 1-c-1: list-prefix fix + reminder claim/release/snooze/purge ──
if (DatabaseSync) {
  const fresh1c1 = () => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1'), (2, '2')");
    const base = (sql) => { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
    return { sq, db: { prepare(sql) { return base(sql); } }, rows: (sql, params = []) => sq.prepare(sql).all(...params) };
  };
  const mkEnv1c1 = (db, extra = {}) => ({ STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "1,2", DB: db, ...extra });
  const mkS1c1 = () => { const sent = []; const chats = []; let markup = 0; return { sent, chats, markup: () => markup, send: async (text, opts) => { sent.push({ text, replyMarkup: opts?.replyMarkup }); }, chat: async (text) => { chats.push(text); }, editMarkup: async () => { markup++; } }; };
  const NOW1c1 = "2026-10-31T12:00:00.000Z";
  const seed1c1 = (sq, title, userId, extra = {}) => { sq.prepare("INSERT INTO tasks (user_id, title, status, source, created_at, completed_at, remind_at, reminded_at, remind_attempts) VALUES (?, ?, ?, 'text', ?, ?, ?, ?, ?)").run(userId, title, extra.status ?? "open", extra.createdAt ?? "2026-10-30T00:00:00.000Z", extra.completedAt ?? null, extra.remindAt ?? null, extra.remindedAt ?? null, extra.attempts ?? 0); return sq.prepare("SELECT id FROM tasks WHERE title = ? AND user_id = ?").all(title, userId)[0].id; };
  // List-prefix routing: every live-QA variant matches, bare forms never do.
  {
    const cl = (t) => classifyDaily(t, { nowMs: Date.UTC(2026, 9, 31, 12, 0, 0) }).intent;
    check(cl("لیست تسک‌هام") === "task-list" && cl("فهرست تسک‌هام") === "task-list" && cl("لیست تسک هام") === "task-list" && cl("لیست تسکهام") === "task-list" && cl("فهرست تسک هام") === "task-list" && cl("فهرست تسکهام") === "task-list" && cl("لیست تسک‌هایم") === "task-list" && cl("لیست تسک‌هام را نشان بده") === "task-list", "1-c-1: list prefixes route deterministically");
    check(cl("تسک") !== "task-list" && cl("لیست") !== "task-list" && cl("فهرست") !== "task-list" && cl("لیست تسک جدید") !== "task-list" && cl("تسک جدید") !== "task-list" && cl("لیست تسک‌هام جلسه") !== "task-list", "1-c-1: bare/ambiguous forms never auto-route");
  }
  // End-to-end: the previously-hallucinating input now renders the D1 list, zero chat calls.
  {
    const { sq, db, rows } = fresh1c1(); const env = mkEnv1c1(db), s = mkS1c1();
    seed1c1(sq, "کار لیستی", 1);
    await handleDailyText(env, { chatId: 1, userId: 1, text: "لیست تسک‌هام", send: s.send, chat: s.chat, nowMs: Date.UTC(2026, 9, 31, 12, 0, 0) });
    check(String(s.sent.at(-1)?.text ?? "").includes("کار لیستی") && s.chats.length === 0 && rows("SELECT COUNT(*) AS n FROM tasks")[0].n === 1, "1-c-1: list prefix renders D1 list, zero model calls");
  }
  // Atomic claiming: due+open only, no double-claim, done/future/max-attempt/no-remind/foreign excluded.
  {
    const { sq, db, rows } = fresh1c1();
    seed1c1(sq, "due", 1, { remindAt: "2026-10-31T11:00:00.000Z" });
    seed1c1(sq, "future", 1, { remindAt: "2026-10-31T13:00:00.000Z" });
    seed1c1(sq, "done-due", 1, { status: "done", remindAt: "2026-10-31T11:00:00.000Z", completedAt: "2026-10-31T10:00:00.000Z" });
    seed1c1(sq, "maxed", 1, { remindAt: "2026-10-31T11:00:00.000Z", attempts: 3 });
    seed1c1(sq, "no-remind", 1);
    seed1c1(sq, "foreign-due", 2, { remindAt: "2026-10-31T11:00:00.000Z" });
    const c1 = await claimDueReminders(db, NOW1c1, 20);
    check(c1.ok && c1.reminders.length === 2 && c1.reminders.map((r) => r.title).sort().join(",") === "due,foreign-due" && c1.reminders.every((r) => r.telegram_id === String(r.user_id) && r.remind_attempts === 1), "1-c-1: claim takes due open rows only, with owner telegram_id");
    check(rows("SELECT reminded_at FROM tasks WHERE title = 'due'")[0].reminded_at === NOW1c1, "1-c-1: claim stamps reminded_at");
    const c2 = await claimDueReminders(db, NOW1c1, 20);
    check(c2.ok && c2.reminders.length === 0, "1-c-1: second claim never double-claims");
  }
  // Limit 20 + order: 25 due rows -> 20 claimed (lowest ids), then the remaining 5.
  {
    const sq2 = new DatabaseSync(":memory:");
    sq2.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8")); sq2.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8")); sq2.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8")); sq2.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
    const b2 = (sql) => { const st = sq2.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
    const db2 = { prepare(sql) { return b2(sql); } };
    for (let i = 1; i <= 25; i++) sq2.prepare("INSERT INTO tasks (user_id, title, status, source, created_at, remind_at, remind_attempts) VALUES (1, ?, 'open', 'text', '2026-10-30T00:00:00.000Z', '2026-10-31T11:00:00.000Z', 0)").run(`bulk ${i}`);
    const c1 = await claimDueReminders(db2, NOW1c1, 20);
    const c2 = await claimDueReminders(db2, NOW1c1, 20);
    check(c1.reminders.length === 20 && c2.reminders.length === 5 && c1.reminders[0].title === "bulk 1" && c1.reminders[19].title === "bulk 20" && c2.reminders[0].title === "bulk 21", "1-c-1: claim respects limit 20, ordered by remind_at/id");
  }
  // Completing before remind_at cancels claiming.
  {
    const { sq, db } = fresh1c1();
    const tid = seed1c1(sq, "soon-done", 1, { remindAt: "2026-10-31T13:00:00.000Z" });
    check((await setTaskStatus(db, 1, tid, "done")).ok === true, "1-c-1: setup completes the task");
    const c = await claimDueReminders(db, "2026-10-31T14:00:00.000Z", 20);
    check(c.ok && c.reminders.length === 0, "1-c-1: task completed before remind_at is never claimed");
  }
  // Claim -> fail -> release -> 3-attempt ceiling.
  {
    const { sq, db, rows } = fresh1c1();
    const tid = seed1c1(sq, "flaky", 1, { remindAt: "2026-10-31T11:00:00.000Z" });
    check((await claimDueReminders(db, NOW1c1, 20)).reminders.length === 1 && rows("SELECT remind_attempts FROM tasks WHERE id = ?", [tid])[0].remind_attempts === 1, "1-c-1: first claim attempts 1");
    check((await releaseReminderClaim(db, tid)).ok === true && rows("SELECT reminded_at FROM tasks WHERE id = ?", [tid])[0].reminded_at === null && rows("SELECT remind_attempts FROM tasks WHERE id = ?", [tid])[0].remind_attempts === 1, "1-c-1: release clears reminded_at, preserves attempts");
    check((await claimDueReminders(db, NOW1c1, 20)).reminders.length === 1, "1-c-1: released claim retries");
    check((await releaseReminderClaim(db, tid)).ok === true && (await claimDueReminders(db, NOW1c1, 20)).reminders.length === 1 && rows("SELECT remind_attempts FROM tasks WHERE id = ?", [tid])[0].remind_attempts === 3, "1-c-1: third claim reaches the ceiling");
    check((await claimDueReminders(db, NOW1c1, 20)).reminders.length === 0, "1-c-1: attempts >= 3 stops claiming");
  }
  // Snooze: owner-scoped, attempts reset, foreign/non-open/invalid untouched.
  {
    const { sq, db, rows } = fresh1c1();
    const tid = seed1c1(sq, "snoozable", 1, { remindAt: "2026-10-31T11:00:00.000Z", remindedAt: NOW1c1, attempts: 2 });
    const done = seed1c1(sq, "snooze-done", 1, { status: "done", remindAt: "2026-10-31T11:00:00.000Z", completedAt: "2026-10-31T10:00:00.000Z" });
    const r = await snoozeTaskReminder(db, 1, tid, "2026-10-31T12:10:00.000Z");
    const row = rows("SELECT remind_at, reminded_at, remind_attempts FROM tasks WHERE id = ?", [tid])[0];
    check(r.ok === true && r.updated === true && row.remind_at === "2026-10-31T12:10:00.000Z" && row.reminded_at === null && row.remind_attempts === 0, "1-c-1: snooze resets time, clears claim, resets attempts");
    check((await snoozeTaskReminder(db, 2, tid, "2026-10-31T12:20:00.000Z")).updated === false && (await snoozeTaskReminder(db, 1, done, "2026-10-31T12:20:00.000Z")).updated === false && (await snoozeTaskReminder(db, 1, tid, "tomorrow")).ok === false && rows("SELECT remind_at FROM tasks WHERE id = ?", [tid])[0].remind_at === "2026-10-31T12:10:00.000Z", "1-c-1: foreign/non-open/invalid snooze leaves the row untouched");
  }
  // Purge: 30-day cutoff on done/deleted via completed_at, created_at fallback; open/recent kept.
  {
    const { sq, db, rows } = fresh1c1();
    seed1c1(sq, "old-done", 1, { status: "done", completedAt: "2026-09-15T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z" });
    seed1c1(sq, "old-deleted-fallback", 1, { status: "deleted", createdAt: "2026-09-01T00:00:00.000Z" });
    seed1c1(sq, "recent-done", 1, { status: "done", completedAt: "2026-10-20T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z" });
    seed1c1(sq, "old-open", 1, { createdAt: "2026-09-01T00:00:00.000Z" });
    const p = await purgeOldClosedTasks(db, "2026-10-01T00:00:00.000Z");
    check(p.ok === true && p.deleted === 2 && rows("SELECT title FROM tasks ORDER BY id").map((x) => x.title).join(",") === "recent-done,old-open", "1-c-1: purge deletes only old closed tasks");
  }
  // D1 failure shapes: honest {ok: false}, never a throw, never a fake empty success.
  {
    const { db } = fresh1c1();
    const failDb = { prepare(sql) { if (/UPDATE tasks SET reminded_at|DELETE FROM tasks|UPDATE tasks SET remind_at/i.test(sql)) throw new Error("boom"); return db.prepare(sql); } };
    check((await claimDueReminders(failDb, NOW1c1, 20)).ok === false && (await claimDueReminders(failDb, NOW1c1, 20)).reminders.length === 0, "1-c-1: claim D1 failure is honest");
    check((await releaseReminderClaim(failDb, 1)).ok === false && (await snoozeTaskReminder(failDb, 1, 1, "2026-10-31T12:10:00.000Z")).ok === false && (await purgeOldClosedTasks(failDb, "2026-10-01T00:00:00.000Z")).ok === false, "1-c-1: release/snooze/purge D1 failures are honest");
    check((await claimDueReminders(null, NOW1c1, 20)).ok === false && (await purgeOldClosedTasks(db, "not-a-date")).ok === false, "1-c-1: missing DB / bad cutoff rejected");
  }
}

// ── Phase 1-c-2: scheduled delivery, delayed label, snooze callback, active notice ──
if (DatabaseSync) {
  const fresh1c2 = () => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1'), (2, '2')");
    const base = (sql) => { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
    return { sq, db: { prepare(sql) { return base(sql); } }, rows: (sql, params = []) => sq.prepare(sql).all(...params) };
  };
  const seed1c2 = (sq, title, userId, extra = {}) => { sq.prepare("INSERT INTO tasks (user_id, title, status, source, created_at, completed_at, remind_at, reminded_at, remind_attempts) VALUES (?, ?, ?, 'text', ?, ?, ?, ?, ?)").run(userId, title, extra.status ?? "open", extra.createdAt ?? "2026-10-30T00:00:00.000Z", extra.completedAt ?? null, extra.remindAt ?? null, extra.remindedAt ?? null, extra.attempts ?? 0); return sq.prepare("SELECT id FROM tasks WHERE title = ? AND user_id = ?").all(title, userId)[0].id; };
  const mkEnv1c2 = (db, kv = fakeKV()) => ({ STATE: kv, TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "1,2", DB: db });
  const NOON1c2 = Date.UTC(2026, 9, 31, 12, 0, 0); // 12:00 UTC, not the purge slot
  const NOWISO1c2 = "2026-10-31T12:00:00.000Z";
  // Scheduled delivery: claim -> send -> buttons; second tick sends nothing.
  {
    const { sq, db, rows } = fresh1c2();
    const t1 = seed1c2(sq, "یادآوری یک", 1, { remindAt: "2026-10-31T11:59:00.000Z" });
    const t2 = seed1c2(sq, "یادآوری دو", 2, { remindAt: "2026-10-31T11:59:30.000Z" });
    const sent = [];
    const send = async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); };
    const r1 = await runReminderTick(mkEnv1c2(db), { nowIso: NOWISO1c2, scheduledTime: NOON1c2, sendMessage: send });
    const b1 = sent.find((m) => m.chatId === "1")?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
    check(r1.ok === true && r1.sent === 2 && r1.failed === 0 && r1.purged === null && sent.find((m) => m.chatId === "1")?.text === "⏰ یادآوری: یادآوری یک" && sent.find((m) => m.chatId === "2")?.text === "⏰ یادآوری: یادآوری دو" && b1.includes(`task:done:${t1}`) && b1.includes(`task:snooze:${t1}`) && b1.includes(`task:done:${t2}`) === false, "1-c-2: tick claims, sends with done/snooze buttons");
    check(rows("SELECT reminded_at FROM tasks WHERE id IN (?, ?)", [t1, t2]).every((x) => x.reminded_at === NOWISO1c2), "1-c-2: delivered rows stay claimed");
    const r2 = await runReminderTick(mkEnv1c2(db), { nowIso: NOWISO1c2, scheduledTime: NOON1c2, sendMessage: send });
    check(r2.sent === 0 && sent.length === 2, "1-c-2: second tick never re-sends claimed rows");
  }
  // Delayed label: > 5 min late -> delayed label; exactly 5 min -> normal label.
  {
    const { sq, db } = fresh1c2();
    seed1c2(sq, "دیرکرده", 1, { remindAt: "2026-10-31T11:54:59.000Z" });
    seed1c2(sq, "سر وقت", 1, { remindAt: "2026-10-31T11:55:00.000Z" });
    const sent = [];
    await runReminderTick(mkEnv1c2(db), { nowIso: NOWISO1c2, scheduledTime: NOON1c2, sendMessage: async (chatId, text) => { sent.push(text); } });
    check(sent.includes("⏰ یادآوری (با تاخیر): دیرکرده") && sent.includes("⏰ یادآوری: سر وقت"), "1-c-2: delayed label only past the 5-minute boundary");
  }
  // Send failure releases the claim; three strikes stop delivery, successes still send.
  {
    const { sq, db, rows } = fresh1c2();
    const flaky = seed1c2(sq, "ناپایدار", 1, { remindAt: "2026-10-31T11:00:00.000Z" });
    seed1c2(sq, "پایدار", 1, { remindAt: "2026-10-31T11:00:00.000Z" });
    const failSend = async (chatId, text) => { if (text.includes("ناپایدار")) throw new Error("tg down"); };
    const goodSend = async () => {};
    let r = await runReminderTick(mkEnv1c2(db), { nowIso: NOWISO1c2, scheduledTime: NOON1c2, sendMessage: failSend });
    check(r.sent === 1 && r.failed === 1 && rows("SELECT reminded_at, remind_attempts FROM tasks WHERE id = ?", [flaky])[0].reminded_at === null && rows("SELECT remind_attempts FROM tasks WHERE id = ?", [flaky])[0].remind_attempts === 1, "1-c-2: send failure releases the claim, attempts preserved");
    await runReminderTick(mkEnv1c2(db), { nowIso: NOWISO1c2, scheduledTime: NOON1c2, sendMessage: failSend });
    await runReminderTick(mkEnv1c2(db), { nowIso: NOWISO1c2, scheduledTime: NOON1c2, sendMessage: failSend });
    r = await runReminderTick(mkEnv1c2(db), { nowIso: NOWISO1c2, scheduledTime: NOON1c2, sendMessage: goodSend });
    check(r.sent === 0 && rows("SELECT remind_attempts FROM tasks WHERE id = ?", [flaky])[0].remind_attempts === 3, "1-c-2: three strikes stop delivery");
  }
  // Snooze callback Fix B states.
  {
    const { sq, db, rows } = fresh1c2();
    const env = mkEnv1c2(db);
    const mkCb = (data, userId, nowMs) => { const s = { sent: [], markup: 0 }; return { s, o: { fromId: userId, chatId: userId, data, nowMs, send: async (text) => { s.sent.push(text); }, editMarkup: async () => { s.markup++; }, chat: async () => {} } }; };
    const tid = seed1c2(sq, "قابل تعویق", 1, { remindAt: "2026-10-31T11:00:00.000Z" });
    const done = seed1c2(sq, "تمام‌شده", 1, { status: "done", remindAt: "2026-10-31T11:00:00.000Z", completedAt: "2026-10-31T10:00:00.000Z" });
    const other = seed1c2(sq, "دیگری", 2, { remindAt: "2026-10-31T11:00:00.000Z" });
    let c = mkCb(`task:snooze:${tid}`, 1, NOON1c2);
    await resolveTaskCallback(env, c.o);
    const row = rows("SELECT remind_at, reminded_at, remind_attempts FROM tasks WHERE id = ?", [tid])[0];
    check(c.s.sent[0] === "💤 یادآوری برای ۱۰ دقیقه‌ی دیگر تنظیم شد." && c.s.markup === 1 && row.remind_at === "2026-10-31T12:10:00.000Z" && row.reminded_at === null && row.remind_attempts === 0, "1-c-2: open snooze sets +10 min, removes buttons, exact reply");
    c = mkCb(`task:snooze:${other}`, 1, NOON1c2);
    await resolveTaskCallback(env, c.o);
    check(c.s.sent.length === 0 && c.s.markup === 0, "1-c-2: foreign snooze is silent");
    c = mkCb("task:snooze:abc", 1, NOON1c2);
    await resolveTaskCallback(env, c.o);
    check(c.s.sent.length === 0 && c.s.markup === 0, "1-c-2: invalid snooze id is silent");
    c = mkCb(`task:snooze:${done}`, 1, NOON1c2);
    await resolveTaskCallback(env, c.o);
    check(c.s.sent[0] === "قبلاً ثبت شد یا مهلتش گذشته" && c.s.markup === 1, "1-c-2: consumed snooze removes buttons, fixed message");
    const failEnv = { ...env, DB: { prepare(sql) { if (/SELECT .* FROM tasks WHERE id/i.test(sql)) throw new Error("boom"); return db.prepare(sql); } } };
    c = mkCb(`task:snooze:${tid}`, 1, NOON1c2);
    await resolveTaskCallback(failEnv, c.o);
    check(c.s.sent[0] === "ذخیره نشد، دوباره تلاش کن" && c.s.markup === 0, "1-c-2: snooze D1 failure keeps buttons, error notice");
  }
  // Daily purge inside the scheduled flow: 00:00 UTC tick purges, noon tick does not, zero KV writes.
  {
    const { sq, db, rows } = fresh1c2();
    seed1c2(sq, "قدیمی تمام", 1, { status: "done", completedAt: "2026-09-15T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z" });
    seed1c2(sq, "تازه تمام", 1, { status: "done", completedAt: "2026-10-20T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z" });
    const puts = [];
    const countingKV = { get: async () => null, put: async (k, v) => { puts.push(k); }, delete: async () => {} };
    const noon = await runReminderTick(mkEnv1c2(db, countingKV), { nowIso: "2026-10-31T12:00:00.000Z", scheduledTime: NOON1c2, sendMessage: async () => {} });
    check(noon.purged === null && rows("SELECT COUNT(*) AS n FROM tasks WHERE title = 'قدیمی تمام'")[0].n === 1, "1-c-2: noon tick never purges");
    const midnight = await runReminderTick(mkEnv1c2(db, countingKV), { nowIso: "2026-11-01T00:00:00.000Z", scheduledTime: Date.UTC(2026, 10, 1, 0, 0, 0), sendMessage: async () => {} });
    check(midnight.purged === 1 && rows("SELECT title FROM tasks ORDER BY id").map((x) => x.title).join(",") === "تازه تمام" && puts.length === 0, "1-c-2: 00:00 UTC tick purges old closed tasks, zero KV writes");
  }
  // Claim failure: tick reports ok false, sends nothing.
  {
    const { db } = fresh1c2();
    const failDb = { prepare(sql) { if (/UPDATE tasks SET reminded_at/i.test(sql)) throw new Error("boom"); return db.prepare(sql); } };
    const sent = [];
    const r = await runReminderTick({ DB: failDb }, { nowIso: NOWISO1c2, scheduledTime: NOON1c2, sendMessage: async (c, t) => { sent.push(t); } });
    check(r.ok === false && r.sent === 0 && sent.length === 0, "1-c-2: claim failure sends nothing, honest result");
  }
}

// ── Phase 1-c-3: offset-aware claiming + deterministic daypart slot fill ──
if (DatabaseSync) {
  const fresh1c3 = () => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1'), (2, '2')");
    const base = (sql) => { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
    return { sq, db: { prepare(sql) { return base(sql); } }, rows: (sql, params = []) => sq.prepare(sql).all(...params) };
  };
  const seed1c3 = (sq, title, userId, extra = {}) => { sq.prepare("INSERT INTO tasks (user_id, title, status, source, created_at, completed_at, remind_at, reminded_at, remind_attempts) VALUES (?, ?, ?, 'text', ?, ?, ?, ?, ?)").run(userId, title, extra.status ?? "open", extra.createdAt ?? "2026-10-30T00:00:00.000Z", extra.completedAt ?? null, extra.remindAt ?? null, extra.remindedAt ?? null, extra.attempts ?? 0); return sq.prepare("SELECT id FROM tasks WHERE title = ? AND user_id = ?").all(title, userId)[0].id; };
  // Cross-midnight claim: a +03:30 row due at 01:24 Tehran claims exactly
  // at its true UTC instant (21:54Z), not one minute earlier.
  {
    const { sq, db, rows } = fresh1c3();
    const id = seed1c3(sq, "cross-midnight", 1, { remindAt: "2026-11-02T01:24:00+03:30" });
    const early = await claimDueReminders(db, "2026-11-01T21:53:00.000Z", 20);
    check(early.ok === true && early.reminders.length === 0, "1-c-3: +03:30 row NOT claimed one minute before its true instant");
    const onTime = await claimDueReminders(db, "2026-11-01T21:54:00.000Z", 20);
    check(onTime.ok === true && onTime.reminders.length === 1 && onTime.reminders[0].id === id && rows("SELECT reminded_at, remind_attempts FROM tasks WHERE id = ?", [id])[0].reminded_at === "2026-11-01T21:54:00.000Z", "1-c-3: +03:30 row claimed exactly at its true UTC instant");
  }
  // Mixed-format ordering follows true chronological instant, not string
  // order. ORDER BY decides WHICH rows the limit takes (RETURNING order
  // itself is not guaranteed by SQLite), so the test binds limit 1: the
  // offset row is earlier in real time (21:54Z) than the Z row (22:30Z)
  // although its string sorts later — old string ordering would claim
  // the Z row first.
  {
    const { sq, db } = fresh1c3();
    seed1c3(sq, "z-later", 1, { remindAt: "2026-11-01T22:30:00.000Z" });
    seed1c3(sq, "offset-earlier", 1, { remindAt: "2026-11-02T01:24:00+03:30" });
    const one = await claimDueReminders(db, "2026-11-01T23:00:00.000Z", 1);
    check(one.ok === true && one.reminders.length === 1 && one.reminders[0].remind_at === "2026-11-02T01:24:00+03:30", "1-c-3: with limit 1, the earliest true instant claims first across offset/Z forms");
    const rest = await claimDueReminders(db, "2026-11-01T23:00:00.000Z", 20);
    check(rest.ok === true && rest.reminders.length === 1 && rest.reminders[0].remind_at === "2026-11-01T22:30:00.000Z", "1-c-3: second claim takes the remaining row, no double-claim");
  }
  // Purge cutoff is offset-safe: an offset-stored completion before the Z
  // cutoff purges, while a recent Z-form completion survives.
  {
    const { sq, db, rows } = fresh1c3();
    seed1c3(sq, "offset-old", 1, { status: "done", completedAt: "2026-10-01T01:00:00+03:30" });
    seed1c3(sq, "recent", 1, { status: "done", completedAt: "2026-10-31T00:00:00.000Z" });
    const p = await purgeOldClosedTasks(db, "2026-10-01T00:00:00.000Z");
    check(p.ok === true && p.deleted === 1 && rows("SELECT title FROM tasks")[0].title === "recent", "1-c-3: purge cutoff compares true instants across offset/Z forms");
  }
  // Ambiguous-hour follow-ups end to end, zero model calls: the env
  // carries no ROUTER_KEY and no interpreter function, and the chat stub
  // records any call (it must stay at zero).
  const mkEnv1c3 = (db, kv) => ({ STATE: kv, TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "1,2", DB: db });
  const mkS1c3 = () => { const sent = []; const chats = []; return { sent, chats, send: async (text) => { sent.push(text); }, chat: async (text) => { chats.push(text); } }; };
  const T1646 = Date.UTC(2026, 10, 1, 21, 46, 0); // 01:16 Tehran, Nov 2
  const flow1c3 = async (followup) => {
    const { db, rows } = fresh1c3();
    const kv = fakeKV(); const env = mkEnv1c3(db, kv); const s = mkS1c3();
    const msg = (text) => ({ chatId: 1, userId: 1, text, send: s.send, chat: s.chat, nowMs: T1646 });
    await handleDailyText(env, msg("یادآوری کن امروز ساعت ۰1:17 تست کرون فاز یک ج"));
    const asked = s.sent.at(-1);
    await handleDailyText(env, msg(followup));
    return { s, rows, kv, asked };
  };
  {
    const { s, rows, kv, asked } = await flow1c3("صبح");
    const t = rows("SELECT remind_at, title FROM tasks WHERE user_id = 1");
    check(asked === "ساعت را با صبح یا عصر مشخص کن." && s.sent.at(-1) === "⏰ یادآوری به‌عنوان تسک ذخیره شد." && s.chats.length === 0 && t.length === 1 && t[0].remind_at === "2026-11-02T01:17:00+03:30" && t[0].title === "تست کرون فاز یک ج" && !kv.store.has("daily:pending-ask:1"), "1-c-3: bare صبح fills the pending hour, stores 01:17+03:30, clears slot, zero model calls");
  }
  {
    const { s, rows, kv } = await flow1c3("01:17 صبح");
    const t = rows("SELECT remind_at FROM tasks WHERE user_id = 1");
    check(s.sent.at(-1) === "⏰ یادآوری به‌عنوان تسک ذخیره شد." && s.chats.length === 0 && t.length === 1 && t[0].remind_at === "2026-11-02T01:17:00+03:30" && !kv.store.has("daily:pending-ask:1"), "1-c-3: 01:17 صبح without ساعت fills the pending hour, zero model calls");
  }
  {
    // A brand-new list query while the slot is pending routes to the
    // list, never trapped in the pending loop.
    const { sq, db } = fresh1c3();
    seed1c3(sq, "کار لیستی", 1);
    const kv = fakeKV(); const env = mkEnv1c3(db, kv); const s = mkS1c3();
    const msg = (text) => ({ chatId: 1, userId: 1, text, send: s.send, chat: s.chat, nowMs: T1646 });
    await handleDailyText(env, msg("یادآوری کن امروز ساعت ۰1:17 تست کرون فاز یک ج"));
    await handleDailyText(env, msg("لیست تسک‌هام"));
    check(String(s.sent.at(-1) ?? "").includes("کار لیستی") && s.chats.length === 0, "1-c-3: لیست تسک‌هام while slot pending routes to the list, not trapped");
  }
  {
    // A non-matching follow-up stores nothing and falls through to the
    // existing routing unchanged.
    const { rows } = await flow1c3("سلام");
    check(rows("SELECT COUNT(*) AS n FROM tasks WHERE user_id = 1")[0].n === 0, "1-c-3: non-matching follow-up stores no task");
  }
}

// ── Phase 1-d-1: no /dev loop, no 80-token classifier misfires, multi-turn chat ──
{
  // buildChatContext keeps prior assistant + user turns, oldest first.
  const built = buildChatContext([
    { role: "user", content: "سلام" },
    { role: "assistant", content: "سلام! چطور می‌توانم کمک کنم؟" },
    { role: "user", content: "ادامه بده" },
    { role: "assistant", content: "حتماً." },
  ]);
  check(built.length === 4 && built[0].role === "user" && built[1].role === "assistant" && built[2].role === "user" && built[3].role === "assistant" && built[1].content.includes("کمک"), "1-d-1: buildChatContext keeps prior assistant + user turns in order");
  // Quick-convert keyboard: exactly the two qconv buttons for the message id, no text.
  const kb = quickConvertKeyboard(42);
  check(kb.length === 1 && kb[0].length === 2 && kb[0][0].text === "📝 ذخیره یادداشت" && kb[0][0].callback_data === "qconv:note:42" && kb[0][1].text === "☑️ ثبت تسک" && kb[0][1].callback_data === "qconv:task:42", "1-d-1: quickConvertKeyboard carries the two qconv buttons for the message id");
}
if (DatabaseSync) {
  const fresh1d1 = () => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
    const base = (sql) => { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
    return { sq, db: { prepare(sql) { return base(sql); } }, rows: (sql, params = []) => sq.prepare(sql).all(...params) };
  };
  // Two consecutive technical free-text turns: both reach chat, zero
  // model calls (env HAS a ROUTER_KEY and fetch counts — the old path
  // would have called classifyDailyWithModel for each turn), no /dev
  // suggestion, entries saved as chat for multi-turn context.
  {
    const { db, rows } = fresh1d1();
    const kv = fakeKV(); const env = { STATE: kv, DB: db, ROUTER_KEY: "fake-key" };
    const sent = []; const chats = [];
    const msg = (text) => ({ chatId: 1, userId: 1, text, send: async (t) => { sent.push(t); }, chat: async (t) => { chats.push(t); }, nowMs: Date.UTC(2026, 10, 2, 12, 0, 0) });
    const realFetch = globalThis.fetch; let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls++; throw new Error("must not fetch"); };
    let r1, r2;
    try {
      r1 = await handleDailyText(env, msg("explain how Workers KV caching works"));
      r2 = await handleDailyText(env, msg("and how do I add a health endpoint to the worker"));
    } finally { globalThis.fetch = realFetch; }
    const kinds = rows("SELECT role, kind FROM messages WHERE user_id = 1 ORDER BY id");
    check(r1 === "chat" && r2 === "chat" && fetchCalls === 0 && chats.length === 0 && sent.length === 0 && kinds.length === 2 && kinds.every((r) => r.role === "user" && r.kind === "chat"), "1-d-1: consecutive technical turns both reach chat, zero model calls, entries saved as chat");
  }
  // A model dev verdict no longer blocks: runModelBranch returns
  // chat-direct with no suggestion sent.
  {
    const kv = fakeKV(); const env = { STATE: kv, ROUTER_KEY: "fake-key" };
    const sent = []; const chats = [];
    const o = { userId: 1, text: "add a health endpoint to the worker", send: async (t) => { sent.push(t); }, chat: async (t) => { chats.push(t); } };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"intent":"dev","followup":null}' } }] }) });
    let res;
    try { res = await runModelBranch(env, o, { intent: "chat" }, { now: Date.UTC(2026, 10, 2, 12, 0, 0), remembered: "TOMAN" }); } finally { globalThis.fetch = realFetch; }
    check(res.ret === "chat-direct" && sent.length === 0 && !sent.join("").includes("/dev"), "1-d-1: model dev verdict flows to chat-direct, no /dev suggestion sent");
  }
  // Ask-tier keeps the model path (it matched a deterministic rule):
  // a model failure falls back to the rule ask, still handled.
  {
    const { db } = fresh1d1();
    const kv = fakeKV(); const env = { STATE: kv, DB: db, ROUTER_KEY: "fake-key" };
    const sent = []; const chats = [];
    const realFetch = globalThis.fetch; let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls++; throw new Error("boom"); };
    let r;
    try { r = await handleDailyText(env, { chatId: 1, userId: 1, text: "۵۰۰۰ تومان", send: async (t) => { sent.push(t); }, chat: async (t) => { chats.push(t); }, nowMs: Date.UTC(2026, 10, 2, 12, 0, 0) }); } finally { globalThis.fetch = realFetch; }
    check(r === "handled" && fetchCalls === 1 && chats.length === 0 && sent.length === 1 && sent[0] === askText("expense-or-chat"), "1-d-1: ask-tier keeps the model path; a model failure falls back to the rule ask");
  }
}

// ── Phase 1-d-2: natural projects, deterministic tasks, folder tagging ──
{
  // Pure classifier + tag extraction (no D1).
  const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
  const cl = (s) => classifyDaily(s, { nowMs: NOW });
  check(cl("پروژه گلبهار رو بساز").intent === "project-create" && cl("پروژه گلبهار رو بساز").name === "گلبهار", "1-d-2: project-create رو-form keeps the name");
  check(cl("پروژه جدید: سفر").name === "سفر" && cl("یه پروژه جدید تعریف کن به اسم سفر").name === "سفر", "1-d-2: project-create colon + phrase forms");
  check(cl("پروژه‌هام").intent === "project-list" && cl("لیست پروژه‌ها").intent === "project-list" && cl("پروژه‌های من").intent === "project-list", "1-d-2: project-list joined forms");
  check(cl("تسک: خرید نان").intent === "task-create" && cl("تسک: خرید نان").text === "خرید نان" && cl("به تسک‌هام اضافه کن: کتاب").text === "کتاب", "1-d-2: task-create prefixes");
  check(cl("تسک: خریدم نان ۵۰۰ تومان").intent === "task-create", "1-d-2: explicit task prefix wins over expense inference");
  const tS = extractFolderTag("توی پروژه گلبهار یادداشت کن خرید نان"), tE = extractFolderTag("یادداشت کن خرید نان در پروژه گل"), tM = extractFolderTag("یادداشت کن خرید نان توی پروژه گلبهار فردا"), tB = extractFolderTag("توی پروژه گلبهار");
  check(tS?.at === "start" && tS.rest === "گلبهار یادداشت کن خرید نان" && tE?.at === "end" && tE.body === "یادداشت کن خرید نان" && tE.name === "گل", "1-d-2: folder tag start/end extraction");
  check(tM?.at === "end" && tM.name === "گلبهار فردا" && tB?.at === "start" && tB.rest === "گلبهار", "1-d-2: folder tag tail is the whole trailing name; bare tag still extracts");
}
if (DatabaseSync) {
  const fresh1d2 = () => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
    const base = (sql) => { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
    return { sq, db: { prepare(sql) { return base(sql); } }, rows: (sql, params = []) => sq.prepare(sql).all(...params) };
  };
  const seedProj = (sq, name, aliases = [], isDefault = 0) => { sq.prepare("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (1, ?, ?, 'active', ?, '2026-11-01T00:00:00.000Z')").run(name, JSON.stringify(aliases), isDefault); return sq.prepare("SELECT id FROM projects WHERE user_id = 1 AND name = ?").all(name)[0].id; };
  const mkEnv1d2 = (db, kv) => ({ STATE: kv, DB: db });
  const mkS1d2 = () => { const sent = []; const chats = []; return { sent, chats, send: async (t) => { sent.push(t); }, chat: async (t) => { chats.push(t); } }; };
  const T = Date.UTC(2026, 10, 2, 12, 0, 0);
  const flow1d2 = async (text, seed = true) => {
    const { sq, db, rows } = fresh1d2();
    let gol = null, om = null;
    if (seed) { om = seedProj(sq, "عمومی", [], 1); gol = seedProj(sq, "گلبهار", ["گل"]); }
    const kv = fakeKV(); const env = mkEnv1d2(db, kv); const s = mkS1d2();
    const r = await handleDailyText(env, { chatId: 1, userId: 1, text, send: s.send, chat: s.chat, nowMs: T });
    return { r, s, rows, gol, om };
  };
  // insertProject: new + duplicate name/alias/normalized + empty + bad user + D1 error.
  {
    const { sq, db, rows } = fresh1d2();
    seedProj(sq, "عمومی", [], 1); seedProj(sq, "گلبهار", ["گل"]);
    const n = await insertProject(db, 1, "سفر");
    check(n.ok === true && n.created === true && n.project.name === "سفر" && n.project.status === "active" && n.project.is_default === 0 && rows("SELECT COUNT(*) AS c FROM projects WHERE user_id = 1")[0].c === 3, "1-d-2: insertProject inserts active non-default");
    const d1 = await insertProject(db, 1, "گلبهار");
    const d2 = await insertProject(db, 1, "گل");
    const d3 = await insertProject(db, 1, "  گلبهار  ");
    check(d1.ok === true && d1.created === false && d1.duplicate === true && d1.project.name === "گلبهار" && d2.duplicate === true && d2.project.name === "گلبهار" && d3.duplicate === true, "1-d-2: insertProject duplicates on name, alias, and normalized name");
    check((await insertProject(db, 1, "   ")).ok === false && (await insertProject(db, "nope", "x")).ok === false, "1-d-2: insertProject rejects empty name and bad user");
    const badDb = { prepare() { throw new Error("boom"); } };
    check((await insertProject(badDb, 1, "x")).ok === false, "1-d-2: insertProject D1 error -> ok:false");
  }
  // Natural project creation + duplicate via the rule tier.
  {
    const { s, rows } = await flow1d2("پروژه جدید: سفر");
    check(s.sent.at(-1) === "📁 پروژه «سفر» ساخته شد." && rows("SELECT name FROM projects WHERE user_id = 1 AND name = 'سفر'").length === 1, "1-d-2: natural project creation stores + confirms");
    const f2 = await flow1d2("پروژه گلبهار رو بساز");
    check(f2.s.sent.at(-1) === "📁 پروژه «گلبهار» از قبل وجود دارد.", "1-d-2: natural duplicate project reports already-exists");
  }
  // Project listing: seeded list + empty list.
  {
    const { s } = await flow1d2("پروژه‌هام");
    check(s.sent.at(-1) === "📁 پروژه‌ها:\n📁 عمومی\n📁 گلبهار", "1-d-2: project list renders the folder list");
    const e = await flow1d2("لیست پروژه‌ها", false);
    check(e.s.sent.at(-1) === "پروژه‌ای پیدا نشد.", "1-d-2: empty project list reports none");
    const badEnv = { STATE: fakeKV(), DB: { prepare() { throw new Error("boom"); } } };
    const bs = mkS1d2();
    const br = await handleDailyText(badEnv, { chatId: 1, userId: 1, text: "پروژه‌هام", send: bs.send, chat: bs.chat, nowMs: T });
    check(br === "handled" && bs.sent.at(-1) === "پروژه‌ها خوانده نشد؛ دوباره تلاش کن.", "1-d-2: project-list D1 failure reports a read failure, never an empty list");
  }
  // Deterministic task creation, zero model calls (counting fetch stub throws).
  {
    const { db, rows } = fresh1d2();
    const kv = fakeKV(); const env = mkEnv1d2(db, kv); const s = mkS1d2();
    const realFetch = globalThis.fetch; let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls++; throw new Error("must not fetch"); };
    let r;
    try { r = await handleDailyText(env, { chatId: 1, userId: 1, text: "تسک: خرید نان", send: s.send, chat: s.chat, nowMs: T }); } finally { globalThis.fetch = realFetch; }
    check(r === "handled" && fetchCalls === 0 && s.chats.length === 0 && s.sent.at(-1) === "✅ تسک ثبت شد." && rows("SELECT title, project_id FROM tasks WHERE user_id = 1")[0].title === "خرید نان", "1-d-2: deterministic task creation, zero model calls");
  }
  // Folder tagging: note end-form (گلبهار), task end-form (new project), reminder start-form (گلبهار), alias -> canonical name.
  {
    const { s, rows, gol } = await flow1d2("یادداشت کن خرید نان توی پروژه گلبهار");
    const n = rows("SELECT text, project_id FROM notes WHERE user_id = 1")[0];
    check(s.sent.at(-1) === "✅ یادداشت ذخیره شد. [📁 گلبهار]" && n.text === "خرید نان" && n.project_id === gol, "1-d-2: note end-form tag attaches گلبهار + badge");
    const f2 = await flow1d2("یادداشت کن تماس با علی در پروژه گل");
    const n2 = f2.rows("SELECT text, project_id FROM notes WHERE user_id = 1")[0];
    check(f2.s.sent.at(-1) === "✅ یادداشت ذخیره شد. [📁 گلبهار]" && n2.project_id === f2.gol, "1-d-2: alias گل resolves to canonical گلبهار");
  }
  {
    const { sq, db, rows } = fresh1d2();
    seedProj(sq, "عمومی", [], 1); const safar = seedProj(sq, "سفر", []);
    const kv = fakeKV(); const env = mkEnv1d2(db, kv); const s = mkS1d2();
    await handleDailyText(env, { chatId: 1, userId: 1, text: "تسک: تماس با علی توی پروژه سفر", send: s.send, chat: s.chat, nowMs: T });
    const t = rows("SELECT title, project_id FROM tasks WHERE user_id = 1")[0];
    check(s.sent.at(-1) === "✅ تسک ثبت شد. [📁 سفر]" && t.title === "تماس با علی" && t.project_id === safar, "1-d-2: task end-form tag attaches a newly created project");
  }
  {
    const { s, rows, gol } = await flow1d2("توی پروژه گلبهار یادآوری کن فردا ساعت ۹ تمرین");
    const t = rows("SELECT title, remind_at, project_id FROM tasks WHERE user_id = 1")[0];
    check(s.sent.at(-1) === "⏰ یادآوری به‌عنوان تسک ذخیره شد. [📁 گلبهار]" && t.title === "تمرین" && t.remind_at === "2026-11-03T09:00:00+03:30" && t.project_id === gol, "1-d-2: reminder start-form tag attaches گلبهار + keeps the due time");
  }
  // No-tag guards: an UNKNOWN project stores plain, no badge;
  // untagged note keeps the default + exact old reply. (Phase 2-b
  // supersedes the known-project half of the old middle-phrase guard:
  // a colon-less middle phrase with a KNOWN project now resolves by
  // boundary matching — body keeps the trailing word, badge attaches.
  // The unknown-project guard below is unchanged.)
  {
    const { s, rows, gol } = await flow1d2("یادداشت کن خرید نان توی پروژه گلبهار فردا");
    const n = rows("SELECT text, project_id FROM notes WHERE user_id = 1")[0];
    check(s.sent.at(-1) === "✅ یادداشت ذخیره شد. [📁 گلبهار]" && n.text === "خرید نان فردا" && n.project_id === gol, "1-d-2 (2-b update): known-project middle phrase now tags; note keeps trailing word + گلبهار badge");
    const f2 = await flow1d2("یادداشت کن خرید نان توی پروژه ناشناخته");
    check(!f2.s.sent.at(-1).includes("[📁"), "1-d-2: unknown project does not tag");
    const f3 = await flow1d2("یادداشت کن خرید نان");
    const n3 = f3.rows("SELECT project_id FROM notes WHERE user_id = 1")[0];
    check(f3.s.sent.at(-1) === "✅ یادداشت ذخیره شد." && n3.project_id === f3.om, "1-d-2: untagged note keeps default project + exact old reply");
  }
}

// ── Phase 1-d-3: rich notes (filtering, Jalali + badge display, paging, delete) ──
{
  const NOW = Date.UTC(2026, 10, 2, 12, 0, 0); // Tehran 2026-11-02 15:30
  const cl = (s) => classifyDaily(s, { nowMs: NOW });
  check(cl("لیست یادداشت‌ها").intent === "note-query" && cl("لیست یادداشت‌ها").date == null && cl("لیست یادداشت‌ها").projectName == null, "1-d-3: list form queries all notes");
  check(cl("یادداشت‌های پروژه گلبهار").projectName === "گلبهار" && cl("یادداشت‌های گل").projectName === "گل" && cl("یادداشت‌های پروژه گل را نشان بده").projectName === "گل", "1-d-3: project forms incl. show-verb strip");
  check(cl("یادداشت‌های قرارها و ملاقات‌ها").projectName === "قرارها و ملاقات ها", "1-d-3: multi-word project name survives normalization");
  check(cl("یادداشت‌های امروز").date === "2026-11-02" && cl("یادداشت‌های دیروز").date === "2026-11-01" && cl("لیست یادداشت‌های دیروز").date === "2026-11-01", "1-d-3: date forms map to Tehran days");
  check(cl("یادداشت‌های من").projectName == null && cl("یادداشتهامو نشون بده").intent === "note-query" && cl("یادداشتهایم را نشان بده").projectName == null, "1-d-3: possessive forms stay unfiltered; joined transcription still queries");
  check(cl("یادداشت کن خرید نان").intent === "note" && cl("یادداشت‌هایم دیروز").date === "2026-11-01", "1-d-3: note creation not stolen; date word beats a possessive tail");
}
if (DatabaseSync) {
  const fresh1d3 = () => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1'), (2, '2')");
    const base = (sql) => { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
    return { sq, db: { prepare(sql) { return base(sql); } }, rows: (sql, params = []) => sq.prepare(sql).all(...params) };
  };
  const seedProj3 = (sq, uid, name, aliases = [], isDefault = 0) => { sq.prepare("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (?, ?, ?, 'active', ?, '2026-11-01T00:00:00.000Z')").run(uid, name, JSON.stringify(aliases), isDefault); return sq.prepare("SELECT id FROM projects WHERE user_id = ? AND name = ?").all(uid, name)[0].id; };
  const seedNote3 = (sq, uid, text, pid, created) => { sq.prepare("INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (?, ?, 'text', ?, ?)").run(uid, text, created, pid); return sq.prepare("SELECT id FROM notes WHERE user_id = ? AND text = ?").all(uid, text)[0].id; };
  const mkS1d3 = () => { const sent = []; let edits = 0; return { sent, edits: () => edits, send: async (t, opts) => { sent.push({ text: t, opts }); }, chat: async () => {}, editMarkup: async () => { edits++; } }; };
  const T = Date.UTC(2026, 10, 2, 12, 0, 0);
  // 9 notes for user 1: 3 Tehran-today (mixed +03:30/Z), 2 Tehran-yesterday (mixed), 4 older; mixed projects.
  const scenario3 = () => {
    const { sq, db, rows } = fresh1d3();
    const om = seedProj3(sq, 1, "عمومی", [], 1), gol = seedProj3(sq, 1, "گلبهار", ["گل"]);
    const foreignProj = seedProj3(sq, 2, "بیگانه", []);
    const ids = {};
    ids.a = seedNote3(sq, 1, "صبحانه امروز", gol, "2026-11-02T01:24:00+03:30");
    ids.b = seedNote3(sq, 1, "تماس امروز", null, "2026-11-01T23:00:00Z");
    ids.c = seedNote3(sq, 1, "خرید امروز", om, "2026-11-02T10:00:00Z");
    ids.d = seedNote3(sq, 1, "جلسه دیروز", gol, "2026-11-01T05:00:00+03:30");
    ids.e = seedNote3(sq, 1, "کتاب دیروز", null, "2026-10-31T22:00:00Z");
    ids.f = seedNote3(sq, 1, "قدیمی یک", null, "2026-10-30T09:00:00+03:30");
    ids.g = seedNote3(sq, 1, "قدیمی دو", gol, "2026-10-29T09:00:00+03:30");
    ids.h = seedNote3(sq, 1, "قدیمی سه", null, "2026-10-28T09:00:00+03:30");
    ids.i = seedNote3(sq, 1, "قدیمی چهار", null, "2026-10-27T09:00:00+03:30");
    const foreignNote = seedNote3(sq, 2, "مال دیگری", null, "2026-11-02T08:00:00+03:30");
    return { sq, db, rows, om, gol, foreignProj, ids, foreignNote };
  };
  const flow3 = async (sc, text) => { const s = mkS1d3(); const r = await handleDailyText({ STATE: fakeKV(), DB: sc.db }, { chatId: 1, userId: 1, text, send: s.send, chat: s.chat, nowMs: T }); return { r, s }; };
  const tap3 = async (sc, data, fromId = 1) => { const s = mkS1d3(); const r = await resolveNoteCallback({ STATE: fakeKV(), DB: sc.db }, { fromId, data, send: s.send, editMarkup: s.editMarkup, nowMs: T }); return { r, s }; };
  const kbOf = (s) => s.sent.at(-1)?.opts?.replyMarkup?.inline_keyboard ?? [];
  const flatKb = (s) => kbOf(s).flat().map((b) => b.callback_data);
  // listNotesResult: newest-first, paging, project + Tehran-day filters, failure vs empty.
  {
    const sc = scenario3();
    const all = await listNotesResult(sc.db, 1);
    check(all.ok === true && all.notes.length === 8 && all.notes[0].text === "قدیمی چهار" && all.notes[7].text === "تماس امروز" && all.notes[0].id != null && all.notes[0].project_id !== undefined && all.notes[0].created_at, "1-d-3: listNotesResult newest-first, 8/page, full row shape");
    const p2 = await listNotesResult(sc.db, 1, { offset: 8 });
    check(p2.notes.length === 1 && p2.notes[0].text === "صبحانه امروز", "1-d-3: listNotesResult offset page holds the oldest note");
    const gp = await listNotesResult(sc.db, 1, { projectId: sc.gol });
    check(gp.notes.length === 3 && gp.notes.every((n) => n.project_id === sc.gol), "1-d-3: listNotesResult project filter");
    const today = await listNotesResult(sc.db, 1, { sinceIso: "2026-11-01T20:30:00.000Z", untilIso: "2026-11-02T20:30:00.000Z" });
    const yday = await listNotesResult(sc.db, 1, { sinceIso: "2026-10-31T20:30:00.000Z", untilIso: "2026-11-01T20:30:00.000Z" });
    check(today.notes.length === 3 && today.notes.some((n) => n.text === "صبحانه امروز") && today.notes.some((n) => n.text === "تماس امروز") && yday.notes.length === 2, "1-d-3: Tehran-day filter normalizes mixed +03:30/Z created_at");
    const bad = await listNotesResult({ prepare() { throw new Error("boom"); } }, 1);
    const empty = await listNotesResult(sc.db, 1, { projectId: sc.foreignProj });
    check(bad.ok === false && bad.notes.length === 0 && empty.ok === true && empty.notes.length === 0, "1-d-3: listNotesResult failure vs empty distinguished");
  }
  // deleteNote: own, foreign, invalid, D1 error.
  {
    const sc = scenario3();
    const d = await deleteNote(sc.db, 1, sc.ids.f);
    const foreign = await deleteNote(sc.db, 1, sc.foreignNote);
    check(d.ok === true && d.deleted === true && sc.rows("SELECT COUNT(*) AS c FROM notes WHERE id = ?", [sc.ids.f])[0].c === 0, "1-d-3: deleteNote removes the own note");
    check(foreign.ok === true && foreign.deleted === false && sc.rows("SELECT COUNT(*) AS c FROM notes WHERE id = ?", [sc.foreignNote])[0].c === 1, "1-d-3: deleteNote refuses a foreign note, row remains");
    check((await deleteNote(sc.db, 1, 0)).ok === false && (await deleteNote(sc.db, 1, 1.5)).ok === false && (await deleteNote(sc.db, 1, "x")).ok === false, "1-d-3: deleteNote rejects invalid ids");
    check((await deleteNote({ prepare() { throw new Error("boom"); } }, 1, 1)).ok === false, "1-d-3: deleteNote D1 error -> ok:false");
  }
  // Rich branch render: numbering, Jalali + Tehran time, badge, 8/page + more button.
  {
    const sc = scenario3();
    const { s } = await flow3(sc, "یادداشت‌هام");
    const first = s.sent[0].text;
    check(first.startsWith("📖 #1 · ") && first.includes("۵ آبان ۱۴۰۵") && first.includes("09:00") && first.includes("قدیمی چهار") && first.includes("📁 گلبهار"), "1-d-3: first row renders title-only number + Jalali + Tehran time; a project note carries its badge");
    check(first.includes("📖 #8") && !first.includes("📖 #9") && flatKb(s).includes("note:more:all:8") && flatKb(s).some((c) => c.startsWith("note:del:")), "1-d-3: first page holds 8 rows with delete + more buttons");
  }
  // Date + project filters via the branch; unknown project; empty; D1 failure.
  {
    const sc = scenario3();
    const t = await flow3(sc, "یادداشت‌های امروز");
    check(t.s.sent[0].text.includes("صبحانه امروز") && t.s.sent[0].text.includes("تماس امروز") && !t.s.sent[0].text.includes("جلسه دیروز"), "1-d-3: today filter shows only Tehran-today notes");
    const y = await flow3(sc, "یادداشت‌های دیروز");
    check(y.s.sent[0].text.includes("جلسه دیروز") && y.s.sent[0].text.includes("کتاب دیروز") && !y.s.sent[0].text.includes("صبحانه امروز"), "1-d-3: yesterday filter shows only Tehran-yesterday notes");
    const g = await flow3(sc, "یادداشت‌های پروژه گل");
    check(g.s.sent[0].text.includes("صبحانه امروز") && !g.s.sent[0].text.includes("تماس امروز"), "1-d-3: alias project filter resolves to the canonical project");
    const nf = await flow3(sc, "یادداشت‌های پروژه ناشناخته");
    check(nf.s.sent[0].text === "📁 پروژه «ناشناخته» پیدا نشد.", "1-d-3: unknown project reports not-found, never an empty list");
    const e = await flow3(fresh1d3(), "یادداشت‌هام");
    check(e.s.sent[0].text === "یادداشتی پیدا نشد.", "1-d-3: empty store keeps the exact old empty text");
    const badS = mkS1d3();
    await handleDailyText({ STATE: fakeKV(), DB: { prepare() { throw new Error("boom"); } } }, { chatId: 1, userId: 1, text: "یادداشت‌هام", send: badS.send, chat: badS.chat, nowMs: T });
    check(badS.sent[0].text === "یادداشت‌ها خوانده نشد؛ دوباره تلاش کن.", "1-d-3: branch D1 failure reports a read failure");
  }
  // Callbacks: paging, project filter + all, foreign silence, delete + markup removal, date paging.
  {
    const sc = scenario3();
    const pg = await tap3(sc, "note:more:all:8");
    check(pg.s.sent[0].text.startsWith("📖 #9 · ") && pg.s.sent[0].text.includes("صبحانه امروز") && pg.s.sent[0].text.includes("۱۱ آبان ۱۴۰۵") && pg.s.sent[0].text.includes("01:24") && pg.s.sent[0].text.includes("📁 گلبهار") && !flatKb(pg.s).some((c) => c.startsWith("note:more:")), "1-d-3: page 2 renders the oldest note title (Jalali + Tehran time + badge) with no more button");
    const pf = await tap3(sc, `note:proj:${sc.gol}`);
    check(pf.s.sent[0].text.includes("صبحانه امروز") && !pf.s.sent[0].text.includes("تماس امروز") && flatKb(pf.s).includes("note:proj:all"), "1-d-3: project filter tap shows only that project + an all button");
    const pa = await tap3(sc, "note:proj:all");
    check(pa.s.sent[0].text.includes("تماس امروز"), "1-d-3: all button restores the unfiltered list");
    const fs = await tap3(sc, `note:proj:${sc.foreignProj}`);
    const fdel = await tap3(sc, `note:del:${sc.foreignNote}`);
    check(fs.s.sent.length === 0 && fdel.s.sent.length === 0, "1-d-3: foreign project filter and foreign delete stay silent");
    const del = await tap3(sc, `note:del:${sc.ids.f}`);
    check(del.s.sent[0].text === "🗑 یادداشت حذف شد." && del.s.edits() === 1 && sc.rows("SELECT COUNT(*) AS c FROM notes WHERE id = ?", [sc.ids.f])[0].c === 0, "1-d-3: own delete confirms, removes markup, deletes the row");
    const dp = await tap3(sc, "note:more:all:0:2026-11-01");
    check(dp.s.sent[0].text.includes("جلسه دیروز") && !dp.s.sent[0].text.includes("صبحانه امروز"), "1-d-3: date filter survives paging via the 4th callback segment");
    const be = await tap3(sc, "note:more:all:16");
    check(be.s.sent[0].text === "صفحه‌ی دیگری نیست." && flatKb(be.s).includes("note:more:all:0"), "1-d-3: beyond-end page reports no further page + back button");
    const badDel = mkS1d3();
    await resolveNoteCallback({ STATE: fakeKV(), DB: { prepare() { throw new Error("boom"); } } }, { fromId: 1, data: `note:del:${sc.ids.g}`, send: badDel.send, editMarkup: badDel.editMarkup, nowMs: T });
    check(badDel.sent[0].text === "ذخیره نشد، دوباره تلاش کن" && badDel.edits() === 0, "1-d-3: delete D1 failure reports failure, buttons kept");
  }
}

// ── Phase 1-d-4: D1-grounded summary & table over notes & tasks ──
{
  const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
  const cl = (s) => classifyDaily(s, { nowMs: NOW });
  check(cl("یادداشت‌هام رو خلاصه کن").intent === "summary" && cl("یادداشت‌هام رو خلاصه کن").kind === "note" && cl("یادداشت‌هام رو خلاصه کن").projectName == null, "1-d-4: bare note summary");
  check(cl("یادداشت‌های گلبهار رو خلاصه کن").kind === "note" && cl("یادداشت‌های گلبهار رو خلاصه کن").projectName === "گلبهار", "1-d-4: project note summary");
  check(cl("یادداشت‌های پروژه گل رو جدول کن").projectName === "گل" && cl("تسک‌های گلبهار رو خلاصه و جدول کن").kind === "task" && cl("تسک‌های گلبهار رو خلاصه و جدول کن").projectName === "گلبهار", "1-d-4: alias + combined-verb + task summary forms");
  check(cl("تسک‌هام رو جدول کن").intent !== "summary" && cl("یادداشت‌های امروز رو خلاصه کن").projectName == null, "1-d-4: bare task request is not a summary (spec lists task summaries as project forms only); bare date word degrades to unfiltered");
  check(cl("خلاصه کن").intent !== "summary" && cl("یادداشت کن خرید نان").intent === "note" && cl("یادداشت‌های گلبهار").intent === "note-query", "1-d-4: no subject / note creation / plain query not stolen by summary");
}
if (DatabaseSync) {
  const fresh1d4 = () => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1'), (2, '2')");
    const base = (sql) => { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
    return { sq, db: { prepare(sql) { return base(sql); } }, rows: (sql, params = []) => sq.prepare(sql).all(...params) };
  };
  const seedProj4 = (sq, uid, name, aliases = [], isDefault = 0) => { sq.prepare("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (?, ?, ?, 'active', ?, '2026-11-01T00:00:00.000Z')").run(uid, name, JSON.stringify(aliases), isDefault); return sq.prepare("SELECT id FROM projects WHERE user_id = ? AND name = ?").all(uid, name)[0].id; };
  const mkS1d4 = () => { const sent = []; const chats = []; let edits = 0; return { sent, chats, edits: () => edits, send: async (t, opts) => { sent.push({ text: t, opts }); }, chat: async (t, copts) => { chats.push({ text: t, opts: copts }); }, editMarkup: async () => { edits++; } }; };
  const T = Date.UTC(2026, 10, 2, 12, 0, 0);
  const scenario4 = () => {
    const { sq, db, rows } = fresh1d4();
    const om = seedProj4(sq, 1, "عمومی", [], 1), gol = seedProj4(sq, 1, "گلبهار", ["گل"]);
    const foreignProj = seedProj4(sq, 2, "بیگانه", []);
    sq.prepare("INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (1, 'صبحانه گلبهار', 'text', '2026-11-02T01:24:00+03:30', ?)").run(gol);
    sq.prepare("INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (1, 'تماس عمومی', 'text', '2026-11-01T23:00:00Z', ?)").run(om);
    sq.prepare("INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (1, 'بدون پروژه', 'text', '2026-11-02T10:00:00Z', NULL)").run();
    sq.prepare("INSERT INTO tasks (user_id, title, status, project_id, remind_at, created_at) VALUES (1, 'تمرین گلبهار', 'open', ?, '2026-11-03T09:00:00+03:30', '2026-11-02T00:00:00Z')").run(gol);
    sq.prepare("INSERT INTO tasks (user_id, title, status, project_id, created_at) VALUES (1, 'خرید عمومی', 'open', ?, '2026-11-02T00:00:00Z')").run(om);
    return { sq, db, rows, om, gol, foreignProj };
  };
  const flow4 = async (sc, text) => { const s = mkS1d4(); const r = await handleDailyText({ STATE: fakeKV(), DB: sc.db }, { chatId: 1, userId: 1, text, send: s.send, chat: s.chat, nowMs: T }); return { r, s }; };
  const tap4 = async (sc, data, resolver, fromId = 1) => { const s = mkS1d4(); const r = await resolver({ STATE: fakeKV(), DB: sc.db }, { fromId, data, send: s.send, chat: s.chat, editMarkup: s.editMarkup, nowMs: T }); return { r, s }; };
  const kbOf4 = (s) => s.sent.at(-1)?.opts?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
  // Grounded note summary: only the project's verified rows, Jalali dates, strict chat options.
  {
    const sc = scenario4();
    const { s } = await flow4(sc, "یادداشت‌های گلبهار رو خلاصه کن");
    check(s.chats.length === 1 && s.chats[0].text.includes("صبحانه گلبهار") && !s.chats[0].text.includes("تماس عمومی") && !s.chats[0].text.includes("بدون پروژه"), "1-d-4: project note summary passes ONLY that project's rows");
    check(s.chats[0].text.includes("۱۱ آبان ۱۴۰۵") && s.chats[0].opts.systemPrompt && s.chats[0].opts.noHistory === true && s.chats[0].opts.saveText === "" && s.chats[0].opts.maxTokens === 2200, "1-d-4: summary input carries Jalali dates + grounded chat options (noHistory, no save, 2200 tokens — Phase 2-f spec change from 900)");
    const all = await flow4(sc, "یادداشت‌هام رو خلاصه کن");
    check(all.s.chats.length === 1 && all.s.chats[0].text.includes("صبحانه گلبهار") && all.s.chats[0].text.includes("تماس عمومی") && all.s.chats[0].text.includes("بدون پروژه"), "1-d-4: unfiltered note summary passes all rows");
  }
  // Task summary, empty zero-model-call, D1 failure zero-model-call, unknown project.
  {
    const sc = scenario4();
    const t = await flow4(sc, "تسک‌های گلبهار رو جدول کن");
    check(t.s.chats.length === 1 && t.s.chats[0].text.includes("تمرین گلبهار") && !t.s.chats[0].text.includes("خرید عمومی") && t.s.chats[0].text.includes("یادآوری"), "1-d-4: project task summary passes only that project's open tasks + remind time");
    const e = await flow4(fresh1d4(), "یادداشت‌هام رو خلاصه کن");
    check(e.s.sent[0].text === "موردی برای خلاصه‌سازی پیدا نشد." && e.s.chats.length === 0, "1-d-4: empty folder reports none found with zero model calls");
    const bad = mkS1d4();
    await handleDailyText({ STATE: fakeKV(), DB: { prepare() { throw new Error("boom"); } } }, { chatId: 1, userId: 1, text: "یادداشت‌هام رو خلاصه کن", send: bad.send, chat: bad.chat, nowMs: T });
    check(bad.sent[0].text === "یادداشت‌ها خوانده نشد؛ دوباره تلاش کن." && bad.chats.length === 0, "1-d-4: D1 failure reports a read failure with zero model calls");
    const nf = await flow4(sc, "یادداشت‌های پروژه ناشناخته رو خلاصه کن");
    check(nf.s.sent[0].text === "📁 پروژه «ناشناخته» پیدا نشد." && nf.s.chats.length === 0, "1-d-4: unknown project reports not-found with zero model calls");
  }
  // 30-row cap + inline buttons + callback triggers (incl. foreign silence).
  {
    const { sq, db } = fresh1d4();
    seedProj4(sq, 1, "عمومی", [], 1);
    for (let i = 1; i <= 31; i++) sq.prepare("INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (1, ?, 'text', '2026-11-02T00:00:00Z', NULL)").run(`یادداشت ${i}`);
    const s = mkS1d4();
    await handleDailyText({ STATE: fakeKV(), DB: db }, { chatId: 1, userId: 1, text: "یادداشت‌هام رو خلاصه کن", send: s.send, chat: s.chat, nowMs: T });
    check(s.chats[0].text.includes("30. ") && !s.chats[0].text.includes("31. "), "1-d-4: summary caps at 30 rows");
    const sc = scenario4();
    const nl = await flow4(sc, "یادداشت‌هام");
    check(kbOf4(nl.s).includes("note:sum:all"), "1-d-4: note list card carries the summary button");
    const tl = await flow4(sc, "لیست تسک‌هام");
    check(kbOf4(tl.s).includes("task:sum:all"), "1-d-4: task list card carries the summary button");
    const ns = await tap4(sc, "note:sum:all", resolveNoteCallback);
    check(ns.s.chats.length === 1 && ns.s.chats[0].text.includes("صبحانه گلبهار"), "1-d-4: note summary button triggers a grounded summary");
    const ts = await tap4(sc, `task:sum:${sc.gol}`, resolveTaskCallback);
    check(ts.s.chats.length === 1 && ts.s.chats[0].text.includes("تمرین گلبهار") && !ts.s.chats[0].text.includes("خرید عمومی"), "1-d-4: task summary button triggers a project-scoped summary");
    const fs = await tap4(sc, `note:sum:${sc.foreignProj}`, resolveNoteCallback);
    check(fs.s.sent.length === 0 && fs.s.chats.length === 0, "1-d-4: foreign project summary tap stays silent");
  }
}

// ── Phase 1-d-5: voice echo, 1-tap quick convert, stage failure notice ──
{
  // Pure failure-notice helper: stage label, detail lines, button shapes.
  const n1 = chatFailureNotice("چت", "targetA: 500", { retryEntryId: 42, quickConvertId: 42 });
  const n1kb = n1.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data);
  check(n1.text === "❌ مرحله‌ی چت شکست خورد.\ntargetA: 500" && n1kb.includes("chat:retry:42") && n1kb.includes("qconv:note:42") && n1kb.includes("qconv:task:42"), "1-d-5: failure notice names the stage + retry + quick-convert buttons");
  const n2 = chatFailureNotice("خلاصه‌سازی", null, { retryData: "note:sum:all" });
  check(n2.text === "❌ مرحله‌ی خلاصه‌سازی شکست خورد." && n2.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data).includes("note:sum:all"), "1-d-5: summary failure notice carries a re-tap retry button");
  const n3 = chatFailureNotice("چت", null, {});
  check(n3.replyMarkup === undefined, "1-d-5: failure notice without ids carries no buttons");
}
if (DatabaseSync) {
  const fresh1d5 = () => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1'), (2, '2')");
    const base = (sql) => { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
    return { sq, db: { prepare(sql) { return base(sql); } }, rows: (sql, params = []) => sq.prepare(sql).all(...params) };
  };
  const seedProj5 = (sq, uid, name, isDefault = 0) => { sq.prepare("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (?, ?, '[]', 'active', ?, '2026-11-01T00:00:00.000Z')").run(uid, name, isDefault); return sq.prepare("SELECT id FROM projects WHERE user_id = ? AND name = ?").all(uid, name)[0].id; };
  const mkS1d5 = () => { const sent = []; const chats = []; let edits = 0; return { sent, chats, edits: () => edits, send: async (t, opts) => { sent.push({ text: t, opts }); }, chat: async (t, copts) => { chats.push({ text: t, opts: copts }); }, editMarkup: async () => { edits++; } }; };
  const T = Date.UTC(2026, 10, 2, 12, 0, 0);
  // getMessageRow: own, foreign, invalid, D1 error.
  {
    const { sq, db, rows } = fresh1d5();
    await saveMessage(db, { userId: 1, role: "user", content: "متن من", kind: "chat" });
    await saveMessage(db, { userId: 2, role: "user", content: "مال دیگری", kind: "chat" });
    const mine = rows("SELECT id FROM messages WHERE user_id = 1")[0].id;
    const theirs = rows("SELECT id FROM messages WHERE user_id = 2")[0].id;
    const g1 = await getMessageRow(db, 1, mine);
    const g2 = await getMessageRow(db, 1, theirs);
    check(g1.ok === true && g1.row.content === "متن من" && g1.row.role === "user" && g2.ok === true && g2.row === null, "1-d-5: getMessageRow returns the own row, null for a foreign row");
    check((await getMessageRow(db, 1, 0)).ok === false && (await getMessageRow(db, 1, 1.5)).ok === false && (await getMessageRow({ prepare() { throw new Error("boom"); } }, 1, 1)).ok === false, "1-d-5: getMessageRow rejects invalid ids and D1 errors");
  }
  // Voice header on daily replies: first send only.
  {
    const { sq, db, rows } = fresh1d5();
    const s = mkS1d5();
    const header = "🎙 «یادداشت کن خرید نان»\n\n";
    await handleDailyText({ STATE: fakeKV(), DB: db }, { chatId: 1, userId: 1, text: "یادداشت کن خرید نان", send: s.send, chat: s.chat, nowMs: T, source: "voice", voiceHeader: header });
    check(s.sent[0].text === `${header}✅ یادداشت ذخیره شد.`, "1-d-5: voice daily reply prepends the transcript echo");
    const long = "x".repeat(3000);
    sq.prepare("INSERT INTO notes (user_id, text, source, created_at) VALUES (1, ?, 'text', '2026-11-02T00:00:00Z')").run(long + "A");
    sq.prepare("INSERT INTO notes (user_id, text, source, created_at) VALUES (1, ?, 'text', '2026-11-02T00:00:00Z')").run(long + "B");
    const s2 = mkS1d5();
    await handleDailyText({ STATE: fakeKV(), DB: db }, { chatId: 1, userId: 1, text: "یادداشت‌هام", send: s2.send, chat: s2.chat, nowMs: T, source: "voice", voiceHeader: "🎙 «یادداشت‌هام»\n\n" });
    check(s2.sent.length === 1 && s2.sent[0].text.startsWith("🎙 «یادداشت‌هام»") && s2.sent[0].text.includes("📖 #1"), "1-d-5: title-only note rows keep the voice list in one chunk with the header first");
  }
  // Chat wrap: voice summary passes the header + sum retry data (no chat retry alongside it).
  {
    const { sq, db } = fresh1d5();
    const gol = seedProj5(sq, 1, "گلبهار", 1);
    sq.prepare("INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (1, 'صبحانه', 'text', '2026-11-02T00:00:00Z', ?)").run(gol);
    const s = mkS1d5();
    await handleDailyText({ STATE: fakeKV(), DB: db }, { chatId: 1, userId: 1, text: "یادداشت‌های گلبهار رو خلاصه کن", send: s.send, chat: s.chat, nowMs: T, source: "voice", voiceHeader: "🎙 «خلاصه»\n\n" });
    check(s.chats.length === 1 && s.chats[0].opts.voiceHeader === "🎙 «خلاصه»\n\n" && s.chats[0].opts.retryData === `note:sum:${gol}` && s.chats[0].opts.retryEntryId == null && s.chats[0].opts.failureLabel === "خلاصه‌سازی", "1-d-5: voice summary chat call carries header + sum retry (no chat retry)");
  }
  // qconv: note/task success (default project), no-default, foreign/missing/assistant/invalid/D1 failure.
  {
    const { sq, db, rows } = fresh1d5();
    const om = seedProj5(sq, 1, "عمومی", 1);
    await saveMessage(db, { userId: 1, role: "user", content: "متن قابل تبدیل", kind: "chat" });
    await saveMessage(db, { userId: 2, role: "user", content: "مال دیگری", kind: "chat" });
    await saveMessage(db, { userId: 1, role: "assistant", content: "پاسخ مدل", kind: "chat" });
    const mine = rows("SELECT id FROM messages WHERE user_id = 1 AND role = 'user'")[0].id;
    const theirs = rows("SELECT id FROM messages WHERE user_id = 2")[0].id;
    const asst = rows("SELECT id FROM messages WHERE user_id = 1 AND role = 'assistant'")[0].id;
    const tap5 = async (data, resolver, fromId = 1, d = db) => { const s = mkS1d5(); const r = await resolver({ STATE: fakeKV(), DB: d }, { fromId, data, send: s.send, chat: s.chat, editMarkup: s.editMarkup, nowMs: T }); return { r, s }; };
    const n = await tap5(`qconv:note:${mine}`, resolveQuickConvertCallback);
    const noteRow = rows("SELECT text, project_id FROM notes WHERE user_id = 1")[0];
    check(n.s.sent[0].text === "✅ به یادداشت تبدیل شد." && n.s.edits() === 1 && noteRow.text === "متن قابل تبدیل" && noteRow.project_id === om, "1-d-5: qconv:note saves the stored text into the default project + confirms + removes buttons");
    const t = await tap5(`qconv:task:${mine}`, resolveQuickConvertCallback);
    const taskRow = rows("SELECT title, project_id FROM tasks WHERE user_id = 1")[0];
    check(t.s.sent[0].text === "✅ به تسک تبدیل شد." && t.s.edits() === 1 && taskRow.title === "متن قابل تبدیل" && taskRow.project_id === om, "1-d-5: qconv:task saves the stored text as a task in the default project");
    const f1 = await tap5(`qconv:note:${theirs}`, resolveQuickConvertCallback);
    const f2 = await tap5(`qconv:note:99999`, resolveQuickConvertCallback);
    const f3 = await tap5(`qconv:note:${asst}`, resolveQuickConvertCallback);
    const f4 = await tap5(`qconv:note:0`, resolveQuickConvertCallback);
    check(f1.s.sent.length === 0 && f2.s.sent.length === 0 && f3.s.sent.length === 0 && f4.s.sent.length === 0, "1-d-5: foreign/missing/assistant/invalid qconv taps stay silent");
    const bad = await tap5(`qconv:note:${mine}`, resolveQuickConvertCallback, 1, { prepare() { throw new Error("boom"); } });
    check(bad.s.sent[0].text === "ذخیره نشد، دوباره تلاش کن" && bad.s.edits() === 0, "1-d-5: qconv D1 failure reports failure, buttons kept");
    const nd = fresh1d5();
    seedProj5(nd.sq, 1, "بدون پیش‌فرض", 0);
    await saveMessage(nd.db, { userId: 1, role: "user", content: "بدون پروژه", kind: "chat" });
    const nid = nd.rows("SELECT id FROM messages WHERE user_id = 1")[0].id;
    const sNd = mkS1d5();
    await resolveQuickConvertCallback({ STATE: fakeKV(), DB: nd.db }, { fromId: 1, data: `qconv:note:${nid}`, send: sNd.send, chat: sNd.chat, editMarkup: sNd.editMarkup, nowMs: T });
    check(nd.rows("SELECT project_id FROM notes WHERE user_id = 1")[0].project_id === null, "1-d-5: qconv without a default project stores with no project");
  }
  // chat:retry: re-runs the stored text with fresh buttons; foreign/missing/D1 failure.
  {
    const { db, rows } = fresh1d5();
    await saveMessage(db, { userId: 1, role: "user", content: "سؤال دوباره", kind: "chat" });
    await saveMessage(db, { userId: 2, role: "user", content: "مال دیگری", kind: "chat" });
    const mine = rows("SELECT id FROM messages WHERE user_id = 1")[0].id;
    const theirs = rows("SELECT id FROM messages WHERE user_id = 2")[0].id;
    const tapR = async (data, fromId = 1, d = db) => { const s = mkS1d5(); const r = await resolveChatRetryCallback({ STATE: fakeKV(), DB: d }, { fromId, data, send: s.send, chat: s.chat, editMarkup: s.editMarkup, nowMs: T }); return { r, s }; };
    const ok = await tapR(`chat:retry:${mine}`);
    const kb = ok.s.chats[0]?.opts?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
    check(ok.s.chats.length === 1 && ok.s.chats[0].text === "سؤال دوباره" && ok.s.chats[0].opts.saveText === "" && ok.s.chats[0].opts.retryEntryId === mine && ok.s.chats[0].opts.quickConvertId === mine && kb.includes(`qconv:note:${mine}`) && ok.s.edits() === 1, "1-d-5: chat:retry re-runs the stored text with fresh buttons + removes old markup");
    const f1 = await tapR(`chat:retry:${theirs}`);
    const f2 = await tapR(`chat:retry:99999`);
    check(f1.s.chats.length === 0 && f1.s.sent.length === 0 && f2.s.chats.length === 0, "1-d-5: foreign/missing chat:retry taps stay silent");
    const bad = await tapR(`chat:retry:${mine}`, 1, { prepare() { throw new Error("boom"); } });
    check(bad.s.sent[0].text === "ذخیره نشد، دوباره تلاش کن", "1-d-5: chat:retry D1 failure reports failure");
  }
  // Worker-level: a failing chat turn names the stage and carries retry + quick-convert buttons.
  // (The env needs a DB: without one, handleDailyText takes the D1-unavailable path and no entry
  // row exists to attach the buttons to — the notice text still names the stage in that case.)
  {
    const world = mockWorld();
    try {
      const { db } = fresh1d5();
      const env = { ...newEnv(), DB: db };
      await sendTg(env, msgUpdate("add a /health endpoint to the worker"));
      // Phase 1-e Pillar 1: the failure notice finalizes the ⏳
      // placeholder (editMessageText, markup on the edit) instead of a
      // second sendMessage.
      const failMsg = world.calls.telegram.filter((c) => c.method === "editMessageText").at(-1) ?? world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
      check(String(failMsg?.payload?.text ?? "").includes("مرحله‌ی چت شکست خورد"), "1-d-5: worker chat failure notice names the stage");
      const kb = failMsg?.payload?.reply_markup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
      check(kb.some((c) => c.startsWith("chat:retry:")) && kb.some((c) => c.startsWith("qconv:note:")) && kb.some((c) => c.startsWith("qconv:task:")), "1-d-5: worker chat failure notice carries retry + quick-convert buttons");
    } finally { world.restore(); }
  }
}

// ── Phase 1-d-6: live-QA hotfix — hour-ambiguous discharge, middle folder tag, summary budget ──
{
  const NOW6 = Date.UTC(2026, 9, 28, 5, 0, 0); // 2026-10-28 08:30 Tehran: 03:30/05:00 today ambiguous, 15:30/17:00 still future
  const cl6 = (s) => classifyDaily(s, { nowMs: NOW6 });
  check(cl6("یادداشت توی پروژه گلبهار: سیمان و گچ فردا صبح تحویل گرفته شود").intent === "note", "1-d-6: middle-tagged note classifies as note");
  check(cl6("تسک توی پروژه گلبهار: خرید سیمان").intent === "task-create", "1-d-6: middle-tagged task classifies as task-create");
  check(cl6("یادآوری توی پروژه گلبهار: فردا ساعت ۹ تماس").intent === "reminder" && cl6("یادآوری توی پروژه گلبهار: فردا ساعت ۹ تماس").due === "2026-10-29T09:00:00+03:30", "1-d-6: middle-tagged reminder (bare یادآوری) classifies as reminder");
  const tg6 = extractFolderTag("یادداشت توی پروژه گلبهار: سیمان و گچ فردا صبح تحویل گرفته شود");
  check(tg6?.at === "middle" && tg6?.name === "گلبهار" && tg6?.body === "یادداشت: سیمان و گچ فردا صبح تحویل گرفته شود", "1-d-6: middle folder tag extracts name + stripped body");
  check(hasDaypartReply("عصر") && hasDaypartReply("ساعت ۳ عصر") && !hasDaypartReply("تفاوت Cloudflare D1 و KV چیه؟") && !hasDaypartReply("تفاوت صبح و عصر چیه؟"), "1-d-6: daypart detection is exact-shape, not substring");
  check(mergeHourAmbiguousFollowup("عصر", "یادآوری کن امروز ساعت ۰۳:۳۰ تست یادآور") === "یادآوری کن امروز ساعت 03:30 عصر تست یادآور", "1-d-6: daypart merge splices onto the stored hour");
}
if (DatabaseSync) {
  const fresh1d6 = () => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
    const base = (sql) => { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
    return { sq, db: { prepare(sql) { return base(sql); } }, rows: (sql, params = []) => sq.prepare(sql).all(...params) };
  };
  const seedProj6 = (sq, uid, name, aliases = [], isDefault = 0) => { sq.prepare("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (?, ?, ?, 'active', ?, '2026-10-01T00:00:00.000Z')").run(uid, name, JSON.stringify(aliases), isDefault); return sq.prepare("SELECT id FROM projects WHERE user_id = ? AND name = ?").all(uid, name)[0].id; };
  const mkS6 = () => { const sent = []; const chats = []; return { sent, chats, send: async (t, opts) => { sent.push({ text: t, opts }); }, chat: async (t, copts) => { chats.push({ text: t, opts: copts }); }, editMarkup: async () => {} }; };
  const convo6 = (sc) => { const s = mkS6(); const env = { STATE: fakeKV(), DB: sc.db }; const say = async (text, nowMs) => handleDailyText(env, { chatId: 1, userId: 1, text, send: s.send, chat: s.chat, nowMs }); const slot = async () => env.STATE.get("daily:pending-ask:1", "json"); return { s, env, say, slot }; };
  const MORNING = Date.UTC(2026, 9, 28, 5, 0, 0); // 08:30 Tehran
  const REM6 = "یادآوری کن امروز ساعت ۰۳:۳۰ تست یادآور";
  // Bug 1a: daypart reply resolves + stores, zero model calls, slot gone.
  {
    const sc = fresh1d6(); const c = convo6(sc);
    await c.say(REM6, MORNING);
    check(c.s.sent.at(-1)?.text === "ساعت را با صبح یا عصر مشخص کن." && (await c.slot())?.kind === "hour-ambiguous", "1-d-6: ambiguous reminder asks + stores hour-ambiguous slot");
    const r = await c.say("عصر", MORNING);
    const task = sc.rows("SELECT title, remind_at FROM tasks WHERE user_id = 1 ORDER BY id DESC LIMIT 1")[0];
    check(r === "handled" && task?.title === "تست یادآور" && task?.remind_at === "2026-10-28T15:30:00+03:30" && c.s.sent.at(-1)?.text === "⏰ یادآوری به‌عنوان تسک ذخیره شد." && c.s.chats.length === 0 && (await c.slot()) === null, "1-d-6: عصر resolves 15:30 + stores task, 0 model calls, slot cleared");
  }
  // Bug 1b: unrelated question is fresh chat, never trapped, slot cleared.
  {
    const sc = fresh1d6(); const c = convo6(sc);
    await c.say(REM6, MORNING);
    const n = c.s.sent.length;
    const r = await c.say("تفاوت Cloudflare D1 و KV چیه؟", MORNING);
    check(r === "chat" && c.s.sent.length === n && (await c.slot()) === null, "1-d-6: unrelated question routes to chat, no re-ask, slot cleared");
  }
  // Bug 1c: still-ambiguous re-asks once WITH the original body, then resolves.
  {
    const sc = fresh1d6(); const c = convo6(sc);
    await c.say("یادآوری کن امروز ساعت ۵ تست شب", MORNING);
    await c.say("شب", MORNING);
    const slot = await c.slot();
    check(c.s.sent.at(-1)?.text === "ساعت را با صبح یا عصر مشخص کن." && slot?.kind === "hour-ambiguous" && slot?.pendingBody === "یادآوری کن امروز ساعت ۵ تست شب", "1-d-6: still-ambiguous re-asks once, original body preserved");
    await c.say("عصر", MORNING);
    const task = sc.rows("SELECT title, remind_at FROM tasks WHERE user_id = 1 ORDER BY id DESC LIMIT 1")[0];
    check(task?.title === "تست شب" && task?.remind_at === "2026-10-28T17:00:00+03:30" && (await c.slot()) === null, "1-d-6: preserved slot then resolves 17:00");
  }
  // Bug 1d: hour-only daypart ("ساعت ۳ عصر") resolves per the directive.
  {
    const sc = fresh1d6(); const c = convo6(sc);
    await c.say("یادآوری کن امروز ساعت ۳ تست ساعت", MORNING);
    await c.say("ساعت ۳ عصر", MORNING);
    const task = sc.rows("SELECT title, remind_at FROM tasks WHERE user_id = 1 ORDER BY id DESC LIMIT 1")[0];
    check(task?.remind_at === "2026-10-28T15:00:00+03:30", "1-d-6: ساعت ۳ عصر resolves 15:00");
  }
  // Bug 2: middle-tagged note stores with the project, exact confirm, 0 model calls.
  {
    const sc = fresh1d6(); const gol = seedProj6(sc.sq, 1, "گلبهار", ["گل"]); seedProj6(sc.sq, 1, "عمومی", [], 1);
    const c = convo6(sc);
    await c.say("یادداشت توی پروژه گلبهار: سیمان و گچ فردا صبح تحویل گرفته شود", MORNING);
    const note = sc.rows("SELECT text, project_id FROM notes WHERE user_id = 1 ORDER BY id DESC LIMIT 1")[0];
    check(note?.text === "سیمان و گچ فردا صبح تحویل گرفته شود" && note?.project_id === gol && c.s.sent.at(-1)?.text === "✅ یادداشت ذخیره شد. [📁 گلبهار]" && c.s.chats.length === 0, "1-d-6: middle-tagged note saves to گلبهار, exact confirm, 0 model calls");
  }
  // Bug 3: summary handler passes 1600 tokens + the tightened instruction.
  {
    const sc = fresh1d6(); const gol = seedProj6(sc.sq, 1, "گلبهار", ["گل"]);
    sc.sq.prepare("INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (1, 'صبحانه گلبهار', 'text', '2026-10-28T01:24:00+03:30', ?)").run(gol);
    const c = convo6(sc);
    await c.say("یادداشت‌های گلبهار رو خلاصه کن", MORNING);
    check(c.s.chats.length === 1 && c.s.chats[0].opts.maxTokens === 2200 && String(c.s.chats[0].opts.systemPrompt ?? "").includes("۴ تا ۵ خط") && String(c.s.chats[0].opts.systemPrompt ?? "").includes("فهرست شماره‌دار") && String(c.s.chats[0].opts.systemPrompt ?? "").includes("۳۰ ردیف") && !String(c.s.chats[0].opts.systemPrompt ?? "").includes("| ردیف |"), "sumstab: summary passes 2200 tokens + concise lead + numbered-list rows (Phase 2-f raises the Stable v1 addendum's 900-token cap for reasoning-model headroom; numbered-list form unchanged)");
  }
  // ── Phase 2-b Pillar C ──
  // Static resource boundary (Pillar A.1): there is no DEFAULT_COMBOS
  // constant — combos resolve from RULES + KV catalog + manual combos,
  // and the only builtin providers are the three external router
  // providers, so workers-ai/Gemini cannot appear in chat/code/
  // translate combos by construction. Guard that here.
  check(Object.keys(PROVIDERS).every((k) => ["nvidia", "openrouter", "xkiro"].includes(k)) && !Object.values(PROVIDERS).some((p) => /workers-ai|gemini/i.test(p.baseUrl ?? "")), "2-b: builtin providers contain no workers-ai/Gemini targets (Pillar A.1 by construction)");
  // Pure reasoning extraction (Pillar A.4).
  // Stable v1 addendum SCOPE NOTE (assertions unchanged): these assert
  // ROUTER-layer extraction, which the /v1 passthrough still relies on.
  // Telegram delivery (answerChatText) no longer delivers reasoning-only
  // or unclosed-think text as the user's answer — see the sumstab tests
  // below, which assert the Telegram layer rejects both.
  check(extractAssistantText({ content: "", reasoning_content: "خلاصه یادداشت‌ها..." }) === "خلاصه یادداشت‌ها...", "2-b: reasoning_content fallback extracts text");
  check(extractAssistantText({ content: "<think>خلاصه یادداشت‌ها..." }) === "خلاصه یادداشت‌ها...", "2-b: unclosed <think> extracts inner text instead of empty");
  check(extractAssistantText({ content: "<think>فکر</think>پاسخ نهایی" }) === "پاسخ نهایی", "2-b: closed <think> block stripped, answer kept");
  check(extractAssistantText({ content: "سلام <think>ناتمام" }) === "سلام ناتمام", "2-b: text before an unclosed <think> is preserved");
  check(extractAssistantText({ content: "" }) === "" && extractAssistantText({ content: "", reasoning_content: "", reasoning: "" }) === "", "2-b: all three empty still yields empty");
  // Pure known-project boundary matching (Pillar B).
  {
    const projs = [{ name: "گلبهار", aliases: ["گل"] }, { name: "یوتیوب", aliases: [] }];
    const a = extractFolderTag("اینو یادداشت کن که فردا قراره بار جدید سیمان برای پروژه گلبهار برسه", projs);
    check(a?.at === "known" && a?.name === "گلبهار" && a?.body === "اینو یادداشت کن که فردا قراره بار جدید سیمان برسه", "2-b: Example A pure extraction keeps trailing words out of the name");
    const b = extractFolderTag("یه تسک جدید ثبت کن برای پروژه یوتیوب ضبط ویدیوی معرفی", projs);
    check(b?.at === "known" && b?.name === "یوتیوب" && b?.body === "یه تسک جدید ثبت کن ضبط ویدیوی معرفی", "2-b: Example B pure extraction keeps trailing words out of the name");
    check(resolveProjectName("گلبهار برسه", projs) === "گلبهار" && resolveProjectName("یوتیوب ضبط ویدیوی معرفی", projs) === "یوتیوب" && resolveProjectName("ناشناخته", projs) === null, "2-b: resolveProjectName prefix fallback (trailing words) + null for unknown");
    check(matchKnownProjectAt("گل برسه", projs)?.name === "گل" && matchKnownProjectAt("گلبهارها", projs) === null, "2-b: alias match at exact position, no match inside a longer word");
    const mid = classifyDaily("یادداشت توی پروژه گلبهار: سیمان", MORNING, projs);
    check(mid.intent === "note" && mid.text === "سیمان", "2-b: classifyDaily accepts positional (text, nowMs, projects) + threads projects through the mid-tag recursion");
  }
  // Strict resource boundary (Pillar C.1): total OUR_ROUTER failure
  // during chat and during summary delivers the clean stage notice
  // with 0 calls to env.AI.run.
  {
    resetRouterHealthForTests();
    const tgCalls = [];
    const stubFetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("api.telegram.org")) {
        let body = {};
        try { body = JSON.parse(init.body ?? "{}"); } catch {}
        tgCalls.push({ method: u.split("/").pop(), text: body.text ?? "" });
        return Response.json({ ok: true, result: { message_id: 555 } });
      }
      return new Response("down", { status: 503 });
    };
    const prev = global.fetch;
    try {
      global.fetch = stubFetch;
      const seedCombo = async (st) => {
        await st.put("tgprefs:1", JSON.stringify({ combo: "cbchat", auto: false }));
        await st.put("config:v1", JSON.stringify({ providers: [], combos: [{ name: "cbchat", strategy: "priority", targets: [{ provider: "xkiro", model: "dead-503" }] }] }));
      };
      // Chat-level failure.
      {
        const sc = fresh1d6();
        let aiCalls = 0;
        const env = { STATE: fakeKV(), DB: sc.db, TG_TOKEN: "x", ALLOWED_TG_IDS: "1", XKIRO_API_KEY: "k", AI: { run: async () => { aiCalls++; return {}; } } };
        await seedCombo(env.STATE);
        tgCalls.length = 0;
        await answerChatText(env, 1, 1, "سلام", "", {});
        const notice = tgCalls.find((c) => c.method === "editMessageText" && c.text.includes("مرحله‌ی چت شکست خورد"));
        check(!!notice && aiCalls === 0, "2-b: total router failure in chat delivers the clean stage notice with 0 env.AI.run calls");
      }
      // Summary-level failure through the real handleDailyText path.
      {
        const sc = fresh1d6();
        const gol = seedProj6(sc.sq, 1, "گلبهار", ["گل"]);
        sc.sq.prepare("INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (1, 'صبحانه گلبهار', 'text', '2026-10-28T01:24:00+03:30', ?)").run(gol);
        let aiCalls = 0;
        const env = { STATE: fakeKV(), DB: sc.db, TG_TOKEN: "x", ALLOWED_TG_IDS: "1", XKIRO_API_KEY: "k", AI: { run: async () => { aiCalls++; return {}; } } };
        await seedCombo(env.STATE);
        tgCalls.length = 0;
        const chat = (t, copts) => answerChatText(env, 1, 1, t, "", copts);
        await handleDailyText(env, { chatId: 1, userId: 1, text: "یادداشت‌های گلبهار رو خلاصه کن", send: async () => {}, chat, editMarkup: async () => {}, nowMs: MORNING });
        const notice = tgCalls.find((c) => c.method === "editMessageText" && c.text.includes("خلاصه‌سازی") && c.text.includes("شکست خورد"));
        check(!!notice && aiCalls === 0, "2-b: total router failure in summary delivers the clean stage notice with 0 env.AI.run calls");
      }
    } finally { global.fetch = prev; }
  }
    // Circuit breaker + 7.5s default timeout (Pillar C.2, A.2/A.3; 2-c raised 6s to 13s, 2-i lowered to 7.5s).
  {
    resetRouterHealthForTests();
    const attempts = [];
    let goodDown = false;
    const stubFetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("api.xkiro.com")) {
        // The model travels in the JSON body, not the URL.
        let model = "";
        try { model = JSON.parse(init.body ?? "{}").model ?? ""; } catch {}
        if (model === "dead-503") { attempts.push("xkiro/dead-503"); return new Response("down", { status: 503 }); }
        attempts.push("xkiro/good");
        return goodDown ? new Response("down", { status: 503 }) : Response.json({ choices: [{ message: { content: "ok" } }] });
      }
      return new Response("unexpected", { status: 500 });
    };
    const prev = global.fetch;
    try {
      global.fetch = stubFetch;
      const mkEnv = async () => {
        const env = { STATE: fakeKV(), XKIRO_API_KEY: "k" };
        await env.STATE.put("config:v1", JSON.stringify({ providers: [], combos: [{ name: "cbtest", strategy: "priority", targets: [{ provider: "xkiro", model: "dead-503" }, { provider: "xkiro", model: "good" }] }] }));
        return env;
      };
      const body = { messages: [{ role: "user", content: "hi" }] };
      attempts.length = 0;
      const r1 = await runCombo(await mkEnv(), "cbtest", body, {});
      check(r1.ok === true && r1.used === "xkiro/good" && attempts.join(",") === "xkiro/dead-503,xkiro/good", "2-b: breaker call #1 tries both, succeeds via healthy target");
      attempts.length = 0;
      const r2 = await runCombo(await mkEnv(), "cbtest", body, {});
      check(r2.ok === true && r2.used === "xkiro/good" && attempts.join(",") === "xkiro/good", "2-b: breaker call #2 within cooldown tries healthy first, skips cooled-down target");
      goodDown = true;
      attempts.length = 0;
      const r3 = await runCombo(await mkEnv(), "cbtest", body, {});
      check(r3.ok === false && attempts.join(",") === "xkiro/good,xkiro/dead-503", "2-b: breaker call #3 tries cooled-down target only after all healthy fail");
      resetRouterHealthForTests();
      goodDown = false;
      attempts.length = 0;
      const r4 = await runCombo(await mkEnv(), "cbtest", body, {});
      check(r4.ok === true && attempts.join(",") === "xkiro/dead-503,xkiro/good", "2-b: resetRouterHealthForTests restores original order");
    } finally { global.fetch = prev; }
    // Default per-attempt timeout is 7.5s (no explicit timeout option).
    const hungFetch = async (url, init = {}) => new Promise((_, rej) => { init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); });
    const prev2 = global.fetch;
    try {
      global.fetch = hungFetch;
      const env = { STATE: fakeKV(), XKIRO_API_KEY: "k" };
      const t0 = Date.now();
      const r = await callRouter(env, "xkiro/test-model", { messages: [{ role: "user", content: "hi" }] }, {});
      const elapsed = Date.now() - t0;
      check(r.ok === false && r.error === "timeout" && elapsed >= 5000 && elapsed < 20000, `2-d: default per-attempt timeout is ~7.5s (within [5s, 20s) window) (elapsed ${elapsed}ms)`);
    } finally { global.fetch = prev2; }
  }
  // Reasoning-model fix through callRouter + runCombo (Pillar C.3).
  // Stable v1 addendum SCOPE NOTE (assertions unchanged): callRouter /
  // runCombo keep surfacing reasoning text as message content for the
  // router//v1 layer. The Telegram layer (answerChatText) applies the
  // final-content rule on top via answerMeta.finalText — see sumstab.
  {
    resetRouterHealthForTests();
    const mkReasonFetch = (message) => async (url) => String(url).includes("api.xkiro.com") ? Response.json({ choices: [{ message }] }) : new Response("unexpected", { status: 500 });
    const prev = global.fetch;
    try {
      global.fetch = mkReasonFetch({ content: "", reasoning_content: "خلاصه یادداشت‌ها..." });
      const env = { STATE: fakeKV(), XKIRO_API_KEY: "k" };
      const r = await callRouter(env, "xkiro/reason-model", { messages: [{ role: "user", content: "hi" }] }, {});
      check(r.ok === true && r.text === "خلاصه یادداشت‌ها..." && r.error === null, "2-b: reasoning_content HTTP 200 returns ok instead of empty assistant message");
      const r2 = await runCombo(env, "xkiro/reason-model", { messages: [{ role: "user", content: "hi" }] }, {});
      check(r2.ok === true && r2.data?.choices?.[0]?.message?.content === "خلاصه یادداشت‌ها...", "2-b: runCombo surfaces reasoning text as the message content");
      global.fetch = mkReasonFetch({ content: "<think>خلاصه یادداشت‌ها..." });
      const r3 = await callRouter(env, "xkiro/reason-model", { messages: [{ role: "user", content: "hi" }] }, {});
      check(r3.ok === true && r3.text === "خلاصه یادداشت‌ها...", "2-b: unclosed <think> HTTP 200 returns ok instead of empty assistant message");
      global.fetch = mkReasonFetch({ content: "" });
      const r4 = await callRouter(env, "xkiro/reason-model", { messages: [{ role: "user", content: "hi" }] }, {});
      check(r4.ok === false && r4.error === "empty assistant message", "2-b: all-three-empty still fails as empty assistant message");
    } finally { global.fetch = prev; }
    resetRouterHealthForTests();
  }
  // Mid-sentence known-project extraction end to end (Pillar C.4).
  {
    const sc = fresh1d6(); const gol = seedProj6(sc.sq, 1, "گلبهار", ["گل"]); seedProj6(sc.sq, 1, "عمومی", [], 1);
    const c = convo6(sc);
    await c.say("اینو یادداشت کن که فردا قراره بار جدید سیمان برای پروژه گلبهار برسه", MORNING);
    const note = sc.rows("SELECT text, project_id FROM notes WHERE user_id = 1 ORDER BY id DESC LIMIT 1")[0];
    check(note?.text === "فردا قراره بار جدید سیمان برسه" && note?.project_id === gol && c.s.sent.at(-1)?.text === "✅ یادداشت ذخیره شد. [📁 گلبهار]" && c.s.chats.length === 0, "2-b: Example A end to end — exact note body, گلبهار project_id, badge, 0 model calls");
  }
  {
    const sc = fresh1d6(); const yt = seedProj6(sc.sq, 1, "یوتیوب", []); seedProj6(sc.sq, 1, "عمومی", [], 1);
    const c = convo6(sc);
    await c.say("یه تسک جدید ثبت کن برای پروژه یوتیوب ضبط ویدیوی معرفی", MORNING);
    const task = sc.rows("SELECT title, project_id FROM tasks WHERE user_id = 1 ORDER BY id DESC LIMIT 1")[0];
    check(task?.title === "ضبط ویدیوی معرفی" && task?.project_id === yt && c.s.sent.at(-1)?.text === "✅ تسک ثبت شد. [📁 یوتیوب]" && c.s.chats.length === 0, "2-b: Example B end to end — exact task title, یوتیوب project_id, badge, 0 model calls");
  }
  {
    const sc = fresh1d6(); const gol = seedProj6(sc.sq, 1, "گلبهار", ["گل"]); seedProj6(sc.sq, 1, "عمومی", [], 1);
    const c = convo6(sc);
    await c.say("اینو یادداشت کن که فردا سیمان برای پروژه گل برسه", MORNING);
    const note = sc.rows("SELECT text, project_id FROM notes WHERE user_id = 1 ORDER BY id DESC LIMIT 1")[0];
    check(note?.text === "فردا سیمان برسه" && note?.project_id === gol && c.s.sent.at(-1)?.text === "✅ یادداشت ذخیره شد. [📁 گلبهار]" && c.s.chats.length === 0, "2-b: alias mid-sentence tag resolves to گلبهار, exact body + badge, 0 model calls");
  }
  // ── Phase 2-c: timeout classification, phantom lines, provider demotion, NLU skip ──
  // (a) Error("timeout") thrown by fetch is classified as "timeout" and
  // recorded in targetHealthMap — not "network: timeout".
  {
    resetRouterHealthForTests();
    const prev = global.fetch;
    const calls = [];
    global.fetch = async () => { calls.push(1); throw new Error("timeout"); };
    try {
      const env = { STATE: fakeKV(), XKIRO_API_KEY: "k" };
      const r = await runCombo(env, "xkiro/test-model", { messages: [{ role: "user", content: "hi" }] }, { attemptTimeoutMs: 5000, totalTimeoutMs: 20000 });
      check(r.ok === false && r.errors.length === 1 && r.errors[0]?.reason === "timeout", "2-c: Error(\"timeout\") in fetch is classified as \"timeout\", not \"network: timeout\"");
      check(getRouterHealthSnapshotForTests().get("xkiro/test-model")?.lastStatus === "timeout", "2-c: timeout failure is recorded in targetHealthMap");
    } finally { global.fetch = prev; }
    // Same classification for the bare-string abort shape.
    resetRouterHealthForTests();
    global.fetch = async () => { throw "timeout"; };
    try {
      const env = { STATE: fakeKV(), XKIRO_API_KEY: "k" };
      const r = await runCombo(env, "xkiro/test-model", { messages: [{ role: "user", content: "hi" }] }, { attemptTimeoutMs: 5000, totalTimeoutMs: 20000 });
      check(r.ok === false && r.errors[0]?.reason === "timeout", "2-c: bare-string \"timeout\" throw is classified as \"timeout\"");
    } finally { global.fetch = prev; }
  }
  // (b) No phantom unattempted lines when the budget expires after real
  // attempts: first target fails 503 after ~800ms inside an 1800ms
  // total budget, so < 1200ms remain for the second target.
  {
    resetRouterHealthForTests();
    const prev = global.fetch;
    global.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.model === "first") {
        await new Promise((r) => setTimeout(r, 800));
        return new Response(JSON.stringify({ error: { message: "down" } }), { status: 503 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    };
    try {
      const kv = fakeKV();
      await kv.put("config:v1", JSON.stringify({ providers: [{ id: "demoprov", name: "demoprov", baseUrl: "https://demo.test/v1", secretName: "TG_TOKEN", enabled: true }], combos: [{ name: "phantomtest", kind: "custom", strategy: "priority", timeoutMs: 8000, retries: 0, targets: [{ provider: "demoprov", model: "first" }, { provider: "demoprov", model: "second" }] }] }));
      const env = { STATE: kv, TG_TOKEN: "x" };
      const r = await runCombo(env, "phantomtest", { messages: [{ role: "user", content: "hi" }] }, { totalTimeoutMs: 1800 });
      check(r.ok === false && r.errors.length === 1 && r.errors[0]?.target === "demoprov/first", "2-c: no phantom unattempted target lines when budget expires after real attempts");
    } finally { global.fetch = prev; }
  }
  // (c) Intra-call provider demotion: [xkiro/m1 (503), xkiro/m2,
  // nvidia/m3] tries nvidia/m3 BEFORE xkiro/m2.
  {
    resetRouterHealthForTests();
    const prev = global.fetch;
    const seen = [];
    global.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      seen.push(body.model);
      if (body.model === "m1") return new Response(JSON.stringify({ error: { message: "down" } }), { status: 503 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok-" + body.model } }] }), { status: 200 });
    };
    try {
      const kv = fakeKV();
      await kv.put("config:v1", JSON.stringify({ providers: [{ id: "xkiro", name: "xkiro", baseUrl: "https://xkiro.test/v1", secretName: "XKIRO_API_KEY", enabled: true }, { id: "nvidia", name: "nvidia", baseUrl: "https://nvidia.test/v1", secretName: "NVIDIA_API_KEY", enabled: true }], combos: [{ name: "demotest", kind: "custom", strategy: "priority", timeoutMs: 8000, retries: 0, targets: [{ provider: "xkiro", model: "m1" }, { provider: "xkiro", model: "m2" }, { provider: "nvidia", model: "m3" }] }] }));
      const env = { STATE: kv, XKIRO_API_KEY: "k", NVIDIA_API_KEY: "k" };
      const r = await runCombo(env, "demotest", { messages: [{ role: "user", content: "hi" }] }, {});
      check(r.ok === true && r.used === "nvidia/m3" && seen.join(",") === "m1,m3", "2-c: provider demotion tries nvidia/m3 before xkiro/m2 after xkiro/m1 503");
    } finally { global.fetch = prev; }
  }
  // (d) Unambiguous question skips classifyIntentNlu (0 AI.run calls)
  // and goes straight to chat; the rule itself is checked directly too.
  {
    check(isUnambiguousQuestion("تفاوت Cloudflare D1 و KV چیه؟") && isUnambiguousQuestion("چرا آسمان آبیه؟") && !isUnambiguousQuestion("یادداشت‌هام رو چطور ببینم؟") && !isUnambiguousQuestion("فردا سیمان و گچ برای پروژه گلبهار تحویل گرفته میشه"), "2-c: isUnambiguousQuestion rule — question words skip, keyword/statement messages do not");
    const sc = fresh1d6(); seedProj6(sc.sq, 1, "عمومی", [], 1);
    let aiCalls = 0;
    const env = { STATE: fakeKV(), DB: sc.db, AI: { run: async () => { aiCalls++; return { response: JSON.stringify({ intent: "chat", confidence: 0.9 }) }; } } };
    const s = mkS6();
    const r = await handleDailyText(env, { chatId: 1, userId: 1, text: "تفاوت Cloudflare D1 و KV چیه؟", send: s.send, chat: s.chat, nowMs: MORNING });
    check(r === "chat" && aiCalls === 0, "2-c: unambiguous question skips classifyIntentNlu (0 AI.run calls) and goes straight to chat");
  }

  // ── Phase 2-d: admin overrides API, safe pinning, compact keyboards,
  // stray-dot strip, line-aware split, update_id dedup ──
  // (a) /admin/api/overrides pin/ban validation + /admin/api/health/clear.
  {
    const kv = fakeKV();
    await kv.put("catalog:xkiro", JSON.stringify({ models: [{ id: "qwen3-32b", provider: "xkiro", context: 131072 }] }));
    const env = { STATE: kv };
    const call = async (method, pathname, body, url = null) => {
      const req = { method, url: url ?? `http://x${pathname}`, json: async () => body };
      const res = await adminApi(req, env, method, pathname);
      return { status: res.status, data: await res.json() };
    };
    const badPin = await call("POST", "/admin/api/overrides/pin", { combo: "chat", target: "xkiro/no-such-model" });
    check(badPin.status === 400 && /unknown model/.test(badPin.data.error ?? ""), "2-d: pin of an unknown catalog model is rejected with 400, never silently dropped");
    const goodPin = await call("POST", "/admin/api/overrides/pin", { combo: "chat", target: "xkiro/qwen3-32b" });
    check(goodPin.status === 200 && (goodPin.data.pins?.chat ?? []).includes("xkiro/qwen3-32b"), "2-d: pin of a catalog model stores in overrides:v1");
    const ov = await call("GET", "/admin/api/overrides", null);
    check(ov.status === 200 && (ov.data.pins?.chat ?? []).includes("xkiro/qwen3-32b") && Array.isArray(ov.data.bans) && Array.isArray(ov.data.providerBlocks), "2-d: GET /admin/api/overrides returns pins + bans + prefer + provider blocks");
    const ban = await call("POST", "/admin/api/overrides/ban", { target: "xkiro/qwen3-32b" });
    check(ban.status === 200 && ban.data.bans.includes("xkiro/qwen3-32b"), "2-d: ban stores in overrides:v1");
    const unban = await call("DELETE", "/admin/api/overrides/ban", { target: "xkiro/qwen3-32b" });
    check(unban.status === 200 && !unban.data.bans.includes("xkiro/qwen3-32b"), "2-d: unban removes from overrides:v1");
    await markFailure(env, "xkiro/qwen3-32b", classifyFailure(null, "", true), "timeout");
    check((await isModelHealthy(env, "xkiro/qwen3-32b")) === false, "2-d: seeded timeout cooldown marks the model unhealthy");
    const cleared = await call("POST", "/admin/api/health/clear", { target: "xkiro/qwen3-32b" });
    check(cleared.status === 200 && cleared.data.cleared.includes("health:xkiro/qwen3-32b") && (await isModelHealthy(env, "xkiro/qwen3-32b")) === true, "2-d: POST /admin/api/health/clear deletes the KV cooldown");
    const entry = await call("GET", "/admin/api/models", null, "http://x/admin/api/models?provider=xkiro");
    const row = (entry.data.models ?? []).find((m) => m.id === "qwen3-32b");
    check(entry.status === 200 && row?.status === "ok" && row?.medianLatencyMs === null, "2-d: GET /admin/api/models carries status + cooldownReason + medianLatencyMs fields");
  }
  // (a2) Phase 2-l: /admin/api/default-combo sets, validates and clears the
  // admin manual default; GET config surfaces it.
  {
    const env = { STATE: fakeKV() };
    const call = async (method, pathname, body) => {
      const req = { method, url: `http://x${pathname}`, json: async () => body };
      const res = await adminApi(req, env, method, pathname);
      return { status: res.status, data: await res.json() };
    };
    const bad = await call("POST", "/admin/api/default-combo", { combo: "no-such" });
    check(bad.status === 400 && /unknown combo/.test(bad.data.error ?? ""), "2-l: unknown default combo rejected with 400");
    const set = await call("POST", "/admin/api/default-combo", { combo: "chat" });
    const cfg = await call("GET", "/admin/api/config", null);
    check(set.status === 200 && set.data.defaultCombo === "chat" && cfg.data.defaultCombo === "chat", "2-l: default combo stored and surfaced by GET config");
    const clr = await call("DELETE", "/admin/api/default-combo", null);
    const cfg2 = await call("GET", "/admin/api/config", null);
    check(clr.status === 200 && clr.data.defaultCombo === null && cfg2.data.defaultCombo === null, "2-l: DELETE clears the default combo");
  }
  // (b) KV-cooling pinned models do not block healthy targets; previews
  // do not advance the round-robin pointer.
  {
    const kv = fakeKV();
    await kv.put("catalog:xkiro", JSON.stringify({ models: [
      { id: "cool-model", provider: "xkiro", context: 131072 },
      { id: "fresh-model", provider: "xkiro", context: 131072 },
    ] }));
    await kv.put("overrides:v1", JSON.stringify({ pins: { chat: ["xkiro/cool-model"] }, bans: [], prefer: {} }));
    const env = { STATE: kv };
    await markFailure(env, "xkiro/cool-model", classifyFailure(null, "", true), "timeout");
    const sel = await getComboTargets(env, "chat");
    const order = (sel.targets ?? []).map((t) => `${t.provider}/${t.model}`);
    const coolIdx = order.indexOf("xkiro/cool-model");
    const freshIdx = order.indexOf("xkiro/fresh-model");
    check(!sel.error && freshIdx !== -1 && coolIdx !== -1 && freshIdx < coolIdx && sel.targets[coolIdx].pinned === true, "2-d: KV-cooling pin is demoted after healthy targets, still marked pinned");
    await kv.put("config:v1", JSON.stringify({ providers: [], combos: [{ name: "rrtest", strategy: "round-robin", timeoutMs: 13000, retries: 0, targets: [{ provider: "xkiro", model: "a", enabled: true }, { provider: "xkiro", model: "b", enabled: true }] }] }));
    const p1 = await getComboTargets(env, "rrtest", { preview: true });
    const p2 = await getComboTargets(env, "rrtest", { preview: true });
    check((await kv.get("rr:rrtest")) === null && p1.targets.map((t) => t.model).join(",") === "a,b" && p2.targets.map((t) => t.model).join(",") === "a,b", "2-d: preview getComboTargets does not advance rr:<combo>");
    const r1 = await getComboTargets(env, "rrtest");
    const r2 = await getComboTargets(env, "rrtest");
    check((await kv.get("rr:rrtest")) === "0" && r1.targets.map((t) => t.model).join(",") === "a,b" && r2.targets.map((t) => t.model).join(",") === "b,a", "2-d: real getComboTargets advances rr:<combo> and rotates");
  }
  // (c) Compact keyboards + stray-dot strip (save-time and render-time).
  {
    const sc = fresh1d6();
    seedProj6(sc.sq, 1, "عمومی", [], 1);
    seedProj6(sc.sq, 1, "گلبهار", []);
    seedProj6(sc.sq, 1, "ایجنت", []);
    seedProj6(sc.sq, 1, "قرارها", []);
    seedProj6(sc.sq, 1, "یوتیوب", []);
    for (let i = 0; i < 8; i++) sc.sq.prepare("INSERT INTO notes (user_id, text, source, created_at) VALUES (1, ?, 'text', '2026-10-20T09:00:00.000Z')").run(`یادداشت ${i + 1}`);
    for (let i = 0; i < 4; i++) sc.sq.prepare("INSERT INTO tasks (user_id, title, status, created_at) VALUES (1, ?, 'open', '2026-10-20T09:00:00.000Z')").run(`تسک ${i + 1}`);
    const env = { STATE: fakeKV(), DB: sc.db };
    const list = await renderNoteList(env, 1, {});
    const delRows = list.keyboard.filter((row) => row.every((b) => b.callback_data.startsWith("note:del:")));
    const filterRows = list.keyboard.filter((row) => row.every((b) => b.callback_data.startsWith("note:proj:")));
    check(list.ok === true && delRows.length === 2 && delRows.every((r) => r.length <= 4) && delRows[0][0].text === "🗑 #1" && filterRows.every((r) => r.length <= 3), "2-d: note delete buttons packed 4/row, project filters chunked ≤3/row");
    const tl = await renderTaskList(env, 1, null, 0);
    const taskRows = tl.keyboard.filter((row) => row.some((b) => b.callback_data.startsWith("task:done:")));
    check(tl.ok === true && taskRows.length === 2 && taskRows[0].length === 4 && taskRows[0][0].text === "✅1" && tl.text.startsWith("1. تسک 1"), "2-d: task action buttons packed 2 tasks/row, numbered to match the list");
    check(stripLeadingNotePunct(". یه قابلیت") === "یه قابلیت" && stripLeadingNotePunct(": تست") === "تست" && stripLeadingNotePunct("- مورد") === "مورد" && stripLeadingNotePunct("سالم") === "سالم", "2-d: stripLeadingNotePunct trims leading . : - only");
    check(deriveNoteTitle(". خط اول\nخط دوم") === "خط اول" && deriveNoteTitle("   ") === "بدون عنوان" && deriveNoteTitle("کوتاه") === "کوتاه", "3-a: deriveNoteTitle uses the first meaningful line and falls back to بدون عنوان");
    check(deriveNoteTitle("ا".repeat(80)).length === 61 && deriveNoteTitle("ا".repeat(80)).endsWith("…"), "3-a: deriveNoteTitle caps a long title on a word boundary");
    const c = convo6(sc);
    await c.say("یادداشت: . یه قابلیت تازه", MORNING);
    const saved = sc.rows("SELECT text FROM notes WHERE user_id = 1 ORDER BY id DESC LIMIT 1")[0];
    check(saved?.text === "یه قابلیت تازه", "2-d: note saved from 'یادداشت: . ...' has no leading dot");
    sc.sq.prepare("INSERT INTO notes (user_id, text, source, created_at) VALUES (1, '. قدیمی', 'text', '2026-10-21T09:00:00.000Z')").run();
    const list2 = await renderNoteList(env, 1, {});
    check(list2.text.includes("قدیمی") && !list2.text.includes(". قدیمی"), "2-d: legacy note row with a leading dot renders clean");
  }
  // (d) Compact failure detail: count line + first 3 lines + overflow.
  {
    check(formatFailureDetail(["a: 503", "b: 429"]) === "تعداد مدل‌های بررسی‌شده: 2\na: 503\nb: 429", "2-d: formatFailureDetail keeps short failure lists with a count line");
    const many = ["m1: 503", "m2: 429", "m3: timeout", "m4: 503", "m5: 429", "m6: 503", "m7: timeout"];
    check(formatFailureDetail(many) === "تعداد مدل‌های بررسی‌شده: 7\nm1: 503\nm2: 429\nm3: timeout\n(+4 مورد دیگر)", "2-d: formatFailureDetail caps at 3 lines with a (+N) overflow line");
    check(formatFailureDetail([]) === "", "2-d: formatFailureDetail of no failures is empty");
  }
  // (e) Line-aware splitTelegramText: newline/word boundaries first,
  // hard slice only for a token longer than maxLen.
  {
    check(JSON.stringify(splitTelegramText("word1 word2 word3", 6)) === JSON.stringify(["word1", "word2", "word3"]), "2-d: splitTelegramText prefers word boundaries over mid-word cuts");
    check(JSON.stringify(splitTelegramText("line1\nline2\nline3", 6)) === JSON.stringify(["line1", "line2", "line3"]), "2-d: splitTelegramText prefers newline boundaries");
    check(JSON.stringify(splitTelegramText("سلام دنیا خوبی", 8)) === JSON.stringify(["سلام", "دنیا", "خوبی"]), "2-d: splitTelegramText never cuts a Persian word in half");
    check(JSON.stringify(splitTelegramText("a".repeat(25), 10)) === JSON.stringify(["a".repeat(10), "a".repeat(10), "a".repeat(5)]), "2-d: splitTelegramText hard-slices a token longer than maxLen");
  }
  // (f) Webhook update_id deduplication.
  {
    resetSeenUpdateIdsForTests();
    const sends = [];
    const prev = global.fetch;
    global.fetch = async (url, init = {}) => {
      const m = /\/bot[^/]+\/(\w+)$/.exec(String(url));
      let payload = {};
      try { payload = JSON.parse(String(init.body ?? "{}")); } catch {}
      sends.push({ method: m ? m[1] : "", payload });
      return Response.json({ ok: true, result: { message_id: 1 } });
    };
    try {
      const env = { TG_TOKEN: "x", ALLOWED_TG_IDS: "1" };
      const upd = (id) => ({ update_id: id, message: { from: { id: 1 }, chat: { id: 1 }, text: "/ping" } });
      await handleUpdate(env, upd(987654321));
      await handleUpdate(env, upd(987654321));
      await handleUpdate(env, upd(987654322));
      const pongs = sends.filter((s) => s.method === "sendMessage" && s.payload.text === "pong");
      check(pongs.length === 2, "2-d: redelivered update_id is ignored, a new update_id still answers");
    } finally { global.fetch = prev; }
  }
  // (g) ask:dp tap edits the original ask message in place when
  // editText is available; without it, the old send path is kept.
  {
    const sc = fresh1d6(); const c = convo6(sc);
    await c.say("یادآوری کن فردا ساعت ۰۳:۳۰ تست یادآور", MORNING);
    const edited = [];
    const sentBefore = c.s.sent.length;
    await resolveAskCallback(c.env, { fromId: 1, chatId: 1, data: "ask:dp:عصر", nowMs: MORNING, send: c.s.send, editMarkup: async () => {}, editText: async (t) => { edited.push(t); return { ok: true }; } });
    check(edited.length === 1 && edited[0] === "⏰ یادآوری به‌عنوان تسک ذخیره شد." && c.s.sent.length === sentBefore, "2-d: ask:dp tap edits the ask message in place instead of sending a second message");
    const sc2 = fresh1d6(); const c2 = convo6(sc2);
    await c2.say("یادآوری کن فردا ساعت ۰۳:۳۰ تست یادآور", MORNING);
    await resolveAskCallback(c2.env, { fromId: 1, chatId: 1, data: "ask:cancel", nowMs: MORNING, send: c2.s.send, editMarkup: async () => {} });
    check(c2.s.sent.at(-1)?.text === "❌ یادآوری لغو شد.", "2-d: ask:cancel without editText still falls back to send");
  }
  // ── Stable v1 addendum: diagnose + stabilize summary delivery ──
  // Telegram-layer final-content rule, diagnostic metadata, truncation
  // marking, body-stall provenance, summary D1 distinctions. The 2-b
  // router tests above are intentionally untouched: they pin the
  // router//v1 layer, which this addendum preserves.
  {
    check(extractFinalText({ content: "<think>فکر</think>پاسخ نهایی" }) === "پاسخ نهایی", "sumstab: extractFinalText strips a closed <think> block, keeps the final answer");
    check(extractFinalText({ content: "", reasoning_content: "فقط استدلال" }) === "", "sumstab: extractFinalText never falls back to reasoning_content (reasoning-only yields empty)");
    check(extractFinalText({ content: "<think>ناتمام" }) === "", "sumstab: extractFinalText never exposes an unclosed <think> block as the answer");
    check(extractFinalText({ content: "سلام <think>ناتمام" }) === "سلام", "sumstab: extractFinalText keeps text before an unclosed <think> block, drops the block");
    check(extractFinalText({ content: "" }) === "" && extractFinalText({ content: "   " }) === "", "sumstab: extractFinalText genuinely empty stays empty");
    check(extractFinalText({ content: [{ text: "<think>x</think>الف" }, { text: "ب" }] }) === "الفب", "sumstab: extractFinalText joins array content parts, then strips think blocks");
    const mkDbSum = () => {
      const sq = new DatabaseSync(":memory:");
      sq.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
      sq.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
      sq.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
      sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
      const base = (sql) => { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
      return { sq, db: { prepare(sql) { return base(sql); } } };
    };
    const seedCatalogSum = async (kv) => { await kv.put("catalog:xkiro", JSON.stringify({ models: [{ id: "qwen3-32b", provider: "xkiro", context: 131072 }, { id: "qwen3-coder-32b", provider: "xkiro", context: 131072 }] })); };
    const tgProvStub = (calls, replyFn, seenUrls) => async (url, init = {}) => {
      const u = String(url);
      if (seenUrls) seenUrls.push(u);
      if (u.startsWith("https://api.telegram.org/")) {
        const m = /\/bot[^/]+\/(\w+)$/.exec(u);
        let payload = {};
        try { payload = JSON.parse(String(init.body ?? "{}")); } catch {}
        calls.push({ method: m ? m[1] : "", payload });
        return Response.json({ ok: true, result: { message_id: 99 } });
      }
      if (u.includes("api.xkiro.com")) return Response.json({ choices: [{ message: replyFn(), finish_reason: "stop" }] });
      return new Response("unexpected", { status: 500 });
    };
    const deliveredTexts = (calls) => calls.filter((c) => (c.method === "editMessageText" || c.method === "sendMessage") && c.payload?.text !== "⏳ در حال پردازش...").map((c) => c.payload.text);
    const captureDiag = async (fn) => {
      const orig = console.log;
      const lines = [];
      console.log = (...a) => { try { const s = a.map(String).join(" "); if (s.includes("telegram_answer_diag")) lines.push(JSON.parse(s)); } catch {} };
      try { await fn(); } finally { console.log = orig; }
      return lines;
    };
    // (a) Reasoning-only through Telegram: classified failure, never delivered.
    {
      resetRouterHealthForTests();
      const { db } = mkDbSum();
      const kv = fakeKV(); await seedCatalogSum(kv);
      const calls = []; const seenUrls = []; let aiCalls = 0;
      const prev = global.fetch;
      global.fetch = tgProvStub(calls, () => ({ content: "", reasoning_content: "استدلال طولانی مدل" }), seenUrls);
      let diags = [];
      try {
        diags = await captureDiag(() => answerChatText({ STATE: kv, DB: db, TG_TOKEN: "x", ALLOWED_TG_IDS: "1", XKIRO_API_KEY: "k", AI: { run: async () => { aiCalls++; return { response: "{}" }; } } }, 1, 1, "سلام", false, { saveText: "" }));
      } finally { global.fetch = prev; }
      const edit = calls.find((c) => c.method === "editMessageText");
      // Phase 2-f: with in-combo failover (requireFinalText from
      // answerChatText), an all-reasoning-only combo no longer lands in
      // the ok-but-empty "پاسخ خالی بود." branch — it returns ok:false
      // with empty_response entries, so Telegram renders the compact
      // Phase 2-d failure notice (line 1 + count + first lines) on the
      // same progress id, with the diag carrying one errors[] entry
      // per empty_response target. The old bare-empty assertion is
      // superseded by this behavior (directive test 2).
      check(edit?.payload?.message_id === 99 && String(edit?.payload?.text ?? "").includes("مرحله‌ی چت شکست خورد") && String(edit?.payload?.text ?? "").includes("تعداد مدل‌های بررسی‌شده:") && String(edit?.payload?.text ?? "").includes("empty_response") && !String(edit?.payload?.text ?? "").includes("پاسخ خالی بود."), "2-f: reasoning-only all targets → compact failure notice with empty_response lines on the same progress id, NOT bare پاسخ خالی بود. (00:38 shape, supersedes sumstab (a))");
      check(!deliveredTexts(calls).some((t) => String(t).includes("استدلال طولانی مدل")), "sumstab: reasoning text is never delivered as the Telegram answer");
      check(calls.filter((c) => c.method === "sendMessage").length === 1, "sumstab: reasoning-only failure sends no extra message (no orphan, no duplicate)");
      check(aiCalls === 0 && !seenUrls.some((u) => u.includes("generativelanguage")), "sumstab: chat generation uses zero Workers AI / Gemini calls");
      const d = diags[0] ?? {};
      check(d.event === "telegram_answer_diag" && d.stage === "چت" && d.ok === false && Array.isArray(d.errors) && d.errors.length >= 1 && d.errors.every((e) => e.reason === "empty_response"), "2-f: failure diag carries one errors[] entry per empty_response target, never message text");
    }
    // (b) Closed think + final: final delivered, think stripped, same id.
    {
      resetRouterHealthForTests();
      const { db } = mkDbSum();
      const kv = fakeKV(); await seedCatalogSum(kv);
      const calls = [];
      const prev = global.fetch;
      global.fetch = tgProvStub(calls, () => ({ content: "<think>استدلال</think>پاسخ نهایی" }));
      try { await answerChatText({ STATE: kv, DB: db, TG_TOKEN: "x", ALLOWED_TG_IDS: "1", XKIRO_API_KEY: "k" }, 1, 1, "سلام", false, { saveText: "" }); } finally { global.fetch = prev; }
      const edit = calls.find((c) => c.method === "editMessageText");
      check(edit?.payload?.message_id === 99 && edit?.payload?.text === "پاسخ نهایی", "sumstab: closed <think> + final answer delivers only the final text on the same progress id");
    }
    // (c) Unclosed think with pre-text: pre-text only, inner think never delivered.
    {
      resetRouterHealthForTests();
      const { db } = mkDbSum();
      const kv = fakeKV(); await seedCatalogSum(kv);
      const calls = [];
      const prev = global.fetch;
      global.fetch = tgProvStub(calls, () => ({ content: "سلام <think>ناتمام" }));
      try { await answerChatText({ STATE: kv, DB: db, TG_TOKEN: "x", ALLOWED_TG_IDS: "1", XKIRO_API_KEY: "k" }, 1, 1, "سلام", false, { saveText: "" }); } finally { global.fetch = prev; }
      const edit = calls.find((c) => c.method === "editMessageText");
      check(edit?.payload?.text === "سلام", "sumstab: unclosed <think> delivers pre-text only, never the think block");
    }
    // (d) Empty-final fallback within the shared budget: code-combo first
    // call reasoning-only, chat fallback delivers final text.
    {
      resetRouterHealthForTests();
      const { db } = mkDbSum();
      const kv = fakeKV(); await seedCatalogSum(kv);
      const calls = [];
      let n = 0;
      const prev = global.fetch;
      global.fetch = tgProvStub(calls, () => (++n === 1 ? { content: "", reasoning_content: "استدلال" } : { content: "جواب نهایی" }));
      try { await answerChatText({ STATE: kv, DB: db, TG_TOKEN: "x", ALLOWED_TG_IDS: "1", XKIRO_API_KEY: "k" }, 1, 1, "```\nکد\n```", false, { saveText: "" }); } finally { global.fetch = prev; }
      const edit = calls.find((c) => c.method === "editMessageText");
      check(n === 2 && edit?.payload?.text === "جواب نهایی", "2-f: reasoning-only first target recovers via IN-COMBO failover (next target, same combo) inside the shared budget (supersedes the sumstab fallback-combo wording; assertion unchanged)");
    }
    // (e) finish_reason=length: delivered with an incompleteness warning,
    // never labeled complete.
    {
      resetRouterHealthForTests();
      const { db } = mkDbSum();
      const kv = fakeKV(); await seedCatalogSum(kv);
      const calls = [];
      const prev = global.fetch;
      global.fetch = async (url, init = {}) => {
        const u = String(url);
        if (u.startsWith("https://api.telegram.org/")) {
          const m = /\/bot[^/]+\/(\w+)$/.exec(u);
          let payload = {};
          try { payload = JSON.parse(String(init.body ?? "{}")); } catch {}
          calls.push({ method: m ? m[1] : "", payload });
          return Response.json({ ok: true, result: { message_id: 99 } });
        }
        if (u.includes("api.xkiro.com")) return Response.json({ choices: [{ message: { content: "خلاصه کوتاه" }, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
        return new Response("unexpected", { status: 500 });
      };
      try { await answerChatText({ STATE: kv, DB: db, TG_TOKEN: "x", ALLOWED_TG_IDS: "1", XKIRO_API_KEY: "k" }, 1, 1, "سلام", false, { saveText: "" }); } finally { global.fetch = prev; }
      const edit = calls.find((c) => c.method === "editMessageText");
      check(String(edit?.payload?.text ?? "").includes("خلاصه کوتاه") && String(edit?.payload?.text ?? "").includes("ناقص"), "sumstab: finish_reason=length is delivered with an incompleteness warning, never labeled complete");
    }
    // (f) Summary-stage diag: failing summary records stage + budget metadata.
    {
      resetRouterHealthForTests();
      const { db } = mkDbSum();
      const kv = fakeKV(); await seedCatalogSum(kv);
      const calls = [];
      const prev = global.fetch;
      global.fetch = tgProvStub(calls, () => { throw new Error("boom"); });
      let diags = [];
      try {
        diags = await captureDiag(() => answerChatText({ STATE: kv, DB: db, TG_TOKEN: "x", ALLOWED_TG_IDS: "1", XKIRO_API_KEY: "k" }, 1, 1, "خلاصه", false, { saveText: "", failureLabel: "خلاصه‌سازی", maxTokens: 900 }));
      } finally { global.fetch = prev; }
      const d = diags[0] ?? {};
      check(d.stage === "خلاصه‌سازی" && d.budgetMs === 22000 && d.ok === false && typeof d.elapsedMs === "number", "sumstab: summary failure diag carries stage + configured budget + elapsed time");
    }
    // (g) Timer provenance: same "timeout" string, different provenance.
    {
      resetRouterHealthForTests();
      const hungFetch = async (url, init = {}) => new Promise((_, rej) => { init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); });
      const prev = global.fetch;
      try {
        global.fetch = hungFetch;
        const r = await runCombo({ STATE: fakeKV(), XKIRO_API_KEY: "k" }, "xkiro/test-model", { messages: [{ role: "user", content: "hi" }] }, { attemptTimeoutMs: 1500 });
        check(r.ok === false && r.errors[0]?.reason === "timeout" && r.errors[0]?.timerFired === true, "sumstab: own attempt-timer abort records timerFired=true");
      } finally { global.fetch = prev; }
      resetRouterHealthForTests();
      try {
        global.fetch = async () => { throw new Error("timeout"); };
        const r2 = await runCombo({ STATE: fakeKV(), XKIRO_API_KEY: "k" }, "xkiro/test-model", { messages: [{ role: "user", content: "hi" }] }, {});
        check(r2.ok === false && r2.errors[0]?.reason === "timeout" && r2.errors[0]?.timerFired === false, "sumstab: network Error(timeout) without an abort records timerFired=false (string alone proves nothing)");
      } finally { global.fetch = prev; }
      resetRouterHealthForTests();
    }
    // (h) Headers arrive but the body stalls: the body-read race times out
    // against the remaining budget (timerFired=true), it does not hang.
    {
      resetRouterHealthForTests();
      const prev = global.fetch;
      try {
        global.fetch = async (url) => String(url).includes("api.xkiro.com") ? { ok: true, json: () => new Promise(() => {}) } : new Response("unexpected", { status: 500 });
        const t0 = Date.now();
        const r = await runCombo({ STATE: fakeKV(), XKIRO_API_KEY: "k" }, "xkiro/test-model", { messages: [{ role: "user", content: "hi" }] }, { totalTimeoutMs: 2500 });
        const elapsed = Date.now() - t0;
        check(r.ok === false && r.errors[0]?.reason === "timeout" && r.errors[0]?.timerFired === true && elapsed >= 2000 && elapsed < 8000, "sumstab: stalled body read times out via the remaining-budget race (timerFired=true)");
      } finally { global.fetch = prev; }
      resetRouterHealthForTests();
    }
    // (i) Summary D1 distinctions + project filter, zero model calls on
    // empty/error (handleDailyText level, mock o.chat).
    {
      const { sq, db } = mkDbSum();
      sq.exec("INSERT INTO projects (id, user_id, name, aliases, is_default) VALUES (1, 1, 'عمومی', '[]', 1), (2, 1, 'گلبهار', '[\"گل\"]', 0)");
      sq.exec("INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (1, 'یادداشت عمومی', 'text', '2026-10-28T01:24:00+03:30', 1), (1, 'یادداشت گلبهار', 'text', '2026-10-28T02:24:00+03:30', 2)");
      const chats = [];
      const sent = [];
      await handleDailyText({ STATE: fakeKV(), DB: db }, { chatId: 1, userId: 1, text: "یادداشت‌های گلبهار رو خلاصه کن", send: async (t) => { sent.push(t); }, chat: async (t, o) => { chats.push({ text: t, opts: o }); }, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
      check(chats.length === 1 && chats[0].opts.maxTokens === 2200 && chats[0].opts.failureLabel === "خلاصه‌سازی" && String(chats[0].text).includes("یادداشت گلبهار") && !String(chats[0].text).includes("یادداشت عمومی"), "sumstab: project summary passes only that project's verified rows, 2200 tokens, summary failure label (Phase 2-f: 900 -> 2200)");
      const chats2 = []; const sent2 = [];
      await handleDailyText({ STATE: fakeKV(), DB: mkDbSum().db }, { chatId: 1, userId: 1, text: "یادداشت‌هام رو خلاصه کن", send: async (t) => { sent2.push(t); }, chat: async (t, o) => { chats2.push(t); }, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
      check(sent2[0] === "موردی برای خلاصه‌سازی پیدا نشد." && chats2.length === 0, "sumstab: empty folder reports none found with zero model calls");
      const chats3 = []; const sent3 = [];
      await handleDailyText({ STATE: fakeKV(), DB: { prepare() { throw new Error("boom"); } } }, { chatId: 1, userId: 1, text: "یادداشت‌هام رو خلاصه کن", send: async (t) => { sent3.push(t); }, chat: async (t, o) => { chats3.push(t); }, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
      check(String(sent3[0]).includes("خوانده نشد") && chats3.length === 0, "sumstab: D1 failure reports a read failure (not an empty notice) with zero model calls");
    }
    // (j) Phase 2-h: code-heavy notes must summarise via the chat combo,
    // never the code combo (taskType:"chat" pins the route).
    {
      resetRouterHealthForTests();
      const { sq, db } = mkDbSum();
      sq.exec("INSERT INTO notes (user_id, text, source, created_at) VALUES (1, 'باگ در روتر کد و خطا در Cloudflare Workers و function test() { return 1; }', 'text', '2026-10-28T01:24:00+03:30')");
      const kv = fakeKV();
      // 2-i: the chat rule now demotes qwen3.8 (unstable in production) and
      // boosts proven workhorses, so the fixture uses llama-3.3-70b as the
      // healthy chat target; qwen3-coder-plus remains the code-only decoy.
      await kv.put("catalog:xkiro", JSON.stringify({ models: [
        { id: "meta/llama-3.3-70b-instruct", provider: "xkiro", context: 131072 },
        { id: "qwen3-coder-plus", provider: "xkiro", context: 131072 },
      ] }));
      const calls = [];
      const providerModels = [];
      const prev = global.fetch;
      global.fetch = async (url, init = {}) => {
        const u = String(url);
        if (u.startsWith("https://api.telegram.org/")) {
          const m = /\/bot[^/]+\/(\w+)$/.exec(u);
          let payload = {};
          try { payload = JSON.parse(String(init.body ?? "{}")); } catch {}
          calls.push({ method: m ? m[1] : "", payload });
          return Response.json({ ok: true, result: { message_id: 99 } });
        }
        if (u.includes("api.xkiro.com")) {
          let body = {};
          try { body = JSON.parse(String(init.body ?? "{}")); } catch {}
          providerModels.push(body.model ?? null);
          return Response.json({ choices: [{ message: { content: "خلاصه‌ی یادداشت‌ها" }, finish_reason: "stop" }] });
        }
        return new Response("unexpected", { status: 500 });
      };
      const env = { STATE: kv, DB: db, TG_TOKEN: "x", ALLOWED_TG_IDS: "1", XKIRO_API_KEY: "k", SHOW_MODEL: "1" };
      try {
        await handleDailyText(env, {
          chatId: 1, userId: 1, text: "یادداشت‌هام رو خلاصه کن", nowMs: Date.UTC(2026, 9, 28, 12, 0, 0),
          send: async () => {},
          chat: (t, copts) => answerChatText(env, 1, 1, t, false, copts),
        });
      } finally { global.fetch = prev; }
      const edit = calls.find((c) => c.method === "editMessageText");
      const answerText = String(edit?.payload?.text ?? "");
      check(providerModels.length >= 1 && providerModels.every((m) => !/coder/i.test(String(m))), `2-h: code-heavy note summary uses a non-coder target (models: ${providerModels.join(", ")})`);
      check(answerText.includes("- chat /") && !answerText.includes("- code /"), `2-h: code-heavy note summary routes to the chat combo, never code (${answerText})`);
    }
    // ── Phase 2-f: in-combo empty-final failover (Telegram-only),
    // summary 2200-token headroom, /admin Empty-final counter ──
    // (a) Telegram all-reasoning-only WITH a retry id: compact notice +
    // retry button on the same progress id, no orphan ⏳, no extra send.
    {
      resetRouterHealthForTests(); resetEmptyFinalCountsForTests();
      const { db } = mkDbSum();
      const kv = fakeKV(); await seedCatalogSum(kv);
      const calls = [];
      const prev = global.fetch;
      global.fetch = tgProvStub(calls, () => ({ content: "", reasoning_content: "استدلال طولانی مدل" }));
      try { await answerChatText({ STATE: kv, DB: db, TG_TOKEN: "x", ALLOWED_TG_IDS: "1", XKIRO_API_KEY: "k" }, 1, 1, "سلام", false, { saveText: "", retryEntryId: 42 }); } finally { global.fetch = prev; }
      const edit = calls.find((c) => c.method === "editMessageText");
      const kb = edit?.payload?.reply_markup?.inline_keyboard ?? [];
      check(edit?.payload?.message_id === 99 && String(edit?.payload?.text ?? "").includes("مرحله‌ی چت شکست خورد") && String(edit?.payload?.text ?? "").includes("empty_response") && !String(edit?.payload?.text ?? "").includes("پاسخ خالی بود.") && kb.flat().some((b) => b.callback_data === "chat:retry:42"), "2-f: all-reasoning-only Telegram turn renders the compact failure notice WITH retry button on the same progress id (no orphan ⏳)");
      check(calls.filter((c) => c.method === "sendMessage").length === 1, "2-f: compact failure notice sends no extra message");
    }
    // (b) Normal chat always sends the mandatory 700-token cap; summaries
    // still pass their own 2200 override.
    {
      resetRouterHealthForTests();
      const { db } = mkDbSum();
      const kv = fakeKV(); await seedCatalogSum(kv);
      const calls = []; let providerBody = null;
      const prev = global.fetch;
      global.fetch = async (url, init = {}) => {
        const u = String(url);
        if (u.startsWith("https://api.telegram.org/")) {
          const m = /\/bot[^/]+\/(\w+)$/.exec(u);
          let payload = {};
          try { payload = JSON.parse(String(init.body ?? "{}")); } catch {}
          calls.push({ method: m ? m[1] : "", payload });
          return Response.json({ ok: true, result: { message_id: 99 } });
        }
        if (u.includes("api.xkiro.com")) {
          try { providerBody = JSON.parse(String(init.body ?? "{}")); } catch {}
          return Response.json({ choices: [{ message: { content: "سلام! چطور می‌توانم کمک کنم؟" }, finish_reason: "stop" }] });
        }
        return new Response("unexpected", { status: 500 });
      };
      try { await answerChatText({ STATE: kv, DB: db, TG_TOKEN: "x", ALLOWED_TG_IDS: "1", XKIRO_API_KEY: "k" }, 1, 1, "سلام", false, { saveText: "" }); } finally { global.fetch = prev; }
      check(providerBody !== null && providerBody.max_tokens === 700 && providerBody.temperature === 0.7, "2-j: normal chat sends max_tokens 700 with temperature 0.7");
      const edit = calls.find((c) => c.method === "editMessageText");
      check(String(edit?.payload?.text ?? "").includes("سلام! چطور می‌توانم کمک کنم؟"), "2-f: normal chat still delivers its final answer");
    }
    // (c) Empty-final counter: in-memory only (no KV counter keys),
    // surfaced by GET /admin/api/models as emptyFinal24h (0 unknown).
    {
      resetRouterHealthForTests(); resetEmptyFinalCountsForTests();
      const kv = fakeKV(); await seedCatalogSum(kv);
      // runCombo needs the provider key (as in the sumstab Telegram
      // tests); without it the targets are skipped, not fetched.
      const env = { STATE: kv, XKIRO_API_KEY: "k" };
      const call = async (method, pathname, body, url = null) => {
        const req = { method, url: url ?? `http://x${pathname}`, json: async () => body };
        const res = await adminApi(req, env, method, pathname);
        return { status: res.status, data: await res.json() };
      };
      const before = await call("GET", "/admin/api/models", null, "http://x/admin/api/models?provider=xkiro");
      const rowBefore = (before.data.models ?? []).find((m) => m.id === "qwen3-32b");
      check(before.status === 200 && rowBefore?.emptyFinal24h === 0, "2-f: GET /admin/api/models reports emptyFinal24h 0 when unknown");
      const prev = global.fetch;
      global.fetch = tgProvStub([], () => ({ content: "", reasoning_content: "استدلال" }));
      let r;
      try { r = await runCombo(env, "chat", { messages: [{ role: "user", content: "سلام" }] }, { requireFinalText: true }); } finally { global.fetch = prev; }
      check(r.ok === false && Array.isArray(r.tried) && r.tried.length === 2 && r.tried.every((t) => t.endsWith(": empty_response")), "2-f: all-reasoning-only chat combo exhausts with one tried empty_response entry per target");
      const counts = getEmptyFinalCounts();
      check(counts.get("xkiro/qwen3-32b") === 1 && counts.get("xkiro/qwen3-coder-32b") === 1, "2-f: Empty-final counter increments in-memory per target on empty_response");
      check([...kv.store.keys()].every((k) => !k.startsWith("emptyFinal")), "2-f: Empty-final counter writes no KV keys (health cooldown keys are the separate Task 1 markFailure path)");
      const after = await call("GET", "/admin/api/models", null, "http://x/admin/api/models?provider=xkiro");
      const rowAfter = (after.data.models ?? []).find((m) => m.id === "qwen3-32b");
      check(after.status === 200 && rowAfter?.emptyFinal24h === 1, "2-f: GET /admin/api/models surfaces the Empty-final counter per target");
    }
  }
}

// ── Phase 2-g: colloquial list routing + NLU diag + chat memory-claim guard ──
{
  // (a) Phrase → route matrix. classifyDaily is pure (no env.AI, no
  // provider fetch); the runtime tests below count both at the
  // handleDailyText/handleUpdate level.
  const cl2g = (t) => classifyDaily(t, { nowMs: Date.UTC(2026, 10, 4, 12, 0, 0) });
  const taskForms2g = ["تسک‌هام رو نشون بده", "تسک‌هام رو بیار", "تسک‌های من رو نشون بده", "کارهام رو نشون بده", "تسک‌ها رو نشون بده", "تسک‌هام چی دارم", "تسک‌هام چه کارهایی دارم", "تسک‌هام رو لیست کن", "تسک‌هامو لیست کن", "لیست کارهام", "تسک‌هام"];
  for (const t of taskForms2g) check(cl2g(t).intent === "task-list", `2-g: task list form ${t}`);
  const noteForms2g = ["یادداشت‌هام رو نشون بده", "یادداشت‌هام رو بیار", "نوت‌هام رو نشون بده", "نوت‌هامو لیست کن", "یادداشت‌های من رو نشون بده", "یادداشت‌هام چی دارم", "لیست نوت‌هام", "یادداشت‌ها رو نشون بده"];
  for (const t of noteForms2g) check(cl2g(t).intent === "note-query", `2-g: note list form ${t}`);
  check(cl2g("یادداشت‌ها رو نشون بده").projectName == null, "2-g: plural note list without possessive carries no bogus project filter");
  const remForms2g = ["یادآوری‌هام رو نشون بده", "ریمایندرهام رو نشون بده", "یادآوری‌های من رو نشون بده", "یادآوری‌هام رو بیار", "یادآوری‌هام چی دارم", "لیست یادآوری‌هام"];
  for (const t of remForms2g) check(cl2g(t).intent === "reminder-list", `2-g: reminder list form ${t}`);
  check(cl2g("تسک‌های پروژه گلبهار رو نشون بده").intent === "task-list" && cl2g("تسک‌های پروژه گلبهار رو نشون بده").projectName === "گلبهار", "2-g: task list extracts پروژه <name>");
  check(cl2g("تسک‌هام توی پروژه گلبهار رو نشون بده").intent === "task-list" && cl2g("تسک‌هام توی پروژه گلبهار رو نشون بده").projectName === "گلبهار", "2-g: task list extracts توی پروژه <name>");
  // Creation phrases never match .list (creation patterns are checked
  // before the list position in classifyDaily).
  check(cl2g("یه تسک جدید ثبت کن جلسه فردا").intent === "task-create", "2-g: task creation still routes to creation");
  check(cl2g("یادم بنداز فردا ساعت ۵ به علی زنگ بزنم").intent === "reminder", "2-g: reminder creation still routes to creation");
  check(cl2g("اینو یادداشت کن که فردا جلسه دارم").intent === "note", "2-g: note creation still routes to creation");
  check(cl2g("تسک هام شیر بخرم").intent !== "task-list" && cl2g("تسک هام را ببینم").intent !== "task-list" && cl2g("تسک‌هام رو ببینم").intent !== "task-list" && cl2g("کارهام انجام شد").intent !== "task-list" && cl2g("تسک‌هام رو جدول کن").intent !== "summary", "2-g: body/junk/verb forms never route to .list");

  // (g) prompt checks need no sqlite, so they run on every Node.
  check(CHAT_SYSTEM_PROMPT.includes("no access to the user's notes") && CHAT_SYSTEM_PROMPT.includes("برای دیدن تسک‌ها بنویس: تسک‌هام رو نشون بده"), "2-g: free-chat system prompt carries the memory-claim guard");
  check(!SUMMARY_SYSTEM.includes("no access to the user's notes") && SUMMARY_SYSTEM.includes("فهرست شماره‌دار"), "2-g: summary system prompt has no guard and keeps its numbered-list instruction");

  // Everything below needs node:sqlite (Node 22+); on CI's Node 20 it
  // is skipped exactly like every earlier DatabaseSync section.
  if (DatabaseSync) {
    const fresh2g = () => {
      const sq = new DatabaseSync(":memory:");
      sq.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
      sq.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
      sq.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
      sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
      const base = (sql) => { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
      return { sq, db: { prepare(sql) { return base(sql); } } };
    };
    const mkS2g = () => { const sent = []; const chats = []; return { sent, chats, send: async (text, opts) => { sent.push({ text, replyMarkup: opts?.replyMarkup }); }, chat: async (text) => { chats.push(text); }, editMarkup: async () => {} }; };
    const NOW2g = Date.UTC(2026, 10, 4, 12, 0, 0);

    // (b) Runtime routing: every matrix phrase routes through
    // handleDailyText with 0 env.AI.run calls and 0 chat calls.
    {
      const { db } = fresh2g();
      let aiCalls = 0;
      const env = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "1", DB: db, AI: { run: async () => { aiCalls++; return { response: JSON.stringify({ intent: "chat", confidence: 0.9 }) }; } } };
      const s = mkS2g();
      for (const t of [...taskForms2g, ...noteForms2g, ...remForms2g]) {
        const before = s.sent.length, chatsBefore = s.chats.length;
        await handleDailyText(env, { chatId: 1, userId: 1, text: t, send: s.send, chat: s.chat, nowMs: NOW2g });
        check(s.sent.length > before && s.chats.length === chatsBefore, `2-g: ${t} routes deterministically (sent, no chat call)`);
      }
      check(aiCalls === 0, "2-g: deterministic list routing makes 0 env.AI.run calls across the matrix");
    }

    // (c) Project-filtered task list + reminder-only render.
    {
      const { sq, db } = fresh2g();
      sq.prepare("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (1, 'گلبهار', '[]', 'active', 0, '2026-10-01T00:00:00.000Z')").run();
      const golId = sq.prepare("SELECT id FROM projects WHERE user_id = 1 AND name = 'گلبهار'").all()[0].id;
      sq.prepare("INSERT INTO tasks (user_id, title, status, project_id, source, created_at) VALUES (1, 'سیمان گلبهار', 'open', ?, 'text', '2026-10-30T00:00:00.000Z')").run(golId);
      sq.prepare("INSERT INTO tasks (user_id, title, status, project_id, source, created_at) VALUES (1, 'کار عمومی', 'open', NULL, 'text', '2026-10-30T00:00:00.000Z')").run();
      sq.prepare("INSERT INTO tasks (user_id, title, status, project_id, source, created_at, remind_at) VALUES (1, 'زنگ به علی', 'open', NULL, 'text', '2026-10-30T00:00:00.000Z', '2026-11-04T15:00:00.000Z')").run();
      let aiCalls = 0;
      const env = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "1", DB: db, AI: { run: async () => { aiCalls++; return { response: JSON.stringify({ intent: "chat", confidence: 0.9 }) }; } } };
      const s = mkS2g();
      await handleDailyText(env, { chatId: 1, userId: 1, text: "تسک‌های پروژه گلبهار رو نشون بده", send: s.send, chat: s.chat, nowMs: NOW2g });
      const projText = String(s.sent.at(-1)?.text ?? "");
      check(projText.includes("سیمان گلبهار") && !projText.includes("کار عمومی") && aiCalls === 0, "2-g: project-filtered task list shows only that project's tasks, 0 AI calls");
      await handleDailyText(env, { chatId: 1, userId: 1, text: "یادآوری‌هام رو نشون بده", send: s.send, chat: s.chat, nowMs: NOW2g });
      const remText = String(s.sent.at(-1)?.text ?? "");
      check(remText.includes("زنگ به علی") && !remText.includes("کار عمومی") && !remText.includes("سیمان گلبهار"), "2-g: reminder list shows only tasks with a reminder set");
    }

    // (d) Reminder paging keeps the filter (rem:more, never task:more).
    {
      const { sq, db } = fresh2g();
      for (let i = 1; i <= 9; i++) sq.prepare("INSERT INTO tasks (user_id, title, status, source, created_at, remind_at) VALUES (1, ?, 'open', 'text', '2026-10-30T00:00:00.000Z', '2026-11-04T15:00:00.000Z')").run(`یادآوری ${i}`);
      sq.prepare("INSERT INTO tasks (user_id, title, status, source, created_at) VALUES (1, 'کار بدون یادآوری', 'open', 'text', '2026-10-30T00:00:00.000Z')").run();
      const env = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "1", DB: db };
      const s = mkS2g();
      await handleDailyText(env, { chatId: 1, userId: 1, text: "یادآوری‌هام رو نشون بده", send: s.send, chat: s.chat, nowMs: NOW2g });
      const first = s.sent.at(-1);
      const moreBtn = (first?.replyMarkup?.inline_keyboard ?? []).flat().find((b) => String(b.callback_data ?? "").startsWith("rem:more:"));
      check(String(first?.text ?? "").includes("یادآوری 8") && !String(first?.text ?? "").includes("یادآوری 9") && moreBtn?.callback_data === "rem:more:8", "2-g: reminder list pages 8 at a time with a rem:more button");
      await resolveTaskCallback(env, { fromId: 1, chatId: 1, data: "rem:more:8", send: s.send, editMarkup: async () => {}, chat: s.chat, nowMs: NOW2g });
      const second = String(s.sent.at(-1)?.text ?? "");
      check(second.includes("یادآوری 9") && !second.includes("کار بدون یادآوری"), "2-g: rem:more page 2 stays reminder-only");
    }

    // (e) End-to-end: the live phrase via handleUpdate delivers the D1
    // task list with the compact 2-d keyboard and 0 model calls.
    {
      resetSeenUpdateIdsForTests();
      const { sq, db } = fresh2g();
      sq.prepare("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (1, 'گلبهار', '[]', 'active', 0, '2026-10-01T00:00:00.000Z'), (1, 'ایجنت', '[]', 'active', 0, '2026-10-01T00:00:00.000Z'), (1, 'یوتیوب', '[]', 'active', 0, '2026-10-01T00:00:00.000Z'), (1, 'قرارها و ملاقات‌ها', '[]', 'active', 0, '2026-10-01T00:00:00.000Z')").run();
      sq.prepare("INSERT INTO tasks (user_id, title, status, source, created_at) VALUES (1, 'ضبط ویدیوی معرفی', 'open', 'text', '2026-10-30T00:00:00.000Z'), (1, 'خرید سیمان', 'open', 'text', '2026-10-30T00:00:00.000Z')").run();
      let aiCalls = 0, providerCalls = 0;
      const sends = [];
      const prev = global.fetch;
      global.fetch = async (url, init = {}) => {
        const u = String(url);
        if (u.startsWith("https://api.telegram.org/")) {
          const m = /\/bot[^/]+\/(\w+)$/.exec(u);
          let payload = {};
          try { payload = JSON.parse(String(init.body ?? "{}")); } catch {}
          sends.push({ method: m ? m[1] : "", payload });
          return Response.json({ ok: true, result: { message_id: 7 } });
        }
        providerCalls++;
        return new Response("must not be called", { status: 500 });
      };
      try {
        const env = { STATE: fakeKV(), TG_TOKEN: "x", TG_SECRET: "x", ALLOWED_TG_IDS: "1", DB: db, AI: { run: async () => { aiCalls++; return { response: "{}" }; } } };
        await handleUpdate(env, { update_id: 770000001, message: { message_id: 11, from: { id: 1 }, chat: { id: 1 }, text: "تسک‌هام رو نشون بده" } });
      } finally { global.fetch = prev; }
      const listMsg = sends.filter((x) => x.method === "sendMessage").find((x) => String(x.payload.text ?? "").includes("ضبط ویدیوی معرفی"));
      check(!!listMsg && aiCalls === 0 && providerCalls === 0, "2-g: handleUpdate «تسک‌هام رو نشون بده» delivers the D1 task list with 0 AI and 0 provider calls");
      const kb = listMsg?.payload?.reply_markup?.inline_keyboard ?? [];
      const taskRows = kb.filter((row) => row.some((b) => String(b.callback_data ?? "").startsWith("task:done:")));
      const filterRows = kb.filter((row) => row.every((b) => String(b.callback_data ?? "").startsWith("task:proj:")));
      check(taskRows.length === 1 && taskRows[0].length === 4 && filterRows.every((r) => r.length <= 3), "2-g: end-to-end task keyboard packs 2 tasks/row and project filters ≤3/row");
    }

    // (f) intent_nlu_diag: one privacy-safe line per NLU invocation.
    const captureNluDiag = async (fn) => {
      const orig = console.log; const lines = [];
      console.log = (...a) => { try { const s = a.map(String).join(" "); if (s.includes("intent_nlu_diag")) lines.push(JSON.parse(s)); } catch {} };
      try { await fn(); } finally { console.log = orig; }
      return lines;
    };
    const nluEnv2g = (aiRun) => { const { db } = fresh2g(); return { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "1", DB: db, AI: { run: aiRun } }; };
    {
      const env = nluEnv2g(async () => ({ response: JSON.stringify({ intent: "task_list", confidence: 0.9 }) }));
      const s = mkS2g();
      const lines = await captureNluDiag(() => handleDailyText(env, { chatId: 1, userId: 1, text: "ZZMARKER2G لطفا تسک‌هایم را نشان بده", send: s.send, chat: s.chat, nowMs: NOW2g }));
      const d = lines[0] ?? {};
      check(lines.length === 1 && d.event === "intent_nlu_diag" && Array.isArray(d.models) && d.models[0] === DEFAULT_INTERPRETER_MODEL && d.perModel?.[0]?.status === "ok" && d.parseOk === true && d.finalDomain === "task" && d.finalAction === "list" && d.confidence === 0.9 && d.routedTo === "task-list" && typeof d.elapsedMs === "number" && d.fallbackReason === null, "2-g: intent_nlu_diag on a routed NLU turn carries exactly the specified fields");
      check(!JSON.stringify(lines).includes("ZZMARKER2G"), "2-g: intent_nlu_diag never contains user text");
      check([...env.STATE.store.keys()].every((k) => !k.includes("nlu") && !k.includes("diag")), "2-g: intent_nlu_diag writes no KV keys");
    }
    {
      const env = nluEnv2g(async () => ({ response: JSON.stringify({ intent: "chat", confidence: 0.9 }) }));
      const s = mkS2g();
      const lines = await captureNluDiag(() => handleDailyText(env, { chatId: 1, userId: 1, text: "ZZMARKER2G چیزی بگو", send: s.send, chat: s.chat, nowMs: NOW2g }));
      check(lines.length === 1 && lines[0].routedTo === "chat" && lines[0].fallbackReason === "chat-intent" && lines[0].finalDomain === "chat" && lines[0].finalAction === null, "2-g: intent_nlu_diag on a chat verdict reports chat-intent");
    }
    {
      const env = nluEnv2g(async () => ({ response: JSON.stringify({ intent: "task_list", confidence: 0.5 }) }));
      const s = mkS2g();
      const lines = await captureNluDiag(() => handleDailyText(env, { chatId: 1, userId: 1, text: "ZZMARKER2G تسک‌ها", send: s.send, chat: s.chat, nowMs: NOW2g }));
      check(lines.length === 1 && lines[0].routedTo === "chat" && lines[0].fallbackReason === "low-confidence" && lines[0].confidence === 0.5, "2-g: intent_nlu_diag on low confidence reports low-confidence");
    }
    {
      const env = nluEnv2g(async () => ({ response: "this is not json" }));
      const s = mkS2g();
      const lines = await captureNluDiag(() => handleDailyText(env, { chatId: 1, userId: 1, text: "ZZMARKER2G سلام", send: s.send, chat: s.chat, nowMs: NOW2g }));
      check(lines.length === 1 && lines[0].fallbackReason === "bad-json" && lines[0].parseOk === false && lines[0].finalDomain === null, "2-g: intent_nlu_diag on unparseable output reports bad-json");
    }
    {
      const { db } = fresh2g();
      const env = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "1", DB: db };
      const s = mkS2g();
      const lines = await captureNluDiag(() => handleDailyText(env, { chatId: 1, userId: 1, text: "ZZMARKER2G سلام", send: s.send, chat: s.chat, nowMs: NOW2g }));
      check(lines.length === 0, "2-g: no intent_nlu_diag when no model resolves (env.AI never invoked)");
    }

    // (g) Chat memory-claim guard, behavioral half: the chat provider
    // request carries the guard in its system prompt.
    {
      const { db } = fresh2g();
      const kv = fakeKV();
      await kv.put("catalog:xkiro", JSON.stringify({ models: [{ id: "qwen3-32b", provider: "xkiro", context: 131072 }] }));
      let providerBody = null;
      const prev = global.fetch;
      global.fetch = async (url, init = {}) => {
        const u = String(url);
        if (u.startsWith("https://api.telegram.org/")) return Response.json({ ok: true, result: { message_id: 99 } });
        if (u.includes("api.xkiro.com")) { try { providerBody = JSON.parse(String(init.body ?? "{}")); } catch {} return Response.json({ choices: [{ message: { content: "سلام!" }, finish_reason: "stop" }] }); }
        return new Response("unexpected", { status: 500 });
      };
      try { await answerChatText({ STATE: kv, DB: db, TG_TOKEN: "x", ALLOWED_TG_IDS: "1", XKIRO_API_KEY: "k" }, 1, 1, "سلام", false, { saveText: "" }); } finally { global.fetch = prev; }
      const sysMsg = (providerBody?.messages ?? []).find((m) => m.role === "system");
      check(typeof sysMsg?.content === "string" && sysMsg.content.includes("no access to the user's notes"), "2-g: chat provider request carries the memory-claim guard in its system prompt");
      }
    // (h) Phase 2-k: POST /admin/api/probe sends max_tokens>=200, reports
    // ok/failed rows, and cools only real HTTP failures (not HTTP 200).
    {
      resetRouterHealthForTests();
      const kv = fakeKV();
      await kv.put("catalog:xkiro", JSON.stringify({ models: [
        { id: "probe-ok", provider: "xkiro", context: 131072 },
        { id: "probe-down", provider: "xkiro", context: 131072 },
      ] }));
      const env = { STATE: kv, XKIRO_API_KEY: "k" };
      const prev = global.fetch;
      let capturedMaxTokens = null;
      global.fetch = async (url, init = {}) => {
        if (String(url).includes("api.xkiro.com")) {
          let body = {};
          try { body = JSON.parse(String(init.body ?? "{}")); } catch {}
          capturedMaxTokens = body.max_tokens ?? null;
          if (body.model === "probe-down") return new Response(JSON.stringify({ error: { message: "down" } }), { status: 503 });
          return Response.json({ choices: [{ message: { content: "سلام از مدل" } }] });
        }
        return new Response("unexpected", { status: 500 });
      };
      let data;
      try {
        const req = { method: "POST", url: "http://x/admin/api/probe", json: async () => ({ provider: "xkiro", limit: 2 }) };
        const res = await adminApi(req, env, "POST", "/admin/api/probe");
        data = await res.json();
      } finally { global.fetch = prev; }
      const okRow = data?.results?.find((x) => x.target === "xkiro/probe-ok");
      const failRow = data?.results?.find((x) => x.target === "xkiro/probe-down");
      check(capturedMaxTokens !== null && capturedMaxTokens >= 200, `2-k: probe sends max_tokens >= 200 (got ${capturedMaxTokens})`);
      check(data?.ok === true && data.results.length === 2 && okRow?.ok === true && okRow.finalChars > 0 && typeof okRow.elapsedMs === "number" && failRow?.ok === false && failRow.status === 503, "2-k: probe reports ok/failed rows with latency + final chars");
      check((await kv.get("health:xkiro/probe-down")) !== null, "2-k: probe HTTP 503 failure records the target cooldown");
      resetRouterHealthForTests();
    }
    // (i) Phase 2-k: HTTP 200 with reasoning-only content must NOT call
    // markFailure and must NOT put the target into cooldown.
    {
      resetRouterHealthForTests();
      const kv = fakeKV();
      await kv.put("catalog:xkiro", JSON.stringify({ models: [
        { id: "reasoning-model", provider: "xkiro", context: 131072 },
      ] }));
      const env = { STATE: kv, XKIRO_API_KEY: "k" };
      const prev = global.fetch;
      global.fetch = async (url, init = {}) => {
        if (String(url).includes("api.xkiro.com")) {
          return Response.json({ choices: [{ message: { content: "", reasoning_content: "بگذارید فکر کنم..." } }] });
        }
        return new Response("unexpected", { status: 500 });
      };
      let data;
      try {
        const req = { method: "POST", url: "http://x/admin/api/probe", json: async () => ({ provider: "xkiro", limit: 1 }) };
        const res = await adminApi(req, env, "POST", "/admin/api/probe");
        data = await res.json();
      } finally { global.fetch = prev; }
      const row = data?.results?.[0];
      check(row?.ok === true && row.reasoningChars > 0 && row.finalChars === 0, "2-k: HTTP 200 reasoning-only response is marked alive (ok=true)");
      check((await kv.get("health:xkiro/reasoning-model")) === null, "2-k: HTTP 200 reasoning-only response does NOT trigger markFailure / cooldown");
      resetRouterHealthForTests();
    }
    // (j) Phase 2-k: probe reports HTTP status in result and does NOT cool
    // a 404 model via ok=true path.
    {
      resetRouterHealthForTests();
      const kv = fakeKV();
      await kv.put("catalog:xkiro", JSON.stringify({ models: [
        { id: "retired-model", provider: "xkiro", context: 131072 },
      ] }));
      const env = { STATE: kv, XKIRO_API_KEY: "k" };
      const prev = global.fetch;
      global.fetch = async (url) => {
        if (String(url).includes("api.xkiro.com")) return new Response(JSON.stringify({ error: { message: "Not found" } }), { status: 404 });
        return new Response("unexpected", { status: 500 });
      };
      let data;
      try {
        const req = { method: "POST", url: "http://x/admin/api/probe", json: async () => ({ provider: "xkiro", limit: 1 }) };
        const res = await adminApi(req, env, "POST", "/admin/api/probe");
        data = await res.json();
      } finally { global.fetch = prev; }
      const row = data?.results?.[0];
      check(row?.ok === false && row.status === 404, "2-k: probe records HTTP 404 status in result row");
      check((await kv.get("health:xkiro/retired-model")) !== null, "2-k: probe HTTP 404 cools the retired model");
      resetRouterHealthForTests();
    }
    // (k) Phase 2-k: verified threshold is 10000ms; 7s verified probe enters
    // tier-0 (was rejected at 6s in 2-j).
    {
      resetRouterHealthForTests();
      const sq = new DatabaseSync(":memory:");
      const stmt = (sql) => {
        const st = sq.prepare(sql);
        return { bind(...p) { return { run: async () => { st.run(...p); return { success: true }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } };
      };
      const db = { prepare(sql) { return stmt(sql); } };
      const env = { STATE: fakeKV(), DB: db };
      await recordVerifiedModel(env, "xkiro/fast-model", "xkiro", 1200, null);
      check((await getVerifiedLatencies(env)).get("xkiro/fast-model") === 1200, "2-k: 1.2s verified probe enters tier-0");
      await recordVerifiedModel(env, "xkiro/medium-model", "xkiro", 7000, null);
      check((await getVerifiedLatencies(env)).get("xkiro/medium-model") === 7000, "2-k: 7s verified probe now enters tier-0 (threshold raised to 10s)");
      await recordVerifiedModel(env, "xkiro/slow-model", "xkiro", 11000, null);
      check(!(await getVerifiedLatencies(env)).has("xkiro/slow-model"), "2-k: 11s probe is not tier-0 verified");
      resetRouterHealthForTests();
    }
  }
}

// ── Phase 3-A: encrypted vault + Google mirror ────────────────────────────
{
  const env = { VAULT_SECRET: "s1" };
  const c1 = await encryptVaultValue(env, "secret value");
  const c2 = await encryptVaultValue(env, "secret value");
  check(c1.startsWith("enc:v1:") && c1 !== c2 && !c1.includes("secret value") && isEncryptedVaultValue(c1), "3-a: vault encrypts with a random IV and hides the plaintext");
  check((await decryptVaultValue(env, c1)) === "secret value" && (await decryptVaultValue(env, "plain")) === "plain", "3-a: vault round-trips ciphertext and passes plaintext through");
  let wrongKey = false;
  try { await decryptVaultValue({ VAULT_SECRET: "s2" }, c1); } catch { wrongKey = true; }
  check(wrongKey, "3-a: vault decryption fails with the wrong secret");
  check(
    googleVaultStatus({}).configured === false &&
      googleVaultStatus({ webhookUrl: "x", sheetId: "y", driveFolderId: "z" }).modes.join(",") === "webhook,sheets,drive",
    "3-a: googleVaultStatus reports configured modes without secrets",
  );
}
if (DatabaseSync) {
  const sqlite = new DatabaseSync(":memory:");
  const db = { prepare(sql) { const stmt = sqlite.prepare(sql); return { bind(...p) { return { run: async () => { const r = stmt.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: stmt.all(...p) }), first: async () => stmt.get(...p) ?? null }; } }; } };
  const env = { VAULT_SECRET: "s1", DB: db };
  const enc = await encryptVaultValue(env, "top secret");
  const saved = await saveVaultItem(env, { userId: 1, label: "bank", valueEnc: enc, kind: "text" });
  const list = await listVaultItems(env, 1);
  const row = await getVaultItem(env, 1, saved.id);
  check(saved.ok && saved.id === 1 && list.ok && list.items.length === 1 && list.items[0].label === "bank" && !("value_enc" in list.items[0]), "3-a: vault D1 list exposes metadata only");
  check(row && (await decryptVaultValue(env, row.value_enc)) === "top secret" && (await getVaultItem(env, 2, saved.id)) === null, "3-a: vault D1 get is user-scoped and decryptable");
  await setVaultSyncStatus(env, 1, saved.id, "synced", "g1");
  const synced = await getVaultItem(env, 1, saved.id);
  check(synced.sync_status === "synced" && synced.google_id === "g1", "3-a: vault sync status + google id persist");
  check((await deleteVaultItem(env, 2, saved.id)).deleted === false && (await deleteVaultItem(env, 1, saved.id)).deleted === true, "3-a: vault delete is user-scoped");
}
{
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("hook.test")) return Response.json({ ok: true, id: "w1" });
    if (String(url).includes("sheets.googleapis")) return Response.json({ updates: { updatedRange: "A2:D2" } });
    return Response.json({ ok: true });
  };
  const webhookEnv = { GOOGLE_VAULT_WEBHOOK_URL: "https://hook.test/vault", GOOGLE_VAULT_WEBHOOK_SECRET: "shh" };
  const r1 = await syncVaultItemToGoogle(webhookEnv, { id: 1, userId: 1, label: "bank", value: "secret" }, fetchImpl);
  const body1 = JSON.parse(String(calls[0].init.body));
  check(
    r1.ok && r1.mode === "webhook" && r1.googleId === "w1" && calls[0].init.headers["X-Vault-Secret"] === "shh" && body1.value === "secret",
    "3-a: vault webhook sync sends the item with X-Vault-Secret",
  );
  const sheetsEnv = { GOOGLE_VAULT_SHEET_ID: "sheet1", GOOGLE_VAULT_ACCESS_TOKEN: "tok" };
  const r2 = await syncVaultItemToGoogle(sheetsEnv, { id: 2, userId: 1, label: "pin", value: "1234" }, fetchImpl);
  check(r2.ok && r2.mode === "sheets" && r2.googleId === "A2:D2" && calls[1].init.headers.authorization === "Bearer tok", "3-a: vault sheets sync appends a row with a bearer token");
  const r3 = await syncVaultFileToGoogle(webhookEnv, { fileName: "a.txt", mimeType: "text/plain", data: new TextEncoder().encode("hi") }, fetchImpl);
  const body3 = JSON.parse(String(calls[2].init.body));
  check(r3.ok && body3.kind === "file" && body3.dataB64 === btoa("hi"), "3-a: vault file webhook sync carries base64 bytes");
  const pulled = await fetchVaultFromGoogle(webhookEnv, { userId: 1 }, async (url) => {
    check(String(url).includes("userId=1"), "3-a: vault webhook pull scopes by userId");
    return Response.json({ ok: true, items: [{ label: "bank" }] });
  });
  check(pulled.ok && pulled.items[0].label === "bank", "3-a: vault webhook pull returns items");
}

// ── Phase 3-A Part C: conversational vault + file archive ──
{
  const origFetch = global.fetch;
  try {
    if (DatabaseSync) {
      const sqlite = new DatabaseSync(":memory:");
      sqlite.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
      sqlite.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
      sqlite.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
      const d1 = {
        prepare(sql) {
          const stmt = sqlite.prepare(sql);
          return {
            bind(...p) {
              return {
                run: async () => { const r = stmt.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; },
                all: async () => ({ results: stmt.all(...p) }),
                first: async () => stmt.get(...p) ?? null,
              };
            },
          };
        },
      };
      const rows = (sql, params = []) => sqlite.prepare(sql).all(...params);
      const mkEnv = (extra = {}) => ({ STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242", VAULT_SECRET: "s1", DB: d1, ...extra });
      const fakeSend = () => { const sent = []; return { sent, send: async (text, opts) => { sent.push({ text, replyMarkup: opts?.replyMarkup }); } }; };
      const o = (env, userId, text, extra = {}) => ({ chatId: userId, userId, text, send: extra.send, chat: extra.chat ?? (async () => {}), nowMs: extra.nowMs });
      const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
      const cl = (s) => classifyDaily(s, { nowMs: NOW });

      // 1) rule detection
      {

        const save = cl("شماره کارت بانک رسالت من ۶۰۳۷۹۹۷۵۱۲۳۴۵۶۷۸ است ثبتش کن");
        check(save.intent === "vault_save", `vault_save: ${JSON.stringify(save)}`);
        check(save.category === "bank_card" && save.title === "کارت بانک رسالت" && save.value === "6037997512345678", `vault_save fields: ${JSON.stringify({ category: save.category, title: save.title, value: save.value })}`);
        check(cl("\u0634\u0645\u0627ره\u0020\u06a9ارت\u0020رسالتم\u0020چنده؟").intent === "vault_get", "vault_get detected");
        check(cl("شماره کارت‌هام رو نشون بده").intent === "vault_list", "vault_list detected");
        check(cl("شبا رسالت IR123 ذخیره کن").intent === "vault_save" && cl("شبا رسالت IR123 ذخیره کن").category === "sheba" && cl("شبا رسالت IR123 ذخیره کن").value === "123", "sheba save");
        check(cl("کد ملی من 0012345678 را ذخیره کن").intent === "vault_save" && cl("کد ملی من 0012345678 را ذخیره کن").category === "national_id", "national id save");
        check(cl("\u0622\u062e\u0631\u06cc\u0646\u0020\u0622\u0632\u0645\u0627\u06cc\u0634\u0645\u0020\u0631\u0648\u0020\u0628\u0641\u0631\u0633\u062a").intent === "vault_file_get", "vault_file_get detected");
        check(cl("\u0644\u06cc\u0633\u062a\u0020\u0645\u062f\u06cc\u0631\u06cc\u062a\u0020\u0622\u0631\u0634\u06cc\u0648").intent === "vault_list" && cl("\u0644\u06cc\u0633\u062a\u0020\u0645\u062f\u06cc\u0631\u06cc\u062a\u0020\u0622\u0631\u0634\u06cc\u0648").fileList === true, "vault file list detected");
        check(cl("چرا اینقدر خرج می‌کنم؟").intent === "chat", "spending chat stays chat");
      }

      // 2) save -> get -> list via handleDailyText
      {
        const env = mkEnv(), s = fakeSend();
        await handleDailyText(env, o(env, 4242, "شماره کارت بانک رسالت من ۶۰۳۷۹۹۷۵۱۲۳۴۵۶۷۸ است ثبتش کن", { ...s, nowMs: NOW }));
        const last = String(s.sent.at(-1)?.text ?? "");
        check(last.includes("در گاوصندوق امن ذخیره شد") && last.includes("کارت بانک رسالت") && last.includes("6037997512345678"), `vault save reply: ${JSON.stringify(s.sent.at(-1))}`);
        const item = await getVaultItem(env, 4242, 1);
        check(item && (await decryptVaultValue(env, item.value_enc)) === "6037997512345678" && item.category === "bank_card", `vault item stored: ${JSON.stringify({ id: item?.id, category: item?.category, sync: item?.sync_status })}`);
        check(item.sync_status === "pending_google", "vault item pending google when no backend configured");

        const s2 = fakeSend();
        await handleDailyText(env, o(env, 4242, "شماره کارت رسالتم چنده؟", { ...s2, nowMs: NOW }));
        check(String(s2.sent.at(-1)?.text ?? "").includes("6037997512345678"), `vault get reply: ${JSON.stringify(s2.sent.at(-1))}`);

        const s3 = fakeSend();
        await handleDailyText(env, o(env, 4242, "شماره کارت‌هام رو نشون بده", { ...s3, nowMs: NOW }));
        const listed = String(s3.sent.at(-1)?.text ?? "");
        const kb = s3.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
        check(listed.includes("6037997512345678") && kb.includes("vault:csv") && kb.includes("vault:sync"), `vault list reply: ${JSON.stringify({ listed, kb })}`);

        const s4 = fakeSend();
        await handleDailyText(env, o(env, 9999, "کد ملی من چنده؟", { ...s4, nowMs: NOW }));
        check(String(s4.sent.at(-1)?.text ?? "").includes("هیچ موردی در گاوصندوق پیدا نشد"), "vault get empty for stranger");

        const s5 = fakeSend();
        await handleDailyText(env, o(env, 9999, "شماره کارت‌هام رو نشون بده", { ...s5, nowMs: NOW }));
        const sl = String(s5.sent.at(-1)?.text ?? "");
        check(sl.includes("هیچ مقدار ذخیره‌شده‌ای پیدا نشد") || sl.includes("خالی است"), `vault list empty: ${JSON.stringify(sl)}`);
      }

      // 3) file uploads: Case A caption / Case B pending / next-turn naming / retrieval
      const tgCalls = [];
      let driveCalls = 0;
      global.fetch = async (url, init = {}) => {
        const u = String(url);
        if (u.startsWith("https://api.telegram.org/")) {
          const m = /\/bot[^/]+\/(\w+)$/.exec(u);
          const payload = {};
          if (init && init.body) {
            if (typeof init.body.get === "function") {
              for (const key of ["chat_id", "document", "photo", "caption"]) {
                const v = init.body.get(key);
                if (v !== null) payload[key] = v;
              }
            } else if (typeof init.body === "string") {
              try { Object.assign(payload, JSON.parse(init.body)); } catch {}
            }
          }
          tgCalls.push({ method: m ? m[1] : "", payload });
          return Response.json({ ok: true, result: { message_id: 1 } });
        }
        if (u.includes("/getFile")) return Response.json({ ok: true, result: { file_path: "docs/f1" } });
        if (u.includes("/file/bot")) return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
        if (u.includes("googleapis.com/upload/drive")) { driveCalls++; return Response.json({ id: "drive-file-1" }); }
        if (u.includes("googleapis.com") || u.includes("oauth2.googleapis.com")) return Response.json({ ok: true });
        return Response.json({ ok: true });
      };
      try {
        // Case A: captioned document
        {
          const env = mkEnv(), s = fakeSend();
          const handled = await handleVaultFile(env, { userId: 4242, chatId: 4242, tgFileId: "file-1", fileType: "document", mimeType: "application/pdf", fileName: "scan.pdf", caption: "آخرین آزمایش", send: s.send });
          check(handled === true, "handleVaultFile case A handled");
          const text = String(s.sent.at(-1)?.text ?? "");
          check(text.includes("مدرک") && text.includes("آخرین آزمایش") && text.includes("آرشیو امن"), `case A reply: ${JSON.stringify(s.sent.at(-1))}`);
          const f = await getVaultFile(env, 4242, 1);
          check(f && f.title === "آخرین آزمایش" && f.file_type === "document" && f.mime_type === "application/pdf" && f.sync_status === "pending_google", `file row: ${JSON.stringify(f)}`);
        }
        // Case A with Google Drive configured
        {
          const driveBefore = driveCalls;
          const env = mkEnv({ GOOGLE_VAULT_DRIVE_FOLDER_ID: "folder1", GOOGLE_VAULT_ACCESS_TOKEN: "tok" }), s = fakeSend();
          await handleVaultFile(env, { userId: 4242, chatId: 4242, tgFileId: "file-2", fileType: "document", mimeType: "image/png", fileName: "card.png", caption: "تصویر کارت ملی", send: s.send });
          check(driveCalls === driveBefore + 1, "drive upload attempted for captioned file");
          const f = await getVaultFile(env, 4242, 2);
          check(f.sync_status === "synced" && f.drive_url === "drive-file-1", `synced file row: ${JSON.stringify(f)}`);
        }
        // Case B: no caption -> pending
        {
          const env = mkEnv(), s = fakeSend();
          const handled = await handleVaultFile(env, { userId: 4242, chatId: 4242, tgFileId: "file-3", fileType: "photo", mimeType: "image/jpeg", fileName: null, caption: null, send: s.send });
          check(handled === true, "handleVaultFile case B handled");
          check(String(s.sent.at(-1)?.text ?? "").includes("تصویر/فایل دریافت شد. چه کاری انجام دهم؟"), `case B reply: ${JSON.stringify(s.sent.at(-1))}`);
          const kb = s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
          check(kb.includes("vault:analyze:3") && kb.includes("vault:askname:3") && kb.includes("vault:cancel:3"), `case B buttons: ${JSON.stringify(kb)}`);
          const f = (await listVaultFiles(env, 4242)).files.find(f => f.id == 3);
           check(f && f.id == 3, "file renamed: " + JSON.stringify(f));
           check(f && f.title === "__choice__", "file renamed: " + JSON.stringify(f));
        }
        // Next-turn naming: tap vault:askname first
        {
          const env = mkEnv(), s = fakeSend();
          await resolveVaultCallback(env, { fromId: 4242, chatId: 4242, data: "vault:askname:3", send: s.send, editMarkup: async () => {} });
          const handled = await handleDailyText(env, o(env, 4242, "\\u0628\\u06cc\\u0645\\u0647\\u0020\\u0646\\u0627\\u0645\\u0647\\u0020\\u06f2\\u06f0\\u06f6", { ...s, nowMs: NOW }));
          check(handled === "handled", "next-turn naming handled");
          const text = String(s.sent.at(-1)?.text ?? "");
          check(text.includes("\\u0628\\u06cc\\u0645\\u0647\\u0020\\u0646\\u0627\\u0645\\u0647\\u0020\\u06f2\\u06f0\\u06f6") && text.includes("ثبت شد"), `naming reply: ${JSON.stringify(s.sent.at(-1))}`);
           const files = (await listVaultFiles(env, 4242)).files || [];
           check(files.some(f => f.id == 3 && f.title !== "__pending__" && f.title !== "__choice__"), "file renamed: " + JSON.stringify(files.map(f=>({id: f.id, title: f.title}))));
        }
        // Retrieve by text (document file-1)
        {
          const env = mkEnv(), s = fakeSend();
          await handleDailyText(env, o(env, 4242, "آخرین آزمایشم رو بفرست", { ...s, nowMs: NOW }));
          const fileSend = tgCalls.find((c) => (c.method === "sendDocument" && c.payload.document === "file-1") || (c.method === "sendPhoto" && c.payload.photo === "file-3"));
          check(Boolean(fileSend), `retrieve re-sends archived file by file_id: ${JSON.stringify(tgCalls.filter((c) => c.method === "sendDocument" || c.method === "sendPhoto"))}`);
          check(String(fileSend?.payload?.caption ?? "").includes("\u0622\u062e\u0631\u06cc\u0646\u0020\u0622\u0632\u0645\u0627\u06cc\u0634"), "retrieve caption has title");
        }
        // vault:file:<id> callback
        {
          const env = mkEnv();
          check(await resolveVaultCallback(env, { fromId: 4242, chatId: 4242, data: "vault:file:1" }) === true, "vault:file handled");
          const cbSend = tgCalls.find((c) => c.method === "sendDocument" && c.payload.document === "file-1");
          check(Boolean(cbSend), `vault:file callback re-sends document: ${JSON.stringify(cbSend)}`);
        }
        // List archived files
        {
          const env = mkEnv(), s = fakeSend();
          await handleDailyText(env, o(env, 4242, "\u0644\u06cc\u0633\u062a\u0020\u0645\u062f\u06cc\u0631\u06cc\u062a\u0020\u0622\u0631\u0634\u06cc\u0648", { ...s, nowMs: NOW }));
          const flist = String(s.sent.at(-1)?.text ?? "");
          const fkb = s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
          check(flist.includes("\u0622\u062e\u0631\u06cc\u0646\u0020\u0622\u0632\u0645\u0627\u06cc\u0634") && fkb.includes("vault:file:1") && fkb.includes("vault:file:2"), `file list: ${JSON.stringify({ flist, fkb })}`);
        }
        // vault:csv callback
        {
          tgCalls.length = 0;
          const env = mkEnv();
          check(await resolveVaultCallback(env, { fromId: 4242, chatId: 4242, data: "vault:csv" }) === true, "vault:csv handled");
          const docs = tgCalls.filter((c) => c.method === "sendDocument");
          const doc = docs[docs.length - 1];
          check(Boolean(doc) && doc.payload.document.name === "personal-vault.csv", `sendDocument for csv: ${JSON.stringify(docs.map((d) => ({ name: d.payload.document?.name })))}`);
          const csvText = await doc.payload.document.text();
          check(csvText.includes("ID,Category,Title,Value,Extra,UpdatedAt") && csvText.includes("6037997512345678"), `csv content: ${JSON.stringify(csvText.slice(0, 80))}`);
          check(csvText.includes("ID,Category,Title,Value,Extra,UpdatedAt"), "csv header present");
          check(csvText.includes("bank_card") && csvText.includes("کارت بانک رسالت") && csvText.includes("6037997512345678"), `csv row present: ${JSON.stringify(csvText)}`);
        }
        // vault:sync via Google Sheets
        {
          const env = mkEnv({ GOOGLE_VAULT_SHEET_ID: "sheet1", GOOGLE_VAULT_ACCESS_TOKEN: "tok" }), s = fakeSend();
          check(await resolveVaultCallback(env, { fromId: 4242, chatId: 4242, data: "vault:sync", send: s.send }) === true, "vault:sync handled");
          const item = await getVaultItem(env, 4242, 1);
          check(item.sync_status === "synced", `item synced: ${item.sync_status}`);
        }
      } finally {
        global.fetch = origFetch;
      }

      // 4) note:view callback + view buttons on the list
      {
        const env = mkEnv();
        await d1.prepare("INSERT INTO notes (user_id, text, created_at) VALUES (?, ?, ?)").bind(4242, "یادداشت کامل برای نمایش و بررسی", "2026-10-28T12:00:00+03:30").run();
         const nrow = await d1.prepare("SELECT id FROM notes WHERE user_id = 4242 ORDER BY id DESC LIMIT 1").bind().first();
        const noteId = (nrow && typeof nrow.id === 'number') ? nrow.id : null;
        check(noteId != null && noteId > 0, "note inserted: " + JSON.stringify(nrow));
        const s = fakeSend();
        check(await resolveNoteCallback(env, { fromId: 4242, chatId: 4242, data: `note:view:${noteId}`, send: s.send, editMarkup: async () => {} }) === true, "note:view handled");
        const view = String(s.sent.at(-1)?.text ?? "");
        const viewKb = String(s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? "");
         check(view.includes("یادداشت کامل برای نمایش و بررسی") && viewKb.includes(`note:del:${noteId}`), `note view: ${JSON.stringify(s.sent.at(-1))}`);
        const rendered = await renderNoteList(env, 4242);
        const flat = rendered.keyboard.flat();
        check(flat.some((b) => b.text === "📖 #1" && b.callback_data === `note:view:${noteId}`), `view button on list: ${JSON.stringify(rendered.keyboard)}`);
        check(flat.some((b) => b.text === "🗑 #1" && b.callback_data === `note:del:${noteId}`), "delete button on list");
      }
    }
  } finally {
    global.fetch = origFetch;
  }
}

// ── Root-cause audit fixes: migration, report routing, vault lookup, NLU, voice ──
{
  // A) ensureVaultFilesTable migrates an older vault_files table
  if (DatabaseSync) {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE vault_files (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, tg_file_id TEXT NOT NULL, file_type TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    const db = {
      prepare(sql) {
        const stmt = sqlite.prepare(sql);
        return {
          bind(...params) {
            return {
              run: async () => { const r = stmt.run(...params); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; },
              all: async () => ({ results: stmt.all(...params) }),
              first: async () => stmt.get(...params) ?? null,
            };
          },
        };
      },
    };
    const migOk = await ensureVaultFilesTable(db);
    check(migOk === true, "ensureVaultFilesTable migrates older table");
    const env = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242", VAULT_SECRET: "s1", DB: db };
    const sentHolder = [];
    const s = { send: async (text, opts) => { sentHolder.push({ text, replyMarkup: opts?.replyMarkup }); } };
    const handled = await handleVaultFile(env, { userId: 4242, chatId: 4242, tgFileId: "file-x", fileType: "photo", mimeType: "image/jpeg", fileName: null, caption: null, send: s.send });
    check(handled === true, "handleVaultFile photo no caption handled after migration");
    const kb = (sentHolder.at(-1)?.replyMarkup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
    check(kb.some((x) => x.startsWith("vault:analyze:")) && kb.some((x) => x.startsWith("vault:askname:")) && kb.some((x) => x.startsWith("vault:cancel:")), `3 choice buttons after migration: ${JSON.stringify(kb)}`);
    check(!sentHolder.some((x) => String(x.text).includes("ذخیره نشد، دوباره تلاش کن")), "no not-saved after migration");
  }
}

// B) handleDailyText expense report
if (DatabaseSync) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  const d1 = {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            run: async () => { const r = stmt.run(...params); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; },
            all: async () => ({ results: stmt.all(...params) }),
            first: async () => stmt.get(...params) ?? null,
          };
        },
      };
    },
  };
  sqlite.prepare("INSERT INTO expenses (user_id, type, amount, currency_code, item, date, created_at) VALUES (?,?,?,?,?,?,?)").run(4242, "expense", 1000, "TOMAN", "nan", "2026-10-28", new Date().toISOString());
  const env = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242", DB: d1 };
  for (const txt of ["خرج امروز", "خرجای امروز"]) {
    const sent = [];
    const s = { send: async (text, opts) => { sent.push({ text, replyMarkup: opts?.replyMarkup }); } };
    let chats = 0;
    const o = { chatId: 4242, userId: 4242, text: txt, send: s.send, chat: async () => { chats++; }, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) };
    const ret = await handleDailyText(env, o);
    check(ret !== "chat", `${txt} must not fall to chat (got ${ret})`);
    check(chats === 0, `${txt} must not call o.chat`);
    check(sent.some((x) => String(x.text).includes("TOMAN") && String(x.text).includes("1000")), `${txt} report contains TOMAN 1000: ${JSON.stringify(sent)}`);
  }
}

// C) handleDailyText vault get short lookup
if (DatabaseSync) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  const d1 = {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            run: async () => { const r = stmt.run(...params); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; },
            all: async () => ({ results: stmt.all(...params) }),
            first: async () => stmt.get(...params) ?? null,
          };
        },
      };
    },
  };
  const env = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242", VAULT_SECRET: "s1", DB: d1 };
  const sent0 = [];
  await handleDailyText(env, { chatId: 4242, userId: 4242, text: "شماره کارت بانک رسالت من ۶۰۳۷۹۹۷۵۱۲۳۴۵۶۷۸ است ثبتش کن", send: async (t, o) => { sent0.push({ text: t, replyMarkup: o?.replyMarkup }); }, chat: async () => {}, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
  const sent = [];
  const s = { send: async (t, o) => { sent.push({ text: t, replyMarkup: o?.replyMarkup }); } };
  let chats = 0;
  const ret = await handleDailyText(env, { chatId: 4242, userId: 4242, text: "شماره کارت رسالت", send: s.send, chat: async () => { chats++; }, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
  check(ret !== "chat", `vault lookup must not fall to chat (got ${ret})`);
  check(chats === 0, "vault lookup must not call o.chat");
  check(sent.some((x) => String(x.text).includes("6037997512345678")), `vault lookup returns card: ${JSON.stringify(sent)}`);
}

// D) runNluBranch calls env.AI.run
if (DatabaseSync) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
  const d1 = {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            run: async () => { const r = stmt.run(...params); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; },
            all: async () => ({ results: stmt.all(...params) }),
            first: async () => stmt.get(...params) ?? null,
          };
        },
      };
    },
  };
  let aiCalled = null;
  const env = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242", DB: d1, VAULT_SECRET: "s1", INTERPRETER_MODEL: "custom-model", AI: { run: async (model, body) => { aiCalled = { model, body }; return { response: JSON.stringify({ intent: "note", confidence: 0.9, project: null, body: "hello", date_ref: null, time_ref: null, daypart: null, summary_target: null }) }; } } };
  const sent = [];
  const s = { send: async (t, o) => { sent.push({ text: t, replyMarkup: o?.replyMarkup }); } };
  const o = { chatId: 4242, userId: 4242, text: "یه یادداشت برام ثبت کن سلام", send: s.send, chat: async () => {}, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) };
  const ret = await runNluBranch(env, o, { now: Date.UTC(2026, 9, 28, 12, 0, 0), remembered: "TOMAN" });
  check(!!aiCalled, "runNluBranch calls env.AI.run");
  check(aiCalled && aiCalled.model === "@cf/meta/llama-3.3-70b-instruct-fp8-fast", `model default: ${JSON.stringify(aiCalled?.model)}`);
  check(aiCalled && aiCalled.body?.max_tokens === 240 && aiCalled.body?.temperature === 0.1, `params: ${JSON.stringify(aiCalled?.body)}`);
  check(ret === "handled", `runNluBranch routed: ${ret}`);
}

// E) voice handleVoice at most one error message
{
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) return { ok: true, json: async () => ({ ok: true, result: { file_path: "voice/file.ogg" } }) };
    if (u.includes("/file/bot")) return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    if (u.includes("generativelanguage.googleapis.com")) {
      if (init?.method === "DELETE") return { ok: true, json: async () => ({}) };
      if (u.includes("/upload/v1beta/files")) return { ok: true, json: async () => ({ file: { name: "files/abc" } }) };
      if (u.includes("/v1beta/files/abc")) return { ok: true, json: async () => ({ state: "ACTIVE", uri: "https://example/audio" }) };
      if (u.includes(":generateContent")) throw new Error("boom");
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    const env = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242", GEMINI_API_KEY: "k" };
    const sent = [];
    const s = { send: async (t, opts) => { sent.push({ text: t, replyMarkup: opts?.replyMarkup }); } };
    const r = await handleVoice(env, { userId: 4242, chatId: 4242, voice: { file_id: "v", duration: 5, mime_type: "audio/ogg; codecs=opus" }, send: s.send, route: async () => {} });
    check(r === "failed", "voice failed");
    check(sent.length <= 1, `voice at most one error message: ${sent.length}`);
  } finally {
    global.fetch = origFetch;
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
