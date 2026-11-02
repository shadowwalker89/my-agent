// Step 1b-2: everyday wiring (money, notes, reminders, translate,
// remember, queries, file reference + file branch). Pure classifier in
// daily.js; side effects here. D1 failures never throw.
import { classifyDaily, parseExpense, parseReminder, normalizeText, formatJalali, sumByCurrency, iranDate, weekRange, monthRange, resolveHourAmbiguousFollowup, extractFolderTag, IRAN_OFFSET_MIN } from "./daily.js";
import { classifyDailyWithModel, freeTextDevSuggestion, MODEL_INTENT_COMBO } from "./intent.js";
import { saveMessage, finalizeMessageKind, listProjectsResult, listOpenTasksResult, listDoneTasksResult, getTask, getProject, insertTask, insertProject, listNotesResult, deleteNote, setTaskStatus, updateTaskFields, addProjectAlias, insertIntentFeedback, runDbBatch, claimDueReminders, releaseReminderClaim, snoozeTaskReminder, purgeOldClosedTasks } from "./db.js";
import { buildInterpreterPrompt, interpretText, parseInterpreterOutput, validateInterpreterAction } from "./interpreter.js";
import { getDefaultCurrency, setSetting } from "./memory.js";
import { tgApi } from "./telegram.js";

export const CHAT_CONTEXT_CHAR_LIMIT = 8000;
const DRAFT_TTL_SEC = 600;
const EXPIRED_TEXT = "قبلاً ثبت شد یا مهلتش گذشته";
const NOT_SAVED_TEXT = "ذخیره نشد، دوباره تلاش کن";

export function mapQuestion(q) { return q === "ambiguous" ? "amount" : q; } // TODO from 1b-1, resolved here
export function askText(q) {
  return { amount: "مبلغ چقدر بود؟", decimal: "مبلغ اعشاری در این قدم پذیرفته نیست؛ مبلغ را به عدد صحیح بگو.", period: "برای کدام دوره؟ امروز، دیروز، این هفته یا این ماه؟", date: "تاریخ را درست بگو؛ آن تاریخ معتبر نیست.", "hour-ambiguous": "ساعت را با صبح یا عصر مشخص کن.", "no-time": "ساعت یادآوری را بگو.", past: "آن زمان گذشته است؛ زمان آینده را بگو.", empty: "یادآوری برای چه کاری؟", text: "چه متنی را ترجمه کنم؟", "expense-or-chat": "این خرج است یا چت؟", "expense-or-income": "این خرج است یا درآمد؟", "note-text": "چه چیزی را یادداشت کنم؟", language: "به چه زبانی؟" }[q] ?? "دوباره بگو؟";
}

// Chat context: last 50 rows plus the 8,000-char cap, oldest dropped first.
export function buildChatContext(rows) {
  const msgs = (rows || []).filter((r) => r && typeof r.content === "string" && r.content).slice(-50);
  const kept = []; let total = 0;
  for (let i = msgs.length - 1; i >= 0; i--) { if (total + msgs[i].content.length > CHAT_CONTEXT_CHAR_LIMIT) break; kept.push({ role: msgs[i].role === "assistant" ? "assistant" : "user", content: msgs[i].content }); total += msgs[i].content.length; }
  return kept.reverse();
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
    : [[{ text: "💰 خرج", callback_data: `daily:ask:${id}:expense` }, { text: "📥 درآمد", callback_data: `daily:ask:${id}:income` }]];
}
// 1-d-1: 1-tap quick-convert buttons for chat replies. The callback
// handlers (qconv:note:<msgId> / qconv:task:<msgId>) land in 1-d-5;
// messageId is the saved user message row id (o.entryMessageId), never
// user text, so the tap saves exactly that stored message.
export function quickConvertKeyboard(messageId) {
  return [[{ text: "📝 ذخیره یادداشت", callback_data: `qconv:note:${messageId}` }, { text: "☑️ ثبت تسک", callback_data: `qconv:task:${messageId}` }]];
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
    const r = pid === null ? await runDb(env, "INSERT INTO notes (user_id, text, source, created_at) VALUES (?, ?, ?, ?)", [userId, body, o.source === "voice" ? "voice" : "text", new Date().toISOString()]) : await runDb(env, "INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (?, ?, ?, ?, ?)", [userId, body, o.source === "voice" ? "voice" : "text", new Date().toISOString(), pid]);
    await o.send(r.ok ? `✅ یادداشت ذخیره شد.${pname ? ` [📁 ${pname}]` : ""}` : NOT_SAVED_TEXT);
    if (r.ok) await markDaily(env, o);
    return "handled";
  }
  if (c.intent === "task-list") { const r = await renderTaskList(env, userId); await sendListMessage(o, r); if (r.ok) await markDaily(env, o); return "handled"; }
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
    if (c.ask) { await setPendingAsk(env, userId, askText(c.ask), undefined, c.ask, c.ask === "hour-ambiguous" ? text : undefined); await o.send(askText(c.ask)); return "handled"; }
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
    const ok = await runSummary(env, o, c.kind, projectId, userId);
    if (ok) await markDaily(env, o);
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
  const tag = extractFolderTag(fullText);
  if (!tag) return null;
  const rp = await listProjectsResult(env, userId);
  if (!rp.ok || rp.projects.length === 0) return null;
  const cands = [];
  for (const p of rp.projects) {
    if (p.id == null) continue;
    cands.push({ name: normalizeText(p.name).trim(), project: p });
    for (const a of parseAliasesText(p.aliases)) cands.push({ name: normalizeText(a).trim(), project: p });
  }
  cands.sort((a, b) => b.name.length - a.name.length);
  if (tag.at === "end") {
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
async function renderTaskList(env, userId, projectId = null, offset = 0) {
  const r = await listOpenTasksResult(env, userId, projectId, 8, offset);
  if (!r.ok) return { ok: false, text: TASK_LIST_FAILED_TEXT, keyboard: null };
  if (r.tasks.length === 0) return { ok: true, text: offset > 0 ? "صفحه‌ی دیگری نیست." : "تسک بازی پیدا نشد.", keyboard: offset > 0 ? [[{ text: "↩ فهرست", callback_data: projectId == null ? "task:more:0" : `task:more:0:${projectId}` }]] : null };
  const rp = await resolveProjects(env, userId);
  const names = new Map();
  if (rp.ok && !rp.fallback) for (const p of rp.projects) if (p.id != null) names.set(p.id, p.name);
  const text = r.tasks.map((t) => `• ${t.title}${t.project_id != null && names.get(t.project_id) ? ` — ${names.get(t.project_id)}` : ""}`).join("\n");
  const keyboard = r.tasks.map((t) => [{ text: "✅", callback_data: `task:done:${t.id}` }, { text: "🗑", callback_data: `task:del:${t.id}` }]);
  if (r.tasks.length === 8) keyboard.push([{ text: "بیشتر", callback_data: projectId == null ? `task:more:${offset + 8}` : `task:more:${offset + 8}:${projectId}` }]);
  keyboard.push([{ text: "📦 آرشیو", callback_data: "task:arch:0" }]);
  keyboard.push([{ text: "📊 خلاصه و جدول", callback_data: `task:sum:${projectId == null ? "all" : projectId}` }]);
  if (rp.ok && !rp.fallback) {
    const row = rp.projects.filter((p) => p.id != null).map((p) => ({ text: p.name, callback_data: `task:proj:${p.id}:0` }));
    if (row.length) keyboard.push(row);
    if (projectId != null) keyboard.push([{ text: "همه", callback_data: "task:more:0" }]);
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
async function renderNoteList(env, userId, { projectName = null, projectId = null, date = null, offset = 0 } = {}) {
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
    const badge = n.project_id != null && names.get(n.project_id) ? ` [📁 ${names.get(n.project_id)}]` : "";
    return `${offset + i + 1}. ${when ? `${when} ` : ""}${badge ? `${badge} ` : ""}${n.text}`;
  }).join("\n");
  const keyboard = r.notes.map((n) => [{ text: "🗑", callback_data: `note:del:${n.id}` }]);
  if (r.notes.length === 8) keyboard.push([{ text: "بیشتر", callback_data: moreTag(offset + 8) }]);
  keyboard.push([{ text: "📊 خلاصه و جدول", callback_data: `note:sum:${pidTag}` }]);
  if (rp.ok) {
    const row = rp.projects.filter((p) => p.id != null).map((p) => ({ text: p.name, callback_data: `note:proj:${p.id}` }));
    if (row.length) keyboard.push(row);
    if (projectId != null) keyboard.push([{ text: "همه", callback_data: "note:proj:all" }]);
  }
  return { ok: true, text, keyboard };
}

// 1-d-4: D1-grounded summary/table. Verified rows are fetched FIRST
// (up to 30, newest-first for notes, open order for tasks); a D1
// failure reports the failure, 0 rows reports none found — both with
// ZERO model calls. Otherwise ONLY the verified rows (Jalali dates,
// project names) go to the chat combo with no history (history would
// pollute grounding, as it did for translate), no user-row save (the
// caller owns the entry, or the tap owns none), and a 700-token cap.
// Returns false ONLY on a D1 failure (the branch gates markDaily on it).
const SUMMARY_SYSTEM = "فقط از روی ردیف‌هایی که در پیام کاربر آمده خلاصه بساز. هیچ ردیفی را اضافه، حذف یا حدس نزن و هیچ دانسته‌ی بیرونی را قاطی نکن؛ تاریخ‌ها و نام پروژه‌ها را دقیقاً همان‌طور که داده شده بنویس. خروجی: اول یک خلاصه‌ی ساخت‌یافته‌ی کوتاه به فارسی، بعد یک جدول مارک‌داون با همان ردیف‌ها.";
async function runSummary(env, o, kind, projectId, userId) {
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
    if (kind === "note") { const tp = tehranParts(row.created_at); const when = tp ? `${formatJalali(tp.date) || tp.date} ${tp.hhmm}` : ""; return `${i + 1}. ${when ? `${when} ` : ""}${badge ? `${badge} ` : ""}${row.text}`; }
    const whenOf = (iso, label) => { const tp = tehranParts(iso); return tp ? ` (${label}: ${formatJalali(tp.date) || tp.date} ${tp.hhmm})` : ""; };
    return `${i + 1}. ${badge ? `${badge} ` : ""}${row.title}${row.remind_at ? whenOf(row.remind_at, "یادآوری") : ""}${row.due_at ? whenOf(row.due_at, "مهلت") : ""}`;
  }).join("\n");
  await o.chat(`${kind === "note" ? "یادداشت‌ها" : "تسک‌ها"} (${scope}، ${rows.length} ردیف):\n${lines}`, { systemPrompt: SUMMARY_SYSTEM, saveText: "", noHistory: true, maxTokens: 700 });
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
    await runSummary(env, o, "note", sum[1] === "all" ? null : Number(sum[1]), o.fromId);
    return true;
  }
  return false;
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
    await runSummary(env, o, "task", tsum[1] === "all" ? null : Number(tsum[1]), o.fromId);
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
      await send(r.telegram_id, text, replyMarkup);
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
  const prompt = buildInterpreterPrompt({ text, source: o.source === "voice" ? "voice" : "text", recentTurns: recent, openQuestion: null, projects: rp.projects, nowIso: new Date(ctx.now + 210 * 60000).toISOString(), defaultCurrency: ctx.remembered });
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

// Everyday text, Phase 0-b: deterministic gates first (commands, bare-note
// ask, fast money, open-question answers), then the interpreter for
// everything else — never directly to chat. Part 2 comment below kept.
// uncertain (ask) or finds no everyday branch (chat). Confident rule
// results never reach a model. Returns "handled", "chat" (normal
// chat/task/dev path), or "chat-direct" (model already said chat for a
// text message, so the caller answers directly and skips classifyIntent).
export async function handleDailyText(env, o) {
  const { userId, text } = o;
  const now = o.nowMs ?? Date.now();
  if (!dbOf(env)) { await clearPendingAsk(env, userId); return "chat"; } // D1 unavailable: everyday off, chat keeps working
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
  const entry = await saveMessage(env, { userId, role: "user", content: text, kind: "pending" });
  if (entry.ok) o.entryMessageId = entry.id; else o._entrySaveFailed = true;
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
  if (c.intent !== "chat" && c.intent !== "ask") { await clearPendingAsk(env, userId); return viaBranch(c); }
  // Answers to an open bot question keep the existing slot path.
  const slot = await getPendingAsk(env, userId);
  // 1-c-3: deterministic rule-tier fill for a pending hour-ambiguous
  // reminder slot, BEFORE the model branch. The slot kind stays
  // "hour-ambiguous" (no new "time" kind is introduced). Only the two
  // follow-up shapes resolve (bare daypart; time + daypart); anything
  // else falls through to the existing routing unchanged, so a
  // brand-new unambiguous command/query is never trapped here
  // (task-list and other non-chat/non-ask intents already returned
  // above with the slot cleared).
  if (slot && slotKind(slot) === "hour-ambiguous" && typeof slot.pendingBody === "string" && slot.pendingBody) {
    const filled = resolveHourAmbiguousFollowup(text, slot.pendingBody, now);
    if (filled) { await clearPendingAsk(env, userId); return viaBranch({ intent: "reminder", text: filled.text, due: filled.due }); }
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
  if (!o.interpreterCallFn && !o.interpreterModel && !env.INTERPRETER_MODEL) {
    if (c.intent === "chat") { await finalizeEntry("chat"); return "chat"; }
    const { ret, outcome, ms } = await runModelBranch(env, o, c, ctx);
    console.log(JSON.stringify({ modelIntent: MODEL_INTENT_COMBO, tier: c.intent, ms, outcome }));
    await finalizeEntry(ret === "handled" ? "daily" : "chat");
    return ret;
  }
  // Everything else goes to the interpreter, never directly to chat.
  return handleInterpreterText(env, o, ctx);
}

// daily: callbacks. Returns true when the data was a daily: callback.
// Forbidden callbacks send nothing, store nothing, and delete nothing.
export async function resolveDailyCallback(env, o) {
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

// Telegram senders for the daily: branches in index.js.
export function dailySenders(env, chatId, messageId) {
  return {
    send: (msgText, opts) => tgApi(env, "sendMessage", { chat_id: chatId, text: msgText, ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}) }),
    editMarkup: () => tgApi(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
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
