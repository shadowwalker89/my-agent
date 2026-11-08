// Step 1b-1a: pure date/time functions only. No Telegram, no D1, no KV,
// no model calls, no side effects. `now` is always passed in (ms), so
// tests are deterministic. Nothing here changes bot behaviour on its own:
// these functions are only imported by tests until 1b-2 wires them in.
export const IRAN_OFFSET_MIN = 210; // +03:30, fixed, no daylight saving
const FA = "۰۱۲۳۴۵۶۷۸۹";
const JMONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2322, 2394, 2456, 3178];
const HOURW = { "یک": 1, "دو": 2, "سه": 3, "چهار": 4, "پنج": 5, "شش": 6, "هفت": 7, "هشت": 8, "نه": 9, "ده": 10, "یازده": 11, "دوازده": 12 };
// The word for nine counts as 9 ONLY here, after the word for hour.
// It is deliberately absent from the amount word map in 1b-1b.
export function normalizeDigits(t) { return String(t ?? "").replace(/[۰-۹]/g, (d) => String(FA.indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))); }
function toFa(t) { return String(t).replace(/[0-9]/g, (d) => FA[Number(d)]); }
function pad(n) { return String(n).padStart(2, "0"); }
function iso(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
function isValidGregorian(y, m, d) { if (!Number.isInteger(y) || m < 1 || m > 12 || d < 1 || d > 31) return false; const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d; }
function addDays(date, n) { const [y, m, d] = date.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 1, d) + n * 86400000); return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()); }
export function iranDate(nowMs) { const d = new Date(nowMs + IRAN_OFFSET_MIN * 60000); return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
function jalYear(jy) { // Farvardin 1 (Gregorian year, March day) + leap flag
  const div = (a, b) => Math.floor(a / b), mod = (a, b) => a - div(a, b) * b;
  let gy = jy + 621, leapJ = -14, jp = BREAKS[0], jump = 0;
  for (let i = 1; i < BREAKS.length; i++) { jump = BREAKS[i] - jp; if (jy < BREAKS[i]) break; leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4); jp = BREAKS[i]; }
  let n = jy - jp; leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150, march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4); if (leap === -1) leap = 4;
  return { gy, march, leap: leap === 0 };
}
function jalLens(jy) { const l = jalYear(jy).leap; return [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, l ? 30 : 29]; }
export function jalaliToGregorian(jy, jm, jd) {
  const lens = jalLens(jy); if (jm < 1 || jm > 12 || jd < 1 || jd > lens[jm - 1]) return null;
  const { gy, march } = jalYear(jy), off = lens.slice(0, jm - 1).reduce((a, b) => a + b, 0) + jd - 1;
  const d = new Date(Date.UTC(gy, 2, march) + off * 86400000); return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
export function gregorianToJalali(date) {
  const [gy, gm, gd] = String(date).split("-").map(Number); if (!isValidGregorian(gy, gm, gd)) return null;
  const utc = Date.UTC(gy, gm - 1, gd);
  let jy = gy - 621, info = jalYear(jy), start = Date.UTC(info.gy, 2, info.march);
  if (utc < start) { jy -= 1; info = jalYear(jy); start = Date.UTC(info.gy, 2, info.march); }
  let rest = Math.round((utc - start) / 86400000); const lens = jalLens(jy); let jm = 1;
  while (jm <= 12 && rest >= lens[jm - 1]) { rest -= lens[jm - 1]; jm += 1; }
  return { jy, jm, jd: rest + 1 };
}
export function formatJalali(date) { const g = gregorianToJalali(date); if (!g) return null; return `${toFa(g.jd)} ${JMONTHS[g.jm - 1]} ${toFa(g.jy)}`; }
function findMonth(t) {
  // Unicode-letter boundaries: the \u0600-\u06FF range wrongly contains
  // ، and ؟, so "۷ آبان، ..." lost the month. \p{L} with the u flag
  // treats ، and ؟ as boundaries, as they are.
  for (const [m, i] of JMONTHS.map((m, i) => [m, i + 1]).sort((a, b) => b[0].length - a[0].length)) {
    if (new RegExp(`(?<!\\p{L})${m}(?!\\p{L})`, "u").test(t)) return [m, i];
  }
  return null;
}
// A date string, or null when the text names an invalid date.
// Callers turn null into an ask, never into a stored date or a crash.
export function parseRelativeDate(text, nowMs) {
  // Unify ZWNJ/space only for the relative-date phrases; full text
  // normalisation (Arabic letters, ZWNJ variants) lands in 1b-1b.
  const t = normalizeDigits(String(text ?? "")).replace(/‌/g, " "), today = iranDate(nowMs);
  if (/پس[\s‌]+فردا/.test(t)) return addDays(today, 2);
  if (/فردا/.test(t)) return addDays(today, 1);
  if (/دیروز/.test(t)) return addDays(today, -1);
  if (/امروز/.test(t)) return today;
  const g = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (g) { const [y, m, d] = [Number(g[1]), Number(g[2]), Number(g[3])]; return isValidGregorian(y, m, d) ? iso(y, m, d) : null; }
  const sl = /(\d{1,4})\/(\d{1,2})\/(\d{1,2})/.exec(t);
  if (sl) {
    const [a, b, c] = [Number(sl[1]), Number(sl[2]), Number(sl[3])];
    if (a >= 1300 && a <= 1499) return jalaliToGregorian(a, b, c); // Jalali slash date, e.g. 1405/8/7
    if (a >= 1900 && a <= 2100 && isValidGregorian(a, b, c)) return iso(a, b, c); // Gregorian slash date
    return null;
  }
  const jm = findMonth(t);
  if (jm) {
    const dm = new RegExp(`(\\d{1,2})\\s*${jm[0]}`).exec(t) || new RegExp(`${jm[0]}\\s*(\\d{1,2})`).exec(t);
    if (!dm) return today;
    // Jalali year: digit-bounded 13xx/14xx only, so 145000 never yields 1450,
    // and never a number followed by a currency word.
    let jy = gregorianToJalali(today).jy;
    const ym = /(?<!\d)(1[34]\d\d)(?!\d)/.exec(t);
    if (ym) { const after = t.slice(ym.index + ym[0].length); if (!/^\s*(تومان|ریال|دلار|یورو|€|\$)/.test(after)) jy = Number(ym[0]); }
    return jalaliToGregorian(jy, jm[1], Number(dm[1])); // null = invalid day -> caller asks
  }
  return today;
}
// Saturday-Friday week for a date. Returns null for a null/invalid date,
// so a caller can never crash on weekRange(null).
export function weekRange(date) {
  if (typeof date !== "string") return null;
  const [y, m, d] = date.split("-").map(Number); if (!isValidGregorian(y, m, d)) return null;
  const back = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 1) % 7;
  return { start: addDays(date, -back), end: addDays(date, -back + 6) };
}
export function monthRange(date) {
  if (typeof date !== "string") return null;
  const [y, m, d] = date.split("-").map(Number); if (!isValidGregorian(y, m, d)) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: iso(y, m, 1), end: iso(y, m, last) };
}
const HOUR_ALTS = "دوازده|یازده|ده|نه|هشت|هفت|شش|پنج|چهار|سه|دو|یک"; // longest first: twelve before two
function qualifierNearHour(text, hourEnd) {
  // Qualifiers count only near the hour itself (next few tokens), with
  // Unicode word boundaries, so "شبکه", "عصرانه", "صبحانه" do not qualify.
  // Phase 1-e Pillar 3: typo-tolerant — keyboard-adjacent daypart typos
  // in the window are canonicalized first, so "ساعت ۳ صبخ" qualifies
  // as morning with 0 model calls.
  const window = text.slice(hourEnd, hourEnd + 24)
    .replace(/(?<!\p{L})(?:بعدازظهر|بعداز ظهر)(?!\p{L})/gu, "بعد از ظهر")
    .replace(/(?<!\p{L})(?:صبخ|صیح|صبج|صبحی|صب)(?!\p{L})/gu, "صبح")
    .replace(/(?<!\p{L})(?:عصز|عصذ|عصری)(?!\p{L})/gu, "عصر")
    .replace(/(?<!\p{L})(?:شبی|شی)(?!\p{L})/gu, "شب");
  if (/(?<!\p{L})بعد از ظهر(?!\p{L})/u.test(window)) return "afternoon";
  if (/(?<!\p{L})عصر(?!\p{L})/u.test(window)) return "evening";
  if (/(?<!\p{L})شب(?!\p{L})/u.test(window)) return "night";
  if (/(?<!\p{L})ظهر(?!\p{L})/u.test(window)) return "noon";
  if (/(?<!\p{L})(صبح|بامداد|سحر)(?!\p{L})/u.test(window)) return "morning";
  return null;
}
// Hour phrase only: "hour" + number (digits or 1-12 words, where nine
// DOES count). Null = no hour; { ask } = ambiguous, never a guessed hour.
export function parseHour(text) {
  const t = normalizeDigits(String(text ?? ""));
  const m = new RegExp(`ساعت\\s*(\\d{1,2}|${HOUR_ALTS})(?::(\\d{1,2}))?`).exec(t); if (!m) return null;
  const hour = /^\d+$/.test(m[1]) ? Number(m[1]) : (Object.hasOwn(HOURW, m[1]) ? HOURW[m[1]] : undefined); if (hour === undefined || hour > 23) return null;
  const afterHour = t.slice(m.index + m[0].length);
  const minute = /ربع/.test(afterHour.slice(0, 12)) ? 15 : (/نیم/.test(afterHour.slice(0, 12)) ? 30 : (m[2] ? Number(m[2]) : 0));
  const q = qualifierNearHour(t, m.index + m[0].length);
  if (q === "afternoon") return { hour: hour < 12 ? hour + 12 : hour, minute };
  if (q === "evening") return { hour: hour < 12 ? hour + 12 : hour, minute };
  if (q === "night") { if (hour === 12 || hour <= 5) return { ask: "hour-ambiguous" }; return { hour: hour < 12 ? hour + 12 : hour, minute }; }
  if (q === "noon") { if (hour === 12) return { hour: 12, minute }; if (hour >= 1 && hour <= 4) return { hour: hour + 12, minute }; return { ask: "hour-ambiguous" }; }
  if (q === "morning") return { hour, minute };
  if (hour >= 12) return { hour, minute }; if (hour >= 7) return { hour, minute };
  return { ask: "hour-ambiguous" };
}
const REMINDER_TRIGGERS = /(?:یادم بینداز|یادآوری کن|یادم بنداز|یادت باشه|یادآوری)(?![\p{L}])/u;
export function parseReminder(text, nowMs, origText) {
  const now = nowMs ?? Date.now(), hour = parseHour(text);
  if (!hour) return { ask: "no-time" }; if (hour.ask) return { ask: hour.ask };
  const date = parseRelativeDate(text, now); if (date === null) return { ask: "date" };
  const [y, mo, d] = date.split("-").map(Number);
  if (Date.UTC(y, mo - 1, d, hour.hour, hour.minute) - IRAN_OFFSET_MIN * 60000 <= now) return { ask: "past" };
  // Body from the ORIGINAL text at the same indices: normalisation is
  // one-to-one, so ranges found on the normalised text align exactly.
  // Ranges removed: trigger, relative-date words, the whole hour phrase
  // (including a qualifier right after it), and a trailing quarter/half.
  const src = origText ?? text, ranges = [];
  const collect = (re) => { let mm; while ((mm = re.exec(text)) !== null) ranges.push([mm.index, mm.index + mm[0].length]); };
  collect(new RegExp(REMINDER_TRIGGERS.source, "gu"));
  collect(/پس[\s\u200c]+فردا|فردا|امروز|دیروز/g);
  collect(new RegExp(`ساعت\\s*(?:[\\d۰-۹٠-٩]{1,2}|${HOUR_ALTS})(?::[\\d۰-۹٠-٩]{1,2})?(?:\\s+و\\s+(?:ربع|نیم))?(?:\\s+(?:بعد از ظهر|بعدازظهر|بعداز ظهر|صبح|صبخ|صیح|صبج|صب|سحر|صبحی|بامداد|ظهر|عصر|عصز|عصذ|عصری|شب|شی|شبی))?`, "g")); // Phase 1-e: typo daypart forms stripped too, so they never leak into the title
  collect(/و\s+(?:ربع|نیم)/g);
  ranges.sort((a, b) => a[0] - b[0]);
  let body = "", pos = 0;
  for (const [a, b] of ranges) { if (a < pos) continue; body += src.slice(pos, a); pos = b; }
  body += src.slice(pos);
  body = body.replace(/\s+/g, " ").trim();
  if (!body) return { ask: "empty" }; // "for what?" — never store an empty reminder
  return { due: `${date}T${pad(hour.hour)}:${pad(hour.minute)}:00+03:30`, text: body };
}
// Phase 1-c-3: deterministic rule-tier fill for a pending hour-ambiguous
// reminder slot. The slot's pendingBody carries the ORIGINAL reminder
// message; the answer supplies only what was missing. Shapes resolve by
// re-running parseReminder on a merged text (so its qualifier rules
// decide, never a second time parser, and AM/PM is never guessed):
//   Shape 1 — bare daypart ("صبح", "بامداد", "ظهر", "عصر", "بعدازظهر",
//     "بعد از ظهر", "شب"): the qualifier is spliced onto the original
//     ambiguous hour, replacing any stale qualifier it already carried.
//   Shape 2 — time + daypart, with or without "ساعت" ("01:17 صبح",
//     "۱:۱۷ صبح", "ساعت ۱:۱۷ عصر"): the whole original hour phrase is
//     replaced by the clarified time + daypart.
//   Shape 3 (1-d-6) — hour + daypart without minutes ("ساعت ۳ عصر",
//     "۳ عصر"): same replacement with minutes 00.
// Returns { text, due } on a clean parse, else null.
// The merged hour phrase also absorbs a trailing half/quarter tail so a
// body never keeps a stray "و نیم". "بعدازظهر"/"بعداز ظهر" are spelled
// "بعد از ظهر" in the merge because qualifierNearHour only recognises
// the spaced form.
// 1-d-6: the answer parser and the merge are split out so the caller can
// tell "daypart reply, but unresolvable" (route the merged reminder) from
// "not a daypart reply at all" (clear the slot, never trap the message).
// Daypart detection is EXACT-SHAPE (full answer after trim/punct-strip),
// never substring: a question that merely mentions a daypart word (e.g.
// "تفاوت صبح و عصر چیه؟") must stay chat, not become a reminder answer.
// Longest-first alternation for the daypart forms (full word before its
// prefix: صبح before صب, عصری after عصر is rescued by the $ anchors
// in the consuming regexes). Cancel words are NOT dayparts — they never
// belong in a time expression — and live only in the token map below.
const DAYPART_ALT = "بعد از ظهر|بعدازظهر|بعداز ظهر|بامداد|صبح|صبخ|صیح|صبج|صب|سحر|صبحی|ظهر|عصر|عصز|عصذ|عصری|شب|شی|شبی";
// Phase 1-e Pillar 3: typo/phrase map for daypart tokens. A raw token is
// trimmed of trailing punctuation, "واسه/برای X" phrases collapse to X,
// then the map yields the canonical token (صبح/عصر/شب/cancel) or null.
// Used by parseDaypartReply, parseHour's qualifier window (indirectly,
// via DAYPART_ALT + qualifierNearHour), and resolveHourAmbiguousFollowup.
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
  const m2 = new RegExp(`^(?:ساعت\\s+)?(\\d{1,2}):(\\d{1,2})\\s+(${DAYPART_ALT})$`).exec(ans);
  if (m2) { const hh = Number(m2[1]), mm = Number(m2[2]); if (hh > 23 || mm > 59) return null; return { hh, mm, daypart: normalizeDaypartToken(m2[3]) }; }
  const m3 = new RegExp(`^(?:ساعت\\s+)?(\\d{1,2}|${HOUR_ALTS})\\s+(${DAYPART_ALT})$`).exec(ans);
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
  const phrase = new RegExp(`ساعت\\s*(?:\\d{1,2}|${HOUR_ALTS})(?::\\d{1,2})?(?:\\s+و\\s+(?:ربع|نیم))?(?:\\s+(?:${DAYPART_ALT}))?`).exec(orig);
  if (!phrase) return null;
  if (parsed.bare) return orig.slice(0, phrase.index + phrase[0].length) + ` ${parsed.bare}` + orig.slice(phrase.index + phrase[0].length);
  return orig.slice(0, phrase.index) + `ساعت ${pad(parsed.hh)}:${pad(parsed.mm)} ${parsed.daypart}` + orig.slice(phrase.index + phrase[0].length);
}
export function resolveHourAmbiguousFollowup(answer, original, nowMs) {
  const merged = mergeHourAmbiguousFollowup(answer, original);
  if (!merged) return null;
  const r = parseReminder(merged, nowMs, merged);
  if (r.ask || !r.due) return null;
  // Defensive bound: parseHour does not bound minutes, so never store a
  // due with an impossible HH:MM even if the splice produced one.
  const dm = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):00\+03:30$/.exec(r.due);
  if (!dm || Number(dm[1]) > 23 || Number(dm[2]) > 59) return null;
  return { text: r.text, due: r.due };
}
export { REMINDER_TRIGGERS };
// ── Step 1b-1b: amount and classifier (on top of 1b-1a) ─────────────────
// Normalisation runs FIRST, before every pattern in this section.
// Object-key safety: every map lookup below uses Object.hasOwn, never
// bare indexing, so a user word like "constructor" cannot return a
// function from Object.prototype.
export const DEFAULT_CURRENCY = "TOMAN";
const CUR = { "تومان": "TOMAN", "تومنی": "TOMAN", "تومن": "TOMAN", "ریال": "IRR", "دلار": "USD", "یورو": "EUR", "€": "EUR", "$": "USD" };
const ONES = { "یک": 1, "دو": 2, "سه": 3, "چهار": 4, "پنج": 5, "شش": 6, "هفت": 7, "هشت": 8, "ده": 10, "یازده": 11, "دوازده": 12, "سیزده": 13, "چهارده": 14, "پانزده": 15, "شانزده": 16, "هفده": 17, "هجده": 18, "نوزده": 19 };
const TENS = { "بیست": 20, "سی": 30, "چهل": 40, "پنجاه": 50, "شصت": 60, "هفتاد": 70, "هشتاد": 80, "نود": 90 };
const HUNDREDS = { "صد": 100, "دویست": 200, "سیصد": 300, "چهارصد": 400, "پانصد": 500, "ششصد": 600, "هفتصد": 700, "هشتصد": 800, "نهصد": 900 };
const COUNTING = new Set(["تا", "عدد", "کیلو", "گرم", "لیتر", "متر", "نفر", "دانه", "مرتبه", "دفعه", "بار", "جلد", "بسته", "ساعت"]); const MULTS = new Set(["هزار", "میلیون", "میلیارد"]);
export function normalizeText(t) {
  return String(t ?? "").replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/‌/g, " "); // one-to-one only: no collapse, no trim, so indices match the original text
}
function stripThousands(t) { return String(t).replace(/(\d)[,٬](?=\d{3}(?!\d))/g, "$1"); }
function has(map, key) { return Object.hasOwn(map, key); }
// Parse a number phrase: a run of number tokens (digits or words)
// joined by "و", composed into segments, each optionally multiplied
// by thousand/million, and summed. A bare multiplier alone is its own
// value (هزار = 1000). A bare segment after a million segment, without
// thousand, is ambiguous (2,000,500 vs colloquial 2.5 million) and
// returns an error instead of either value.
export function parseNumberPhrase(toks, start = 0) {
  const segments = []; let i = start, cur = 0, seen = false, lastNumber = false;
  while (i < toks.length) {
    const tok = toks[i];
    if (tok === "و") { if (!seen && segments.length === 0) break; lastNumber = false; i++; continue; }
    if (tok === "هزار" || tok === "میلیون") { segments.push({ value: seen ? cur : 1, mult: tok }); cur = 0; seen = false; lastNumber = false; i++; continue; }
    let v = null;
    if (/^\d+$/.test(tok)) v = Number(tok); else if (has(ONES, tok)) v = ONES[tok]; else if (has(TENS, tok)) v = TENS[tok]; else if (has(HUNDREDS, tok)) v = HUNDREDS[tok];
    if (v === null) break;
    if (lastNumber) return { error: "ambiguous", consumed: i - start }; // "دو سه" without "و" never sums
    cur += v; seen = true; lastNumber = true; i++;
  }
  if (seen) segments.push({ value: cur, mult: null });
  if (segments.length === 0) return null;
  for (let j = 0; j < segments.length - 1; j++) if (segments[j].mult === "میلیون" && segments[j + 1].mult === null) return { error: "ambiguous", consumed: i - start };
  const value = segments.reduce((a, sg) => a + sg.value * (sg.mult === "هزار" ? 1000 : sg.mult === "میلیون" ? 1000000 : 1), 0);
  return { value, consumed: i - start, bareMultiplier: segments.length === 1 && segments[0].mult !== null && segments[0].value === 1 };
}
export function resolveDefaultCurrency(remembered) {
  if (typeof remembered === "string") {
    if (has(CUR, remembered)) return CUR[remembered];
    if (remembered.endsWith("ه") && has(CUR, remembered.slice(0, -1))) return CUR[remembered.slice(0, -1)];
    if (["TOMAN", "IRR", "USD", "EUR"].includes(remembered)) return remembered;
  }
  return DEFAULT_CURRENCY;
}
export function sumByCurrency(rows) { const out = {}; for (const r of rows || []) { if (!r || !Number.isInteger(r.amount)) continue; const c = r.currency_code || DEFAULT_CURRENCY; out[c] = (out[c] || 0) + r.amount; } return out; }
const CUR_WORDS = ["تومان", "تومنی", "تومن", "ریال", "دلار", "یورو", "€", "$"];
// Amount, anchored to the currency word when present. Number words count
// ONLY when followed by a currency word. A bare digit amount is returned
// with anchored:false and is only used by the classifier when a verb is
// present and the digit is not next to a month name or counting word.
export function parseAmount(text, rememberedCurrency) {
  const t = stripThousands(normalizeDigits(normalizeText(text)));
  if (/(\d+)\s*[.٫,]\s*(\d+)\s*(?:هزار|میلیون)?\s*(?:تومان|تومنی|تومن|ریال|دلار|یورو|€|\$)/.test(t)) return { error: "decimal" };
  const toks = t.replace(/[؟?!.،,]/g, " ").split(/\s+/).filter(Boolean);
  const ci = toks.findIndex((x) => CUR_WORDS.includes(x));
  if (ci >= 0) {
    // Unknown token directly before a multiplier asks, never silently 1000.
    // Known non-number tokens (verbs, dates, prepositions) do not count:
    // "خرج کردم هزار تومان" is still 1000, but "نه/فلان هزار" asks.
    if (ci > 1 && (toks[ci - 1] === "هزار" || toks[ci - 1] === "میلیون")) {
      const prev = toks[ci - 2];
      const knownNonNumber = new Set(["خرج", "کردم", "پرداخت", "خریدم", "خرید", "گرفتم", "دریافت", "امروز", "دیروز", "فردا", "را", "برای", "از", "به", "در", "با", "است", "هست", ...JMONTHS]);
      if (prev !== "و" && !/^\d+$/.test(prev) && !has(ONES, prev) && !has(TENS, prev) && !has(HUNDREDS, prev) && !knownNonNumber.has(prev)) return { error: "unknown-number" };
    }
    // Find a number phrase ending exactly at the currency token.
    for (let s = Math.max(0, ci - 7); s < ci; s++) {
      const ph = parseNumberPhrase(toks.slice(s, ci), 0);
      if (ph?.error === "ambiguous") return { error: "amount" };
      if (ph && ph.consumed === ci - s) {
        if (ph.value <= 0 || ph.value > Number.MAX_SAFE_INTEGER) return { error: "amount" };
        return { amount: ph.value, currency: CUR[toks[ci]], matched: toks.slice(s, ci + 1).join(" "), anchored: true, bareMultiplier: ph.bareMultiplier };
      }
    }
    return null;
  }
  return null;
}
// Bare digits usable as an amount: digits NOT adjacent to a month name
// or a counting word (so "۷ آبان" and "۳ تا" are never money).
// Returns { digits: [...] } with the surviving digit values in order.
export function bareDigits(text) {
  const toks = stripThousands(normalizeDigits(normalizeText(text))).replace(/[؟?!.،,]/g, " ").split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    if (!/^\d+$/.test(toks[i])) continue;
    const prev = toks[i - 1], next = toks[i + 1];
    if (JMONTHS.includes(prev) || JMONTHS.includes(next) || COUNTING.has(prev) || COUNTING.has(next) || MULTS.has(prev) || MULTS.has(next)) continue;
    out.push(Number(toks[i]));
  }
  return out;
}
const STOP = new Set(["تومان", "ریال", "دلار", "یورو", "€", "$", "امروز", "دیروز", "فردا", "خرج", "کردم", "پرداخت", "خریدم", "خرید", "گرفتم", "دریافت", "را", "برای", "از", "به", "در", "با", "و", "است", "هست", "هزار", "میلیون", ...JMONTHS]);
function stripItem(text, amount, origText) {
  // Item from the ORIGINAL text; normalisation is for matching only.
  const amtToks = amount?.matched ? amount.matched.split(/\s+/) : [];
  return String(origText ?? text).replace(/پس[\s‌]فردا/g, " ").replace(/[؟?!.،,]/g, " ").split(/\s+/).filter(Boolean).filter((tok) => !normalizeDigits(normalizeText(tok)).split(/\s+/).filter(Boolean).every((pt) => STOP.has(pt) || /^\d+$/.test(pt) || amtToks.includes(pt))).join(" ").trim();
}
export function parseExpense(text, opts = {}, origText) {
  const a = parseAmount(text, opts.rememberedCurrency);
  if (a?.error) return a;
  // Currency/multiplier with no parsable amount asks, never a bare fallback (500 هزار -> 500).
  if (!a && /(?<!\p{L})(تومان|تومنی|تومن|ریال|دلار|یورو|هزار|میلیون|میلیارد|€|\$)(?!\p{L})/u.test(normalizeText(text))) return { error: "amount" };
  let amount = a;
  if (!a) {
    // Bare digits only: exactly one surviving digit becomes the amount.
    const digits = bareDigits(text);
    if (digits.length !== 1) return { error: "ambiguous" };
    amount = { amount: digits[0], currency: resolveDefaultCurrency(opts.rememberedCurrency), matched: String(digits[0]), anchored: false };
  }
  if (amount.amount <= 0 || amount.amount > Number.MAX_SAFE_INTEGER) return { error: "amount" };
  const date = parseRelativeDate(text, opts.nowMs ?? Date.now()); if (date === null) return { error: "date" };
  return { ...amount, date, item: stripItem(text, amount, origText), category: null };
}
const EXPENSE_VERBS = /(?<!\p{L})(خرج کردم|پرداخت کردم|خریدم|خرید کردم)(?![\p{L}])/u, INCOME_VERBS = /(?<!\p{L})(دریافت کردم|واریز شد|حقوق گرفتم|پول گرفتم)(?![\p{L}])/u;
const WEAK_BUY = /(?<!\p{L})(خریدم|خرید کردم)(?![\p{L}])/u; const NEGATED_RE = /(?<!\p{L})(نکردم|نکرد|نخریدم|نگرفتم|نپرداختم|ندریافتم|ندادم|نخواهم|نمی\s+کنم|نمی\s+خواهم|نمی\s+خرم|نمی\s+دهم|نکنم)(?![\p{L}])/u;
const NOTE_RE = /^\s*(?:(?:لطفا|لطفاً|ببین)\s+)?(?:یادداشت\s+کن(?![\p{L}])|یادداشت\s*[:：])\s*([\s\S]+)/u, REMINDER_RE = /(?<!\p{L})(?:یادم بینداز|یادآوری کن|یادم بنداز|یادت باشه)(?![\p{L}])/u;
// Phase 2-l: conversational note framing. A greeting/politeness/modal
// opener before the note phrase, or a trailing "… اینو برام یادداشت کن",
// is still a note. The note verb accepts only imperative/second-person
// forms (کن/کنی/کنید/بنویس/...), so the pinned first-person
// "می‌خواهم یادداشت کنم" stays chat (see the 1b-1b regression test).
const NOTE_FRAMING = String.raw`(?:(?:سلام|درود|سلام\s+علیکم|وقت\s+بخیر|صبح\s+بخیر|عصر\s+بخیر|شب\s+بخیر|لطفا|لطفاً|بی\s*زحمت|ممنون|مرسی|خواهشا|خواهشاً|می\s*خوام|می\s*خواهم|میخوام|میخواهم|می\s*خواستم|میخواستم|میشه|می\s*شه|می\s*تونی|میتونی|می\s*تونید|میتونید)\s*[،,!.؛;:]?\s*)*`;
const NOTE_VERB = String.raw`(?:ثبت\s+|ذخیره\s+|ایجاد\s+|نوشتن\s+)?(?:کنی|کنید|کن|بنویسی|بنویس|بذاری|بذار|بگذاری|بگذار|بکنی|بکن)(?!\p{L})`;
const NOTE_LEAD_RE = new RegExp(String.raw`^${NOTE_FRAMING}(?:(?:یه|یک)\s+)?یادداشت(?:\s+جدید)?(?:\s+(?:برام|واسم|برای\s+من|برایم|برا\s+من))?\s*${NOTE_VERB}(?:\s+که(?!\p{L}))?\s*[:：]?\s*([\s\S]+)$`, "ud");
const NOTE_TAIL_RE = new RegExp(String.raw`^([\s\S]{2,}?)\s*[،,؛;]?\s*(?:(?:اینو|این\s+رو|این\s+را|اونو|اون\s+رو|اون\s+را)\s+)?(?:برام|واسم|برای\s+من|برایم|برا\s+من)?\s*(?:(?:یه|یک)\s+)?یادداشت(?:\s+جدید)?\s*${NOTE_VERB}(?:\s+که(?!\p{L}))?\s*[.؟?!]?\s*$`, "ud");
const CONV_NOTE_TRIGGER_A = String.raw`(?:یه|یک)?\s*(?:نوت|یادداشت|نوتی|یادداشتی)\s+(?:جدید\s+)?(?:برام\s+)?(?:ثبت\s*کن(?:م|ی|ید)?|بنویس(?:م|ی|ید)?|ذخیره\s*کن(?:م|ی|ید)?|بذار(?:م|ی|ید)?|اضافه\s*کن(?:م|ی|ید)?)`;
const CONV_NOTE_TRIGGER_B = String.raw`(?:این(?:و|\s+رو|\s+را)?\s+(?:برام\s+)?(?:یادداشت|نوت|ثبت|ذخیره)\s*کن(?:م|ی|ید)?)`;
const CONV_NOTE_RE = new RegExp(String.raw`^(?:(?:سلام|درود|وقت\s+بخیر|خسته\s+نباشی|بی\s*زحمت|لطفا|لطفاً|ببین)\s*[\s،,.:!-]*)*(?:(?:من|می\s*خوام|میخوام|می\s*خواستم|میشه|می\s*شه|میتونی|می\s*تونی)\s*[\s،,.:!-]*)*(?:${CONV_NOTE_TRIGGER_A}|${CONV_NOTE_TRIGGER_B})\\s*(?:\\s+که\\s+|[\\s:：.،,؛\\-]+)\\s*(.+)$`, "ud");
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
function parseConversationalNote(raw, text) {
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
// 1-d-4: summary/table requests. The trailing verb phrase is stripped
// first — this MUST run before note-query, else "project notes,
// summarize them" misreads as a project filter with a junk name — then
// the subject is a note/task head with an optional project name. Only
// summarize/tabulate verbs count (tell/show verbs are not summary).
// A bare date word is not a project name: summary has no date
// dimension, so it degrades to unfiltered rather than a bogus project.
export function parseSummaryQuery(raw) {
  const t = String(raw ?? "").trim().replace(/[؟?!.،,]+$/u, "");
  const m = /^(.*?)(?:\s+(?:رو|را))?\s+(?:خلاصه|جدول)(?:\s+و\s+(?:خلاصه|جدول))?\s*(?:کن|کنید|بکن)\s*$/u.exec(t);
  if (!m) return null;
  const subj = m[1].trim();
  const nm = /^(یادداشت|تسک)\s*های?/u.exec(subj);
  if (!nm) return null;
  const kind = nm[1] === "یادداشت" ? "note" : "task";
  const rest = subj.slice(nm[0].length).trim();
  if (!rest || /^(?:م|مو|من|امروز|دیروز)$/.test(rest)) return kind === "task" ? null : { intent: "summary", confidence: 1, kind, projectName: null };
  const pm = /^پروژه\s+(.+)$/u.exec(rest);
  if (pm && pm[1].trim()) return { intent: "summary", confidence: 1, kind, projectName: pm[1].trim() };
  return { intent: "summary", confidence: 1, kind, projectName: rest };
}
const NOTE_QUERY_RE = /(یادداشت\s*های(م|مو| امروز)?|یادداشت\s*هامو?|نوت\s*های(م|مو)?|نوت\s*هامو?)/;
// Phase 2-g: colloquial list routing for tasks and reminders (zero
// model calls). This replaces the 1-b-1 TASK_LIST_RE closed list, which
// missed the colloquial object marker «رو» (it allowed only formal
// «را»), the verbs بیار/لیست کن, the «های من» possessive, and the
// کار/یادآوری/ریمایندر subjects — so «تسک‌هام رو نشون بده» fell
// through to free chat while «یادداشت‌هام رو نشون بده» matched
// deterministically (that divergence is the proven 2-g trace finding).
// Grammar: [لیست|فهرست] SUBJECT [پروژه <name>] [رو|را] [show verb],
// where SUBJECT is تسک/کار (→ task-list) or یادآوری/ریمایندر
// (→ reminder-list) with a plural/possessive ending. A bare subject
// or a marker-only tail still requires a possessive or a project
// segment; any other tail (a body word, ببینم, جلسه, جدول کن)
// rejects, so creation and chat keep their existing routes.
const LIST_SUBJECT_RE = /^(تسک|کار|یادآوری|ریمایندر)\s*(?:(های|ها)\s*(مو|من|یم|م)?|(هامو|هام))\s*/u;
const LIST_TAIL_RE = /^(?:(رو|را)\s+)?(نشان\s+بده|نشون\s+بده|نمایش\s+بده|بیار|بیاور|لیست\s+کنید|لیست\s+کن|لیست|چی\s+دارم|چه\s+دارم|چه\s+(?:\S+\s+){0,3}دارم)$/u;
// NOTE: no \b here — JavaScript \b is ASCII-only, so it never matches
// after a Persian word (رو followed by a space has no ASCII boundary
// and the project name would swallow the whole tail). The verb is
// instead followed by an explicit whitespace-or-end guard.
const LIST_PROJECT_RE = /(?:^|\s+)(?:(?:توی|تو|در|برای|بابت)\s+)?پروژه\s+(.+?)(?=\s+(?:رو|را|نشان\s+بده|نشون\s+بده|نمایش\s+بده|بیار|بیاور|لیست|چی|چه)(?:\s|$)|\s*$)/u;
export function parseListRequest(raw) {
  let s = String(raw ?? "").trim().replace(/[؟?!.،,]+$/u, "");
  s = s.replace(/^(?:لیست|فهرست)\s+/u, "");
  const subj = LIST_SUBJECT_RE.exec(s);
  if (!subj) return null;
  const intent = subj[1] === "تسک" || subj[1] === "کار" ? "task-list" : "reminder-list";
  const possessive = Boolean(subj[3] || subj[4]);
  let rest = s.slice(subj[0].length).trim();
  let projectName = null;
  const pm = LIST_PROJECT_RE.exec(rest);
  if (pm && pm[1].trim()) {
    projectName = pm[1].trim().replace(/[؟?!.،,]+$/u, "").trim();
    rest = `${rest.slice(0, pm.index)} ${rest.slice(pm.index + pm[0].length)}`.replace(/\s+/g, " ").trim();
  }
  if (rest === "") return possessive || projectName ? { intent, confidence: 1, projectName } : null;
  if (/^(رو|را)$/.test(rest)) return possessive || projectName ? { intent, confidence: 1, projectName } : null;
  if (LIST_TAIL_RE.test(rest)) return { intent, confidence: 1, projectName };
  return null;
}
const FILE_RE = /(?<!\p{L})(خلاصه\s+اش\s+کن(?![\p{L}])|خلاصه\s+کن(?![\p{L}])|خلاصه\s+اش|این فایل را خلاصه\s+کن(?![\p{L}]))/u;
const TRANSLATE_VERB = /(?<!\p{L})(?:ترجمه\s+(?:کن|کنید|بکن))(?![\p{L}])/u;
function countAnchoredAmounts(text) { const toks = stripThousands(normalizeDigits(normalizeText(text))).replace(/[؟?!.،,]/g, " ").split(/\s+/).filter(Boolean); let n = 0; for (let ci = 0; ci < toks.length; ci++) if (CUR_WORDS.includes(toks[ci])) for (let s = Math.max(0, ci - 7); s < ci; s++) { const ph = parseNumberPhrase(toks.slice(s, ci), 0); if (ph && !ph.error && ph.consumed === ci - s) { n++; break; } } return n; }
const CLAUSE_SEP_RE = /[.،؛;!?؟\n]+/gu;
function isLongDiscussion(text) {
  const s = String(text ?? "");
  if (s.length > 160) return true;
  const seps = s.match(CLAUSE_SEP_RE);
  return Boolean(seps && seps.length >= 3);
}
function isExplicitStandaloneCommand(text) {
  const s = String(text ?? "").trim();
  if (!s) return false;
  const head = s.slice(0, 48), tail = s.slice(-64);
  return /^(?:لطفا\s+|لطفاً\s+|ببین\s+)?(?:یادداشت\s*کن|یادداشت\s*:|بنویس|تسک\s*:|تسک\s+جدید\s*:|یه\s+تسک\s+|پروژه\s+جدید|یادم\s+بنداز|یادت\s+باشه|یادآوری\s+کن)/u.test(head)
    || /(?:یادداشت\s*کن|ثبت\s*(?:اش|ش)?\s*کن|ذخیره\s*(?:اش|ش)?\s*کن|بذار|نگه\s*دار|یادم\s+بنداز|یادت\s+باشه|تسک\s*:)\s*[.،؛;!?؟\s]*$/u.test(tail);
}
const NEGATED_COMMAND_RE = /(?<!\p{L})(?:ثبت(?:[‌\s]*(?:اش|ش))?\s*نکن|ذخیره(?:[‌\s]*(?:اش|ش))?\s*نکن|نساز|نذار|نفرست|نگه\s*ندار|اضافه\s*نکن)(?![\p{L}])/u;
function isNegatedCommand(text) {
  return NEGATED_COMMAND_RE.test(String(text ?? ""));
}
// Rule-only classifier. Confident = 1; ambiguous = { intent: "ask" }.
// Never a guess, never a model call. Strict translate is checked FIRST:
// a bare word "translate" anywhere is not a translate, only the verb is.
export function classifyDaily(text, opts = {}, projectsArg = null) {
  // Phase 2-b: the project list may arrive as a numeric nowMs, as an
  // opts object carrying `projects`, or as the third argument — all
  // existing callers (opts objects, or none) keep working unchanged.
  if (typeof opts === "number") opts = { nowMs: opts };
  if (opts && Array.isArray(opts.projects) && !projectsArg) projectsArg = opts.projects;
  const now = opts.nowMs ?? Date.now(), raw = normalizeText(text);
  if (!raw.trim()) return { intent: "chat", confidence: 1 };
  if (raw.trimStart().startsWith("/")) return { intent: "command", confidence: 1 };
  if (isNegatedCommand(raw)) return { intent: "chat", confidence: 1 };
  const longDiscussion = isLongDiscussion(raw);
  const keywordInLongDiscussion = longDiscussion && !isExplicitStandaloneCommand(raw);
  const trVerb = TRANSLATE_VERB.exec(raw);
  if (trVerb) {
    // Destination: a known language maps to its code; any other word after
    // "به" with a colon passes through as written, never null with the
    // prefix left in the text sent to the model. The body is sliced from
    // the original text (indices align: normalisation is one-to-one).
    const verbEnd = trVerb.index + trVerb[0].length, afterNorm = raw.slice(verbEnd);
    const known = /^\s*[:：]?\s*به\s+(انگلیسی|فارسی|en|fa)\s*[:：]?\s*/u.exec(afterNorm);
    const other = /^\s*[:：]?\s*به\s+(\S+)\s*[:：]\s*/u.exec(afterNorm);
    let target = null, bodyStart = 0;
    if (known) { target = known[1] === "انگلیسی" || known[1] === "en" ? "en" : "fa"; bodyStart = known[0].length; }
    else if (other) { target = other[1]; bodyStart = other[0].length; }
    else bodyStart = /^\s*[:：]?\s*/.exec(afterNorm)[0].length;
    const body = text.slice(verbEnd + bodyStart).trim();
    if (!body) return { intent: "translate", confidence: 0.5, ask: "text" };
    return { intent: "translate", confidence: 1, target, text: body };
  }
  // Remember/note/reminder are UNANCHORED now that strict translate runs
  // first, so a reminder at the end of a message is still caught.
  const rem = /(?<!\p{L})(?:یادت باشد|یادت باشه|به خاطر بسپار)(?![\p{L}])\s+([\s\S]+)/u.exec(raw);
  if (rem) {
    const rest = rem[1].trim();
    // A remember match that is not a setting attempt falls through to
    // the reminder check below, so "tomorrow at 9, remember ..." with
    // the colloquial form is a reminder, not a refused setting. Only a
    // genuine setting attempt (currency/language/name keyword) can refuse.
    const isSetting = /^(?:ارزم|ارز[\s\u200c]|زبانم|زبان[\s\u200c]|نامم|اسمم)/.test(rest);
    if (isSetting) {
      const cur = /^(?:ارز[\s\u200c]+پیش[\s\u200c]*فرضم|ارزم)\s+(\S+)/u.exec(rest);
      if (cur) { const tok = cur[1].replace(/[؟?!.،,]+$/, ""); const code = has(CUR, tok) ? CUR[tok] : (tok.endsWith("ه") && has(CUR, tok.slice(0, -1)) ? CUR[tok.slice(0, -1)] : (["TOMAN", "IRR", "USD", "EUR"].includes(tok) ? tok : null)); return code ? { intent: "remember", confidence: 1, setting: { key: "currency", value: code } } : { intent: "remember", confidence: 1, refused: true }; }
      const lang = /^(?:زبانم|زبان)\s+(\S+)/.exec(rest);
      if (lang) { const v = lang[1] === "انگلیسی" ? "en" : lang[1] === "فارسی" ? "fa" : (lang[1] === "en" || lang[1] === "fa" ? lang[1] : null); return v ? { intent: "remember", confidence: 1, setting: { key: "language", value: v } } : { intent: "remember", confidence: 1, refused: true }; }
      const name = /^(?:نامم|اسمم)\s+([\s\S]+)/.exec(rest);
      if (name) { let v = name[1].trim().replace(/\s+(است|هست)$/, "").trim(); return v && v.length <= 50 ? { intent: "remember", confidence: 1, setting: { key: "name", value: v } } : { intent: "remember", confidence: 1, refused: true }; }
      return { intent: "remember", confidence: 1, refused: true };
    }
  }
  // 1-d-6: a folder phrase between the leading keyword and the colon
  // ("یادداشت توی پروژه گلبهار: ...") must not fall through to chat:
  // classify the phrase-stripped body; the branch re-derives the
  // project from the original text via extractFolderTag's middle form.
  // Only note/task-create/reminder verdicts return here, so any other
  // stripped reading falls through to the normal checks below.
  const mid = stripMiddleFolderTag(text);
  if (mid) { const c2 = classifyDaily(mid.body, opts, projectsArg); if (c2.intent === "note" || c2.intent === "task-create" || c2.intent === "reminder") return c2; }
  // Phase 1-e Pillar 2: deterministic natural note forms without a
  // colon (0 model calls). Placed BEFORE NOTE_RE so the "که" particle
  // is stripped from the body (NOTE_RE would keep it) and a stray
  // colon after کن is dropped; the (?!\p{L}) guard keeps words like
  // کهکشان intact. A trigger with no body still falls through to the
  // bare-note ask below.
  for (const re of [/^(?:اینو\s+)?یادداشت\s+کن(?:\s+که(?!\p{L}))?\s*:?\s*([\s\S]+)$/ud, /^بنویس(?:\s+توی\s+یادداشت\s*های?م)?\s+([\s\S]+)$/ud]) {
    const m = re.exec(raw);
    if (m && m[1].trim().replace(/[؟?!.،,:：\s]+/gu, "")) return { intent: "note", confidence: 1, text: text.slice(m.indices[1][0], m.indices[1][1]).trim() };
  }
  const note = NOTE_RE.exec(raw); if (note && note[1].trim().replace(/[؟?!.،,:：\s]+/gu, "")) return { intent: "note", confidence: 1, text: text.slice(note.index + note[0].length - note[1].length).trim() };
  // Phase 2-l: greeting/politeness/modal openers and the trailing
  // "… اینو برام یادداشت کن" form are notes too, with the framing
  // stripped from the stored body.
  const convNoteDirect = CONV_NOTE_RE.exec(raw);
  if (convNoteDirect && convNoteDirect[1] && String(convNoteDirect[1]).trim().replace(/[؟?!.،,:：\s]+/gu, "")) return { intent: "note", confidence: 1, text: text.slice(convNoteDirect.indices[1][0], convNoteDirect.indices[1][1]).trim() };
  const convNote = parseConversationalNote(raw, text);
  if (convNote) return { intent: "note", confidence: 1, text: convNote };
  // Bare note: only a note trigger, no body. Ask for the text at rule
  // level instead of falling through to chat, where the live model
  // answered chat and hallucinated a stored note (2026-10-30). Anchored
  // to the whole message (trailing punctuation stripped), so a note
  // WITH a body is never stolen. The longer "می‌خوام … ثبت کنم" forms
  // are a closed whole-message list for the same reason.
  const bareNote = raw.trim().replace(/[؟?!.،,:：\s]+$/u, "");
  if (/^(?:(?:لطفا|لطفاً|ببین)\s+)?(?:یادداشت\s+کن|یادداشت\s+جدید|یادداشت)$/u.test(bareNote)
    || /^(?:می\s*خوام|می\s*خواهم|میخوام|میخواهم)\s+(?:یک\s+)?یادداشت(?:\s+جدید)?(?:\s+و\s+جداگانه)?\s+(?:ثبت\s+کنم|بنویسم|ایجاد\s+کنم|بکنم)$/u.test(bareNote)) return { intent: "ask", confidence: 0.5, question: "note-text" };
  if (!keywordInLongDiscussion && REMINDER_RE.test(raw)) { const r = parseReminder(raw, now, text); return r.ask ? { intent: "reminder", confidence: 0.5, ask: r.ask } : { intent: "reminder", confidence: 1, due: r.due, text: r.text }; }
  // 1-d-2: natural project creation, project listing, deterministic
  // task creation. Placed before expense inference so an explicit
  // "task:" / "project" prefix wins over a verb/amount reading. Bodies
  // are sliced from the original text (normalisation is one-to-one, so
  // indices align); names strip trailing punctuation.
  const stripPunct = (s) => String(s ?? "").replace(/[؟?!.،,:：\s]+$/u, "").trim();
  for (const re of [/^پروژه جدید\s*[:：]\s*(.+)$/ud, /^پروژه جدید به اسم\s+(.+)$/ud, /^یه پروژه جدید تعریف کن به اسم\s+(.+)$/ud, /^پروژه\s+(.+?)\s+رو\s+(?:بساز|تعریف کن)\s*[؟?!.،,]*$/ud]) {
    const m = re.exec(raw);
    if (m) { const name = stripPunct(text.slice(m.indices[1][0], m.indices[1][1])); if (name) return { intent: "project-create", confidence: 1, name }; }
  }
  if (/^(?:پروژه\s+ها\s*(?:م|یم|ی\s+من|من)?|پروژه\s+هام|لیست\s+پروژه\s+ها|فهرست\s+پروژه\s+ها)\s*[؟?!.،,]*$/u.test(raw)) return { intent: "project-list", confidence: 1 };
  // Phase 1-e Pillar 2: deterministic natural task forms without a
  // colon ("یه تسک بذار ...", "تسک ثبت کن که ..."). Placed before the
  // colon-prefix loop; colon forms still match through the :? tail.
  if (!keywordInLongDiscussion) {
    const m = /^(?:یه\s+)?تسک\s+(?:جدید\s+)?(?:ثبت\s*کن|بذار|اضافه\s*کن)(?:\s+که(?!\p{L})|\s+برای(?!\p{L}))?\s*:?\s*([\s\S]+)$/ud.exec(raw);
    if (m && m[1].trim().replace(/[؟?!.،,:：\s]+/gu, "")) return { intent: "task-create", confidence: 1, text: text.slice(m.indices[1][0], m.indices[1][1]).trim() };
  }
  if (!keywordInLongDiscussion) for (const re of [/^تسک\s*[:：]\s*(.+)$/ud, /^تسک جدید\s*[:：]\s*(.+)$/ud, /^تسک ثبت کن\s*[:：]\s*(.+)$/ud, /^به تسک\s*هامو?\s+اضافه کن\s*[:：]\s*(.+)$/ud]) {
    const m = re.exec(raw);
    if (m) { const body = text.slice(m.indices[1][0], m.indices[1][1]).trim(); if (body) return { intent: "task-create", confidence: 1, text: body }; }
  }
  // Expense query: needs "how much/total" or a period word with a question
  // mark. An unknown period (e.g. last week) asks, never returns today.
  // An invalid date asks, never calls weekRange(null).
  const amount = parseAmount(raw, opts.rememberedCurrency);
  const hasHowMuch = /چقدر|چقد|مجموع/.test(raw), hasQuestion = /[؟?]\s*$/.test(raw);
  const periodWord = /این هفته/.test(raw) ? "week" : /این ماه/.test(raw) ? "month" : /دیروز/.test(raw) ? "yesterday" : /امروز/.test(raw) ? "today" : null;
  const isReportQuery = /خرجای|خرج\s*ها|خرج‌ها|خرج\s*(امروز|این\s*هفته|این\s*ماه)|هزینه\s*ها|هزینه‌ها|هزینه‌های|هزینه\s*(امروز|این\s*هفته|این\s*ماه)|مخارج|لیست\s*خرج|گزارش\s*(خرج|هزینه|مالی)|حساب\s*کتاب|چقدر\s*خرج\s*کردم/u.test(raw) && !/(گذشته|قبل|اخیر|پریروز|سال|پیش|تا\s*حالا|مجموع)/u.test(raw);
  const unknownPeriod = (/(گذشته|قبل|اخیر|پریروز|سال)/.test(raw) || /(?<!\p{L})پیش(?!\p{L})/u.test(raw) || (findMonth(raw) && !new RegExp(`[0-9۰-۹٠-٩]+\\s*${findMonth(raw)[0]}|${findMonth(raw)[0]}\\s*[0-9۰-۹٠-٩]+`).test(raw)));
  const hasExpenseWord = /خرج|هزینه|مخارج/u.test(raw);
  // Last-expense question: answered from D1, never from the chat model.
  // Placed before the period query (so "آخرین خرج چقدر بود؟" is not a
  // period ask) but never steals a recordable expense (amount + verb).
  if (/(?<!\p{L})(خرج\s+قبلی|آخرین\s+خرج|خرج\s+آخر)(?!\p{L})/u.test(raw) && !(amount?.anchored && EXPENSE_VERBS.test(raw))) return { intent: "last-expense", confidence: 1 };
  const effectivePeriodWord = periodWord || (isReportQuery ? "today" : null);
  if (hasExpenseWord && (hasHowMuch || (effectivePeriodWord && (hasQuestion || isReportQuery)) || isReportQuery) && !(amount?.anchored && EXPENSE_VERBS.test(raw))) {
    if (unknownPeriod || (!effectivePeriodWord && !findMonth(raw) && !/(?:\d{4}-\d{2}-\d{2}|\d{1,4}\/\d{1,2}\/\d{1,2})/.test(normalizeDigits(raw)))) return { intent: "expense-query", confidence: 0.5, ask: "period" };
    const date = parseRelativeDate(raw, now); if (date === null) return { intent: "expense-query", confidence: 0.5, ask: "date" };
    const period = effectivePeriodWord || "today";
    let range;
    if (period === "week") { range = weekRange(date); if (!range) return { intent: "expense-query", confidence: 0.5, ask: "date" }; }
    else if (period === "month") { range = monthRange(date); if (!range) return { intent: "expense-query", confidence: 0.5, ask: "date" }; }
    else range = { start: date, end: date };
    return { intent: "expense-query", confidence: 1, kind: "report", period, range };
  }
  // Declaration expense: a spoken-style "new expense" declaration with
  // خرید but no past-tense verb ("یک هزینه جدید خرید نون 1500 تومن")
  // previously fell to chat conf 1 via the token-count fallback below,
  // so a live voice expense was answered by chat and never stored.
  // Placed before the verb branch so the خرج variant gets the same
  // cleaned item (the verb branch's خرج+anchored path kept "جدید" in
  // the item); verb-only messages cannot fire it (they lack جدید+خرید).
  // Fires only for an explicit declaration + خرید + anchored amount +
  // a remaining item noun, with no query wording and no negation.
  // Normalisation already turns ZWNJ into a space, so "هزینه‌ی جدید"
  // arrives as the tokens هزینه / ی / جدید.
  if (amount?.anchored && !NEGATED_RE.test(raw) && !/چقدر|چقد|چند|چیست/.test(raw) && !/[؟?]\s*$/.test(raw)) {
    const toks = raw.replace(/[؟?!.،,]/g, " ").split(/\s+/).filter(Boolean);
    let decl = -1;
    for (let i = 0; i < toks.length; i++) {
      if ((toks[i] === "هزینه" || toks[i] === "خرج") && (toks[i + 1] === "جدید" || (toks[i + 1] === "ی" && toks[i + 2] === "جدید"))) { decl = i; break; }
    }
    if (decl >= 0 && toks.includes("خرید")) {
      if (countAnchoredAmounts(raw) >= 2) return { intent: "ask", confidence: 0.5, question: "amount" };
      const ex = parseExpense(raw, opts, text);
      if (ex?.error === "date") return { intent: "ask", confidence: 0.5, question: "date" };
      if (ex?.error) return { intent: "ask", confidence: 0.5, question: "expense-or-chat" };
      // Strip the declaration words from the item (parseExpense keeps
      // them, since only verbs are in its STOP set); a ZWNJ-spelled
      // trigger splits into two normalised parts, so filter per part.
      const item = String(ex.item ?? "").split(/\s+/).flatMap((t) => normalizeText(t).split(/\s+/)).filter((t) => !["یک", "هزینه", "خرج", "جدید", "ی"].includes(t)).join(" ").trim();
      if (!item) return { intent: "ask", confidence: 0.5, question: "expense-or-chat" };
      return { intent: "expense", confidence: 1, extraction: { ...ex, item } };
    }
  }
  const incomeWords = /حقوق|درآمد|پول\s+گرفتم|از\s+\S+\s+گرفتم|واریز|سود|پاداش|عیدی|بیعانه|قرض|وام/u.test(raw);
  const ex0 = parseExpense(raw, opts, text);
  const hasItem = Boolean(ex0 && !ex0.error && ex0.item && String(ex0.item).trim());
  const hasE = !NEGATED_RE.test(raw) && (EXPENSE_VERBS.test(raw) || (/(?<!\p{L})خرج(?!\p{L})/u.test(raw) && amount?.anchored) || ((/(?<!\p{L})گرفتم(?![\p{L}])/u.test(raw)) && amount?.anchored && !incomeWords && hasItem));
  const hasI = !NEGATED_RE.test(raw) && (INCOME_VERBS.test(raw) || ((/(?<!\p{L})درآمد(?!\p{L})/u.test(raw)) && amount?.anchored) || ((/(?<!\p{L})گرفتم(?![\p{L}])/u.test(raw)) && amount?.anchored && (incomeWords || !hasItem)));
  if (hasE || hasI) {
    if (countAnchoredAmounts(raw) >= 2) return { intent: "ask", confidence: 0.5, question: "amount" };
    if (amount?.error === "decimal") return { intent: "ask", confidence: 0.5, question: "decimal" };
    if (amount?.error === "amount" || amount?.error === "unknown-number") return { intent: "ask", confidence: 0.5, question: "amount" };
    const digits = amount?.anchored ? [] : bareDigits(raw); if (amount?.anchored || digits.length === 1) { const ex = parseExpense(raw, opts, text); if (ex?.error === "date") return { intent: "ask", confidence: 0.5, question: "date" }; if (ex?.error) return { intent: "ask", confidence: 0.5, question: ex.error }; // TODO 1b-2: map question "ambiguous" to "amount" before it reaches Telegram
    if (hasI && !hasE && /(?<!\p{L})گرفتم(?![\p{L}])/u.test(raw) && !INCOME_VERBS.test(raw) && !/(?<!\p{L})درآمد(?!\p{L})/u.test(raw) && ex.item && incomeWords) return { intent: "ask", confidence: 0.5, question: "expense-or-income" }; return { intent: hasI && !hasE ? "income" : "expense", confidence: 1, extraction: ex }; }
    return { intent: "ask", confidence: 0.5, question: WEAK_BUY.test(raw) ? "expense-or-chat" : "amount" };
  }
  if (amount?.error === "decimal") return { intent: "ask", confidence: 0.5, question: "decimal" };
  if (amount?.error === "amount") return { intent: "ask", confidence: 0.5, question: "amount" };
  if (amount?.error === "unknown-number") return { intent: "chat", confidence: 1 }; // no verb: a bare-thousand statement is chat, not an amount question
  const lr = parseListRequest(raw); if (lr) return lr;
  const sq = parseSummaryQuery(raw); if (sq) return sq;
  // Phase 1-e Pillar 2: flexible summary phrasings without a trailing
  // "خلاصه/جدول کن" verb ("یه خلاصه از یادداشت‌هام بده"). NOTE-ONLY
  // by design: 1-d-4 deliberately excludes bare task forms from
  // summaries ("تسک‌هام رو جدول کن" stays a task list — task summaries
  // require the strict project forms), and the directive's flexible
  // examples are note forms, so nothing here overrides that pin.
  // The strict parseSummaryQuery above keeps precedence for exact
  // forms, and the file-reference check below still wins for short
  // messages without a یادداشت word.
  if (/(?:خلاصه|جدول)/.test(raw) && raw.search(/یادداشت/) >= 0) {
    return { intent: "summary", confidence: 1, kind: "note", projectName: null };
  }
  if (!longDiscussion) { const nq = parseNoteQuery(raw, now); if (nq) return nq; }
  if (FILE_RE.test(raw)) {
    // File reference only for a short message with no accompanying text:
    // a colon followed by text means the user is asking about that text.
    const hasColonText = /[:：]\s*\S/.test(raw), tokens = raw.split(/\s+/).filter(Boolean).length;
    if (!hasColonText && tokens <= 6) return { intent: "file-reference", confidence: 1 };
    return { intent: "chat", confidence: 1 };
  }
  // No verb: ask only for a short message that carries a currency word.
  if (amount?.anchored) { if (NEGATED_RE.test(raw)) return { intent: "chat", confidence: 1 }; if (amount.bareMultiplier) return { intent: "chat", confidence: 1 }; if (raw.split(/\s+/).some((tok) => /^ن(خریدم|خرید|گرفتم|پرداختم|دریافت|کردم)/u.test(tok))) return { intent: "chat", confidence: 1 }; const tokens = raw.split(/\s+/).filter(Boolean).length; if (tokens <= 4) return { intent: "ask", confidence: 0.5, question: "expense-or-chat" }; return { intent: "chat", confidence: 1 }; }
  // Phase 3-A: personal vault references — rule-based, zero model calls.
  // A vault keyword (card/sheba/account/national-id/personal-info) gates
  // every vault verdict so ordinary chat never misclassifies.
  const vk = /کارت|شبا|حساب|کد\s*ملی|اطلاعات\s*شخصی|گاوصندوق/u.test(raw);
  if (vk && !keywordInLongDiscussion) {
    const cat = /شبا/u.test(raw) ? "sheba" : /کد\s*ملی/u.test(raw) ? "national_id" : /حساب/u.test(raw) ? "account" : /اطلاعات\s*شخصی/u.test(raw) ? "personal_info" : /کارت/u.test(raw) ? "bank_card" : null;
    const vDigits = raw ? normalizeDigits(raw).match(/\d+/g) : null;
    const value = vDigits ? vDigits.join("") : "";
    let title = null;
    if (cat) {
      if (cat === "bank_card") { const m = /کارت\s+(بانک\s+)?([^\s\d،,؛:؛؟!.]{2,})/u.exec(raw); title = m ? `کارت ${m[1] ?? ""}${m[2]}`.replace(/\s+/g, " ").trim() : "کارت بانکی"; }
      else if (cat === "sheba") { const m = /شبا\s+([^\s\d]{2,})/u.exec(raw); title = m ? `شبا ${m[1]}` : "شبا"; }
      else if (cat === "account") { const m = /حساب\s+([^\s\d]{2,})/u.exec(raw); title = m ? `حساب ${m[1]}` : "حساب بانکی"; }
      else if (cat === "national_id") title = "کد ملی";
      else if (cat === "personal_info") title = "اطلاعات شخصی";
    }
    const kws = (cat ? [cat] : []).concat(title ? [title] : []);
    // List before get: "نشون بده" also ends in "بده".
    if (/نشون\s*بده|\bلیست\b/u.test(raw)) return { intent: "vault_list", confidence: 1, category: cat ?? null, title, keywords: kws };
    if (/ثبت\s*ش?\s*کن|ثبت\s*کن|ذخیره\s*کن|بذار(?!\p{L})|بگذار|ذخیره‌اش\s*کن|ثبت‌اش\s*کن/u.test(raw)) return { intent: "vault_save", confidence: 1, category: cat ?? null, title, value, keywords: kws };
    if (/چنده(?!\p{L})|چقدر(?!\p{L})|بده(?!\p{L})/u.test(raw)) return { intent: "vault_get", confidence: 1, category: cat ?? null, title, keywords: kws };
const isVaultLookup = /^(?:شماره\s*کارت|شماره\s*شبا|شماره\s*حساب|کد\s*ملی)/u.test(raw);
const hasCardNumber = /\d{13,19}/.test(normalizeDigits(raw));
if (isVaultLookup && !hasCardNumber && !/ثبت|ذخیره/u.test(raw)) return { intent: "vault_get", confidence: 1, category: cat ?? null, title, keywords: kws };
  }
  // Phase 3-A: archived file listing ("لیست مدارک آرشیو", "فایل‌های ذخیره شده").
  if (/لیست\s*(?:مادرک|مدیریت)|(?:مادرک|مدیریت)\s*آرشیو|آرشیو\s*(?:مادرک|مدیریت)|فایل\s*های\s*ذخیره\s*شدة|ذخیره\s*شدة\s*فایل/u.test(raw)) return { intent: "vault_list", confidence: 1, category: null, title: null, keywords: [], fileList: true };
  // Phase 3-A: archived file retrieval ("آخرین آزمایشم رو بفرست", "تصویر کارت ملی رو بده").
  if ((/فایل|مدرک|عکس|تصویر|کارت\s*ملی|آزمایش|بیمه|گواهینامه|شناسنامه|پاسپورت|سند/u.test(raw)) && /بفرست(?!\p{L})|بده(?!\p{L})|رو\s*فرست/u.test(raw)) return { intent: "vault_file_get", confidence: 1, keywords: raw.split(/\s+/).filter(Boolean).slice(-6) };
  return { intent: "chat", confidence: 1 };
}

// 1-d-2: explicit folder phrase at the START or END only (a phrase in
// the middle never tags). Start form returns { at: "start", rest } —
// the text after the phrase, for longest-name-prefix resolution in
// everyday.js; end form returns { at: "end", body, name } — the body
// before the phrase and the trailing name, for exact resolution.
// 1-d-6 middle form: a folder phrase between a leading keyword and the
// colon ("یادداشت توی پروژه گلبهار: ...") returns { at: "middle",
// body, name } — body is the phrase-stripped, re-classifiable text
// ("یادداشت: ...", "تسک: ...", "یادآوری کن ..."), name is exact for
// resolution. The colon is required: without it the name boundary is
// ambiguous in a pure function, so colon-less middle phrases keep the
// old behaviour (no tag).
const FOLDER_START_RE = /^(?:توی|در|برای)\s+پروژه\s+([\s\S]+)$/u;
const FOLDER_END_RE = /^([\s\S]+?)\s+(?:توی|در|برای)\s+پروژه\s+(.+?)\s*[؟?!.،,]*$/u;
const MIDDLE_KEYWORDS = "یادداشت کن|یادداشت|تسک جدید|تسک|یادآوری کن|یادآوری"; // longest first
const MIDDLE_TAG_RE = new RegExp(`^\\s*(?:(?:لطفا|لطفاً|ببین)\\s+)?(${MIDDLE_KEYWORDS})\\s+(?:توی|در|برای)\\s+پروژه(?:\\s+ی)?\\s+(.+?)\\s*[:：]\\s*([\\s\\S]+)$`, "ud");
function middleTagBody(keyword, rest) { const base = keyword === "یادآوری" || keyword === "یادآوری کن" ? "یادآوری کن" : keyword.split(" ")[0]; return base === "یادآوری کن" ? `${base} ${rest}` : `${base}: ${rest}`; }
export function stripMiddleFolderTag(text) {
  const raw = normalizeText(text ?? "");
  const m = MIDDLE_TAG_RE.exec(raw);
  if (!m) return null;
  const keyword = m[1], name = m[2].trim(), rest = m[3].trim();
  if (!name || !rest) return null;
  return { keyword, name, body: middleTagBody(keyword, rest), nameSpan: m.indices[2], restSpan: m.indices[3] };
}

// Phase 2-b Pillar B: known-project boundary matching. The old end
// form captured everything after "برای پروژه " up to punctuation/EOL
// ("گلبهار برسه", "یوتیوب ضبط ویدیوی معرفی"), so resolution returned
// null and the badge was dropped. When the caller supplies the known
// projects, an introducer followed by a known name/alias (longest
// first, followed by end-of-string, whitespace, colon, or
// punctuation) extracts ONLY that name and keeps the remaining words
// intact. Aliases may be arrays or JSON strings (D1 stores aliases as
// JSON text). Pure and side-effect free; daily.js stays agnostic of
// where the project list came from — resolveFolderTag in everyday.js
// passes the real D1 rows.
const FOLDER_INTRO_RE = /(?:توی|تو|در|برای|بابت)\s+(?:پروژه(?:\s+ی(?=[\s:：؟?!.،,]|$))?|پوشه(?:\s+ی(?=[\s:：؟?!.،,]|$))?)\s*/gu;
const PROJECT_BOUNDARY_RE = /[\s؟?!.،,:：]/u;
function projectCandidates(projects) {
  const out = [];
  const push = (n) => {
    const v = normalizeText(n ?? "").trim();
    if (v && !out.includes(v)) out.push(v);
  };
  for (const p of projects ?? []) {
    if (typeof p === "string") { push(p); continue; }
    if (!p) continue;
    push(p.name);
    let aliases = p.aliases;
    if (typeof aliases === "string") { try { aliases = JSON.parse(aliases); } catch { aliases = []; } }
    if (Array.isArray(aliases)) for (const a of aliases) push(a);
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}
// Returns { name, rest } when `afterText` starts with a known project
// name/alias at that exact position (boundary-delimited), else null.
// `rest` is the remaining text with one immediately adjacent colon
// stripped — the trailing words are never swallowed into the name.
export function matchKnownProjectAt(afterText, projects) {
  const after = normalizeText(afterText ?? "");
  for (const c of projectCandidates(projects)) {
    if (after === c) return { name: c, rest: "" };
    if (after.startsWith(c)) {
      const next = after[c.length];
      if (next === undefined || PROJECT_BOUNDARY_RE.test(next)) {
        let rest = after.slice(c.length).replace(/^[\s:：]+/u, "");
        // A remainder of pure punctuation ("گلبهار.") is no remainder.
        if (/^[\s؟?!.،,:：]+$/u.test(rest)) rest = "";
        return { name: c, rest };
      }
    }
  }
  return null;
}
// Phase 2-b upgrade of the old "resolveProjectMatch": a raw candidate
// that still has trailing words ("گلبهار برسه") resolves to the known
// project it starts with (longest first, boundary-delimited), or null.
export function resolveProjectName(rawCandidate, projects) {
  const hit = matchKnownProjectAt(rawCandidate, projects);
  return hit ? hit.name : null;
}
export function extractFolderTag(text, projects = null) {
  const raw = normalizeText(text);
  const orig = String(text ?? "");
  const s = FOLDER_START_RE.exec(raw);
  // normalisation is one-to-one, so raw spans map onto orig spans of
  // the same length: the start rest is the tail of orig, the end body
  // is the head of orig — ZWNJ survives in the returned body/rest.
  if (s) { const rest = orig.slice(orig.length - s[1].length).trim(); if (rest) return { at: "start", rest }; }
  // Middle before end: the end regex would otherwise swallow a middle
  // tag whole (name = "گلبهار: <body>"), which never resolves exactly.
  const mid = stripMiddleFolderTag(text);
  if (mid) {
    const name = orig.slice(mid.nameSpan[0], mid.nameSpan[1]).trim();
    const rest = orig.slice(mid.restSpan[0], mid.restSpan[1]).trim();
    if (name && rest) return { at: "middle", body: middleTagBody(mid.keyword, rest), name };
  }
  // Phase 2-b: known-name scan for mid-sentence phrases ("... برای
  // پروژه گلبهار برسه"). Runs before the end form so a trailing-word
  // name never falls through to an exact-match failure. The start
  // form above already handled a leading introducer; a known hit here
  // covers every other position, including a leading introducer that
  // the start regex missed (leading whitespace).
  if (Array.isArray(projects) && projects.length) {
    FOLDER_INTRO_RE.lastIndex = 0;
    let m;
    while ((m = FOLDER_INTRO_RE.exec(raw)) !== null) {
      const afterIdx = m.index + m[0].length;
      const hit = matchKnownProjectAt(raw.slice(afterIdx), projects);
      if (!hit) continue;
      // raw indices map 1:1 onto orig (see the comment above).
      const restClean = orig.slice(afterIdx + hit.name.length).replace(/^[\s:：]+/u, "").trim();
      const before = orig.slice(0, m.index).trim();
      const clean = /^[\s؟?!.،,:：]+$/u.test(restClean) ? "" : restClean;
      const body = before ? (clean ? `${before} ${clean}` : before) : clean;
      if (body) return { at: "known", name: hit.name, body };
    }
  }
  const e = FOLDER_END_RE.exec(raw);
  if (e) { const body = orig.slice(0, e[1].length).trim(); const name = e[2].trim(); if (body && name) return { at: "end", body, name }; }
  return null;
}
