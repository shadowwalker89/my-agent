// Note rendering helpers extracted from src/everyday.js (R0.7c).
// No channel/pipeline imports; D1 access goes through src/db.js.
import { listNotesResult, listProjectsResult } from "../../db.js";
import { findProjectByName } from "../tasks/projects.js";
import { chunkButtons } from "../tasks/service.js";
import { formatJalali, IRAN_OFFSET_MIN } from "../reminders/time.js";

// 1-d-3: Tehran wall-clock parts of a stored ISO timestamp (live rows mix +03:30 and Z forms).
export function tehranParts(isoStr) {
  const ms = Date.parse(isoStr);
  if (!Number.isFinite(ms)) return null;
  const s = new Date(ms + IRAN_OFFSET_MIN * 60000).toISOString();
  return { date: s.slice(0, 10), hhmm: s.slice(11, 16) };
}

// Phase 2-d: a leading "." (or ":" / "-") left by a folder-strip or a
// "یادداشت: . ..." form must never reach storage or the list render.
// E.g. "یادداشت توی پروژه عمومی: . یه قابلیت" re-classifies to a body
// starting with ". ", which used to render as "[📁 عمومی] . یه قابلیت...".
export function stripLeadingNotePunct(text) {
  // Leading run only: the directive is a stray leading ". "/" : "/" -".
  // No trailing trim — a note body must be stored byte-identical apart
  // from that leading run (a trailing space is user content).
  return String(text ?? "").replace(/^[\s.·:؛،\-–—()[\]]+/u, "");
}

// Phase 3-A: the note list is a scannable index, not a transcript.
// Derive a one-line title from the first meaningful line and cap it on
// a word boundary so a long note never turns the list into a wall.
export function deriveNoteTitle(text, maxLen = 60) {
  const first = String(text ?? "").split(/\r?\n/).find((line) => stripLeadingNotePunct(line).trim()) ?? "";
  const s = stripLeadingNotePunct(first).replace(/\s+/g, " ").trim();
  if (!s) return "بدون عنوان";
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > Math.floor(maxLen * 0.6) ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

export const NOTE_LIST_FAILED_TEXT = "یادداشت‌ها خوانده نشد؛ دوباره تلاش کن.";
// 1-d-3: rich note render — 8 rows newest-first, row number + Jalali date + Tehran HH:MM + folder badge + text,
// per-note delete, project filter, pagination. {ok:false} ONLY on a note-read failure (Fix A); names degrade to
// no badge when THEIR read fails. The more callback carries the date filter as an optional 4th segment (the spec
// shape note:more:<pid|all>:<offset> still parses): without it, paging a date-filtered list would drop the filter.
export async function renderNoteList(env, userId, { projectName = null, projectId = null, date = null, offset = 0 } = {}) {
  const rp = await listProjectsResult(env, userId);
  if (projectName) {
    if (!rp.ok) return { ok: false, text: NOTE_LIST_FAILED_TEXT, keyboard: null };
    const hit = findProjectByName(rp.projects, projectName);
    if (!hit) return { ok: true, text: `📁 پروژه «${projectName}» پیدا نشد.`, keyboard: null };
    projectId = hit.id;
  }
  const names = new Map();
  if (rp.ok) for (const p of rp.projects) if (p.id != null) names.set(p.id, p.name);
  let sinceIso = null, untilIso = null;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) { const [y, m, d] = date.split("-").map(Number); const start = Date.UTC(y, m - 1, d) - IRAN_OFFSET_MIN * 60000; sinceIso = new Date(start).toISOString(); untilIso = new Date(start + 86400000).toISOString(); }
  const r = await listNotesResult(env, userId, { projectId, sinceIso, untilIso, limit: 8, offset });
  if (!r.ok) return { ok: false, text: NOTE_LIST_FAILED_TEXT, keyboard: null };
  const pidTag = projectId == null ? "all" : projectId;
  const moreTag = (off) => `note:more:${pidTag}:${off}${date ? `:${date}` : ""}`;
  if (r.notes.length === 0) return { ok: true, text: offset > 0 ? "صفحه‌ی دیگری نیست." : "یادداشتی پیدا نشد.", keyboard: offset > 0 ? [[{ text: "↩ فهرست", callback_data: moreTag(0) }]] : null };
  const text = r.notes.map((n, i) => {
    const tp = tehranParts(n.created_at);
    const when = tp ? `${formatJalali(tp.date) || tp.date} ${tp.hhmm}` : "";
    const badge = n.project_id != null && names.get(n.project_id) ? `📁 ${names.get(n.project_id)}` : "";
    const parts = [when, badge].filter(Boolean).join(" · ");
    // Phase 3-A: title-only rows keep the list scannable; the full body
    // is still available through the summary/delete actions.
    return `📖 #${offset + i + 1}${parts ? ` · ${parts}` : ""} — ${deriveNoteTitle(n.text)}`;
  }).join("\n");
  // Phase 3-A: view buttons (📖 #N -> note:view:<id>) render the full note
  // on tap; delete buttons follow below, both packed 4 per row.
  const keyboard = [];
  keyboard.push(...chunkButtons(r.notes.map((n, i) => ({ text: `📖 #${offset + i + 1}`, callback_data: `note:view:${n.id}` })), 4));
  keyboard.push(...chunkButtons(r.notes.map((n, i) => ({ text: `🗑 #${offset + i + 1}`, callback_data: `note:del:${n.id}` })), 4));
  if (r.notes.length === 8) keyboard.push([{ text: "بیشتر", callback_data: moreTag(offset + 8) }]);
  keyboard.push([{ text: "📊 خلاصه و جدول", callback_data: `note:sum:${pidTag}` }]);
  if (rp.ok) {
    const filters = rp.projects.filter((p) => p.id != null).map((p) => ({ text: p.name, callback_data: `note:proj:${p.id}` }));
    if (projectId != null) filters.push({ text: "همه", callback_data: "note:proj:all" });
    keyboard.push(...chunkButtons(filters, 3));
  }
  return { ok: true, text, keyboard };
}
