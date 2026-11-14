// Interpreter callback dispatch (interp:*), extracted from src/everyday.js (R0.8a).
// Owner-checked; expired records get the fixed message. Rank 3; no channel
// imports — transport arrives via `o` (send/chat/editMarkup).
import { finalizeMessageKind, addProjectAlias } from "../db.js";
import { resolveProjects } from "../domain/tasks/projects.js";
import { insertNoteRow, noteCardKeyboard } from "../domain/notes/service.js";
import { startConfirm } from "../domain/expenses/service.js";
import { askText, setPendingAsk } from "./route.js";
import { normalizeText, parseExpense } from "../daily.js";
import { getDefaultCurrency } from "../memory.js";
import { getKv, delKv, firstDb, runDb, EXPIRED_TEXT, NOT_SAVED_TEXT } from "./context.js";
import { interpKey, interpTypeKeyboard, newInterpRecord, runInterpPolicy } from "./policy.js";
import { interpretAndExecute, runBackupInterpretation } from "./interp-runner.js";
import { runTaskConversion, recordChangeTypeFeedback } from "./interp-conversions.js";

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
    if (tm[1] === "taskdismiss") { await o.send("باشه، تسک کنار گذاشته شد؛ ذخیره با فاز ۱ می‌آیند."); return true; }
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
