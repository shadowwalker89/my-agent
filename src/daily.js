import { JMONTHS, addDays, findMonth, normalizeDigits, normalizeText, parseRelativeDate, iranDate, weekRange, monthRange } from "./domain/reminders/time.js";
import { parseReminder } from "./domain/reminders/parse.js";
import { parseListRequest, stripMiddleFolderTag, extractFolderTag, matchKnownProjectAt, resolveProjectName } from "./domain/tasks/parse.js";
export { parseListRequest, stripMiddleFolderTag, extractFolderTag, matchKnownProjectAt, resolveProjectName };
import { stripNoteCommandPrefix, parseNoteQuery, parseConversationalNote, CONV_NOTE_RE, NOTE_RE } from "./domain/notes/parse.js";
export { stripNoteCommandPrefix, parseNoteQuery } from "./domain/notes/parse.js";
export { IRAN_OFFSET_MIN, normalizeDigits, iranDate, jalaliToGregorian, gregorianToJalali, formatJalali, parseRelativeDate, weekRange, monthRange, parseHour, normalizeText } from "./domain/reminders/time.js";
export { parseReminder, normalizeDaypartToken, parseDaypartReply, hasDaypartReply, mergeHourAmbiguousFollowup, resolveHourAmbiguousFollowup, REMINDER_TRIGGERS } from "./domain/reminders/parse.js";
import { DEFAULT_CURRENCY, parseNumberPhrase, resolveDefaultCurrency, sumByCurrency, parseAmount, bareDigits, parseExpense, parseSummaryQuery, EXPENSE_VERBS, INCOME_VERBS, WEAK_BUY, NEGATED_RE, REMINDER_RE, stripThousands, CUR_WORDS, has, CUR } from "./domain/expenses/parse.js";
export { DEFAULT_CURRENCY, parseNumberPhrase, resolveDefaultCurrency, sumByCurrency, parseAmount, bareDigits, parseExpense, parseSummaryQuery, EXPENSE_VERBS, INCOME_VERBS, WEAK_BUY, NEGATED_RE, REMINDER_RE, stripThousands, CUR_WORDS, has, CUR } from "./domain/expenses/parse.js";

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
  // Phase 2.3: four distinct operational contracts. Unsupported external
  // sends (email/connector) are never chat and never a silent note/task:
  // they return unsupported_action so the caller replies honestly.
  if (!isNegatedCommand(raw) && /(?:ایمیل|پیامک|واتساپ|واتس\s*اپ|email)/iu.test(raw) && /(بفرست|ارسال)/u.test(raw)) return { intent: "unsupported_action", confidence: 1, action: "email", text: String(text ?? "").trim() };
  // Memory-save: "این را به خاطر بسپار: ..." / "یادت بمونه اسم من ... است"
  // (and the bare "به خاطر بسپار ..." form). Distinct from note (یادداشت کن)
  // and from remember-settings (یادت باشد ...): the caller saves a user fact
  // (and a setting when the fact is name/currency/language) and confirms
  // "🧠 به خاطر سپرده شد" — never a note or a task.
  const mem = /(?:این\s+را|اینو|این)?\s*(?:به\s+خاطر\s+بسپار|یادت\s+بمونه|یادت\s+بماند|یادم\s+بمونه|یادت\s+باشه|یادت\s+باشد|یادم\s+باشه|فراموش\s+نکن|تو\s+ذهنت\s+باشه|ذهنت\s+باشه)\s*[:：]?\s*(?:که\s+)?([\s\S]+)/u.exec(raw);
  if (mem) {
    const bodyRaw = mem[1].trim().replace(/[؟?!.،,؛;:\s]+$/u, "").trim();
    const memTrig = mem[0] ?? "";
    const isBashaTrig = /یادت\s+باشه|یادت\s+باشد|یادم\s+باشه|فراموش\s+نکن|ذهنت\s+باشه/.test(memTrig);
    let memFact = true;
    if (isBashaTrig && bodyRaw) {
      const FACT_RE = /(?:اسم\s*من|اسمم|نام\s*من|نامم|شهر\s*من|شهرم|زندگی\s*می\s*کنم|می\s*شینم|می\s*نشینم|ماشین\s*من|ماشینم|شغلم|شغل\s*من|سنم|سن\s*من|تولدم|تولد\s*من|علاقه\s*م|حساسیت|آلرژی)/u;
      const HAS_TIME_RE = /(فردا|امروز|پس\s*فردا|دیروز|ساعت)/u;
      const FUTURE_RE = /(زنگ\s*بزن|تماس\s*بگیر|انجام\s*بده|بررسی\s*کن|خرید\s*کن|پرداخت\s*کن|بفرست|ارسال\s*کن|یادآوری\s*کن|یادم\s*بنداز|بزنم|بگیرم|کنم|بدم|بخر)/u;
      const isSettingAttempt = /^(?:ارزم|ارز\s|زبانم|زبان\s|نامم|اسمم)/.test(bodyRaw);
      if (isSettingAttempt) memFact = false;
      else if (!FACT_RE.test(bodyRaw) && (HAS_TIME_RE.test(bodyRaw) || HAS_TIME_RE.test(raw) || FUTURE_RE.test(bodyRaw))) memFact = false;
    }
    if (bodyRaw && (!isBashaTrig || memFact)) {
      const nameM = /^(?:اسمم|نامم|اسم\s+من|نام\s+من)\s+([\s\S]+?)(?:\s+(?:است|هست))?$/u.exec(bodyRaw);
      if (nameM) { let v = nameM[1].trim(); if (isBashaTrig && v.endsWith("ه") && v.length > 1) v = v.slice(0, -1); if (v && v.length <= 50) return { intent: "memory_save", confidence: 1, text: bodyRaw, factKey: "name", factValue: v, setting: { key: "name", value: v } }; }
      const curM = /^(?:ارزم|ارز[\s ]+پیش[\s ]*فرضم)\s+(\S+)/u.exec(bodyRaw);
      if (curM) { const tok = curM[1].replace(/[؟?!.،,]+$/, ""); const code = has(CUR, tok) ? CUR[tok] : (tok.endsWith("ه") && has(CUR, tok.slice(0, -1)) ? CUR[tok.slice(0, -1)] : (["TOMAN", "IRR", "USD", "EUR"].includes(tok) ? tok : null)); if (code) return { intent: "memory_save", confidence: 1, text: bodyRaw, factKey: "currency", factValue: code, setting: { key: "currency", value: code } }; }
      const langM = /^(?:زبانم|زبان)\s+(\S+)/u.exec(bodyRaw);
      if (langM) { const v = langM[1] === "انگلیسی" ? "en" : langM[1] === "فارسی" ? "fa" : (langM[1] === "en" || langM[1] === "fa" ? langM[1] : null); if (v) return { intent: "memory_save", confidence: 1, text: bodyRaw, factKey: "language", factValue: v, setting: { key: "language", value: v } }; }
      return { intent: "memory_save", confidence: 1, text: bodyRaw, factKey: "general", factValue: bodyRaw };
    }
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
  for (const re of [/^(?:اینو\s+)?یادداشت\s+کن(?:\s+که(?!\p{L}))?\s*:?\s*([\s\S]+)$/ud, /^بنویس(?:\s+توی\s+یادداشت\s*های?م)?\s+([\s\S]+)$/ud, /^این\s+را\s+یادداشت\s+کن\s*[:：]?\s*([\s\S]+)$/ud]) {
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
  if (vk && !keywordInLongDiscussion && !raw.includes("یادداشت") && raw.length <= 160) {
    const cat = /شبا/u.test(raw) ? "sheba" : /کد\s*ملی/u.test(raw) ? "national_id" : /حساب/u.test(raw) ? "account" : /اطلاعات\s*شخصی/u.test(raw) ? "personal_info" : /کارت/u.test(raw) ? "bank_card" : null;
    const vDigits = raw ? normalizeDigits(raw).match(/\d+/g) : null;
    const longDigits = vDigits ? vDigits.filter((d) => d.length >= 8) : [];
    const value = longDigits.length ? longDigits.join("") : "";
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
  return { intent: "chat", confidence: 1 }; }
