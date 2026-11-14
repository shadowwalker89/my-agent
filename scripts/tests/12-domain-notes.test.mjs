// R0.7c: deterministic note parsing, rich note rendering/list pagination,
// note insertion, and note callback handling — extracted domain modules.
import fs from "node:fs";
import { check, fakeKV, DatabaseSync } from "./harness.mjs";
import { NOTE_RE, stripNoteCommandPrefix, parseNoteQuery } from "../../src/domain/notes/parse.js";
import { normalizeText } from "../../src/domain/reminders/time.js";
import { stripNoteCommandPrefix as dailyStrip, parseNoteQuery as dailyParse } from "../../src/daily.js";
import { renderNoteList, deriveNoteTitle, stripLeadingNotePunct } from "../../src/domain/notes/render.js";
import { renderNoteList as everydayRender, deriveNoteTitle as everydayTitle } from "../../src/everyday.js";
import { insertNoteRow, noteCardKeyboard, resolveNoteCallback } from "../../src/domain/notes/service.js";

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

export async function run() {
  // ── parse.js: pure Persian note prefix stripping & query parsing ───────
  {
    const created = NOTE_RE.exec("لطفا یادداشت کن شماره پیگیری سفارش ۴۸۲۹۱۰ را نگه دارم");
    check(created?.[1] === "شماره پیگیری سفارش ۴۸۲۹۱۰ را نگه دارم", "R0.7c: note command prefix is stripped from the stored body");
    check(stripNoteCommandPrefix("اینو برام یادداشت کن خرید نان") === "خرید نان", "R0.7c: trailing conversational framing is stripped");
    check(stripNoteCommandPrefix("لطفا یه یادداشت برام ثبت کن: شماره پیگیری سفارش") === "شماره پیگیری سفارش", "R0.7c: greeting and note verb framing are stripped");
    const nq = (s) => parseNoteQuery(normalizeText(s), NOW);
    const today = nq("یادداشت‌های امروز");
    check(today?.intent === "note-query" && today.date === "2026-11-02" && today.projectName === null, "R0.7c: today note query maps to the Tehran day");
    const yday = nq("یادداشت‌های دیروز را نشان بده");
    check(yday?.intent === "note-query" && yday.date === "2026-11-01" && yday.projectName === null, "R0.7c: yesterday note query strips the show verb");
    const proj = nq("یادداشت‌های پروژه متا ادز");
    check(proj?.intent === "note-query" && proj.date === null && proj.projectName === "متا ادز", "R0.7c: project note query extracts the project name");
    const bare = nq("لیست یادداشت‌ها");
    check(bare?.intent === "note-query" && bare.date === null && bare.projectName === null, "R0.7c: list form queries all notes");
    check(nq("یادداشت کن خرید نان") === null, "R0.7c: note creation is not stolen by the query parser");
    check(stripLeadingNotePunct(". یه قابلیت") === "یه قابلیت" && deriveNoteTitle(". خط اول\nخط دوم") === "خط اول" && deriveNoteTitle("   ") === "بدون عنوان", "R0.7c: render helpers trim leading punctuation and derive a title");
    check(dailyStrip === stripNoteCommandPrefix && dailyParse === parseNoteQuery, "R0.7c: src/daily.js re-exports the same note parsers");
    check(everydayRender === renderNoteList && everydayTitle === deriveNoteTitle, "R0.7c: src/everyday.js re-exports the same note renderers");
  }

  // ── canary: parsing/rendering make no network call and write no log ───
  {
    const prevFetch = globalThis.fetch;
    const prevConsole = {};
    const calls = [];
    globalThis.fetch = () => { calls.push("fetch"); return Promise.reject(new Error("network")); };
    for (const k of ["log", "warn", "error", "info", "debug"]) { prevConsole[k] = console[k]; console[k] = () => { calls.push(k); }; }
    try {
      stripNoteCommandPrefix("لطفا یادداشت کن شماره پیگیری سفارش ۴۸۲۹۱۰ را نگه دارم");
      parseNoteQuery("یادداشت‌های امروز", NOW);
      deriveNoteTitle(". خط اول");
      check(calls.length === 0, "R0.7c: note parsing makes no network call and writes no log");
    } finally {
      globalThis.fetch = prevFetch;
      for (const k of Object.keys(prevConsole)) console[k] = prevConsole[k];
    }
  }

  if (!DatabaseSync) return;

  // ── D1 fixture: notes across projects, newest-id-first paging ─────────
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqlite.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
  sqlite.exec("INSERT INTO users (id, telegram_id) VALUES (2, '2')");
  sqlite.exec("INSERT INTO users (id, telegram_id) VALUES (3, '3')");
  const addProj = (name, aliases = []) => sqlite.prepare("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (1, ?, ?, 'active', 0, '2026-11-01T00:00:00.000Z')").run(name, JSON.stringify(aliases));
  addProj("متا ادز");
  const pid = (name) => sqlite.prepare("SELECT id FROM projects WHERE user_id = 1 AND name = ?").all(name)[0].id;
  const gol = pid("گلبهار"), om = pid("متا ادز");
  const addNote = (userId, text, projectId, createdAt) => {
    sqlite.prepare("INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (?, ?, 'text', ?, ?)").run(userId, text, createdAt, projectId);
    return sqlite.prepare("SELECT last_insert_rowid() AS id").all()[0].id;
  };
  const ids = {};
  ids.a = addNote(1, "صبحانه امروز", gol, "2026-11-02T01:24:00+03:30");
  ids.b = addNote(1, "تماس امروز", null, "2026-11-01T23:00:00Z");
  ids.c = addNote(1, "خرید امروز", om, "2026-11-02T10:00:00Z");
  ids.d = addNote(1, "جلسه دیروز", gol, "2026-11-01T05:00:00+03:30");
  ids.e = addNote(1, "کتاب دیروز", null, "2026-10-31T22:00:00Z");
  ids.f = addNote(1, "قدیمی یک", null, "2026-10-30T09:00:00+03:30");
  ids.g = addNote(1, "قدیمی دو", gol, "2026-10-29T09:00:00+03:30");
  ids.h = addNote(1, "قدیمی سه", null, "2026-10-28T09:00:00+03:30");
  ids.i = addNote(1, "قدیمی چهار", null, "2026-10-27T09:00:00+03:30");
  const foreignNote = addNote(2, "مال دیگری", null, "2026-11-02T08:00:00+03:30");
  const base = (sql) => { const st = sqlite.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
  const db = { prepare(sql) { return base(sql); } };
  const env = { STATE: fakeKV(), DB: db };
  const mkS = () => { const sent = []; let edits = 0; return { sent, edits: () => edits, send: async (t, opts) => { sent.push({ text: t, opts }); }, editMarkup: async () => { edits++; } }; };
  const tap = async (data, fromId = 1) => { const s = mkS(); const r = await resolveNoteCallback(env, { fromId, data, send: s.send, editMarkup: s.editMarkup, nowMs: NOW }); return { r, s }; };
  const flatKb = (s) => (s.sent.at(-1)?.opts?.replyMarkup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);

  // ── render.js: rich list, Jalali + time + badge, pagination ───────────
  const page1 = await renderNoteList(env, 1, {});
  check(page1.ok === true && page1.text.startsWith("📖 #1 · ") && page1.text.includes("قدیمی چهار") && page1.text.includes("۵ آبان ۱۴۰۵") && page1.text.includes("09:00"), "R0.7c: page 1 numbers rows with Jalali date and Tehran time");
  check(page1.text.includes("📖 #8") && !page1.text.includes("📖 #9") && page1.keyboard.some((row) => row.some((b) => b.callback_data === "note:more:all:8")), "R0.7c: page 1 holds eight rows and a more button");
  check(page1.keyboard.some((row) => row.some((b) => b.callback_data === `note:del:${ids.i}`)) && page1.text.includes("📁 گلبهار"), "R0.7c: list carries delete buttons and project badges");
  const page2 = await renderNoteList(env, 1, { offset: 8 });
  check(page2.ok === true && page2.text.startsWith("📖 #9 · ") && page2.text.includes("صبحانه امروز") && !page2.keyboard.some((row) => row.some((b) => b.callback_data.startsWith("note:more:"))), "R0.7c: page 2 renders the remaining row with no more button");
  const empty = await renderNoteList(env, 3, {});
  check(empty.ok === true && empty.text === "یادداشتی پیدا نشد.", "R0.7c: empty store keeps the exact empty-state text");

  // ── service.js: pagination, filters, deletion callbacks ───────────────
  const pg = await tap("note:more:all:8");
  check(pg.r === true && pg.s.sent[0].text.startsWith("📖 #9 · ") && pg.s.sent[0].text.includes("صبحانه امروز"), "R0.7c: note:more paginates");
  const pf = await tap(`note:proj:${gol}`);
  check(pf.r === true && pf.s.sent[0].text.includes("صبحانه امروز") && !pf.s.sent[0].text.includes("تماس امروز") && flatKb(pf.s).includes("note:proj:all"), "R0.7c: project filter shows only that project plus an all button");
  const dp = await tap("note:more:all:0:2026-11-01");
  check(dp.r === true && dp.s.sent[0].text.includes("جلسه دیروز") && !dp.s.sent[0].text.includes("صبحانه امروز"), "R0.7c: date filter survives pagination via the fourth segment");
  const be = await tap("note:more:all:16");
  check(be.r === true && be.s.sent[0].text === "صفحه‌ی دیگری نیست." && flatKb(be.s).includes("note:more:all:0"), "R0.7c: beyond-end page reports no further page + back button");
  const foreignProj = await tap("note:proj:999999");
  const foreignDel = await tap(`note:del:${foreignNote}`);
  check(foreignProj.r === true && foreignProj.s.sent.length === 0 && foreignDel.r === true && foreignDel.s.sent.length === 0, "R0.7c: foreign project filter and foreign delete stay silent");
  const del = await tap(`note:del:${ids.f}`);
  check(del.r === true && del.s.sent[0].text === "🗑 یادداشت حذف شد." && del.s.edits() === 1 && sqlite.prepare("SELECT COUNT(*) AS c FROM notes WHERE id = ?").all(ids.f)[0].c === 0, "R0.7c: own delete confirms, removes markup, and removes the row");
  check(await resolveNoteCallback(env, { fromId: 1, data: "note:del:0", send: mkS().send, editMarkup: async () => {} }) === true, "R0.7c: invalid delete id is silently handled");

  // ── service.js: insertion helper + note card keyboard ─────────────────
  const ins = await insertNoteRow(env, 1, "یادداشت مستقیم", "text", gol);
  const insRow = sqlite.prepare("SELECT text, source, project_id FROM notes WHERE id = ?").all(ins.id)[0];
  check(ins.ok === true && ins.id != null && insRow.text === "یادداشت مستقیم" && insRow.source === "text" && insRow.project_id === gol, "R0.7c: insertNoteRow stores the body, source, and project");
  check(JSON.parse(env.STATE.store.get("interp:last-item:1")).id === ins.id, "R0.7c: insertNoteRow sets the correction pointer");
  const noProj = await insertNoteRow(env, 1, "بدون پروژه", "voice");
  check(noProj.ok === true && sqlite.prepare("SELECT project_id FROM notes WHERE id = ?").all(noProj.id)[0].project_id === null, "R0.7c: insertNoteRow accepts a null project");
  const card = noteCardKeyboard(ins.id).flat().map((b) => b.callback_data);
  check(card.includes(`interp:change:${ins.id}`) && card.includes(`interp:del:${ins.id}`), "R0.7c: note card keyboard carries change/delete callbacks");
}
