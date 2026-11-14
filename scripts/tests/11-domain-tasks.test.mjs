// R0.7b: deterministic task/project parsing, project resolution, task list
// rendering, and task callback handling — extracted domain modules.
import fs from "node:fs";
import { check, fakeKV, DatabaseSync } from "./harness.mjs";
import { normalizeText } from "../../src/domain/reminders/time.js";
import { parseListRequest, stripMiddleFolderTag, extractFolderTag, matchKnownProjectAt, resolveProjectName } from "../../src/domain/tasks/parse.js";
import { resolveProjects, resolveFolderTag } from "../../src/domain/tasks/projects.js";
import { renderTaskList, resolveTaskCallback } from "../../src/domain/tasks/service.js";

export async function run() {
  // ── parse.js: pure Persian folder/project/list parsing ────────────────
  {
    const start = extractFolderTag("توی پروژه گلبهار یادداشت کن خرید نان");
    const end = extractFolderTag("یادداشت کن خرید نان در پروژه گل");
    check(start?.at === "start" && start.rest === "گلبهار یادداشت کن خرید نان", "R0.7b: start folder tag keeps the remaining text");
    check(end?.at === "end" && end.body === "یادداشت کن خرید نان" && end.name === "گل", "R0.7b: end folder tag splits body and name");
    const mid = stripMiddleFolderTag("یادداشت در پروژه گلبهار: خرید نان");
    check(mid?.keyword === "یادداشت" && mid.name === "گلبهار" && mid.body === "یادداشت: خرید نان", "R0.7b: middle folder tag is stripped and re-classifiable");
    const knownTag = extractFolderTag("یادداشت کن برای پروژه متا ادز خرید نان", [{ name: "متا ادز", aliases: [] }]);
    check(knownTag?.at === "known" && knownTag.name === "متا ادز" && knownTag.body === "یادداشت کن خرید نان", "R0.7b: known project name resolves mid-sentence");
    const hit = matchKnownProjectAt("گلبهار برسه", ["گلبهار"]);
    check(hit?.name === "گلبهار" && hit.rest === "برسه" && resolveProjectName("گلبهار برسه", ["گلبهار"]) === "گلبهار", "R0.7b: known-project boundary match keeps trailing words out of the name");
  }
  {
    const taskList = parseListRequest(normalizeText("تسک‌های پروژه متا ادز رو نشون بده"));
    check(taskList?.intent === "task-list" && taskList.projectName === "متا ادز", "R0.7b: project-filtered task list extracts the project name");
    const reminderList = parseListRequest(normalizeText("لیست یادآوری‌هام"));
    check(reminderList?.intent === "reminder-list" && reminderList.projectName === null, "R0.7b: reminder list request routes to reminder-list");
    check(parseListRequest(normalizeText("لیست تسک‌هام"))?.intent === "task-list", "R0.7b: possessive task list request parses");
    check(parseListRequest("لیست چیزهای عجیب") === null, "R0.7b: an unknown subject is not a list request");
  }
  {
    const prevFetch = globalThis.fetch;
    const prevConsole = {};
    const calls = [];
    globalThis.fetch = (...args) => { calls.push("fetch"); return Promise.reject(new Error("network")); };
    for (const k of ["log", "warn", "error", "info", "debug"]) { prevConsole[k] = console[k]; console[k] = (...args) => { calls.push(k); }; }
    try {
      extractFolderTag("توی پروژه گلبهار یادداشت کن خرید نان");
      stripMiddleFolderTag("یادداشت در پروژه گلبهار: خرید نان");
      parseListRequest(normalizeText("لیست تسک‌هام"));
      check(calls.length === 0, "R0.7b: task parsing makes no network call and writes no log");
    } finally {
      globalThis.fetch = prevFetch;
      for (const k of Object.keys(prevConsole)) console[k] = prevConsole[k];
    }
  }

  if (!DatabaseSync) return;

  // ── projects.js + service.js against in-memory D1 ─────────────────────
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqlite.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
  const addProj = (name, aliases = []) => sqlite.prepare("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (1, ?, ?, 'active', 0, '2026-11-01T00:00:00.000Z')").run(name, JSON.stringify(aliases));
  addProj("متا ادز"); addProj("کارها");
  const pid = (name) => sqlite.prepare("SELECT id FROM projects WHERE user_id = 1 AND name = ?").all(name)[0].id;
  const addTask = (title, projectId, remindAt = null) => { sqlite.prepare("INSERT INTO tasks (user_id, title, project_id, status, remind_at, source, created_at) VALUES (1, ?, ?, 'open', ?, 'text', '2026-11-01T00:00:00.000Z')").run(title, projectId, remindAt); return sqlite.prepare("SELECT last_insert_rowid() AS id").all()[0].id; };
  const taskA = addTask("گزارش کمپین‌ها", pid("متا ادز"));
  const taskB = addTask("خرید نان", pid("عمومی"), "2026-11-01T08:00:00+03:30");
  const taskC = addTask("تماس با شرکت بیمه", pid("کارها"));
  for (let i = 4; i <= 9; i++) addTask(`کار شماره ${i}`, null);
  const base = (sql) => { const st = sqlite.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
  const db = { prepare(sql) { return base(sql); } };
  const env = { STATE: fakeKV(), DB: db };
  const mkS = () => { const sent = []; return { sent, send: async (t) => { sent.push(t); }, editMarkup: async () => {}, data: "" }; };
  const NOW = Date.UTC(2026, 10, 1, 9, 0, 0);

  const rp = await resolveProjects(env, 1);
  check(rp.ok === true && rp.fallback === false && rp.projects.some((p) => p.name === "متا ادز") && rp.projects.some((p) => p.name === "گلبهار" && p.aliases.includes("گل")), "R0.7b: resolveProjects maps D1 rows with parsed aliases");
  const folder = await resolveFolderTag(env, 1, "برای پروژه متا ادز تسک بساز: گزارش کمپین‌ها");
  check(folder?.project?.name === "متا ادز" && folder.body === "تسک بساز: گزارش کمپین‌ها", "R0.7b: resolveFolderTag attaches the D1 project");
  const midFolder = await resolveFolderTag(env, 1, "یادداشت در پروژه کارها: تماس با شرکت بیمه");
  check(midFolder?.project?.name === "کارها" && midFolder.body === "یادداشت: تماس با شرکت بیمه", "R0.7b: resolveFolderTag handles the middle form");

  const list = await renderTaskList(env, 1, null, 0);
  check(list.ok === true && list.text.split("\n").length === 8, "R0.7b: task list renders one page of eight rows");
  check(list.text.startsWith("1. گزارش کمپین‌ها — متا ادز") && list.text.includes("2. خرید نان — عمومی"), "R0.7b: task list numbers rows and shows Jalali project badges");
  check(list.keyboard.some((row) => row.some((b) => b.text === "بیشتر" && b.callback_data === "task:more:8")) && list.keyboard.some((row) => row.some((b) => b.callback_data === `task:done:${taskA}`)), "R0.7b: task list carries pagination and per-task buttons");
  const page2 = await renderTaskList(env, 1, null, 8);
  check(page2.ok === true && page2.text.startsWith("9. کار شماره 9"), "R0.7b: task list pagination renders the next page");

  const s1 = mkS();
  check(await resolveTaskCallback(env, { fromId: 1, data: `task:more:8`, send: s1.send, editMarkup: s1.editMarkup, nowMs: NOW }) === true && s1.sent[0].startsWith("9. کار شماره 9"), "R0.7b: task:more callback paginates");
  const s2 = mkS();
  check(await resolveTaskCallback(env, { fromId: 1, data: `task:done:${taskA}`, send: s2.send, editMarkup: s2.editMarkup, nowMs: NOW }) === true && s2.sent[0] === "✅ انجام شد." && sqlite.prepare("SELECT status FROM tasks WHERE id = ?").all(taskA)[0].status === "done", "R0.7b: task:done completes the row");
  const s3 = mkS();
  await resolveTaskCallback(env, { fromId: 1, data: `task:snooze:${taskB}`, send: s3.send, editMarkup: s3.editMarkup, nowMs: NOW });
  const snoozed = sqlite.prepare("SELECT remind_at FROM tasks WHERE id = ?").all(taskB)[0].remind_at;
  check(s3.sent[0] === "💤 یادآوری برای ۱۰ دقیقه‌ی دیگر تنظیم شد." && snoozed === new Date(NOW + 10 * 60 * 1000).toISOString(), "R0.7b: task:snooze moves the reminder ten minutes ahead");
  const s4 = mkS();
  check(await resolveTaskCallback(env, { fromId: 1, data: `task:del:${taskC}`, send: s4.send, editMarkup: s4.editMarkup, nowMs: NOW }) === true && s4.sent[0] === "🗑 حذف شد." && sqlite.prepare("SELECT status FROM tasks WHERE id = ?").all(taskC)[0].status === "deleted", "R0.7b: task:del soft-deletes the row");
  check(await resolveTaskCallback(env, { fromId: 1, data: "task:done:abc", send: mkS().send, editMarkup: async () => {}, nowMs: NOW }) === false, "R0.7b: an invalid callback id is not handled");
  const s5 = mkS();
  await resolveTaskCallback(env, { fromId: 1, data: "task:proj:999999:0", send: s5.send, editMarkup: s5.editMarkup, nowMs: NOW });
  check(s5.sent.length === 0, "R0.7b: a foreign project callback stays silent");
}
