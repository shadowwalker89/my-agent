// Task-conversion chains and change-type feedback, extracted from src/everyday.js (R0.8a).
// Pipeline rank 3; no channel imports, no model calls.
import { getProject, getTask, setTaskStatus, insertIntentFeedback } from "../db.js";
import { insertNoteRow } from "../domain/notes/service.js";
import { startConfirm } from "../domain/expenses/service.js";
import { getDefaultCurrency } from "../memory.js";
import { parseExpense } from "../daily.js";
import { allDb, delKv, putKv, EXPIRED_TEXT, NOT_SAVED_TEXT } from "./context.js";
import { interpKey } from "./policy.js";

// Phase 1-b-3: change-type feedback. Silent best-effort, D1 only, never
// logs: a recording failure never changes the reply and never blocks
// the re-type. Recorded ONLY on a completed re-type via a change-type
// tap (never on every interpreter verdict, correction, or button
// fallback; never on a no-op, a honesty-line refusal, or a failed
// attempt). "Completed" means the target action's delivery finished:
// chat sent, note stored + task deleted, or the expense confirm card
// shown (the later Confirm is money safety, not the type correction).
// project is the re-typed item's project NAME, or null.
export async function recordChangeTypeFeedback(env, userId, text, predictedType, correctType, projectId) {
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
export async function adoptConversionNote(env, userId, rec, task) {
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
// record and the reply carries a Retry button that resumes from the
// recorded stage — never restarts blindly.
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
//    chat-send, a later retry cannot know and would re-send — at most
//    a repeated chat answer, never a lost task or duplicated task.
//  - task -> expense: amount parse first (unextractable -> stop message,
//    task kept, no confirm card, mirroring the note rule), then the
//    confirm card with taskId (Amendment 6 chain lives in
//    confirmExpenseDraft); Cancel -> task untouched, draft deleted.
//  - task -> task: no-op message. Success is reported ONLY after the
//    full chain completes; a FAILED attempt transiently leaves both
//    records alive with an explicit failure reply and a kept record —
//    that is a failed attempt, not a completed conversion.
export async function runTaskConversion(env, o, rec, choice, recordId) {
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
