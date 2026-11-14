// Note persistence and callback handling extracted from src/everyday.js
// (R0.7c). No channel/pipeline imports; D1 access goes through src/db.js.
import { deleteNote, listProjectsResult } from "../../db.js";
import { formatJalali } from "../reminders/time.js";
import { parseListOffset, sendListMessage } from "../tasks/service.js";
import { deriveNoteTitle, NOTE_LIST_FAILED_TEXT, renderNoteList, tehranParts } from "./render.js";

const NOT_SAVED_TEXT = "ذخیره نشد، دوباره تلاش کن";
const KV_TTL_SEC = 600;

function dbOf(env) { const db = env && env.DB; return db && typeof db.prepare === "function" ? db : null; }
async function firstRow(env, sql, params) { const db = dbOf(env); if (!db) return { ok: false, row: null }; try { const res = await db.prepare(sql).bind(...params).first(); return { ok: true, row: res ?? null }; } catch { return { ok: false, row: null }; } }
function correctionKey(id) { return `interp:last-item:${id}`; }
async function putKv(env, key, value) { if (!env.STATE) return; try { await env.STATE.put(key, JSON.stringify(value), { expirationTtl: KV_TTL_SEC }); } catch {} }

export function noteCardKeyboard(id) { return [[{ text: "🔄 تغییر نوع", callback_data: `interp:change:${id}` }, { text: "🗑 لغو", callback_data: `interp:del:${id}` }]]; }
export async function insertNoteRow(env, userId, text, source, projectId = null) {
  const db = dbOf(env); if (!db) return { ok: false, id: null };
  try {
    if (projectId === null || projectId === undefined) await db.prepare("INSERT INTO notes (user_id, text, source, created_at) VALUES (?, ?, ?, ?)").bind(userId, text, source, new Date().toISOString()).run();
    else await db.prepare("INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (?, ?, ?, ?, ?)").bind(userId, text, source, new Date().toISOString(), projectId).run();
    const row = await db.prepare("SELECT last_insert_rowid() AS id").bind().first(); const id = row?.id ?? null; if (id) await putKv(env, correctionKey(userId), { table: "notes", id }); return { ok: true, id };
  } catch { return { ok: false, id: null }; }
}

// 1-d-3: note: namespace. del re-checks ownership via the user-scoped delete (foreign/missing -> silent; D1 failure -> buttons kept); more/proj validate the project user-scoped.
// The summary tap needs runSummary, which stays in everyday.js (it also serves tasks), so it is injected instead of an upward import.
export async function resolveNoteCallback(env, o, deps = {}) {
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
  const view = /^note:view:(\d+)$/.exec(o.data);
  if (view) {
    const id = Number(view[1]);
    if (!Number.isSafeInteger(id) || id <= 0) return true;
    const row = await firstRow(env, "SELECT id, text, project_id, created_at FROM notes WHERE id = ? AND user_id = ?", [id, o.fromId]);
    if (!row.ok || !row.row) { await o.send("یادداشتی پیدا نشد."); return true; }
    let pname = null;
    if (row.row.project_id != null) {
      const rp = await listProjectsResult(env, o.fromId);
      if (rp.ok) { const hit = rp.projects.find((p) => String(p.id) === String(row.row.project_id)); if (hit) pname = hit.name; }
    }
    const tp = tehranParts(row.row.created_at);
    const when = tp ? `${formatJalali(tp.date) || tp.date} ${tp.hhmm}` : "";
    const body = String(row.row.text ?? "");
    const title = deriveNoteTitle(body);
    let text = `📌 **${title}**`;
    if (when) text += `\n🗓 ${when}`;
    if (pname) text += ` [📁 ${pname}]`;
    text += `\n\n${body}`;
    await o.send(text, { replyMarkup: { inline_keyboard: [[{ text: "🗑 حذف یادداشت", callback_data: `note:del:${id}` }]] } });
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
    if (typeof deps.runSummary === "function") await deps.runSummary(env, o, "note", sum[1] === "all" ? null : Number(sum[1]), o.fromId, o.data);
    return true;
  }
  return false;
}
