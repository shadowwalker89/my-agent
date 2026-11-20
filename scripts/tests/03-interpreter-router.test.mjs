// Synthetic eval / interpreter / router — extracted from scripts/test-dev.mjs by R0.3; assertions unchanged.
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
import { check, failures, fakeKV, mockWorld, workerDefault, ctxNull, sendTg, msgUpdate, cbUpdate, newEnv, DatabaseSync } from "./harness.mjs";

export async function run() {
// ── Phase 0-c: synthetic eval set + scorer (offline only, no network) ──
{
  const cases = JSON.parse(fs.readFileSync(new URL("../../eval/intent-synthetic.json", import.meta.url), "utf8"));
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
        sends.length === 2 && first.parse_mode === "HTML" && first.text === "<b>bold</b>" && second.text === "bold" && second.parse_mode === undefined,
        "3-a: sendMessage retries stripped plain text when Telegram rejects HTML",
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
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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

  // ── N-6b: safe NLU shape diagnostic + object-shaped model responses ──
  {
    const nluText = "فردا سیمان و گچ یادداشت کن";
    const validNlu = {
      intent: "note", confidence: 0.93, project: null, title: null, body: "سیمان و گچ",
      date_ref: null, time_ref: null, daypart: null, summary_target: null,
      leading_framing: null, trailing_framing: null,
    };
    const runNlu = (aiRun) => classifyIntentNlu({ AI: { run: aiRun } }, nluText, {}, {});

    // N6b-1: object response goes through the same extract + validation path.
    {
      const obj = await runNlu(async () => ({ response: { ...validNlu } }));
      const str = await runNlu(async () => ({ response: JSON.stringify(validNlu) }));
      check(obj.ok === true && obj.intent === validNlu.intent && obj.body === validNlu.body && obj.confidence === str.confidence, "N6b-1: {response:<object>} is coerced and validated identically to the existing string mock");
      check(obj.ok === true && !("shape" in obj), "N6b-1: a successful NLU never carries a shape");
    }
    // N6b-2: bad-json failure carries a safe, class-only shape.
    {
      const r = await runNlu(async () => ({ response: "this is not json" }));
      const sh = r.shape ?? {};
      check(r.ok === false && r.reason === "bad-json" && sh.resType === "object" && sh.responseType === "string" && sh.hasIntentToken === false && sh.extractOk === false, "N6b-2: bad-json failure reports resType/responseType/hasIntentToken/extractOk");
      check(!JSON.stringify(sh).includes("this is not json") && !JSON.stringify(sh).includes("not json"), "N6b-2: shape contains no substring of the model text");
    }
    // N6b-3: object {} matches the string {} outcome; no new accepted path.
    {
      const obj = await runNlu(async () => ({ response: {} }));
      const str = await runNlu(async () => ({ response: "{}" }));
      const ok = await runNlu(async () => ({ response: JSON.stringify(validNlu) }));
      check(obj.ok === str.ok && obj.reason === str.reason && obj.reason === "bad-intent", "N6b-3: object {} and string {} share the same failure outcome");
      check(Boolean(obj.shape) && Boolean(str.shape) && !("shape" in ok), "N6b-3: shape appears on failures only");
    }
    // N6b-4: truncated JSON reports structural hints plus the token count.
    {
      const r = await runNlu(async () => ({ response: '{"intent":"chat","conf', usage: { completion_tokens: 512 } }));
      const sh = r.shape ?? {};
      check(r.ok === false && r.reason === "bad-json" && sh.braceDelta > 0 && sh.completionTokens === 512 && sh.hasIntentToken === true && sh.extractOk === false, "N6b-4: truncated JSON shape reports braceDelta, completionTokens, intent token and failed extraction");
    }
    // N6b-5: canary — user text and object key/value never leak into the diag.
    {
      const CAN = "TESTKEY-FAKE-CANARY-123";
      const sc = fresh1e();
      const env = { STATE: fakeKV(), DB: sc.db, AI: { run: async () => ({ response: { [CAN]: CAN }, usage: { completion_tokens: 7 } }) } };
      const orig = console.log;
      const captured = [];
      console.log = (...a) => { captured.push(a.map(String).join(" ")); };
      try {
        await handleDailyText(env, { chatId: 1, userId: 1, text: `${CAN} لطفا تسک‌هایم را نشان بده`, send: async () => {}, chat: async () => {}, nowMs: MORNING });
      } finally { console.log = orig; }
      const diag = captured.filter((line) => line.includes("intent_nlu_diag"));
      check(diag.length >= 1 && !diag.join("\n").includes(CAN), "N6b-5 canary: user text and object keys/values never appear in intent_nlu_diag");
    }
    // N6b-6: diag includes shape only when the NLU failed.
    {
      const sc = fresh1e();
      const envOf = (aiRun) => ({ STATE: fakeKV(), DB: sc.db, AI: { run: aiRun } });
      const callBranch = async (env, text) => {
        const orig = console.log; const lines = [];
        console.log = (...a) => { const s = a.map(String).join(" "); if (s.includes("intent_nlu_diag")) lines.push(s); };
        try {
          await runNluBranch(env, { userId: 1, chatId: 1, text, send: async () => {}, chat: async () => {} }, { now: MORNING }, { runDailyBranch: async () => null });
        } finally { console.log = orig; }
        return lines;
      };
      const badLines = await callBranch(envOf(async () => ({ response: "not json at all" })), "سلام");
      const okLines = await callBranch(envOf(async () => ({ response: JSON.stringify({ intent: "chat", confidence: 0.9 }) })), "سلام");
      check(badLines.length === 1 && badLines[0].includes('"shape"'), "N6b-6: failing NLU emits a diag line with a shape field");
      check(okLines.length === 1 && !okLines[0].includes('"shape"'), "N6b-6: successful NLU emits a diag line without a shape field");
    }
    // N6b-7: timeout and low-confidence behaviour is unchanged.
    {
      const timedOut = await classifyIntentNlu({ AI: { run: () => new Promise(() => {}) } }, "hi", {}, { timeoutMs: 50 });
      check(timedOut.ok === false && timedOut.reason === "timeout", "N6b-7: NLU timeout still returns { ok: false, reason: timeout }");
      const sc = fresh1e(); seedProjE(sc.sq, 1, "عمومی", [], 1);
      const c = convoE(sc, { AI: aiJson({ intent: "note", confidence: 0.4, body: "چیزی" }) });
      const r = await c.say("فردا سیمان و گچ برای پروژه گلبهار تحویل گرفته میشه", MORNING);
      check(r === "chat" && sc.rows("SELECT id FROM notes WHERE user_id = 1").length === 0, "N6b-7: low-confidence NLU still falls through to chat with no write");
    }
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
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
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
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
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
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
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
  sqlite0b.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite0b.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  // 1-b-1: the shared Phase 0-b DB now also carries migration 0003 (the
  // schema production already has). No users rows exist yet, so the
  // migration seeds nothing and the fallback seed list still governs.
  sqlite0b.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
    sqliteFix.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sqliteFix.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
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

}
