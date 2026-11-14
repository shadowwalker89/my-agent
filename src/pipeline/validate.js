// Pipeline validators and output repairers (R0.6, contract v3 §3/§4).
// Deterministic ONLY: no network, no model call, no D1 write. Every function
// either validates a proposal against rule parsers or repairs model text.
// Policy (ask vs execute, confidence gating) lives in the caller, not here.
import { parseAmount, parseRelativeDate, parseHour, normalizeText } from "../daily.js";

// Action vocabulary. It lives here because validateInterpreterAction is its
// only consumer; interpret.js imports it for the prompt/parse limits, which
// keeps the dependency one-way (interpret.js -> validate.js, never back).
export const INTERPRETER_TYPES = ["task", "note", "expense", "income", "query", "translate", "setting", "correction", "dev_hint", "chat"];

// ── Model-intent vocabulary (moved from intent.js) ──────────────────────────
export const MODEL_INTENT_ALLOW = Object.freeze([
  "expense",
  "income",
  "note",
  "reminder",
  "translate",
  "remember",
  "expense-query",
  "note-query",
  "last-expense",
  "file-reference",
  "dev",
  "chat",
]);
export const MODEL_INTENT_TARGETS = Object.freeze(["en", "fa", "ar"]);

// parseModelIntent: raw model text -> {intent, followup, target}
//   | {invalid: "target"} (translate with an out-of-list target: the caller
//     asks for the language later, it must NOT be guessed) | null (failure).
// Unparseable, out-of-allow-list intent (including "task"), non-object JSON,
// and empty input are all null — never a guessed intent. A confidence field
// and any amount/date/currency fields are ignored, never read.
export function parseModelIntent(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch {
    const m = /\{[^}]+\}/.exec(s);
    if (!m) return null;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const intent = parsed.intent;
  if (typeof intent !== "string" || !MODEL_INTENT_ALLOW.includes(intent)) return null;
  const followup = parsed.followup === "yes" || parsed.followup === "no" ? parsed.followup : null;
  if (intent === "translate") {
    if (parsed.target === undefined || parsed.target === null) return { intent, followup, target: null };
    if (!MODEL_INTENT_TARGETS.includes(parsed.target)) return { invalid: "target" };
    return { intent, followup, target: parsed.target };
  }
  return { intent, followup, target: null };
}

const CONFIRM_THRESHOLD = 0.85;

// needsConfirmation: does this intent need confirmation before executing?
export function needsConfirmation(result) {
  return (result.intent === "dev" || result.intent === "task") && result.confidence < CONFIRM_THRESHOLD;
}

// extractJsonObject(raw): strip <think> blocks (closed and unclosed) and
// markdown fences, then parse the FIRST balanced {...} object with string
// awareness (braces inside quoted strings do not count). Any failure returns
// null — never a partial object.
export function extractJsonObject(raw) {
  let s = typeof raw === "string" ? raw : "";
  s = s.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/g, "");
  s = s.replace(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g, "$1");
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// ── Note-body repair (moved from intent.js) ─────────────────────────────────
const NOTE_LEAD_FRAMING_RE = /^\s*(?:(?:سلام|درود|وقت\s*بخیر|خسته\s*نباشی|لطفا|لطفاً|بی[‌\s]*زحمت|ممنون|مرسی|ببین|می[‌\s]*(?:خوام|خواهم|خواستم)|میخوام|میخواهم|میخواستم|میشه|می[‌\s]*شه|میتونی|می[‌\s]*تونی)\s*[،,.:!؛;?؟\-]*\s*)+/u;
const NOTE_COMMAND_LEAD_RE = /^(?:یه\s+|یک\s+)?(?:یادداشت|نوت)(?:\s+جدید)?\s*(?:ثبت\s*کن|بذار|بنویس|ایجاد\s*کن|بکن)\s*(?:که(?!\p{L})|[:：.،,؛;\-]+\s*)?/u;
const NOTE_TRAIL_FRAMING_RE = /[\s،,؛;:：.!?؟\-]*(?:(?:این|اون|هم)\s+)*(?:(?:رو|را)\s+)?(?:(?:برام|واسم|برای\s*من|توی|در|داخل|به)\s+)?(?:(?:یادداشت(?:[‌\s]*ها(?:م|یم|ی)?|هام|هایم)?|نوت(?:[‌\s]*هام)?)\s*)?(?:(?:برام|واسم)\s+)?(?:نگه\s*دار|نگهدار|ثبت(?:[‌\s]*(?:اش|ش))?\s*کن|ذخیره(?:[‌\s]*(?:اش|ش))?\s*کن|بذار|بنویس|یادداشت\s*کن|نوت\s*کن|اضافه\s*کن)\s*$/u;

function stripNoteFramingPrefix(s) {
  let out = String(s ?? "").trim();
  for (let i = 0; i < 8; i++) {
    const before = out;
    out = out.replace(NOTE_LEAD_FRAMING_RE, "").replace(NOTE_COMMAND_LEAD_RE, "").trim();
    if (out === before) break;
  }
  return out;
}

function stripNoteFramingSuffix(s) {
  let out = String(s ?? "").trim();
  for (let i = 0; i < 8; i++) {
    const before = out;
    out = out.replace(NOTE_TRAIL_FRAMING_RE, "").trim();
    if (out === before) break;
  }
  return out;
}

export function recoverFullNoteBody(rawText, modelBody, leadingFraming, trailingFraming) {
  const raw = typeof rawText === "string" ? rawText : "";
  const model = typeof modelBody === "string" ? modelBody.trim() : "";
  if (!raw.trim()) return model;
  let stripped = raw.trim();
  const lf = typeof leadingFraming === "string" ? leadingFraming.trim() : "";
  const tf = typeof trailingFraming === "string" ? trailingFraming.trim() : "";
  if (lf && lf.length < raw.length * 0.3 && stripped.startsWith(lf)) stripped = stripped.slice(lf.length);
  if (tf && tf.length < raw.length * 0.3 && stripped.endsWith(tf)) stripped = stripped.slice(0, stripped.length - tf.length);
  stripped = stripNoteFramingPrefix(stripped);
  stripped = stripNoteFramingSuffix(stripped);
  stripped = stripped.replace(/^[\s،,؛;:：.!?؟\-]+/u, "").replace(/[\s،,؛;:：.!?؟\-]+$/u, "").trim();
  if (!stripped) return model || raw.trim();
  if (!model) return stripped;
  if (raw.length > 100 && model.length < stripped.length * 0.85) return stripped;
  return model;
}

// ── Action validators (moved from interpreter.js) ───────────────────────────
// validateAmountText(amountText, rememberedCurrency) — reuses parseAmount.
// null means "no amount claimed": valid, unresolved. Unparsable or
// currency-less phrases are a mismatch (the caller asks).
export function validateAmountText(amountText, rememberedCurrency) {
  if (amountText === undefined || amountText === null) return { ok: true, amount: null, currency: null };
  if (typeof amountText !== "string" || !amountText.trim()) return { ok: false, error: "amount" };
  const parsed = parseAmount(amountText, rememberedCurrency);
  if (!parsed || parsed.error) return { ok: false, error: "amount" };
  return { ok: true, amount: parsed.amount, currency: parsed.currency };
}

function hasDatePhrase(t) {
  return /امروز|فردا|دیروز|پس\s*فردا|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\s*(فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند)|(فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند)\s*\d{1,2}/.test(t);
}

// resolvePhrase(text, now, {needTime, allowDateOnly}) -> {at, error}.
// NOTE: parseReminder is deliberately NOT used: it strips a full sentence to a
// body and returns {ask:"empty"} for a bare time phrase — but remind_text IS a
// bare time phrase (item text lives in the action's text field). A date-only
// due today is not "past"; any fully specified past date/time is.
function resolvePhrase(text, now, { needTime, allowDateOnly }) {
  if (typeof text !== "string" || !text.trim()) return { at: null, error: "time" };
  const hour = parseHour(text);
  if (hour && hour.ask) return { at: null, error: "time" };
  if (needTime && !hour) return { at: null, error: "time" };
  if (!hasDatePhrase(text) && !hour) return { at: null, error: "time" };
  const date = parseRelativeDate(text, now);
  if (date === null) return { at: null, error: "time" };
  const at = `${date}T${hour ? String(hour.hour).padStart(2, "0") : "00"}:${hour ? String(hour.minute).padStart(2, "0") : "00"}:00+03:30`;
  const today = new Date(now + 210 * 60000).toISOString().slice(0, 10);
  if (date < today || (date === today && hour && Date.parse(at) <= now)) return { at: null, error: "past" };
  if (date === today && !hour && !allowDateOnly) return { at: null, error: "time" };
  return { at, error: null };
}

// validateDateTexts(due_text, remind_text, nowMs) -> { ok, due_at, remind_at, errors }.
export function validateDateTexts(dueText, remindText, nowMs) {
  const now = nowMs ?? Date.now();
  const out = { ok: true, due_at: null, remind_at: null, errors: [] };
  for (const [txt, opts, key] of [[dueText, { needTime: false, allowDateOnly: true }, "due_at"], [remindText, { needTime: true, allowDateOnly: false }, "remind_at"]]) {
    if (txt == null) continue;
    const r = resolvePhrase(txt, now, opts);
    if (r.error) out.errors.push(r.error === "past" ? "past" : "time");
    else out[key] = r.at;
  }
  out.errors = [...new Set(out.errors)];
  out.ok = out.errors.length === 0;
  return out;
}

// matchProject(nameOrAlias, projects) -> matched project object or null.
// Matches on normalised name or alias. NEVER auto-creates: unknown names
// return null so the caller can offer the new-project card.
export function matchProject(nameOrAlias, projects) {
  if (nameOrAlias === undefined || nameOrAlias === null) return null;
  const want = normalizeText(String(nameOrAlias)).trim();
  if (!want) return null;
  for (const p of Array.isArray(projects) ? projects : []) {
    if (!p) continue;
    if (normalizeText(String(p.name ?? "")).trim() === want) return p;
    for (const al of Array.isArray(p.aliases) ? p.aliases : []) {
      if (normalizeText(String(al)).trim() === want) return p;
    }
  }
  return null;
}

// validateInterpreterAction(action, ctx) -> { ok, errors[], resolved }.
// ctx: { projects, nowMs, defaultCurrency }. Errors use the needs vocabulary
// (amount/time/project/type). Low confidence is NOT a validation error here.
export function validateInterpreterAction(action, ctx = {}) {
  const errors = [];
  const resolved = { amount: null, currency: null, due_at: null, remind_at: null, project: null };
  if (!action || !INTERPRETER_TYPES.includes(action.type)) return { ok: false, errors: ["type"], resolved };
  if (action.type === "expense" || action.type === "income") {
    const a = validateAmountText(action.amount_text, ctx.defaultCurrency);
    if (!a.ok || action.amount_text == null) errors.push("amount");
    else { resolved.amount = a.amount; resolved.currency = a.currency; }
  }
  if (action.due_text != null || action.remind_text != null) {
    const d = validateDateTexts(action.due_text ?? null, action.remind_text ?? null, ctx.nowMs);
    if (!d.ok) errors.push("time");
    else { resolved.due_at = d.due_at; resolved.remind_at = d.remind_at; }
  }
  const projectName = action.type === "query" && action.query ? action.query.project : action.project;
  if (projectName != null) {
    const matched = matchProject(projectName, ctx.projects);
    if (!matched) errors.push("project");
    else resolved.project = matched;
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], resolved };
}
