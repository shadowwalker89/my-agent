// Interpreter policy + single-action executor, extracted from src/everyday.js (R0.8a).
// Pipeline rank 3; pure orchestration — no channel imports, no LLM calls here.
import { insertTask, getTask, updateTaskFields } from "../db.js";
import { insertNoteRow, noteCardKeyboard } from "../domain/notes/service.js";
import { startConfirm, queryExpenseSums, rangeForPeriod } from "../domain/expenses/service.js";
import { renderTaskList, sendListMessage } from "../domain/tasks/service.js";
import { resolveProjects } from "../domain/tasks/projects.js";
import { parseExpense, classifyDaily } from "../daily.js";
import { setSetting } from "../memory.js";
import { freeTextDevSuggestion } from "../intent.js";
import { validateInterpreterAction } from "../interpreter.js";
import { putKv, getKv, firstDb, runDb, allDb, newId, NOT_SAVED_TEXT, correctionKey } from "./context.js";

const INTERP_UNAVAILABLE_TEXT = "تفسیر خودکار الان در دسترس نیست؛ خودت نوعش را بگو:";

export function interpKey(id) { return `interp:${id}`; }
export function interpTypeKeyboard(id) {
  return [[{ text: "📋 تسک", callback_data: `interp:type:task:${id}` }, { text: "📝 یادداشت", callback_data: `interp:type:note:${id}` }], [{ text: "💰 خرج", callback_data: `interp:type:expense:${id}` }, { text: "💬 چت", callback_data: `interp:type:chat:${id}` }]];
}
export async function newInterpRecord(env, userId, value) { const id = newId(); await putKv(env, interpKey(id), { owner: userId, ...value }); return id; }

// Failure reply: the unavailable message + type buttons + a Retry button
// + the external-backup button (0-b2). The message row IS stored
// (pending); only the domain action is not. The record carries rowId so
// the backup tap can finalise the same pending row on success.
export async function sendInterpUnavailable(env, o, text, rowId) {
  const id = await newInterpRecord(env, o.userId, { text, rowId: rowId ?? null });
  const keyboard = [...interpTypeKeyboard(id)];
  keyboard.push([{ text: "🌐 تفسیر با مدل بیرونی", callback_data: `interp:backup:${id}` }]);
  if (rowId) keyboard.push([{ text: "🔄 ارسال مجدد", callback_data: `retry:${rowId}` }]);
  await o.send(INTERP_UNAVAILABLE_TEXT, { replyMarkup: { inline_keyboard: keyboard } });
}

// Execute ONE validated interpreter action. Money/query/translate/setting/
// dev/chat send their own reply (direct: true); note/task/query return data
// for the caller to present. Money always re-derives from rule code and
// goes through the existing confirm card; the model never supplies numbers.
export async function executeInterpAction(env, o, ctx, action, resolved) {
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
