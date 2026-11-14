// Deterministic Persian note parsing extracted from src/daily.js (R0.7c).
// Pure functions only: no channel/pipeline imports, no I/O, no model calls.
import { addDays, iranDate, normalizeText } from "../reminders/time.js";

export const NOTE_RE = /^\s*(?:(?:لطفا|لطفاً|ببین)\s+)?(?:یادداشت\s+کن(?![\p{L}])|یادداشت\s*[:：])\s*([\s\S]+)/u;
// Phase 2-l: conversational note framing. A greeting/politeness/modal
// opener before the note phrase, or a trailing "… اینو برام یادداشت کن",
// is still a note. The note verb accepts only imperative/second-person
// forms (کن/کنی/کنید/بنویس/...), so the pinned first-person
// "می‌خواهم یادداشت کنم" stays chat (see the 1b-1b regression test).
const NOTE_FRAMING = String.raw`(?:(?:سلام|درود|سلام\s+علیکم|وقت\s+بخیر|صبح\s+بخیر|عصر\s+بخیر|شب\s+بخیر|لطفا|لطفاً|بی\s*زحمت|ممنون|مرسی|خواهشا|خواهشاً|می\s*خوام|می\s*خواهم|میخوام|میخواهم|می\s*خواستم|میخواستم|میشه|می\s*شه|می\s*تونی|میتونی|می\s*تونید|میتونید)\s*[،,!.؛;:]?\s*)*`;
const NOTE_VERB = String.raw`(?:ثبت\s+|ذخیره\s+|ایجاد\s+|نوشتن\s+)?(?:کنی|کنید|کن|بنویسی|بنویس|بذاری|بذار|بگذاری|بگذار|بکنی|بکن)(?!\p{L})`;
const NOTE_LEAD_RE = new RegExp(String.raw`^${NOTE_FRAMING}(?:(?:یه|یک)\s+)?یادداشت(?:\s+جدید)?(?:\s+(?:برام|واسم|برای\s+من|برایم|برا\s+من))?\s*${NOTE_VERB}(?:\s+که(?!\p{L}))?\s*[:：]?\s*([\s\S]+)$`, "ud");
const NOTE_TAIL_RE = new RegExp(String.raw`^([\s\S]{2,}?)\s*[،,؛;]?\s*(?:(?:اینو|این\s+رو|این\s+را|این|اونو|اون\s+رو|اون\s+را|اون)\s+)?(?:برام|واسم|برای\s+من|برایم|برا\s+من)?\s*(?:(?:یه|یک)\s+)?یادداشت(?:\s+جدید)?(?:\s*(?:رو|را))?\s*${NOTE_VERB}(?:\s+که(?!\p{L}))?\s*[.؟?!]?\s*$`, "ud");
const CONV_NOTE_TRIGGER_A = String.raw`(?:یه|یک)?\s*(?:نوت|یادداشت|نوتی|یادداشتی)\s+(?:جدید\s+)?(?:برام\s+)?(?:ثبت\s*کن(?:م|ی|ید)?|بنویس(?:م|ی|ید)?|ذخیره\s*کن(?:م|ی|ید)?|بذار(?:م|ی|ید)?|اضافه\s*کن(?:م|ی|ید)?)`;
const CONV_NOTE_TRIGGER_B = String.raw`(?:این(?:و|\s+رو|\s+را)?\s+(?:برام\s+)?(?:یادداشت|نوت|ثبت|ذخیره)\s*کن(?:م|ی|ید)?)`;
export const CONV_NOTE_RE = new RegExp(String.raw`^(?:(?:سلام|درود|وقت\s+بخیر|خسته\s+نباشی|بی\s*زحمت|لطفا|لطفاً|ببین)\s*[\s،,.:!-]*)*(?:(?:من|می\s*خوام|میخوام|می\s*خواستم|میشه|می\s*شه|میتونی|می\s*تونی)\s*[\s،,.:!-]*)*(?:${CONV_NOTE_TRIGGER_A}|${CONV_NOTE_TRIGGER_B})\s*(?:\s+که\s+|[\s:：.،,؛\-]+)\s*(.+)$`, "ud");

export function stripNoteCommandPrefix(s) {
  const raw = normalizeText(s ?? "");
  const m = CONV_NOTE_RE.exec(raw);
  if (m && m.indices && m.indices[1]) {
    return String(s ?? "").slice(m.indices[1][0], m.indices[1][1]).trim();
  }
  let out = String(s ?? "").trim();
  out = out.replace(new RegExp(String.raw`^(?:${NOTE_FRAMING})`, "u"), "").trim();
  out = out.replace(/^(?:که|این\s+که|اینکه)\s+/u, "").trim();
  out = out.replace(/^[:：،,؛;\s]+/u, "").trim();
  return out;
}
function isMeaningfulNoteBody(s) {
  const t = String(s ?? "").trim();
  if (!t || !t.replace(/[؟?!.،,:：؛;\s]+/gu, "")) return false;
  return !/^(?:تسک|کار|یادآوری|پروژه|یادداشت)$/u.test(t);
}
export function parseConversationalNote(raw, text) {
  const lead = NOTE_LEAD_RE.exec(raw);
  if (lead) {
    const body = text.slice(lead.indices[1][0], lead.indices[1][1]).trim();
    if (isMeaningfulNoteBody(body)) return body;
  }
  const tail = NOTE_TAIL_RE.exec(raw);
  if (tail) {
    const body = stripNoteCommandPrefix(text.slice(tail.indices[1][0], tail.indices[1][1]));
    if (isMeaningfulNoteBody(body)) return body;
  }
  return null;
}
// Note-query: the separator between یادداشت and the plural/possessive
// suffix is optional, so colloquial joined spellings from speech
// transcription (یادداشتهامو، یادداشتهایم) reach note-query instead of
// chat. Note creation (NOTE_RE) is checked before this, so a یادداشت کن
// + body message still goes to note, never to note-query.
// 1-d-3: rich note queries. Anchored forms (optional list prefix): list/possessive -> all; today/yesterday -> that Tehran day;
// project forms -> the named project (bare name, or after the project word); a trailing show verb and trailing punctuation
// are stripped from the name. The old unanchored possessive match stays as a fallback, so joined transcriptions still reach
// note-query. Date words are explicit only — no today default. Precedence: date beats project; no combined filter.
const NOTE_SHOW_TAIL = /(?:\s+(?:را|رو))?(?:\s+(?:نشان\s+بده|نشون\s+بده|نمایش\s+بده|بگو|بگوید|بگویید))?\s*$/u;
export function parseNoteQuery(raw, now) {
  const t = String(raw ?? "").trim().replace(/[؟?!.،,]+$/u, "");
  const day = /دیروز/.test(t) ? addDays(iranDate(now), -1) : /امروز/.test(t) ? iranDate(now) : null;
  // Phase 2-g: نوت is a note synonym, but only in its plural form
  // (نوت‌ها/نوت‌هام): a bare نوت head would misread "نوت جدید" as a
  // project-filtered list, while یادداشت keeps its pinned bare forms.
  const head = /^(?:(?:لیست|فهرست)\s+)?(?:یادداشت\s*های?|نوت\s*های)/u.exec(t);
  if (head) {
    // Phase 2-g: after the show-verb tail is stripped, a leftover
    // colloquial «رو» marker ("یادداشت‌ها رو نشون بده" → "رو") must
    // not become a bogus project filter — strip it before the branches.
    const rest = t.slice(head[0].length).trim().replace(NOTE_SHOW_TAIL, "").replace(/[؟?!.،,]+$/u, "").trim().replace(/^(?:رو|را)(?:\s+|$)/u, "").trim();
    if (/^(?:امروز|دیروز)(?:\s|$)/.test(rest)) return { intent: "note-query", confidence: 1, date: day, projectName: null };
    if (day && /(?:امروز|دیروز)/.test(rest)) return { intent: "note-query", confidence: 1, date: day, projectName: null };
    if (/^(?:م|مو|من)(?:\s|$)/.test(rest)) return { intent: "note-query", confidence: 1, date: day, projectName: null };
    const pm = /^پروژه\s+(.+)$/u.exec(rest);
    if (pm && pm[1].trim()) return { intent: "note-query", confidence: 1, date: null, projectName: pm[1].trim() };
    if (rest) return { intent: "note-query", confidence: 1, date: null, projectName: rest };
    return { intent: "note-query", confidence: 1, date: day, projectName: null };
  }
  if (NOTE_QUERY_RE.test(raw)) return { intent: "note-query", confidence: 1, date: day, projectName: null };
  return null;
}
const NOTE_QUERY_RE = /(یادداشت\s*های(م|مو| امروز)?|یادداشت\s*هامو?|نوت\s*های(م|مو)?|نوت\s*هامو?)/;
