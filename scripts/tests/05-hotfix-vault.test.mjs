// Hotfixes / vault / audit fixes — extracted from scripts/test-dev.mjs by R0.3; assertions unchanged.
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
  recoverFullNoteBody,
} from "../../src/intent.js";
import { runTask, EXECUTOR_NOT_CONFIGURED } from "../../src/executor.js";
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
} from "../../src/dev.js";
import { isProtectedPath } from "../../src/guard.js";
import { normalizePrefs, DEFAULT_PREFS } from "../../src/tgprefs.js";
import fs from "node:fs";
import { saveMessage, getLatestFileMessage, getChatMessages, listProjects, listProjectsResult, getProject, getMessageRow, insertTask, insertProject, listNotesResult, deleteNote, listOpenTasks, listOpenTasksResult, listDoneTasks, listDoneTasksResult, getTask, addProjectAlias, setTaskStatus, updateTaskFields, insertIntentFeedback, claimDueReminders, releaseReminderClaim, snoozeTaskReminder, purgeOldClosedTasks, saveVaultItem, listVaultItems, getVaultItem, deleteVaultItem, setVaultSyncStatus, saveVaultFile, listVaultFiles, getVaultFile, resolvePendingVaultFile, setFileSyncStatus, ensureVaultFilesTable, ensureVaultTable, ensureUserFactsTable, upsertUserFact, listActiveUserFactsResult, forgetUserFact, claimTelegramUpdateId } from "../../src/db.js";
import { encryptVaultValue, decryptVaultValue, isEncryptedVaultValue, getGoogleVaultConfig, googleVaultStatus, syncVaultItemToGoogle, syncVaultFileToGoogle, fetchVaultFromGoogle } from "../../src/vault.js";
import {
  getChatContext,
  getSetting,
  setSetting,
  getDefaultCurrency,
  CHAT_CONTEXT_LIMIT,
  DEFAULT_CURRENCY,
  searchPersonalMemoryResult,
  buildUserMemoryHeader,
} from "../../src/memory.js";
import { iranDate, weekRange, monthRange, jalaliToGregorian, gregorianToJalali, formatJalali, parseRelativeDate, parseHour, parseReminder, extractFolderTag, resolveProjectName, matchKnownProjectAt, parseNoteQuery, parseSummaryQuery, parseDaypartReply, hasDaypartReply, mergeHourAmbiguousFollowup, stripMiddleFolderTag, normalizeDaypartToken } from "../../src/daily.js";
import { callRouter, runCombo, resetRouterHealthForTests, getRouterHealthSnapshotForTests, extractAssistantText, extractFinalText, getComboTargets, classifyFailure, getEmptyFinalCounts, resetEmptyFinalCountsForTests } from "../../src/router.js";
import { recordProviderCircuitFailure, recordProviderCircuitSuccess, getOpenProviderCircuits, recordVerifiedModel, getVerifiedLatencies } from "../../src/circuit.js";
import { PROVIDERS } from "../../src/providers.js";
import { sendProgressMessage, finalizeProgressMessage, splitTelegramText, escapeHtml, formatTelegramHtml, sendMessage, editMessage, sendDocument, sendPhoto, getFileDownloadData } from "../../src/telegram.js";
import { answerChatText, adminApi, handleUpdate, resetSeenUpdateIdsForTests, CHAT_SYSTEM_PROMPT } from "../../src/index.js";
import { classifyDaily, parseAmount, parseNumberPhrase, normalizeText, bareDigits, resolveDefaultCurrency, sumByCurrency } from "../../src/daily.js";
import { buildInterpreterPrompt, parseInterpreterOutput, interpretText, callInterpreterModel, validateAmountText, validateDateTexts, matchProject, validateInterpreterAction, INTERPRETER_MAX_ACTIONS } from "../../src/interpreter.js";
import { scoreEvalResults, mapOutcome, scoreSlots, runCaseEvaluation, iranNowIso, median } from "../eval-intent.mjs";
import { buildChatContext, mapQuestion, askText, ensureUserRow, handleDailyText, resolveDailyCallback, resolveInterpCallback, resolveTaskCallback, resolveNoteCallback, resolveQuickConvertCallback, resolveChatRetryCallback, resolveAskCallback, hourAmbiguousKeyboard, chatFailureNotice, formatFailureDetail, stripLeadingNotePunct, deriveNoteTitle, renderNoteList, renderTaskList, confirmExpenseDraft, runModelBranch, resolveProjects, CHAT_CONTEXT_CHAR_LIMIT, runReminderTick, quickConvertKeyboard, isUnambiguousQuestion, SUMMARY_SYSTEM, handleVaultFile, resolveVaultCallback, runNluBranch, REF_RE } from "../../src/everyday.js";
import { markFailure, isModelHealthy } from "../../src/health.js";
import { handleDailyFile } from "../../src/everyday.js";
import { resolveVaultCallback as resolveVaultCallbackCore } from "../../src/pipeline/vault-callbacks.js";
import { runVaultAndFileBranch, VAULT_PRIVATE_ONLY_TEXT, VAULT_REDACTED_TEXT } from "../../src/pipeline/daily-helpers.js";
import { classifyVoiceQuota, transcribeWithGemini, handleVoice, handleVoiceRetry, VOICE_FAILED_TEXT, VOICE_TOO_LONG_TEXT } from "../../src/voice.js";
import { downloadTelegramVoice } from "../../src/channels/telegram.js";
import { analyzeVaultImage as analyzeVaultImageRaw } from "../../src/pipeline/vault-files.js";

import { check, failures, fakeKV, mockWorld, workerDefault, ctxNull, sendTg, msgUpdate, cbUpdate, newEnv, DatabaseSync } from "./harness.mjs";

export async function run() {
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
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
    resetRouterHealthForTests();
    const kv = fakeKV();
    await kv.put("catalog:xkiro", JSON.stringify({ models: [
      { id: "cool-model", provider: "xkiro", context: 131072 },
      { id: "fresh-model", provider: "xkiro", context: 131072 },
    ] }));
    await kv.put("overrides:v1", JSON.stringify({ pins: { chat: ["xkiro/cool-model"] }, bans: [], prefer: {} }));
    const env = { STATE: kv, __TEST_RR_KV: true };
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
    await kv.put("config:v1", JSON.stringify({ providers: [], combos: [{ name: "chatmini", strategy: "priority", timeoutMs: 13000, retries: 0, targets: [{ provider: "xkiro", model: "cohere/north-mini-code:free", enabled: true }, { provider: "xkiro", model: "good-model", enabled: true }] }] }));
    const mini = await getComboTargets(env, "chatmini", { preview: true });
    check(mini.targets.map((t) => t.model).join(",") === "good-model,cohere/north-mini-code:free", `fix4: cached non-code combo demotes north-mini-code to the tail: ${JSON.stringify(mini.targets.map((t) => t.model))}`);
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
  if (DatabaseSync) {
    const sqD = new DatabaseSync(":memory:");
    const dbD = { prepare(sql) { const st = sqD.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; } };
    check(await claimTelegramUpdateId(dbD, 7001, 1) === true, "C8: first update_id claim is new");
    check(await claimTelegramUpdateId(dbD, 7001, 2) === false, "C8: duplicate update_id claim is rejected");
    check(await claimTelegramUpdateId({}, 7002, 3) === true, "C8: missing DB fails open");
    const sqN = new DatabaseSync(":memory:");
    const dbN = { prepare(sql) { const st = sqN.prepare(sql); return { bind(...p) { return { run: async () => { st.run(...p); return { success: true }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; } };
    check(await claimTelegramUpdateId(dbN, 7003, 4) === true && await claimTelegramUpdateId(dbN, 7003, 5) === false, "C8: duplicate detected without meta.changes");
    const sendsD = [];
    const prevD = global.fetch;
    global.fetch = async (url, init = {}) => {
      const m = /\/bot[^/]+\/(\w+)$/.exec(String(url));
      let payload = {};
      try { payload = JSON.parse(String(init.body ?? "{}")); } catch {}
      sendsD.push({ method: m ? m[1] : "", payload });
      return Response.json({ ok: true, result: { message_id: 1 } });
    };
    try {
      const envD = { TG_TOKEN: "x", ALLOWED_TG_IDS: "1", DB: dbD };
      const updD = (id) => ({ update_id: id, message: { from: { id: 1 }, chat: { id: 1 }, text: "/ping" } });
      resetSeenUpdateIdsForTests();
      await handleUpdate(envD, updD(7004));
      resetSeenUpdateIdsForTests();
      await handleUpdate(envD, updD(7004));
      resetSeenUpdateIdsForTests();
      await handleUpdate(envD, updD(7005));
      const pongsD = sendsD.filter((s) => s.method === "sendMessage" && s.payload.text === "pong");
      check(pongsD.length === 2, "C8: D1 claim blocks cross-isolate redelivery and accepts a new id");
    } finally { global.fetch = prevD; }
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
      sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
      sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
      sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
      check(answerText.includes("chat ·") && !answerText.includes("code ·") && !answerText.includes("- chat /"), `2-h: code-heavy note summary routes to the chat combo, never code (${answerText})`);
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
  check(CHAT_SYSTEM_PROMPT.includes("[حافظه و اطلاعات شخصی کاربر]") && !CHAT_SYSTEM_PROMPT.includes("no access to the user's notes"), "2-g: free-chat system prompt carries the memory header instruction");
  check(!SUMMARY_SYSTEM.includes("no access to the user's notes") && SUMMARY_SYSTEM.includes("فهرست شماره‌دار"), "2-g: summary system prompt has no guard and keeps its numbered-list instruction");

  // Everything below needs node:sqlite (Node 22+); on CI's Node 20 it
  // is skipped exactly like every earlier DatabaseSync section.
  if (DatabaseSync) {
    const fresh2g = () => {
      const sq = new DatabaseSync(":memory:");
      sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
      sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
      sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
      check(typeof sysMsg?.content === "string" && sysMsg.content.includes("[حافظه و اطلاعات شخصی کاربر]") && !sysMsg.content.includes("no access to the user's notes"), "2-g: chat provider request carries the memory header instruction in its system prompt");
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
  check(c1.startsWith("v1:") && c1 !== c2 && !c1.includes("secret value") && isEncryptedVaultValue(c1), "3-a: vault encrypts with a random IV and hides the plaintext");
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
      sqlite.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
      sqlite.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
      sqlite.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
      const o = (env, userId, text, extra = {}) => ({ chatId: userId, userId, chatType: extra.chatType ?? "private", text, send: extra.send, chat: extra.chat ?? (async () => {}), nowMs: extra.nowMs });
      const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
      const cl = (s) => classifyDaily(s, { nowMs: NOW });

      // 1) rule detection
      {

        const save = cl("شماره کارت بانک رسالت من ۶۰۳۷۹۹۷۵۱۲۳۴۵۶۷۸ است ثبتش کن");
        check(save.intent === "vault_save", `vault_save: ${JSON.stringify(save)}`);
        check(save.category === "bank_card" && save.title === "کارت بانک رسالت" && save.value === "6037997512345678", `vault_save fields: ${JSON.stringify({ category: save.category, title: save.title, value: save.value })}`);
        check(cl("\u0634\u0645\u0627ره\u0020\u06a9ارت\u0020رسالتم\u0020چنده؟").intent === "vault_get", "vault_get detected");
        check(cl("شماره کارت‌هام رو نشون بده").intent === "vault_list", "vault_list detected");
        check(cl("شبا رسالت IR12345678 ذخیره کن").intent === "vault_save" && cl("شبا رسالت IR12345678 ذخیره کن").category === "sheba" && cl("شبا رسالت IR12345678 ذخیره کن").value === "12345678", "sheba save");
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
    if (u.includes("/file/bot")) return new Response(new ArrayBuffer(8), { headers: { "content-type": "application/octet-stream" } });
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
          await resolveVaultCallback(env, { fromId: 4242, chatId: 4242, chatType: "private", data: "vault:askname:3", send: s.send, editMarkup: async () => {} });
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
          check(await resolveVaultCallback(env, { fromId: 4242, chatId: 4242, chatType: "private", data: "vault:file:1" }) === true, "vault:file handled");
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
          check(await resolveVaultCallback(env, { fromId: 4242, chatId: 4242, chatType: "private", data: "vault:csv" }) === true, "vault:csv handled");
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
          check(await resolveVaultCallback(env, { fromId: 4242, chatId: 4242, chatType: "private", data: "vault:sync", send: s.send }) === true, "vault:sync handled");
          const item = await getVaultItem(env, 4242, 1);
          check(item.sync_status === "synced", `item synced: ${item.sync_status}`);
        }
        for (const chatType of [undefined, "group", "supergroup"]) {
          let dbCalls = 0, secretReads = 0, fetchCalls = 0, telegramCalls = 0, documentCalls = 0, messageCalls = 0;
          const env = { STATE: fakeKV(), DB: { prepare() { dbCalls++; throw new Error("unexpected Vault access"); } }, get VAULT_SECRET() { secretReads++; return "s1"; } };
          const callbacks = ["vault:askname:3", "vault:cancel:3", "vault:csv", "vault:sync", "vault:file:1", "vault:analyze:3"];
          const prevFetch = global.fetch;
          global.fetch = async () => { fetchCalls++; return Response.json({ ok: true }); };
          try {
            for (const data of callbacks) {
              const handled = await resolveVaultCallbackCore(env, { fromId: 4242, chatId: 4242, ...(chatType === undefined ? {} : { chatType }), data, send: async () => { messageCalls++; }, editText: async () => { messageCalls++; } }, {
                tgApi: async () => { telegramCalls++; },
                sendDocument: async () => { documentCalls++; },
                getFileDownloadData: async () => { fetchCalls++; },
              });
              check(handled === true, `vault callback rejected outside private chat: ${chatType ?? "missing"} ${data}`);
            }
          } finally { global.fetch = prevFetch; }
          check(dbCalls === 0 && secretReads === 0 && fetchCalls === 0 && telegramCalls === 0 && documentCalls === 0 && messageCalls === 0,
            `vault callbacks outside private chat perform no reads, decryption, sync, delivery, cancellation, or replies: ${chatType ?? "missing"}`);
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
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
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
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
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
  await handleDailyText(env, { chatId: 4242, userId: 4242, chatType: "private", text: "شماره کارت بانک رسالت من ۶۰۳۷۹۹۷۵۱۲۳۴۵۶۷۸ است ثبتش کن", send: async (t, o) => { sent0.push({ text: t, replyMarkup: o?.replyMarkup }); }, chat: async () => {}, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
  const sent = [];
  const s = { send: async (t, o) => { sent.push({ text: t, replyMarkup: o?.replyMarkup }); } };
  let chats = 0;
  const ret = await handleDailyText(env, { chatId: 4242, userId: 4242, chatType: "private", text: "شماره کارت رسالت", send: s.send, chat: async () => { chats++; }, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
  check(ret !== "chat", `vault lookup must not fall to chat (got ${ret})`);
  check(chats === 0, "vault lookup must not call o.chat");
  check(sent.some((x) => String(x.text).includes("6037997512345678")), `vault lookup returns card: ${JSON.stringify(sent)}`);
}

// D) runNluBranch calls env.AI.run
if (DatabaseSync) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
  check(aiCalled && aiCalled.body?.max_tokens === 512 && aiCalled.body?.temperature === 0.1, `params: ${JSON.stringify(aiCalled?.body)}`);
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
      if (u.includes(":generateContent") || u.includes("/v1beta/interactions")) throw new Error("boom");
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    const env = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242", GEMINI_API_KEY: "k" };
    const sent = [];
    const s = { send: async (t, opts) => { sent.push({ text: t, replyMarkup: opts?.replyMarkup }); } };
    const r = await handleVoice(env, { userId: 4242, chatId: 4242, voice: { file_id: "v", duration: 5, mime_type: "audio/ogg; codecs=opus" }, downloadTelegramVoice, send: s.send, route: async () => {} });
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

// ── A11: merge hardening — rename guard, file cap, pinned sha ────────────────
{
  const world = mockWorld({ prFiles: [{ filename: "src/a.js", previous_filename: ".github/workflows/ci.yml" }] });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await sendTg(env, cbUpdate("dev:approve:7"));
    const merge = world.calls.github.find((c) => c.method === "PUT" && c.url.endsWith("/merge"));
    check(!merge, "A11: renamed protected file must block merge");
    const msg = world.calls.telegram.filter((c) => c.method === "sendMessage").at(-1);
    check(String(msg?.payload?.text ?? "").includes("Blocked"), "A11: rename block reports Blocked");
    check(world.calls.unexpected === 0, "A11: no unexpected fetch on rename guard");
  } finally {
    world.restore();
  }
}

{
  const world = mockWorld();
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await env.STATE.put("dev:active:4242", "1");
    await sendTg(env, cbUpdate("dev:approve:7"));
    const merge = world.calls.github.find((c) => c.method === "PUT" && c.url.endsWith("/merge"));
    check(Boolean(merge), "A11: clean approve merges");
    check(merge?.body?.sha === "headsha123", `A11: merge pinned to verified head sha: ${JSON.stringify(merge?.body)}`);
    check(world.calls.unexpected === 0, "A11: no unexpected fetch on pinned merge");
  } finally {
    world.restore();
  }
}

{
  const prFiles = Array.from({ length: 100 }, (_, i) => ({ filename: `src/f${i}.js` }));
  const world = mockWorld({ prFiles });
  try {
    const env = newEnv({ GITHUB_DISPATCH_TOKEN: "gh-fake" });
    await sendTg(env, cbUpdate("dev:approve:7"));
    const merge = world.calls.github.find((c) => c.method === "PUT" && c.url.endsWith("/merge"));
    check(!merge, "A11: 100-file response must fail closed");
  } finally {
    world.restore();
  }
}

// ── A09: reminder tick must treat Telegram { ok: false } as a send failure ──
if (DatabaseSync) {
  const freshA09 = () => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
    sq.prepare("INSERT INTO tasks (user_id, title, status, source, created_at, remind_at, remind_attempts) VALUES (1, '\u0622\u0632\u0645\u0648\u0646 \u062a\u0644\u06af\u0631\u0627\u0645', 'open', 'text', '2026-10-30T00:00:00.000Z', '2026-10-31T11:00:00.000Z', 0)").run();
    const db = { prepare(sql) { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { st.run(...p); return { success: true }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; } };
    return { sq, env: { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "1", DB: db } };
  };
  {
    const { sq, env } = freshA09();
    const nowIso = "2026-10-31T12:00:00.000Z";
    const r = await runReminderTick(env, { nowIso, scheduledTime: Date.UTC(2026, 9, 31, 12, 0, 0), sendMessage: async () => ({ ok: false, error_code: 403, description: "bot was blocked by the user" }) });
    check(r.ok === true && r.sent === 0 && r.failed === 1, `A09: ok:false send counts as failed, not sent: ${JSON.stringify(r)}`);
    const row = sq.prepare("SELECT id, reminded_at FROM tasks WHERE title = '\u0622\u0632\u0645\u0648\u0646 \u062a\u0644\u06af\u0631\u0627\u0645'").get();
    check(row.reminded_at === null, `A09: failed delivery releases the claim: ${JSON.stringify(row)}`);
    const rGood = await runReminderTick(env, { nowIso, scheduledTime: Date.UTC(2026, 9, 31, 12, 0, 0), sendMessage: async () => ({ ok: true }) });
    check(rGood.ok === true && rGood.sent === 1 && rGood.failed === 0, `A09: released reminder is claimable again and honest retry succeeds: ${JSON.stringify(rGood)}`);
    check(sq.prepare("SELECT reminded_at FROM tasks WHERE id = ?").get(row.id).reminded_at === nowIso, "A09: successful delivery keeps the claim");;
  }
}

// ── A07/A15: pending vault file must not hijack an explicit note command, ──
// ── and the naming reply must not claim Google Docs when Google is unconfigured ──
if (DatabaseSync) {
  const mkS2 = () => { const s = { sent: [] }; s.send = async (text, sopts = {}) => { s.sent.push({ ...sopts, text: String(text) }); return { ok: true }; }; return s; };
  const freshA07 = () => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    const db = { prepare(sql) { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { st.run(...p); return { success: true }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; } };
    return { sq, env: { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "999", DB: db } };
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    void init;
    const u = String(url ?? "");
    if (u.includes("/getFile")) return Response.json({ ok: true, result: { file_path: "docs/f9" } });
    if (u.includes("/file/bot")) return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    return Response.json({ ok: true });
  };
  try {
    const NOWA07 = Date.UTC(2026, 9, 31, 12, 0, 0);
    const mkPending = () => {
      const { sq, env } = freshA07();
      // Case B: photo without caption -> choice buttons (__choice__ row)
      const s0 = mkS2();
      sq.prepare("INSERT INTO users (id, telegram_id) VALUES (999, '999')").run();
      return { sq, env, s0 };
    };
    // (1) an explicit note command is NOT consumed as a pending file name
    {
      const { sq, env, s0 } = mkPending();
      await handleVaultFile(env, { userId: 999, chatId: 999, tgFileId: "file-9", fileType: "photo", mimeType: "image/jpeg", fileName: null, caption: null, send: s0.send });
      await resolveVaultCallback(env, { fromId: 999, chatId: 999, chatType: "private", data: "vault:askname:1", send: s0.send });
      const titleAfterAsk = sq.prepare("SELECT title FROM vault_files WHERE id = 1").get().title;
      check(titleAfterAsk === "__pending__", `A07: askname sets __pending__: ${JSON.stringify(titleAfterAsk)}`);
      const s = mkS2();
      await handleDailyText(env, { chatId: 999, userId: 999, text: "\u0627\u06cc\u0646 \u06cc\u0627\u062f\u062f\u0627\u0634\u062a \u0631\u0648 \u062b\u0628\u062a \u06a9\u0646: \u062a\u0633\u062a", send: s.send, chat: async () => {}, nowMs: NOWA07 });
      const texts = s.sent.map((m) => m.text).join(" | ");
      const row = sq.prepare("SELECT title FROM vault_files WHERE id = 1").get();
      check(row.title === "__pending__", `A07: note command is not consumed as a pending file name: ${JSON.stringify(row)}`);
      check(!texts.includes("\u0646\u0627\u0645 \u0641\u0627\u06cc\u0644 \u062b\u0628\u062a \u0634\u062f"), `A07: note command did not take the naming path: ${JSON.stringify(texts)}`);
    }
    // (2) plain naming names the file, but never claims Google Docs when Google is unconfigured
    {
      const { sq, env } = mkPending();
      const s0 = mkS2();
      await handleVaultFile(env, { userId: 999, chatId: 999, tgFileId: "file-9", fileType: "photo", mimeType: "image/jpeg", fileName: null, caption: null, send: s0.send });
      await resolveVaultCallback(env, { fromId: 999, chatId: 999, chatType: "private", data: "vault:askname:1", send: s0.send });
      const s = mkS2();
      await handleDailyText(env, { chatId: 999, userId: 999, text: "\u0628\u06cc\u0645\u0647 \u0646\u0627\u0645\u0647 \u06f2\u06f0\u06f6", send: s.send, chat: async () => {}, nowMs: NOWA07 });
      const reply = String(s.sent.at(-1)?.text ?? "");
      check(reply.includes("\u0646\u0627\u0645 \u0641\u0627\u06cc\u0644 \u062b\u0628\u062a \u0634\u062f") && reply.includes("\u0628\u06cc\u0645\u0647 \u0646\u0627\u0645\u0647 \u06f2\u06f0\u06f6"), `A07: honest local naming reply: ${JSON.stringify(s.sent.at(-1))}`);
      check(!reply.includes("Google Docs"), `A07: no Google Docs claim without sync: ${JSON.stringify(reply)}`);
      const f = sq.prepare("SELECT title FROM vault_files WHERE id = 1").get();
      check(f.title === "\u0628\u06cc\u0645\u0647 \u0646\u0627\u0645\u0647 \u06f2\u06f0\u06f6", `A07: pending file renamed by plain title: ${JSON.stringify(f)}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── A04: chat input dedupe + oversized-history retention ────────────────────
if (DatabaseSync) {
  const freshA04 = () => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
    const base = (sql) => { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
    return { sq, db: { prepare(sql) { return base(sql); } } };
  };
  const captureFetch = (captured) => async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://api.telegram.org/")) return Response.json({ ok: true, result: { message_id: 91 } });
    try { captured.push(JSON.parse(String(init.body ?? "{}"))); } catch {}
    return Response.json({ choices: [{ message: { content: "پاسخ آزمایشی" } }] });
  };
  const chatEnv = async (db) => {
    const kv = fakeKV();
    await kv.put("catalog:xkiro", JSON.stringify({ models: [{ id: "qwen3-32b", provider: "xkiro", context: 131072 }] }));
    return { STATE: kv, DB: db, TG_TOKEN: "x", ALLOWED_TG_IDS: "1", XKIRO_API_KEY: "k" };
  };
  // A04-1: handleDailyText finalises the entry row to kind='chat' before the
  // chat call, so without dedupe the same message is both history and current.
  {
    const { db } = freshA04();
    const env = await chatEnv(db);
    const text = "explain how Workers KV caching works";
    const o = { chatId: 1, userId: 1, text, send: async () => {}, chat: async () => {}, nowMs: Date.UTC(2026, 10, 2, 12, 0, 0) };
    const daily = await handleDailyText(env, o);
    const captured = [];
    const prev = globalThis.fetch;
    globalThis.fetch = captureFetch(captured);
    try {
      await answerChatText(env, 1, 1, text, false, { saveText: "", excludeMessageId: o.entryMessageId });
    } finally { globalThis.fetch = prev; }
    const body = captured.find((b) => Array.isArray(b.messages));
    const hits = (body?.messages ?? []).filter((m) => m.role === "user" && m.content === text).length;
    check(daily === "chat" && hits === 1, `A04: current chat message appears once in LLM input (got ${hits})`);
  }
  // A04-2: a single 8001-char historical turn must be truncated, not wipe
  // all older context on the next turn.
  {
    const { db } = freshA04();
    const env = await chatEnv(db);
    await saveMessage(db, { userId: 1, role: "user", content: "پیام قدیمی", kind: "chat" });
    await saveMessage(db, { userId: 1, role: "user", content: "x".repeat(8001), kind: "chat" });
    const captured = [];
    const prev = globalThis.fetch;
    globalThis.fetch = captureFetch(captured);
    try {
      await answerChatText(env, 1, 1, "سوال بعدی", false, { saveText: "" });
    } finally { globalThis.fetch = prev; }
    const body = captured.find((b) => Array.isArray(b.messages));
    const history = (body?.messages ?? []).slice(1, -1);
    const histChars = history.reduce((a, m) => a + String(m.content ?? "").length, 0);
    check(history.length > 0 && histChars > 0 && histChars <= 8000, `A04: oversized history keeps earlier turns (${history.length} msgs, ${histChars} chars)`);
    check(history.some((m) => String(m.content).endsWith("...")), "A04: oversized historical message is truncated with ...");
  }
}

// ── A08/A19: vault privacy (no plaintext credentials in messages) + versioned ciphertext ──
if (DatabaseSync) {
  const freshA08 = () => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
    const db = { prepare(sql) { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; } };
    return { sq, env: { STATE: fakeKV(), VAULT_MASTER_KEY: "master-a08", DB: db } };
  };
  const runVaultText = async (env, text, chatType) => {
    const sent = [];
    const r = await handleDailyText(env, { chatId: 1, userId: 1, text, chatType, send: async (t) => { sent.push(String(t)); }, chat: async () => {}, nowMs: Date.UTC(2026, 10, 8, 12, 0, 0) });
    return { r, sent, joined: sent.join("\n") };
  };
  // A08: a successful private save stores the redaction placeholder, never the card.
  {
    const { sq, env } = freshA08();
    const card = "6037123412341234";
    const { r } = await runVaultText(env, `شماره کارت رسالت ${card} رو ثبتش کن`, "private");
    const rows = sq.prepare("SELECT content FROM messages WHERE user_id = ?").all(1);
    check(r === "handled" && rows.length > 0, `A08: vault save handled and a message row exists: ${JSON.stringify({ r, rows })}`);
    check(rows.every((row) => !String(row.content).includes(card)), `A08: raw card number never persists in messages.content: ${JSON.stringify(rows)}`);
    check(rows.some((row) => row.content === "[🔒 محتوای حساس گاوصندوق]"), `A08: vault save stores the redaction placeholder: ${JSON.stringify(rows)}`);
  }
  {
    const freshTrackedF01 = () => {
      const { sq, env } = freshA08();
      env.GOOGLE_VAULT_WEBHOOK_URL = "https://f01.invalid/google-sync";
      const operations = [];
      const baseDb = env.DB;
      env.DB = {
        prepare(sql) {
          const statement = baseDb.prepare(sql);
          const operation = { sql: String(sql).replace(/\s+/g, " ").trim().toLowerCase(), params: [], method: null };
          operations.push(operation);
          return {
            bind(...params) {
              const bound = statement.bind(...params);
              operation.params = params;
              return {
                run: async () => { operation.method = "run"; return bound.run(); },
                all: async () => { operation.method = "all"; return bound.all(); },
                first: async () => { operation.method = "first"; return bound.first(); },
              };
            },
          };
        },
      };
      let keyReads = 0;
      Object.defineProperty(env, "VAULT_MASTER_KEY", { configurable: true, get() { keyReads++; return "master-f01"; } });
      return { sq, env, operations, keyReads: () => keyReads, resetKeyReads: () => { keyReads = 0; } };
    };
    const intents = [
      ["vault_save", { title: "F01 test card", value: "f01-nonsecret-test-value" }],
      ["vault_get", { keywords: ["F01"] }],
      ["vault_list", {}],
      ["vault_list", { fileList: true }],
      ["vault_file_get", { keywords: ["F01"] }],
    ];
    const chatTypes = [undefined, null, "group", "supergroup", "channel"];
    const originalFetch = global.fetch;
    let googleRequests = 0;
    global.fetch = async (...args) => { googleRequests++; return originalFetch(...args); };
    try {
      for (const [intent, fields] of intents) {
        for (const chatType of chatTypes) {
          const { sq, env, operations, keyReads } = freshTrackedF01();
          sq.prepare("INSERT INTO messages (id, user_id, role, content, created_at) VALUES (101, 1, 'user', 'F01 owner row', '2026-11-08T12:00:00.000Z'), (202, 2, 'user', 'F01 other owner row', '2026-11-08T12:00:00.000Z')").run();
          let telegramCalls = 0;
          const sent = [];
          const o = {
            userId: 1,
            chatId: 1,
            ...(chatType === undefined ? {} : { chatType }),
            ...(intent === "vault_save" ? { messageRowId: 101 } : {}),
            send: async (text) => { sent.push(String(text)); },
          };
          const fetchBefore = googleRequests;
          const result = await runVaultAndFileBranch(env, o, { intent, ...fields }, {}, {
            tgApi: async () => { telegramCalls++; },
          });
          check(result === "handled" && sent.length === 1 && sent[0] === VAULT_PRIVATE_ONLY_TEXT,
            `F-01: blocked ${intent} returns only the private-chat refusal (${chatType ?? "missing"})`);
          check(telegramCalls === 0 && googleRequests === fetchBefore && keyReads() === 0,
            `F-01: blocked ${intent} does not access crypto, Google sync, or Telegram delivery (${chatType ?? "missing"})`);
          if (intent === "vault_save") {
            check(operations.length === 1 && operations[0].sql === "update messages set content = ?1 where id = ?2 and user_id = ?3" && operations[0].method === "run" && operations[0].params[0] === VAULT_REDACTED_TEXT && operations[0].params[1] === 101 && operations[0].params[2] === 1,
              `F-01: blocked vault_save issues only owner-scoped messages.content redaction (${chatType ?? "missing"})`);
            const ownerContent = sq.prepare("SELECT content FROM messages WHERE id = 101 AND user_id = 1").get()?.content;
            const otherContent = sq.prepare("SELECT content FROM messages WHERE id = 202 AND user_id = 2").get()?.content;
            check(ownerContent === VAULT_REDACTED_TEXT && otherContent === "F01 other owner row",
              `F-01: save redacts the owned row and preserves the other owner's row (${chatType ?? "missing"})`);
          } else {
            check(operations.length === 0,
              `F-01: blocked ${intent} performs no database access, including vault_items/vault_files (${chatType ?? "missing"})`);
          }
        }
      }
    } finally { global.fetch = originalFetch; }

    {
      const { env, operations, keyReads, resetKeyReads } = freshTrackedF01();
      const saved = await saveVaultItem(env, { userId: 1, label: "F01 private get", kind: "text", valueEnc: await encryptVaultValue(env, "f01-private-get-value"), category: "test", syncStatus: "local" });
      check(saved.ok === true, "F-01: private get fixture is saved");
      operations.length = 0;
      resetKeyReads();
      const sent = [];
      const result = await runVaultAndFileBranch(env, { userId: 1, chatId: 1, chatType: "private", send: async (text) => sent.push(String(text)) }, { intent: "vault_get", keywords: ["F01 private get"] }, {}, { tgApi: async () => {} });
      check(result === "handled" && sent.length === 1 && sent[0].includes("f01-private-get-value") && keyReads() > 0,
        "F-01: private vault_get decrypts and returns the matching saved item");
      check(operations.some((op) => op.sql.includes("from vault_items") && op.method === "all") && operations.some((op) => op.sql.includes("from vault_items") && op.method === "first"),
        "F-01: private vault_get queries the item list and selected encrypted row");
    }
    {
      const { env, operations, keyReads, resetKeyReads } = freshTrackedF01();
      const saved = await saveVaultItem(env, { userId: 1, label: "F01 private list", kind: "text", valueEnc: await encryptVaultValue(env, "f01-private-list-value"), category: "test", syncStatus: "local" });
      check(saved.ok === true, "F-01: private text-list fixture is saved");
      operations.length = 0;
      resetKeyReads();
      const sent = [];
      const result = await runVaultAndFileBranch(env, { userId: 1, chatId: 1, chatType: "private", send: async (text, opts) => sent.push({ text: String(text), opts }) }, { intent: "vault_list" }, {}, { tgApi: async () => {} });
      check(result === "handled" && sent.length === 1 && sent[0].text.includes("F01 private list") && sent[0].text.includes("f01-private-list-value") && keyReads() > 0,
        "F-01: private vault_list returns the decrypted text-item listing");
      check(operations.some((op) => op.sql.includes("from vault_items") && op.method === "all") && operations.some((op) => op.sql.includes("from vault_items") && op.method === "first"),
        "F-01: private text-item listing reads vault_items");
    }
    {
      const { env, operations } = freshTrackedF01();
      const saved = await saveVaultFile(env, { userId: 1, tgFileId: "f01-archive-list-file", fileType: "document", mimeType: "application/pdf", title: "F01 private archive listing", fileName: "f01-archive.pdf", caption: null });
      check(saved.ok === true, "F-01: private archive-list fixture is saved");
      operations.length = 0;
      const sent = [];
      const result = await runVaultAndFileBranch(env, { userId: 1, chatId: 1, chatType: "private", send: async (text, opts) => sent.push({ text: String(text), opts }) }, { intent: "vault_list", fileList: true }, {}, { tgApi: async () => {} });
      check(result === "handled" && sent.length === 1 && sent[0].text.includes("F01 private archive listing") && sent[0].opts?.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data === `vault:file:${saved.id}`,
        "F-01: private archived-file listing returns the file title and matching callback");
      check(operations.some((op) => op.sql.includes("from vault_files") && op.method === "all"),
        "F-01: private archive listing reads vault_files");
    }
    {
      const { env, operations } = freshTrackedF01();
      const saved = await saveVaultFile(env, { userId: 1, tgFileId: "f01-archive-delivery-file", fileType: "document", mimeType: "application/pdf", title: "F01 private archive delivery", fileName: "f01-delivery.pdf", caption: null });
      check(saved.ok === true, "F-01: private file-delivery fixture is saved");
      operations.length = 0;
      const telegram = [];
      const result = await runVaultAndFileBranch(env, { userId: 1, chatId: 1, chatType: "private", send: async () => {} }, { intent: "vault_file_get", keywords: ["F01 private archive delivery"] }, {}, { tgApi: async (_env, method, payload) => telegram.push({ method, payload }) });
      check(result === "handled" && telegram.length === 1 && telegram[0].method === "sendDocument" && telegram[0].payload.chat_id === 1 && telegram[0].payload.document === "f01-archive-delivery-file" && telegram[0].payload.caption.includes("F01 private archive delivery"),
        "F-01: private vault_file_get delivers the matching archived document through Telegram");
      check(operations.some((op) => op.sql.includes("from vault_files") && op.method === "all"),
        "F-01: private file retrieval searches vault_files");
    }
  }
  // A19: group vault_get refuses to decrypt/leak.
  {
    const { env } = freshA08();
    const secret = "6037999988887777";
    const valueEnc = await encryptVaultValue(env, secret);
    await saveVaultItem(env, { userId: 1, label: "کارت بانکی", kind: "text", valueEnc, category: "bank_card", syncStatus: "local" });
    const { r, joined } = await runVaultText(env, "شماره کارتم چنده؟", "group");
    check(r === "handled" && joined.includes("عملیات گاوصندوق فقط در چت خصوصی مجاز است"), `A19: group vault_get is refused: ${JSON.stringify(joined)}`);
    check(!joined.includes(secret), `A19: group vault_get never leaks the decrypted secret: ${JSON.stringify(joined)}`);
  }
  // A19: versioned ciphertext + legacy rows stay readable.
  {
    const env = { VAULT_MASTER_KEY: "master-a08", VAULT_SECRET: "older-secret" };
    const current = await encryptVaultValue(env, "legacy-secret");
    check(current.startsWith("v1:"), `A19: new ciphertext is v1-prefixed: ${JSON.stringify(current.slice(0, 3))}`);
    const body = current.slice("v1:".length);
    check((await decryptVaultValue(env, current)) === "legacy-secret", "A19: v1 ciphertext round-trips");
    check((await decryptVaultValue(env, body)) === "legacy-secret", "A19: bare iv:cipher legacy ciphertext decrypts");
    check((await decryptVaultValue(env, `enc:v1:${body}`)) === "legacy-secret", "A19: existing enc:v1 rows remain readable");
    check((await decryptVaultValue({ VAULT_SECRET: "master-a08" }, current)) === "legacy-secret", "A19: VAULT_SECRET remains a valid fallback key");
  }
  // A06: a long voice note survives a truncated NLU body — raw text is canonical.
  {
    const { sq, env: baseEnv } = freshA08();
    const phrase = "امروز جلسه مهمی داشتیم و درباره بودجه و برنامه فردا صحبت کردیم ";
    const core = phrase.repeat(20).slice(0, 500).trim();
    const raw = `${core} این رو توی یادداشت‌هام نگه دار`;
    const truncated = "این خلاصه کوتاه مدل است که باید نادیده گرفته شود";
    const env = { ...baseEnv, AI: { run: async () => ({ response: JSON.stringify({ intent: "note", confidence: 0.95, body: truncated, leading_framing: null, trailing_framing: "این رو توی یادداشت‌هام نگه دار" }) }) } };
    const direct = recoverFullNoteBody(raw, truncated, null, "این رو توی یادداشت‌هام نگه دار");
    check(direct === core, `A06: recoverFullNoteBody keeps the full dictation, not the 50-char model body: ${JSON.stringify({ got: direct.length, want: core.length })}`);
    const r = await handleDailyText(env, { chatId: 1, userId: 1, text: raw, source: "voice", send: async () => {}, chat: async () => {}, nowMs: Date.UTC(2026, 10, 8, 12, 0, 0) });
    const saved = sq.prepare("SELECT text, source FROM notes WHERE user_id = ?").all(1);
    check(r === "handled" && saved.length === 1, `A06: long voice note is handled and stored: ${JSON.stringify({ r, saved })}`);
    check(saved[0]?.text === core && saved[0]?.source === "voice", `A06: stored body is the complete dictation with source voice: ${JSON.stringify({ len: saved[0]?.text?.length, want: core.length, source: saved[0]?.source })}`);
  }
  // A01: keyword mentions inside a long discussion never fire a deterministic write.
  {
    const phrase = "امروز درباره گاوصندوق و شماره کارت و ایمیل و جلسه فردا ساعت ۸ صحبت کردیم. ";
    const para = phrase.repeat(4).slice(0, 200).trim();
    const c = classifyDaily(para);
    check(c.intent !== "vault_save" && c.intent !== "reminder" && c.intent !== "task-create", `A01: long discussion is not a keyword write: ${JSON.stringify(c)}`);
  }
  // A01: negated commands never create tasks/notes/vault items.
  {
    for (const text of ["این کار رو برای فردا ثبت نکن", "این شماره کارت رو ذخیره نکن", "برام تسک نساز", "این یادداشت رو نذار", "این ایمیل رو نفرست"]) {
      const c = classifyDaily(text);
      check(!["note", "task-create", "reminder", "expense", "vault_save"].includes(c.intent), `A01: negated command is not actionable (${text}): ${JSON.stringify(c)}`);
    }
  }
}

  // ── N-10: vault:analyze distinct, safe failure reasons (Gemini only) ──
  if (DatabaseSync) {
    const CANARY = "TESTKEY-FAKE-CANARY-123";
    const N10 = {
      noDownload: "تحلیل ممکن نشد: دانلود فایل از تلگرام انجام نشد.",
      noKey: "تحلیل ممکن نشد: کلید Gemini تنظیم نشده است.",
      http429: "تحلیل ممکن نشد: Gemini خطا داد (کد 429).",
      empty: "تحلیل ممکن نشد: Gemini متنی برنگرداند.",
      network: "تحلیل ممکن نشد: ارتباط با Gemini برقرار نشد.",
    };
    const freshN10 = () => {
      const sq = new DatabaseSync(":memory:");
      for (const file of ["0001_init.sql", "0002_step1_columns.sql", "0003_tasks_projects.sql"]) sq.exec(fs.readFileSync(new URL("../../migrations/" + file, import.meta.url), "utf8"));
      sq.exec("INSERT INTO users (id, telegram_id) VALUES (4242, '4242')");
      const db = { prepare(sql) { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; } };
      return { sq, db };
    };
    const mkN10Env = (db, extra = {}) => ({ STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242", VAULT_SECRET: "s1", DB: db, ...extra });
    const fmtArg = (x) => { try { return typeof x === "string" ? x : JSON.stringify(x); } catch { return String(x); } };
    const withRec = async (fetchImpl, fn) => {
      const urls = [], logs = [], sent = [];
      const origFetch = global.fetch;
      const orig = { log: console.log, warn: console.warn, error: console.error };
      global.fetch = async (url, init) => { urls.push(String(url)); return fetchImpl(String(url), init); };
      for (const k of ["log", "warn", "error"]) console[k] = (...a) => { logs.push(a.map(fmtArg).join(" ")); };
      try { return await fn({ urls, logs, sent, send: async (t) => { sent.push(String(t)); } }); }
      finally { global.fetch = origFetch; console.log = orig.log; console.warn = orig.warn; console.error = orig.error; }
    };
    const runCallbackN10 = async ({ env, download, fetchImpl }) => {
      const saved = await saveVaultFile(env, { userId: 4242, tgFileId: "tg-n10", fileType: "photo", mimeType: "image/jpeg", title: "__choice__", caption: null });
      return withRec(fetchImpl, async (rec) => {
        await resolveVaultCallbackCore(env, { fromId: 4242, chatId: 4242, chatType: "private", data: `vault:analyze:${saved.id}`, send: rec.send }, { getFileDownloadData: download });
        return rec;
      });
    };
    const rawN10 = async ({ env, download, fetchImpl }) => withRec(fetchImpl, async (rec) => {
      const text = await analyzeVaultImageRaw(env, { tg_file_id: "tg-n10", mime_type: "image/jpeg", file_type: "photo" }, null, 4242, { getFileDownloadData: download });
      return { text, ...rec };
    });
    const never = async () => { throw new Error("fetch must not be called"); };
    const n10bUrls = [];
    const n10bBlobParts = [];
    const safeUrls = (urls) => JSON.stringify(urls.map((u) => String(u).split("?")[0]));

    // T1 no_download
    {
      const { db } = freshN10(); const env = mkN10Env(db);
      const r = await runCallbackN10({ env, download: async () => null, fetchImpl: never });
      check(r.sent.length === 1 && r.sent[0] === N10.noDownload, `N-10 T1 no_download message: ${JSON.stringify(r.sent)}`);
      check(r.urls.length === 0, `N-10 T1 no_download zero fetch calls (got ${r.urls.length})`);
      check(!r.sent.join("\n").includes(CANARY) && !r.logs.join("\n").includes(CANARY), "N-10 T1 canary absent from sent texts and logs");
    }
    // T2 no_key
    {
      const { db } = freshN10(); const env = mkN10Env(db);
      const r = await runCallbackN10({ env, download: async () => ({ data: new Uint8Array([1, 2, 3]) }), fetchImpl: never });
      check(r.sent.length === 1 && r.sent[0] === N10.noKey, `N-10 T2 no_key message: ${JSON.stringify(r.sent)}`);
      check(r.urls.length === 0, `N-10 T2 no_key zero fetch calls (got ${r.urls.length})`);
    }
    // T3 http error 429
    {
      const { db } = freshN10(); const env = mkN10Env(db, { GEMINI_API_KEY: CANARY });
      const r = await runCallbackN10({ env, download: async () => ({ data: new Uint8Array([1, 2, 3]) }), fetchImpl: async () => new Response(JSON.stringify({ error: { code: 429 } }), { status: 429, headers: { "content-type": "application/json" } }) });
      check(r.sent.length === 1 && r.sent[0] === N10.http429 && r.sent[0].includes("429"), `N-10 T3 http_429 message: ${JSON.stringify(r.sent)}`);
      n10bUrls.push(...r.urls);
      n10bBlobParts.push(r.sent.join("\n") + "\n" + r.logs.join("\n"));
      const blob = r.sent.join("\n") + "\n" + r.logs.join("\n");
      check(!blob.includes(CANARY) && !blob.includes("generativelanguage") && !blob.includes("key="), "N-10 T3 key/URL absent from sent texts and logs");
    }
    // T4 empty response
    {
      const { db } = freshN10(); const env = mkN10Env(db, { GEMINI_API_KEY: CANARY });
      const r = await runCallbackN10({ env, download: async () => ({ data: new Uint8Array([1, 2, 3]) }), fetchImpl: async () => Response.json({}) });
      check(r.sent.length === 1 && r.sent[0] === N10.empty, `N-10 T4 empty_response message: ${JSON.stringify(r.sent)}`);
    }
    // T5 network error
    {
      const { db } = freshN10(); const env = mkN10Env(db, { GEMINI_API_KEY: CANARY });
      const r = await runCallbackN10({ env, download: async () => ({ data: new Uint8Array([1, 2, 3]) }), fetchImpl: async () => { throw new Error("boom https://x.example/?key=" + CANARY); } });
      check(r.sent.length === 1 && r.sent[0] === N10.network, `N-10 T5 network_error message: ${JSON.stringify(r.sent)}`);
      const blob = r.sent.join("\n") + "\n" + r.logs.join("\n");
      check(!blob.includes(CANARY) && !blob.includes("key=") && !blob.includes("boom"), "N-10 T5 exception/canary/key absent from sent texts and logs");
    }
    // T6 success
    {
      const { db } = freshN10(); const env = mkN10Env(db, { GEMINI_API_KEY: CANARY });
      const r = await runCallbackN10({ env, download: async () => ({ data: new Uint8Array([1, 2, 3]) }), fetchImpl: async () => Response.json({ candidates: [{ content: { parts: [{ text: "RESULT-OK" }] } }] }) });
      check(r.sent.length === 1 && r.sent[0] === "RESULT-OK", `N-10 T6 success text unchanged: ${JSON.stringify(r.sent)}`);
      const hosts = r.urls.map((u) => { try { return new URL(u).host; } catch { return "?"; } });
      check(r.urls.length > 0 && hosts.every((h) => h === "generativelanguage.googleapis.com"), `N-10 T6 only Gemini hosts contacted: ${JSON.stringify(hosts)}`);
    }
    // T7 compatibility: old analyzeVaultImage text-or-null
    {
      const { db } = freshN10(); const env = mkN10Env(db, { GEMINI_API_KEY: CANARY });
      const ok = await rawN10({ env, download: async () => ({ data: new Uint8Array([1, 2, 3]) }), fetchImpl: async () => Response.json({ candidates: [{ content: { parts: [{ text: "RESULT-OK" }] } }] }) });
      check(ok.text === "RESULT-OK", `N-10 T7 legacy success returns text: ${JSON.stringify(ok.text)}`);
      const noDownload = await rawN10({ env: mkN10Env(freshN10().db), download: async () => null, fetchImpl: never });
      check(noDownload.text === null, `N-10 T7 legacy no_download returns null: ${JSON.stringify(noDownload.text)}`);
      const noKey = await rawN10({ env: mkN10Env(freshN10().db), download: async () => ({ data: new Uint8Array([1, 2, 3]) }), fetchImpl: never });
      check(noKey.text === null, `N-10 T7 legacy no_key returns null: ${JSON.stringify(noKey.text)}`);
      const http = await rawN10({ env, download: async () => ({ data: new Uint8Array([1, 2, 3]) }), fetchImpl: async () => new Response("", { status: 429 }) });
      check(http.text === null, `N-10 T7 legacy http failure returns null: ${JSON.stringify(http.text)}`);
      const empty = await rawN10({ env, download: async () => ({ data: new Uint8Array([1, 2, 3]) }), fetchImpl: async () => Response.json({}) });
      check(empty.text === null, `N-10 T7 legacy empty response returns null: ${JSON.stringify(empty.text)}`);
      const net = await rawN10({ env, download: async () => ({ data: new Uint8Array([1, 2, 3]) }), fetchImpl: async () => { throw new Error("boom"); } });
      check(net.text === null, `N-10 T7 legacy network failure returns null: ${JSON.stringify(net.text)}`);
    }
    // T8 primary reason: model 1 429, model 2 404
    {
      const { db } = freshN10(); const env = mkN10Env(db, { GEMINI_API_KEY: CANARY });
      let n = 0;
      const r = await runCallbackN10({ env, download: async () => ({ data: new Uint8Array([1, 2, 3]) }), fetchImpl: async () => { n++; return n === 1 ? new Response("", { status: 429 }) : new Response("", { status: 404 }); } });
      check(r.sent.length === 1 && r.sent[0].includes("429") && !r.sent[0].includes("404"), `N-10 T8 primary reason 429 only: ${JSON.stringify(r.sent)}`);
      n10bUrls.push(...r.urls);
      n10bBlobParts.push(r.sent.join("\n") + "\n" + r.logs.join("\n"));
      const logs = r.logs.join("\n");
      check(logs.includes("http_429") && logs.includes("http_404"), `N-10 T8 both per-model reasons logged: ${JSON.stringify(r.logs)}`);
    }

    // ── N-10b: one shared Gemini vision model list (vault analyze + vision-core) ──
    const OLD_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash"];
    const NEW_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
    const successBody = () => Response.json({ candidates: [{ content: { parts: [{ text: "RESULT-OK" }] } }] });
    const downloadOk = async () => ({ data: new Uint8Array([1, 2, 3]) });

    // M1: first attempted URL uses the new primary model.
    {
      const { db } = freshN10(); const env = mkN10Env(db, { GEMINI_API_KEY: CANARY });
      const r = await runCallbackN10({ env, download: downloadOk, fetchImpl: async () => successBody() });
      n10bUrls.push(...r.urls);
      n10bBlobParts.push(r.sent.join("\n") + "\n" + r.logs.join("\n"));
      check(r.urls.length > 0 && r.urls[0].includes(NEW_MODELS[0]), `N-10b M1 first vault analyze URL uses ${NEW_MODELS[0]}: ${safeUrls(r.urls)}`);
      check(r.sent.length === 1 && r.sent[0] === "RESULT-OK", `N-10b M1 success text unchanged: ${JSON.stringify(r.sent)}`);
    }
    // M2: 404 then success -> fallback model used, final text is the success text.
    {
      const { db } = freshN10(); const env = mkN10Env(db, { GEMINI_API_KEY: CANARY });
      let n = 0;
      const r = await runCallbackN10({ env, download: downloadOk, fetchImpl: async () => (++n === 1 ? new Response("", { status: 404 }) : successBody()) });
      n10bUrls.push(...r.urls);
      n10bBlobParts.push(r.sent.join("\n") + "\n" + r.logs.join("\n"));
      check(r.sent.length === 1 && r.sent[0] === "RESULT-OK", `N-10b M2 fallback success text: ${JSON.stringify(r.sent)}`);
      check(r.urls.length === 2 && r.urls[1].includes(NEW_MODELS[1]), `N-10b M2 second vault analyze URL uses ${NEW_MODELS[1]}: ${safeUrls(r.urls)}`);
    }
    // M3: no old model name in any recorded vault analyze URL (M1/M2/T3/T8).
    {
      check(n10bUrls.length >= 6 && OLD_MODELS.every((m) => n10bUrls.every((u) => !u.includes(m))), `N-10b M3 no stale model in vault analyze URLs: count=${n10bUrls.length}`);
    }
    // M4: vision-core analyzeImage uses the same list, in the same order.
    {
      const { analyzeImage } = await import("../../src/skills/media/vision-core.js");
      let n = 0;
      const r = await withRec(async () => (++n === 1 ? new Response("", { status: 404 }) : successBody()), async (rec) => {
        const out = await analyzeImage({ GEMINI_API_KEY: CANARY }, { imageBytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg", prompt: "تحلیل", fetchFn: (url, init) => global.fetch(url, init) });
        return { out, ...rec };
      });
      n10bUrls.push(...r.urls);
      n10bBlobParts.push(r.sent.join("\n") + "\n" + r.logs.join("\n"));
      check(r.urls.length === 2 && r.urls[0].includes(NEW_MODELS[0]) && r.urls[1].includes(NEW_MODELS[1]), `N-10b M4 vision model order: ${safeUrls(r.urls)}`);
      check(r.out.ok === true && String(r.out.text).includes("RESULT-OK") && OLD_MODELS.every((m) => r.urls.every((u) => !u.includes(m))), `N-10b M4 vision success, no stale model: ${JSON.stringify({ ok: r.out.ok, text: r.out.text })}`);
    }
    // M5: the shared export is the single source of truth.
    {
      let shared = null;
      try { ({ GEMINI_VISION_MODELS: shared } = await import("../../src/platform/gemini-models.js")); } catch {}
      check(JSON.stringify(shared) === JSON.stringify(NEW_MODELS), `N-10b M5 shared constant is the ordered pair: ${JSON.stringify(shared)}`);
      const contents = ["src/pipeline/vault-files.js", "src/skills/media/vision-core.js"].map((p) => fs.readFileSync(new URL("../../" + p, import.meta.url), "utf8"));
      check(contents.every((s) => !s.includes("gemini-2.")), "N-10b M5 no hard-coded old model in vault-files.js or vision-core.js");
    }
    // M6: the canary key and its URL never appear in any sent text or log line.
    {
      const blob = n10bBlobParts.join("\n");
      check(!blob.includes(CANARY) && !blob.includes("generativelanguage") && !blob.includes("key="), "N-10b M6 canary key/URL absent from sent texts and logs");
    }
  }

}
