// Task list rendering and callback handling extracted from src/everyday.js
// (R0.7b). No channel/pipeline imports; D1 access goes through src/db.js.
import { listOpenTasksResult, listDoneTasksResult, listProjectsResult, getTask, setTaskStatus, snoozeTaskReminder } from "../../db.js";
import { resolveProjects } from "./projects.js";

const EXPIRED_TEXT = "قبلاً ثبت شد یا مهلتش گذشته";
const NOT_SAVED_TEXT = "ذخیره نشد، دوباره تلاش کن";
export const TASK_LIST_FAILED_TEXT = "تسک‌ها خوانده نشد؛ دوباره تلاش کن";

// Phase 2-d: chunk a flat button list into rows of at most n.
export function chunkButtons(buttons, n) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += n) rows.push(buttons.slice(i, i + n));
  return rows;
}

// 1-b-2: send a list render, splitting at Telegram's 4096-character cap
// on line boundaries (a single over-long line is hard-split); the keyboard
// rides on the LAST chunk only.
export async function sendListMessage(o, rendered) {
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
export function parseListOffset(raw) {
  if (!/^-?\d+$/.test(String(raw ?? ""))) return 0;
  return Math.max(0, Number(raw));
}

// 1-b-2: full list render — 8 rows, open only, with project names,
// per-task ✅/🗑 buttons, more/archive/filter navigation. {ok:false}
// ONLY on a task-read failure (Fix A); name resolution degrades to
// titles only when IT fails, since names are decoration. The more
// button renders ONLY on a full page; beyond-end renders no-more.
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
    // Phase 2-d: project filters chunked to at most 3 per row.
    keyboard.push(...chunkButtons(filters, 3));
  }
  return { ok: true, text, keyboard };
}

// 1-b-2: archive render — done only, newest-first (listDoneTasks core,
// never the wrapper, so a failure is never an "empty archive").
async function renderTaskArchive(env, userId, offset = 0) {
  const r = await listDoneTasksResult(env, userId, null, 8, offset);
  if (!r.ok) return { ok: false, text: TASK_LIST_FAILED_TEXT, keyboard: null };
  if (r.tasks.length === 0) return { ok: true, text: offset > 0 ? "صفحه‌ی دیگری نیست." : "تسک آرشیوشده‌ای پیدا نشد.", keyboard: offset > 0 ? [[{ text: "↩ آرشیو", callback_data: "task:arch:0" }]] : null };
  const keyboard = [];
  if (r.tasks.length === 8) keyboard.push([{ text: "بیشتر", callback_data: `task:arch:${offset + 8}` }]);
  keyboard.push([{ text: "↩ فهرست باز", callback_data: "task:more:0" }]);
  return { ok: true, text: r.tasks.map((t) => `• ${t.title}`).join("\n"), keyboard };
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
// (amendment 1: allow-list gate already ran; proj validates the project
// user-scoped, foreign/missing -> silent, no data, no filter).
export async function resolveTaskCallback(env, o, deps = {}) {
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
    if (typeof deps.runSummary === "function") await deps.runSummary(env, o, "task", tsum[1] === "all" ? null : Number(tsum[1]), o.fromId, o.data);
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
