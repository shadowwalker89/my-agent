import { IRAN_OFFSET_MIN, normalizeDigits, normalizeText, pad, iso, parseHour, parseRelativeDate, HOUR_ALTS, HOURW } from "./time.js";

const REMINDER_TRIGGERS = /(?:یادم بینداز|یادآوری کن|یادم بنداز|یادت باشه|یادآوری)(?![\p{L}])/u;
const REL_WORD_VAL = { "یک": 1, "دو": 2, "سه": 3, "چهار": 4, "پنج": 5, "شش": 6, "هفت": 7, "هشت": 8, "نه": 9, "ده": 10, "پانزده": 15, "بیست": 20, "سی": 30, "چهل": 40, "پنجاه": 50, "شصت": 60, "هفتاد": 70, "هشتاد": 80, "نود": 90, "نیم": 0.5 };
const REL_RE = /(?<!\p{L})(?:(\d+)|(چهل\s+و\s+پنج)|(یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|پانزده|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود|نیم))\s*(دقیقه|ساعت|روز|ربع)\s*(?:دیگه|دیگر|بعد)(?!\p{L})/u;

function parseRelativeDurationMs(tNorm) {
  const m = REL_RE.exec(String(tNorm ?? ""));
  if (!m) return null;
  let num;
  if (m[1] !== undefined) num = Number(m[1]);
  else if (m[2] !== undefined) num = 45;
  else {
    const w = String(m[3] ?? "").replace(/\s+/g, " ").trim();
    if (w === "چهل و پنج") num = 45;
    else if (w === "نیم") num = 0.5;
    else if (Object.hasOwn(REL_WORD_VAL, w)) num = REL_WORD_VAL[w];
    else return null;
  }
  if (!Number.isFinite(num) || num <= 0) return null;
  const unit = m[4];
  let ms;
  if (unit === "دقیقه") ms = num * 60000;
  else if (unit === "ساعت") ms = num * 3600000;
  else if (unit === "روز") ms = num * 86400000;
  else if (unit === "ربع") ms = num * 900000;
  else return null;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return { ms, index: m.index, length: m[0].length };
}

export function parseReminder(text, nowMs, origText) {
  const now = nowMs ?? Date.now();
  const tNorm = normalizeDigits(String(text ?? ""));
  const rel = parseRelativeDurationMs(tNorm);
  if (rel) {
    const src0 = origText ?? text;
    const ranges0 = [];
    const collect0 = (re) => { let mm; while ((mm = re.exec(text)) !== null) ranges0.push([mm.index, mm.index + mm[0].length]); };
    collect0(new RegExp(REMINDER_TRIGGERS.source, "gu"));
    ranges0.push([rel.index, rel.index + rel.length]);
    ranges0.sort((a, b) => a[0] - b[0]);
    let body0 = "", pos0 = 0;
    for (const [a, b] of ranges0) { if (a < pos0) continue; body0 += src0.slice(pos0, a); pos0 = b; }
    body0 += src0.slice(pos0);
    body0 = body0.replace(/\s+/g, " ").trim().replace(/^برای\s+/u, "").trim();
    if (!body0) return { ask: "empty" };
    const target = now + rel.ms;
    const t = new Date(target + IRAN_OFFSET_MIN * 60000);
    const dateStr = iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    const due = `${dateStr}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00+03:30`;
    return { due, text: body0 };
  }
  const hour = parseHour(text);
  if (!hour) return { ask: "no-time" }; if (hour.ask) return { ask: hour.ask };
  const date = parseRelativeDate(text, now); if (date === null) return { ask: "date" };
  const [y, mo, d] = date.split("-").map(Number);
  if (Date.UTC(y, mo - 1, d, hour.hour, hour.minute) - IRAN_OFFSET_MIN * 60000 <= now) return { ask: "past" };
  const src = origText ?? text, ranges = [];
  const collect = (re) => { let mm; while ((mm = re.exec(text)) !== null) ranges.push([mm.index, mm.index + mm[0].length]); };
  collect(new RegExp(REMINDER_TRIGGERS.source, "gu"));
  collect(/پس[\s\u200c]+فردا|فردا|امروز|دیروز/g);
  collect(new RegExp(String.raw`ساعت\s*(?:[\d۰-۹٠-٩]{1,2}|${HOUR_ALTS})(?::[\d۰-۹٠-٩]{1,2})?(?:\s+و\s+(?:ربع|نیم))?(?:\s+(?:بعد از ظهر|بعدازظهر|بعداز ظهر|صبح|صبخ|صیح|صبج|صب|سحر|صبحی|بامداد|ظهر|عصر|عصز|عصذ|عصری|شب|شی|شبی))?`, "g"));
  collect(/و\s+(?:ربع|نیم)/g);
  ranges.sort((a, b) => a[0] - b[0]);
  let body = "", pos = 0;
  for (const [a, b] of ranges) { if (a < pos) continue; body += src.slice(pos, a); pos = b; }
  body += src.slice(pos);
  body = body.replace(/\s+/g, " ").trim();
  if (/^برای\s+(?:فردا|امروز|پس[\s\u200c]+فردا)/u.test(text)) body = body.replace(/^برای\s+/u, "").trim();
  if (!body) return { ask: "empty" };
  return { due: `${date}T${pad(hour.hour)}:${pad(hour.minute)}:00+03:30`, text: body };
}

const DAYPART_ALT = "بعد از ظهر|بعدازظهر|بعداز ظهر|بامداد|صبح|صبخ|صیح|صبج|صب|سحر|صبحی|ظهر|عصر|عصز|عصذ|عصری|شب|شی|شبی";
const DAYPART_TOKEN_MAP = {
  صبح: ["صبح", "صبخ", "صیح", "صبج", "صب", "بامداد", "سحر", "صبحی"],
  عصر: ["عصر", "عصز", "عصذ", "عصری", "ظهر", "بعدازظهر", "بعد از ظهر", "بعداز ظهر"],
  شب: ["شب", "شی", "شبی"],
  cancel: ["لغو", "انصراف", "کنسل", "بیخیال", "هیچی"],
};
const DAYPART_LOOKUP = {};
for (const [canon, forms] of Object.entries(DAYPART_TOKEN_MAP)) {
  for (const f of forms) DAYPART_LOOKUP[f] = canon;
}

export function normalizeDaypartToken(raw) {
  const t = normalizeDigits(normalizeText(raw ?? ""))
    .trim()
    .replace(/[؟?!.،,:：\s]+$/u, "");
  if (!t) return null;
  if (Object.hasOwn(DAYPART_LOOKUP, t)) return DAYPART_LOOKUP[t];
  const core = t.replace(/^(?:واسه|برای)\s+/u, "");
  if (core !== t && Object.hasOwn(DAYPART_LOOKUP, core)) return DAYPART_LOOKUP[core];
  return null;
}

export function parseDaypartReply(answer) {
  const ans = normalizeDigits(normalizeText(answer ?? "")).trim().replace(/[؟?!.،,:：\s]+$/u, "");
  if (!ans) return null;
  const m2 = new RegExp(String.raw`^(?:ساعت\s+)?(\d{1,2}):(\d{1,2})\s+(${DAYPART_ALT})$`).exec(ans);
  if (m2) { const hh = Number(m2[1]), mm = Number(m2[2]); if (hh > 23 || mm > 59) return null; return { hh, mm, daypart: normalizeDaypartToken(m2[3]) }; }
  const m3 = new RegExp(String.raw`^(?:ساعت\s+)?(\d{1,2}|${HOUR_ALTS})\s+(${DAYPART_ALT})$`).exec(ans);
  if (m3) { const hh = /^\d+$/.test(m3[1]) ? Number(m3[1]) : (Object.hasOwn(HOURW, m3[1]) ? HOURW[m3[1]] : undefined); if (hh === undefined || hh > 23) return null; return { hh, mm: 0, daypart: normalizeDaypartToken(m3[2]) }; }
  const bm = new RegExp(`^(${DAYPART_ALT})$`).exec(ans);
  if (bm) return { bare: normalizeDaypartToken(bm[1]) };
  return null;
}

export function hasDaypartReply(answer) { return parseDaypartReply(answer) !== null; }

export function mergeHourAmbiguousFollowup(answer, original) {
  const parsed = parseDaypartReply(answer);
  if (!parsed) return null;
  const orig = normalizeDigits(normalizeText(original ?? ""));
  const phrase = new RegExp(String.raw`ساعت\s*(?:\d{1,2}|${HOUR_ALTS})(?::\d{1,2})?(?:\s+و\s+(?:ربع|نیم))?(?:\s+(?:${DAYPART_ALT}))?`).exec(orig);
  if (!phrase) return null;
  if (parsed.bare) return orig.slice(0, phrase.index + phrase[0].length) + ` ${parsed.bare}` + orig.slice(phrase.index + phrase[0].length);
  return orig.slice(0, phrase.index) + `ساعت ${pad(parsed.hh)}:${pad(parsed.mm)} ${parsed.daypart}` + orig.slice(phrase.index + phrase[0].length);
}

export function resolveHourAmbiguousFollowup(answer, original, nowMs) {
  const merged = mergeHourAmbiguousFollowup(answer, original);
  if (!merged) return null;
  const r = parseReminder(merged, nowMs, merged);
  if (r.ask || !r.due) return null;
  const dm = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):00\+03:30$/.exec(r.due);
  if (!dm || Number(dm[1]) > 23 || Number(dm[2]) > 59) return null;
  return { text: r.text, due: r.due };
}

const RECALL_REMINDER_RE = /^(?:یادم\s+بنداز|یادت\s+باشه)(?=[\s،,.:؛!؟?]|$)/u;
const RECALL_QUESTION_RE = /(?:چی\s*بود|چیه|کی\s*بود|کجا\s*بود|چند\s*بود|[?؟])/u;

export function isRecallQuestionReminder(text) {
  const t = String(text ?? "").trim();
  return RECALL_REMINDER_RE.test(t) && RECALL_QUESTION_RE.test(t);
}

export { REMINDER_TRIGGERS };
