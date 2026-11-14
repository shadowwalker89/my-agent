// Deterministic Persian amount/currency/expense/income/summary-query parsing
// extracted from src/daily.js (R0.7d). Pure functions only: no channel/pipeline
// imports, no I/O, no model calls.
import { JMONTHS, normalizeDigits, normalizeText, parseRelativeDate, weekRange, monthRange, iranDate } from "../reminders/time.js";

export { normalizeText } from "../reminders/time.js";

export const DEFAULT_CURRENCY = "TOMAN";
export const CUR = { "تومان": "TOMAN", "تومنی": "TOMAN", "تومن": "TOMAN", "ریال": "IRR", "دلار": "USD", "یورو": "EUR", "€": "EUR", "$": "USD" };
const ONES = { "یک": 1, "دو": 2, "سه": 3, "چهار": 4, "پنج": 5, "شش": 6, "هفت": 7, "هشت": 8, "ده": 10, "یازده": 11, "دوازده": 12, "سیزده": 13, "چهارده": 14, "پانزده": 15, "شانزده": 16, "هفده": 17, "هجده": 18, "نوزده": 19 };
const TENS = { "بیست": 20, "سی": 30, "چهل": 40, "پنجاه": 50, "شصت": 60, "هفتاد": 70, "هشتاد": 80, "نود": 90 };
const HUNDREDS = { "صد": 100, "دویست": 200, "سیصد": 300, "چهارصد": 400, "پانصد": 500, "ششصد": 600, "هفتصد": 700, "هشتصد": 800, "نهصد": 900 };
const COUNTING = new Set(["تا", "عدد", "کیلو", "گرم", "لیتر", "متر", "نفر", "دانه", "مرتبه", "دفعه", "بار", "جلد", "بسته", "ساعت"]); const MULTS = new Set(["هزار", "میلیون", "میلیارد"]);

export function stripThousands(t) { return String(t).replace(/(\d)[,٬](?=\d{3}(?!\d))/g, "$1"); }
export function has(map, key) { return Object.hasOwn(map, key); }

export function parseNumberPhrase(toks, start = 0) {
  const segments = []; let i = start, cur = 0, seen = false, lastNumber = false;
  while (i < toks.length) {
    const tok = toks[i];
    if (tok === "و") { if (!seen && segments.length === 0) break; lastNumber = false; i++; continue; }
    if (tok === "هزار" || tok === "میلیون") { segments.push({ value: seen ? cur : 1, mult: tok }); cur = 0; seen = false; lastNumber = false; i++; continue; }
    let v = null;
    if (/^\d+$/.test(tok)) v = Number(tok); else if (has(ONES, tok)) v = ONES[tok]; else if (has(TENS, tok)) v = TENS[tok]; else if (has(HUNDREDS, tok)) v = HUNDREDS[tok];
    if (v === null) break;
    if (lastNumber) return { error: "ambiguous", consumed: i - start };
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

export const CUR_WORDS = ["تومان", "تومنی", "تومن", "ریال", "دلار", "یورو", "€", "$"];

export function parseAmount(text, rememberedCurrency) {
  const t = stripThousands(normalizeDigits(normalizeText(text)));
  if (/(\d+)\s*[.٫,]\s*(\d+)\s*(?:هزار|میلیون)?\s*(?:تومان|تومنی|تومن|ریال|دلار|یورو|€|\$)/.test(t)) return { error: "decimal" };
  const toks = t.replace(/[؟?!.،,]/g, " ").split(/\s+/).filter(Boolean);
  const ci = toks.findIndex((x) => CUR_WORDS.includes(x));
  if (ci >= 0) {
    if (ci > 1 && (toks[ci - 1] === "هزار" || toks[ci - 1] === "میلیون")) {
      const prev = toks[ci - 2];
      const knownNonNumber = new Set(["خرج", "کردم", "پرداخت", "خریدم", "خرید", "گرفتم", "دریافت", "امروز", "دیروز", "فردا", "را", "برای", "از", "به", "در", "با", "است", "هست", ...JMONTHS]);
      if (prev !== "و" && !/^\d+$/.test(prev) && !has(ONES, prev) && !has(TENS, prev) && !has(HUNDREDS, prev) && !knownNonNumber.has(prev)) return { error: "unknown-number" };
    }
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
  const amtToks = amount?.matched ? amount.matched.split(/\s+/) : [];
  return String(origText ?? text).replace(/پس[\s‌]فردا/g, " ").replace(/[؟?!.،,]/g, " ").split(/\s+/).filter(Boolean).filter((tok) => !normalizeDigits(normalizeText(tok)).split(/\s+/).filter(Boolean).every((pt) => STOP.has(pt) || /^\d+$/.test(pt) || amtToks.includes(pt))).join(" ").trim();
}

export function parseExpense(text, opts = {}, origText) {
  const a = parseAmount(text, opts.rememberedCurrency);
  if (a?.error) return a;
  if (!a && /(?<!\p{L})(تومان|تومنی|تومن|ریال|دلار|یورو|هزار|میلیون|میلیارد|€|\$)(?!\p{L})/u.test(normalizeText(text))) return { error: "amount" };
  let amount = a;
  if (!a) {
    const digits = bareDigits(text);
    if (digits.length !== 1) return { error: "ambiguous" };
    amount = { amount: digits[0], currency: resolveDefaultCurrency(opts.rememberedCurrency), matched: String(digits[0]), anchored: false };
  }
  if (amount.amount <= 0 || amount.amount > Number.MAX_SAFE_INTEGER) return { error: "amount" };
  const date = parseRelativeDate(text, opts.nowMs ?? Date.now()); if (date === null) return { error: "date" };
  return { ...amount, date, item: stripItem(text, amount, origText), category: null };
}

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

export const EXPENSE_VERBS = /(?<!\p{L})(خرج کردم|پرداخت کردم|خریدم|خرید کردم)(?![\p{L}])/u;
export const INCOME_VERBS = /(?<!\p{L})(دریافت کردم|واریز شد|حقوق گرفتم|پول گرفتم)(?![\p{L}])/u;
export const WEAK_BUY = /(?<!\p{L})(خریدم|خرید کردم)(?![\p{L}])/u;
export const NEGATED_RE = /(?<!\p{L})(نکردم|نکرد|نخریدم|نگرفتم|نپرداختم|ندریافتم|ندادم|نخواهم|نمی\s+کنم|نمی\s+خواهم|نمی\s+خرم|نمی\s+دهم|نکنم)(?![\p{L}])/u;
export const REMINDER_RE = /(?<!\p{L})(?:یادم بینداز|یادآوری کن|یادم بنداز|یادت باشه)(?![\p{L}])/u;

// Also export helper constants used by callers/tests (best-effort).
export { CUR_WORDS as EXPENSE_CUR_WORDS, STOP as EXPENSE_STOP_WORDS };