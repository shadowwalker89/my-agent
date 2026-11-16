// Memory graph / media / PDF — extracted from scripts/test-dev.mjs by R0.3; assertions unchanged.
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
import { classifyVoiceQuota, transcribeWithGemini, handleVoice, handleVoiceRetry, VOICE_FAILED_TEXT, VOICE_TOO_LONG_TEXT } from "../../src/voice.js";

import { check, fakeKV, mockWorld, workerDefault, ctxNull, sendTg, msgUpdate, cbUpdate, newEnv, DatabaseSync } from "./harness.mjs";

export async function run() {
// Phase 2.2: personal memory graph, message dependencies & grounded retrieval (A03/A05/A13/A17)
if (DatabaseSync) {
  const fresh22 = () => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
    const db = { prepare(sql) { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; } };
    return { sq, env: { STATE: fakeKV(), DB: db } };
  };
  {
    const { sq, env } = fresh22();
    check(await ensureUserFactsTable(env) === true, "A03/A05: ensureUserFactsTable creates user_facts");
    const r1 = await upsertUserFact(env, { userId: 1, factKey: "name", factValue: "علی", category: "general", sourceMsgId: 11, nowMs: 1700000000000 });
    check(r1.ok && r1.id != null, `A03/A05: upsert stores علی: ${JSON.stringify(r1)}`);
    const r2 = await upsertUserFact(env, { userId: 1, factKey: "name", factValue: "رضا", category: "general", sourceMsgId: 22, nowMs: 1700000001000 });
    check(r2.ok && r2.id != null && r2.id !== r1.id, `A03/A05: upsert stores رضا as new row: ${JSON.stringify(r2)}`);
    const rows = sq.prepare("SELECT fact_value, status, superseded_by, source_msg_id FROM user_facts WHERE user_id = ? ORDER BY id ASC").all(1);
    check(rows.length === 2 && rows[0].fact_value === "علی" && rows[0].status === "superseded" && rows[0].superseded_by === r2.id, `A03/A05: علی is superseded_by رضا row: ${JSON.stringify(rows)}`);
    check(rows[1].fact_value === "رضا" && rows[1].status === "active" && rows[1].source_msg_id === 22, `A03/A05: رضا is active with source_msg_id provenance: ${JSON.stringify(rows)}`);
    const list = await listActiveUserFactsResult(env, 1);
    check(list.ok === true && Array.isArray(list.rows) && list.rows.length === 1 && list.rows[0].fact_value === "رضا" && list.rows[0].source_msg_id === 22, `A03/A05/A17: listActiveUserFactsResult returns رضا with provenance: ${JSON.stringify(list)}`);
    check((await getSetting(env, 1, "name")) === "رضا", "A03: name fact syncs to setting");
    const s = await searchPersonalMemoryResult(env, 1, "رضا");
    check(s.ok === true && s.facts.length === 1 && s.facts[0].fact_value === "رضا" && s.facts[0].source_msg_id === 22 && s.facts[0].id === r2.id, `A03/A13: search returns رضا with provenance: ${JSON.stringify(s)}`);
    const sOld = await searchPersonalMemoryResult(env, 1, "علی");
    check(sOld.ok === true && sOld.facts.length === 0, `A03/A13: superseded علی never returned by search: ${JSON.stringify(sOld)}`);
    const header = await buildUserMemoryHeader(env, 1, {});
    check(typeof header === "string" && header.includes("رضا") && header.length < 300, `A03/A05: buildUserMemoryHeader is compact and contains رضا: ${JSON.stringify(header)}`);
    const ctx = buildChatContext([{ id: 1, role: "user", content: "سلام" }], { memoryHeader: header });
    check(ctx.length === 2 && ctx[0].content === header, `A03/A05: buildChatContext injects memory header when non-empty: ${JSON.stringify(ctx)}`);
    const ctxNo = buildChatContext([{ id: 1, role: "user", content: "سلام" }], {});
    check(ctxNo.length === 1 && ctxNo[0].content === "سلام", `A03/A05: buildChatContext unchanged without header: ${JSON.stringify(ctxNo)}`);
    await saveMessage(env, { userId: 1, role: "user", content: "پیام مورد نظر", kind: "chat" });
    const msgRow = sq.prepare("SELECT id FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(1);
    const header2 = await buildUserMemoryHeader(env, 1, { replyToMessageId: msgRow.id });
    check(header2.includes("پیام مورد نظر") && header2.length < 300, `A05: buildUserMemoryHeader includes replied message via getMessageRow: ${JSON.stringify(header2)}`);
  }
  {
    const { sq, env } = fresh22();
    await upsertUserFact(env, { userId: 1, factKey: "city", factValue: "تهران", sourceMsgId: 5, nowMs: 1700000000000 });
    sq.prepare("INSERT INTO notes (user_id, text, source, created_at) VALUES (?, ?, ?, ?)").run(1, "جلسه بودجه فردا", "text", new Date().toISOString());
    const noteId = sq.prepare("SELECT id FROM notes WHERE user_id = ?").get(1).id;
    sq.prepare("INSERT INTO tasks (user_id, title, status, source, created_at) VALUES (?, ?, ?, ?, ?)").run(1, "خرید نان", "open", "text", new Date().toISOString());
    const dailyHeader = await buildUserMemoryHeader(env, 1, {});
    check(dailyHeader.includes("خرید نان") && dailyHeader.includes("جلسه بودجه فردا") && dailyHeader.length < 300, `A05/2.2: recent daily actions are compact in header: ${JSON.stringify(dailyHeader)}`);
    let s = await searchPersonalMemoryResult(env, 1, "جلسه");
    check(s.ok === true && s.notes.length === 1 && s.notes[0].id === noteId, `A13: search finds note by keyword: ${JSON.stringify(s)}`);
    await deleteNote(env, 1, noteId);
    s = await searchPersonalMemoryResult(env, 1, "جلسه");
    check(s.ok === true && s.notes.length === 0, `A13: deleted note removed from search: ${JSON.stringify(s)}`);
    s = await searchPersonalMemoryResult(env, 1, "تهران");
    check(s.ok === true && s.facts.length === 1, `A13: search finds active fact تهران: ${JSON.stringify(s)}`);
    const f = await forgetUserFact(env, 1, "city");
    check(f.ok === true, `A13: forgetUserFact ok: ${JSON.stringify(f)}`);
    s = await searchPersonalMemoryResult(env, 1, "تهران");
    check(s.ok === true && s.facts.length === 0, `A13: forgotten fact removed from search: ${JSON.stringify(s)}`);
    const list = await listActiveUserFactsResult(env, 1);
    check(list.ok === true && list.rows.length === 0, `A13: listActive empty after forget (ok:true, not an error): ${JSON.stringify(list)}`);
    s = await searchPersonalMemoryResult(env, 1, "نان");
    check(s.ok === true && s.tasks.length === 1 && s.tasks[0].title === "خرید نان", `A13: search finds task by keyword: ${JSON.stringify(s)}`);
  }
  {
    const badDb = { prepare() { throw new Error("db boom"); } };
    const badEnv = { DB: badDb, STATE: fakeKV() };
    const l = await listActiveUserFactsResult(badEnv, 1);
    check(l.ok === false && !!l.error, `A17: listActiveUserFactsResult returns ok:false on DB throw, not []: ${JSON.stringify(l)}`);
    const s = await searchPersonalMemoryResult(badEnv, 1, "رضا");
    check(s.ok === false && !!s.error, `A17: searchPersonalMemoryResult returns ok:false on DB throw, not []: ${JSON.stringify(s)}`);
    const l2 = await listActiveUserFactsResult({}, 1);
    check(l2.ok === false, `A17: listActiveUserFactsResult returns ok:false on missing DB: ${JSON.stringify(l2)}`);
    const s2 = await searchPersonalMemoryResult({}, 1, "x");
    check(s2.ok === false, `A17: searchPersonalMemoryResult returns ok:false on missing DB: ${JSON.stringify(s2)}`);
  }
}

// Phase 2.3: four contracts + NLU branches (A02/A05/A12/A13/A14)
if (DatabaseSync) {
  const MORNING23 = Date.UTC(2026, 9, 28, 5, 0, 0); // 08:30 Tehran
  const fresh23 = () => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
    sq.prepare("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (1, 'عمومی', '[]', 'active', 1, '2026-10-01T00:00:00.000Z')").run();
    const db = { prepare(sql) { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; } };
    return { sq, db };
  };
  const convo23 = (sc, extraEnv = {}) => {
    const sent = []; const chats = [];
    const send = async (t, opts) => { sent.push({ text: t, opts }); };
    const chat = async (t, copts) => { chats.push({ text: t, opts: copts }); };
    const env = { STATE: fakeKV(), DB: sc.db, ...extraEnv };
    const say = async (text, nowMs = MORNING23) => handleDailyText(env, { chatId: 1, userId: 1, text, send, chat, nowMs });
    return { env, sent, chats, say };
  };
  const ai23 = (obj, capture) => ({ run: async (model, body) => { if (capture) capture.body = body; return { response: JSON.stringify(obj) }; } });
  // Contract 1: memory_save
  {
    check(classifyDaily("این را به خاطر بسپار که اسمم سینا است", { nowMs: MORNING23 }).intent === "memory_save", "2.3: classify memory_save for به خاطر بسپار");
    check(classifyDaily("یادت بمونه اسم من مریم است", { nowMs: MORNING23 }).intent === "memory_save", "2.3: classify memory_save for یادت بمونه");
    const sc = fresh23(); const c = convo23(sc);
    const r = await c.say("این را به خاطر بسپار که اسمم سینا است");
    let facts = []; try { facts = sc.sq.prepare("SELECT fact_key, fact_value FROM user_facts WHERE user_id = 1 AND status = 'active'").all(); } catch {}
    check(r === "handled" && c.sent.at(-1)?.text === "🧠 به خاطر سپرده شد", `2.3: memory_save confirms به خاطر سپرده شد: ${JSON.stringify(c.sent.at(-1))}`);
    check(facts.length === 1 && facts[0].fact_key === "name" && facts[0].fact_value === "سینا", `2.3: memory_save stores user_fact name=سینا: ${JSON.stringify(facts)}`);
    check((await getSetting({ DB: sc.db, STATE: c.env.STATE }, 1, "name")) === "سینا", "2.3: memory_save syncs name setting");
    check(sc.sq.prepare("SELECT id FROM notes WHERE user_id = 1").all().length === 0 && sc.sq.prepare("SELECT id FROM tasks WHERE user_id = 1").all().length === 0, "2.3: memory_save creates no note/task");
  }
  // Contract 2: note
  {
    check(classifyDaily("این را یادداشت کن: خرید نان", { nowMs: MORNING23 }).intent === "note", `2.3: classify note for این را یادداشت کن: ${JSON.stringify(classifyDaily("این را یادداشت کن: خرید نان", { nowMs: MORNING23 }))}`);
    const sc = fresh23(); const c = convo23(sc);
    const r = await c.say("این را یادداشت کن: خرید نان");
    const note = sc.sq.prepare("SELECT text FROM notes WHERE user_id = 1").all()[0];
    check(r === "handled" && note?.text === "خرید نان" && String(c.sent.at(-1)?.text ?? "").includes("یادداشت ذخیره شد"), `2.3: note contract saves note خرید نان: ${JSON.stringify(note)}`);
    check(sc.sq.prepare("SELECT id FROM tasks WHERE user_id = 1").all().length === 0, "2.3: note contract creates no task");
  }
  // Contract 3: reminder
  {
    check(classifyDaily("برای فردا ساعت ۹ یادآوری کن جلسه", { nowMs: MORNING23 }).intent === "reminder", "2.3: classify reminder for برای فردا یادآوری کن");
    const sc = fresh23(); const c = convo23(sc);
    const r = await c.say("برای فردا ساعت ۹ یادآوری کن جلسه");
    const task = sc.sq.prepare("SELECT title, remind_at, due_at FROM tasks WHERE user_id = 1").all()[0];
    check(r === "handled" && task && String(task.title ?? "").includes("جلسه") && (task.remind_at === "2026-10-29T09:00:00+03:30" || task.due_at === "2026-10-29T09:00:00+03:30"), `2.3: reminder contract saves task with due/remind tomorrow 09:00: ${JSON.stringify(task)}`);
    check(sc.sq.prepare("SELECT id FROM notes WHERE user_id = 1").all().length === 0, "2.3: reminder contract creates no note");
  }
  // Contract 4: unsupported email
  {
    check(classifyDaily("الان ایمیل بفرست به علی", { nowMs: MORNING23 }).intent === "unsupported_action", "2.3: classify unsupported_action for ایمیل بفرست");
    const sc = fresh23(); const c = convo23(sc);
    const r = await c.say("الان ایمیل بفرست به علی");
    let facts = []; try { facts = sc.sq.prepare("SELECT id FROM user_facts WHERE user_id = 1").all(); } catch {}
    check(r === "handled" && c.sent.at(-1)?.text === "در حال حاضر ابزار اتصال و ارسال مستقیم ایمیل فعال نیست؛ چیزی ارسال نشد. اگر بخواهی می‌توانم متنش را به‌عنوان یادداشت یا کار ذخیره کنم.", `2.3: email honestly states not connected: ${JSON.stringify(c.sent.at(-1))}`);
    check(c.chats.length === 0 && sc.sq.prepare("SELECT id FROM notes WHERE user_id = 1").all().length === 0 && sc.sq.prepare("SELECT id FROM tasks WHERE user_id = 1").all().length === 0 && facts.length === 0, "2.3: email creates no false items and no chat fallback");
  }
  // NLU vault_list (direct, so deterministic vault routing cannot mask it) + rich context
  {
    const sc = fresh23();
    sc.sq.prepare("INSERT INTO tasks (user_id, title, status, source, created_at) VALUES (1, 'خرید نان', 'open', 'text', '2026-10-28T00:00:00.000Z')").run();
    const capture = {}; const sent = [];
    const env = { STATE: fakeKV(), DB: sc.db, VAULT_SECRET: "s1", AI: ai23({ intent: "vault_list", confidence: 0.9 }, capture) };
    const o = { chatId: 1, userId: 1, chatType: "private", text: "کارت‌هام رو نشون بده", replyToText: "کارت‌هام رو نشون بده", send: async (t) => { sent.push(t); }, chat: async () => {}, nowMs: MORNING23 };
    const r = await runNluBranch(env, o, { now: MORNING23, remembered: "TOMAN" });
    const promptText = String(capture.body?.messages?.[0]?.content ?? "");
    check(r === "handled" && sent.some((t) => String(t).includes("گاوصندوق خالی")), `2.3: NLU vault_list executes instead of chat: ${JSON.stringify(sent)}`);
    check(promptText.includes("+03:30") && promptText.includes("خرید نان") && /Message source: text/.test(promptText), "2.3: NLU receives source, +03:30 nowIso and open-task context");
  }
  // NLU income
  {
    const sc = fresh23(); const sent = [];
    const env = { STATE: fakeKV(), DB: sc.db, AI: ai23({ intent: "income", confidence: 0.9 }) };
    const o = { chatId: 1, userId: 1, text: "حقوق گرفتم ۵۰۰ تومان", send: async (t) => { sent.push(t); }, chat: async () => {}, nowMs: MORNING23 };
    const r = await runNluBranch(env, o, { now: MORNING23, remembered: "TOMAN" });
    const drafts = [...env.STATE.store.keys()].filter((k) => k.startsWith("daily:draft:"));
    check(r === "handled" && drafts.length === 1 && sent.some((t) => String(t).includes("💰 درآمد: 500")) && sc.sq.prepare("SELECT id FROM expenses WHERE user_id = 1").all().length === 0, `2.3: NLU income creates confirm draft, no direct insert: ${JSON.stringify(sent)}`);
  }
  // NLU memory_save
  {
    const sc = fresh23(); const sent = [];
    const env = { STATE: fakeKV(), DB: sc.db, AI: ai23({ intent: "memory_save", confidence: 0.92, body: "اسمم پارسا است" }) };
    const o = { chatId: 1, userId: 1, text: "این را به خاطر بسپار که اسمم پارسا است", send: async (t) => { sent.push(t); }, chat: async () => {}, nowMs: MORNING23 };
    const r = await runNluBranch(env, o, { now: MORNING23, remembered: "TOMAN" });
    let facts = []; try { facts = sc.sq.prepare("SELECT fact_value FROM user_facts WHERE user_id = 1 AND status = 'active'").all(); } catch {}
    check(r === "handled" && sent.includes("🧠 به خاطر سپرده شد") && facts[0]?.fact_value === "پارسا", `2.3: NLU memory_save executes: ${JSON.stringify({ sent, facts })}`);
  }
  // NLU unsupported_action
  {
    const sc = fresh23(); const sent = [];
    const env = { STATE: fakeKV(), DB: sc.db, AI: ai23({ intent: "unsupported_action", confidence: 0.9 }) };
    const o = { chatId: 1, userId: 1, text: "الان ایمیل بفرست به علی", send: async (t) => { sent.push(t); }, chat: async () => {}, nowMs: MORNING23 };
    const r = await runNluBranch(env, o, { now: MORNING23, remembered: "TOMAN" });
    check(r === "handled" && sent.includes("در حال حاضر ابزار اتصال و ارسال مستقیم ایمیل فعال نیست؛ چیزی ارسال نشد. اگر بخواهی می‌توانم متنش را به‌عنوان یادداشت یا کار ذخیره کنم."), `2.3: NLU unsupported_action replies honestly: ${JSON.stringify(sent)}`);
  }
}

// ── Live Telegram 5 fixes: AI-first semantic, memory, vault, relative, header ──
if (DatabaseSync) {
  const NOW_LIVE = Date.UTC(2026, 9, 28, 5, 0, 0);
  const freshLive = () => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
    sq.prepare("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (1, 'عمومی', '[]', 'active', 1, '2026-10-01T00:00:00.000Z')").run();
    const db = { prepare(sql) { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; } };
    return { sq, db };
  };
  const convoLive = (sc, extraEnv = {}) => {
    const sent = []; const chats = [];
    const send = async (t, opts) => { sent.push({ text: t, opts }); };
    const chat = async (t, copts) => { chats.push({ text: t, opts: copts }); };
    const env = { STATE: fakeKV(), DB: sc.db, VAULT_SECRET: "s1", ...extraEnv };
    const say = async (text, nowMs = NOW_LIVE) => handleDailyText(env, { chatId: 1, userId: 1, chatType: "private", text, send, chat, nowMs });
    return { env, sent, chats, say };
  };
  {
    const sc = freshLive(); const c = convoLive(sc);
    const r = await c.say("یادت باشه اسم من محمده.", NOW_LIVE);
    const facts = sc.sq.prepare("SELECT fact_key, fact_value FROM user_facts WHERE user_id = 1 AND status = 'active'").all();
    check(r === "handled" && c.sent.some((x) => x.text === "🧠 به خاطر سپرده شد"), `live1: memory reply: ${JSON.stringify(c.sent)}`);
    check(facts.some((f) => f.fact_value === "محمد"), `live1: fact محمد: ${JSON.stringify(facts)}`);
    check((await getSetting(c.env, 1, "name")) === "محمد", "live1: settings.name = محمد");
    check(!c.sent.some((x) => String(x.text).includes("ساعت یادآوری را بگو.")), "live1: no time ask");
  }
  {
    const sc = freshLive(); const c = convoLive(sc);
    const longText = "خب می‌خوام برنامه فاز بعدی رو بررسی کنیم. باید کیف پول و گاوصندوق و API رو تست کنیم و اتصال ایمیل هم لازم است. فردا ساعت ۸ باید این کارها رو بررسی کنیم نه اینکه الان اجرا بشن. شماره کارت و شبا هم در مستندات هست. خیلی خب، این وویس رو برام، این یادداشت رو ثبت کن.";
    const r = await c.say(longText, NOW_LIVE);
    const notes = sc.sq.prepare("SELECT id, text FROM notes WHERE user_id = 1").all();
    const vault = await listVaultItems(c.env, 1);
    const reminders = sc.sq.prepare("SELECT id FROM tasks WHERE user_id = 1 AND remind_at IS NOT NULL").all();
    check(r === "handled" && notes.length === 1, `live2: 1 note: ${JSON.stringify(notes)}`);
    check((vault.items || []).length === 0, `live2: 0 vault: ${JSON.stringify(vault)}`);
    check(reminders.length === 0, `live2: 0 reminders: ${JSON.stringify(reminders)}`);
  }
  {
    const sc = freshLive(); const c = convoLive(sc);
    const r = await c.say("شماره کارت را ذخیره کن", NOW_LIVE);
    const vault = await listVaultItems(c.env, 1);
    check(r === "handled" && c.sent.some((x) => x.text === "برای ثبت در گاوصندوق، عنوان و مقدار را مشخص کن؛ هنوز چیزی ذخیره نشده است."), `live3: guard reply: ${JSON.stringify(c.sent)}`);
    check((vault.items || []).length === 0, "live3: 0 vault");
  }
  {
    const sc = freshLive(); const c = convoLive(sc);
    const r = await c.say("برای ۲ دقیقه دیگه یادآوری کن تست زنده فاز دو", NOW_LIVE);
    const tasks = sc.sq.prepare("SELECT title, remind_at FROM tasks WHERE user_id = 1").all();
    check(r === "handled" && tasks.length === 1 && tasks[0].title === "تست زنده فاز دو", `live4: task title: ${JSON.stringify(tasks)}`);
    const dueMs = tasks[0] && tasks[0].remind_at ? Date.parse(tasks[0].remind_at) : NaN;
    check(dueMs === NOW_LIVE + 120000, `live4: due +120s: ${tasks[0]?.remind_at} ms=${dueMs} want=${NOW_LIVE + 120000}`);
    check(!c.sent.some((x) => String(x.text).includes("ساعت یادآوری را بگو.")), "live4: no time ask");
  }
  {
    const sc = freshLive(); const c = convoLive(sc);
    const r1 = await c.say("یادم بنداز اسمم چی بود؟", NOW_LIVE);
    const r2 = await c.say("یادت باشه اسمم چیه؟", NOW_LIVE);
    const tasks = sc.sq.prepare("SELECT id FROM tasks WHERE user_id = 1").all();
    const name = await getSetting(c.env, 1, "name");
    check(r1 === "chat" && r2 === "chat" && c.chats.length === 0 && tasks.length === 0 && !name && !c.sent.some((x) => String(x.text).includes("ساعت یادآوری را بگو.")), `live5: recall questions route to chat without storage: ${JSON.stringify({ r1, r2, sent: c.sent, tasks, name })}`);
  }
  {
    const sc = freshLive();
    const kv = fakeKV();
    await kv.put("catalog:xkiro", JSON.stringify({ models: [{ id: "qwen3-32b", provider: "xkiro", context: 131072 }] }));
    const env = { STATE: kv, DB: sc.db, TG_TOKEN: "x", ALLOWED_TG_IDS: "1", XKIRO_API_KEY: "k", VAULT_SECRET: "s1" };
    const sent = [];
    const send = async (t, o) => { sent.push({ text: t, opts: o }); };
    const chatNoop = async () => {};
    await handleDailyText(env, { chatId: 1, userId: 1, text: "یادت باشه اسم من محمده.", send, chat: chatNoop, nowMs: NOW_LIVE });
    await handleDailyText(env, { chatId: 1, userId: 1, text: "این را به خاطر بسپار: شهر من تهران است و ماشینم پژو ۲۰۷ است", send, chat: chatNoop, nowMs: NOW_LIVE });
    const captured = [];
    const prev = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.startsWith("https://api.telegram.org/")) return Response.json({ ok: true, result: { message_id: 99 } });
      try { captured.push(JSON.parse(String(init.body ?? "{}"))); } catch {}
      return Response.json({ choices: [{ message: { content: "پاسخ" } }] });
    };
    try {
      await answerChatText(env, 1, 1, "اسم من چیه؟", false, { saveText: "" });
    } finally { globalThis.fetch = prev; }
    const body = captured.find((b) => Array.isArray(b.messages));
    const promptText = String(body?.messages?.[0]?.content ?? "");
    check(promptText.includes("محمد") && promptText.includes("تهران") && promptText.includes("پژو ۲۰۷"), `live5: header injected: ${promptText.slice(0, 500)}`);
    check(!promptText.includes("دسترسی نداری") && !promptText.includes("You have no access") && !promptText.includes("دسترسی ندارم"), `live5: no deny: ${promptText.slice(0, 500)}`);
    check(!CHAT_SYSTEM_PROMPT.includes("دسترسی نداری") && !CHAT_SYSTEM_PROMPT.includes("You have no access"), "live5: CHAT_SYSTEM_PROMPT no deny");
  }
}

// Phase 3.1: multi-provider interpreter fallback — callFn (nvidia) first, env.AI on throw
{
  let callFnTried = false;
  const aiModels = [];
  const env31 = {
    INTERPRETER_MODEL: "nvidia/llama-3.1-nemotron-70b-instruct",
    AI: { run: async (model) => { aiModels.push(model); return { response: JSON.stringify({ intent: "note", confidence: 0.9, body: "fallback ok" }) }; } },
  };
  const callFn = async () => { callFnTried = true; throw new Error("provider boom"); };
  check(resolveInterpreterModel(env31, { callFn }) === "nvidia/llama-3.1-nemotron-70b-instruct", "3.1: resolveInterpreterModel keeps non-@cf model when callFn provided");
  const res = await classifyIntent(env31, "hello", {}, { callFn });
  check(callFnTried === true, "3.1: classifyIntent tried callFn first");
  check(aiModels.length === 1 && aiModels[0] === DEFAULT_INTERPRETER_MODEL, `3.1: fell back to env.AI default model: ${JSON.stringify(aiModels)}`);
  check(res.ok === true && res.intent === "note" && res.body === "fallback ok", `3.1: fallback result returned: ${JSON.stringify(res)}`);
}

// Phase 3.2: media module — parse, generate, handleDailyText wiring
{
  const { parseImageGenCommand, generateFreeImage } = await import("../../src/media.js");
  const p1 = parseImageGenCommand("یه عکس از کوه دماوند در شب بساز");
  check(p1.isImageGen === true && p1.prompt === "کوه دماوند در شب", `3.2: parse Persian image gen: ${JSON.stringify(p1)}`);
  const p2 = parseImageGenCommand("عکس کارت ملی را در گاوصندوق ذخیره کن");
  check(p2.isImageGen === false, `3.2: vault command must not match image gen: ${JSON.stringify(p2)}`);
  let cfCalls = 0;
  const pollFn = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer });
  const r1 = await generateFreeImage({ AI: { run: async () => { cfCalls++; return new Uint8Array([1,2,3]); } } }, "kand", { fetchFn: pollFn });
  check(cfCalls === 0, `3.2: generateFreeImage never calls env.AI.run: cfCalls=${cfCalls}`);
  check(r1.ok === true && r1.provider === "pollinations" && r1.bytes.length === 3, `3.2: generateFreeImage uses Pollinations, never cloudflare: ${JSON.stringify(r1).slice(0, 200)}`);
  const b64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
  let togetherUrl = "";
  let togetherCalled = false;
  const togetherFn = async (url, init = {}) => { togetherCalled = true; togetherUrl = String(url); return { ok: true, json: async () => ({ data: [{ b64_json: b64 }] }) }; };
  const rT = await generateFreeImage({ TOGETHER_API_KEY: "tkey", AI: { run: async () => { throw new Error("should not be called"); } } }, "kand", { fetchFn: togetherFn });
  check(togetherCalled && togetherUrl.includes("api.together.xyz") && rT.ok === true && rT.provider === "together" && rT.bytes.length === 8, `3.2: together provider used: ok=${rT.ok} provider=${rT.provider} url=${togetherUrl}`);
  let puterUrl = "", puterAuth = "", puterBody = null;
  const puterFn = async (url, init = {}) => {
    puterUrl = String(url); puterAuth = init.headers?.Authorization || "";
    puterBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ result: { url: `data:image/png;base64,${b64}` } }) };
  };
  const rP = await generateFreeImage({ PUTER_API_TOKEN: "pkey", AI: { run: async () => { throw new Error("should not be called"); } } }, "kand", { fetchFn: puterFn });
  check(puterUrl.includes("api.puter.com/drivers/call") && puterAuth === "Bearer pkey"
    && puterBody?.interface === "puter-image-generation" && puterBody?.driver === "together" && puterBody?.method === "generate"
    && puterBody?.args?.model === "black-forest-labs/FLUX.1-schnell"
    && rP.ok === true && rP.provider === "puter" && rP.bytes.length === 8,
    `3.2: puter top-tier provider used: ok=${rP.ok} provider=${rP.provider} url=${puterUrl} body=${JSON.stringify(puterBody).slice(0, 160)}`);
  const nvidiaB64 = Buffer.from([5,5,5]).toString("base64");
  let nvidiaUrl = "";
  const nvidiaFn = async (url) => { nvidiaUrl = String(url); return { ok: true, json: async () => ({ artifacts: [{ base64: nvidiaB64 }] }) }; };
  const rN = await generateFreeImage({ NVIDIA_API_KEY: "nkey" }, "kand", { fetchFn: nvidiaFn });
  check(nvidiaUrl.includes("ai.api.nvidia.com") && rN.ok === true && rN.provider === "nvidia" && rN.bytes.length === 3, `3.2: nvidia provider used: ${JSON.stringify(rN).slice(0, 200)} url=${nvidiaUrl}`);
  let geminiUrl = "";
  const geminiFn = async (url) => { geminiUrl = String(url); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: b64 } }] } }] }) }; };
  const rG = await generateFreeImage({ GEMINI_API_KEY: "AIza-test-key" }, "hi", { fetchFn: geminiFn });
  check(geminiUrl.includes("generativelanguage.googleapis.com") && rG.ok === true && rG.provider === "gemini" && rG.bytes.length === 8, `3.2: gemini provider used: ${JSON.stringify(rG).slice(0, 200)} url=${geminiUrl}`);
  const r3 = await generateFreeImage({ AI: { run: async () => { throw new Error("boom"); } } }, "hi", { fetchFn: pollFn });
  check(r3.ok === true && r3.provider === "pollinations" && r3.bytes.length === 3 && r3.provider !== "cloudflare", `3.2: fallback to pollinations (never cloudflare): ${JSON.stringify(r3).slice(0, 200)}`);
}
if (DatabaseSync) {
  const sq32 = new DatabaseSync(":memory:");
  sq32.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sq32.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sq32.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
  sq32.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
  const base32 = (sql) => { const st = sq32.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
  const db32 = { prepare(sql) { return base32(sql); } };
  const rows32 = (sql, params = []) => sq32.prepare(sql).all(...params);
  let cfCalls32 = 0;
  const env32 = { STATE: fakeKV(), DB: db32, AI: { run: async () => { cfCalls32++; return new Uint8Array([137, 80, 78, 71, 13]); } } };
  const sent32 = [];
  const photos32 = [];
  const r32 = await handleDailyText(env32, { chatId: 1, userId: 1, text: "یک تصویر از غروب شیراز بساز", send: async (t) => { sent32.push(t); }, sendPhoto: async (bytes, opts) => { photos32.push({ bytes, opts }); }, chat: async () => {}, fetchFn: async (url) => {
    const u = String(url);
    if (u.includes("pollinations.ai")) return { ok: true, arrayBuffer: async () => new Uint8Array([10,20,30]).buffer };
    return { ok: false, json: async () => ({}) };
  }, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
  check(r32 === "handled", `3.2: handleDailyText image gen handled: ${r32}`);
  check(cfCalls32 === 0, `3.2: handleDailyText never uses Workers AI image generation`);
  check(photos32.length === 1 && sent32.some((t) => String(t).includes("در حال ساخت تصویر")), `3.2: image confirmation sent: photos=${photos32.length} sent=${JSON.stringify(sent32)}`);
  check(rows32("SELECT COUNT(*) AS n FROM notes")[0].n === 0, "3.2: image gen creates no note");
  check(rows32("SELECT COUNT(*) AS n FROM tasks")[0].n === 0, "3.2: image gen creates no task");
}

// Phase 3.3: Unified Connector Setup Hub /setup, upload.am & backup
if (DatabaseSync) {
  const { CONNECTORS, getConnectorStatuses, getConnectorSecret, setConnectorSecret, uploadToUploadAm } = await import("../../src/connectors.js");
  const { exportUserBackupSnapshot } = await import("../../src/db.js");
  const sq33 = new DatabaseSync(":memory:");
  sq33.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sq33.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sq33.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
  sq33.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
  const base33 = (sql) => { const st = sq33.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
  const db33 = { prepare(sql) { return base33(sql); } };
  const rows33 = (sql, params = []) => sq33.prepare(sql).all(...params);
  const env33 = { STATE: fakeKV(), DB: db33, VAULT_MASTER_KEY: "master33", VAULT_SECRET: "s33", TG_TOKEN: "fake", TELEGRAM_BOT_TOKEN: "fake" };
  check(CONNECTORS.length === 9 && CONNECTORS.some((c) => c.id === "gemini" && c.keyName === "GEMINI_API_KEY") && CONNECTORS.some((c) => c.id === "upload_am" && c.optionalKey) && CONNECTORS.some((c) => c.id === "puter" && c.keyName === "PUTER_API_TOKEN"), "3.3: connector registry has 9 connectors including puter");
  sq33.prepare("INSERT INTO notes (user_id, text, source, created_at) VALUES (1, 'note one', 'text', '2026-10-30T00:00:00.000Z')").run();
  sq33.prepare("INSERT INTO tasks (user_id, title, status, source, created_at) VALUES (1, 'task one', 'open', 'text', '2026-10-30T00:00:00.000Z')").run();
  sq33.prepare("INSERT INTO expenses (user_id, type, amount, currency_code, item, date, created_at) VALUES (1, 'expense', 500, 'TOMAN', 'bread', '2026-10-30', '2026-10-30T00:00:00.000Z')").run();
  sq33.prepare("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (1, 'عمومی', '[]', 'active', 1, '2026-10-30T00:00:00.000Z')").run();
  await upsertUserFact(env33, { userId: 1, factKey: "favorite_color", factValue: "blue" });
  // /setup displays statuses
  {
    const sent = [];
    const r = await handleDailyText({ ...env33 }, { chatId: 1, userId: 1, text: "/setup", send: async (t) => { sent.push(String(t)); }, chat: async () => {}, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
    const txt = sent.join("\n");
    check(r === "handled" && txt.includes("وضعیت کانکتورها") && txt.includes("gemini") && txt.includes("together") && txt.includes("⚙️ تنظیم‌نشده") && txt.includes("/setup gemini"), `3.3: /setup displays connector statuses: ${txt.slice(0, 200)}`);
  }
  // /setup together test-key-123 stores, redacts, marks configured
  {
    const sent = [];
    const r = await handleDailyText({ ...env33 }, { chatId: 1, userId: 1, text: "/setup together test-key-123", chatType: "private", send: async (t) => { sent.push(String(t)); }, chat: async () => {}, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
    check(r === "handled" && sent.join(" ").includes("✅ کانکتور **together** با موفقیت تنظیم و فعال شد."), "3.3: /setup together confirms");
    const storedTogether = rows33("SELECT value FROM memories WHERE user_id = 1 AND kind = 'setting' AND key = 'conn_together'")[0]?.value;
    check(typeof storedTogether === "string" && storedTogether.startsWith("v1:") && storedTogether !== "test-key-123", "3.3: connector key stored encrypted in memories settings");
    check(rows33("SELECT COUNT(*) AS n FROM messages WHERE content LIKE '%test-key-123%'")[0].n === 0, "3.3: raw API key redacted from messages");
    check(rows33("SELECT COUNT(*) AS n FROM messages WHERE content LIKE '%کلید کانکتور%'")[0].n >= 1, "3.3: redacted message row exists");
    check((await getConnectorSecret(env33, 1, "together")) === "test-key-123", "3.3: getConnectorSecret reads user key");
    const st = (await getConnectorStatuses({ ...env33 }, { conn_together: "test-key-123" })).find((x) => x.id === "together");
    check(st?.configured === true && st?.masked === "test...23", `3.3: together marked configured with masked preview: ${JSON.stringify(st)}`);
    const sent2 = [];
    await handleDailyText({ ...env33 }, { chatId: 1, userId: 1, text: "تنظیمات کانکتورها", send: async (t) => { sent2.push(String(t)); }, chat: async () => {}, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
    check(sent2.join(" ").includes("✅ متصل") && sent2.join(" ").includes("together"), "3.3: /setup after set shows together متصل");
  }
  // Persian set form + upload mock
  {
    const sent = [];
    const r = await handleDailyText({ ...env33 }, { chatId: 1, userId: 1, text: "تنظیم کانکتور gemini AIzaSyTestKey9f", chatType: "private", send: async (t) => { sent.push(String(t)); }, chat: async () => {}, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
    check(r === "handled" && (await getConnectorSecret(env33, 1, "gemini")) === "AIzaSyTestKey9f", "3.3: Persian تنظیم کانکتور stores gemini key");
    check(rows33("SELECT COUNT(*) AS n FROM messages WHERE content LIKE '%AIzaSyTestKey9f%'")[0].n === 0, "3.3: gemini key redacted from messages");
    const up = await uploadToUploadAm(new TextEncoder().encode("hello"), "a.txt", { apiKey: "k", fetchFn: async () => ({ ok: true, json: async () => ({ url: "https://upload.am/f/abc" }) }) });
    check(up.ok === true && up.url === "https://upload.am/f/abc", `3.3: uploadToUploadAm returns url: ${JSON.stringify(up)}`);
  }
  // Backup exports counts, excludes conn_* secrets, keeps vault encrypted
  {
    const enc = await encryptVaultValue(env33, "vault-plaintext-33");
    const saved = await saveVaultItem(env33, { userId: 1, label: "bank33", valueEnc: enc, kind: "text" });
    check(saved.ok === true, "3.3: vault item saved for backup");
    const docs = [];
    const sent = [];
    const r = await handleDailyText({ ...env33 }, { chatId: 1, userId: 1, text: "بکاپ اطلاعات", send: async (t) => { sent.push(String(t)); }, sendDocument: async (data, opts) => { docs.push({ data, opts }); }, chat: async () => {}, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
    const txt = sent.join("\n");
    check(r === "handled" && docs.length === 1, "3.3: backup sends one document");
    check(txt.includes("یادداشت‌ها: 1") && txt.includes("تسک‌ها: 1") && txt.includes("هزینه‌ها: 1") && txt.includes("حقایق حافظه: 1") && txt.includes("گاوصندوق رمزنگاری‌شده: 1"), `3.3: backup summary counts: ${txt}`);
    const snap = JSON.parse(String(docs[0]?.data ?? "{}"));
    check(snap.counts?.notes === 1 && snap.counts?.tasks === 1 && snap.counts?.expenses === 1 && snap.counts?.user_facts === 1 && snap.counts?.vault_items === 1, `3.3: backup counts accurate: ${JSON.stringify(snap.counts)}`);
    check(!JSON.stringify(snap.settings ?? []).includes("test-key-123") && !JSON.stringify(snap.settings ?? []).includes("conn_together"), "3.3: backup settings exclude conn_* secrets");
    check(snap.vault_items?.[0]?.value_enc === enc && !JSON.stringify(snap).includes("vault-plaintext-33"), "3.3: backup keeps vault items encrypted, never decrypted");
    const direct = await exportUserBackupSnapshot(env33, 1, { nowMs: 0 });
    check(direct.ok === true && direct.counts.notes === 1 && direct.vault_items[0].value_enc === enc, "3.3: exportUserBackupSnapshot direct works");
  }
}

// Phase 3.3b: P0-A connector secret encryption — dual-read, lazy re-encryption, bounded sweep
if (DatabaseSync) {
  const { isConnectorSecretError, sweepConnectorSecrets, resolveConnectorSweepOwner, getConnectorStatuses, getConnectorSecret, setConnectorSecret } = await import("../../src/connectors.js");
  const { editImage, generateFreeImage, analyzeImage } = await import("../../src/media.js");
  const { analyzePdfDocument } = await import("../../src/pdf.js");

  const makeP0Env = (masterKey = "master-p0") => {
    const sq = new DatabaseSync(":memory:");
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
    const base = (sql) => { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
    const db = { prepare(sql) { return base(sql); } };
    const rows = (sql, params = []) => sq.prepare(sql).all(...params);
    const put = (key, value, userId = 1) => sq.prepare("INSERT OR REPLACE INTO memories (user_id, kind, key, value, updated_at) VALUES (?, 'setting', ?, ?, ?)").run(userId, key, value, new Date().toISOString());
    const env = { STATE: fakeKV(), DB: db, VAULT_MASTER_KEY: masterKey, VAULT_SECRET: "s-p0", TG_TOKEN: "fake" };
    return { sq, db, rows, put, env };
  };

  // A: write/read, lazy migration, bare plaintext, wrong key, missing key, status isolation
  {
    const A = makeP0Env();
    const w = await setConnectorSecret(A.env, 1, "gemini", "AIzaRoundTrip");
    check(w.ok === true, "P0-A: setConnectorSecret writes ok");
    const stored = A.rows("SELECT value FROM memories WHERE user_id = 1 AND kind = 'setting' AND key = 'conn_gemini'")[0]?.value;
    check(typeof stored === "string" && stored.startsWith("v1:") && stored !== "AIzaRoundTrip", "P0-A: stored value is v1 ciphertext");
    check((await getConnectorSecret(A.env, 1, "gemini")) === "AIzaRoundTrip", "P0-A: getConnectorSecret decrypts round trip");

    A.put("conn_together", "legacy-plain-key");
    check((await getConnectorSecret(A.env, 1, "together")) === "legacy-plain-key", "P0-A: legacy plaintext read returns plaintext");
    const lazy = A.rows("SELECT value FROM memories WHERE user_id = 1 AND kind = 'setting' AND key = 'conn_together'")[0]?.value;
    check(typeof lazy === "string" && lazy.startsWith("v1:"), "P0-A: legacy plaintext lazily re-encrypted");
    check((await getConnectorSecret(A.env, 1, "together")) === "legacy-plain-key", "P0-A: lazily re-encrypted value still reads");

    A.put("conn_huggingface", "AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBB");
    let bareThrew = null, bareValue = null;
    try { bareValue = await getConnectorSecret(A.env, 1, "huggingface"); } catch (e) { bareThrew = e; }
    check(!bareThrew && bareValue === "AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBB", "P0-A: bare iv:cipher plaintext is not misclassified");

    const wrongEnc = await encryptVaultValue({ VAULT_MASTER_KEY: "other-key" }, "secret");
    A.put("conn_nvidia", wrongEnc);
    let wrongThrew = null;
    try { await getConnectorSecret(A.env, 1, "nvidia"); } catch (e) { wrongThrew = e; }
    check(isConnectorSecretError(wrongThrew) && wrongThrew.reason === "decrypt_failed", "P0-A: wrong-key encrypted row throws decrypt_failed");

    const stP0 = await getConnectorStatuses(A.env, {}, 1);
    const gStatus = stP0.find((x) => x.id === "gemini");
    const nStatus = stP0.find((x) => x.id === "nvidia");
    check(gStatus?.configured === true && gStatus?.masked === "AIza...ip", `P0-A: status masks decrypted plaintext: ${JSON.stringify(gStatus)}`);
    check(nStatus?.configured === false && nStatus?.error === "decrypt_failed" && stP0.find((x) => x.id === "together")?.configured === true, `M2: one corrupt connector does not break status for others: ${JSON.stringify(stP0)}`);

    const envNoMaster = { STATE: fakeKV(), DB: A.db, VAULT_SECRET: "s-p0", TG_TOKEN: "fake" };
    const w2 = await setConnectorSecret(envNoMaster, 1, "puter", "puter-token");
    check(w2.ok === false && w2.error === "vault master key is not configured", "P0-A: missing VAULT_MASTER_KEY fails closed");
    check(A.rows("SELECT COUNT(*) AS n FROM memories WHERE user_id = 1 AND kind = 'setting' AND key = 'conn_puter'")[0].n === 0, "P0-A: missing key writes no plaintext");

    const B = makeP0Env();
    B.put("conn_gemini", await encryptVaultValue({ VAULT_MASTER_KEY: "other-key" }, "secret"));
    let missingKeyThrew = null;
    try { await getConnectorSecret({ DB: B.db }, 1, "gemini"); } catch (e) { missingKeyThrew = e; }
    check(isConnectorSecretError(missingKeyThrew) && missingKeyThrew.reason === "key_missing", "M1: missing keyring is distinguished from corrupt ciphertext");
  }

  // H2: accurate remaining count, no pending:1 undercount
  {
    const C = makeP0Env();
    for (const id of ["gemini", "nvidia", "together", "puter", "huggingface"]) C.put(`conn_${id}`, `${id}-plain`);
    const sw1 = await sweepConnectorSecrets(C.env, { limit: 2, callerId: 1 });
    check(sw1.ok === false && sw1.complete === false && sw1.scanned === 2 && sw1.encrypted === 2 && sw1.remaining === 3 && sw1.pending === 3, `H2: first batch reports exact remaining and not complete: ${JSON.stringify(sw1)}`);
    const sw2 = await sweepConnectorSecrets(C.env, { limit: 2, callerId: 1 });
    check(sw2.remaining === 1 && sw2.pending === 1 && sw2.encrypted === 2 && sw2.ok === false && sw2.complete === false, `H2: second batch reports exact remaining and not complete: ${JSON.stringify(sw2)}`);
    const sw3 = await sweepConnectorSecrets(C.env, { limit: 2, callerId: 1 });
    check(sw3.ok === true && sw3.complete === true && sw3.remaining === 0 && sw3.pending === 0 && sw3.alreadyEncrypted === 4 && sw3.scanned === 1, `H2: completion only after no plaintext remains: ${JSON.stringify(sw3)}`);
    const sw4 = await sweepConnectorSecrets(C.env, { limit: 2, callerId: 1 });
    check(sw4.ok === true && sw4.scanned === 0 && sw4.alreadyEncrypted === 5 && sw4.remaining === 0, `H2: sweep is idempotent: ${JSON.stringify(sw4)}`);
  }

  // H1: K1-encrypted records followed by K2 configuration must not look healthy
  {
    const D = makeP0Env("key-two");
    const k1Enc = await encryptVaultValue({ VAULT_MASTER_KEY: "key-one" }, "gemini-secret");
    D.put("conn_gemini", k1Enc);
    D.put("conn_nvidia", "nvidia-plain");
    const sw = await sweepConnectorSecrets(D.env, { limit: 50, callerId: 1 });
    check(sw.ok === false && sw.decryptFailed === 1 && sw.alreadyEncrypted === 0 && sw.encrypted === 1 && sw.remaining === 0, `H1: wrong-key record is a failure, not already-migrated: ${JSON.stringify(sw)}`);
    check(D.rows("SELECT value FROM memories WHERE kind = 'setting' AND key = 'conn_gemini'")[0]?.value === k1Enc, "H1: undecryptable record is not rewritten");
    const swNoKey = await sweepConnectorSecrets({ DB: D.db }, { limit: 50, callerId: 1 });
    check(swNoKey.ok === false && swNoKey.error === "vault master key is not configured", "H1: missing key never reports ok");
  }

  // M3: invalid rows are reported, never rewritten, and cannot starve valid rows
  {
    const E = makeP0Env();
    E.put("conn_gemini", "");
    E.put("conn_unknown", "do-not-touch");
    E.put("conn_nvidia", "nvidia-plain");
    const sw = await sweepConnectorSecrets(E.env, { limit: 1, callerId: 1 });
    check(sw.scanned === 1 && sw.encrypted === 1 && sw.invalid === 2 && sw.invalidEmpty === 1 && sw.invalidUnknown === 1 && sw.remaining === 0 && sw.ok === true && sw.complete === false, `M3: invalid rows counted, valid row processed: ${JSON.stringify(sw)}`);
    check(E.rows("SELECT value FROM memories WHERE kind = 'setting' AND key = 'conn_unknown'")[0]?.value === "do-not-touch", "M3: unknown connector row is never rewritten");
    check(E.rows("SELECT value FROM memories WHERE kind = 'setting' AND key = 'conn_gemini'")[0]?.value === "", "M3: empty connector row is never rewritten");
    const sw2 = await sweepConnectorSecrets(E.env, { limit: 1, callerId: 1 });
    check(sw2.ok === true && sw2.encrypted === 0 && sw2.invalid === 2 && sw2.complete === false, `M3: repeated sweep stays deterministic: ${JSON.stringify(sw2)}`);
  }

  // M4: zero-row conditional UPDATE may be a concurrent success
  {
    const F = makeP0Env();
    F.put("conn_gemini", "concurrent-plain");
    const encConcurrent = await encryptVaultValue({ VAULT_MASTER_KEY: "master-p0" }, "concurrent-plain");
    let intercepted = 0;
    const fakeDb = {
      prepare(sql) {
        if (/^\s*UPDATE memories SET value =/.test(sql)) {
          return { bind(...params) { return { run: async () => {
            intercepted++;
            F.sq.prepare("UPDATE memories SET value = ? WHERE user_id = 1 AND kind = 'setting' AND key = 'conn_gemini'").run(encConcurrent);
            const r = F.sq.prepare(sql).run(...params);
            return { success: true, meta: { changes: r.changes } };
          }, all: async () => ({ results: [] }), first: async () => null }; } };
        }
        return F.db.prepare(sql);
      },
    };
    const sw = await sweepConnectorSecrets({ ...F.env, DB: fakeDb }, { limit: 10, callerId: 1 });
    check(intercepted === 1 && sw.encrypted === 1 && sw.concurrent === 1 && sw.failed === 0 && sw.ok === true, `M4: zero-row update verified as concurrent success: ${JSON.stringify(sw)}`);
    check(F.rows("SELECT value FROM memories WHERE kind = 'setting' AND key = 'conn_gemini'")[0]?.value === encConcurrent, "M4: concurrent ciphertext is not overwritten");

    const F2 = makeP0Env();
    F2.put("conn_gemini", "original-plain");
    const changedDb = {
      prepare(sql) {
        if (/^\s*UPDATE memories SET value =/.test(sql)) {
          return { bind(...params) { return { run: async () => {
            F2.sq.prepare("UPDATE memories SET value = ? WHERE user_id = 1 AND kind = 'setting' AND key = 'conn_gemini'").run("changed-plain");
            const r = F2.sq.prepare(sql).run(...params);
            return { success: true, meta: { changes: r.changes } };
          }, all: async () => ({ results: [] }), first: async () => null }; } };
        }
        return F2.db.prepare(sql);
      },
    };
    const swChanged = await sweepConnectorSecrets({ ...F2.env, DB: changedDb }, { limit: 10, callerId: 1 });
    check(swChanged.changed === 1 && swChanged.ok === false && swChanged.remaining === 1, `M4: concurrent value change is not reported as success: ${JSON.stringify(swChanged)}`);
    check(F2.rows("SELECT value FROM memories WHERE kind = 'setting' AND key = 'conn_gemini'")[0]?.value === "changed-plain", "M4: concurrent plaintext change is not overwritten");

    const G = makeP0Env();
    G.put("conn_together", "lazy-plain");
    const encLazy = await encryptVaultValue({ VAULT_MASTER_KEY: "master-p0" }, "lazy-plain");
    let lazyIntercepted = 0;
    const lazyDb = {
      prepare(sql) {
        if (/^\s*UPDATE memories SET value =/.test(sql)) {
          return { bind(...params) { return { run: async () => {
            lazyIntercepted++;
            G.sq.prepare("UPDATE memories SET value = ? WHERE user_id = 1 AND kind = 'setting' AND key = 'conn_together'").run(encLazy);
            const r = G.sq.prepare(sql).run(...params);
            return { success: true, meta: { changes: r.changes } };
          }, all: async () => ({ results: [] }), first: async () => null }; } };
        }
        return G.db.prepare(sql);
      },
    };
    const lazyValue = await getConnectorSecret({ ...G.env, DB: lazyDb }, 1, "together");
    check(lazyIntercepted === 1 && lazyValue === "lazy-plain" && G.rows("SELECT value FROM memories WHERE kind = 'setting' AND key = 'conn_together'")[0]?.value === encLazy, "M4: lazy re-encryption treats zero-row update as concurrent success");
  }

  // M5: canonical owner scope and authorization
  {
    const H = makeP0Env();
    H.put("conn_gemini", "owner-secret", 1);
    H.put("conn_gemini", "other-secret", 2);
    const owner = await resolveConnectorSweepOwner(H.env);
    check(owner.ok === true && owner.userId === 1 && owner.telegramId === "1", `M5: canonical owner resolved from users row: ${JSON.stringify(owner)}`);
    const denied = await sweepConnectorSecrets(H.env, { limit: 10, callerId: 2 });
    check(denied.ok === false && denied.error === "owner authorization required", `M5: non-owner is rejected: ${JSON.stringify(denied)}`);
    const missingCaller = await sweepConnectorSecrets(H.env, { limit: 10 });
    check(missingCaller.ok === false && missingCaller.error === "owner authorization required", "M5: sweep requires caller identity");
    const own = await sweepConnectorSecrets(H.env, { limit: 10, callerId: 1 });
    check(own.ok === true && own.encrypted === 1, `M5: owner sweep runs: ${JSON.stringify(own)}`);
    check(H.rows("SELECT value FROM memories WHERE user_id = 2 AND kind = 'setting' AND key = 'conn_gemini'")[0]?.value === "other-secret", "M5: other users' records are never modified");

    const I = makeP0Env();
    I.sq.exec("INSERT INTO users (id, telegram_id) VALUES (2, '2')");
    const ambiguous = await sweepConnectorSecrets(I.env, { limit: 10, callerId: 1 });
    check(ambiguous.ok === false && ambiguous.error === "owner identity is ambiguous", `M5: ambiguous owner fails closed: ${JSON.stringify(ambiguous)}`);
  }

  // M6: connector credential setup is private-chat-only for every alias
  {
    const J = makeP0Env();
    const group1 = [];
    const r1 = await handleDailyText(J.env, { chatId: -1, userId: 1, text: "/setup gemini GROUP_SECRET_1", chatType: "group", send: async (t) => { group1.push(String(t)); }, chat: async () => {}, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
    check(r1 === "handled" && group1.join(" ").includes("چت خصوصی"), "M6: /setup credential rejected in group chat");
    const group2 = [];
    const r2 = await handleDailyText(J.env, { chatId: -1, userId: 1, text: "تنظیم کانکتور gemini GROUP_SECRET_2", chatType: "group", send: async (t) => { group2.push(String(t)); }, chat: async () => {}, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
    check(r2 === "handled" && group2.join(" ").includes("چت خصوصی"), "M6: Persian setup alias rejected in group chat");
    check(J.rows("SELECT COUNT(*) AS n FROM memories WHERE kind = 'setting' AND key = 'conn_gemini'")[0].n === 0, "M6: group credentials are never stored");
    check(J.rows("SELECT COUNT(*) AS n FROM messages WHERE content LIKE '%GROUP_SECRET%'")[0].n === 0, "M6: group credentials are never persisted in messages");
    const priv = [];
    const r3 = await handleDailyText(J.env, { chatId: 1, userId: 1, text: "/setup gemini PRIVATE_SECRET_1", chatType: "private", send: async (t) => { priv.push(String(t)); }, chat: async () => {}, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
    check(r3 === "handled" && (await getConnectorSecret(J.env, 1, "gemini")) === "PRIVATE_SECRET_1", "M6: private setup still works");
  }

  // M1: DB failure vs absent vs plaintext vs decrypted vs corrupt
  {
    const K = makeP0Env();
    K.put("conn_gemini", await encryptVaultValue({ VAULT_MASTER_KEY: "other-key" }, "x"));
    let dbFail = null;
    try { await getConnectorSecret({ DB: { prepare() { throw new Error("db down"); } }, GEMINI_API_KEY: "env-key" }, 1, "gemini"); } catch (e) { dbFail = e; }
    check(isConnectorSecretError(dbFail) && dbFail.reason === "db_read_failed", "M1: DB read failure does not fall back to env");
    const absent = await getConnectorSecret({ ...K.env, NVIDIA_API_KEY: "env-key" }, 1, "nvidia");
    check(absent === "env-key", "M1: absent connector may use safe env fallback");
    check((await getConnectorSecret({ DB: K.db, NVIDIA_API_KEY: "env-key" }, 1, "nvidia")) === "env-key", "M1: absent secret falls back to env when DB is readable");
    check((await getConnectorSecret({ GEMINI_API_KEY: "env-key" }, 1, "gemini")) === "env-key", "M1: no DB binding keeps env fallback");
  }

  // M2: a corrupt secret for one provider does not disable unrelated providers
  {
    const L = makeP0Env();
    L.put("conn_gemini", await encryptVaultValue({ VAULT_MASTER_KEY: "other-key" }, "gemini-real"));
    const envL = { ...L.env, NVIDIA_API_KEY: "nvidia-key", HF_TOKEN: "hf-key" };

    const gen = await generateFreeImage(envL, "test", { userId: 1, fetchFn: async (url) => {
      const u = String(url);
      if (u.includes("ai.api.nvidia.com") && u.includes("/genai/")) return { ok: true, json: async () => ({ artifacts: [{ base64: "AAAA" }] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    } });
    check(gen.ok === true && gen.provider === "nvidia", `M2: corrupt gemini does not abort nvidia image generation: ${JSON.stringify(gen).slice(0, 200)}`);

    const an = await analyzeImage(envL, { imageBytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg", prompt: "تحلیل", userId: 1, fetchFn: async (url) => {
      const u = String(url);
      if (u.includes("integrate.api.nvidia.com")) return { ok: true, json: async () => ({ choices: [{ message: { content: "سلام دنیا" } }] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    } });
    check(an.ok === true && an.text.includes("سلام"), `M2: corrupt gemini does not abort nvidia vision: ${JSON.stringify(an).slice(0, 200)}`);

    const ed = await editImage(envL, { imageBytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg", instruction: "edit", userId: 1, fetchFn: async (url) => {
      if (String(url).includes("router.huggingface.co")) return { ok: true, arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer };
      return { ok: false, status: 404, json: async () => ({}) };
    } });
    check(ed.ok === true && ed.provider === "huggingface-edit", `M2: corrupt gemini does not abort HF image edit: ${JSON.stringify(ed).slice(0, 200)}`);

    const envOnlyBad = { ...makeP0Env().env };
    envOnlyBad.DB = L.db;
    const genOnly = await generateFreeImage(envOnlyBad, "test", { userId: 1, fetchFn: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
    check(genOnly.ok === false && Array.isArray(genOnly.diagErrors) && genOnly.diagErrors.some((d) => String(d).startsWith("gemini:connector_secret_unavailable")), `M2: affected provider failure is reported, not silently skipped: ${JSON.stringify(genOnly).slice(0, 250)}`);

    const envBadNoHf = { ...L.env, NVIDIA_API_KEY: "" };
    const edOnly = await editImage(envBadNoHf, { imageBytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg", instruction: "edit", userId: 1, fetchFn: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
    check(edOnly.ok === false && edOnly.error === "connector_secret_unavailable", `M2: edit fails closed when only credential is corrupt: ${JSON.stringify(edOnly).slice(0, 200)}`);

    let pdfThrew = null;
    try { await analyzePdfDocument(envL, { pdfBytes: new Uint8Array([1, 2, 3]), prompt: "خلاصه کن", userId: 1, fetchFn: async () => ({ ok: false, status: 404, json: async () => ({}) }) }); } catch (e) { pdfThrew = e; }
    check(isConnectorSecretError(pdfThrew), "M2: pdf fails closed for its required connector secret");
  }

  // Sweep command: owner private-only, counts only, no secrets
  {
    const M = makeP0Env();
    M.put("conn_gemini", "sweep-command-plain");
    const sentSweep = [];
    const rSweep = await handleDailyText(M.env, { chatId: 1, userId: 1, text: "رمزنگاری مجدد کانکتورها", chatType: "private", send: async (t) => { sentSweep.push(String(t)); }, chat: async () => {}, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
    const sweepText = sentSweep.join(" ");
    check(rSweep === "handled" && sweepText.includes("مهاجرت کلیدها") && !sweepText.includes("sweep-command-plain"), "P0-A: owner private sweep runs and reports counts only");
    const sentDenied = [];
    const rDenied = await handleDailyText(M.env, { chatId: 1, userId: 1, text: "رمزنگاری مجدد کانکتورها", chatType: "group", send: async (t) => { sentDenied.push(String(t)); }, chat: async () => {}, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
    check(rDenied === "handled" && sentDenied.join(" ").includes("فقط برای مالک"), "P0-A: sweep command denied outside private chat");
    const sentNonOwner = [];
    const rNonOwner = await handleDailyText(M.env, { chatId: 2, userId: 2, text: "/setup sweep", chatType: "private", send: async (t) => { sentNonOwner.push(String(t)); }, chat: async () => {}, nowMs: Date.UTC(2026, 9, 28, 12, 0, 0) });
    check(rNonOwner === "handled" && sentNonOwner.join(" ").includes("مالک") === false && !sentNonOwner.join(" ").includes("✅"), "P0-A: non-owner private sweep does not run");
  }
}

// Phase 3.4: Remove Cloudflare env.AI, multi-provider gen + edit + vision
{
  const { generateFreeImage: genImg, analyzeImage, editImage, isVisionQuestionCaption, isImageEditCaption } = await import("../../src/media.js");
  const { handleIncomingFile, handleVaultFile: hvf34 } = await import("../../src/everyday.js");
  let cf34 = 0;
  const poll34 = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1,2,3]).buffer });
  const g0 = await genImg({ AI: { run: async () => { cf34++; return new Uint8Array([9]); } } }, "test", { fetchFn: poll34 });
  check(cf34 === 0 && g0.ok === true && g0.provider === "pollinations" && g0.provider !== "cloudflare", `3.4: generateFreeImage never returns cloudflare: cf=${cf34} provider=${g0.provider}`);
  const b64edited = Buffer.from([10,20,30]).toString("base64");
  const geminiEditFn = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("gemini-2.0-flash-preview-image-generation")) {
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: b64edited } }] } }] }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  const edited = await editImage({ GEMINI_API_KEY: "gkey" }, { imageBytes: new Uint8Array([1,2,3]), mimeType: "image/jpeg", instruction: "این عکس رو کارتونی کن", fetchFn: geminiEditFn });
  check(edited.ok === true && edited.provider === "gemini-edit" && edited.bytes.length === 3, `3.4: editImage gemini-edit returns edited bytes: ${JSON.stringify(edited).slice(0,200)}`);
  const noKeyEdit = await editImage({ STATE: fakeKV() }, { imageBytes: new Uint8Array([1,2,3]), mimeType: "image/jpeg", instruction: "ویرایش: نور بهتر کن", fetchFn: poll34 });
  check(noKeyEdit.ok === false && String(noKeyEdit.reason).includes("GEMINI_API_KEY") && String(noKeyEdit.reason).includes("/setup"), `3.4: editImage no-key Persian reason: ${JSON.stringify(noKeyEdit)}`);
  const geminiVisionFn = async (url) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "این عکس یک فاکتور برق است و مبلغ آن ۱۲۳۴۵ تومان است." }] } }] }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  const ana = await analyzeImage({ GEMINI_API_KEY: "gkey" }, { imageBytes: new Uint8Array([1,2,3]), mimeType: "image/jpeg", prompt: "این عکس رو تحلیل کن", fetchFn: geminiVisionFn });
  check(ana.ok === true && String(ana.text).includes("فاکتور"), `3.4: analyzeImage gemini Persian analysis: ${JSON.stringify(ana)}`);
  let routerSeen = null;
  const anaRouter = await analyzeImage({ STATE: fakeKV() }, { imageBytes: new Uint8Array([1,2,3]), mimeType: "image/jpeg", prompt: "متن داخل عکس رو بخون", fetchFn: poll34, routerCallFn: async (body) => { routerSeen = body; return { text: "متن داخل عکس: سلام" }; } });
  check(anaRouter.ok === true && String(anaRouter.text).includes("سلام") && routerSeen && String(routerSeen.messages?.[0]?.content?.[0]?.image_url?.url || "").startsWith("data:image/jpeg;base64,"), `3.4: analyzeImage router fallback with data URI: ok=${anaRouter.ok} seen=${JSON.stringify(routerSeen).slice(0,200)}`);
  check(isVisionQuestionCaption("این عکس رو تحلیل کن و بگو چیه؟") === true, "3.4: isVisionQuestionCaption detects تحلیل + چیه؟");
  check(isImageEditCaption("ویرایش: پس‌زمینه عکس رو حذف کن") === true, "3.4: isImageEditCaption detects ویرایش:");
  if (DatabaseSync) {
    const sq34 = new DatabaseSync(":memory:");
    sq34.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq34.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq34.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq34.exec("INSERT INTO users (id, telegram_id) VALUES (4242, '4242')");
    const base34 = (sql) => { const st = sq34.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
    const db34 = { prepare(sql) { return base34(sql); } };
    const origFetch34 = global.fetch;
    global.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.startsWith("https://api.telegram.org/")) {
        const m = /\/bot[^/]+\/(\w+)$/.exec(u);
        const method = m ? m[1] : "";
        if (method === "getFile") return Response.json({ ok: true, result: { file_path: "photos/f34.jpg" } });
        return Response.json({ ok: true, result: { message_id: 1 } });
      }
      if (u.includes("/file/bot")) return new Response(new ArrayBuffer(8), { headers: { "content-type": "image/jpeg" } });
      if (u.includes("generativelanguage.googleapis.com")) {
        return Response.json({ candidates: [{ content: { parts: [{ text: "این عکس یک فاکتور است." }] } }] });
      }
      return Response.json({ ok: true });
    };
    try {
      const env34 = { STATE: fakeKV(), DB: db34, TG_TOKEN: "fake-token", VAULT_SECRET: "s34", GEMINI_API_KEY: "gkey34" };
      const sent34 = [];
      const send34 = async (text) => { sent34.push(String(text)); };
      const geminiFetch34 = async (url) => {
        if (String(url).includes("generativelanguage.googleapis.com")) return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "این عکس یک فاکتور برق است." }] } }] }) };
        return { ok: true, json: async () => ({}) };
      };
      const handled34 = await handleIncomingFile(env34, { userId: 4242, chatId: 4242, tgFileId: "photo-34", fileType: "photo", kind: "photo", mimeType: "image/jpeg", fileName: null, caption: "این عکس رو تحلیل کن و بگو چیه؟", send: send34, fetchFn: geminiFetch34, routerCallFn: null });
      check(handled34 === true, "3.4: handleIncomingFile vision photo handled");
      check(sent34.some((t) => String(t).includes("فاکتور برق")), `3.4: vision caption triggers Persian interpretation: ${JSON.stringify(sent34)}`);
      check((await (async () => { try { const r = await listVaultFiles(env34, 4242); return r?.files?.length ?? -1; } catch { return -1; } })()) === 0, "3.4: vision photo not blindly vault-archived");
      const sentVault = [];
      const handledVault = await handleVaultFile(env34, { userId: 4242, chatId: 4242, tgFileId: "file-34v", fileType: "document", mimeType: "application/pdf", fileName: "scan.pdf", caption: "در گاوصندوق ذخیره کن", send: async (t) => { sentVault.push(String(t)); } });
      check(handledVault === true && sentVault.some((t) => t.includes("آرشیو امن")), `3.4: explicit vault caption still archives: ${JSON.stringify(sentVault)}`);
    } finally {
      global.fetch = origFetch34;
    }
  }
}

// Phase 3.5: Bidirectional PDF engine — isPdfAnalysisRequest, analyze, image->pdf, text->pdf
{
  const { isPdfAnalysisRequest, analyzePdfDocument, buildImageToPdfBytes, buildTextPdfOrHtmlReport, parsePdfCreateCommand } = await import("../../src/pdf.js");
  const { handleIncomingFile: hif35, handleVaultFile: hvf35, handleDailyText: hdt35 } = await import("../../src/everyday.js");
  const fakeJpeg35 = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
  const imgPdf35 = buildImageToPdfBytes(fakeJpeg35);
  const imgPdfStr35 = Buffer.from(imgPdf35).toString("latin1");
  check(imgPdfStr35.startsWith("%PDF-1.4") && imgPdfStr35.includes("%%EOF"), `3.5: buildImageToPdfBytes valid %PDF-1.4 binary: head=${imgPdfStr35.slice(0, 20)}`);
  check(isPdfAnalysisRequest("این پی‌دی‌اف رو خلاصه کن", "application/pdf", "scan.pdf") === true, "3.5: isPdfAnalysisRequest detects خلاصه");
  check(isPdfAnalysisRequest("این پی‌دی‌اف درباره چیه", "application/pdf", "scan.pdf") === true && isPdfAnalysisRequest("متن این فایل رو دربیار", null, "doc.pdf") === true, "3.5: isPdfAnalysisRequest detects درباره/دربیار");
  check(isPdfAnalysisRequest("در گاوصندوق ذخیره کن", "application/pdf", "scan.pdf") === false && isPdfAnalysisRequest("سلام", "application/pdf", "scan.pdf") === false, "3.5: vault/plain caption is not analysis");
  check(isPdfAnalysisRequest("خلاصه کن", "image/jpeg", "a.jpg") === false, "3.5: non-PDF is not analysis");
  const rep35 = buildTextPdfOrHtmlReport("یادداشت", "سلام دنیا");
  const repStr35 = Buffer.from(rep35.pdfBytes).toString("latin1");
  check(repStr35.startsWith("%PDF-1.4") && repStr35.includes("%%EOF") && rep35.html.includes('dir="rtl"') && rep35.html.includes('lang="fa"') && rep35.html.includes("@media print"), `3.5: buildTextPdfOrHtmlReport pdf+rtl html: html=${String(rep35.html).slice(0,120)}`);
  check(parsePdfCreateCommand("این متن رو PDF کن: سلام").isPdfCreate === true && parsePdfCreateCommand("تبدیل به PDF: سلام").isPdfCreate === true && parsePdfCreateCommand("/pdf سلام").text === "سلام" && parsePdfCreateCommand("سلام").isPdfCreate === false, "3.5: parsePdfCreateCommand matches 3 forms");
  const fakePdf35 = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nstream\nBT /F1 12 Tf (Hello World) Tj ET\nendstream\n%%EOF");
  const ana35 = await analyzePdfDocument({ STATE: fakeKV() }, { pdfBytes: fakePdf35, prompt: "این پی‌دی‌اف درباره چیه؟", userId: 1, fetchFn: async () => ({ ok: false, json: async () => ({}) }), chatFn: async (t) => { check(String(t).includes("Hello World"), "3.5: extractor passes Hello World to chatFn"); return "خلاصه فارسی: سلام دنیا"; } });
  check(ana35.ok === true && String(ana35.text).includes("خلاصه فارسی"), `3.5: analyzePdfDocument extractor fallback: ${JSON.stringify(ana35).slice(0,200)}`);
  if (DatabaseSync) {
    const sq35 = new DatabaseSync(":memory:");
    sq35.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq35.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq35.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
    sq35.exec("INSERT INTO users (id, telegram_id) VALUES (4242, '4242')");
    const base35 = (sql) => { const st = sq35.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
    const db35 = { prepare(sql) { return base35(sql); } };
    const origFetch35 = global.fetch;
    const fakePdfBuf35 = new TextEncoder().encode("%PDF-1.4\nBT (Hello World) Tj ET\n%%EOF");
    global.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith("https://api.telegram.org/")) {
        const m = /\/bot[^/]+\/(\w+)$/.exec(u);
        const method = m ? m[1] : "";
        if (method === "getFile") return Response.json({ ok: true, result: { file_path: "doc/s35.pdf" } });
        return Response.json({ ok: true, result: { message_id: 1 } });
      }
      if (u.includes("/file/bot")) return new Response(fakePdfBuf35.slice().buffer, { headers: { "content-type": "application/pdf" } });
      return Response.json({ ok: true });
    };
    try {
      const env35 = { STATE: fakeKV(), DB: db35, TG_TOKEN: "fake-token", VAULT_SECRET: "s35", GEMINI_API_KEY: "gkey35" };
      const geminiFn35 = async (url) => {
        if (String(url).includes("generativelanguage.googleapis.com")) return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "خلاصه فارسی PDF: این کتاب درباره زندگی است." }] } }] }) };
        return { ok: true, json: async () => ({}) };
      };
      const sent35 = [];
      const handled35 = await hif35(env35, { userId: 4242, chatId: 4242, tgFileId: "pdf-35", fileType: "document", mimeType: "application/pdf", fileName: "scan.pdf", caption: "این پی‌دی‌اف رو خلاصه کن", send: async (t) => { sent35.push(String(t)); }, fetchFn: geminiFn35, chat: async () => { return "fallback"; }, routerCallFn: null });
      check(handled35 === true && sent35.some((t) => String(t).includes("خلاصه فارسی")), `3.5: PDF summary caption invokes analyzePdfDocument: ${JSON.stringify(sent35)}`);
      check((await (async () => { try { const r = await listVaultFiles(env35, 4242); return r?.files?.length ?? -1; } catch { return -1; } })()) === 0, "3.5: analysis PDF not blindly vault-archived");
      const sentV35 = [];
      const handledV35 = await hvf35(env35, { userId: 4242, chatId: 4242, tgFileId: "pdf-35v", fileType: "document", mimeType: "application/pdf", fileName: "scan.pdf", caption: "در گاوصندوق ذخیره کن", send: async (t) => { sentV35.push(String(t)); } });
      check(handledV35 === true && sentV35.some((t) => String(t).includes("آرشیو امن")), `3.5: PDF without analysis caption still archives: ${JSON.stringify(sentV35)}`);
      const docs35 = [];
      const sentP35 = [];
      await hif35(env35, { userId: 4242, chatId: 4242, tgFileId: "photo-35", fileType: "photo", kind: "photo", mimeType: "image/jpeg", fileName: null, caption: "تبدیل به PDF", send: async (t) => { sentP35.push(String(t)); }, sendDocument: async (data, opts) => { docs35.push({ data, opts }); } });
      check(docs35.length === 1 && Buffer.from(docs35[0].data).toString("latin1").startsWith("%PDF-1.4") && Buffer.from(docs35[0].data).toString("latin1").includes("%%EOF"), "3.5: photo -> pdf via sendDocument");
      const docsD35 = [];
      const msgsD35 = [];
      const rD35 = await hdt35(env35, { userId: 4242, chatId: 4242, text: "این متن رو PDF کن: سلام دنیا", send: async (t) => { msgsD35.push(String(t)); }, sendDocument: async (data, opts) => { docsD35.push({ data, opts }); }, chat: async () => {} });
      check(rD35 === "handled" && docsD35.length === 1 && Buffer.from(docsD35[0].data).toString("latin1").includes("%PDF-1.4"), `3.5: handleDailyText pdf create via sendDocument: r=${rD35} docs=${docsD35.length}`);
    } finally {
      global.fetch = origFetch35;
    }
  }
}

// Real Telegram wiring: slash passthrough + photo->PDF + PDF summary + vision.
if (DatabaseSync) {
  const sqliteW = new DatabaseSync(":memory:");
  sqliteW.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqliteW.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqliteW.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
  sqliteW.exec("INSERT INTO users (id, telegram_id) VALUES (4242, '4242')");
  const baseW = (sql) => { const st = sqliteW.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
  const dbW = { prepare(sql) { return baseW(sql); } };
  const photoBytesW = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
  const pdfBytesW = new TextEncoder().encode("%PDF-1.4\nBT (Hello World) Tj ET\n%%EOF");
  const sendsW = [];
  const geminiReplyW = "تحلیل فارسی: این تصویر یک خودروی آینده‌نگر است.";
  const origFetchW = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const m = /\/bot[^/]+\/(\w+)$/.exec(u);
    if (m) {
      const method = m[1];
      let payload = {};
      let doc = null;
      if (init.body instanceof FormData) {
        const blob = init.body.get("document");
        if (blob && typeof blob.arrayBuffer === "function") doc = Buffer.from(await blob.arrayBuffer());
        payload = { caption: init.body.get("caption") };
      } else {
        try { payload = JSON.parse(String(init.body ?? "{}")); } catch {}
      }
      sendsW.push({ method, payload, doc });
      if (method === "getFile") return Response.json({ ok: true, result: { file_path: "doc/test" } });
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    if (u.includes("/file/bot")) return new Response(pdfBytesW.slice().buffer, { headers: { "content-type": "application/pdf" } });
    if (u.includes("generativelanguage.googleapis.com")) {
      return Response.json({ candidates: [{ content: { parts: [{ text: geminiReplyW }] } }] });
    }
    return Response.json({ ok: true });
  };
  const sendUpdateW = async (env, message) => {
    resetSeenUpdateIdsForTests();
    await handleUpdate(env, {
      update_id: 880000 + sendsW.length,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        from: { id: 4242, is_bot: false, first_name: "T" },
        chat: { id: 4242, type: "private" },
        ...message,
      },
    });
  };
  const allTextsW = () => sendsW.map((s) => String(s.payload?.text ?? ""));
  try {
    const envW = { STATE: fakeKV(), DB: dbW, TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242", GEMINI_API_KEY: "gkey-w" };
    await sendUpdateW(envW, { text: "/setup" });
    check(!allTextsW().some((t) => t.includes("دستور ناشناس")), "/setup must not be swallowed as an unknown slash command");
    check(sendsW.some((s) => s.method === "sendMessage" && String(s.payload?.text ?? "").includes("وضعیت کانکتور")), "/setup reaches handleDailyText through the real slash handler");

    const beforePdf = sendsW.length;
    await sendUpdateW(envW, { photo: [{ file_id: "photo-w", file_unique_id: "u-w", width: 100, height: 100 }], caption: "اینو به pdf تبدیل کن برام" });
    const docW = sendsW.slice(beforePdf).find((s) => s.method === "sendDocument" && s.doc);
    check(Boolean(docW) && docW.doc.toString("latin1").startsWith("%PDF-1.4"), "/photo with a PDF caption is converted and sent as %PDF-1.4 without the vault prompt");
    check(!allTextsW().some((t) => t.includes("تصویر/فایل دریافت شد") || t.includes("تحلیل ممکن نشد")), "photo->PDF never falls through to the generic file reply");

    const beforeSummary = sendsW.length;
    await sendUpdateW(envW, { document: { file_id: "pdf-w", file_name: "140425100040212725.pdf", mime_type: "application/pdf" }, caption: "این فایل رو ببین و خلاصه کن برام" });
    check(sendsW.slice(beforeSummary).some((s) => s.method === "sendMessage" && String(s.payload?.text ?? "").includes(geminiReplyW)), "PDF summary caption downloads the document and returns the summary");

    const envVisionW = { STATE: fakeKV(), DB: dbW, TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242", GOOGLE_API_KEY: "gkey-w2" };
    const beforeVision = sendsW.length;
    await sendUpdateW(envVisionW, { photo: [{ file_id: "photo-v", file_unique_id: "u-v", width: 100, height: 100 }], caption: "اون ها چیه روی لباسش" });
    check(sendsW.slice(beforeVision).some((s) => s.method === "sendMessage" && String(s.payload?.text ?? "").includes(geminiReplyW)), "vision caption reuses env.GOOGLE_API_KEY (same Gemini key as voice) and returns the analysis");
  } finally {
    global.fetch = origFetchW;
  }
}

// Regression: PDF single reply + FlateDecode, NVIDIA vision, image-gen progress/sendPhoto.
if (DatabaseSync) {
  const { extractTextFromPdfBytes } = await import("../../src/pdf.js");
  const { analyzeImage } = await import("../../src/media.js");
  const { handleIncomingFile, handleDailyText } = await import("../../src/everyday.js");

  const deflateText = async (text) => {
    const stream = new Response(new TextEncoder().encode(text)).body.pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  const flateBody = await deflateText("BT (Flate Secret Text) Tj ET");
  const fHead = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Length " + flateBody.length + " /Filter /FlateDecode >>\nstream\n");
  const fTail = new TextEncoder().encode("\nendstream\nendobj\n%%EOF");
  const flatePdf = new Uint8Array(fHead.length + flateBody.length + fTail.length);
  flatePdf.set(fHead, 0); flatePdf.set(flateBody, fHead.length); flatePdf.set(fTail, fHead.length + flateBody.length);
  const flateText = await extractTextFromPdfBytes(flatePdf);
  check(String(flateText).includes("Flate Secret Text"), `fix1: extractTextFromPdfBytes inflates FlateDecode stream: ${JSON.stringify(flateText).slice(0, 120)}`);

  const sqR = new DatabaseSync(":memory:");
  sqR.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqR.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqR.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
  sqR.exec("INSERT INTO users (id, telegram_id) VALUES (4242, '4242')");
  const baseR = (sql) => { const st = sqR.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
  const dbR = { prepare(sql) { return baseR(sql); } };
  const origFetchR = global.fetch;
  const plainPdf = new TextEncoder().encode("%PDF-1.4\nBT (Hello World) Tj ET\n%%EOF");
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/file/bot")) return new Response(plainPdf.slice().buffer, { headers: { "content-type": "application/pdf" } });
    if (u.startsWith("https://api.telegram.org/")) {
      const m = /\/bot[^/]+\/(\w+)$/.exec(u);
      const method = m ? m[1] : "";
      if (method === "getFile") return Response.json({ ok: true, result: { file_path: "doc/r.pdf" } });
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    return Response.json({ ok: true });
  };
  try {
    const envR = { STATE: fakeKV(), DB: dbR, TG_TOKEN: "fake-token" };
    const sentR = [];
    const handledR = await handleIncomingFile(envR, {
      userId: 4242, chatId: 4242, tgFileId: "pdf-r", fileType: "document", mimeType: "application/pdf", fileName: "scan.pdf",
      caption: "این پی‌دی‌اف رو خلاصه کن",
      send: async (t) => { sentR.push(String(t)); },
      chatFn: async (t) => { check(String(t).includes("Hello World"), "fix1: pure chatFn receives extracted PDF text"); return "خلاصه فارسی: یک بار"; },
      routerCallFn: null,
    });
    check(handledR === true && sentR.length === 1 && sentR[0].includes("خلاصه فارسی"), `fix1: PDF summary sends exactly ONE reply: count=${sentR.length} ${JSON.stringify(sentR)}`);
  } finally {
    global.fetch = origFetchR;
  }

  let nvSeen = null;
  const nvFn = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("integrate.api.nvidia.com/v1/chat/completions")) {
      nvSeen = { url: u, init };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "روی لباسش دو شخصیت کارتونی است." } }] }) };
    }
    return { ok: false, json: async () => ({}) };
  };
  const anaNv = await analyzeImage({ STATE: fakeKV(), GEMINI_API_KEY: "AQ.not-a-rest-key", NVIDIA_API_KEY: "nvap-test" }, {
    imageBytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg", prompt: "اون ها چیه روی لباسش", fetchFn: nvFn,
  });
  check(anaNv.ok === true && String(anaNv.text).includes("شخصیت کارتونی") && nvSeen && nvSeen.url.includes("integrate.api.nvidia.com") && String(nvSeen.init?.headers?.Authorization || "").startsWith("Bearer nvap-"), `fix2: analyzeImage uses NVIDIA vision key: ${JSON.stringify(anaNv)} seen=${nvSeen && nvSeen.url}`);

  const sentI = [];
  const photosI = [];
  const imgFn = async (url) => {
    const u = String(url);
    if (u.includes("integrate.api.nvidia.com/v1/chat/completions")) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: "futuristic car on Tehran streets" } }] }) };
    }
    if (u.includes("ai.api.nvidia.com")) return { ok: false, json: async () => ({}) };
    if (u.includes("image.pollinations.ai")) return { ok: true, arrayBuffer: async () => new Uint8Array([7, 8, 9]).buffer };
    return { ok: false, json: async () => ({}) };
  };
  const rI = await handleDailyText({ STATE: fakeKV(), DB: dbR, NVIDIA_API_KEY: "nvap-img" }, {
    userId: 4242, chatId: 4242, text: "یه عکس از یک خودروی آینده‌نگر در خیابان‌های تهران بساز",
    send: async (t) => { sentI.push(String(t)); },
    sendPhoto: async (bytes, opts) => { photosI.push({ bytes, opts }); return { ok: true }; },
    fetchFn: imgFn,
  });
  check(rI === "handled" && sentI.some((t) => t.includes("در حال ساخت تصویر")), `fix3: image gen sends progress message: ${JSON.stringify(sentI)}`);
  check(photosI.length === 1 && photosI[0].bytes instanceof Uint8Array && photosI[0].bytes.length === 3 && String(photosI[0].opts?.caption || "").includes("تصویر ساخته شد") && Boolean(photosI[0].opts?.mimeType), `fix3: sendPhoto(bytes, opts) called once with caption/mimeType: ${JSON.stringify(photosI.map((p) => ({ len: p.bytes?.length, opts: p.opts })))}`);
}

// Regression: chunked base64 on large photos + ToUnicode CMap + image stream skip.
{
  const { bytesToBase64, analyzeImage } = await import("../../src/media.js");
  const { extractTextFromPdfBytes } = await import("../../src/pdf.js");

  const bigPhoto = new Uint8Array(150000);
  for (let i = 0; i < bigPhoto.length; i++) bigPhoto[i] = i & 0xff;
  let bigB64 = "";
  let b64Threw = false;
  const savedBuffer = globalThis.Buffer;
  try {
    try { delete globalThis.Buffer; } catch {}
    bigB64 = bytesToBase64(bigPhoto);
  } catch { b64Threw = true; }
  finally { globalThis.Buffer = savedBuffer; }
  check(b64Threw === false && bigB64.length > 0, `fix2: bytesToBase64 handles 150KB without Maximum call stack size exceeded (threw=${b64Threw})`);

  const bigAna = await analyzeImage(
    { GEMINI_API_KEY: "gkey-big" },
    {
      imageBytes: bigPhoto,
      mimeType: "image/jpeg",
      prompt: "اون ها چیه روی لباسش",
      fetchFn: async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "روی لباس دو شخصیت کارتونی است." }] } }] }) }),
    },
  );
  check(bigAna.ok === true && String(bigAna.text).includes("شخصیت کارتونی"), `fix2: analyzeImage handles a 150KB photo without throwing: ${JSON.stringify(bigAna).slice(0, 120)}`);

  const toUni = [
    "/CIDInit /ProcSet findresource begin",
    "begincmap",
    "beginbfchar",
    "<0001> <0048>",
    "<0002> <0069>",
    "endbfchar",
    "endcmap",
  ].join("\n");
  const content = "BT /F1 12 Tf <0001><0002> Tj ET";
  const imageBinary = "\x00BT (BINARYIMAGEDATA) Tj ET\xFF";
  const pdf = new TextEncoder().encode(
    "%PDF-1.4\n" +
    "1 0 obj\n<< /Length " + toUni.length + " >>\nstream\n" + toUni + "\nendstream\nendobj\n" +
    "2 0 obj\n<< /Type /XObject /Subtype /Image /Width 10 /Height 10 /BitsPerComponent 8 /Length " + imageBinary.length + " >>\nstream\n" + imageBinary + "\nendstream\nendobj\n" +
    "3 0 obj\n<< /Length " + content.length + " >>\nstream\n" + content + "\nendstream\nendobj\n%%EOF",
  );
  const cmapText = await extractTextFromPdfBytes(pdf);
  check(String(cmapText).includes("Hi"), `fix1: ToUnicode beginbfchar maps glyphs to readable text: ${JSON.stringify(cmapText).slice(0, 120)}`);
  check(!String(cmapText).includes("BINARYIMAGEDATA"), "fix1: /Subtype /Image binary stream is skipped");
}

// Fix #3/#4: reply-to-photo edit + direct photo vision.
if (DatabaseSync) {
  const sqF = new DatabaseSync(":memory:");
  sqF.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqF.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqF.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
  sqF.exec("INSERT INTO users (id, telegram_id) VALUES (4242, '4242')");
  const baseF = (sql) => { const st = sqF.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
  const dbF = { prepare(sql) { return baseF(sql); } };
  const origFetchF = global.fetch;
  const visionReplyF = "روی لباسش دو شخصیت کارتونی است.";
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("https://api.telegram.org/")) {
      const m = /\/bot[^/]+\/(\w+)$/.exec(u);
      if (m && m[1] === "getFile") return Response.json({ ok: true, result: { file_path: "photos/f.jpg" } });
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    if (u.includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]).buffer, { headers: { "content-type": "image/jpeg" } });
    if (u.includes("generativelanguage.googleapis.com")) return Response.json({ candidates: [{ content: { parts: [{ text: visionReplyF }] } }] });
    return Response.json({ ok: true });
  };
  try {
    const sentDirect = [];
    const handledDirect = await handleVaultFile({ STATE: fakeKV(), DB: dbF, TG_TOKEN: "fake-token", GEMINI_API_KEY: "gkey-f" }, {
      userId: 4242, chatId: 4242, tgFileId: "photo-direct", fileType: "photo", mimeType: "image/jpeg", caption: "اون ها چیه روی لباسش",
      send: async (t) => { sentDirect.push(String(t)); },
    });
    check(handledDirect === true && sentDirect.length === 1 && sentDirect[0].includes(visionReplyF), `fix4: direct photo vision passes downloaded bytes to analyzeImage: ${JSON.stringify(sentDirect)}`);

    const sentEdit = []; const photosEdit = [];
    const editFetch = async (url) => {
      const u = String(url);
      if (u.includes("integrate.api.nvidia.com/v1/chat/completions")) return { ok: true, json: async () => ({ choices: [{ message: { content: "futuristic car, no people, empty street, clear blue sky without pollution" } }] }) };
      if (u.includes("ai.api.nvidia.com")) return { ok: false, status: 500, json: async () => ({}) };
      if (u.includes("image.pollinations.ai")) return { ok: true, arrayBuffer: async () => new Uint8Array([5, 6, 7]).buffer };
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const rEdit = await handleDailyText({ STATE: fakeKV(), DB: dbF, TG_TOKEN: "fake-token", NVIDIA_API_KEY: "nvap-edit" }, {
      userId: 4242, chatId: 4242,
      text: "ادمها رو از عکس حذف کن. الودگی هوا رو هم کم کن",
      replyToPhoto: { fileId: "photo-reply", caption: "🎨 تصویر ساخته شد: یک خودروی آینده‌نگر در خیابان‌های تهران" },
      send: async (t) => { sentEdit.push(String(t)); },
      sendPhoto: async (bytes, opts) => { photosEdit.push({ bytes, opts }); return { ok: true }; },
      fetchFn: editFetch,
    });
    check(rEdit === "handled" && sentEdit.some((t) => t.includes("در حال ویرایش تصویر")), `fix3: reply-to-image edit sends progress: ${JSON.stringify(sentEdit)}`);
    check(photosEdit.length === 1 && photosEdit[0].bytes instanceof Uint8Array && photosEdit[0].bytes.length === 3 && String(photosEdit[0].opts?.caption || "").includes("ویرایش"), `fix3: reply-to-image edit regenerates and sends a new photo: ${JSON.stringify(photosEdit.map((p) => ({ len: p.bytes?.length, caption: p.opts?.caption })))}`);
    check(!sentEdit.some((t) => /فتوشاپ|Photoshop|OpenCV|آموزش/u.test(t)), "fix3: edit never falls through to a text tutorial");

    const sentFollow = []; const photosFollow = [];
    const followFetch = async (url) => {
      const u = String(url);
      if (u.includes("integrate.api.nvidia.com/v1/chat/completions")) return { ok: true, json: async () => ({ choices: [{ message: { content: "futuristic car in Tehran streets, red car, taller surrounding buildings" } }] }) };
      if (u.includes("ai.api.nvidia.com")) return { ok: false, status: 500, json: async () => ({}) };
      if (u.includes("image.pollinations.ai")) return { ok: true, arrayBuffer: async () => new Uint8Array([11, 12, 13]).buffer };
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const rFollow = await handleDailyText({ STATE: fakeKV(), DB: dbF, TG_TOKEN: "fake-token", NVIDIA_API_KEY: "nvap-follow" }, {
      userId: 4242, chatId: 4242,
      text: "رنگ ماشینو قرمز کن و ساختمونهای اطراف بلند تر بشن",
      replyToPhoto: { fileId: "photo-follow", caption: "🎨 تصویر ساخته شد (pollinations): یک خودروی آینده‌نگر در خیابان‌های تهران" },
      send: async (t) => { sentFollow.push(String(t)); },
      sendPhoto: async (bytes, opts) => { photosFollow.push({ bytes, opts }); return { ok: true }; },
      fetchFn: followFetch,
    });
    check(rFollow === "handled" && photosFollow.length === 1 && photosFollow[0].bytes instanceof Uint8Array && photosFollow[0].bytes.length === 3 && String(photosFollow[0].opts?.caption || "").includes("رنگ ماشینو قرمز کن"), `fix3: any-wording reply to generated photo regenerates and sends a new photo: ${JSON.stringify(photosFollow.map((p) => ({ len: p.bytes?.length, caption: p.opts?.caption })))}`);
    check(!sentFollow.some((t) => /فتوشاپ|Photoshop|OpenCV|آموزش/u.test(t)), "fix3: any-wording follow-up never falls through to a text tutorial");

    const sentFollow2 = []; const photosFollow2 = []; const followBodies2 = [];
    const followFetch2 = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("translate.googleapis.com")) return { ok: false, status: 500, json: async () => ({}) };
      if (u.includes("integrate.api.nvidia.com/v1/chat/completions")) {
        followBodies2.push(String(init.body || ""));
        return { ok: true, json: async () => ({ choices: [{ message: { content: "futuristic car in Tehran streets, clearer, daytime" } }] }) };
      }
      if (u.includes("ai.api.nvidia.com")) return { ok: false, status: 500, json: async () => ({}) };
      if (u.includes("image.pollinations.ai")) return { ok: true, arrayBuffer: async () => new Uint8Array([21, 22, 23]).buffer };
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const baseScene = "یک خودروی آینده‌نگر در خیابان‌های تهران";
    const editText = "خودروی آینده نگر رو واضح تر کن. روز بشه.";
    const rFollow2 = await handleDailyText({ STATE: fakeKV(), DB: dbF, TG_TOKEN: "fake-token", NVIDIA_API_KEY: "nvap-follow2" }, {
      userId: 4242, chatId: 4242,
      text: editText,
      replyToPhoto: { fileId: "photo-follow2", caption: `🎨 تصویر ساخته شد (pollinations): ${baseScene}` },
      send: async (t) => { sentFollow2.push(String(t)); },
      sendPhoto: async (bytes, opts) => { photosFollow2.push({ bytes, opts }); return { ok: true }; },
      fetchFn: followFetch2,
    });
    const passedBoth = followBodies2.some((b) => b.includes(baseScene) && b.includes(editText));
    check(rFollow2 === "handled" && passedBoth, `fix3: follow-up edit passes base scene and edit into the image generator: ${JSON.stringify(followBodies2).slice(0, 300)}`);
    check(photosFollow2.length === 1 && String(photosFollow2[0].opts?.caption || "").includes(baseScene) && String(photosFollow2[0].opts?.caption || "").includes(editText), `fix3: follow-up caption preserves base scene and edit text: ${JSON.stringify(photosFollow2.map((p) => p.opts?.caption))}`);
  } finally {
    global.fetch = origFetchF;
  }
}

// Fix #1 + Fix #4: visual-RTL Persian un-reversal and vision text cleanup.
{
  const { fixVisualRtlPersian } = await import("../../src/pdf.js");
  const { cleanVisionPersianText } = await import("../../src/media.js");
  check(fixVisualRtlPersian("راضحتسا تهج ناریا تارباخم") === "مخابرات ایران جهت استحضار", `fix1: visual-RTL line un-reverses to مخابرات ایران جهت استحضار: ${JSON.stringify(fixVisualRtlPersian("راضحتسا تهج ناریا تارباخم"))}`);
  check(fixVisualRtlPersian("شورف زا سپ تامدخ") === "خدمات پس از فروش", `fix1: visual-RTL line un-reverses to خدمات پس از فروش: ${JSON.stringify(fixVisualRtlPersian("شورف زا سپ تامدخ"))}`);
  check(fixVisualRtlPersian("خروم هبنشود زور رد") === "در روز دوشنبه مورخ", `fix1: visual-RTL line un-reverses to در روز دوشنبه مورخ: ${JSON.stringify(fixVisualRtlPersian("خروم هبنشود زور رد"))}`);
  const dirtyVision = "_IMAGE_ <think>internal</think> این یک فاکتور برق است.,}}]\n\n... wait, let me look at the image again...";
  const cleanVision = cleanVisionPersianText(dirtyVision);
  check(cleanVision.includes("فاکتور برق") && !cleanVision.includes("_IMAGE_") && !cleanVision.includes("<think>") && !cleanVision.includes("wait, let me look") && !cleanVision.includes(",}}]"), `fix4: cleanVisionPersianText strips _IMAGE_/think/JSON/English self-talk: ${JSON.stringify(cleanVision)}`);
}

// Fix #1: TJ kerning -> table separators + Arabic Presentation Forms -> NFKC.
{
  const { extractTextFromPdfBytes } = await import("../../src/pdf.js");
  const cmapP = ["begincmap", "beginbfchar", "<0001> <FB56FE98>", "endbfchar", "endcmap"].join("\n");
  const colsP = "BT /F1 12 Tf [ (Net) -400 (7,03 EUR) -400 (19%) -400 (8,37 EUR) ] TJ ET";
  const persianP = "BT /F2 12 Tf <0001> Tj ET";
  const pdfP = new TextEncoder().encode(
    "%PDF-1.4\n" +
    "1 0 obj\n<< /Length " + cmapP.length + " >>\nstream\n" + cmapP + "\nendstream\nendobj\n" +
    "2 0 obj\n<< /Length " + colsP.length + " >>\nstream\n" + colsP + "\nendstream\nendobj\n" +
    "3 0 obj\n<< /Length " + persianP.length + " >>\nstream\n" + persianP + "\nendstream\nendobj\n%%EOF",
  );
  const outP = await extractTextFromPdfBytes(pdfP);
  check(String(outP).includes("Net") && /\|\s*7,03 EUR/.test(outP) && /\|\s*19%/.test(outP) && /\|\s*8,37 EUR/.test(outP), `fix1: TJ kerning offsets become table column separators: ${JSON.stringify(outP).slice(0, 200)}`);
  check(String(outP).includes("پت"), `fix1: Arabic Presentation Forms normalize via NFKC to Persian: ${JSON.stringify(outP).slice(0, 200)}`);
}

// Fix #1/#2/#3: relaxed image parsing, NLU image_gen, document-wide visual RTL.
{
  const { parseImageGenCommand } = await import("../../src/media.js");
  const pTypo = parseImageGenCommand("برام به عکس شکلات کنار چای روی میز خونه در هوایی پاییزی بساز.");
  const pPlain = parseImageGenCommand("یه عکس شکلات کنار چای روی میز خونه در هوایی پاییزی بساز.");
  check(pTypo.isImageGen === true && pTypo.prompt.includes("شکلات کنار چای"), `fix1: "برام به عکس ..." matches image gen: ${JSON.stringify(pTypo)}`);
  check(pPlain.isImageGen === true && pPlain.prompt.includes("شکلات کنار چای"), `fix1: "یه عکس ..." (no از) matches image gen: ${JSON.stringify(pPlain)}`);
  const nluImg = await classifyIntentNlu({}, "یه عکس شکلات بساز", {}, {
    model: "test/model",
    callFn: async () => JSON.stringify({ intent: "image_gen", confidence: 0.92, body: "شکلات کنار چای" }),
  });
  check(nluImg.ok === true && nluImg.intent === "image_gen", `fix1: NLU accepts image_gen intent: ${JSON.stringify(nluImg)}`);
  const { fixVisualRtlPersian } = await import("../../src/pdf.js");
  const rtlDoc = ["راضحتسا تهج ناریا تارباخم", "نایع‌راز دواد"].join("\n");
  const nameLine = fixVisualRtlPersian(rtlDoc).split("\n")[1].replace(/\u200C/g, "");
  check(nameLine === "داود زارعیان", `fix3: document-wide visual RTL reverses standalone name line: ${JSON.stringify(nameLine)}`);
}

// Fix #2: Telegram formatting upgrade — headings, bold, bullets, dividers,
// markdown tables as mobile cards, and preserved safe HTML.
{
  const h = formatTelegramHtml("### نکات\n**مهم**\n- مورد اول\n---\n| نام | نقش |\n|---|---|\n| علی | مدیر |");
  check(h.includes("📌 <b>نکات</b>") && h.includes("<b>مهم</b>") && h.includes("• مورد اول") && h.includes("───────────────"), `fix2: headings/bold/bullets/dividers convert cleanly: ${JSON.stringify(h)}`);
  check(h.includes("▫️ <b>نام:</b> علی  •  <b>نقش:</b> مدیر") && !h.includes("|---|") && !h.includes("| نام |"), `fix2: markdown tables render as mobile cards without pipes: ${JSON.stringify(h)}`);
  check(!h.includes("**") && !h.includes("###"), `fix2: no raw markdown symbols remain: ${JSON.stringify(h)}`);
  const preserved = formatTelegramHtml("<b>موجود</b> و **جدید**");
  check(preserved === "<b>موجود</b> و <b>جدید</b>", `fix2: existing <b> tags are preserved and not double-escaped: ${JSON.stringify(preserved)}`);
}

// Fix #1: Pollinations uses the clean URL (no enhance/private) and shrinks
// to 768 only after the 1024 attempt fails.
{
  const { generateFreeImage } = await import("../../src/media.js");
  const urls = [];
  const fn = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("hf.space")) return { ok: false, status: 503 };
    if (u.includes("image.pollinations.ai") && u.includes("width=1024")) return { ok: false, status: 502 };
    if (u.includes("image.pollinations.ai") && u.includes("width=768")) return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    return { ok: false, status: 404 };
  };
  const r = await generateFreeImage({}, "sunset over the city", { fetchFn: fn });
  const pollUrls = urls.filter((u) => u.includes("image.pollinations.ai"));
  check(r.ok === true && r.provider === "pollinations" && r.bytes.length === 3, `fix1: pollinations 768 fallback succeeds: ${JSON.stringify(r).slice(0, 160)}`);
  check(pollUrls.length === 2 && pollUrls[0].includes("width=1024") && pollUrls[1].includes("width=768"), `fix1: 1024 first, then 768: ${JSON.stringify(pollUrls)}`);
  check(!pollUrls.some((u) => u.includes("enhance=true") || u.includes("private=true") || u.includes("model=flux")), `fix1: clean Pollinations URL has no enhance/private/model flags: ${JSON.stringify(pollUrls)}`);
}

// NVIDIA NIM parallel race: sd3/sdxl win even when flux returns 404/422.
{
  const { generateFreeImage } = await import("../../src/media.js");
  const b64 = Buffer.from([1, 2, 3, 4, 5]).toString("base64");
  const seen = [];
  const fn = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes("flux.1-schnell")) return { ok: false, status: 404, json: async () => ({ error: "model not found" }) };
    if (u.includes("stable-diffusion-3-medium")) return { ok: true, status: 200, json: async () => ({ image: b64 }) };
    if (u.includes("sdxl-turbo")) return { ok: false, status: 422, json: async () => ({ error: "bad params" }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const r = await generateFreeImage({ NVIDIA_API_KEY: "nkey" }, "a red fox in the snow", { fetchFn: fn });
  check(r.ok === true && r.provider === "nvidia" && r.bytes.length === 5, `race: nvidia Promise.any uses sd3 when flux fails: ${JSON.stringify(r).slice(0, 200)}`);
  check(seen.some((u) => u.includes("flux.1-schnell")) && seen.some((u) => u.includes("stable-diffusion-3-medium")) && seen.some((u) => u.includes("sdxl-turbo")), `race: all three NVIDIA endpoints raced: ${JSON.stringify(seen.filter((u) => u.includes("ai.api.nvidia.com")))}`);
  check(Array.isArray(r.diagErrors) && r.diagErrors.some((d) => /^nvidia-flux:404:/.test(d)), `race: flux failure recorded in diagErrors: ${JSON.stringify(r.diagErrors)}`);
}

// HF ZeroGPU FLUX.1-schnell Space: Gradio event_id + SSE complete flow.
{
  const { generateViaHfFluxSpace } = await import("../../src/media.js");
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method });
    if (u.endsWith("/gradio_api/call/infer")) return { ok: true, status: 200, json: async () => ({ event_id: "evt-42" }) };
    if (u.endsWith("/gradio_api/call/infer/evt-42")) return { ok: true, status: 200, text: async () => "event: generating\ndata: null\n\nevent: complete\ndata: [[{\"url\":\"https://cdn.example/img.webp\"}]]\n\n" };
    if (u === "https://cdn.example/img.webp") return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([9, 8, 7, 6]).buffer };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const r = await generateViaHfFluxSpace("a red fox in the snow", fn, 7);
  check(r.ok === true && r.provider === "hf-flux-space" && r.mimeType === "image/webp" && r.bytes.length === 4, `hf-space: parses event_id + SSE complete: ${JSON.stringify({ ok: r.ok, provider: r.provider, mimeType: r.mimeType, len: r.bytes?.length, diag: r.diagErrors })}`);
  check(calls.some((c) => c.method === "POST" && c.url.endsWith("/gradio_api/call/infer")) && calls.some((c) => c.method === "GET" && c.url.endsWith("/gradio_api/call/infer/evt-42")), `hf-space: uses Gradio POST + SSE GET: ${JSON.stringify(calls)}`);
}

}
