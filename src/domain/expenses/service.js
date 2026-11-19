// Expense/income recording, draft/currency callbacks, period range, and
// D1-grounded financial summary helpers extracted from src/everyday.js (R0.7d).
// No channel/pipeline imports; D1 access goes through src/db.js.
import { getTask, runDbBatch } from "../../db.js";
import { formatJalali } from "../reminders/time.js";
import { normalizeText, iranDate, weekRange, monthRange } from "../reminders/time.js";
import { sumByCurrency } from "./parse.js";

const DRAFT_TTL_SEC = 600;
const NOT_SAVED_TEXT = "ذخیره نشد، دوباره تلاش کن";
const EXPIRED_TEXT = "قبلاً ثبت شد یا مهلتش گذشته";

function dbOf(env) { const db = env && env.DB; return db && typeof db.prepare === "function" ? db : null; }
async function runDb(env, sql, params) { const db = dbOf(env); if (!db) return { ok: false }; try { await db.prepare(sql).bind(...params).run(); return { ok: true }; } catch { return { ok: false }; } }
async function allDb(env, sql, params) { const db = dbOf(env); if (!db) return []; try { const res = await db.prepare(sql).bind(...params).all(); return Array.isArray(res?.results) ? res.results : []; } catch { return []; } }
async function firstDb(env, sql, params) { const db = dbOf(env); if (!db) return { ok: false, row: null }; try { const res = await db.prepare(sql).bind(...params).first(); return { ok: true, row: res ?? null }; } catch { return { ok: false, row: null }; } }
async function putKv(env, key, value) { if (!env.STATE) return; try { await env.STATE.put(key, JSON.stringify(value), { expirationTtl: DRAFT_TTL_SEC }); } catch {} }
async function getKv(env, key) { if (!env.STATE) return null; try { const raw = await env.STATE.get(key, "json"); return raw && typeof raw === "object" ? raw : null; } catch { return null; } }
async function delKv(env, key) { if (!env.STATE) return; try { await env.STATE.delete(key); } catch {} }

function draftKey(id) { return `daily:draft:${id}`; }
function correctionKey(id) { return `interp:last-item:${id}`; }

export function rangeForPeriod(periodText, nowMs) {
  const t = normalizeText(periodText ?? ""), today = iranDate(nowMs);
  if (/دیروز/.test(t)) { const d = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10); return { start: d, end: d }; }
  if (/هفته/.test(t)) return weekRange(today);
  if (/ماه/.test(t)) return monthRange(today);
  return { start: today, end: today };
}

export async function queryExpenseSums(env, userId, range) {
  return sumByCurrency(await allDb(env, "SELECT amount, currency_code FROM expenses WHERE user_id = ? AND type = 'expense' AND date BETWEEN ? AND ?", [userId, range.start, range.end]));
}

export async function startConfirm(env, o, type, ex) {
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  await putKv(env, draftKey(id), { owner: o.userId ?? o.fromId, type, ...ex });
  const jalali = formatJalali(ex.date) || ex.date;
  await o.send(`💰 ${type === "income" ? "درآمد" : "خرج"}: ${ex.amount} ${ex.currency}${ex.item ? ` — ${ex.item}` : ""} — ${jalali}\nتأیید می‌کنی؟`, { replyMarkup: { inline_keyboard: [[{ text: "✅ تأیید", callback_data: `daily:confirm:${id}` }, { text: "❌ لغو", callback_data: `daily:cancel:${id}` }]] } });
  return id;
}

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
  if (draft.taskId) return confirmTaskExpense(env, userId, id, draft);
  let expenseId = null;
  if (draft.corrects?.table === "expenses") {
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
    const d = await runDb(env, "DELETE FROM notes WHERE id = ? AND user_id = ?", [draft.noteId, userId]);
    if (!d.ok) return { status: "failed" };
  }
  await delKv(env, draftKey(id));
  return { status: "ok", draft, id: expenseId };
}