import { listProjectsResult, listNotesResult, listOpenTasksResult } from "../db.js";
import { formatJalali } from "../daily.js";
import { NOTE_LIST_FAILED_TEXT, tehranParts, stripLeadingNotePunct } from "../domain/notes/render.js";
import { TASK_LIST_FAILED_TEXT } from "../domain/tasks/service.js";

export const SUMMARY_SYSTEM = "فقط از روی ردیف‌هایی که در پیام کاربر آمده خلاصه بساز. هیچ ردیفی را اضافه، حذف یا حدس نزن و هیچ دانسته‌ی بیرونی را قاطی نکن؛ تاریخ‌ها و نام پروژه‌ها را دقیقاً همان‌طور که داده شده بنویس. خلاصه حداکثر ۴ تا ۵ خط کوتاه باشد و بلافاصله بعد از آن فهرست شماره‌دار همان ردیف‌ها بیاید؛ هر ردیف در یک خط: شماره. تاریخ ـ پوشه ـ خلاصه یک‌خطی. فهرست دقیقاً ردیف‌های داده‌شده (حداکثر ۳۰ ردیف) را پوشش دهد.";

export async function runSummary(env, o, kind, projectId, userId, retryData = null, deps = {}) {
  const sendProgressMessage = deps.sendProgressMessage || o.sendProgressMessage;
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
  let progressMsgId = null;
  if (o.chatId != null && typeof sendProgressMessage === "function") progressMsgId = await sendProgressMessage(env, o.chatId, "⏳ در حال آماده‌سازی خلاصه و جدول...");
  await o.chat(`${kind === "note" ? "یادداشت‌ها" : "تسک‌ها"} (${scope}، ${rows.length} ردیف):\n${lines}`, { systemPrompt: SUMMARY_SYSTEM, saveText: "", noHistory: true, maxTokens: 2200, taskType: "chat", failureLabel: "خلاصه‌سازی", ...(retryData ? { retryData } : {}), ...(progressMsgId != null ? { progressMsgId } : {}) });
  return true;
}
