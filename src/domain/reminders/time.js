export const IRAN_OFFSET_MIN = 210;
const FA = "۰۱۲۳۴۵۶۷۸۹";
export const JMONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2322, 2394, 2456, 3178];
export const HOURW = { "یک": 1, "دو": 2, "سه": 3, "چهار": 4, "پنج": 5, "شش": 6, "هفت": 7, "هشت": 8, "نه": 9, "ده": 10, "یازده": 11, "دوازده": 12 };
export function normalizeDigits(t) { return String(t ?? "").replace(/[۰-۹]/g, (d) => String(FA.indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))); }
function toFa(t) { return String(t).replace(/[0-9]/g, (d) => FA[Number(d)]); }
export function pad(n) { return String(n).padStart(2, "0"); }
export function iso(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
function isValidGregorian(y, m, d) { if (!Number.isInteger(y) || m < 1 || m > 12 || d < 1 || d > 31) return false; const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d; }
export function addDays(date, n) { const [y, m, d] = date.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 1, d) + n * 86400000); return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()); }
export function iranDate(nowMs) { const d = new Date(nowMs + IRAN_OFFSET_MIN * 60000); return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
function jalYear(jy) {
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
export function findMonth(t) {
  for (const [m, i] of JMONTHS.map((m, i) => [m, i + 1]).sort((a, b) => b[0].length - a[0].length)) {
    if (new RegExp(String.raw`(?<!\p{L})${m}(?!\p{L})`, "u").test(t)) return [m, i];
  }
  return null;
}
export function parseRelativeDate(text, nowMs) {
  const t = normalizeDigits(String(text ?? "")).replace(/\u200c/g, " "), today = iranDate(nowMs);
  if (/پس[\s\u200c]+فردا/.test(t)) return addDays(today, 2);
  if (/فردا/.test(t)) return addDays(today, 1);
  if (/دیروز/.test(t)) return addDays(today, -1);
  if (/امروز/.test(t)) return today;
  const g = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (g) { const [y, m, d] = [Number(g[1]), Number(g[2]), Number(g[3])]; return isValidGregorian(y, m, d) ? iso(y, m, d) : null; }
  const sl = /(\d{1,4})\/(\d{1,2})\/(\d{1,2})/.exec(t);
  if (sl) {
    const [a, b, c] = [Number(sl[1]), Number(sl[2]), Number(sl[3])];
    if (a >= 1300 && a <= 1499) return jalaliToGregorian(a, b, c);
    if (a >= 1900 && a <= 2100 && isValidGregorian(a, b, c)) return iso(a, b, c);
    return null;
  }
  const jm = findMonth(t);
  if (jm) {
    const dm = new RegExp(`(\\d{1,2})\\s*${jm[0]}`).exec(t) || new RegExp(`${jm[0]}\\s*(\\d{1,2})`).exec(t);
    if (!dm) return today;
    let jy = gregorianToJalali(today).jy;
    const ym = /(?<!\d)(1[34]\d\d)(?!\d)/.exec(t);
    if (ym) { const after = t.slice(ym.index + ym[0].length); if (!/^\s*(تومان|ریال|دلار|یورو|€|\$)/.test(after)) jy = Number(ym[0]); }
    return jalaliToGregorian(jy, jm[1], Number(dm[1]));
  }
  return today;
}
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
export const HOUR_ALTS = "دوازده|یازده|ده|نه|هشت|هفت|شش|پنج|چهار|سه|دو|یک";
function qualifierNearHour(text, hourEnd) {
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
export function normalizeText(t) {
  return String(t ?? "").replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/\u200c/g, " ");
}
