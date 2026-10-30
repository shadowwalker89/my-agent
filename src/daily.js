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
  const window = text.slice(hourEnd, hourEnd + 24);
  if (/(?<!\p{L})بعد از ظهر(?!\p{L})/u.test(window)) return "afternoon";
  if (/(?<!\p{L})عصر(?!\p{L})/u.test(window)) return "evening";
  if (/(?<!\p{L})شب(?!\p{L})/u.test(window)) return "night";
  if (/(?<!\p{L})ظهر(?!\p{L})/u.test(window)) return "noon";
  if (/(?<!\p{L})(صبح|بامداد)(?!\p{L})/u.test(window)) return "morning";
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
  collect(new RegExp(`ساعت\\s*(?:[\\d۰-۹٠-٩]{1,2}|${HOUR_ALTS})(?::[\\d۰-۹٠-٩]{1,2})?(?:\\s+و\\s+(?:ربع|نیم))?(?:\\s+(?:بعد از ظهر|صبح|بامداد|ظهر|عصر|شب))?`, "g"));
  collect(/و\s+(?:ربع|نیم)/g);
  ranges.sort((a, b) => a[0] - b[0]);
  let body = "", pos = 0;
  for (const [a, b] of ranges) { if (a < pos) continue; body += src.slice(pos, a); pos = b; }
  body += src.slice(pos);
  body = body.replace(/\s+/g, " ").trim();
  if (!body) return { ask: "empty" }; // "for what?" — never store an empty reminder
  return { due: `${date}T${pad(hour.hour)}:${pad(hour.minute)}:00+03:30`, text: body };
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
const NOTE_QUERY_RE = /(یادداشت\s+های|یادداشت\s+هام|یادداشت\s+های امروز)/;
const FILE_RE = /(?<!\p{L})(خلاصه\s+اش\s+کن(?![\p{L}])|خلاصه\s+کن(?![\p{L}])|خلاصه\s+اش|این فایل را خلاصه\s+کن(?![\p{L}]))/u;
const TRANSLATE_VERB = /(?<!\p{L})(?:ترجمه\s+(?:کن|کنید|بکن))(?![\p{L}])/u;
function countAnchoredAmounts(text) { const toks = stripThousands(normalizeDigits(normalizeText(text))).replace(/[؟?!.،,]/g, " ").split(/\s+/).filter(Boolean); let n = 0; for (let ci = 0; ci < toks.length; ci++) if (CUR_WORDS.includes(toks[ci])) for (let s = Math.max(0, ci - 7); s < ci; s++) { const ph = parseNumberPhrase(toks.slice(s, ci), 0); if (ph && !ph.error && ph.consumed === ci - s) { n++; break; } } return n; }
// Rule-only classifier. Confident = 1; ambiguous = { intent: "ask" }.
// Never a guess, never a model call. Strict translate is checked FIRST:
// a bare word "translate" anywhere is not a translate, only the verb is.
export function classifyDaily(text, opts = {}) {
  const now = opts.nowMs ?? Date.now(), raw = normalizeText(text);
  if (!raw.trim()) return { intent: "chat", confidence: 1 };
  if (raw.trimStart().startsWith("/")) return { intent: "command", confidence: 1 };
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
  const note = NOTE_RE.exec(raw); if (note && note[1].trim()) return { intent: "note", confidence: 1, text: text.slice(note.index + note[0].length - note[1].length).trim() };
  if (REMINDER_RE.test(raw)) { const r = parseReminder(raw, now, text); return r.ask ? { intent: "reminder", confidence: 0.5, ask: r.ask } : { intent: "reminder", confidence: 1, due: r.due, text: r.text }; }
  // Expense query: needs "how much/total" or a period word with a question
  // mark. An unknown period (e.g. last week) asks, never returns today.
  // An invalid date asks, never calls weekRange(null).
  const amount = parseAmount(raw, opts.rememberedCurrency);
  const hasHowMuch = /چقدر|مجموع/.test(raw), hasQuestion = /[؟?]\s*$/.test(raw);
  const periodWord = /این هفته/.test(raw) ? "week" : /این ماه/.test(raw) ? "month" : /دیروز/.test(raw) ? "yesterday" : /امروز/.test(raw) ? "today" : null;
  const unknownPeriod = /(گذشته|قبل|اخیر|پریروز|سال)/.test(raw) || /(?<!\p{L})پیش(?!\p{L})/u.test(raw) || (findMonth(raw) && !new RegExp(`[0-9۰-۹٠-٩]+\\s*${findMonth(raw)[0]}|${findMonth(raw)[0]}\\s*[0-9۰-۹٠-٩]+`).test(raw));
  const hasExpenseWord = /(?<!\p{L})(خرج|هزینه)(?!\p{L})/u.test(raw);
  if (hasExpenseWord && (hasHowMuch || (periodWord && hasQuestion)) && !(amount?.anchored && EXPENSE_VERBS.test(raw))) {
    if (unknownPeriod || (!periodWord && !findMonth(raw) && !/(?:\d{4}-\d{2}-\d{2}|\d{1,4}\/\d{1,2}\/\d{1,2})/.test(normalizeDigits(raw)))) return { intent: "expense-query", confidence: 0.5, ask: "period" };
    const date = parseRelativeDate(raw, now); if (date === null) return { intent: "expense-query", confidence: 0.5, ask: "date" };
    const period = periodWord || "today";
    let range;
    if (period === "week") { range = weekRange(date); if (!range) return { intent: "expense-query", confidence: 0.5, ask: "date" }; }
    else if (period === "month") { range = monthRange(date); if (!range) return { intent: "expense-query", confidence: 0.5, ask: "date" }; }
    else range = { start: date, end: date };
    return { intent: "expense-query", confidence: 1, period, range };
  }
  const hasE = !NEGATED_RE.test(raw) && (EXPENSE_VERBS.test(raw) || (/(?<!\p{L})خرج(?!\p{L})/u.test(raw) && amount?.anchored));
  const hasI = !NEGATED_RE.test(raw) && (INCOME_VERBS.test(raw) || (/(?<!\p{L})درآمد(?!\p{L})/u.test(raw) && amount?.anchored) || (/(?<!\p{L})گرفتم(?![\p{L}])/u.test(raw) && amount?.anchored));
  if (hasE || hasI) {
    if (countAnchoredAmounts(raw) >= 2) return { intent: "ask", confidence: 0.5, question: "amount" };
    if (amount?.error === "decimal") return { intent: "ask", confidence: 0.5, question: "decimal" };
    if (amount?.error === "amount" || amount?.error === "unknown-number") return { intent: "ask", confidence: 0.5, question: "amount" };
    const digits = amount?.anchored ? [] : bareDigits(raw); if (amount?.anchored || digits.length === 1) { const ex = parseExpense(raw, opts, text); if (ex?.error === "date") return { intent: "ask", confidence: 0.5, question: "date" }; if (ex?.error) return { intent: "ask", confidence: 0.5, question: ex.error }; // TODO 1b-2: map question "ambiguous" to "amount" before it reaches Telegram
    if (hasI && !hasE && /(?<!\p{L})گرفتم(?![\p{L}])/u.test(raw) && !INCOME_VERBS.test(raw) && !/(?<!\p{L})درآمد(?![\p{L}])/u.test(raw) && ex.item) return { intent: "ask", confidence: 0.5, question: "expense-or-income" }; return { intent: hasI && !hasE ? "income" : "expense", confidence: 1, extraction: ex }; }
  return { intent: "ask", confidence: 0.5, question: WEAK_BUY.test(raw) ? "expense-or-chat" : "amount" };
  }
  if (amount?.error === "decimal") return { intent: "ask", confidence: 0.5, question: "decimal" };
  if (amount?.error === "amount") return { intent: "ask", confidence: 0.5, question: "amount" };
  if (amount?.error === "unknown-number") return { intent: "chat", confidence: 1 }; // no verb: a bare-thousand statement is chat, not an amount question
  if (NOTE_QUERY_RE.test(raw)) { const date = parseRelativeDate(raw, now); if (date === null) return { intent: "note-query", confidence: 0.5, ask: "date" }; return { intent: "note-query", confidence: 1, date }; }
  if (FILE_RE.test(raw)) {
    // File reference only for a short message with no accompanying text:
    // a colon followed by text means the user is asking about that text.
    const hasColonText = /[:：]\s*\S/.test(raw), tokens = raw.split(/\s+/).filter(Boolean).length;
    if (!hasColonText && tokens <= 6) return { intent: "file-reference", confidence: 1 };
    return { intent: "chat", confidence: 1 };
  }
  // No verb: ask only for a short message that carries a currency word.
  if (amount?.anchored) { if (NEGATED_RE.test(raw)) return { intent: "chat", confidence: 1 }; if (amount.bareMultiplier) return { intent: "chat", confidence: 1 }; if (raw.split(/\s+/).some((tok) => /^ن(خریدم|خرید|گرفتم|پرداختم|دریافت|کردم)/u.test(tok))) return { intent: "chat", confidence: 1 }; const tokens = raw.split(/\s+/).filter(Boolean).length; if (tokens <= 4) return { intent: "ask", confidence: 0.5, question: "expense-or-chat" }; return { intent: "chat", confidence: 1 }; }
  return { intent: "chat", confidence: 1 };
}
