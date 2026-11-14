import { classifyDaily, formatJalali } from "../daily.js";
import { resolveFolderTag, defaultProjectId, findProjectByName } from "../domain/tasks/projects.js";
import { renderTaskList, sendListMessage, TASK_LIST_FAILED_TEXT } from "../domain/tasks/service.js";
import { renderNoteList, stripLeadingNotePunct, NOTE_LIST_FAILED_TEXT } from "../domain/notes/render.js";
import { startConfirm, queryExpenseSums } from "../domain/expenses/service.js";
import { setSetting } from "../memory.js";
import { listProjectsResult, insertTask, insertProject, upsertUserFact } from "../db.js";
import { newId, putKv, askKey, markDaily, markChat, runDb, firstDb, NOT_SAVED_TEXT, UNSUPPORTED_ACTION_TEXT } from "./context.js";
import { mapQuestion, askText, setPendingAsk, kindForAskKey, askKeyboard, sendHourAmbiguousAsk } from "./route.js";
import { runSummary } from "./summary.js";
import { runVaultAndFileBranch } from "./daily-helpers.js";

const MEMORY_SAVED_TEXT = "🧠 به خاطر سپرده شد";

export async function runDailyBranch(env, o, c, ctx, deps = {}) {
  const { userId, text } = o;
  const tg = deps.tgApi || o.tgApi;
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
    const tag = await resolveFolderTag(env, userId, text);
    let body = c.text, pid = await defaultProjectId(env, userId), pname = null;
    if (tag) {
      const c2 = classifyDaily(tag.body, { nowMs: ctx.now, rememberedCurrency: ctx.remembered });
      if (c2.intent === "note" && c2.text) { body = c2.text; pid = tag.project.id; pname = tag.project.name; }
    }
    const cleanBody = stripLeadingNotePunct(body);
    if (cleanBody) body = cleanBody;
    const r = pid === null ? await runDb(env, "INSERT INTO notes (user_id, text, source, created_at) VALUES (?, ?, ?, ?)", [userId, body, o.source === "voice" ? "voice" : "text", new Date().toISOString()]) : await runDb(env, "INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (?, ?, ?, ?, ?)", [userId, body, o.source === "voice" ? "voice" : "text", new Date().toISOString(), pid]);
    await o.send(r.ok ? `✅ یادداشت ذخیره شد.${pname ? ` [📁 ${pname}]` : ""}` : NOT_SAVED_TEXT);
    if (r.ok) await markDaily(env, o);
    return "handled";
  }
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
    if (c.ask) { await setPendingAsk(env, userId, askText(c.ask), undefined, c.ask, c.ask === "hour-ambiguous" ? text : undefined); if (c.ask === "hour-ambiguous") await sendHourAmbiguousAsk(o); else await o.send(askText(c.ask)); return "handled"; }
    const tag = await resolveFolderTag(env, userId, text);
    let body = c.text, due = c.due, pid = null, pname = null;
    if (tag) {
      const c2 = classifyDaily(tag.body, { nowMs: ctx.now, rememberedCurrency: ctx.remembered });
      if (c2.intent === "reminder" && !c2.ask && c2.text && c2.due) { body = c2.text; due = c2.due; pid = tag.project.id; pname = tag.project.name; }
    }
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
    const ok = await runSummary(env, o, c.kind, projectId, userId, `${c.kind === "note" ? "note" : "task"}:sum:${projectId == null ? "all" : projectId}`, deps);
    if (ok) await markDaily(env, o);
    return "handled";
  }
  const vaultResult = await runVaultAndFileBranch(env, o, c, ctx, { ...deps, tgApi: tg });
  if (vaultResult) return vaultResult;
  return "chat";
}
