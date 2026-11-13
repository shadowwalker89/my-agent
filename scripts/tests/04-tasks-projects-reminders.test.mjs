// Tasks / projects / reminders / notes — extracted from scripts/test-dev.mjs by R0.3; assertions unchanged.
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
// ── Phase 1-a: migration 0003 + task/project D1 functions (no wiring) ───
// Fresh in-memory DB: user + note rows exist BEFORE 0003, so the migration
// itself must seed projects and attach old notes to عمومی.
if (DatabaseSync) {
  const sqlite1a = new DatabaseSync(":memory:");
  sqlite1a.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite1a.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqlite1a.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
  sqlite1a.exec("INSERT INTO notes (user_id, text, source, created_at) VALUES (1, 'old note', 'text', '2026-10-30T00:00:00.000Z')");
  sqlite1a.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
  sqlite0a.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite0a.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqlite0a.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
  sqlite0a.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
  sqlite0b.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite0b.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqlite0b.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
  sqlite0b.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
  sqlite1b1.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite1b1.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqlite1b1.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
  sqlite1b2.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite1b2.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqlite1b2.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
    sqlite1b3.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sqlite1b3.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sqlite1b3.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
    sqlite1b4.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sqlite1b4.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sqlite1b4.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
    sq2.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8")); sq2.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8")); sq2.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8")); sq2.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
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
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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
    sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
    sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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

}
