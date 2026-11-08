// Step 1b-2: everyday wiring (money, notes, reminders, translate,
// remember, queries, file reference + file branch). Pure classifier in
// daily.js; side effects here. D1 failures never throw.
import { classifyDaily, parseExpense, parseReminder, normalizeText, formatJalali, sumByCurrency, iranDate, weekRange, monthRange, resolveHourAmbiguousFollowup, mergeHourAmbiguousFollowup, hasDaypartReply, normalizeDaypartToken, extractFolderTag, matchKnownProjectAt, IRAN_OFFSET_MIN } from "./daily.js";
import { classifyDailyWithModel, classifyIntent, freeTextDevSuggestion, MODEL_INTENT_COMBO, resolveInterpreterModel, recoverFullNoteBody } from "./intent.js";
import { saveMessage, finalizeMessageKind, redactMessageContent, listProjectsResult, listOpenTasksResult, listDoneTasksResult, getTask, getProject, getMessageRow, insertTask, insertProject, listNotesResult, deleteNote, setTaskStatus, updateTaskFields, addProjectAlias, insertIntentFeedback, runDbBatch, claimDueReminders, releaseReminderClaim, snoozeTaskReminder, purgeOldClosedTasks, saveVaultItem, listVaultItems, getVaultItem, saveVaultFile, listVaultFiles, getVaultFile, resolvePendingVaultFile, setFileSyncStatus, setVaultSyncStatus, upsertUserFact } from "./db.js";
import { buildInterpreterPrompt, interpretText, parseInterpreterOutput, validateInterpreterAction } from "./interpreter.js";
import { getDefaultCurrency, setSetting } from "./memory.js";
import { tgApi, sendProgressMessage, sendDocument, sendPhoto, getFileDownloadData, escapeHtml, formatTelegramHtml } from "./telegram.js";
import { encryptVaultValue, decryptVaultValue, syncVaultItemToGoogle, syncVaultFileToGoogle } from "./vault.js";
import { parseImageGenCommand, generateFreeImage } from "./media.js";

export const CHAT_CONTEXT_CHAR_LIMIT = 8000;
export const DAILY_CHAT_PROMPT = "هرگز دستورهای اسلش جعلی مثل /یادداشت، /تسکم، یا /اضافه کردن هزینه به کاربر پیشنهاد نده. کاربر برای ثبت موارد فقط کافی است با زبان طبیعی بنویسد یا ویس بدهد (مثلاً: «یادداشت کن فردا جلسه دارم» یا «امروز ۲۰۰ تومن نون خریدم» یا «خرجای امروز»).";
const DRAFT_TTL_SEC = 600;
const EXPIRED_TEXT = "قبلاً ثبت شد یا مهلتش گذشته";
const NOT_SAVED_TEXT = "ذخیره نشد، دوباره تلاش کن";
const VAULT_PRIVATE_ONLY_TEXT = "🔒 عملیات گاوصندوق فقط در چت خصوصی مجاز است.";
const VAULT_REDACTED_TEXT = "[🔒 محتوای حساس گاوصندوق]";
const MEMORY_SAVED_TEXT = "🧠 به خاطر سپرده شد";
const UNSUPPORTED_ACTION_TEXT = "در حال حاضر ابزار اتصال و ارسال مستقیم ایمیل فعال نیست؛ چیزی ارسال نشد. اگر بخواهی می‌توانم متنش را به‌عنوان یادداشت یا کار ذخیره کنم.";
const iranIso = (ms) => new Date((ms ?? Date.now()) + IRAN_OFFSET_MIN * 60000).toISOString().replace(/Z$/, "+03:30");

export function mapQuestion(q) { return q === "ambiguous" ? "amount" : q; } // TODO from 1b-1, resolved here
export function askText(q) {
  return { amount: "مبلغ چقدر بود؟", decimal: "مبلغ اعشاری در این قدم پذیرفته نیست؛ مبلغ را به عدد صحیح بگو.", period: "برای کدام دوره؟ امروز، دیروز، این هفته یا این ماه؟", date: "تاریخ را درست بگو؛ آن تاریخ معتبر نیست.", "hour-ambiguous": "ساعت را با صبح یا عصر مشخص کن.", "no-time": "ساعت یادآوری را بگو.", past: "آن زمان گذشته است؛ زمان آینده را بگو.", empty: "یادآوری برای چه کاری؟", text: "چه متنی را ترجمه کنم؟", "expense-or-chat": "این خرج است یا چت؟", "expense-or-income": "این خرج است یا درآمد؟", "note-text": "چه چیزی را یادداشت کنم؟", language: "به چه زبانی؟" }[q] ?? "دوباره بگو؟";
}

// Chat context: last 50 rows plus the 8,000-char cap, oldest dropped first.
// Phase 1-e Pillar 3: anti-hallucination filter — historical assistant
// turns that START with a fake confirmation header are skipped, so a
// hallucinated "stored" message can never be quoted back as fact by a
// later chat turn (the live 2026-11-03 case: an old fake ✅ note header
// was repeated to the user as if it had been stored).
// A04: `excludeMessageId` drops the in-flight user row (already appended by
// the caller) so it is sent to the model exactly once. An oversized single
// turn is truncated instead of clearing all older history.
export function buildChatContext(rows, opts = {}) {
  const headerRaw = typeof opts === "string" ? opts : opts && typeof opts === "object" ? (opts.memoryHeader ?? opts.userMemoryHeader ?? opts.header ?? opts.memory ?? null) : null;
  const memoryHeader = typeof headerRaw === "string" && headerRaw.trim() ? headerRaw.trim() : "";
  const excludeId = opts && opts.excludeMessageId != null ? Number(opts.excludeMessageId) : null;
  const msgs = (rows || []).filter((r) => r && typeof r.content === "string" && r.content && (excludeId === null || Number(r.id) !== excludeId)).slice(-50);
  const kept = []; let total = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant" && (/^✅\s*\*\*یادداشت جدید/.test(msgs[i].content) || /^✅\s*(?:یادداشت|تسک|هزینه)/.test(msgs[i].content) || /^⏰\s*یادآوری/.test(msgs[i].content))) continue;
    const remaining = CHAT_CONTEXT_CHAR_LIMIT - total;
    if (remaining <= 0) break;
    let content = msgs[i].content;
    if (content.length > remaining) {
      const cap = Math.min(2000, remaining);
      if (cap <= 3) break;
      content = content.slice(0, cap - 3) + "...";
    }
    kept.push({ role: msgs[i].role === "assistant" ? "assistant" : "user", content }); total += content.length;
  }
  const result = kept.reverse();
  if (memoryHeader) result.unshift({ role: "system", content: memoryHeader });
  return result;
}

function dbOf(env) { const db = env && env.DB; return db && typeof db.prepare === "function" ? db : null; }
async function runDb(env, sql, params) { const db = dbOf(env); if (!db) return { ok: false }; try { await db.prepare(sql).bind(...params).run(); return { ok: true }; } catch { return { ok: false }; } }
async function allDb(env, sql, params) { const db = dbOf(env); if (!db) return []; try { const res = await db.prepare(sql).bind(...params).all(); return Array.isArray(res?.results) ? res.results : []; } catch { return []; } }
// Single-row read that distinguishes "no row" from "query failed".
async function firstDb(env, sql, params) { const db = dbOf(env); if (!db) return { ok: false, row: null }; try { const res = await db.prepare(sql).bind(...params).first(); return { ok: true, row: res ?? null }; } catch { return { ok: false, row: null }; } }
async function queryExpenseSums(env, userId, range) { return sumByCurrency(await allDb(env, "SELECT amount, currency_code FROM expenses WHERE user_id = ? AND type = 'expense' AND date BETWEEN ? AND ?", [userId, range.start, range.end])); }
async function recentMessages(env, userId, limit = 10) { return allDb(env, "SELECT role, content, kind, tg_file_id, file_name, file_mime FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?", [userId, limit]); }

// User row: allow-list FIRST (callers guarantee it), then INSERT OR IGNORE.
export async function ensureUserRow(env, userId) { const id = Number(userId); if (!Number.isFinite(id)) return { ok: false }; return runDb(env, "INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)", [id, String(id)]); }

// Keys carry only the short id; owner is checked after load (forbidden = silent, not expired).
function draftKey(id) { return `daily:draft:${id}`; }
function askKey(id) { return `daily:ask:${id}`; }
// Pending-ask slot (Part 3): ONE slot per user, 600s TTL like money drafts.
// {question, askId?, kind?, pendingBody?}: question is always the bot's own
// ask text; askId points at the existing daily:ask record. Part 3b adds kind
// (a stable identifier like "note-text", never a Persian-text comparison) and
// pendingBody (a body already known while a language ask is pending).
function pendingKey(id) { return `daily:pending-ask:${id}`; }
// Correction pointer (0-b3): last created item, 10-minute TTL via putKv.
// {table: "notes"|"expenses", id}: only tables that exist pre-0003.
function correctionKey(id) { return `interp:last-item:${id}`; }
async function setPendingAsk(env, userId, question, askId, kind, pendingBody) {
  const value = { question };
  if (askId) value.askId = askId;
  if (kind) value.kind = kind;
  if (pendingBody) value.pendingBody = pendingBody;
  await putKv(env, pendingKey(userId), value);
}
// Language-name mapper for deterministic language-slot answers (en/fa/ar
// only, the pre-existing everyday target restriction — "German" re-asks).
function parseLanguageAnswer(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(/^به\s+/u, "").replace(/[؟?!.،,:：\s]+$/u, "");
  if (["en", "english", "انگلیسی", "انگليسي"].includes(t)) return "en";
  if (["fa", "persian", "farsi", "فارسی", "فارسي"].includes(t)) return "fa";
  if (["ar", "arabic", "عربی", "عربي"].includes(t)) return "ar";
  return null;
}

// Slot kind, with a defensive fallback for slots built without one (Part 3
// slots): button slots by askId, otherwise reverse the ask text to its key.
function slotKind(slot) {
  if (!slot || typeof slot !== "object") return "other";
  if (slot.kind) return slot.kind;
  if (slot.askId) return "button";
  for (const key of ["amount", "decimal", "period", "date", "hour-ambiguous", "no-time", "past", "empty", "text", "expense-or-chat", "expense-or-income", "note-text", "language"]) {
    if (slot.question === askText(key)) return key === "text" ? "translate-text" : key;
  }
  return "other";
}
// Slots whose question must survive a skipped/failed model call: dropping
// them would lose the question (Part 3b deviation from the generic skip rule).
function isBodySlot(slot) { return ["note-text", "translate-text", "language"].includes(slotKind(slot)); }
// Rule ask key -> slot kind ("text" is the translate-body ask).
function kindForAskKey(key) { return key === "text" ? "translate-text" : key; }
async function getPendingAsk(env, userId) { return getKv(env, pendingKey(userId)); }
async function clearPendingAsk(env, userId) { await delKv(env, pendingKey(userId)); }
function askKeyboard(question, id) {
  return question === "expense-or-chat"
    ? [[{ text: "💰 خرج", callback_data: `daily:ask:${id}:expense` }, { text: "💬 چت", callback_data: `daily:ask:${id}:chat` }]]
    : [[{ text: "💸 خرج", callback_data: `money:dir:spend:${id}` }, { text: "💰 درآمد", callback_data: `money:dir:income:${id}` }]];
}
// Phase 1-e Pillar 3: 1-tap disambiguation for hour-ambiguous asks.
// Attached EVERY time the bot sends "ساعت را با صبح یا عصر مشخص کن."
// (rule ask, discharge re-ask, NLU reminder ask, short-token hold), so
// the user never has to type a daypart. Handled by resolveAskCallback.
export function hourAmbiguousKeyboard() {
  return [[{ text: "☀️ صبح", callback_data: "ask:dp:صبح" }, { text: "🌇 عصر", callback_data: "ask:dp:عصر" }], [{ text: "❌ انصراف", callback_data: "ask:cancel" }]];
}
async function sendHourAmbiguousAsk(o) {
  await o.send(askText("hour-ambiguous"), { replyMarkup: { inline_keyboard: hourAmbiguousKeyboard() } });
}
// 1-d-1: 1-tap quick-convert buttons for chat replies. The callback
// handlers (qconv:note:<msgId> / qconv:task:<msgId>) land in 1-d-5;
// messageId is the saved user message row id (o.entryMessageId), never
// user text, so the tap saves exactly that stored message.
export function quickConvertKeyboard(messageId) {
  return [[{ text: "📝 ذخیره یادداشت", callback_data: `qconv:note:${messageId}` }, { text: "☑️ ثبت تسک", callback_data: `qconv:task:${messageId}` }]];
}
// 1-d-5: pure stage failure notice. label names the failed stage
// ("chat" or "summary stage"); detail carries the model error when known.
// retryEntryId -> a chat:retry button; retryData -> a raw callback_data
// retry (the sum re-tap); quickConvertId -> the quick-convert row. No ids
// -> text only, so a notice is never dropped silently for lack of buttons.
export function chatFailureNotice(label, detail, opts = {}) {
  const text = `❌ مرحله‌ی ${label} شکست خورد.${detail ? `\n${detail}` : ""}`;
  const keyboard = [];
  if (opts.retryEntryId) keyboard.push([{ text: "🔄 تلاش دوباره", callback_data: `chat:retry:${opts.retryEntryId}` }]);
  if (opts.retryData) keyboard.push([{ text: "🔄 تلاش دوباره", callback_data: opts.retryData }]);
  if (opts.quickConvertId) keyboard.push(...quickConvertKeyboard(opts.quickConvertId));
  return { text, replyMarkup: keyboard.length ? { inline_keyboard: keyboard } : undefined };
}
// Phase 2-d: compact failure detail for the chat path (answerChatText).
// Line 1 of the notice itself stays the stage line (chatFailureNotice
// adds it); this detail is: a Persian count line, at most the first 3
// target: status lines, and a (+N مورد دیگر) overflow line. A 7-target
// failure therefore never dumps a wall of raw model:status lines.
export function formatFailureDetail(lines) {
  const arr = (lines ?? []).filter((l) => String(l ?? "").trim() !== "");
  if (!arr.length) return "";
  const parts = [`تعداد مدل‌های بررسی‌شده: ${arr.length}`, ...arr.slice(0, 3)];
  if (arr.length > 3) parts.push(`(+${arr.length - 3} مورد دیگر)`);
  return parts.join("\n");
}
// Phase 2-d: a leading "." (or ":" / "-") left by a folder-strip or a
// "یادداشت: . ..." form must never reach storage or the list render.
// E.g. "یادداشت توی پروژه عمومی: . یه قابلیت" re-classifies to a body
// starting with ". ", which used to render as "[📁 عمومی] . یه قابلیت...".
export function stripLeadingNotePunct(text) {
  // Leading run only: the directive is a stray leading ". "/" : "/" -".
  // No trailing trim — a note body must be stored byte-identical apart
  // from that leading run (a trailing space is user content).
  return String(text ?? "").replace(/^[\s.·:؛،\-–—()[\]]+/u, "");
}

// Phase 3-A: the note list is a scannable index, not a transcript.
// Derive a one-line title from the first meaningful line and cap it on
// a word boundary so a long note never turns the list into a wall.
export function deriveNoteTitle(text, maxLen = 60) {
  const first = String(text ?? "").split(/\r?\n/).find((line) => stripLeadingNotePunct(line).trim()) ?? "";
  const s = stripLeadingNotePunct(first).replace(/\s+/g, " ").trim();
  if (!s) return "بدون عنوان";
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > Math.floor(maxLen * 0.6) ? cut.slice(0, sp) : cut).trimEnd()}…`;
}
// Phase 2-d: chunk a flat button list into rows of at most n (Telegram
// keyboards with one unbounded row overflow; one row per item towers).
function chunkButtons(buttons, n) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += n) rows.push(buttons.slice(i, i + n));
  return rows;
}
function newId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
async function putKv(env, key, value) { if (!env.STATE) return; try { await env.STATE.put(key, JSON.stringify(value), { expirationTtl: DRAFT_TTL_SEC }); } catch {} }
async function getKv(env, key) { if (!env.STATE) return null; try { const raw = await env.STATE.get(key, "json"); return raw && typeof raw === "object" ? raw : null; } catch { return null; } }
async function delKv(env, key) { if (!env.STATE) return; try { await env.STATE.delete(key); } catch {} }

// Money always needs confirmation: draft in KV, buttons carry only the short draft id (< 64 bytes).
export async function startConfirm(env, o, type, ex) {
  const id = newId();
  await putKv(env, draftKey(id), { owner: o.userId, type, ...ex });
  const jalali = formatJalali(ex.date) || ex.date;
  await o.send(`💰 ${type === "income" ? "درآمد" : "خرج"}: ${ex.amount} ${ex.currency}${ex.item ? ` — ${ex.item}` : ""} — ${jalali}\nتأیید می‌کنی؟`, { replyMarkup: { inline_keyboard: [[{ text: "✅ تأیید", callback_data: `daily:confirm:${id}` }, { text: "❌ لغو", callback_data: `daily:cancel:${id}` }]] } });
  return id;
}

// Confirm: insert FIRST, delete the KV draft ONLY after success. A draft
// carrying corrects:{table,id} (0-b3 correction) is strictly an UPDATE: a
// missing target returns "missing" and a read/update failure "failed" —
// it must never fall through to INSERT (a deleted target must not
// silently become a new expense). A draft carrying noteId (change-type)
// deletes that note row after the expense insert, and reports failure
// (draft kept for retry) if the delete fails. Returns the expense row id
// for the correction pointer.
// Phase 1-b-3 (amendment 6): task -> expense Confirm. Pre-check first
// (D1 failure -> failed, draft kept; foreign/missing/not-open -> missing,
// draft kept, NOTHING inserted), then ONE db.batch() unit: expense INSERT
// OR IGNORE on draft_id first, conditional task delete second. Batch
// success alone proves nothing about the second write (a zero-row
// conditional UPDATE is not a batch error), so post-batch reading is
// mandatory on every path, including a thrown batch (assume nothing
// landed, re-read, apply the same branches):
//  - stmt2 changes===1 -> full success (draft deleted, expense id found
//    by draft_id; a retry no-op INSERT still counts as success here; a
//    failed id lookup degrades to ok with a null id, never to "failed" —
//    the retry would otherwise hit the missing pre-check and misreport a
//    completed conversion as expired).
//  - task done/deleted by another path AND expense exists -> COMPENSATE:
//    finalize as converted-with-task-already-done (draft dropped, honest
//    message via "converted-done"; the done task is NEVER silently
//    deleted, the expense is NEVER duplicated, never called "missing").
//  - task still open AND expense exists -> removal itself failed (draft
//    kept, failed; the next Confirm re-runs the batch).
//  - task still open AND no expense -> nothing landed (draft kept, failed).
//  - task missing/foreign AND expense exists -> "expense-exists" (draft
//    kept, failure reply noting the existing expense row; retry re-checks
//    in the same order, never re-inserts).
//  - task missing/foreign AND no expense -> missing (draft kept).
//  - any read failure while re-reading -> failed (draft kept).
async function confirmTaskExpense(env, userId, draftId, draft) {
  const pre = await getTask(env, userId, draft.taskId);
  if (!pre.ok) return { status: "failed" };
  if (!pre.task || pre.task.status !== "open") return { status: "missing" };
  const batch = await runDbBatch(env, [
    { sql: "INSERT OR IGNORE INTO expenses (user_id, type, amount, currency_code, item, category, date, draft_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", params: [userId, draft.type, draft.amount, draft.currency, draft.item || null, null, draft.date, draftId, new Date().toISOString()] },
    { sql: "UPDATE tasks SET status = 'deleted' WHERE id = ? AND user_id = ? AND status = 'open'", params: [draft.taskId, userId] },
  ]);
  const stmt2Changes = batch.ok ? batch.results[1]?.meta?.changes ?? null : null;
  if (stmt2Changes === 1) {
    const row = await firstDb(env, "SELECT id FROM expenses WHERE draft_id = ? AND user_id = ?", [draftId, userId]);
    await delKv(env, draftKey(draftId));
    return { status: "ok", draft, id: row.ok && row.row ? row.row.id : null };
  }
  const expense = await firstDb(env, "SELECT id FROM expenses WHERE draft_id = ? AND user_id = ?", [draftId, userId]);
  const task = await getTask(env, userId, draft.taskId);
  if (!expense.ok || !task.ok) return { status: "failed" };
  if (task.task && task.task.status === "open") return { status: "failed" };
  if (task.task && expense.row) { await delKv(env, draftKey(draftId)); return { status: "converted-done", draft, id: expense.row.id }; }
  if (!task.task && expense.row) return { status: "expense-exists" };
  return { status: "missing" };
}

export async function confirmExpenseDraft(env, userId, id) {
  const draft = await getKv(env, draftKey(id));
  if (!draft) return { status: "missing" };
  if (Number(draft.owner) !== Number(userId)) return { status: "forbidden" };
  // 1-b-3: a task conversion draft runs its own batch + compensation
  // chain and ALWAYS returns here — it must never fall through to the
  // generic insert/noteId path below.
  if (draft.taskId) return confirmTaskExpense(env, userId, id, draft);
  let expenseId = null;
  if (draft.corrects?.table === "expenses") {
    // Strict correction contract: a corrects table without a valid id
    // returns "missing" — it must never fall through to INSERT.
    if (!Number.isInteger(draft.corrects.id) || draft.corrects.id <= 0) return { status: "missing" };
    const old = await firstDb(env, "SELECT id FROM expenses WHERE id = ? AND user_id = ?", [draft.corrects.id, userId]);
    if (!old.ok) return { status: "failed" };
    if (!old.row) return { status: "missing" };
    const r = await runDb(env, "UPDATE expenses SET type = ?, amount = ?, currency_code = ?, item = ?, date = ? WHERE id = ? AND user_id = ?", [draft.type, draft.amount, draft.currency, draft.item || null, draft.date, draft.corrects.id, userId]);
    if (!r.ok) return { status: "failed" };
    expenseId = draft.corrects.id;
  }
  if (expenseId === null) {
    const r = await runDb(env, "INSERT OR IGNORE INTO expenses (user_id, type, amount, currency_code, item, category, date, draft_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [userId, draft.type, draft.amount, draft.currency, draft.item || null, null, draft.date, id, new Date().toISOString()]);
    if (!r.ok) return { status: "failed" };
    const row = await firstDb(env, "SELECT id FROM expenses WHERE draft_id = ?", [id]);
    expenseId = row.ok && row.row ? row.row.id : null;
  }
  if (draft.noteId) {
    // Change-type replaces the note: if its delete fails, do not report
    // success — keep the draft so Confirm can be retried (INSERT OR IGNORE
    // on draft_id makes the retry a no-op for the expense row).
    const d = await runDb(env, "DELETE FROM notes WHERE id = ? AND user_id = ?", [draft.noteId, userId]);
    if (!d.ok) return { status: "failed" };
  }
  await delKv(env, draftKey(id));
  return { status: "ok", draft, id: expenseId };
}

// Save-first reconciliation (Phase 0-b fix): when handleDailyText saved an
// entry row for this message, everyday branches finalise it instead of
// saving a second user row; without an entry row (D1 unavailable, commands)
// they save exactly as before. _entryFinalised keeps every exit to one
// finalise; markChat finalises only when an entry row exists (chat answers
// otherwise save their user row through answerChatText as before).
async function markDaily(env, o) {
  if (o.entryMessageId) { if (!o._entryFinalised) { o._entryFinalised = true; await finalizeMessageKind(env, o.entryMessageId, o.userId, "daily"); } return; }
  await saveMessage(env, { userId: o.userId, role: "user", content: o.text, kind: "daily" });
}
async function markChat(env, o) {
  if (o.entryMessageId && !o._entryFinalised) { o._entryFinalised = true; await finalizeMessageKind(env, o.entryMessageId, o.userId, "chat"); }
}

// Branch dispatch for a rule-classified intent. Returns "handled" or
// "chat" (fall through to the normal chat/task/dev path). Confident
// money messages are saved as kind daily; ask messages are not saved yet
// (choice asks live in KV until chosen, other asks await a corrected resend).
// Used by both the rule path and the model path: the model only picks the
// branch, and every branch below validates the ORIGINAL text again.
async function runDailyBranch(env, o, c, ctx) {
  const { userId, text } = o;
  if (c.intent === "expense" || c.intent === "income") {
    await markDaily(env, o);
    await startConfirm(env, o, c.intent, c.extraction);
    return "handled";
  }
  if (c.intent === "ask") {
    const question = mapQuestion(c.question);
    if (question === "expense-or-chat" || question === "expense-or-income") {
      const id = newId();
      await putKv(env, askKey(id), { owner: userId, text, question });
      await setPendingAsk(env, userId, askText(question), id, "button");
      await o.send(askText(question), { replyMarkup: { inline_keyboard: askKeyboard(question, id) } });
      return "handled";
    }
    await setPendingAsk(env, userId, askText(question), undefined, kindForAskKey(question));
    await o.send(askText(question));
    return "handled";
  }
  if (c.intent === "translate") {
    if (c.ask) { await setPendingAsk(env, userId, askText(c.ask), undefined, c.ask === "language" ? "language" : kindForAskKey(c.ask), c.ask === "language" ? c.text : undefined); await o.send(askText(c.ask)); return "handled"; }
    const targetName = c.target === "en" ? "English" : c.target === "fa" ? "Persian" : c.target;
    await markChat(env, o);
    await o.chat(c.text, { systemPrompt: `Translate the following text${targetName ? ` to ${targetName}` : ""}. Reply with only the translation.`, saveText: o.entryMessageId ? "" : text, noHistory: true });
    return "handled";
  }
  if (c.intent === "remember") {
    if (c.refused) { await o.send("در این قدم فقط تنظیم‌ها نگه داشته می‌شوند؛ خاطره‌های آزاد در قدم حافظه می‌آیند"); return "handled"; }
    const r = await setSetting(env, userId, c.setting.key, c.setting.value);
    await o.send(r.ok ? `✅ ذخیره شد: ${c.setting.key} = ${c.setting.value}` : NOT_SAVED_TEXT);
    return "handled";
  }
  if (c.intent === "memory_save") {
    const factKey = c.factKey ?? c.setting?.key ?? "general";
    const factValue = String(c.factValue ?? c.setting?.value ?? c.text ?? "").trim();
    if (!factValue) { await o.send(NOT_SAVED_TEXT); return "handled"; }
    let ok = false;
    if (c.setting?.key && c.setting?.value) {
      const sr = await setSetting(env, userId, c.setting.key, c.setting.value);
      ok = !!sr?.ok;
      try { const fr = await upsertUserFact(env, { userId, factKey: c.setting.key, factValue: c.setting.value, sourceMsgId: o.entryMessageId ?? o.messageRowId ?? null, nowMs: ctx.now }); ok = ok || !!fr?.ok; } catch {}
    } else {
      try { const fr = await upsertUserFact(env, { userId, factKey, factValue, sourceMsgId: o.entryMessageId ?? o.messageRowId ?? null, nowMs: ctx.now }); ok = !!fr?.ok; } catch {}
    }
    await o.send(ok ? MEMORY_SAVED_TEXT : NOT_SAVED_TEXT);
    if (ok) await markDaily(env, o);
    return "handled";
  }
  if (c.intent === "unsupported_action") {
    await o.send(UNSUPPORTED_ACTION_TEXT);
    return "handled";
  }
  if (c.intent === "note") {
    // 1-b-1 (decision 5): attach the D1 default project when one exists;
    // the legacy INSERT runs when it does not, so a note is still stored.
    // 1-d-2: an explicit folder phrase overrides the default (re-classified
    // body must stay a note, else the tag is ignored and the original stores).
    const tag = await resolveFolderTag(env, userId, text);
    let body = c.text, pid = await defaultProjectId(env, userId), pname = null;
    if (tag) {
      const c2 = classifyDaily(tag.body, { nowMs: ctx.now, rememberedCurrency: ctx.remembered });
      if (c2.intent === "note" && c2.text) { body = c2.text; pid = tag.project.id; pname = tag.project.name; }
    }
    // Phase 2-d: trim a stray leading "." / ":" / "-" from the saved
    // note body (folder-strip and "یادداشت: . ..." forms leave one).
    const cleanBody = stripLeadingNotePunct(body);
    if (cleanBody) body = cleanBody;
    const r = pid === null ? await runDb(env, "INSERT INTO notes (user_id, text, source, created_at) VALUES (?, ?, ?, ?)", [userId, body, o.source === "voice" ? "voice" : "text", new Date().toISOString()]) : await runDb(env, "INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (?, ?, ?, ?, ?)", [userId, body, o.source === "voice" ? "voice" : "text", new Date().toISOString(), pid]);
    await o.send(r.ok ? `✅ یادداشت ذخیره شد.${pname ? ` [📁 ${pname}]` : ""}` : NOT_SAVED_TEXT);
    if (r.ok) await markDaily(env, o);
    return "handled";
  }
  // Phase 2-g: task-list resolves an extracted پروژه <name> against
  // D1 (same pattern as the summary branch); an unknown name reports
  // instead of silently listing everything. reminder-list renders the
  // same compact task view restricted to tasks with a reminder set,
  // with its own rem:more paging so the filter survives paging.
  if (c.intent === "task-list" || c.intent === "reminder-list") {
    let projectId = null;
    if (c.projectName) {
      const rp = await listProjectsResult(env, userId);
      if (!rp.ok) { await o.send(TASK_LIST_FAILED_TEXT); return "handled"; }
      const hit = findProjectByName(rp.projects, c.projectName);
      if (!hit) { await o.send(`📁 پروژه «${c.projectName}» پیدا نشد.`); await markDaily(env, o); return "handled"; }
      projectId = hit.id;
    }
    const r = c.intent === "reminder-list"
      ? await renderTaskList(env, userId, projectId, 0, { remindOnly: true, morePrefix: "rem:more", hideFilters: true, hideSummary: true, emptyText: "یادآوری بازی پیدا نشد." })
      : await renderTaskList(env, userId, projectId);
    await sendListMessage(o, r); if (r.ok) await markDaily(env, o); return "handled";
  }
  // 1-d-2: natural project creation / listing / deterministic task creation.
  if (c.intent === "project-create") {
    const r = await insertProject(env, userId, c.name);
    if (!r.ok) { await o.send(NOT_SAVED_TEXT); return "handled"; }
    await o.send(r.created ? `📁 پروژه «${r.project.name}» ساخته شد.` : `📁 پروژه «${r.project.name}» از قبل وجود دارد.`);
    await markDaily(env, o);
    return "handled";
  }
  if (c.intent === "project-list") {
    const r = await listProjectsResult(env, userId);
    if (!r.ok) { await o.send("پروژه‌ها خوانده نشد؛ دوباره تلاش کن."); return "handled"; }
    if (r.projects.length === 0) await o.send("پروژه‌ای پیدا نشد.");
    else await o.send(`📁 پروژه‌ها:\n${r.projects.map((p) => `📁 ${p.name}`).join("\n")}`);
    await markDaily(env, o);
    return "handled";
  }
  if (c.intent === "task-create") {
    const tag = await resolveFolderTag(env, userId, text);
    let body = c.text, pid = null, pname = null;
    if (tag) {
      const c2 = classifyDaily(tag.body, { nowMs: ctx.now, rememberedCurrency: ctx.remembered });
      if (c2.intent === "task-create" && c2.text) { body = c2.text; pid = tag.project.id; pname = tag.project.name; }
    }
    const r = await insertTask(env, { userId, title: body, projectId: pid, source: o.source === "voice" ? "voice" : "text" });
    await o.send(r.ok ? `✅ تسک ثبت شد.${pname ? ` [📁 ${pname}]` : ""}` : NOT_SAVED_TEXT);
    if (r.ok) await markDaily(env, o);
    return "handled";
  }
  if (c.intent === "reminder") {
    // 1-c-3: an hour-ambiguous ask stores the ORIGINAL message in
    // pendingBody, so a bare daypart (or time + daypart) follow-up can
    // be resolved deterministically in the rule tier. Other reminder
    // asks keep the old slot shape (question + kind only).
    if (c.ask) { await setPendingAsk(env, userId, askText(c.ask), undefined, c.ask, c.ask === "hour-ambiguous" ? text : undefined); if (c.ask === "hour-ambiguous") await sendHourAmbiguousAsk(o); else await o.send(askText(c.ask)); return "handled"; }
    // 1-d-2: an explicit folder phrase attaches the resolved project
    // (re-classified body must stay a clean reminder, else ignored).
    const tag = await resolveFolderTag(env, userId, text);
    let body = c.text, due = c.due, pid = null, pname = null;
    if (tag) {
      const c2 = classifyDaily(tag.body, { nowMs: ctx.now, rememberedCurrency: ctx.remembered });
      if (c2.intent === "reminder" && !c2.ask && c2.text && c2.due) { body = c2.text; due = c2.due; pid = tag.project.id; pname = tag.project.name; }
    }
    // 1-b-3 (decision 2): a reminder is stored as a task (title = text,
    // remind_at = due, due_at = NULL); the legacy reminders table gains
    // NO new rows. 1-c-2: delivery is now active via scheduled(), so the
    // notice is the active text, not the 1-b transitional text.
    const r = await insertTask(env, { userId, title: body, remindAt: due, dueAt: null, projectId: pid, source: o.source === "voice" ? "voice" : "text" });
    await o.send(r.ok ? `⏰ یادآوری به‌عنوان تسک ذخیره شد.${pname ? ` [📁 ${pname}]` : ""}` : NOT_SAVED_TEXT);
    if (r.ok) await markDaily(env, o);
    return "handled";
  }
  if (c.intent === "expense-query") {
    if (c.ask) { await setPendingAsk(env, userId, askText(c.ask), undefined, c.ask); await o.send(askText(c.ask)); return "handled"; }
    const sums = await queryExpenseSums(env, userId, c.range);
    const keys = Object.keys(sums);
    await o.send(keys.length ? keys.map((k) => `${k}: ${sums[k]}`).join("\n") : "در این بازه خرجی ثبت نشده است.");
    await markDaily(env, o);
    return "handled";
  }
  if (c.intent === "last-expense") {
    // Answered from D1 only: the chat model must never claim anything
    // about the user's records. A failed read reports the standard error
    // and stores nothing extra.
    const r = await firstDb(env, "SELECT amount, currency_code, item, date FROM expenses WHERE user_id = ? AND type = 'expense' ORDER BY id DESC LIMIT 1", [userId]);
    if (!r.ok) { await o.send(NOT_SAVED_TEXT); return "handled"; }
    if (!r.row) { await o.send("هنوز خرجی ثبت نشده است."); }
    else await o.send(`💰 آخرین خرج: ${r.row.amount} ${r.row.currency_code}${r.row.item ? ` — ${r.row.item}` : ""} — ${formatJalali(r.row.date) || r.row.date}`);
    await markDaily(env, o);
    return "handled";
  }
  if (c.intent === "note-query") {
    if (c.ask) { await setPendingAsk(env, userId, askText(c.ask), undefined, c.ask); await o.send(askText(c.ask)); return "handled"; }
    const r = await renderNoteList(env, userId, { projectName: c.projectName ?? null, date: c.date ?? null, offset: 0 });
    await sendListMessage(o, r);
    if (r.ok) await markDaily(env, o);
    return "handled";
  }
  if (c.intent === "summary") {
    let projectId = null;
    if (c.projectName) {
      const rp = await listProjectsResult(env, userId);
      if (!rp.ok) { await o.send(c.kind === "note" ? NOTE_LIST_FAILED_TEXT : TASK_LIST_FAILED_TEXT); return "handled"; }
      const hit = findProjectByName(rp.projects, c.projectName);
      if (!hit) { await o.send(`📁 پروژه «${c.projectName}» پیدا نشد.`); await markDaily(env, o); return "handled"; }
      projectId = hit.id;
    }
    const ok = await runSummary(env, o, c.kind, projectId, userId, `${c.kind === "note" ? "note" : "task"}:sum:${projectId == null ? "all" : projectId}`);
    if (ok) await markDaily(env, o);
    return "handled";
  }
  if (c.intent === "vault_save") {
    const rowId = o.messageRowId ?? o.msgId ?? o.entryMessageId ?? null;
    // A19: never accept vault credentials from a group/supergroup chat.
    if (o.chatType && o.chatType !== "private") {
      if (rowId) await redactMessageContent(env, userId, rowId, VAULT_REDACTED_TEXT);
      await o.send(VAULT_PRIVATE_ONLY_TEXT);
      return "handled";
    }
    if (!c.title || !String(c.title).trim() || !c.value || !String(c.value).trim() || String(c.value).trim().length < 4) { await o.send("برای ثبت در گاوصندوق، عنوان و مقدار را مشخص کن؛ هنوز چیزی ذخیره نشده است."); return "handled"; }
    await markDaily(env, o);
    // A08: even slot/NLU-routed saves must not leave plaintext credentials
    // in messages.content (the entry row may already exist).
    if (rowId) await redactMessageContent(env, userId, rowId, VAULT_REDACTED_TEXT);
    let valueEnc;
    try { valueEnc = await encryptVaultValue(env, c.value ?? ""); } catch { await o.send(NOT_SAVED_TEXT); return "handled"; }
    const saved = await saveVaultItem(env, { userId, label: c.title ?? "مورد گاوصندوق", kind: "text", valueEnc, category: c.category ?? null, extra: c.extra ?? null, syncStatus: "local" });
    let badge = "";
    if (saved.ok) {
      const row = await getVaultItem(env, userId, saved.id);
      if (row) {
        const sync = await syncVaultItemToGoogle(env, { id: row.id, userId, label: row.label, value: c.value ?? "", kind: "text", createdAt: row.created_at });
        await setVaultSyncStatus(env, userId, saved.id, sync.ok ? "synced" : "pending_google", sync.googleId ?? null);
        badge = sync.ok ? "\n✅ گوگل‌شیت: ذخیره شد" : "\n⏳ در انتظار همگام‌سازی گوگل";
      }
    }
    await o.send(`🔒 **در گاوصندوق امن ذخیره شد**\n📌 عنوان: **${c.title ?? ""}**\n💳 مقدار (ضربه برای کپی): \`${c.value ?? ""}\`${badge}`);
    return "handled";
  }
  if (c.intent === "vault_get") {
    // A19: decrypting or echoing vault values is private-chat only.
    if (o.chatType && o.chatType !== "private") { await o.send(VAULT_PRIVATE_ONLY_TEXT); return "handled"; }
    await markDaily(env, o);
    const items = (await listVaultItems(env, userId)).items;
    const keys = (c.keywords ?? []).filter(Boolean);
    const matches = [];
    for (const it of items || []) {
      const hay = `${it.label ?? ""} ${it.category ?? ""} ${it.extra ?? ""}`;
      if (keys.some((k) => hay.includes(k))) matches.push(it);
    }
    if (matches.length === 0) { await o.send("هیچ موردی در گاوصندوق پیدا نشد."); return "handled"; }
    const lines = [];
    for (const it of matches) {
      const row = await getVaultItem(env, userId, it.id);
      let value = "";
      try { if (row) value = await decryptVaultValue(env, row.value_enc); } catch { value = "[رمزنگاری‌شده]"; }
      lines.push(`📌 **${it.label ?? ""}**\n\`${value}\``);
    }
    await o.send(lines.join("\n\n"));
    return "handled";
  }
  if (c.intent === "vault_list") {
    await markDaily(env, o);
    if (c.fileList) {
      const files = (await listVaultFiles(env, userId)).files || [];
      if (!files.length) { await o.send("هیچ مدرکی در آرشیو پیدا نشد."); return "handled"; }
      const lines = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const tp = tehranParts(f.created_at);
        const when = tp ? `${formatJalali(tp.date) || tp.date} ${tp.hhmm}` : "";
        lines.push(`${i + 1}. 📁 **${f.title ?? ""}**${when ? ` — ${when}` : ""}`);
      }
      const keyboard = files.map((f, i) => [{ text: `📥 #${i + 1}`, callback_data: `vault:file:${f.id}` }]);
      await o.send(lines.join("\n"), { replyMarkup: { inline_keyboard: keyboard } });
      return "handled";
    }
    const items = (await listVaultItems(env, userId)).items;
    if (!(items || []).length) { await o.send("گاوصندوق خالی است."); return "handled"; }
    const lines = [];
    let n = 0;
    for (const it of items || []) {
      const row = await getVaultItem(env, userId, it.id);
      let value = "";
      try { if (row) value = await decryptVaultValue(env, row.value_enc); } catch { value = ""; }
      if (!value) continue;
      n++;
      lines.push(`${n}. 📌 **${it.label ?? ""}** — \`${value}\``);
    }
    let text = n ? lines.join("\n") : "هیچ مقدار ذخیره‌شده‌ای پیدا نشد.";
    text += `\n\nبرای گرفتن فایل اکسل، روی «📊 خروجی اکسل (CSV)» بزنید.`;
    await o.send(text, { replyMarkup: { inline_keyboard: [[{ text: "📊 خروجی اکسل (CSV)", callback_data: "vault:csv" }], [{ text: "☁️ همگام‌سازی گوگل", callback_data: "vault:sync" }]] } });
    return "handled";
  }
  if (c.intent === "vault_file_get") {
    await markDaily(env, o);
    const keys = (c.keywords ?? []).filter(Boolean);
    const files = (await listVaultFiles(env, userId)).files || [];
    const hits = keys.length ? files.filter((f) => keys.some((k) => String(f.title ?? "").includes(k))) : files;
    hits.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
    const f = hits[0];
    if (!f) { await o.send("مدرکی با این عنوان پیدا نشد."); return "handled"; }
    const tp = tehranParts(f.created_at);
    const when = tp ? `${formatJalali(tp.date) || tp.date} ${tp.hhmm}` : "";
    const caption = `🔒📁 **${f.title ?? ""}**${when ? `\n🗓 ${when}` : ""}${f.doc_url ? `\n${f.doc_url}` : ""}`;
    const formatted = formatTelegramHtml(caption);
    const payload = { chat_id: o.chatId, caption: formatted, ...(formatted !== caption ? { parse_mode: "HTML" } : {}) };
    if (f.file_type === "photo") await tgApi(env, "sendPhoto", { ...payload, photo: f.tg_file_id });
    else await tgApi(env, "sendDocument", { ...payload, document: f.tg_file_id });
    return "handled";
  }
  if (c.intent === "file-reference") {
    const recent = await recentMessages(env, userId, 10);
    const file = recent.find((r) => r.tg_file_id);
    if (file) {
      const fileLabel = file.file_name || (typeof file.file_mime === "string" && file.file_mime.startsWith("image/") ? "عکس" : "فایل");
      await o.send(`📎 فایل پیدا شد: ${fileLabel} — خلاصه‌سازی با قدم فایل‌ها می‌آید، فعلاً فقط ذخیره شده است.`);
      await markDaily(env, o);
      return "handled";
    }
    const prev = recent[0];
    if (prev && prev.role === "user" && prev.kind === "chat" && !prev.tg_file_id) return "chat";
    await o.send("کدام فایل؟ در ۱۰ پیام اخیر فایلی پیدا نشد.");
    return "handled";
  }
  return "chat";
}

// Re-ask the pending question after a model failure (Part 3); button asks reuse the SAME ask id.
async function reaskPending(env, o, slot) {
  if (slot.askId) {
    const ask = await getKv(env, askKey(slot.askId));
    if (!ask || Number(ask.owner) !== Number(o.userId) || (ask.question !== "expense-or-chat" && ask.question !== "expense-or-income")) { await o.send(EXPIRED_TEXT); return; }
    await o.send(askText(ask.question), { replyMarkup: { inline_keyboard: askKeyboard(ask.question, slot.askId) } });
    await setPendingAsk(env, o.userId, askText(ask.question), slot.askId, "button", slot.pendingBody);
    return;
  }
  await o.send(slot.question);
  await setPendingAsk(env, o.userId, slot.question, undefined, slotKind(slot), slot.pendingBody);
}

// Follow-up resolution (Part 3): only with a slot AND a model followup.
// Returns {ret, outcome}, or null to fall through to the normal switch.
// Money safety is unchanged: rule extraction + confirm flow, no record without Confirm.
async function resolveFollowup(env, o, slot, m, ctx) {
  const { text } = o;
  if (slot.askId) {
    const ask = await getKv(env, askKey(slot.askId));
    if (!ask) { await o.send(EXPIRED_TEXT); return { ret: "handled", outcome: "routed" }; }
    if (Number(ask.owner) !== Number(o.userId)) return { ret: "handled", outcome: "routed" };
    if (ask.question !== "expense-or-chat" && ask.question !== "expense-or-income") return null;
    const choice = m.followup === "yes" ? "expense" : ask.question === "expense-or-chat" ? "chat" : "income";
    // Save-first: ask.text already has its entry row from the ask exit, so
    // the chat answer must not save it a second time (saveText "").
    if (choice === "chat") { await o.chat(ask.text, { saveText: "" }); return { ret: "handled", outcome: "chat" }; }
    const ex = parseExpense(ask.text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered }, ask.text);
    if (ex?.error) { const q = askText(mapQuestion(ex.error)); await o.send(q); await setPendingAsk(env, o.userId, q, undefined, mapQuestion(ex.error)); return { ret: "handled", outcome: "asked" }; }
    await startConfirm(env, o, choice, ex);
    return { ret: "handled", outcome: "routed" };
  }
  // Plain-text ask slot.
  if (m.followup === "no") { await o.send("باشه، ثبت نشد."); return { ret: "handled", outcome: "routed" }; }
  if (slot.question === askText("amount") && (m.intent === "expense" || m.intent === "income")) {
    const ex = parseExpense(text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered }, text);
    if (ex?.error) { await o.send(askText("amount")); await setPendingAsk(env, o.userId, askText("amount"), undefined, "amount"); return { ret: "handled", outcome: "asked" }; }
    return { ret: await runDailyBranch(env, o, { intent: m.intent, extraction: ex }, ctx), outcome: "routed" };
  }
  if (slot.question === askText("amount")) {
    // Bare "yes" (or a non-money verdict): "yes" alone answers no amount.
    await o.send(askText("amount")); await setPendingAsk(env, o.userId, askText("amount"), undefined, "amount"); return { ret: "handled", outcome: "asked" };
  }
  // Non-amount plain ask + "yes": a fresh everyday intent runs fresh (the
  // user answered with a full message); a bare "yes" answers nothing, so
  // the same question is re-asked instead of dumping "yes" into chat.
  if (m.intent !== "chat") return null;
  await o.send(slot.question); await setPendingAsk(env, o.userId, slot.question, undefined, slotKind(slot), slot.pendingBody); return { ret: "handled", outcome: "asked" };
}

// Translate body derivation, shared by the translate case and the
// invalid-target ask: rule body first, then a "text: body" colon fallback.
function deriveTranslateBody(text, ctx) {
  const c2 = classifyDaily(text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered });
  let body = c2.intent === "translate" ? c2.text : null;
  if (!body) { const colon = /[:：]\s*([\s\S]+)/.exec(text); body = colon ? colon[1].trim() : null; }
  return body || null;
}

// Model step (Part 3): the model only picks the branch; every branch below
// re-validates the ORIGINAL text with rule code, so model output fields are
// never read (parseModelIntent drops them). followup is consumed ONLY with a
// pending-ask slot; without one it is ignored, as in Part 2. Exported for tests (branch-level).
export async function runModelBranch(env, o, rule, ctx) {
  const t0 = Date.now();
  const slot = await getPendingAsk(env, o.userId);
  // A skipped call (missing key) is NOT a failure: Part 2 behaviour remains, stale slot just consumed.
  const keyMissing = !env || !env.ROUTER_KEY;
  const m = keyMissing ? null : await classifyDailyWithModel(env, o.text, slot?.question ?? null);
  const ms = () => Date.now() - t0;
  // Old slot consumed now: later paths resolve (stays cleared) or send a new ask (fresh slot).
  await clearPendingAsk(env, o.userId);
  // A validated translate intent with one bad field: ask the language,
  // on either tier — a targeted ask, not a generic failure. A body known
  // here (follow-up body, kept body, or derived body) rides in the slot.
  if (m && m.invalid === "target") {
    const keep = slot && slotKind(slot) === "language" ? slot.pendingBody : slot && slotKind(slot) === "translate-text" ? o.text : deriveTranslateBody(o.text, ctx);
    await setPendingAsk(env, o.userId, askText("language"), undefined, "language", keep || undefined); await o.send(askText("language")); return { ret: "handled", outcome: "asked", ms: ms() };
  }
  if (!m && rule.intent === "chat" && slot) {
    // Fallback body-slot handling: ONLY when the model gave nothing
    // (failure, timeout, unparseable output, or missing key). Model
    // successes keep the old 3b behaviour; the slot kind decides only
    // as a fallback, so a live model that never returns JSON cannot
    // loop on re-ask. Chat tier only: rule "ask" keeps the model path.
    const fallbackKind = slotKind(slot);
    if (fallbackKind === "note-text" || fallbackKind === "translate-text" || (fallbackKind === "language" && slot.pendingBody)) {
      if (fallbackKind === "note-text") {
        if (!o.text.trim()) { await setPendingAsk(env, o.userId, askText("note-text"), undefined, "note-text"); await o.send(askText("note-text")); return { ret: "handled", outcome: "asked", ms: ms() }; }
        return { ret: await runDailyBranch(env, o, { intent: "note", text: o.text }, ctx), outcome: "routed", ms: ms() };
      }
      if (fallbackKind === "translate-text") {
        if (!o.text.trim()) { await setPendingAsk(env, o.userId, askText("text"), undefined, "translate-text"); await o.send(askText("text")); return { ret: "handled", outcome: "asked", ms: ms() }; }
        await setPendingAsk(env, o.userId, askText("language"), undefined, "language", o.text); await o.send(askText("language")); return { ret: "handled", outcome: "asked", ms: ms() };
      }
      const target = parseLanguageAnswer(o.text);
      if (!target) { await setPendingAsk(env, o.userId, askText("language"), undefined, "language", slot.pendingBody); await o.send(askText("language")); return { ret: "handled", outcome: "asked", ms: ms() }; }
      return { ret: await runDailyBranch(env, o, { intent: "translate", text: slot.pendingBody, target }, ctx), outcome: "routed", ms: ms() };
    }
  }
  if (!m) {
    // Part 3b deviation: for body slots (note-text/translate-text/language)
    // a SKIPPED call (missing key) re-asks like a failure — the generic
    // skip-to-chat would silently drop the question. Other slots keep
    // Part 3 behaviour (skip -> rule ask / chat, slot consumed).
    if (slot && (!keyMissing || isBodySlot(slot))) { await reaskPending(env, o, slot); return { ret: "handled", outcome: "asked", ms: ms() }; }
    if (rule.intent === "ask") { const ret = await runDailyBranch(env, o, rule, ctx); return { ret, outcome: "asked", ms: ms() }; }
    return { ret: "chat", outcome: "chat", ms: ms() };
  }
  if (slot && m.followup) {
    const f = await resolveFollowup(env, o, slot, m, ctx);
    if (f) return { ret: f.ret, outcome: f.outcome, ms: ms() };
  }
  const { text } = o;
  const reclassify = () => classifyDaily(text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered });
  // Part 3b: slot-aware body consumption. When the pending slot asked for a
  // body and the model verdict matches it, the follow-up's FULL text IS the
  // body — the reclassification gate below must not loop on it. This bypass
  // applies ONLY to these slot cases; all non-slot verdicts keep Part 2/3
  // behaviour. Bodies always come from o.text (full), never the 300-char
  // classification payload (that cap lives only inside classifyDailyWithModel).
  const kind = slot ? slotKind(slot) : "other";
  if (slot && kind === "note-text" && m.intent === "note") {
    if (!text.trim()) { await setPendingAsk(env, o.userId, askText("note-text"), undefined, "note-text"); await o.send(askText("note-text")); return { ret: "handled", outcome: "asked", ms: ms() }; }
    return { ret: await runDailyBranch(env, o, { intent: "note", text }, ctx), outcome: "routed", ms: ms() };
  }
  if (slot && kind === "translate-text" && m.intent === "translate") {
    if (!text.trim()) { await setPendingAsk(env, o.userId, askText("text"), undefined, "translate-text"); await o.send(askText("text")); return { ret: "handled", outcome: "asked", ms: ms() }; }
    if (m.target) return { ret: await runDailyBranch(env, o, { intent: "translate", text, target: m.target }, ctx), outcome: "routed", ms: ms() };
    await setPendingAsk(env, o.userId, askText("language"), undefined, "language", text); await o.send(askText("language")); return { ret: "handled", outcome: "asked", ms: ms() };
  }
  if (slot && kind === "language" && m.intent === "translate" && slot.pendingBody) {
    if (m.target) return { ret: await runDailyBranch(env, o, { intent: "translate", text: slot.pendingBody, target: m.target }, ctx), outcome: "routed", ms: ms() };
    await setPendingAsk(env, o.userId, askText("language"), undefined, "language", slot.pendingBody); await o.send(askText("language")); return { ret: "handled", outcome: "asked", ms: ms() };
  }
  switch (m.intent) {
    case "chat":
      if (rule.intent === "ask") { const ret = await runDailyBranch(env, o, { intent: "ask", question: "expense-or-chat" }, ctx); return { ret, outcome: "asked", ms: ms() }; }
      if (o.hasImage) return { ret: "chat", outcome: "chat", ms: ms() };
      return { ret: "chat-direct", outcome: "chat", ms: ms() };
    case "dev": return { ret: "chat-direct", outcome: "chat", ms: ms() }; // 1-d-1: free-text dev is never blocked by the /dev suggestion — it flows to normal chat. chat-direct makes the caller answer directly and skip classifyIntent, so the suggestion loop cannot re-intercept it. Only an explicit /dev command dispatches a run (tgCommand path in index.js); the interpreter's explicit dev_hint action still uses freeTextDevSuggestion.
    case "expense": case "income": {
      const ex = parseExpense(text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered }, text);
      if (ex?.error) { const ret = await runDailyBranch(env, o, { intent: "ask", question: ex.error }, ctx); return { ret, outcome: "asked", ms: ms() }; }
      return { ret: await runDailyBranch(env, o, { intent: m.intent, extraction: ex }, ctx), outcome: "routed", ms: ms() };
    }
    case "note": {
      const c2 = reclassify();
      if (c2.intent === "note") return { ret: await runDailyBranch(env, o, c2, ctx), outcome: "routed", ms: ms() };
      await setPendingAsk(env, o.userId, askText("note-text"), undefined, "note-text"); await o.send(askText("note-text")); return { ret: "handled", outcome: "asked", ms: ms() };
    }
    case "reminder": {
      const r = parseReminder(normalizeText(text), ctx.now, text);
      const c2 = r.ask ? { intent: "reminder", ask: r.ask } : { intent: "reminder", text: r.text, due: r.due };
      const ret = await runDailyBranch(env, o, c2, ctx);
      return { ret, outcome: r.ask ? "asked" : "routed", ms: ms() };
    }
    case "translate": {
      const c2 = reclassify();
      const body = deriveTranslateBody(text, ctx);
      if (!body) { await setPendingAsk(env, o.userId, askText("text"), undefined, "translate-text"); await o.send(askText("text")); return { ret: "handled", outcome: "asked", ms: ms() }; }
      const target = m.target || (c2.intent === "translate" && ["en", "fa", "ar"].includes(c2.target) ? c2.target : null);
      if (!target) { await setPendingAsk(env, o.userId, askText("language"), undefined, "language", body); await o.send(askText("language")); return { ret: "handled", outcome: "asked", ms: ms() }; }
      return { ret: await runDailyBranch(env, o, { intent: "translate", text: body, target }, ctx), outcome: "routed", ms: ms() };
    }
    case "remember": {
      const c2 = reclassify();
      if (c2.intent === "remember") return { ret: await runDailyBranch(env, o, c2, ctx), outcome: "routed", ms: ms() };
      await o.send("در این قدم فقط تنظیم‌ها نگه داشته می‌شوند؛ خاطره‌های آزاد در قدم حافظه می‌آیند");
      return { ret: "handled", outcome: "routed", ms: ms() };
    }
    case "expense-query": {
      const c2 = reclassify();
      if (c2.intent === "expense-query") { const ret = await runDailyBranch(env, o, c2, ctx); return { ret, outcome: c2.ask ? "asked" : "routed", ms: ms() }; }
      const ret = await runDailyBranch(env, o, { intent: "expense-query", ask: "period" }, ctx);
      return { ret, outcome: "asked", ms: ms() };
    }
    case "note-query": return { ret: await runDailyBranch(env, o, { intent: "note-query", date: c.date ?? null, projectName: c.projectName ?? null }, ctx), outcome: "routed", ms: ms() };
    case "last-expense": return { ret: await runDailyBranch(env, o, { intent: "last-expense" }, ctx), outcome: "routed", ms: ms() };
    case "file-reference": {
      const ret = await runDailyBranch(env, o, { intent: "file-reference" }, ctx);
      return { ret, outcome: ret === "chat" ? "chat" : "routed", ms: ms() };
    }
    default: return { ret: "chat", outcome: "chat", ms: ms() };
  }
}

// ── Phase 0-b: interpreter wiring (design v3, 3.1-3.5; cards in 0-b2) ──
// Seed projects until migration 0003 lands (Phase 1-a swaps this constant
// for a D1 read). Never auto-create: unknown names get type buttons.
export const SEED_PROJECTS = [{ name: "عمومی", aliases: [] }, { name: "ایجنت", aliases: [] },
  { name: "گلبهار", aliases: ["گل"] }, { name: "قرارها و ملاقات‌ها", aliases: ["قرارها"] }];

// Phase 1-b-0a (Fix A): resolve the user's projects from D1. Exported
// for tests but NOT yet called by any runtime path in this slice (pure
// functions + tests, no wiring). Returns:
//   {ok: true, fallback: false, projects: [{id, name, aliases[], is_default}]}
//     on a D1 read with rows (aliases JSON parsed, malformed -> []);
//   {ok: true, fallback: true, projects: SEED_PROJECTS} on genuine
//     empty success (seed shape preserved, entries carry no D1 id);
//   {ok: false, projects: []} on a D1 failure — NO seed fallback, so a
//     failure is never misread as "user has no projects".
function parseAliasesText(raw) {
  try {
    const v = JSON.parse(typeof raw === "string" ? raw : "[]");
    return Array.isArray(v) ? v.filter((a) => typeof a === "string") : [];
  } catch { return []; }
}
// 1-d-4: shared name/alias resolution (used by renderNoteList and the
// summary branch, so the two never drift apart). Null when unresolved.
function findProjectByName(projects, name) {
  const norm = normalizeText(name).trim();
  return (projects || []).filter((p) => p.id != null).find((p) => normalizeText(p.name).trim() === norm || parseAliasesText(p.aliases).some((a) => normalizeText(a).trim() === norm)) || null;
}
export async function resolveProjects(env, userId) {
  const r = await listProjectsResult(env, userId);
  if (!r.ok) return { ok: false, projects: [] };
  if (r.projects.length === 0) return { ok: true, fallback: true, projects: SEED_PROJECTS };
  return {
    ok: true,
    fallback: false,
    projects: r.projects.map((p) => ({ id: p.id, name: p.name, aliases: parseAliasesText(p.aliases), is_default: p.is_default })),
  };
}

// 1-b-1 (decision 5): the rule note's default project — the D1 row with
// is_default = 1, else NULL. A project lookup never fails a note.
async function defaultProjectId(env, userId) {
  const rp = await resolveProjects(env, userId);
  if (!rp.ok || rp.fallback) return null;
  return rp.projects.find((p) => p.is_default === 1)?.id ?? null;
}

// 1-d-2: resolve an explicit folder phrase against D1 active projects
// (listProjectsResult — real rows with ids only; a seed fallback has no
// id and is never attached). Start form: longest project name/alias
// prefix of rest, with a word boundary (space/colon/end) after the name;
// end form: exact normalized name/alias match of the tail. Returns
// { project, body } or null. The caller re-classifies body and only
// uses the tag when the intent family is preserved, so a false prefix
// (e.g. a name that is a prefix of another word) can never mis-store.
async function resolveFolderTag(env, userId, fullText) {
  // Phase 2-b: load the real D1 projects FIRST and pass them into
  // extractFolderTag, so mid-sentence known names ("... برای پروژه
  // گلبهار برسه") resolve with 0 model calls. A seed fallback has no
  // id and is never attached (pre-existing invariant), so D1 failure
  // or an empty project list still returns null.
  const rp = await listProjectsResult(env, userId);
  if (!rp.ok || rp.projects.length === 0) return null;
  const tag = extractFolderTag(fullText, rp.projects.map((p) => ({ name: p.name, aliases: parseAliasesText(p.aliases) })));
  if (!tag) return null;
  const cands = [];
  for (const p of rp.projects) {
    if (p.id == null) continue;
    cands.push({ name: normalizeText(p.name).trim(), project: p });
    for (const a of parseAliasesText(p.aliases)) cands.push({ name: normalizeText(a).trim(), project: p });
  }
  cands.sort((a, b) => b.name.length - a.name.length);
  // Phase 2-b known form: the name is already a known name/alias, so
  // it resolves exactly; the body keeps every remaining word intact.
  if (tag.at === "known") {
    const hit = cands.find((c) => c.name && c.name === normalizeText(tag.name).trim());
    return hit ? { project: hit.project, body: tag.body } : null;
  }
  if (tag.at === "end") {
    const hit = cands.find((c) => c.name && c.name === normalizeText(tag.name).trim());
    if (hit) return { project: hit.project, body: tag.body };
    // Phase 2-b fallback (resolveProjectMatch upgrade): a raw
    // candidate that still has trailing words ("گلبهار برسه")
    // resolves to the known project it starts with, and the trailing
    // words rejoin the body — this path only fires when the known
    // scan above missed (e.g. an introducer spelling it does not
    // cover).
    const prefix = matchKnownProjectAt(tag.name, cands.map((c) => c.name));
    if (prefix) {
      const pHit = cands.find((c) => c.name === prefix.name);
      if (pHit) return { project: pHit.project, body: prefix.rest ? `${tag.body} ${prefix.rest}` : tag.body };
    }
    return null;
  }
  // 1-d-6 middle form: the name is already colon-bounded, so it resolves
  // exactly like the end form; the body is the phrase-stripped text.
  if (tag.at === "middle") {
    const hit = cands.find((c) => c.name && c.name === normalizeText(tag.name).trim());
    return hit ? { project: hit.project, body: tag.body } : null;
  }
  const rest = normalizeText(tag.rest).trim();
  const origRest = tag.rest.trim();
  for (const c of cands) {
    if (!c.name) continue;
    if (rest === c.name) return { project: c.project, body: "" };
    if (rest.startsWith(c.name)) {
      // Lengths agree (normalisation is one-to-one), so the original
      // remainder is sliced by the normalized name's length — ZWNJ
      // survives in the returned body.
      const after = origRest.slice(c.name.length);
      if (/^[\s:：]/.test(after)) return { project: c.project, body: after.replace(/^[\s:：]+/u, "").trim() };
    }
  }
  return null;
}

const TASK_LIST_FAILED_TEXT = "تسک‌ها خوانده نشد؛ دوباره تلاش کن";
// 1-b-2: full list render — 8 rows, open only, with project names,
// per-task ✅/🗑 buttons, more/archive/filter navigation. {ok:false}
// ONLY on a task-read failure (Fix A); name resolution degrades to
// titles only when IT fails, since names are decoration. The more
// button renders ONLY on a full page; beyond-end renders no-more.
// Phase 2-g: opts.remindOnly renders only tasks with a reminder set
// (the reminder-list view); opts.morePrefix renames the paging
// callback (rem:more for reminders, so paging never drops the filter);
// opts.hideFilters/hideSummary drop the project-filter and
// archive/summary rows for reminders (those rows would switch to the
// unfiltered task list); opts.emptyText overrides the empty message.
// Defaults reproduce the pre-2-g output byte for byte.
export async function renderTaskList(env, userId, projectId = null, offset = 0, opts = {}) {
  const r = await listOpenTasksResult(env, userId, projectId, 8, offset, { remindOnly: opts.remindOnly === true });
  if (!r.ok) return { ok: false, text: TASK_LIST_FAILED_TEXT, keyboard: null };
  const morePrefix = opts.morePrefix ?? "task:more";
  if (r.tasks.length === 0) return { ok: true, text: offset > 0 ? "صفحه‌ی دیگری نیست." : (opts.emptyText ?? "تسک بازی پیدا نشد."), keyboard: offset > 0 ? [[{ text: "↩ فهرست", callback_data: projectId == null ? `${morePrefix}:0` : `${morePrefix}:0:${projectId}` }]] : null };
  const rp = await resolveProjects(env, userId);
  const names = new Map();
  if (rp.ok && !rp.fallback) for (const p of rp.projects) if (p.id != null) names.set(p.id, p.name);
  // Phase 2-d: numbered lines (so numbered buttons map to rows) and
  // compact buttons — 2 tasks per row instead of one row per task.
  const text = r.tasks.map((t, i) => `${offset + i + 1}. ${t.title}${t.project_id != null && names.get(t.project_id) ? ` — ${names.get(t.project_id)}` : ""}`).join("\n");
  const perTask = r.tasks.map((t, i) => [
    { text: `✅${offset + i + 1}`, callback_data: `task:done:${t.id}` },
    { text: `🗑${offset + i + 1}`, callback_data: `task:del:${t.id}` },
  ]);
  const keyboard = [];
  for (let i = 0; i < perTask.length; i += 2) {
    keyboard.push([...perTask[i], ...(perTask[i + 1] ?? [])]);
  }
  if (r.tasks.length === 8) keyboard.push([{ text: "بیشتر", callback_data: projectId == null ? `${morePrefix}:${offset + 8}` : `${morePrefix}:${offset + 8}:${projectId}` }]);
  if (opts.hideSummary) {
    keyboard.push([{ text: "↩ تسک‌ها", callback_data: "task:more:0" }]);
  } else {
    keyboard.push([{ text: "📦 آرشیو", callback_data: "task:arch:0" }, { text: "📊 خلاصه و جدول", callback_data: `task:sum:${projectId == null ? "all" : projectId}` }]);
  }
  if (!opts.hideFilters && rp.ok && !rp.fallback) {
    const filters = rp.projects.filter((p) => p.id != null).map((p) => ({ text: p.name, callback_data: `task:proj:${p.id}:0` }));
    if (projectId != null) filters.push({ text: "همه", callback_data: "task:more:0" });
    // Phase 2-d: project filters chunked to at most 3 per row, never
    // one unbounded horizontal row.
    keyboard.push(...chunkButtons(filters, 3));
  }
  return { ok: true, text, keyboard };
}

// 1-b-2: archive render — done only, newest-first (listDoneTasks
// core, never the wrapper, so a failure is never an "empty archive").
async function renderTaskArchive(env, userId, offset = 0) {
  const r = await listDoneTasksResult(env, userId, null, 8, offset);
  if (!r.ok) return { ok: false, text: TASK_LIST_FAILED_TEXT, keyboard: null };
  if (r.tasks.length === 0) return { ok: true, text: offset > 0 ? "صفحه‌ی دیگری نیست." : "تسک آرشیوشده‌ای پیدا نشد.", keyboard: offset > 0 ? [[{ text: "↩ آرشیو", callback_data: "task:arch:0" }]] : null };
  const keyboard = [];
  if (r.tasks.length === 8) keyboard.push([{ text: "بیشتر", callback_data: `task:arch:${offset + 8}` }]);
  keyboard.push([{ text: "↩ فهرست باز", callback_data: "task:more:0" }]);
  return { ok: true, text: r.tasks.map((t) => `• ${t.title}`).join("\n"), keyboard };
}

// 1-d-3: Tehran wall-clock parts of a stored ISO timestamp (live rows mix +03:30 and Z forms).
function tehranParts(isoStr) {
  const ms = Date.parse(isoStr);
  if (!Number.isFinite(ms)) return null;
  const s = new Date(ms + IRAN_OFFSET_MIN * 60000).toISOString();
  return { date: s.slice(0, 10), hhmm: s.slice(11, 16) };
}

const NOTE_LIST_FAILED_TEXT = "یادداشت‌ها خوانده نشد؛ دوباره تلاش کن.";
// 1-d-3: rich note render — 8 rows newest-first, row number + Jalali date + Tehran HH:MM + folder badge + text,
// per-note delete, project filter, pagination. {ok:false} ONLY on a note-read failure (Fix A); names degrade to
// no badge when THEIR read fails. The more callback carries the date filter as an optional 4th segment (the spec
// shape note:more:<pid|all>:<offset> still parses): without it, paging a date-filtered list would drop the filter.
export async function renderNoteList(env, userId, { projectName = null, projectId = null, date = null, offset = 0 } = {}) {
  const rp = await listProjectsResult(env, userId);
  if (projectName) {
    if (!rp.ok) return { ok: false, text: NOTE_LIST_FAILED_TEXT, keyboard: null };
    const hit = findProjectByName(rp.projects, projectName);
    if (!hit) return { ok: true, text: `📁 پروژه «${projectName}» پیدا نشد.`, keyboard: null };
    projectId = hit.id;
  }
  const names = new Map();
  if (rp.ok) for (const p of rp.projects) if (p.id != null) names.set(p.id, p.name);
  let sinceIso = null, untilIso = null;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) { const [y, m, d] = date.split("-").map(Number); const start = Date.UTC(y, m - 1, d) - IRAN_OFFSET_MIN * 60000; sinceIso = new Date(start).toISOString(); untilIso = new Date(start + 86400000).toISOString(); }
  const r = await listNotesResult(env, userId, { projectId, sinceIso, untilIso, limit: 8, offset });
  if (!r.ok) return { ok: false, text: NOTE_LIST_FAILED_TEXT, keyboard: null };
  const pidTag = projectId == null ? "all" : projectId;
  const moreTag = (off) => `note:more:${pidTag}:${off}${date ? `:${date}` : ""}`;
  if (r.notes.length === 0) return { ok: true, text: offset > 0 ? "صفحه‌ی دیگری نیست." : "یادداشتی پیدا نشد.", keyboard: offset > 0 ? [[{ text: "↩ فهرست", callback_data: moreTag(0) }]] : null };
  const text = r.notes.map((n, i) => {
    const tp = tehranParts(n.created_at);
    const when = tp ? `${formatJalali(tp.date) || tp.date} ${tp.hhmm}` : "";
    const badge = n.project_id != null && names.get(n.project_id) ? `📁 ${names.get(n.project_id)}` : "";
    const parts = [when, badge].filter(Boolean).join(" · ");
    // Phase 3-A: title-only rows keep the list scannable; the full body
    // is still available through the summary/delete actions.
    return `📖 #${offset + i + 1}${parts ? ` · ${parts}` : ""} — ${deriveNoteTitle(n.text)}`;
  }).join("\n");
  // Phase 3-A: view buttons (📖 #N -> note:view:<id>) render the full note
  // on tap; delete buttons follow below, both packed 4 per row.
  const keyboard = [];
  keyboard.push(...chunkButtons(r.notes.map((n, i) => ({ text: `📖 #${offset + i + 1}`, callback_data: `note:view:${n.id}` })), 4));
  keyboard.push(...chunkButtons(r.notes.map((n, i) => ({ text: `🗑 #${offset + i + 1}`, callback_data: `note:del:${n.id}` })), 4));
  if (r.notes.length === 8) keyboard.push([{ text: "بیشتر", callback_data: moreTag(offset + 8) }]);
  keyboard.push([{ text: "📊 خلاصه و جدول", callback_data: `note:sum:${pidTag}` }]);
  if (rp.ok) {
    const filters = rp.projects.filter((p) => p.id != null).map((p) => ({ text: p.name, callback_data: `note:proj:${p.id}` }));
    if (projectId != null) filters.push({ text: "همه", callback_data: "note:proj:all" });
    keyboard.push(...chunkButtons(filters, 3));
  }
  return { ok: true, text, keyboard };
}

// 1-d-4: D1-grounded summary/table. Verified rows are fetched FIRST
// (up to 30, newest-first for notes, open order for tasks); a D1
// failure reports the failure, 0 rows reports none found — both with
// ZERO model calls. Otherwise ONLY the verified rows (Jalali dates,
// project names) go to the chat combo with no history (history would
// pollute grounding, as it did for translate), no user-row save (the
// caller owns the entry, or the tap owns none), and a 2200-token cap
// (Phase 2-f: raised from 900 — free reasoning models commonly spend
// 800–1500 tokens inside reasoning_content / <think> before the first
// visible token, so 900 risked finish_reason "length" with zero visible
// output; the D1 row cap (30) and the numbered-list prompt already bound
// the visible output, so this adds headroom without inviting long
// answers. Normal chat still sends NO max_tokens at all).
// Returns false ONLY on a D1 failure (the branch gates markDaily on it).
// Stable v1 addendum: Telegram does NOT render Markdown tables — a
// | ... | table arrives as literal pipe text. The summary therefore
// renders as a short lead plus a numbered list (one line per row:
// number, date, folder, one-line summary), which Telegram displays
// cleanly. The list covers exactly the rows given (at most 30 — the
// runSummary input cap); project/date filters in the D1 queries below
// are unchanged, and the summary token cap is 2200 (Phase 2-f,
// reasoning-model headroom — see above).
export const SUMMARY_SYSTEM = "فقط از روی ردیف‌هایی که در پیام کاربر آمده خلاصه بساز. هیچ ردیفی را اضافه، حذف یا حدس نزن و هیچ دانسته‌ی بیرونی را قاطی نکن؛ تاریخ‌ها و نام پروژه‌ها را دقیقاً همان‌طور که داده شده بنویس. خلاصه حداکثر ۴ تا ۵ خط کوتاه باشد و بلافاصله بعد از آن فهرست شماره‌دار همان ردیف‌ها بیاید؛ هر ردیف در یک خط: شماره. تاریخ ـ پوشه ـ خلاصه یک‌خطی. فهرست دقیقاً ردیف‌های داده‌شده (حداکثر ۳۰ ردیف) را پوشش دهد.";
async function runSummary(env, o, kind, projectId, userId, retryData = null) {
  const rp = await listProjectsResult(env, userId);
  const names = new Map();
  if (rp.ok) for (const p of rp.projects) if (p.id != null) names.set(p.id, p.name);
  const r = kind === "note" ? await listNotesResult(env, userId, { projectId, limit: 30, offset: 0 }) : await listOpenTasksResult(env, userId, projectId, 30, 0);
  if (!r.ok) { await o.send(kind === "note" ? NOTE_LIST_FAILED_TEXT : TASK_LIST_FAILED_TEXT); return false; }
  const rows = kind === "note" ? r.notes : r.tasks;
  if (rows.length === 0) { await o.send("موردی برای خلاصه‌سازی پیدا نشد."); return true; }
  const scope = projectId != null && names.get(projectId) ? `پروژه «${names.get(projectId)}»` : "همه";
  const lines = rows.map((row, i) => {
    const badge = row.project_id != null && names.get(row.project_id) ? ` [📁 ${names.get(row.project_id)}]` : "";
    if (kind === "note") { const tp = tehranParts(row.created_at); const when = tp ? `${formatJalali(tp.date) || tp.date} ${tp.hhmm}` : ""; return `${i + 1}. ${when ? `${when} ` : ""}${badge ? `${badge} ` : ""}${stripLeadingNotePunct(row.text)}`; }
    const whenOf = (iso, label) => { const tp = tehranParts(iso); return tp ? ` (${label}: ${formatJalali(tp.date) || tp.date} ${tp.hhmm})` : ""; };
    return `${i + 1}. ${badge ? `${badge} ` : ""}${row.title}${row.remind_at ? whenOf(row.remind_at, "یادآوری") : ""}${row.due_at ? whenOf(row.due_at, "مهلت") : ""}`;
  }).join("\n");
  // Phase 1-e Pillar 1: the ⏳ placeholder goes out BEFORE the model
  // call (only when the caller carries a chatId — callback and message
  // paths do; bare mocks do not), and its id rides into o.chat so
  // answerChatText finalizes that exact message instead of sending a
  // second one. Without TG_TOKEN this is a silent null (no network).
  let progressMsgId = null;
  if (o.chatId != null) progressMsgId = await sendProgressMessage(env, o.chatId, "⏳ در حال آماده‌سازی خلاصه و جدول...");
  await o.chat(`${kind === "note" ? "یادداشت‌ها" : "تسک‌ها"} (${scope}، ${rows.length} ردیف):\n${lines}`, { systemPrompt: SUMMARY_SYSTEM, saveText: "", noHistory: true, maxTokens: 2200, taskType: "chat", failureLabel: "خلاصه‌سازی", ...(retryData ? { retryData } : {}), ...(progressMsgId != null ? { progressMsgId } : {}) });
  return true;
}

// 1-d-3: note: namespace. del re-checks ownership via the user-scoped delete (foreign/missing -> silent; D1 failure -> buttons kept); more/proj validate the project user-scoped.
export async function resolveNoteCallback(env, o) {
  const del = /^note:del:(\d+)$/.exec(o.data);
  if (del) {
    const id = Number(del[1]);
    if (!Number.isSafeInteger(id) || id <= 0) return true; // invalid: silent
    const r = await deleteNote(env, o.fromId, id);
    if (!r.ok) { await o.send(NOT_SAVED_TEXT); return true; } // D1 failure: buttons kept
    if (!r.deleted) return true; // foreign/missing: silent
    if (o.editMarkup) await o.editMarkup();
    await o.send("🗑 یادداشت حذف شد.");
    return true;
  }
  const view = /^note:view:(\d+)$/.exec(o.data);
  if (view) {
    const id = Number(view[1]);
    if (!Number.isSafeInteger(id) || id <= 0) return true;
    const row = await firstDb(env, "SELECT id, text, project_id, created_at FROM notes WHERE id = ? AND user_id = ?", [id, o.fromId]);
    if (!row.ok || !row.row) { await o.send("یادداشتی پیدا نشد."); return true; }
    let pname = null;
    if (row.row.project_id != null) {
      const rp = await listProjectsResult(env, o.fromId);
      if (rp.ok) { const hit = rp.projects.find((p) => String(p.id) === String(row.row.project_id)); if (hit) pname = hit.name; }
    }
    const tp = tehranParts(row.row.created_at);
    const when = tp ? `${formatJalali(tp.date) || tp.date} ${tp.hhmm}` : "";
    const body = String(row.row.text ?? "");
    const title = deriveNoteTitle(body);
    let text = `📌 **${title}**`;
    if (when) text += `\n🗓 ${when}`;
    if (pname) text += ` [📁 ${pname}]`;
    text += `\n\n${body}`;
    await o.send(text, { replyMarkup: { inline_keyboard: [[{ text: "🗑 حذف یادداشت", callback_data: `note:del:${id}` }]] } });
    return true;
  }
  const proj = /^note:proj:([^:]+)$/.exec(o.data);
  if (proj) {
    if (proj[1] !== "all" && !/^\d+$/.test(proj[1])) return true; // invalid: silent
    if (proj[1] !== "all") {
      const rp = await listProjectsResult(env, o.fromId);
      if (!rp.ok) { await o.send(NOTE_LIST_FAILED_TEXT); return true; }
      if (!rp.projects.some((p) => String(p.id) === proj[1])) return true; // foreign/missing: silent
    }
    await sendListMessage(o, await renderNoteList(env, o.fromId, { projectId: proj[1] === "all" ? null : Number(proj[1]) }));
    return true;
  }
  const more = /^note:more:([^:]+):([^:]+)(?::([^:]+))?$/.exec(o.data);
  if (more) {
    const date = more[3] && /^\d{4}-\d{2}-\d{2}$/.test(more[3]) ? more[3] : null;
    if (more[1] !== "all" && !/^\d+$/.test(more[1])) return true; // invalid: silent
    if (more[1] !== "all") {
      const rp = await listProjectsResult(env, o.fromId);
      if (!rp.ok) { await o.send(NOTE_LIST_FAILED_TEXT); return true; }
      if (!rp.projects.some((p) => String(p.id) === more[1])) return true; // foreign/missing: silent
    }
    await sendListMessage(o, await renderNoteList(env, o.fromId, { projectId: more[1] === "all" ? null : Number(more[1]), date, offset: parseListOffset(more[2]) }));
    return true;
  }
  const sum = /^note:sum:([^:]+)$/.exec(o.data);
  if (sum) {
    if (sum[1] !== "all" && !/^\d+$/.test(sum[1])) return true; // invalid: silent
    if (sum[1] !== "all") {
      const rp = await listProjectsResult(env, o.fromId);
      if (!rp.ok) { await o.send(NOTE_LIST_FAILED_TEXT); return true; }
      if (!rp.projects.some((p) => String(p.id) === sum[1])) return true; // foreign/missing: silent
    }
    await runSummary(env, o, "note", sum[1] === "all" ? null : Number(sum[1]), o.fromId, o.data);
    return true;
  }
  return false;
}

// 1-d-5: 1-tap quick convert (qconv:note:<msgId> / qconv:task:<msgId>).
// The tap carries only the message id; the row is re-read user-scoped
// and must be a non-empty USER row — foreign/missing/assistant/empty
// taps stay silent (no data leak). A note lands in the D1 default
// project when one exists (same rule as the note branch); a task does
// the same (the spec's "default/resolved project"). D1 failure ->
// standard not-saved text, buttons kept so the user can retry; success
// -> buttons removed, then the spec-exact confirmation. Normal double-
// tap is prevented by markup removal; a replayed/forged tap could
// duplicate (no conversion record exists, and adding one would need a
// migration, which is forbidden) — the realistic exposure is nil
// (Telegram dedupes callback deliveries; the allow-list gate ran first).
export async function resolveQuickConvertCallback(env, o) {
  const m = /^qconv:(note|task):(\d+)$/.exec(o.data);
  if (!m) return false;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return true; // invalid: silent
  const g = await getMessageRow(env, o.fromId, id);
  if (!g.ok) { await o.send(NOT_SAVED_TEXT); return true; } // D1 failure: buttons kept
  if (!g.row || g.row.role !== "user" || !(g.row.content ?? "").trim()) return true; // foreign/missing/assistant/empty: silent
  const pid = await defaultProjectId(env, o.fromId);
  if (m[1] === "note") {
    const r = pid == null ? await runDb(env, "INSERT INTO notes (user_id, text, source, created_at) VALUES (?, ?, 'text', ?)", [o.fromId, g.row.content, new Date(o.nowMs ?? Date.now()).toISOString()]) : await runDb(env, "INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (?, ?, 'text', ?, ?)", [o.fromId, g.row.content, new Date(o.nowMs ?? Date.now()).toISOString(), pid]);
    if (!r.ok) { await o.send(NOT_SAVED_TEXT); return true; } // write failure: buttons kept
    if (o.editMarkup) await o.editMarkup();
    await o.send("✅ به یادداشت تبدیل شد.");
    return true;
  }
  const t = await insertTask(env, { userId: o.fromId, title: g.row.content, projectId: pid, source: "text", sourceMessageId: null });
  if (!t.ok) { await o.send(NOT_SAVED_TEXT); return true; } // write failure: buttons kept
  if (o.editMarkup) await o.editMarkup();
  await o.send("✅ به تسک تبدیل شد.");
  return true;
}

// 1-d-5: chat retry (chat:retry:<msgId>), distinct from the interpreter
// retry:<rowId>. Same ownership rules as quick convert. The entry
// already owns the user row (save-first), so the retry saves no second
// user row (saveText ""); its answer carries fresh quick-convert
// buttons, and a second failure still offers retry + quick-convert (the
// ids ride along in the retry's own chat options). The transcript
// header is NOT re-echoed on retry: messages rows carry no source
// column, so a retry cannot know the original was voice (the original
// failure notice already carried it).
export async function resolveChatRetryCallback(env, o) {
  const m = /^chat:retry:(\d+)$/.exec(o.data);
  if (!m) return false;
  const id = Number(m[1]);
  if (!Number.isSafeInteger(id) || id <= 0) return true; // invalid: silent
  const g = await getMessageRow(env, o.fromId, id);
  if (!g.ok) { await o.send(NOT_SAVED_TEXT); return true; } // D1 failure: buttons kept
  if (!g.row || g.row.role !== "user" || !(g.row.content ?? "").trim()) return true; // foreign/missing/assistant/empty: silent
  if (o.editMarkup) await o.editMarkup();
  await o.chat(g.row.content, { saveText: "", retryEntryId: id, quickConvertId: id, replyMarkup: { inline_keyboard: quickConvertKeyboard(id) } });
  return true;
}

// 1-b-2: send a list render, splitting at Telegram's 4096-character
// cap on line boundaries (a single over-long line is hard-split);
// the keyboard rides on the LAST chunk only.
async function sendListMessage(o, rendered) {
  const chunks = [];
  for (const line of rendered.text.split("\n")) {
    if (line.length > 4096) { for (let i = 0; i < line.length; i += 4096) chunks.push(line.slice(i, i + 4096)); continue; }
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.length + 1 + line.length <= 4096) chunks[chunks.length - 1] = `${last}\n${line}`;
    else chunks.push(line);
  }
  for (let i = 0; i < chunks.length; i++) await o.send(chunks[i], i === chunks.length - 1 && rendered.keyboard ? { replyMarkup: { inline_keyboard: rendered.keyboard } } : undefined);
}

// Amendment 1: unparseable offset -> page 0; negative -> clamped to 0.
function parseListOffset(raw) {
  if (!/^-?\d+$/.test(String(raw ?? ""))) return 0;
  return Math.max(0, Number(raw));
}

// Fix B ordering shared by task:done and task:del: getTask first,
// then the atomic status change; markup removed ONLY after success.
async function actTaskStatus(env, o, id, status, successText) {
  const g = await getTask(env, o.fromId, id);
  if (!g.ok) { await o.send(NOT_SAVED_TEXT); return true; } // D1 failure: buttons kept
  if (!g.task) return true; // foreign/missing/invalid: silent
  if (g.task.status !== "open") { await o.send(EXPIRED_TEXT); if (o.editMarkup) await o.editMarkup(); return true; } // consumed: fixed message + markup removed
  const r = await setTaskStatus(env, o.fromId, id, status);
  if (!r.ok) { const g2 = await getTask(env, o.fromId, id); if (g2.ok && g2.task && g2.task.status !== "open") { await o.send(EXPIRED_TEXT); if (o.editMarkup) await o.editMarkup(); return true; } await o.send(NOT_SAVED_TEXT); return true; } // lost race: re-read once, else buttons kept
  if (o.editMarkup) await o.editMarkup();
  await o.send(successText);
  return true;
}

// 1-b-2: full task: namespace. done/del act on one row via getTask
// (amendment 3); more/arch/proj carry NO row and never call getTask
// (amendment 1: allow-list gate already ran; proj validates the
// project user-scoped, foreign/missing -> silent, no data, no filter).
export async function resolveTaskCallback(env, o) {
  const done = /^task:(done|del):(\d+)$/.exec(o.data);
  if (done) return actTaskStatus(env, o, Number(done[2]), done[1] === "done" ? "done" : "deleted", done[1] === "done" ? "✅ انجام شد." : "🗑 حذف شد.");
  const more = /^task:more:([^:]+)(?::(\d+))?$/.exec(o.data);
  if (more) { await sendListMessage(o, await renderTaskList(env, o.fromId, more[2] !== undefined ? Number(more[2]) : null, parseListOffset(more[1]))); return true; }
  // Phase 2-g: reminder-list paging — same shape as task:more, but the
  // remindOnly filter rides along so page 2 is still reminders only.
  const remMore = /^rem:more:([^:]+)(?::(\d+))?$/.exec(o.data);
  if (remMore) { await sendListMessage(o, await renderTaskList(env, o.fromId, remMore[2] !== undefined ? Number(remMore[2]) : null, parseListOffset(remMore[1]), { remindOnly: true, morePrefix: "rem:more", hideFilters: true, hideSummary: true, emptyText: "یادآوری بازی پیدا نشد." })); return true; }
  const arch = /^task:arch:([^:]+)$/.exec(o.data);
  if (arch) { await sendListMessage(o, await renderTaskArchive(env, o.fromId, parseListOffset(arch[1]))); return true; }
  const proj = /^task:proj:([^:]+):([^:]+)$/.exec(o.data);
  if (proj) {
    if (!/^\d+$/.test(proj[1])) return true; // invalid project id: silent, like foreign/missing
    const rp = await listProjectsResult(env, o.fromId);
    if (!rp.ok) { await o.send(TASK_LIST_FAILED_TEXT); return true; }
    if (!rp.projects.some((p) => String(p.id) === proj[1])) return true; // foreign/missing: silent, no data, no filter
    await sendListMessage(o, await renderTaskList(env, o.fromId, Number(proj[1]), parseListOffset(proj[2])));
    return true;
  }
  // 1-d-4: task summary button (task:sum:<id|all>); same validation as proj.
  const tsum = /^task:sum:([^:]+)$/.exec(o.data);
  if (tsum) {
    if (tsum[1] !== "all" && !/^\d+$/.test(tsum[1])) return true; // invalid: silent
    if (tsum[1] !== "all") {
      const rp = await listProjectsResult(env, o.fromId);
      if (!rp.ok) { await o.send(TASK_LIST_FAILED_TEXT); return true; }
      if (!rp.projects.some((p) => String(p.id) === tsum[1])) return true; // foreign/missing: silent
    }
    await runSummary(env, o, "task", tsum[1] === "all" ? null : Number(tsum[1]), o.fromId, o.data);
    return true;
  }
  // 1-c-2: snooze follows the same Fix B ordering as done/del: getTask
  // first, then the atomic snooze; markup removed ONLY after success.
  const snooze = /^task:snooze:(\d+)$/.exec(o.data);
  if (snooze) {
    const id = Number(snooze[1]);
    const g = await getTask(env, o.fromId, id);
    if (!g.ok) { await o.send(NOT_SAVED_TEXT); return true; } // D1 failure: buttons kept
    if (!g.task) return true; // foreign/missing/invalid: silent
    if (g.task.status !== "open") { await o.send(EXPIRED_TEXT); if (o.editMarkup) await o.editMarkup(); return true; } // consumed: fixed message + markup removed
    const r = await snoozeTaskReminder(env, o.fromId, id, new Date((o.nowMs ?? Date.now()) + 10 * 60 * 1000).toISOString());
    if (!r.ok) { await o.send(NOT_SAVED_TEXT); return true; } // D1 failure on write: buttons kept
    if (!r.updated) { const g2 = await getTask(env, o.fromId, id); if (g2.ok && g2.task && g2.task.status !== "open") { await o.send(EXPIRED_TEXT); if (o.editMarkup) await o.editMarkup(); return true; } await o.send(NOT_SAVED_TEXT); return true; } // lost race: re-read once, else buttons kept
    if (o.editMarkup) await o.editMarkup();
    await o.send("💤 یادآوری برای ۱۰ دقیقه‌ی دیگر تنظیم شد.");
    return true;
  }
  return false;
}

// Phase 1-c-2: scheduled reminder delivery, called from scheduled() in
// index.js. Claim limit 20 bounds the sends; worst-case subrequests per
// tick under the most conservative counting: 2 claim reads + 20 sends +
// 20 failure releases + 1 purge = 43, under the 50 ceiling (catalog
// crons never run in the same invocation — scheduled() dispatches
// exclusively). The daily purge runs on the 00:00 UTC tick only, derived
// from event.scheduledTime with ZERO KV writes: a per-minute cron fires
// exactly one 00:00 tick per day, so the purge runs at most once daily
// (a missed 00:00 tick simply skips that day's purge). Delivery failure
// releases the claim and logs only the error reason + task id, never
// user text. sendMessage is injectable for offline tests; the default
// sends via tgApi.
export async function runReminderTick(env, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = opts.nowIso ?? new Date(nowMs).toISOString();
  const send = opts.sendMessage ?? ((chatId, text, replyMarkup) => tgApi(env, "sendMessage", { chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }));
  const claim = await claimDueReminders(env, nowIso, 20);
  if (!claim.ok) return { ok: false, sent: 0, failed: 0, purged: null };
  let sent = 0, failed = 0;
  for (const r of claim.reminders) {
    const delayed = Date.parse(nowIso) - Date.parse(r.remind_at) > 5 * 60 * 1000;
    const text = `${delayed ? "⏰ یادآوری (با تاخیر):" : "⏰ یادآوری:"} ${r.title}`;
    const replyMarkup = { inline_keyboard: [[{ text: "✅", callback_data: `task:done:${r.id}` }, { text: "💤 ۱۰ دقیقه‌ی دیگر", callback_data: `task:snooze:${r.id}` }]] };
    try {
      const res = await send(r.telegram_id, text, replyMarkup);
      if (res && res.ok === false) throw new Error(`telegram_send_failed: ${res.error_code ?? ""} ${res.description ?? ""}`);
      sent++;
    } catch (err) {
      failed++;
      await releaseReminderClaim(env, r.id);
      console.error(`reminder send failed: task ${r.id}:`, err && err.message);
    }
  }
  let purged = null;
  const d = new Date(opts.scheduledTime ?? nowMs);
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) {
    const p = await purgeOldClosedTasks(env, new Date(Date.parse(nowIso) - 30 * 86400000).toISOString());
    purged = p.ok ? p.deleted : null;
  }
  return { ok: true, sent, failed, purged };
}
const INTERP_UNAVAILABLE_TEXT = "تفسیر خودکار الان در دسترس نیست؛ خودت نوعش را بگو:";
function interpKey(id) { return `interp:${id}`; }
function interpTypeKeyboard(id) {
  return [[{ text: "📋 تسک", callback_data: `interp:type:task:${id}` }, { text: "📝 یادداشت", callback_data: `interp:type:note:${id}` }], [{ text: "💰 خرج", callback_data: `interp:type:expense:${id}` }, { text: "💬 چت", callback_data: `interp:type:chat:${id}` }]];
}
function noteCardKeyboard(id) { return [[{ text: "🔄 تغییر نوع", callback_data: `interp:change:${id}` }, { text: "🗑 لغو", callback_data: `interp:del:${id}` }]]; }
async function newInterpRecord(env, userId, value) { const id = newId(); await putKv(env, interpKey(id), { owner: userId, ...value }); return id; }
async function insertNoteRow(env, userId, text, source, projectId = null) {
  const db = dbOf(env); if (!db) return { ok: false, id: null };
  try {
    if (projectId === null || projectId === undefined) await db.prepare("INSERT INTO notes (user_id, text, source, created_at) VALUES (?, ?, ?, ?)").bind(userId, text, source, new Date().toISOString()).run();
    else await db.prepare("INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (?, ?, ?, ?, ?)").bind(userId, text, source, new Date().toISOString(), projectId).run();
    const row = await db.prepare("SELECT last_insert_rowid() AS id").bind().first(); const id = row?.id ?? null; if (id) await putKv(env, correctionKey(userId), { table: "notes", id }); return { ok: true, id };
  } catch { return { ok: false, id: null }; }
}
function rangeForPeriod(periodText, nowMs) {
  const t = normalizeText(periodText ?? ""), today = iranDate(nowMs);
  if (/دیروز/.test(t)) { const d = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10); return { start: d, end: d }; }
  if (/هفته/.test(t)) return weekRange(today);
  if (/ماه/.test(t)) return monthRange(today);
  return { start: today, end: today };
}
// Execute ONE validated interpreter action. Money/query/translate/setting/
// dev/chat send their own reply (direct: true); note/task/query return data
// for the caller to present. Money always re-derives from rule code and
// goes through the existing confirm card; the model never supplies numbers.
async function executeInterpAction(env, o, ctx, action, resolved) {
  const { userId } = o;
  if (action.type === "note") {
    const r = await insertNoteRow(env, userId, action.text, o.source === "voice" ? "voice" : "text", resolved.project?.id ?? null);
    if (!r.ok) return { line: `📝 یادداشت: ${action.text} — ${NOT_SAVED_TEXT}` };
    return { line: `📝 یادداشت: ${action.text}`, note: { id: r.id, text: action.text }, kind: "daily" };
  }
  // 1-b-1: a task is really stored (insertTask validates title, project
  // ownership, due/remind ISO). Failure: NOT_SAVED_TEXT, no pointer,
  // nothing claimed. Success: correction pointer set (task correction
  // edits in place from 1-b-4); card carries ONLY the delete button.
  if (action.type === "task") {
    const r = await insertTask(env, { userId, title: action.text, projectId: resolved.project?.id ?? null, dueAt: resolved.due_at, remindAt: resolved.remind_at, source: o.source === "voice" ? "voice" : "text", sourceMessageId: o.entryMessageId ?? null });
    if (!r.ok) return { line: NOT_SAVED_TEXT, kind: "daily" };
    await putKv(env, correctionKey(userId), { table: "tasks", id: r.id });
    const parts = [`📋 تسک: ${action.text}`, `پروژه: ${resolved.project?.name ?? "عمومی"}`];
    if (resolved.due_at) parts.push(`سررسید: ${resolved.due_at}`); if (resolved.remind_at) parts.push(`یادآوری: ${resolved.remind_at}`);
    return { line: parts.join(" — "), task: { id: r.id, text: action.text }, kind: "daily" };
  }
  // 0-b3 correction: edits the last created item within 10 minutes (KV
  // pointer). Notes edit in place; expenses go through the confirm card
  // with corrects, so Confirm replaces the old row instead of duplicating.
  // 1-b-4: tasks edit in place via updateTaskFields (UPDATE-only, never
  // delete + recreate, never INSERT); time fields the correction does
  // not mention are left untouched, never silently cleared.
  if (action.type === "correction") {
    const ptr = await getKv(env, correctionKey(userId));
    if (!ptr || (ptr.table !== "notes" && ptr.table !== "expenses" && ptr.table !== "tasks")) return { line: "موردی برای اصلاح در ۱۰ دقیقه‌ی اخیر پیدا نشد؛ مورد را دوباره بفرست.", kind: "daily" };
    if (ptr.table === "tasks") {
      const g = await getTask(env, userId, ptr.id);
      if (!g.ok) return { line: NOT_SAVED_TEXT, kind: "daily" };
      if (!g.task) return { line: "موردی برای اصلاح در ۱۰ دقیقه‌ی اخیر پیدا نشد؛ مورد را دوباره بفرست.", kind: "daily" };
      if (g.task.status !== "open") return { line: "این تسک باز نیست و اصلاح نمی‌شود.", kind: "daily" };
      const fields = { title: action.text };
      if (resolved.due_at != null) fields.dueAt = resolved.due_at;
      if (resolved.remind_at != null) fields.remindAt = resolved.remind_at;
      const r = await updateTaskFields(env, userId, ptr.id, fields);
      if (!r.ok) return { line: NOT_SAVED_TEXT, kind: "daily" };
      await putKv(env, correctionKey(userId), { table: "tasks", id: ptr.id });
      return { line: `✅ تسک اصلاح شد: ${action.text}`, kind: "daily" };
    }
    if (ptr.table === "notes") {
      const old = await firstDb(env, "SELECT id FROM notes WHERE id = ? AND user_id = ?", [ptr.id, userId]);
      if (!old.ok || !old.row) return { line: "موردی برای اصلاح در ۱۰ دقیقه‌ی اخیر پیدا نشد؛ مورد را دوباره بفرست.", kind: "daily" };
      const r = await runDb(env, "UPDATE notes SET text = ? WHERE id = ? AND user_id = ?", [action.text, ptr.id, userId]);
      if (!r.ok) return { line: NOT_SAVED_TEXT, kind: "daily" };
      await putKv(env, correctionKey(userId), { table: "notes", id: ptr.id });
      return { line: `✅ یادداشت اصلاح شد: ${action.text}`, kind: "daily" };
    }
    const ex = parseExpense(action.text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered }, action.text);
    if (ex?.error) return { line: `💰 ${action.text} — مبلغ را دوباره بگو؟`, kind: "daily" };
    await startConfirm(env, o, "expense", { ...ex, corrects: { table: "expenses", id: ptr.id } });
    return { line: `💰 خرج: ${ex.amount} ${ex.currency}${ex.item ? ` — ${ex.item}` : ""} (در انتظار تایید)`, direct: true, kind: "daily" };
  }
  if (action.type === "expense" || action.type === "income") {
    const ex = parseExpense(action.text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered }, action.text);
    if (ex?.error || ex.amount !== resolved.amount || ex.currency !== resolved.currency) return { line: `💰 ${action.text} — مبلغ را دوباره بگو؟`, kind: "daily" };
    await startConfirm(env, o, action.type, ex);
    return { line: `💰 ${action.type === "income" ? "درآمد" : "خرج"}: ${ex.amount} ${ex.currency}${ex.item ? ` — ${ex.item}` : ""} (در انتظار تایید)`, direct: true, kind: "daily" };
  }
  if (action.type === "query") {
    const q = action.query;
    // 1-b-2: task query renders the paginated list — bare request ->
    // open list, resolved project -> pre-filtered list. Decision 4:
    // the period phrase is IGNORED and the reply never implies a
    // period filter was applied. Unresolved projects never reach
    // here (they take the lone-project card path in runInterpPolicy).
    if (q.kind === "task") { const rendered = await renderTaskList(env, userId, resolved.project?.id ?? null, 0); return { line: rendered.text, keyboard: rendered.keyboard, kind: "daily" }; }
    if (q.kind === "note") { const rows = await allDb(env, "SELECT text FROM notes WHERE user_id = ? ORDER BY id DESC LIMIT 5", [userId]); return { line: rows.length ? rows.map((r) => `• ${r.text}`).join("\n") : "یادداشتی پیدا نشد.", kind: "daily" }; }
    // The query action carries its own period phrase; no rule re-derivation.
    const sums = await queryExpenseSums(env, userId, rangeForPeriod(q.periodText, ctx.now));
    const keys = Object.keys(sums);
    return { line: keys.length ? keys.map((k) => `${k}: ${sums[k]}`).join("\n") : "در این بازه خرجی ثبت نشده است.", kind: "daily" };
  }
  if (action.type === "translate") {
    const targetName = action.target === "en" ? "English" : action.target === "fa" ? "Persian" : action.target === "ar" ? "Arabic" : "";
    await o.chat(action.text, { systemPrompt: `Translate the following text${targetName ? ` to ${targetName}` : ""}. Reply with only the translation.`, saveText: "", noHistory: true });
    return { line: `🌐 ترجمه: ${action.text}`, direct: true, kind: "chat" };
  }
  if (action.type === "setting") {
    const c2 = classifyDaily(action.text ?? o.text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered });
    if (c2.intent === "remember" && !c2.refused) {
      const r = await setSetting(env, userId, c2.setting.key, c2.setting.value);
      await o.send(r.ok ? `✅ ذخیره شد: ${c2.setting.key} = ${c2.setting.value}` : NOT_SAVED_TEXT);
    } else await o.send("در این قدم فقط تنظیم‌ها نگه داشته می‌شوند؛ خاطره‌های آزاد در قدم حافظه می‌آیند");
    return { line: `⚙️ تنظیم: ${action.text}`, direct: true, kind: "daily" };
  }
  if (action.type === "dev_hint") { await o.send(freeTextDevSuggestion()); return { line: "💻 پیشنهاد /dev", direct: true, kind: "chat" }; }
  if (action.type === "chat") { await o.chat(o.text, { saveText: "" }); return { line: "💬 چت", direct: true, kind: "chat" }; }
  return { line: "⏭ موردی اجرا نشد.", kind: "daily" };
}
// Validate + execute actions per v3 3.5. A lone "project" validation error
// yields the 0-b3 project-choice card (never auto-create); other skips get
// type buttons (single) or a skipped line (multi).
export async function runInterpPolicy(env, o, ctx, actions, finalize) {
  // 1-b-1: validation and card rows use the resolved list (D1 rows, or
  // the seed fallback on genuine empty). On a project-read failure the
  // failure path runs — no seed names, no assumed project, row stays pending.
  const rp = await resolveProjects(env, o.userId);
  if (!rp.ok) { await sendInterpUnavailable(env, o, o.text, o.entryMessageId ?? null); return "handled"; }
  const projects = rp.projects;
  const outcomes = [];
  for (const a of actions) {
    const v = validateInterpreterAction(a, { projects, nowMs: ctx.now, defaultCurrency: ctx.remembered });
    if (!v.ok && v.errors.length === 1 && v.errors[0] === "project") { outcomes.push({ projectChoice: true, action: a, unknown: a.type === "query" && a.query ? a.query.project : a.project }); continue; }
    if (!v.ok || a.confidence < 0.6 || a.needs !== "none") { outcomes.push({ skipped: true, action: a, errors: v.errors ?? [] }); continue; }
    outcomes.push(await executeInterpAction(env, o, ctx, a, v.resolved));
  }
  if (actions.length === 1) {
    const one = outcomes[0];
    if (one.projectChoice) {
      await finalize("daily");
      const id = await newInterpRecord(env, o.userId, { text: o.text, action: one.action });
      const rows = projects.map((p, i) => [{ text: p.name, callback_data: `interp:proj:${i}:${id}` }]);
      rows.push([{ text: "➕ پروژه‌ی جدید", callback_data: `interp:proj:new:${id}` }]);
      await o.send(`پروژه‌ی «${one.unknown}» را نمی‌شناسم؛ پروژه‌ی جدید است یا یکی از موجودها؟`, { replyMarkup: { inline_keyboard: rows } });
      return "handled";
    }
    if (one.skipped) { await finalize("daily"); const id = await newInterpRecord(env, o.userId, { text: o.text }); await o.send("نوعش را بگو:", { replyMarkup: { inline_keyboard: interpTypeKeyboard(id) } }); return "handled"; }
    if (one.direct) { await finalize(one.kind); return "handled"; }
    if (one.note) { await finalize("daily"); const id = await newInterpRecord(env, o.userId, { table: "notes", id: one.note.id, text: one.note.text }); await o.send("✅ یادداشت ذخیره شد.", { replyMarkup: { inline_keyboard: noteCardKeyboard(id) } }); return "handled"; }
    if (one.task) {
      await finalize("daily");
      // 1-b-3: the stored-task card carries the change-type button (its
      // own interp record, so interp:change can offer the type choices
      // for this task). Multi-action summary rows keep delete-only.
      const cardId = await newInterpRecord(env, o.userId, { table: "tasks", id: one.task.id, text: one.task.text });
      await o.send(one.line, { replyMarkup: { inline_keyboard: [[{ text: "🗑 حذف تسک", callback_data: `task:del:${one.task.id}` }, { text: "🔄 تغییر نوع", callback_data: `interp:change:${cardId}` }]] } });
      return "handled";
    }
    // 1-b-2: a list result carries its keyboard (split at 4096 by
    // sendListMessage); other single results send plain as before.
    if (one.keyboard) { await finalize("daily"); await sendListMessage(o, { text: one.line, keyboard: one.keyboard }); return "handled"; }
    await finalize("daily");
    await o.send(one.line);
    return "handled";
  }
  await finalize("daily");
  const keyboard = [];
  let n = 0, m = 0;
  for (const r of outcomes) {
    if (r.note) { n++; const id = await newInterpRecord(env, o.userId, { table: "notes", id: r.note.id, text: r.note.text, multi: true }); keyboard.push([{ text: `🗑 یادداشت ${n}`, callback_data: `interp:del:${id}` }]); }
    // 1-b-2: per-task summary buttons arrive with the list keyboard
    // work (the 1-b-1 boundary); delete via task:del like single cards.
    if (r.task) { m++; keyboard.push([{ text: `🗑 تسک ${m}`, callback_data: `task:del:${r.task.id}` }]); }
  }
  const lines = outcomes.map((r) => r.line ?? (r.projectChoice ? `⏭ پروژه شناخته نشد: ${r.unknown}` : "⏭ موردی اجرا نشد."));
  await o.send(lines.join("\n"), keyboard.length ? { replyMarkup: { inline_keyboard: keyboard } } : undefined);
  return "handled";
}
// Shared interpreter run (initial + retry): prompt -> interpret -> policy.
// The caller owns the pending row; on failure the row STAYS pending (the
// Phase 0 no-drop invariant) and the reply gains a Retry button. No
// re-gating, no re-save: the retry re-runs interpretation only, and each
// tap is a user action, so a repeated failure is not a loop.
async function interpretAndExecute(env, o, ctx, text, rowId, finalize) {
  const recent = (await recentMessages(env, o.userId, 4)).filter((r) => r.kind !== "pending").reverse().slice(-3).map((r) => r.content).filter((c) => typeof c === "string" && c);
  // Circuit breaker (0-b2): while flagged, no Workers AI call is attempted;
  // the failure reply (with the backup button) is sent instead. A suppressed
  // attempt records no new breaker error or breaker state — the flag's TTL
  // governs lifting — but the failure reply still creates its KV failure
  // record, so the Retry/Backup buttons on that message keep working.
  if (await breakerFlag(env)) { await sendInterpUnavailable(env, o, text, rowId); return "handled"; }
  // 1-b-1: the prompt uses the resolved list; on a project-read failure
  // the failure path runs instead (no seed names shown).
  const rp = await resolveProjects(env, o.userId);
  if (!rp.ok) { await sendInterpUnavailable(env, o, text, rowId); return "handled"; }
  const prompt = buildInterpreterPrompt({ text, source: o.source === "voice" ? "voice" : "text", recentTurns: recent, openQuestion: null, projects: rp.projects, nowIso: iranIso(ctx.now), defaultCurrency: ctx.remembered });
  const res = await interpretText(env, o.interpreterModel ?? env.INTERPRETER_MODEL ?? null, prompt, o.interpreterCallFn ?? null);
  if (!res.ok) { await recordInterpError(env, res.reason); await sendInterpUnavailable(env, o, text, rowId); return "handled"; }
  return runInterpPolicy(env, o, ctx, res.actions, finalize);
}
// Failure reply: the unavailable message + type buttons + a Retry button
// + the external-backup button (0-b2). The message row IS stored
// (pending); only the domain action is not. The record carries rowId so
// the backup tap can finalise the same pending row on success.
async function sendInterpUnavailable(env, o, text, rowId) {
  const id = await newInterpRecord(env, o.userId, { text, rowId: rowId ?? null });
  const keyboard = [...interpTypeKeyboard(id)];
  keyboard.push([{ text: "🌐 تفسیر با مدل بیرونی", callback_data: `interp:backup:${id}` }]);
  if (rowId) keyboard.push([{ text: "🔄 ارسال مجدد", callback_data: `retry:${rowId}` }]);
  await o.send(INTERP_UNAVAILABLE_TEXT, { replyMarkup: { inline_keyboard: keyboard } });
}
// ── Phase 0-b2: external backup + circuit breaker (v3 3.7) ──
// Breaker state is written ONLY on interpreter error: the error-timestamp
// list and the breaker flag. (The failure reply's KV record, which the
// Retry/Backup buttons need, is UI state, not breaker state, and is
// written for suppressed attempts too.) A successful call writes nothing, so "3 consecutive
// errors" is approximated by 3 errors inside a rolling 2-minute window
// (a success between errors does not clear the list — see diff header).
const BREAKER_FLAG_KEY = "interp:breaker:flag";
const BREAKER_ERRORS_KEY = "interp:breaker:errors";
const BREAKER_WINDOW_MS = 120000, BREAKER_MAX_ERRORS = 3, BREAKER_TTL_SEC = 300;
async function putKvTtl(env, key, value, ttlSec) { if (!env.STATE) return; try { await env.STATE.put(key, JSON.stringify(value), { expirationTtl: ttlSec }); } catch {} }
function quotaResetMs(now) { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); }
async function breakerFlag(env) {
  const f = await getKv(env, BREAKER_FLAG_KEY);
  if (!f) return null;
  if (f.until === "quota") return Date.now() < quotaResetMs(Date.now()) ? f : null;
  return typeof f.until === "number" && Date.now() < f.until ? f : null;
}
async function recordInterpError(env, reason) {
  if (!env.STATE) return;
  const now = Date.now();
  if (reason === "quota") { await putKvTtl(env, BREAKER_FLAG_KEY, { until: "quota" }, Math.max(60, Math.round((quotaResetMs(now) - now) / 1000))); return; }
  const prev = (await getKv(env, BREAKER_ERRORS_KEY)) || {};
  const list = (Array.isArray(prev.list) ? prev.list : []).filter((t) => now - t < BREAKER_WINDOW_MS);
  list.push(now);
  await putKvTtl(env, BREAKER_ERRORS_KEY, { list }, Math.round(BREAKER_WINDOW_MS / 1000));
  if (list.length >= BREAKER_MAX_ERRORS) await putKvTtl(env, BREAKER_FLAG_KEY, { until: now + BREAKER_TTL_SEC * 1000 }, BREAKER_TTL_SEC);
}
// Backup masking: only the message itself goes out — no history, no
// project list. Phones -> {P1}, links -> {U1}, amounts -> {A1}, in ONE
// replace pass (so a later class can never re-mask the digit inside an
// inserted placeholder); every placeholder is restored locally in all
// text-like action fields BEFORE validation/policy, so validators still
// see the real values and a dropped placeholder degrades to an ask,
// never a wrong number.
const SENSITIVE_RE = /https?:\/\/\S+|www\.\S+|(\+98|0098|0)?9\d{9}|[۰-۹0-9]+(?:[٬,،][۰-۹0-9]+)*/g;
function maskSensitive(text) {
  const table = {}; let nP = 0, nU = 0, nA = 0;
  const masked = String(text ?? "").replace(SENSITIVE_RE, (m) => {
    let k;
    if (/^https?:\/\/|^www\./.test(m)) k = `{U${++nU}}`;
    else if (/^(\+98|0098|0)?9\d{9}$/.test(m)) k = `{P${++nP}}`;
    else k = `{A${++nA}}`;
    table[k] = m; return k;
  });
  return { masked, table };
}
function unmaskAction(action, table) {
  const fix = (v) => typeof v === "string" ? v.replace(/\{(?:P|U|A)\d+\}/g, (k) => table[k] ?? k) : v;
  const out = { ...action, text: fix(action.text), due_text: fix(action.due_text), remind_text: fix(action.remind_text), amount_text: fix(action.amount_text) };
  if (action.query) out.query = { ...action.query, periodText: fix(action.query.periodText), project: fix(action.query.project) };
  return out;
}
// Backup call seam: tests inject o.backupCallFn (masked text -> raw JSON
// string), mirroring interpreterCallFn. No provider endpoint is guessed:
// the backup provider is still unchosen (the 3.7 human step), so without
// a seam the production tap reports backup as not connected — never chat,
// never a silent drop. Binding the seam to the chosen provider's endpoint
// is one function, with no masking/policy change.
async function callBackupModel(maskedText, callFn) {
  if (typeof callFn === "function") { try { const raw = await callFn(maskedText); return { ok: true, text: typeof raw === "string" ? raw : "" }; } catch { return { ok: false }; } }
  return { ok: false, reason: "no-provider-binding" };
}
const BACKUP_UNAVAILABLE_TEXT = "مدل بیرونی وصل نیست؛ خودت نوعش را بگو:";
const BACKUP_FAILED_TEXT = "تفسیر با مدل بیرونی هم نشد؛ خودت نوعش را بگو:";
async function runBackupInterpretation(env, o, text, rowId, finalize) {
  const userId = o.fromId ?? o.userId;
  const oo = { ...o, userId, text };
  if (!o.backupCallFn && (!env.INTERPRETER_BACKUP_MODEL || !env.INTERPRETER_BACKUP_KEY)) {
    const id = await newInterpRecord(env, userId, { text });
    await oo.send(BACKUP_UNAVAILABLE_TEXT, { replyMarkup: { inline_keyboard: interpTypeKeyboard(id) } });
    return true;
  }
  const { masked, table } = maskSensitive(text);
  const raw = await callBackupModel(masked, o.backupCallFn ?? null);
  const parsed = raw.ok ? parseInterpreterOutput(raw.text) : { ok: false };
  if (!parsed.ok) {
    const id = await newInterpRecord(env, userId, { text });
    await oo.send(BACKUP_FAILED_TEXT, { replyMarkup: { inline_keyboard: interpTypeKeyboard(id) } });
    return true;
  }
  const ctx = { now: o.nowMs ?? Date.now(), remembered: await getDefaultCurrency(env, userId) };
  return runInterpPolicy(env, oo, ctx, parsed.actions.map((a) => unmaskAction(a, table)), finalize);
}
// Interpreter path (v3 3.1): the entry row was already saved as pending by
// handleDailyText, so this only finalises it. An entry-save failure falls
// back to today's chat path with no crash, as before.
export async function handleInterpreterText(env, o, ctx) {
  if (o._entrySaveFailed) return "chat";
  const { userId, text } = o;
  const finalize = (kind) => { if (o.entryMessageId && !o._entryFinalised) { o._entryFinalised = true; return finalizeMessageKind(env, o.entryMessageId, userId, kind); } return Promise.resolve({ ok: false }); };
  return interpretAndExecute(env, o, ctx, text, o.entryMessageId ?? null, finalize);
}
// Phase 1-b-3: change-type feedback. Silent best-effort, D1 only, never
// logs: a recording failure never changes the reply and never blocks
// the re-type. Recorded ONLY on a completed re-type via a change-type
// tap (never on every interpreter verdict, correction, or button
// fallback; never on a no-op, a honesty-line refusal, or a failed
// attempt). "Completed" means the target action's delivery finished:
// chat sent, note stored + task deleted, or the expense confirm card
// shown (the later Confirm is money safety, not the type correction).
// project is the re-typed item's project NAME, or null.
async function recordChangeTypeFeedback(env, userId, text, predictedType, correctType, projectId) {
  try {
    let project = null;
    if (projectId !== null && projectId !== undefined) { const p = await getProject(env, userId, projectId); if (p) project = p.name; }
    await insertIntentFeedback(env, { userId, text, predictedType, correctType, project });
  } catch {}
}

// Phase 1-b-3 (amendment 5a): adoption check for a task -> note retry
// whose note insert succeeded but whose progress write did not. Adopts
// ONLY the most recent note matching the task title and project exactly
// AND created after this conversion started; anything else re-inserts.
// A duplicate is never risked on an unproven adoption — but note the
// honest limit: an independent note with identical text/project created
// inside the same window is indistinguishable from the conversion's own.
async function adoptConversionNote(env, userId, rec, task) {
  const rows = await allDb(env, "SELECT id, text, project_id, created_at FROM notes WHERE user_id = ? ORDER BY id DESC LIMIT 20", [userId]);
  const started = new Date(rec.startedAtMs ?? 0).toISOString();
  const hit = rows.find((r) => r.text === rec.text && (r.project_id ?? null) === (task.project_id ?? null) && String(r.created_at ?? "") >= started);
  return hit ? hit.id : null;
}

// Phase 1-b-3 (amendment 5): task conversion chains, driven by the
// changeTaskId record. The record SURVIVES failures (progress fields
// noteId/chatSent/target) and is dropped ONLY at a defined end state:
// converted, no-op, finally-failed (task gone with nothing to resume),
// or a final stop (unextractable amount). Transient failures keep the
// record and the reply carries a Retry button (interp:retrytask:<id>)
// that resumes from the recorded stage — never restarts blindly.
//  - task -> note: note first (task title as note text, task's project,
//    task's source), then record noteId, then verified delete. Insert
//    failure -> task untouched, noteId null, retry re-attempts insert
//    (after the adoption check). Delete failure -> note stays, task
//    stays open, record keeps noteId, retry deletes only.
//  - task -> chat: chat first, then IMMEDIATELY chatSent:true (no other
//    awaited work between), then verified delete. Chat failure -> task
//    untouched, chatSent false, retry re-sends. Delete failure -> chat
//    already delivered (cannot be unsent), task stays open, record keeps
//    chatSent:true, retry deletes only, chat count stays 1. Residual
//    risk (honest): if the mark-write itself fails after a successful
//    chat-send, a later retry cannot know and would re-send — at worst
//    a repeated chat answer, never a lost task or duplicated task.
//  - task -> expense: amount parse first (unextractable -> stop message,
//    task kept, no confirm card, mirroring the note rule), then the
//    confirm card with taskId (Amendment 6 chain lives in
//    confirmExpenseDraft); Cancel -> task untouched, draft deleted.
//  - task -> task: no-op message. Success is reported ONLY after the
//    full chain completes; a FAILED attempt transiently leaves both
//    records alive with an explicit failure reply and a kept record —
//    that is a failed attempt, not a completed conversion.
async function runTaskConversion(env, o, rec, choice, recordId) {
  const userId = o.userId;
  const drop = () => delKv(env, interpKey(recordId));
  const keep = (patch) => putKv(env, interpKey(recordId), { ...rec, ...patch });
  const retryKeyboard = { replyMarkup: { inline_keyboard: [[{ text: "🔄 تلاش مجدد", callback_data: `interp:retrytask:${recordId}` }]] } };
  const failRetry = async (text) => { await o.send(text, retryKeyboard); };
  if (!rec.target) { rec = { ...rec, target: choice }; await keep({ target: choice }); }
  const g = await getTask(env, userId, rec.changeTaskId);
  if (!g.ok) { await failRetry(NOT_SAVED_TEXT); return true; }
  if (!g.task) { await drop(); await o.send(EXPIRED_TEXT); return true; }
  const task = g.task;
  if (task.status !== "open") { await drop(); await o.send(EXPIRED_TEXT); return true; }
  if (choice === "task") { await drop(); await o.send("این مورد همین حالا تسک است."); return true; }
  if (choice === "expense") {
    const ctx = { now: o.nowMs ?? Date.now(), remembered: await getDefaultCurrency(env, userId) };
    const ex = parseExpense(rec.text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered }, rec.text);
    if (ex?.error) { await drop(); await o.send("مبلغ از متن تسک قابل استخراج نیست؛ تبدیل متوقف شد و تسک دست‌نخورده باقی ماند."); return true; }
    await startConfirm(env, o, "expense", { ...ex, taskId: task.id });
    await recordChangeTypeFeedback(env, userId, rec.text, "task", "expense", task.project_id ?? null);
    await drop();
    return true;
  }
  if (choice === "note") {
    let noteId = rec.noteId ?? null;
    if (!noteId) {
      noteId = await adoptConversionNote(env, userId, rec, task);
      if (noteId) await keep({ noteId });
      if (!noteId) {
        const r = await insertNoteRow(env, userId, rec.text, task.source === "voice" ? "voice" : "text", task.project_id ?? null);
        if (!r.ok) { await failRetry(NOT_SAVED_TEXT); return true; }
        noteId = r.id;
        await keep({ noteId });
      }
    }
    const d = await setTaskStatus(env, userId, task.id, "deleted");
    if (!d.ok) {
      const g2 = await getTask(env, userId, task.id);
      if (g2.ok && g2.task && g2.task.status !== "open") { await drop(); await recordChangeTypeFeedback(env, userId, rec.text, "task", "note", task.project_id ?? null); await o.send("✅ تسک به یادداشت تبدیل شد."); return true; }
      await failRetry(NOT_SAVED_TEXT); return true;
    }
    await drop();
    await recordChangeTypeFeedback(env, userId, rec.text, "task", "note", task.project_id ?? null);
    await o.send("✅ تسک به یادداشت تبدیل شد.");
    return true;
  }
  if (choice === "chat") {
    if (!rec.chatSent) {
      try { await o.chat(rec.text, { saveText: "" }); } catch { await failRetry(NOT_SAVED_TEXT); return true; }
      await keep({ chatSent: true });
    }
    const d = await setTaskStatus(env, userId, task.id, "deleted");
    if (!d.ok) {
      const g2 = await getTask(env, userId, task.id);
      if (g2.ok && g2.task && g2.task.status !== "open") { await drop(); await recordChangeTypeFeedback(env, userId, rec.text, "task", "chat", task.project_id ?? null); await o.send("✅ تسک به چت تبدیل شد."); return true; }
      await o.send("💬 چت ارسال شد، ولی تسک حذف نشد؛ با «تلاش مجدد» فقط حذف انجام می‌شود و چت دوباره ارسال نمی‌شود.", retryKeyboard);
      return true;
    }
    await drop();
    await recordChangeTypeFeedback(env, userId, rec.text, "task", "chat", task.project_id ?? null);
    await o.send("✅ تسک به چت تبدیل شد.");
    return true;
  }
  await drop(); await o.send(EXPIRED_TEXT); return true;
}

// Interpreter callbacks: type choice, note delete, external backup,
// and (0-b3) change-type, task card, and project choice. Owner-checked;
// expired records get the fixed message.
export async function resolveInterpCallback(env, o) {
  // 0-b3 project choice: re-run the stored action with the chosen seed
  // project; "new" never auto-creates (projects arrive with Phase 1-a).
  const pm = /^interp:proj:(new|\d+):(.+)$/.exec(o.data);
  if (pm) {
    const rec = await getKv(env, interpKey(pm[2]));
    if (!rec) { await o.send(EXPIRED_TEXT); return true; }
    if (Number(rec.owner) !== Number(o.fromId)) return true;
    // 1-b-1: rows re-indexed to the resolved list; the alias is written
    // ONLY on this explicit tap (decision 6), never for a seed-fallback
    // row (no id). A project-read failure keeps record + buttons (retryable);
    // a genuine alias-write failure is said honestly, action still runs.
    const rp = pm[1] === "new" || !rec.action ? null : await resolveProjects(env, o.fromId);
    if (rp && !rp.ok) { await o.send(NOT_SAVED_TEXT); return true; }
    await delKv(env, interpKey(pm[2]));
    if (o.editMarkup) await o.editMarkup();
    if (pm[1] === "new" || !rec.action) { await o.send("پروژه‌های تازه با فاز ۱ می‌آیند؛ فعلاً از پروژه‌های موجود یکی را بگو."); return true; }
    const chosen = rp.projects[Number(pm[1])];
    if (!chosen) { await o.send(EXPIRED_TEXT); return true; }
    const unknown = rec.action.query ? rec.action.query.project : rec.action.project;
    if (unknown && chosen.id != null) { const want = normalizeText(unknown).trim(); const same = normalizeText(chosen.name).trim() === want || (Array.isArray(chosen.aliases) && chosen.aliases.some((a) => normalizeText(a).trim() === want)); if (want && !same) { const ar = await addProjectAlias(env, o.fromId, chosen.id, unknown); if (!ar.ok) await o.send("نام مستعار پروژه ذخیره نشد."); } }
    const a2 = chosen && rec.action.query ? { ...rec.action, query: { ...rec.action.query, project: chosen.name } } : { ...rec.action, project: chosen.name };
    const ctx = { now: o.nowMs ?? Date.now(), remembered: await getDefaultCurrency(env, o.fromId) };
    await runInterpPolicy(env, { ...o, userId: o.fromId, text: rec.text }, ctx, [a2], async () => {});
    return true;
  }
  // 0-b3 task card buttons: change re-routes via the type flow; dismiss
  // drops the card (nothing was stored).
  const tm = /^interp:(changetask|taskdismiss):(.+)$/.exec(o.data);
  if (tm) {
    const rec = await getKv(env, interpKey(tm[2]));
    if (!rec) { await o.send(EXPIRED_TEXT); return true; }
    if (Number(rec.owner) !== Number(o.fromId)) return true;
    await delKv(env, interpKey(tm[2]));
    if (o.editMarkup) await o.editMarkup();
    if (tm[1] === "taskdismiss") { await o.send("باشه، تسک کنار گذاشته شد؛ ذخیره با فاز ۱ می‌آید."); return true; }
    const id = await newInterpRecord(env, o.fromId, { text: rec.text });
    await o.send("نوعش را بگو:", { replyMarkup: { inline_keyboard: interpTypeKeyboard(id) } });
    return true;
  }
  // 0-b3 change-type on a stored note card: offer the type choices for
  // that note's text; the type handler below applies change semantics.
  // 1-b-3: a stored TASK card offers the same choice; its record carries
  // changeTaskId and the type handler runs the conversion chains.
  const cm = /^interp:change:(.+)$/.exec(o.data);
  if (cm) {
    const rec = await getKv(env, interpKey(cm[1]));
    if (!rec || (rec.table !== "notes" && rec.table !== "tasks")) { await o.send(EXPIRED_TEXT); return true; }
    if (Number(rec.owner) !== Number(o.fromId)) return true;
    if (o.editMarkup) await o.editMarkup();
    if (rec.table === "tasks") {
      const id = await newInterpRecord(env, o.fromId, { text: rec.text, changeTaskId: rec.id, startedAtMs: Date.now() });
      await o.send("نوعش را بگو:", { replyMarkup: { inline_keyboard: interpTypeKeyboard(id) } });
      return true;
    }
    const id = await newInterpRecord(env, o.fromId, { text: rec.text, changeNoteId: rec.id });
    await o.send("نوعش را بگو:", { replyMarkup: { inline_keyboard: interpTypeKeyboard(id) } });
    return true;
  }
  // Retry (Phase 0-b fix): callback_data retry:{pending D1 row id}. The row
  // id is used — not the Telegram message id — because the button must sit
  // inside the failure message itself, whose id is unknowable before it is
  // sent, and no tg-message-id column exists without a migration (out of
  // scope for 0-b). The original text is loaded from that pending row,
  // scoped by user id; interpretation re-runs only, with no re-gating and
  // no second row. A repeated failure re-shows the same reply + Retry.
  const rm = /^retry:(\d+)$/.exec(o.data);
  if (rm) {
    const rowId = Number(rm[1]);
    const row = await firstDb(env, "SELECT id, user_id, content FROM messages WHERE id = ? AND kind = 'pending'", [rowId]);
    if (!row.ok || !row.row) {
      const id = await newInterpRecord(env, o.fromId, { text: "" });
      await o.send("متن پیام پیدا نشد؛ لطفاً پیام را دوباره بفرست:", { replyMarkup: { inline_keyboard: interpTypeKeyboard(id) } });
      return true;
    }
    if (Number(row.row.user_id) !== Number(o.fromId)) return true;
    if (o.editMarkup) await o.editMarkup();
    const ctx = { now: o.nowMs ?? Date.now(), remembered: await getDefaultCurrency(env, o.fromId) };
    const oo = { ...o, userId: o.fromId, text: row.row.content, entryMessageId: rowId };
    const finalize = (kind) => { if (!oo._entryFinalised) { oo._entryFinalised = true; return finalizeMessageKind(env, rowId, o.fromId, kind); } return Promise.resolve({ ok: false }); };
    await interpretAndExecute(env, oo, ctx, row.row.content, rowId, finalize);
    return true;
  }
  // 1-b-3: task-conversion Retry. The record carries the target and the
  // progress fields, so the retry resumes from the recorded stage
  // (delete-only after a note insert / chat send) — never a blind
  // restart. A missing record or a record without a conversion target
  // gets the fixed expired message; a foreign tap is silent.
  const rt = /^interp:retrytask:(.+)$/.exec(o.data);
  if (rt) {
    const rec = await getKv(env, interpKey(rt[1]));
    if (!rec || !rec.changeTaskId || !rec.target) { await o.send(EXPIRED_TEXT); return true; }
    if (Number(rec.owner) !== Number(o.fromId)) return true;
    if (o.editMarkup) await o.editMarkup();
    const oo = { ...o, userId: o.fromId, text: rec.text };
    await runTaskConversion(env, oo, rec, rec.target, rt[1]);
    return true;
  }
  const m = /^interp:(type|del|backup):(.+)$/.exec(o.data);
  if (!m) return false;
  const [, action, rest] = m;
  // External backup (0-b2): user tap only. The record is kept, not
  // deleted: on backup failure a fresh type-button message is sent, and
  // the old buttons were already cleared by editMarkup below.
  if (action === "backup") {
    const rec = await getKv(env, interpKey(rest));
    if (!rec) { await o.send(EXPIRED_TEXT); return true; }
    if (Number(rec.owner) !== Number(o.fromId)) return true;
    if (!rec.text?.trim()) { await o.send("متن پیام پیدا نشد؛ لطفاً پیام را دوباره بفرست:"); return true; }
    if (o.editMarkup) await o.editMarkup();
    const rowId = Number(rec.rowId) || null;
    let done = false;
    const finalize = (kind) => { if (!rowId || done) return Promise.resolve({ ok: false }); done = true; return finalizeMessageKind(env, rowId, o.fromId, kind); };
    await runBackupInterpretation(env, o, rec.text, rowId, finalize);
    return true;
  }
  if (action === "type") {
    const tm = /^(\w+):(.+)$/.exec(rest);
    if (!tm) return true;
    const [, choice, id] = tm;
    const rec = await getKv(env, interpKey(id));
    if (!rec) { await o.send(EXPIRED_TEXT); return true; }
    if (Number(rec.owner) !== Number(o.fromId)) return true;
    // Empty-text records exist only from the missing-retry-row fallback;
    // never store or answer from them, just say the text is gone.
    if (!rec.text?.trim()) { await o.send("متن پیام پیدا نشد؛ لطفاً پیام را دوباره بفرست:"); return true; }
    // 1-b-3: a task re-type owns its record lifecycle (progress fields
    // for retry) — it must NOT go through the upfront delete below.
    if (rec.changeTaskId) { if (o.editMarkup) await o.editMarkup(); const oo = { ...o, userId: o.fromId, text: rec.text }; await runTaskConversion(env, oo, rec, choice, id); return true; }
    await delKv(env, interpKey(id));
    if (o.editMarkup) await o.editMarkup();
    const ctx = { now: o.nowMs ?? Date.now(), remembered: await getDefaultCurrency(env, o.fromId) };
    const oo = { ...o, userId: o.fromId, text: rec.text };
    // 0-b3 change-type semantics: the note is the item being re-typed.
    // task -> honesty (note kept, it cannot become a task yet); note ->
    // no-op (it already is one); expense -> confirm, and Confirm deletes
    // the note (a delete failure reports failure and keeps the draft);
    // chat -> note deleted first, chat only if the delete succeeds;
    // unextractable amount -> conversion stops, note kept (0-b3 fix: no
    // amount ask, which would have lost the note association).
    // intent_feedback recording waits for migration 0003 (Phase 1-a).
    // 1-b-3: completed note re-types record feedback (silent best-effort;
    // the note's project is read BEFORE the delete, which would hide it).
    if (rec.changeNoteId) {
      if (choice === "task") { await o.send("تسک‌ها با فاز ۱ می‌آیند."); return true; }
      if (choice === "note") { await o.send("این مورد همین حالا یادداشت است."); return true; }
      if (choice === "chat") { const np = await firstDb(env, "SELECT project_id FROM notes WHERE id = ? AND user_id = ?", [rec.changeNoteId, o.fromId]); const d = await runDb(env, "DELETE FROM notes WHERE id = ? AND user_id = ?", [rec.changeNoteId, o.fromId]); if (!d.ok) { await o.send(NOT_SAVED_TEXT); return true; } await o.chat(rec.text, { saveText: "" }); await recordChangeTypeFeedback(env, o.fromId, rec.text, "note", "chat", np.row?.project_id ?? null); return true; }
      const ex = parseExpense(rec.text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered }, rec.text);
      if (ex?.error) { await o.send("مبلغ از متن یادداشت قابل استخراج نیست؛ تبدیل متوقف شد و یادداشت دست‌نخورده باقی ماند."); return true; }
      const np = await firstDb(env, "SELECT project_id FROM notes WHERE id = ? AND user_id = ?", [rec.changeNoteId, o.fromId]);
      await startConfirm(env, oo, "expense", { ...ex, noteId: rec.changeNoteId }); await recordChangeTypeFeedback(env, o.fromId, rec.text, "note", "expense", np.row?.project_id ?? null); return true;
    }
    if (choice === "task") { await o.send("تسک‌ها با فاز ۱ می‌آیند."); return true; }
    if (choice === "note") { const r = await insertNoteRow(env, o.fromId, rec.text, "text"); if (r.ok) { const nid = await newInterpRecord(env, o.fromId, { table: "notes", id: r.id, text: r.text }); await o.send("✅ یادداشت ذخیره شد.", { replyMarkup: { inline_keyboard: noteCardKeyboard(nid) } }); } else await o.send(NOT_SAVED_TEXT); return true; }
    if (choice === "expense") {
      const ex = parseExpense(rec.text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered }, rec.text);
      if (ex?.error) { await setPendingAsk(env, o.fromId, askText("amount"), undefined, "amount"); await o.send(askText("amount")); return true; }
      await startConfirm(env, oo, "expense", ex); return true;
    }
    await o.chat(rec.text, { saveText: "" }); return true;
  }
  const rec = await getKv(env, interpKey(rest));
  if (!rec) { await o.send(EXPIRED_TEXT); return true; }
  if (Number(rec.owner) !== Number(o.fromId)) return true;
  await delKv(env, interpKey(rest));
  // Multi-item delete buttons must survive for the other items: only a
  // single-note card clears its message's markup. A second tap on the
  // same button finds no record and gets the fixed expired message.
  if (!rec.multi && o.editMarkup) await o.editMarkup();
  if (rec.table === "notes" && rec.id) await runDb(env, "DELETE FROM notes WHERE id = ? AND user_id = ?", [rec.id, o.fromId]);
  await o.send("🗑 حذف شد."); return true;
}

// Phase 3-A: secure file/archive vault helpers.

function stripCaptionPrefix(caption) {
  return String(caption ?? "").replace(/^(?:ذخیره\s*[-:]\s*|ثبت\s*[-:]\s*|ذخیره‌اش\s*کن\s*|ثبت‌اش\s*کن\s*|بذر\s*)/u, "").trim() || null;
}

// Strips a conversational naming prefix ("بذار آخرین آزمایش" -> "آخرین آزمایش").
// Returns null unless an actual naming prefix was present, so a pending
// upload is never renamed by an unrelated message.
function stripNamingPrefix(text) {
  const t = String(text ?? "");
      const m = /^(?:بذار\s+|اسمش\s+رو\s+بذار\s+|عنوانش\s+رو\s+بذار\s+|ذخیره\s*[-:]\s*کن\s*به\s*اسم\s*|ثبت\s*[-:]\s*کن\s+|ذخیره\s+به\s*اسم\s*|ثبت\s+به\s*اسم\s*)\s*([\s\S]+)$/u.exec(t);
  return m ? m[1].trim() || null : null;
}

// Escapes Telegram markdown metacharacters so user content stays literal.
function mdEscape(s) { return String(s ?? "").replace(/\*\*/g, "* *").replace(/`/g, "\\`"); }

function csvField(v) {
  const s = String(v ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function csvRow(...fields) { return fields.map(csvField).join(","); }

async function fileBytesFromTelegram(env, tgFileId) {
  const data = await getFileDownloadData(env, tgFileId);
  if (!data) return null;
  return data.data instanceof Uint8Array ? data.data : new Uint8Array(data.data ?? []);
}

const VAULT_CAPTION_RE = /(?:ذخیره|آرشیو|گاوصندوق|ثبت)\s*(?:کن)?|(?:کارت\s*ملی|شناسنامه|پاسپورت|گواهینامه|بیمه\s*نامه|بیمه‌نامه|آزمایش|سند|مدرک|قرارداد)/i;
const VISION_CAPTION_RE = /(?:تحلیل|بررسی|بخون|بخوان|ترجمه|توضیح|چیه|چیست|خلاصه|OCR)/i;

async function analyzeVaultImage(env, file, prompt) {
  const data = await getFileDownloadData(env, file.tg_file_id);
  if (!data || !env?.GEMINI_API_KEY) return null;
  const arr = new Uint8Array(data.data);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  const b64 = btoa(bin);
  const mime = file.mime_type || "image/jpeg";
  const userPrompt = prompt ? `${prompt}\\n` : "";
  const fullPrompt = `${userPrompt}لطفاً این تصویر/فایل را تحلیل کن، متن آن را استخراج کن و به فارسی پاسخ بده.`;
  for (const model of ["gemini-2.5-flash", "gemini-2.0-flash"]) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: fullPrompt }, { inline_data: { mime_type: mime, data: b64 } }] }] }) });
      const json = await res.json().catch(() => null);
      const text = (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
      if (res.ok && text) return text;
    } catch {}
  }
  return null;
}

// Case A (caption) / Case B (no caption) for incoming document/photo uploads.
export async function handleVaultFile(env, o) {
  const { userId, chatId, tgFileId, fileType, mimeType, fileName, caption, send } = o;
  if (!dbOf(env)) return false;
  const cap = typeof caption === "string" ? caption.trim() : "";
  // Case 1: explicit vault caption
  if (cap && VAULT_CAPTION_RE.test(cap)) {
    const title = stripCaptionPrefix(cap) || stripNamingPrefix(cap) || cap;
    const saved = await saveVaultFile(env, { userId, tgFileId, fileType, mimeType, title, fileName, caption: cap, syncStatus: "local" });
    if (!saved || !saved.ok) { await send(NOT_SAVED_TEXT); return true; }
    let syncInfo = "";
    if (saved.ok) {
      const bytes = await fileBytesFromTelegram(env, tgFileId);
      const sync = await syncVaultFileToGoogle(env, { id: saved.id, userId, label: title, fileName, mimeType, data: bytes ?? new Uint8Array(0), createdAt: new Date().toISOString() });
      await setFileSyncStatus(env, userId, saved.id, sync.ok ? "synced" : "pending_google", sync.googleId ?? null, null);
      syncInfo = sync.ok ? `\\n✅ گوگل Docs/Drive${sync.googleId ? ` (${sync.googleId})` : ""}: ذخیره شد` : "\\n⏳ در انتظار همگام‌سازی گوگل";
    }
    await send(`🔒📁 مدرک «**${mdEscape(title)}**» در آرشیو امن ذخیره شد.${syncInfo}`);
    return true;
  }
  // Case 2: explicit vision/analysis caption
  if (cap && VISION_CAPTION_RE.test(cap)) {
    const f = { tg_file_id: tgFileId, mime_type: mimeType, file_type: fileType };
    const text = await analyzeVaultImage(env, f, cap);
    await send(text || "تحلیل ممکن نشد.");
    return true;
  }
  // Case 3: no caption / general caption -> choice buttons
  const saved = await saveVaultFile(env, { userId, tgFileId, fileType, mimeType, title: "__choice__", fileName, caption: cap || null, syncStatus: "local" });
  if (!saved.ok) { await send(NOT_SAVED_TEXT); return true; }
  await send("📎 <b>تصویر/فایل دریافت شد. چه کاری انجام دهم؟</b>", { replyMarkup: { inline_keyboard: [
    [{ text: "🔍 تحلیل تصویر / استخراج متن", callback_data: `vault:analyze:${saved.id}` }],
    [{ text: "🔒 ذخیره در گاوصندوق امن", callback_data: `vault:askname:${saved.id}` }],
    [{ text: "❌ انصراف", callback_data: `vault:cancel:${saved.id}` }],
  ] } });
  return true;
}

// Next-turn naming for a pending __pending__ vault upload. Returns true when
// the incoming text/voice named the file.
async function namePendingVaultFile(env, o) {
  const { userId, text, send } = o;
  if (!text || /^\s*\//.test(text)) return false;
  // A07 escape hatch: never consume the user's next turn as a pending-file
  // name when the turn is actually an actionable message or a command.
  const trimmed = String(text).trim();
  const cg = classifyDaily(trimmed, { nowMs: o.nowMs ?? Date.now() });
  if (["note", "task", "task-create", "task-delete", "reminder", "expense", "income", "memory_save", "unsupported_action", "vault_save", "vault_get", "vault_list", "vault_file_get", "command"].includes(cg.intent)) return false;
  if (/(?:یادداشت|تسک|یادآوری)\s*کن/u.test(trimmed) || /یادداشت[^\n]{0,24}(?:ثبت|ذخیره)\s*کن/u.test(trimmed) || /^ثبت\s*کن(?:\s|$)/u.test(trimmed)) return false;
  if (/لغو|انصراف/.test(trimmed)) return false;
  const cleanTitle = stripNamingPrefix(text) || trimmed;
  if (!cleanTitle) return false;
  let pend = await resolvePendingVaultFile(env, Number(userId), cleanTitle);
  if (!pend.ok || !pend.file) {
    pend = await resolvePendingVaultFile(env, userId, cleanTitle);
  }
  if (!pend.ok || !pend.file) return false;
  const f = pend.file;
  const bytes = await fileBytesFromTelegram(env, f.tg_file_id);
  const sync = await syncVaultFileToGoogle(env, { id: f.id, userId, label: f.title, fileName: f.fileName, mimeType: f.mimeType, data: bytes ?? new Uint8Array(0), createdAt: f.created_at });
  await setFileSyncStatus(env, userId, f.id, sync.ok ? "synced" : "pending_google", sync.googleId ?? null, null);
  // A15 honesty: claim Google Docs only when Google actually synced with an id.
  if (sync.ok && sync.googleId) {
    await send(`🔒📁 مدرک «<b>${cleanTitle}</b>» در آرشیو امن و Google Docs ثبت شد.`);
  } else {
    await send(`✅ نام فایل ثبت شد: **${cleanTitle}**${sync.ok ? "" : "\n⏳ در انتظار همگام‌سازی گوگل"}`);
  }
  return true;
}

// Vault callbacks: vault:csv, vault:sync, vault:file:<id>.
export async function resolveVaultCallback(env, o) {
  const analyze = /^vault:analyze:(\d+)$/.exec(o.data);
  if (analyze) {
    const id = Number(analyze[1]);
    const f = await getVaultFile(env, o.fromId, id);
    if (!f) { await o.send("مدرکی پیدا نشد."); return true; }
    const text = await analyzeVaultImage(env, f, null);
    await o.send(text || "تحلیل ممکن نشد.");
    return true;
  }
  const askname = /^vault:askname:(\d+)$/.exec(o.data);
  if (askname) {
    const id = Number(askname[1]);
    const f = await getVaultFile(env, o.fromId, id);
    if (!f) { await o.send("مدرکی پیدا نشد."); return true; }
    const cap = typeof f.caption === "string" ? f.caption.trim() : "";
    if (cap) {
      await runDb(env, "UPDATE vault_files SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?", [cap, new Date().toISOString(), id, o.fromId]);
      const row = await getVaultFile(env, o.fromId, id);
      const bytes = await fileBytesFromTelegram(env, f.tg_file_id);
      const sync = await syncVaultFileToGoogle(env, { id, userId: o.fromId, label: cap, fileName: f.file_name, mimeType: f.mime_type, data: bytes ?? new Uint8Array(0), createdAt: f.created_at });
      await setFileSyncStatus(env, o.fromId, id, sync.ok ? "synced" : "pending_google", sync.googleId ?? null, null);
      await o.send(`🔒📁 مدرک «<b>${cap}</b>» در گاوصندوق امن ذخیره شد.`);
      return true;
    }
    await runDb(env, "UPDATE vault_files SET title = '__pending__', updated_at = ? WHERE id = ? AND user_id = ?", [new Date().toISOString(), id, o.fromId]);
    await o.send("🔒 با چه عنوانی در گاوصندوق امن ذخیره شود؟ (مثلاً بنویسید یا ویس بدهید: «بیمه نامه ۲۰۶» یا «آخرین آزمایش»)");
    return true;
  }
  const cancel = /^vault:cancel:(\d+)$/.exec(o.data);
  if (cancel) {
    const id = Number(cancel[1]);
    await runDb(env, "DELETE FROM vault_files WHERE id = ? AND user_id = ?", [id, o.fromId]);
    if (typeof o.editText === "function") { try { const r = await o.editText("❌ لغو شد."); if (r && r.ok !== false) return true; } catch {} }
    await o.send("❌ لغو شد.");
    return true;
  }
  const csv = /^vault:csv$/.exec(o.data);
  if (csv) {
    const items = (await listVaultItems(env, o.fromId)).items || [];
    const lines = ["ID,Category,Title,Value,Extra,UpdatedAt"];
    for (const it of items) {
      const row = await getVaultItem(env, o.fromId, it.id);
      let value = "";
      try { if (row) value = await decryptVaultValue(env, row.value_enc); } catch {}
      lines.push(csvRow(it.id, it.category ?? "", it.label ?? "", value, it.extra ?? "", it.updated_at ?? ""));
    }
    const body = "\uFEFF" + lines.join("\r\n") + "\r\n";
    await sendDocument(env, o.chatId, "personal-vault.csv", body, { contentType: "text/csv" });
    return true;
  }
  const sync = /^vault:sync$/.exec(o.data);
  if (sync) {
    let done = 0, failed = 0;
    const items = (await listVaultItems(env, o.fromId)).items || [];
    for (const it of items) {
      if (it.sync_status === "synced") continue;
      let value = "";
      try { value = await decryptVaultValue(env, it.value_enc); } catch {}
      const r = await syncVaultItemToGoogle(env, { id: it.id, userId: o.fromId, label: it.label, value, kind: "text", createdAt: it.created_at });
      await setVaultSyncStatus(env, o.fromId, it.id, r.ok ? "synced" : "pending_google", r.googleId ?? null);
      r.ok ? done++ : failed++;
    }
    const files = (await listVaultFiles(env, o.fromId)).files || [];
    for (const f of files) {
      if (f.sync_status === "synced") continue;
      const bytes = await fileBytesFromTelegram(env, f.tg_file_id);
      const r = await syncVaultFileToGoogle(env, { id: f.id, userId: o.fromId, label: f.title, fileName: f.fileName, mimeType: f.mimeType, data: bytes ?? new Uint8Array(0), createdAt: f.created_at });
      await setFileSyncStatus(env, o.fromId, f.id, r.ok ? "synced" : "pending_google", r.googleId ?? null, null);
      r.ok ? done++ : failed++;
    }
    await o.send(`✅ همگام‌سازی گوگل تمام شد: ${done} موفق، ${failed} ناموفق.`);
    return true;
  }
  const file = /^vault:file:(\d+)$/.exec(o.data);
  if (file) {
    const fid = Number(file[1]);
    if (!Number.isSafeInteger(fid) || fid <= 0) return true;
    const f = await getVaultFile(env, o.fromId, fid);
    if (!f) { await o.send("مدرکی پیدا نشد."); return true; }
    const tp = tehranParts(f.created_at);
    const when = tp ? `${formatJalali(tp.date) || tp.date} ${tp.hhmm}` : "";
    const caption = `🔒📁 **${f.title ?? ""}**${when ? `\n🗓 ${when}` : ""}${f.doc_url ? `\n${f.doc_url}` : ""}`;
    const formatted = formatTelegramHtml(caption);
    const payload = { chat_id: o.chatId, caption: formatted, ...(formatted !== caption ? { parse_mode: "HTML" } : {}) };
    if (f.file_type === "photo") await tgApi(env, "sendPhoto", { ...payload, photo: f.tg_file_id });
    else await tgApi(env, "sendDocument", { ...payload, document: f.tg_file_id });
    return true;
  }
  return false;
}

// Everyday text, Phase 0-b: deterministic gates first (commands, bare-note
// ask, fast money, open-question answers), then the interpreter for
// everything else — never directly to chat. Part 2 comment below kept.
// uncertain (ask) or finds no everyday branch (chat). Confident rule
// results never reach a model. Returns "handled", "chat" (normal
// chat/task/dev path), or "chat-direct" (model already said chat for a
// text message, so the caller answers directly and skips classifyIntent).
// Phase 1-e Pillar 2: NLU branch. Runs ONLY after deterministic rules
// returned chat/ask, only when the legacy interpreter is unconfigured
// but the AI binding exists. Returns "handled" when an intent executed,
// null when the caller must fall through (chat intent, low confidence,
// NLU failure, or an unexecutable verdict) — never a drop. Every write
// is re-validated deterministically: note/task bodies non-empty,
// projects resolved against real D1 rows (explicit folder phrase wins
// over the NLU name; a seed fallback has no id and is never attached),
// reminders re-parsed by parseReminder, expenses ONLY via parseExpense's
// integer amount into the 10-minute confirm draft. An executed verdict
// also saves an intent-feedback trace row.
// Phase 2-c: unambiguous-question rule for the NLU skip above.
// A message is unambiguous when it starts with a question word
// (تفاوت / چرا / چطور / چگونه / چیست / چیه) or ends with ? / ؟,
// AND contains no note/task/reminder/expense/project/summary keyword.
// The keyword guard keeps questions like "یادداشت‌هام رو چطور ببینم؟"
// on the NLU path, where they may route to a list instead of chat.
const NLU_SKIP_QUESTION_PREFIXES = ["تفاوت ", "چرا ", "چطور ", "چگونه ", "چیست", "چیه"];
const NLU_SKIP_KEYWORDS = ["یادداشت", "تسک", "یادآوری", "یادم بنداز", "زنگ", "هزینه", "خرج", "پروژه", "پوشه", "خلاصه", "جدول"];
export function isUnambiguousQuestion(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  const startsQ = NLU_SKIP_QUESTION_PREFIXES.some((p) => t.startsWith(p));
  const endsQ = t.endsWith("?") || t.endsWith("؟");
  if (!startsQ && !endsQ) return false;
  return !NLU_SKIP_KEYWORDS.some((k) => t.includes(k));
}

export async function runNluBranch(env, o, ctx) {
  const { userId, text } = o;
  // Phase 2-c: unambiguous questions skip the NLU entirely — 0 AI.run
  // calls and no D1 projects query — and fall through to chat, which
  // is where they always end up anyway. Skipped only when clearly
  // unambiguous (see isUnambiguousQuestion); anything carrying a
  // note/task/reminder/expense/project/summary keyword still runs
  // the NLU, since it might legitimately route to a list or a write.
  if (isUnambiguousQuestion(text)) return null;
  const now = ctx.now ?? o.nowMs ?? Date.now();
  const pres = await resolveProjects(env, userId);
  // Phase 2-g: intent_nlu_diag — one privacy-safe console line per
  // NLU invocation (never message text, slots, or note/task bodies;
  // no KV writes). Emitted only when a model actually resolved, i.e.
  // when env.AI is really invoked; a no-model miss logs nothing.
  // Fields: event, models tried, per-model status, parseOk (a JSON
  // object was extracted — bad-intent still parsed), finalDomain /
  // finalAction (the NLU intent split on "_"), confidence, routedTo
  // (the branch target, "handled" for a write, "chat" on any null),
  // elapsedMs, fallbackReason (null on a routed turn).
  const nluModel = resolveInterpreterModel(env);
  const nluT0 = Date.now();
  const nowIso = iranIso(now);
  const source = o.source || "text";
  let openTasks = [], recentNotes = [], lastAction = ctx.lastAction ?? null;
  try { const tr = await listOpenTasksResult(env, userId, null, 5, 0); if (tr?.ok) openTasks = (tr.tasks || []).map((t) => t.title).filter(Boolean); } catch {}
  try { const nr = await listNotesResult(env, userId, { limit: 5, offset: 0 }); if (nr?.ok) recentNotes = (nr.notes || []).map((n) => n.text).filter(Boolean); } catch {}
  if (!lastAction) lastAction = openTasks[0] ? { kind: "task", title: openTasks[0] } : recentNotes[0] ? { kind: "note", title: recentNotes[0] } : null;
  const nlu = await classifyIntent(env, text, { projects: (pres.projects || []).map((p) => p.name), pendingAsk: null, source, nowIso, lastAction, openTasks, recentNotes });
  let nluRoutedTo = "chat";
  const emitNluDiag = (fallbackReason) => {
    if (!nluModel) return;
    const parts = String(nlu.intent || "").split("_");
    console.log(JSON.stringify({ event: "intent_nlu_diag", models: [nluModel], perModel: [{ model: nluModel, status: nlu.ok ? "ok" : nlu.reason }], parseOk: nlu.ok || nlu.reason === "bad-intent", finalDomain: nlu.ok ? parts[0] : null, finalAction: nlu.ok ? (parts.slice(1).join("_") || null) : null, confidence: nlu.ok ? nlu.confidence : null, routedTo: nluRoutedTo, elapsedMs: Date.now() - nluT0, fallbackReason }));
  };
  if (!nlu.ok || nlu.confidence < 0.75 || nlu.intent === "chat") { emitNluDiag(!nlu.ok ? nlu.reason : nlu.confidence < 0.75 ? "low-confidence" : "chat-intent"); return null; }
  // A05/A13 reference resolution: "همونو برای فردا بذار" etc. resolve
  // against the single recent task/note; with multiple open targets ask
  // a clarification question instead of guessing.
  const isRef = /همونو|همون|اونو|اینو/.test(text);
  const refTargets = [...openTasks.map((t) => ({ kind: "task", title: t })), ...recentNotes.map((t) => ({ kind: "note", title: t }))];
  if (isRef && ["note", "task", "reminder"].includes(nlu.intent) && (!nlu.body || /همونو|همون|اونو|اینو/.test(nlu.body))) {
    if (refTargets.length > 1) {
      nluRoutedTo = nlu.intent;
      await o.send(`کدام مورد را منظورت است؟\n${refTargets.map((t, i) => `${i + 1}. ${t.title}`).join("\n")}`);
      emitNluDiag(null);
      return "handled";
    }
    if (refTargets.length === 1) nlu.body = refTargets[0].title;
  }
  const trace = async (projectName) => { try { await insertIntentFeedback(env, { userId, text, predictedType: nlu.intent, correctType: nlu.intent, project: projectName ?? null }); } catch {} };
  const tag = await resolveFolderTag(env, userId, text);
  const resolveProject = () => {
    if (tag) return { id: tag.project.id, name: tag.project.name };
    if (nlu.project && !pres.fallback) {
      const hit = findProjectByName(pres.projects, nlu.project);
      if (hit) return { id: hit.id, name: hit.name };
    }
    return null;
  };
  const viaBranch = async (cc) => { const r = await runDailyBranch(env, o, cc, ctx); if (r === "handled") nluRoutedTo = cc.intent; return r === "handled" ? "handled" : null; };
  // Phase 2-g: the switch runs inside this wrapper so every arm's
  // return lands in nluOut and exactly one diag line is emitted below
  // (the arms themselves are unchanged).
  const nluOut = await (async () => {
  switch (nlu.intent) {
    case "note":
    case "task": {
      if (!nlu.body || !nlu.body.trim()) return null;
      const proj = resolveProject();
      const body = nlu.intent === "note"
        ? recoverFullNoteBody(text, nlu.body, nlu.leading_framing, nlu.trailing_framing)
        : nlu.body.trim();
      if (!body) return null;
      let r;
      if (nlu.intent === "note") {
        const pid = proj ? proj.id : await defaultProjectId(env, userId);
        const pname = proj ? proj.name : null;
        r = pid === null
          ? await runDb(env, "INSERT INTO notes (user_id, text, source, created_at) VALUES (?, ?, ?, ?)", [userId, body, o.source || "text", new Date().toISOString()])
          : await runDb(env, "INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (?, ?, ?, ?, ?)", [userId, body, o.source || "text", new Date().toISOString(), pid]);
        await o.send(r.ok ? `✅ یادداشت ذخیره شد.${pname ? ` [📁 ${pname}]` : ""}` : NOT_SAVED_TEXT);
        if (r.ok) { await trace(pname); await markDaily(env, o); }
      } else {
        r = await insertTask(env, { userId, title: body, projectId: proj ? proj.id : null, source: o.source === "voice" ? "voice" : "text" });
        await o.send(r.ok ? `✅ تسک ثبت شد.${proj ? ` [📁 ${proj.name}]` : ""}` : NOT_SAVED_TEXT);
        if (r.ok) { await trace(proj ? proj.name : null); await markDaily(env, o); }
      }
      return "handled";
    }
    case "reminder": {
      if (!nlu.body || !nlu.body.trim()) return null;
      // With an explicit folder phrase, the folder-stripped ORIGINAL
      // message is the canonical string (it still carries trigger, date,
      // and hour words for parseReminder); otherwise the canonical
      // string is built from the NLU fields. Either way parseReminder
      // — never the model — decides the due time.
      let canonical;
      if (tag) canonical = tag.body;
      else {
        const datePart = ["امروز", "فردا", "پس‌فردا"].includes(nlu.date_ref) ? nlu.date_ref : "";
        const timePart = nlu.time_ref ? `ساعت ${nlu.time_ref}${nlu.daypart && ["صبح", "عصر", "شب"].includes(nlu.daypart) ? ` ${nlu.daypart}` : ""}` : "";
        canonical = `یادم بنداز ${datePart} ${timePart} ${nlu.body.trim()}`.replace(/\s+/g, " ").trim();
      }
      const r = parseReminder(canonical, now, canonical);
      if (r.ask === "hour-ambiguous" || r.ask === "no-time") {
        await setPendingAsk(env, userId, askText(r.ask), undefined, r.ask, r.ask === "hour-ambiguous" ? canonical : undefined);
        if (r.ask === "hour-ambiguous") await sendHourAmbiguousAsk(o); else await o.send(askText(r.ask));
        return "handled";
      }
      if (r.ask) return viaBranch({ intent: "reminder", ask: r.ask });
      const proj = resolveProject();
      const rr = await insertTask(env, { userId, title: r.text, remindAt: r.due, dueAt: null, projectId: proj ? proj.id : null, source: o.source === "voice" ? "voice" : "text" });
      await o.send(rr.ok ? `⏰ یادآوری به‌عنوان تسک ذخیره شد.${proj ? ` [📁 ${proj.name}]` : ""}` : NOT_SAVED_TEXT);
      if (rr.ok) { await trace(proj ? proj.name : null); await markDaily(env, o); }
      return "handled";
    }
    case "expense": {
      const ex = parseExpense(text, { nowMs: now }, text);
      if (!ex || ex.error || !Number.isInteger(ex.amount)) return null;
      await startConfirm(env, o, "expense", ex);
      return "handled";
    }
    case "income": {
      const ex = parseExpense(text, { nowMs: now, rememberedCurrency: ctx.remembered }, text);
      if (!ex || ex.error || !Number.isInteger(ex.amount)) return null;
      await startConfirm(env, o, "income", ex);
      await trace(null);
      return "handled";
    }
    case "vault_save": {
      const det = classifyDaily(text, { nowMs: now, rememberedCurrency: ctx.remembered });
      if (det.intent === "vault_save" && det.value) {
        if (!det.title || !String(det.title).trim() || !det.value || !String(det.value).trim() || String(det.value).trim().length < 4) { await trace(null); await o.send("برای ثبت در گاوصندوق، عنوان و مقدار را مشخص کن؛ هنوز چیزی ذخیره نشده است."); return "handled"; }
        await trace(null); return viaBranch(det);
      }
      const digits = String(text).replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).match(/\d+/g);
      const candValue = digits ? digits.join("") : (nlu.body && /\d/.test(nlu.body) ? nlu.body.replace(/\D/g, "") : "");
      const candTitle = nlu.body && !/\d/.test(nlu.body) ? nlu.body.trim() : (det.title ?? null);
      if (!candTitle || !String(candTitle).trim() || !candValue || !String(candValue).trim() || String(candValue).trim().length < 4) { await trace(null); await o.send("برای ثبت در گاوصندوق، عنوان و مقدار را مشخص کن؛ هنوز چیزی ذخیره نشده است."); return "handled"; }
      await trace(null);
      return viaBranch({ intent: "vault_save", value: candValue, title: candTitle, category: det.category ?? null, keywords: det.keywords ?? [], extra: det.extra ?? null });
    }
    case "vault_get": {
      const det = classifyDaily(text, { nowMs: now, rememberedCurrency: ctx.remembered });
      await trace(null);
      return viaBranch(det.intent === "vault_get" ? det : { intent: "vault_get", keywords: det.keywords ?? (nlu.body ? [nlu.body.trim()] : []), category: det.category ?? null, title: det.title ?? nlu.body ?? null });
    }
    case "vault_list": {
      const det = classifyDaily(text, { nowMs: now, rememberedCurrency: ctx.remembered });
      await trace(null);
      return viaBranch(det.intent === "vault_list" ? det : { intent: "vault_list", category: det.category ?? null, title: det.title ?? null, keywords: det.keywords ?? [], fileList: det.fileList ?? false });
    }
    case "vault_file_get": {
      const det = classifyDaily(text, { nowMs: now, rememberedCurrency: ctx.remembered });
      await trace(null);
      return viaBranch(det.intent === "vault_file_get" ? det : { intent: "vault_file_get", keywords: det.keywords ?? (nlu.body ? String(nlu.body).split(/\s+/).filter(Boolean) : []) });
    }
    case "memory_save": {
      const det = classifyDaily(text, { nowMs: now, rememberedCurrency: ctx.remembered });
      if (det.intent === "memory_save") { await trace(null); return viaBranch(det); }
      const body = (nlu.body || "").trim() || text.trim();
      if (!body) return null;
      const nameM = /^(?:اسمم|نامم|اسم\s+من|نام\s+من)\s+([\s\S]+?)(?:\s+(?:است|هست))?$/u.exec(body);
      if (nameM) { const v = nameM[1].trim(); if (!v) return null; await trace(null); return viaBranch({ intent: "memory_save", text: body, factKey: "name", factValue: v, setting: { key: "name", value: v } }); }
      await trace(null);
      return viaBranch({ intent: "memory_save", text: body, factKey: "general", factValue: body });
    }
    case "unsupported_action": {
      await o.send(UNSUPPORTED_ACTION_TEXT);
      await trace(null);
      return "handled";
    }
    case "note_list":
      return viaBranch({ intent: "note-query", date: null, projectName: nlu.project });
    case "task_list":
      return viaBranch({ intent: "task-list" });
    case "project_list":
      return viaBranch({ intent: "project-list" });
    case "project_create": {
      if (!nlu.body || !nlu.body.trim()) return null;
      return viaBranch({ intent: "project-create", name: nlu.body.trim() });
    }
    case "summary": {
      const kind = nlu.summary_target === "tasks" ? "task" : "note";
      return viaBranch({ intent: "summary", kind, projectName: nlu.project });
    }
    default:
      return null;
  }
  })();
  if (nluOut === "handled" && nluRoutedTo === "chat") nluRoutedTo = "handled";
  emitNluDiag(null);
  return nluOut;
}

export async function handleDailyText(env, o) {
  const { userId, text } = o;
  const now = o.nowMs ?? Date.now();
  if (!dbOf(env)) { await clearPendingAsk(env, userId); return "chat"; } // D1 unavailable: everyday off, chat keeps working
  const parsedImage = parseImageGenCommand(text);
  if (parsedImage.isImageGen) {
    const res = await generateFreeImage(env, parsedImage.prompt);
    if (res.ok) {
      let photoSent = false;
      if (typeof o.sendPhoto === "function") { await o.sendPhoto(res.bytes, { caption: `🎨 تصویر ساخته شد: ${parsedImage.prompt}`, mimeType: res.mimeType }); photoSent = true; }
      else if (env?.TELEGRAM_BOT_TOKEN && o.chatId) { await sendPhoto(env, o.chatId, "generated.png", res.bytes, { caption: `🎨 تصویر ساخته شد: ${parsedImage.prompt}`, contentType: res.mimeType }); photoSent = true; }
      if (!photoSent && typeof o.send === "function") await o.send(`🎨 تصویر ساخته شد: ${parsedImage.prompt}`);
    } else {
      if (typeof o.send === "function") await o.send("❌ تولید تصویر در حال حاضر ناموفق بود؛ دوباره تلاش کن.");
    }
    return "handled";
  }
  // Phase 3-A: name a pending __pending__ vault upload on the next turn
  // (text message or voice transcript). At the very top, before classifyDaily.
  if (text && !/^\s*\//.test(text)) {
    const named = await namePendingVaultFile(env, o);
    if (named) { return "handled"; }
  }
  const remembered = await getDefaultCurrency(env, userId);
  const c = classifyDaily(text, { nowMs: now, rememberedCurrency: remembered });
  // Commands never enter the everyday path and stay unstored (Step 1b rule);
  // the entry save below is the everyday-path entry, after command routing.
  if (c.intent === "command") { await clearPendingAsk(env, userId); return "chat"; }
  const ctx = { now, remembered };
  // Save-first (Phase 0-b fix): the message row is saved as pending BEFORE
  // any everyday gate (bare-note bypass, fast money, slot, rollout gate,
  // interpreter). The expense row is untouched by this: it is still
  // inserted only when the user taps Confirm. o.entryMessageId is visible
  // to the caller so downstream chat answers do not save a second user row.
  const entry = await saveMessage(env, { userId, role: "user", content: c.intent === "vault_save" ? VAULT_REDACTED_TEXT : text, kind: "pending" });
  if (entry.ok) o.entryMessageId = entry.id; else o._entrySaveFailed = true;
  // 1-d-5 voice echo + chat wrap (placed AFTER the entry save so the
  // entry id is known, BEFORE any branch sends):
  // (a) send wrap: the voice header prepends to the FIRST o.send only
  // (a flag, not per-call), so list chunks after the first stay clean.
  // (b) chat wrap: every model call's options inherit the voice header
  // and the retry/quick-convert ids (the entry id) UNLESS the call site
  // set them explicitly; a call site that set retryData (the summary
  // re-tap) suppresses the chat retry, so a failed summary offers exactly
  // one retry — the summary itself — plus quick-convert for the entry.
  if (o.voiceHeader && o.send) { const rawSend = o.send; let headerSent = false; o.send = async (t, sopts) => { if (!headerSent) { headerSent = true; return rawSend(o.voiceHeader + t, sopts); } return rawSend(t, sopts); }; }
  if (o.chat) { const rawChat = o.chat; o.chat = (t, copts = {}) => rawChat(t, { ...copts, ...(o.voiceHeader && !copts.voiceHeader ? { voiceHeader: o.voiceHeader } : {}), ...(o.entryMessageId && copts.excludeMessageId == null ? { excludeMessageId: o.entryMessageId } : {}), ...(o.entryMessageId && !copts.retryEntryId && !copts.retryData ? { retryEntryId: o.entryMessageId } : {}), ...(o.entryMessageId && !copts.quickConvertId ? { quickConvertId: o.entryMessageId } : {}) }); }
  const finalizeEntry = async (kind) => { if (o.entryMessageId && !o._entryFinalised) { o._entryFinalised = true; await finalizeMessageKind(env, o.entryMessageId, userId, kind); } };
  const viaBranch = async (cc) => { const r = await runDailyBranch(env, o, cc, ctx); await finalizeEntry(r === "chat" ? "chat" : "daily"); return r; };
  // Bare-note ask bypasses the model step: the model is exactly what
  // failed live for bare notes (chat verdict -> hallucinated storage).
  // runDailyBranch asks for the text and sets the note-text slot itself.
  if (c.intent === "ask" && c.question === "note-text") { await clearPendingAsk(env, userId); return viaBranch(c); }
  // Fast money path (unchanged): rule-confident expense/income only.
  if (c.intent === "expense" || c.intent === "income") { await clearPendingAsk(env, userId); return viaBranch(c); }
  // Rule task list (1-b-1): direct to the list render, never to the model
  // step or the interpreter gate; clears any stale slot first.
  if (c.intent === "task-list") { await clearPendingAsk(env, userId); return viaBranch(c); }
  const aiAvailableForNlu = (env?.AI && typeof env.AI.run === "function") || o.interpreterCallFn || o.interpreterModel;
  const isMultiClause = String(text ?? "").length > 160 || ((String(text ?? "").match(/[.،؛;!?؟\n]/g) || []).length >= 3);
  const hasFactMarker = /(اسم\s*من|اسمم|نام\s*من|نامم|شهر\s*من|شهرم|ماشین\s*من|ماشینم|تولدم|تولد\s*من|سنم|شغلم)/u.test(String(text ?? ""));
  const greedyShouldDeferToAi = Boolean(aiAvailableForNlu) && (
    (c.intent === "reminder" && c.ask && c.ask !== "hour-ambiguous" && hasFactMarker) ||
    ((c.intent === "reminder" || c.intent === "vault_save") && isMultiClause) ||
    (c.confidence < 1 && c.intent === "reminder" && hasFactMarker)
  );
  if (!greedyShouldDeferToAi && c.intent !== "chat" && c.intent !== "ask") { await clearPendingAsk(env, userId); return viaBranch(c); }
  // Answers to an open bot question keep the existing slot path.
  let slot = await getPendingAsk(env, userId);
  // 1-d-6: an hour-ambiguous slot must be fully discharged HERE, before
  // any model branch — the 1-c-3 fill alone left a trap: when it
  // returned null, the slot stayed set and runModelBranch re-asked the
  // same question forever (model-failure re-ask, or a chat+followup
  // verdict). Discharge rules, in order:
  //   filled -> clear + store the reminder (unchanged 1-c-3 path);
  //   merged but still-ambiguous -> re-ask ONCE with the ORIGINAL
  //     pendingBody preserved (routing the reply itself would lose it);
  //   merged but otherwise unparseable (past/empty/...) -> clear +
  //     normal reminder branch with that ask, so the user gets a
  //     meaningful message, never the same question again;
  //   unfillable (no daypart shape, or no usable pendingBody) -> clear
  //     the slot and fall through to the normal pipeline below (slot
  //     nulled, so the model branch below cannot re-ask it).
  if (slot && slotKind(slot) === "hour-ambiguous") {
    // Phase 1-e Pillar 3: cancel text never reaches free chat — it
    // clears the slot and confirms, with 0 model calls.
    if (normalizeDaypartToken(text) === "cancel") {
      await clearPendingAsk(env, userId);
      await o.send("❌ یادآوری لغو شد.");
      await finalizeEntry("daily");
      return "handled";
    }
    // Phase 1-e Pillar 3: a short 1-word token (<= 10 chars, no spaces,
    // not a question, not a daypart shape, no rule match) is held, not
    // dumped into chat — but only after the AI interpreter gets its
    // chance when available: a confident daypart_reply resolves through
    // the fill below with the canonical daypart word, and any other
    // confident non-chat verdict discharges the slot into the normal
    // pipeline (which re-runs the NLU). Longer messages and real
    // questions skip this block entirely and discharge below.
    const trimmed = text.trim();
    const shortUnknown = trimmed.length > 0 && trimmed.length <= 10 && !/\s/.test(trimmed) && !/[؟?]/.test(trimmed) && !hasDaypartReply(text) && c.intent === "chat";
    let answerText = text;
    if (shortUnknown && !o.interpreterCallFn && !o.interpreterModel && !env.INTERPRETER_MODEL && env?.AI && typeof env.AI.run === "function") {
      const pres = await resolveProjects(env, userId);
      const nlu = await classifyIntent(env, text, { projects: (pres.projects || []).map((p) => p.name), pendingAsk: { kind: "reminder", reason: "hour-ambiguous", pendingBody: slot.pendingBody ?? null }, source: o.source || "text", nowIso: iranIso(now), lastAction: null, openTasks: [], recentNotes: [] });
      if (nlu.ok && nlu.confidence >= 0.75 && nlu.intent === "daypart_reply") {
        if (nlu.daypart === "cancel") {
          await clearPendingAsk(env, userId);
          await o.send("❌ یادآوری لغو شد.");
          await finalizeEntry("daily");
          return "handled";
        }
        if (["صبح", "عصر", "شب"].includes(nlu.daypart)) answerText = nlu.daypart;
      } else if (nlu.ok && nlu.confidence >= 0.75 && nlu.intent !== "chat") {
        await clearPendingAsk(env, userId);
        slot = null;
      }
    }
    if (slot && shortUnknown && answerText === text) {
      await o.send("متوجه نشدم؛ لطفاً روی یکی از دکمه‌های «☀️ صبح» یا «🌇 عصر» بزنید یا ساعت دقیق را بنویسید.", { replyMarkup: { inline_keyboard: hourAmbiguousKeyboard() } });
      await finalizeEntry("daily");
      return "handled";
    }
    if (slot && typeof slot.pendingBody === "string" && slot.pendingBody) {
      const filled = resolveHourAmbiguousFollowup(answerText, slot.pendingBody, now);
      if (filled) { await clearPendingAsk(env, userId); return viaBranch({ intent: "reminder", text: filled.text, due: filled.due }); }
      const merged = mergeHourAmbiguousFollowup(answerText, slot.pendingBody);
      if (merged) {
        const r = parseReminder(normalizeText(merged), now, merged);
        if (r.ask === "hour-ambiguous") {
          await setPendingAsk(env, userId, askText("hour-ambiguous"), undefined, "hour-ambiguous", slot.pendingBody);
          await sendHourAmbiguousAsk(o);
          await finalizeEntry("daily");
          return "handled";
        }
        await clearPendingAsk(env, userId);
        return viaBranch(r.ask ? { intent: "reminder", ask: r.ask } : { intent: "reminder", text: r.text, due: r.due });
      }
    }
    if (slot) { await clearPendingAsk(env, userId); slot = null; }
  }
  if (slot) { const { ret, outcome, ms } = await runModelBranch(env, o, c, ctx); console.log(JSON.stringify({ modelIntent: MODEL_INTENT_COMBO, tier: c.intent, ms, outcome })); await finalizeEntry(ret === "handled" ? "daily" : "chat"); return ret; }
  // 1-d-1: interpreter unconfigured -> NO model classifier for UNMATCHED
  // (chat-tier) messages. The 80-token classifyDailyWithModel misroutes
  // voice/chat messages, so an unmatched message goes straight to the
  // chat combo (the caller builds full buildChatContext) with zero
  // model calls. Ask-tier messages DID match a deterministic rule, so
  // above (runModelBranch), where a model verdict is only a branch
  // picker re-validated by rule code. Ask-tier messages DID match a
  // deterministic rule (the ask), so they keep the model path below.
  // Phase 2-l: NLU path — runs when the Workers AI binding exists AND no
  // explicit legacy interpreter is configured on this call object. The outer
  // guard no longer checks env.INTERPRETER_MODEL so the NLU activates in
  // production even when wrangler.jsonc sets INTERPRETER_MODEL (that var only
  // governs resolveInterpreterModel, which the NLU prompt uses internally).
  // Legacy interpreter tests always supply o.interpreterCallFn or
  // o.interpreterModel on mkO(), so they fall through to handleInterpreterText
  // unchanged — no existing test is affected.
  if (!o.interpreterCallFn && !o.interpreterModel) {
    if (env?.AI && typeof env.AI.run === "function") {
      const nluHandled = await runNluBranch(env, o, ctx);
      if (nluHandled !== null) { await finalizeEntry(nluHandled === "chat" ? "chat" : "daily"); return nluHandled; }
    }
    if (c.intent === "chat") { await finalizeEntry("chat"); return "chat"; }
    // ask-tier with no AI binding: use the 80-token model slot picker.
    if (!env.INTERPRETER_MODEL) {
      const { ret, outcome, ms } = await runModelBranch(env, o, c, ctx);
      console.log(JSON.stringify({ modelIntent: MODEL_INTENT_COMBO, tier: c.intent, ms, outcome }));
      await finalizeEntry(ret === "handled" ? "daily" : "chat");
      return ret;
    }
    // INTERPRETER_MODEL set but no AI binding and no interpreterCallFn/Model:
    // fall through to the legacy interpreter path below.
  }
  // Everything else goes to the interpreter, never directly to chat.
  return handleInterpreterText(env, o, ctx);
}

// daily: callbacks. Returns true when the data was a daily: callback.
// Forbidden callbacks send nothing, store nothing, and delete nothing.
export async function resolveDailyCallback(env, o) {
  const md = /^money:dir:(spend|income):(.+)$/.exec(o.data);
  if (md) {
    const direction = md[1] === "spend" ? "expense" : "income";
    const id = md[2];
    const ask = await getKv(env, askKey(id));
    const text = ask?.text ?? null;
    if (!text) { await o.send(EXPIRED_TEXT); return true; }
    const ex = parseExpense(text, { nowMs: o.nowMs ?? Date.now(), rememberedCurrency: await getDefaultCurrency(env, o.fromId) }, text);
    if (ex?.error) { const q = askText(mapQuestion(ex.error)); await o.send(q); return true; }
    await putKv(env, draftKey(id), { owner: o.fromId, type: direction, ...ex });
    const r = await confirmExpenseDraft(env, o.fromId, id);
    if (r.status === "forbidden") return true;
    if (r.status === "missing") { await o.send(EXPIRED_TEXT); return true; }
    if (r.status === "failed") { await o.send(NOT_SAVED_TEXT); return true; }
    if (ask) await delKv(env, askKey(id));
    await o.editMarkup?.();
    await o.send("✅ ثبت شد.");
    return true;
  }
  const m = /^daily:(confirm|cancel|ask):([^:]+)(?::(chat|expense|income))?$/.exec(o.data);
  if (!m) return false;
  const [, action, id, choice] = m;
  await clearPendingAsk(env, o.fromId);
  if (action === "confirm" || action === "cancel") {
    let r;
    if (action === "confirm") r = await confirmExpenseDraft(env, o.fromId, id);
    else { const draft = await getKv(env, draftKey(id)); r = !draft ? { status: "missing" } : Number(draft.owner) !== Number(o.fromId) ? { status: "forbidden" } : (await delKv(env, draftKey(id)), { status: "ok" }); }
    if (r.status === "forbidden") return true;
    if (r.status === "missing") { await o.send(EXPIRED_TEXT); return true; }
    if (r.status === "failed") { await o.send(NOT_SAVED_TEXT); return true; }
    // 1-b-3 (amendment 6): compensation — the expense is stored and the
    // task was separately completed, so it stays in the archive; the
    // expense becomes the correction pointer, never a delete claim.
    if (r.status === "converted-done") { if (r.id) await putKv(env, correctionKey(o.fromId), { table: "expenses", id: r.id }); await o.editMarkup(); await o.send("💰 خرج ذخیره شد؛ تسک پیش‌تر جداگانه انجام شده بود و در بایگانی می‌ماند."); return true; }
    // 1-b-3 (amendment 6): an expense row for this draft already exists
    // but the task is gone — the conversion did not complete; the draft
    // is kept and Cancel stays available, retry re-checks, never re-inserts.
    if (r.status === "expense-exists") { await o.send("💰 خرجی برای این پیش‌نویس از قبل ثبت شده است، ولی تسک پیدا نشد؛ تبدیل کامل نشد."); return true; }
    if (action === "confirm" && r.id) await putKv(env, correctionKey(o.fromId), { table: "expenses", id: r.id });
    await o.editMarkup();
    await o.send(action === "confirm" ? "✅ ثبت شد." : "لغو شد.");
    return true;
  }
  const ask = await getKv(env, askKey(id));
  if (!ask) { await o.send(EXPIRED_TEXT); return true; }
  if (Number(ask.owner) !== Number(o.fromId)) return true;
  await delKv(env, askKey(id));
  await o.editMarkup();
  // Save-first: ask.text already has its entry row from the ask exit, so
  // the chat answer must not save it a second time (saveText "").
  if (choice === "chat") { await o.chat(ask.text, { saveText: "" }); return true; }
  const ex = parseExpense(ask.text, { nowMs: o.nowMs ?? Date.now() }, ask.text);
  if (ex?.error) { const q = askText(mapQuestion(ex.error)); await setPendingAsk(env, o.fromId, q, undefined, mapQuestion(ex.error)); await o.send(q); return true; }
  await startConfirm(env, o, choice, ex);
  return true;
}

// Phase 1-e Pillar 3: ask: callbacks — the hour-ambiguous buttons.
// ask:dp:صبح / ask:dp:عصر resolve the pending reminder via
// resolveHourAmbiguousFollowup on the stored pendingBody (never a new
// parse of the tap text); ask:cancel clears + confirms. A missing,
// foreign, or non-hour-ambiguous slot sends EXPIRED_TEXT and clears the
// buttons, never a silent tap. Project preservation: when pendingBody
// carries a folder phrase, the fill re-runs on the tag-stripped
// original so the stored title is clean AND the project attaches.
export async function resolveAskCallback(env, o) {
  const dp = /^ask:dp:(.+)$/.exec(o.data);
  const cancel = o.data === "ask:cancel";
  if (!dp && !cancel) return false;
  const slot = await getPendingAsk(env, o.fromId);
  if (!slot || slotKind(slot) !== "hour-ambiguous" || typeof slot.pendingBody !== "string" || !slot.pendingBody) {
    if (o.editMarkup) await o.editMarkup();
    await o.send(EXPIRED_TEXT);
    return true;
  }
  const now = o.nowMs ?? Date.now();
  await clearPendingAsk(env, o.fromId);
  // Phase 2-d: a final confirmation edits the original ask message in
  // place (text replaced, buttons removed) instead of sending a second
  // message — this is what eliminates the 9:16 PM double-message
  // clutter. Falls back to the old markup-clear + send when no
  // editText is available (offline mocks) or the edit fails.
  const editFinalOrSend = async (text) => {
    if (typeof o.editText === "function") {
      try {
        const res = await o.editText(text);
        if (res && res.ok !== false) return;
      } catch {}
    }
    if (o.editMarkup) await o.editMarkup();
    await o.send(text);
  };
  if (cancel) {
    await editFinalOrSend("❌ یادآوری لغو شد.");
    return true;
  }
  const daypart = dp[1];
  const filled = resolveHourAmbiguousFollowup(daypart, slot.pendingBody, now);
  if (!filled) {
    const merged = mergeHourAmbiguousFollowup(daypart, slot.pendingBody);
    if (merged) {
      const r = parseReminder(normalizeText(merged), now, merged);
      if (r.ask) {
        if (o.editMarkup) await o.editMarkup();
        if (r.ask === "past") { await o.send(askText("past")); return true; }
        if (r.ask === "hour-ambiguous") { await sendHourAmbiguousAsk(o); await setPendingAsk(env, o.fromId, askText("hour-ambiguous"), undefined, "hour-ambiguous", slot.pendingBody); return true; }
        await o.send(askText(r.ask)); return true;
      }
    }
    if (o.editMarkup) await o.editMarkup();
    await o.send(NOT_SAVED_TEXT);
    return true;
  }
  let body = filled.text, pid = null, pname = null;
  const tag = await resolveFolderTag(env, o.fromId, slot.pendingBody);
  if (tag) {
    const filledClean = resolveHourAmbiguousFollowup(daypart, tag.body, now);
    if (filledClean) { body = filledClean.text; pid = tag.project.id; pname = tag.project.name; }
  }
  const r = await insertTask(env, { userId: o.fromId, title: body, remindAt: filled.due, dueAt: null, projectId: pid, source: "text" });
  if (r.ok) {
    await editFinalOrSend(`⏰ یادآوری به‌عنوان تسک ذخیره شد.${pname ? ` [📁 ${pname}]` : ""}`);
  } else {
    if (o.editMarkup) await o.editMarkup();
    await o.send(NOT_SAVED_TEXT);
  }
  return true;
}

// Telegram senders for the daily: branches in index.js.
export function dailySenders(env, chatId, messageId) {
  return {
    send: (msgText, opts) => {
      const formatted = formatTelegramHtml(String(msgText ?? ""));
      return tgApi(env, "sendMessage", { chat_id: chatId, text: formatted, ...(formatted !== String(msgText ?? "") ? { parse_mode: "HTML" } : {}), ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}) });
    },
    editMarkup: () => tgApi(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    // Phase 2-d: edit the original message's text in place and drop
    // its buttons (reply_markup: []); null when there is no message
    // id to edit, so callers fall back to markup-clear + send.
    editText: (text) => Number.isInteger(messageId) && messageId > 0
      ? tgApi(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } })
      : Promise.resolve(null),
  };
}

// Non-text file message: save one messages row, kind daily, no R2 in
// Step 1. Returns false when D1 is missing (caller keeps the old reply).
export async function handleDailyFile(env, o) {
  if (!dbOf(env)) return false;
  const r = await saveMessage(env, { userId: o.userId, role: "user", content: o.caption || o.fileName || "file", kind: "daily", tgFileId: o.tgFileId, fileName: o.fileName || null, fileMime: o.fileMime || null });
  if (!r.ok) { await o.send(NOT_SAVED_TEXT); return true; }
  await o.send("📎 فایل ذخیره شد (فقط ذخیره؛ خلاصه‌سازی با قدم فایل‌ها می‌آید).");
  return true;
}
