// D1 layer / date time / wiring / voice — extracted from scripts/test-dev.mjs by R0.3; assertions unchanged.
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
import { downloadTelegramVoice } from "../../src/channels/telegram.js";
import { check, fakeKV, mockWorld, workerDefault, ctxNull, sendTg, msgUpdate, cbUpdate, newEnv, DatabaseSync } from "./harness.mjs";

export async function run() {
// ── Step 1a: D1 layer + memory layer (real SQLite, real migration SQL) ─────
// D1-compatible adapter over node:sqlite: db.js talks D1 (.prepare/.bind/
// .run/.all/.first); the adapter translates that to SQLite. This tests the
// real SQL (kind filter, LIMIT, ON CONFLICT) — the only simulation is the
// adapter itself, not the queries. Live D1 verification is still a 1b job.
if (DatabaseSync) {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    sqlite.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
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
  check(!fs.readFileSync(new URL("../../src/daily.js", import.meta.url), "utf8").includes("users.currency"), "1b currency path never reads the users currency column");
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
  const replied = buildChatContext([{ id: 1, role: "user", content: "سلام" }], { memoryHeader: "name=رضا", replyToText: "قبلی" });
  check(replied.length === 3 && replied[0].content === "name=رضا" && replied[1].content === "[در پاسخ به پیام قبلی: «قبلی»]" && replied[2].content === "سلام", `reply context injected after memory header: ${JSON.stringify(replied)}`);
  check(!REF_RE.test("همونجا باش") && REF_RE.test("همونو بنداز فردا"), "REF_RE respects word boundaries");
}
if (DatabaseSync) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
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
if (DatabaseSync) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
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


// Structured Google quota diagnostics: no assumptions from free-form messages.
{
  const quota = (violations, extra = []) => ({ error: { message: "private", details: [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations }, ...extra,
  ] } });
  const retry = (retryDelay) => ({ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay });
  const now = Date.UTC(2026, 10, 7, 12);
  let q = classifyVoiceQuota(quota([{ quotaId: "GenerateRequestsPerDayPerProjectPerModel", quotaDimensions: { model: "private-model" } }]), null, now);
  check(q.kind === "daily" && q.scope === "model" && q.retryAfterSeconds === null, "voice quota: real error.details envelope, daily model scope");
  q = classifyVoiceQuota(quota([{ quotaId: "GenerateRequestsPerMinutePerProject" }], [retry("2.25s")]), new Headers({ "retry-after": "5" }), now);
  check(q.kind === "rate" && q.scope === "project" && q.retryAfterSeconds === 5, "voice quota: project scope and longest server-supplied wait rounded up");
  q = classifyVoiceQuota(quota([{ quotaId: "GenerateRequestsPerMinutePerProject", quotaDimensions: { model: "private-model" } }]), null, now);
  check(q.scope === "model", "voice quota: explicit model dimension prevents false project-wide stop");
  q = classifyVoiceQuota(quota([{ quotaMetric: "api/requests_per_hour_per_project" }]), new Headers({ "retry-after": new Date(now + 9000).toUTCString() }), now);
  check(q.kind === "rate" && q.scope === "project" && q.retryAfterSeconds === 9, "voice quota: metric identifiers and HTTP-date Retry-After");
  q = classifyVoiceQuota({ error: { details: [retry("0.2s")] } }, null, now);
  check(q.kind === "unknown" && q.scope === "unknown" && q.retryAfterSeconds === 1, "voice quota: RetryInfo alone does not prove minute/daily quota");
  for (const header of ["12junk", "-5", "Infinity", "99999999999"]) {
    check(classifyVoiceQuota(null, new Headers({ "retry-after": header }), now).retryAfterSeconds === null, "voice quota: invalid/unbounded wait rejected: " + header);
  }
  q = classifyVoiceQuota(quota([{ quotaId: "PerDayPerProject" }, { quotaId: "PerMinutePerProjectPerModel" }]), null, now);
  check(q.kind === "daily" && q.scope === "project", "voice quota: a proven project violation still blocks model fallback in mixed details");
  q = classifyVoiceQuota({ error: { message: "daily quota exceeded", details: [{ "@type": "unknown", quotaId: "PerDayPerProject" }] } }, null, now);
  check(q.kind === "unknown" && q.scope === "unknown", "voice quota: free-form messages and unknown detail types never establish quota scope");
  check(!JSON.stringify(classifyVoiceQuota(quota([{ subject: "private", description: "private", quotaId: "PerDayPerProject", quotaDimensions: { project: "private" } }]), null)).includes("private"), "voice quota: raw identifiers and descriptions never retained");
}

// Quota response handling across upload, file readiness, create, and result GET.
{
  const originalFetch = global.fetch, originalLog = console.log, originalWarn = console.warn;
  const env = { GEMINI_API_KEY: "quota-secret", TG_TOKEN: "bot-secret", STATE: fakeKV() };
  let target, scope, generations, deletes, logs;
  console.log = console.warn = (...args) => logs.push(JSON.stringify(args));
  const limited = () => Response.json({ error: { status: "RESOURCE_EXHAUSTED", message: env.GEMINI_API_KEY, details: [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: scope === "unknown" ? [] : [{
      quotaId: scope === "project" ? "RequestsPerDayPerProject" : "RequestsPerMinutePerProjectPerModel",
      subject: "private-subject", quotaDimensions: scope === "model" ? { model: "private-model" } : {},
    }] }, { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "8.5s" },
  ] } }, { status: 429 });
  global.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path.includes("/file/bot")) return new Response(new Uint8Array([1]));
    if (String(url).includes("api.telegram.org")) return Response.json({ ok: true, result: { file_path: "voice/test.ogg" } });
    if (init.method === "DELETE") { deletes++; return Response.json({}); }
    if (path.includes("/upload/")) return target === "upload" ? limited() : Response.json({ file: { name: "files/quota-test" } });
    if (path === "/v1beta/files/quota-test") return target === "file" ? limited() : Response.json({ state: "ACTIVE", uri: "https://example/audio" });
    if (path === "/v1beta/interactions/result-1") return limited();
    generations++;
    if (path === "/v1beta/interactions") return target === "result" ? Response.json({ id: "result-1", status: "in_progress" }) : limited();
    if (target === "allfail") return Response.json({ error: { status: "UNAVAILABLE" } }, { status: 503 });
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "successful fallback" }] } }] });
  };
  try {
    for (const scenario of [["upload", "project", 0, "UPLOAD"], ["file", "project", 0, "FILE"], ["create", "project", 1, "INTERACTION"], ["result", "project", 1, "INTERACTION"], ["create", "model", 2], ["create", "unknown", 2], ["allfail", "model", 3, "INTERACTION"]]) {
      [target, scope] = scenario; generations = 0; deletes = 0; logs = [];
      const sent = [], routed = [];
      const result = await handleVoice(env, { userId: 42, chatId: 42,
        voice: { file_id: "private-file", duration: 2 }, transcribeOpts: { pollIntervalMs: 0 },
        downloadTelegramVoice,
        send: async (text, opts) => sent.push({ text, opts }), route: async (text) => routed.push(text),
      });
      check(generations === scenario[2], `voice quota: ${target}/${scope} generation count respects proven scope`);
      check(deletes === (target === "upload" ? 0 : 1), "voice quota: owned uploaded files still cleaned up");
      if (scenario[3]) {
        const code = scope === "project" ? "DAILY" : "RATE";
        check(result === "failed" && routed.length === 0 && sent[0].text.includes(`VOICE-429-${code}/${scenario[3]}`) && sent[0].text.includes("9"), "voice quota: phone-readable type, stage and rounded server wait; fallback errors do not hide first quota");
        check(sent[0].opts.replyMarkup.inline_keyboard[0][0].callback_data.startsWith("voice:retry:"), "voice quota: retry ownership flow preserved");
      } else check(result === "routed" && routed.length === 1 && sent.length === 0, "voice quota: model/unknown scope preserves successful fallback");
      const report = logs.join("") + JSON.stringify(sent);
      check(![env.GEMINI_API_KEY, env.TG_TOKEN, "private-subject", "private-model", "private-file"].some((x) => report.includes(x)), "voice quota: no secrets or raw quota fields in logs/messages");
    }
  } finally { global.fetch = originalFetch; console.log = originalLog; console.warn = originalWarn; }
}

// Voice API contract regressions run on Node 20 too (no SQLite required).
{
  const originalFetch = global.fetch, originalLog = console.log, originalWarn = console.warn;
  const env = { GEMINI_API_KEY: "voice-test-secret", GEMINI_VOICE_MODEL: "custom-voice-model" };
  let mode, calls, logs, deleted, interactionPolls;
  const reset = (next) => { mode = next; calls = []; logs = []; deleted = 0; interactionPolls = 0; };
  console.log = console.warn = (...args) => logs.push(JSON.stringify(args));
  global.fetch = async (url, init) => {
    const u = new URL(url);
    check(u.origin === "https://generativelanguage.googleapis.com", "voice contract: only Google is contacted");
    check(!u.search, "voice contract: API key is never in URL");
    check(init.headers["x-goog-api-key"] === env.GEMINI_API_KEY, "voice contract: API key in header");
    if (init.method === "DELETE") { deleted++; return mode === "cleanup-hang" ? new Promise(() => {}) : Response.json({}); }
    if (u.pathname === "/upload/v1beta/files") return Response.json({ file: { name: "files/contract" } });
    if (u.pathname === "/v1beta/files/contract") return Response.json({ state: "ACTIVE", uri: "https://generativelanguage.googleapis.com/v1beta/files/contract" });
    if (u.pathname === "/v1beta/interactions/pending-1") {
      interactionPolls++;
      if (mode === "async-stuck") return Response.json({ id: "pending-1", status: "in_progress" });
      return Response.json({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "سلام دنیا" }] }] });
    }
    const interactions = u.pathname === "/v1beta/interactions";
    check(interactions || /^\/v1beta\/models\/[^/]+:generateContent$/.test(u.pathname), "voice contract: correct API route");
    const body = JSON.parse(init.body);
    calls.push({ path: u.pathname, body });
    check(interactions ? body.model === "gemini-3.5-transcribe" && !("contents" in body)
      : !("input" in body) && !("generation_config" in body), "voice contract: API-specific request fields");
    if ((mode === "404" && calls.length === 1) || (mode === "fallback404" && calls.length <= 2)) return Response.json({ error: { message: env.GEMINI_API_KEY } }, { status: 404 });
    if (mode === "headers-hang") return new Promise(() => {});
    if (mode === "body-hang") return { ok: true, status: 200, json: () => new Promise(() => {}) };
    if (mode === "throw") throw new Error(env.GEMINI_API_KEY);
    if (mode === "legacy") return Response.json({ output_text: "must not route", error: { text: "must not route either" } });
    if (mode === "503" && calls.length === 1) return Response.json({ error: { status: "UNAVAILABLE", message: env.GEMINI_API_KEY } }, { status: 503 });
    if (interactions && ["async", "async-stuck", "queued"].includes(mode)) return Response.json({ id: "pending-1", status: mode === "queued" ? "queued" : "in_progress" });
    if (interactions && ["steps", "steps-blank-legacy", "steps-incomplete"].includes(mode)) return Response.json({
      status: mode === "steps-incomplete" ? "incomplete" : "completed", output_text: " ", outputs: [],
      steps: [null, { type: "user_input", content: [{ type: "text", text: "private user input" }] },
        { type: "thought", content: [{ type: "text", text: "private reasoning" }] },
        { type: "function_result", content: [{ type: "text", text: "private tool result" }] },
        { type: "model_output", content: [null, { type: "audio", text: "private audio field" }, { type: "text", thought: true, text: "private thought" }, { type: "text", text: "سلام " }, { type: "text", text: "دنیا" }] }],
    });
    if (interactions && mode === "steps-error") return Response.json({ status: "completed", steps: [{ type: "model_output", error: { code: 13, message: "private error" }, content: [{ type: "text", text: "must not route" }] }] });
    if (interactions && mode === "steps-thought") return Response.json({ status: "completed", steps: [{ type: "thought", content: [{ type: "text", text: "must not route" }] }] });
    if (interactions && mode === "steps-malformed") return Response.json({ status: "completed", steps: [null, { type: "model_output", content: {} }, { type: "model_output", content: [null, { type: "text", text: 123 }] }] });
    if (interactions && mode === "output-array") return Response.json({ status: "completed", output: [{ type: "thought", text: "private" }, { type: "text", text: "سلام دنیا" }] });
    if (interactions && mode === "blank-top") return Response.json({ output_text: "  ", outputs: [], output: [{ type: "text", text: "سلام دنیا" }] });
    if (interactions && mode === "nested-content") return Response.json({ output: { content: [{ type: "text", text: { value: "سلام دنیا" } }] } });
    if (interactions && mode === "segments") return Response.json({ transcription: { segments: [{ text: "سلام " }, { text: "دنیا" }] } });
    if (interactions && mode === "reasoning-only") return Response.json({ outputs: [{ type: "thought", text: "must not route" }] });
    if (interactions && mode === "success") return Response.json({ status: "completed", outputs: [{ type: "thought", text: "private reasoning" }, { type: "text", text: "سلام دنیا" }] });
    if (interactions && mode === "output-text") return Response.json({ output_text: "سلام دنیا" });
    if (interactions && mode === "output-object") return Response.json({ output: { text: "سلام دنیا" } });
    if (interactions && mode === "pending") return Response.json({ status: "in_progress", output_text: "must not route" });
    if (interactions && mode === "nested-error") return Response.json({ metadata: { text: "must not route" } });
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
      check(!result.ok && result.reason === "transcription", `voice contract: ${failure} is a transcription failure`);
      check(deleted === 1, `voice contract: ${failure} cleans up uploaded file`);
      check(!logs.join("").includes(env.GEMINI_API_KEY), `voice contract: ${failure} never logs secrets`);
    }

    reset("empty");
    await transcribeWithGemini({ ...env, GEMINI_VOICE_MODEL: "gemini-3.8-flash" }, new ArrayBuffer(8), "audio/ogg");
    check(calls.length === 2 && new Set(calls.map((c) => c.path)).size === 2, "voice contract: default model is not retried twice");

    reset("success");
    const current = await transcribeWithGemini({ ...env, GEMINI_VOICE_MODEL: undefined }, new ArrayBuffer(8), "audio/ogg");
    check(current.ok && calls.length === 1 && calls[0].path === "/v1beta/interactions" && calls[0].body.model === "gemini-3.5-transcribe", "voice contract: default restores dedicated 3.5 transcription through Interactions");

    const transcriptionBody = calls[0].body;
    check(transcriptionBody.input[0].uri.endsWith("files/contract") && transcriptionBody.input[0].mime_type === "audio/ogg", "voice contract: Interactions references uploaded audio");
    check(transcriptionBody.generation_config.transcription_config.language_codes[0] === "fa-IR" && transcriptionBody.generation_config.transcription_config.custom_vocabulary.includes("Cloudflare Workers"), "voice contract: original transcription language and vocabulary restored");
    for (const format of ["output-text", "output-object", "output-array", "blank-top", "nested-content", "segments", "steps", "steps-blank-legacy"]) {
      reset(format);
      const result = await transcribeWithGemini({ ...env, GEMINI_VOICE_MODEL: undefined }, new ArrayBuffer(8), "audio/ogg");
      check(result.ok && result.text === "سلام دنیا" && calls.length === 1 && deleted === 1, `voice contract: Interactions ${format} parsed and cleaned up`);
    }
    for (const failure of ["pending", "nested-error", "reasoning-only", "steps-incomplete", "steps-error", "steps-thought", "steps-malformed"]) {
      reset(failure);
      await transcribeWithGemini({ ...env, GEMINI_VOICE_MODEL: undefined }, new ArrayBuffer(8), "audio/ogg");
      check(calls.length > 1, `voice contract: ${failure} not accepted as a transcript`);
      if (failure.startsWith("steps-")) {
        check(logs.some((line) => line.includes('"responseShape"') && line.includes('"hasSteps":true')), "voice schema: unparsed/unsafe steps get content-free response-shape diagnostics");
        check(!logs.join("").includes("must not route") && !logs.join("").includes("private error"), "voice schema: shape diagnostics do not log rejected text or error messages");
      }
    }
    reset("async");
    const completed = await transcribeWithGemini({ ...env, GEMINI_VOICE_MODEL: undefined }, new ArrayBuffer(8), "audio/ogg", { pollIntervalMs: 0 });
    check(completed.ok && completed.text === "سلام دنیا" && calls.length === 1 && interactionPolls === 1 && deleted === 1, "voice regression: pending interaction is polled, not discarded or re-generated");

    reset("queued");
    const queued = await transcribeWithGemini({ ...env, GEMINI_VOICE_MODEL: undefined }, new ArrayBuffer(8), "audio/ogg", { pollIntervalMs: 0 });
    check(queued.ok && queued.text === "سلام دنیا" && calls.length === 1 && interactionPolls === 1, "voice schema: queued interaction is retrieved by GET and completed steps are parsed without another generation");

    reset("async-stuck");
    const pendingLimit = await transcribeWithGemini({ ...env, GEMINI_VOICE_MODEL: undefined }, new ArrayBuffer(8), "audio/ogg", { pollIntervalMs: 0, maxPolls: 2 });
    check(pendingLimit.ok && interactionPolls === 2 && calls.length === 2 && deleted === 1, "voice regression: polling cap is preserved and releases time to Flash fallback");

    reset("cleanup-hang");
    const cleanupStart = Date.now();
    const ready = await transcribeWithGemini(env, new ArrayBuffer(8), "audio/ogg", { cleanupTimeoutMs: 10 });
    check(ready.ok && ready.text === "سلام دنیا" && deleted === 1 && Date.now() - cleanupStart < 1000, "voice regression: stalled cleanup cannot hold a ready transcript");

    // CI Linux runners can pause the event loop for 50-200ms (GC / task
    // scheduling), so the old 150ms deadline sometimes expired before the
    // hanging request was even issued (calls.length stayed 0) or the 1000ms
    // wall-clock ceiling was too tight. Keep the attempt cap above the total
    // budget so the timer fires exactly at the shared deadline, give the
    // upload/poll steps headroom, and use a ceiling well above runner jitter.
    // The test still proves the deadline aborts the hanging body/headers and
    // that no post-deadline fallback call is made.
    for (const hang of ["headers-hang", "body-hang"]) {
      reset(hang);
      const budgetStart = Date.now();
      const limited = await transcribeWithGemini({ ...env, GEMINI_VOICE_MODEL: undefined }, new ArrayBuffer(8), "audio/ogg", { totalTimeoutMs: 600, attemptTimeoutMs: 1000, cleanupTimeoutMs: 5 });
      check(!limited.ok && limited.reason === "timeout" && calls.length === 1 && Date.now() - budgetStart < 2500, `voice regression: shared deadline bounds ${hang}, with no post-deadline fallback`);
    }
    reset("headers-hang");
    const attemptStart = Date.now();
    const attempts = await transcribeWithGemini({ ...env, GEMINI_VOICE_MODEL: undefined }, new ArrayBuffer(8), "audio/ogg", { totalTimeoutMs: 200, attemptTimeoutMs: 10, cleanupTimeoutMs: 5 });
    check(!attempts.ok && calls.length === 3 && deleted === 1 && Date.now() - attemptStart < 1000, "voice regression: hung per-model attempts release time for fallback within shared budget");

    reset("503");
    const unavailable = await transcribeWithGemini({ ...env, GEMINI_VOICE_MODEL: undefined }, new ArrayBuffer(8), "audio/ogg");
    check(unavailable.ok && calls.length === 2 && logs.join("").includes("UNAVAILABLE") && !logs.join("").includes(env.GEMINI_API_KEY), "voice contract: 503 uses fallback and logs only safe API status");

    reset("404");
    const alias = await transcribeWithGemini({ ...env, GEMINI_VOICE_MODEL: undefined }, new ArrayBuffer(8), "audio/ogg");
    check(alias.ok && calls.length === 2 && calls[1].path === "/v1beta/models/gemini-3.8-flash:generateContent", "voice contract: unavailable transcription model uses Flash generateContent fallback");
    check(!calls.some((c) => /gemini-(1\.5|2\.0|2\.5)-/.test(c.path)) && deleted === 1, "voice contract: no old built-in fallbacks; uploaded file cleaned up");

    reset("fallback404");
    const rolling = await transcribeWithGemini({ ...env, GEMINI_VOICE_MODEL: undefined }, new ArrayBuffer(8), "audio/ogg");
    check(rolling.ok && calls.length === 3 && calls[2].path.includes("gemini-flash-latest:"), "voice contract: rolling alias remains final fallback");

    reset("404");
    const retiredOverride = await transcribeWithGemini({ ...env, GEMINI_VOICE_MODEL: "gemini-2.5-flash" }, new ArrayBuffer(8), "audio/ogg");
    check(retiredOverride.ok && calls.length === 2 && calls[1].path.includes("gemini-3.8-flash:"), "voice contract: stale custom 2.5 model recovers using recommended replacement");
  } finally {
    global.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

// Repeated/simultaneous identical audio must not share file lifecycle or state.
{
  const originalFetch = global.fetch, originalLog = console.log, originalWarn = console.warn;
  const env = { GEMINI_API_KEY: "private-repeat-key", TG_TOKEN: "private-repeat-token", STATE: fakeKV() };
  const active = new Set(), removed = new Set(), logs = [];
  let mode = "success", uploaded = 0;
  console.log = console.warn = (...args) => logs.push(JSON.stringify(args));
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]));
    if (u.includes("api.telegram.org")) return Response.json(mode === "download" ? { ok: false, error_code: 403 } : { ok: true, result: { file_path: "voice/same.ogg" } });
    const path = new URL(u).pathname;
    if (init.method === "DELETE") {
      check(active.has(path), "voice repeat: cleanup deletes only this request's uploaded file");
      active.delete(path); removed.add(path);
      return Response.json({});
    }
    if (path.includes("/upload/")) {
      if (mode === "upload429") return Response.json({ error: { status: "RESOURCE_EXHAUSTED", message: env.GEMINI_API_KEY } }, { status: 429 });
      const name = `files/repeat-${++uploaded}`;
      active.add(`/v1beta/${name}`);
      return Response.json({ file: { name } });
    }
    if (path.startsWith("/v1beta/files/")) {
      if (mode === "poll503") return Response.json({ error: { status: "UNAVAILABLE", message: env.GEMINI_API_KEY } }, { status: 503 });
      return Response.json({ state: "ACTIVE", uri: `https://example/audio/${path.split("/").at(-1)}` });
    }
    if (mode === "auth403") return Response.json({ error: { status: "PERMISSION_DENIED", message: env.GEMINI_API_KEY } }, { status: 403 });
    if (mode === "timeout") return new Promise(() => {});
    if (path === "/v1beta/interactions") {
      const { input } = JSON.parse(init.body);
      const file = input[0].uri.split("/").at(-1);
      check(active.has(`/v1beta/files/${file}`), "voice repeat: audio still exists while transcribing");
      return Response.json({ status: "completed", output_text: "same transcript" });
    }
    throw new Error("Unexpected voice test request");
  };
  const run = (transcribeOpts) => {
    const sent = [], routed = [];
    return handleVoice(env, { userId: 42, chatId: 42, transcribeOpts,
      voice: { file_id: "same-file-id", duration: 2, mime_type: "audio/ogg" },
      downloadTelegramVoice,
      send: async (text, opts) => sent.push({ text, opts }), route: async (text) => routed.push(text),
    }).then((result) => ({ result, sent, routed }));
  };
  try {
    for (let i = 0; i < 5; i++) {
      const r = await run();
      check(r.result === "routed" && r.routed[0] === "same transcript" && r.sent.length === 0, `voice repeat: identical recording succeeds on turn ${i + 1}`);
    }
    const concurrent = await Promise.all([run(), run(), run(), run()]);
    check(concurrent.every((r) => r.result === "routed") && active.size === 0 && removed.size === 9, "voice repeat: concurrent requests have independent upload/delete lifecycles");
    for (const [failure, code, stage] of [["download", "VOICE-DOWNLOAD", "telegram-info"], ["upload429", "VOICE-429", "upload"], ["poll503", "VOICE-SERVICE", "file-poll"], ["auth403", "VOICE-AUTH", "interaction"]]) {
      mode = failure;
      const r = await run();
      check(r.result === "failed" && r.routed.length === 0 && r.sent.length === 1 && r.sent[0].text.includes(code), `voice diagnostic: ${failure} has an actionable phone-readable message`);
      check(logs.some((l) => l.includes('"stage":"' + stage + '"')), `voice diagnostic: ${failure} reports the exact failing stage`);
      check(r.sent[0].opts?.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("voice:retry:"), "voice diagnostic: failure keeps the existing retry action");
      mode = "success";
      check((await run()).result === "routed", `voice repeat: ${failure} does not poison the next request`);
    }
    check(active.size === 0, "voice repeat: recoverable failures clean up their own files");
    mode = "timeout";
    const timeout = await run({ totalTimeoutMs: 30, attemptTimeoutMs: 1000 });
    check(timeout.result === "failed" && timeout.sent.length === 1 && timeout.sent[0].text.includes("VOICE-TIMEOUT"), "voice diagnostic: local timeout is not mislabeled as unintelligible audio");
    // Deadline-exhausted cleanup is best effort, so this timed-out file may remain.

    const report = logs.join("");
    check(!report.includes(env.GEMINI_API_KEY) && !report.includes(env.TG_TOKEN) && !report.includes("same transcript") && !report.includes("same-file-id"), "voice diagnostic: no keys, bot tokens, transcript, or Telegram file IDs logged");
  } finally {
    global.fetch = originalFetch; console.log = originalLog; console.warn = originalWarn;
  }
}

// ── Voice input v1: Telegram voice -> Gemini generateContent -> plain-text path ──
if (DatabaseSync) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
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
        if (u.includes(":generateContent") || u.includes("/v1beta/interactions")) {
          if (opts.failGeneration) throw new Error("boom");
          generationBody = JSON.parse(init.body);
          return { ok: true, json: async () => u.includes("/v1beta/interactions")
            ? { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: transcript }] }] }
            : { candidates: [{ content: { parts: [{ text: transcript }] }, finishReason: "STOP" }] } };
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
    check(r.ok === true && r.text === "سلام دنیا" && body?.model === "gemini-3.5-transcribe" && body?.generation_config?.transcription_config?.language_codes?.[0] === "fa-IR" && body?.generation_config?.transcription_config?.custom_vocabulary?.includes("Cloudflare Workers") && body?.input?.[0]?.mime_type === "audio/ogg" && m.deleted() === true, "voice: dedicated transcribe returns text, Persian + vocab, uploaded file deleted");
  }
  {
    const env = mkEnv(), s = fakeSend(); const m = mockVoiceFetch("یادداشت کن فردا جلسه دارم");
    const r = await handleVoice(env, { userId: 4242, chatId: 4242, voice: voice(), downloadTelegramVoice, send: s.send, route: async (t) => { await handleDailyText(env, o(env, 4242, t, { ...s, nowMs: NOW, source: "voice" })); } });
    check(r === "routed" && rows("SELECT COUNT(*) AS n FROM notes WHERE user_id = 4242")[0].n === 1 && rows("SELECT text, source FROM notes WHERE user_id = 4242")[0].text === "فردا جلسه دارم" && rows("SELECT source FROM notes WHERE user_id = 4242")[0].source === "voice", "voice: transcript -> note stored with voice source");
  }
  {
    const env = mkEnv(), s = fakeSend(); mockVoiceFetch("خرج کردم ۵۰۰ تومان نان");
    const r = await handleVoice(env, { userId: 4242, chatId: 4242, voice: voice(), downloadTelegramVoice, send: s.send, route: async (t) => { await handleDailyText(env, o(env, 4242, t, { ...s, nowMs: NOW, source: "voice" })); } });
    check(r === "routed" && lastText(s).includes("تأیید می‌کنی؟") && rows("SELECT COUNT(*) AS n FROM expenses")[0].n === 0, "voice: transcript -> expense confirm, no row before Confirm");
  }
  {
    const env = mkEnv(), s = fakeSend(); let routed = false; mockVoiceFetch("");
    const r = await handleVoice(env, { userId: 4243, chatId: 4243, voice: voice(), downloadTelegramVoice, send: s.send, route: async () => { routed = true; } });
    check(r === "failed" && routed === false && lastText(s) === VOICE_FAILED_TEXT && rows("SELECT COUNT(*) AS n FROM notes WHERE user_id = 4243")[0].n === 0, "voice: empty transcript -> resend reply, nothing stored");
  }
  {
    const env = mkEnv(), s = fakeSend(); let routed = false; mockVoiceFetch("سلام", { failGeneration: true });
    const r = await handleVoice(env, { userId: 4242, chatId: 4242, voice: voice(), downloadTelegramVoice, send: s.send, route: async () => { routed = true; } });
    check(r === "failed" && routed === false && lastText(s) === VOICE_FAILED_TEXT, "voice: google failure -> fallback reply, nothing routed");
  }
  {
    const env = mkEnv({ GEMINI_API_KEY: undefined }), s = fakeSend(); let routed = false; const m = mockVoiceFetch("سلام");
    const r = await handleVoice(env, { userId: 4242, chatId: 4242, voice: voice(), downloadTelegramVoice, send: s.send, route: async () => { routed = true; } });
    check(r === "failed" && routed === false && m.googleCalls() === 0 && lastText(s) === VOICE_FAILED_TEXT, "voice: missing key -> fallback reply, zero google fetches");
  }
  {
    const env = mkEnv(), s = fakeSend(); let routed = false; const m = mockVoiceFetch("سلام");
    const r = await handleVoice(env, { userId: 4242, chatId: 4242, voice: voice(601), downloadTelegramVoice, send: s.send, route: async () => { routed = true; } });
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
    const r = await handleVoice(env, { userId: 4242, chatId: 4242, voice: voice(), downloadTelegramVoice, send: s.send, route: async () => {} });
    const retryBtn = (s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []).find((d) => d.startsWith("voice:retry:"));
    check(r === "failed" && !!retryBtn, "0-b3 voice: failure message carries a Retry button");
    const stashId = retryBtn.slice("voice:retry:".length);
    const sF = fakeSend();
    const rF = await handleVoiceRetry(env, { userId: 4243, stashId, downloadTelegramVoice, send: sF.send, route: async () => {}, editMarkup: async () => {} });
    check(rF === "forbidden" && sF.sent.length === 0, "0-b3 voice: Retry by another user is silent");
    mockVoiceFetch("یادداشت کن جلسه تازه");
    const r2 = await handleVoiceRetry(env, { userId: 4242, stashId, downloadTelegramVoice, send: s.send, route: async (t) => { await handleDailyText(env, o(env, 4242, t, { ...s, nowMs: NOW, source: "voice" })); }, editMarkup: async () => {} });
    check(r2 === "routed" && rows("SELECT COUNT(*) AS n FROM notes WHERE text = 'جلسه تازه' AND source = 'voice'")[0].n === 1, "0-b3 voice: Retry re-transcribes and enters the normal path");
    const s2 = fakeSend();
    const r3 = await handleVoiceRetry(env, { userId: 4242, stashId, downloadTelegramVoice, send: s2.send, route: async () => {}, editMarkup: async () => {} });
    check(r3 === "missing" && s2.sent.length === 1 && s2.sent[0].text === VOICE_FAILED_TEXT, "0-b3 voice: consumed stash yields the clear resend message");
  }
  // 0-b3 fix: a retry that fails again still offers a usable Retry button.
  {
    const env = mkEnv(), s = fakeSend(); mockVoiceFetch("سلام", { failGeneration: true });
    await handleVoice(env, { userId: 4242, chatId: 4242, voice: voice(), downloadTelegramVoice, send: s.send, route: async () => {} });
    const retryBtn = (s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []).find((d) => d.startsWith("voice:retry:"));
    const stashId = retryBtn.slice("voice:retry:".length);
    const s2 = fakeSend();
    const r2 = await handleVoiceRetry(env, { userId: 4242, stashId, downloadTelegramVoice, send: s2.send, route: async () => {}, editMarkup: async () => {} });
    const retryBtn2 = (s2.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []).find((d) => d.startsWith("voice:retry:"));
    check(r2 === "failed" && retryBtn2 === `voice:retry:${stashId}` && (await env.STATE.get(`voice:stash:${stashId}`, "json")) !== null, "0-b3 fix: transcription-failing retry yields a usable Retry button, stash kept");
    mockVoiceFetch("یادداشت کن جلسه دوباره");
    const r3 = await handleVoiceRetry(env, { userId: 4242, stashId, downloadTelegramVoice, send: s.send, route: async (t) => { await handleDailyText(env, o(env, 4242, t, { ...s, nowMs: NOW, source: "voice" })); }, editMarkup: async () => {} });
    check(r3 === "routed" && rows("SELECT COUNT(*) AS n FROM notes WHERE text = 'جلسه دوباره' AND source = 'voice'")[0].n === 1, "0-b3 fix: retry succeeds after a failed retry");
  }
  {
    // Same for a download-failing retry.
    const env = mkEnv(), s = fakeSend(); mockVoiceFetch("سلام", { failGetFile: true });
    await handleVoice(env, { userId: 4242, chatId: 4242, voice: voice(), downloadTelegramVoice, send: s.send, route: async () => {} });
    const retryBtn = (s.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []).find((d) => d.startsWith("voice:retry:"));
    const stashId = retryBtn.slice("voice:retry:".length);
    const s2 = fakeSend();
    const r2 = await handleVoiceRetry(env, { userId: 4242, stashId, downloadTelegramVoice, send: s2.send, route: async () => {}, editMarkup: async () => {} });
    const retryBtn2 = (s2.sent.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []).find((d) => d.startsWith("voice:retry:"));
    check(r2 === "failed" && retryBtn2 === `voice:retry:${stashId}` && (await env.STATE.get(`voice:stash:${stashId}`, "json")) !== null, "0-b3 fix: download-failing retry yields a usable Retry button, stash kept");
  }
  {
    const env = mkEnv(), s = fakeSend(); const m = mockVoiceFetch("سلام"); const v = voice();
    const calls = [];
    const fakeDownload = async (...args) => { calls.push(args); return { ok: false, failure: { stage: "telegram-download", status: 500, apiStatus: null, kind: "http" } }; };
    const r = await handleVoice(env, { userId: 4242, chatId: 4242, voice: v, downloadTelegramVoice: fakeDownload, send: s.send, route: async () => {} });
    check(r === "failed" && calls.length === 1 && calls[0][0] === env && calls[0][1] === v.file_id && m.googleCalls() === 0 && lastText(s).includes("VOICE-DOWNLOAD"), "F1 voice: injected downloader is used once, skill never touches Telegram");
  }
  {
    const env = mkEnv(), initial = fakeSend(), m = mockVoiceFetch("سلام"); let routed = 0, downloadCalls = 0;
    const downloadFailure = async () => { downloadCalls++; return { ok: false, failure: { stage: "telegram-download", status: 503, apiStatus: null, kind: "http" } }; };
    await handleVoice(env, { userId: 4242, chatId: 4242, voice: voice(), downloadTelegramVoice: downloadFailure, send: initial.send, route: async () => { routed++; } });
    const retryButton = initial.sent[0]?.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data;
    const stashId = retryButton?.slice("voice:retry:".length), retry = fakeSend();
    const result = await handleVoiceRetry(env, { userId: 4242, stashId, downloadTelegramVoice: downloadFailure, send: retry.send, route: async () => { routed++; }, editMarkup: async () => {} });
    check(result === "failed" && downloadCalls === 2 && routed === 0 && m.googleCalls() === 0 && retry.sent[0]?.text.includes("VOICE-DOWNLOAD") && !retry.sent[0]?.text.includes(env.TG_TOKEN) && retry.sent[0]?.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data === `voice:retry:${stashId}` && await env.STATE.get(`voice:stash:${stashId}`, "json") !== null, "F1 voice retry: injected download failure stays retryable, hides token, and never transcribes or routes");
  }
  {
    const oldFetch = global.fetch, oldWarn = console.warn, warnings = [];
    const runDownload = async (fetchImpl) => {
      global.fetch = fetchImpl;
      console.warn = (...args) => warnings.push(args);
      try { return await downloadTelegramVoice({ TG_TOKEN: "private-bot-token" }, "private-file-id"); }
      finally { global.fetch = oldFetch; console.warn = oldWarn; }
    };
    for (const fetchImpl of [
      async () => Response.json({ ok: true, result: {} }),
      async () => Response.json({ ok: true, result: { file_path: "" } }),
      async () => ({ json: async () => { throw new Error("invalid response body"); } }),
    ]) {
      const result = await runDownload(fetchImpl);
      check(result.ok === false && result.failure.stage === "telegram-info" && result.failure.kind === "telegram" && result.failure.status === null, "F1 transport: missing or malformed getFile response fails at telegram-info");
      check(warnings.at(-1)?.[0] === "voice_stage_fail" && JSON.stringify(warnings.at(-1)?.[1]) === JSON.stringify(result.failure), "F1 transport: Telegram-info failure preserves the warning structure");
    }
    const httpFailure = await runDownload(async (url) => String(url).includes("/getFile") ? Response.json({ ok: true, result: { file_path: "voice/file.ogg" } }) : new Response("failed", { status: 503 }));
    check(httpFailure.ok === false && JSON.stringify(httpFailure.failure) === JSON.stringify({ stage: "telegram-download", status: 503, apiStatus: null, kind: "http" }) && warnings.at(-1)?.[0] === "voice_stage_fail" && JSON.stringify(warnings.at(-1)?.[1]) === JSON.stringify(httpFailure.failure), "F1 transport: download HTTP failure preserves stage, status, kind, and warning structure");
    const networkFailure = await runDownload(async (url) => { throw new Error(`request failed for ${url}`); });
    const downloadNetworkFailure = await runDownload(async (url) => String(url).includes("/getFile") ? Response.json({ ok: true, result: { file_path: "voice/file.ogg" } }) : Promise.reject(new Error(`request failed for ${url}`)));
    check(networkFailure.ok === false && networkFailure.failure.stage === "telegram-info" && networkFailure.failure.status === null && networkFailure.failure.kind === "network" && downloadNetworkFailure.failure.stage === "telegram-download" && downloadNetworkFailure.failure.kind === "network", "F1 transport: rejected getFile and download fetches are classified as network failures");
    const warning = warnings.at(-1);
    check(warning?.[0] === "voice_stage_fail" && JSON.stringify(warning?.[1]) === JSON.stringify(downloadNetworkFailure.failure) && !JSON.stringify(warnings).includes("private-bot-token") && !JSON.stringify(warnings).includes("private-file-id") && !JSON.stringify(warnings).includes("request failed"), "F1 transport: warning contract is structured and excludes token, file id, and raw transport details");
  }
  {
    const oldTimeout = AbortSignal.timeout, oldFetch = global.fetch, oldWarn = console.warn, timeouts = [];
    const warnings = [];
    try {
      AbortSignal.timeout = (ms) => { timeouts.push(ms); return { timeoutMs: ms }; };
      console.warn = (...args) => warnings.push(args);
      global.fetch = async (_url, init) => { throw new Error(`timeout ${init.signal.timeoutMs}`); };
      const infoTimeout = await downloadTelegramVoice({ TG_TOKEN: "private-bot-token" }, "private-file-id");
      global.fetch = async (url, init) => String(url).includes("/getFile")
        ? Response.json({ ok: true, result: { file_path: "voice/file.ogg" } })
        : Promise.reject(new Error(`timeout ${init.signal.timeoutMs}`));
      const fileTimeout = await downloadTelegramVoice({ TG_TOKEN: "private-bot-token" }, "private-file-id");
      check(JSON.stringify(timeouts) === JSON.stringify([10000, 10000, 20000]) && infoTimeout.failure.stage === "telegram-info" && fileTimeout.failure.stage === "telegram-download" && infoTimeout.failure.kind === "network" && fileTimeout.failure.kind === "network", "F1 transport: deterministic timeout mocks preserve 10s getFile and 20s download timeouts and failure stages");
      check(!JSON.stringify(warnings).includes("private-bot-token") && !JSON.stringify(warnings).includes("timeout 10000") && !JSON.stringify(warnings).includes("timeout 20000"), "F1 transport: timeout warnings omit credentials and raw transport errors");
    } finally { AbortSignal.timeout = oldTimeout; global.fetch = oldFetch; console.warn = oldWarn; }
  }
  {
    const readDir = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const item = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
      return entry.isDirectory() ? readDir(item) : [item];
    });
    const mediaFiles = readDir(new URL("../../src/skills/media/", import.meta.url));
    const transportPattern = /api\.telegram\.org|\/file\/bot|TG_TOKEN/;
    check(mediaFiles.length > 0 && mediaFiles.every((file) => !transportPattern.test(fs.readFileSync(file, "utf8"))), "F1 boundary: entire media skills scope contains no Telegram transport or TG_TOKEN access");
  }
  global.fetch = origFetch;
}

}
