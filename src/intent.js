// Intent routing for Telegram messages — pure function + one optional LLM call
// for ambiguous cases. R0.6: the NLU interpreter, its model resolution, and the
// deterministic output validators now live in src/pipeline/; they are imported
// and re-exported here so every existing caller keeps working unchanged.
//
// classifyIntent(message, ctx) -> { intent: "chat"|"dev"|"task"|"ask", confidence, reason }
// dev  = request to change/add/fix/refactor this project's code
// task = file processing/conversion/download (pdf, docx, image, zip, convert)
// ask  = a general non-chat question (expandable later)
// chat = everything else (the conservative default)
// If confidence is below DEV_THRESHOLD and the intent is dev|task, callFastCombo
// (optional) runs a JSON-only prompt. LLM failure -> chat. No message content or
// key is ever logged.
import { parseModelIntent } from "./pipeline/validate.js";
import { classifyIntentNlu } from "./pipeline/interpret.js";

// Re-exports for back-compat (R0.6): the definitions moved to src/pipeline/*.
export { MODEL_INTENT_ALLOW, MODEL_INTENT_TARGETS, parseModelIntent, needsConfirmation, extractJsonObject, recoverFullNoteBody } from "./pipeline/validate.js";
export { DEFAULT_INTERPRETER_MODEL, NLU_TIMEOUT_MS, NLU_MAX_TOKENS, NLU_VALID_INTENTS, resolveInterpreterModel } from "./pipeline/route.js";
export { classifyIntentNlu } from "./pipeline/interpret.js";

const DEV_THRESHOLD = 0.7;

// ── dev signals ─────────────────────────────────────────────────────────────
const EN_ACTION_RE =
  /\b(?:add|fix|change|refactor|update|implement|create|remove|delete|rename|edit|rewrite|debug|improve)\b/i;

const FA_LETTER = "\\u0600-\\u06FF\\u0750-\\u077F\\uFB50-\\uFDFF\\uFE70-\\uFEFF";
const FA_ACTION_RE = new RegExp(
  `(?:^|[^${FA_LETTER}])(?:بساز|بنویس|اضافه\\s*کن|درست\\s*کن|تغییر\\s*بده|حذف\\s*کن|ریفکتور|بهتر\\s*کن|بروزرسانی|آپدیت)(?=$|[^${FA_LETTER}])`,
  "um",
);

const PROJECT_REF_EN_RE =
  /\b(?:worker|router|panel|endpoint|bot|telegram|combo|catalog|src\/|index\.js|admin[-_]?page|health\.js|config\.js|providers?\.js|combos?\.js|overrides?\.js|task[-_]?route|tgprefs|intent|dev\.js|executor)\b/i;
const PROJECT_REF_FA_RE = new RegExp(
  `(?:^|[^${FA_LETTER}])(?:پروژه|ایجنت|ورکر|روتر|پنل|اندپوینت|ربات|کاتالوگ)(?=$|[^${FA_LETTER}])`,
  "um",
);

// ── task signals ────────────────────────────────────────────────────────────
const TASK_FILE_RE =
  /\b(?:pdf|docx?|xlsx?|csv|zip|tar|gz|mp3|mp4|wav|avi|mov|png|jpg|jpeg|gif|webp)\b/i;
const TASK_VERB_EN_RE =
  /\b(?:convert|download|upload|process|extract|compress|resize|transcribe|translate|summarize)\b/i;
const FA_TASK_RE = new RegExp(
  `(?:^|[^${FA_LETTER}])(?:تبدیل|استخراج|دانلود|آپلود|فشرده|خلاصه|ترجمه|پردازش)(?=$|[^${FA_LETTER}])`,
  "um",
);

// ── pure classification (no network) ────────────────────────────────────────
export function classifyIntentSync(message) {
  const text = typeof message === "string" ? message : "";
  if (!text.trim()) return { intent: "chat", confidence: 1, reason: "empty" };

  // --- dev ---
  const hasEnAction = EN_ACTION_RE.test(text);
  const hasFaAction = FA_ACTION_RE.test(text);
  const hasAction = hasEnAction || hasFaAction;
  const hasProjectRef = PROJECT_REF_EN_RE.test(text) || PROJECT_REF_FA_RE.test(text);

  if (hasAction && hasProjectRef) {
    return { intent: "dev", confidence: 0.9, reason: "action+project-ref" };
  }
  if (hasProjectRef) {
    return { intent: "dev", confidence: 0.55, reason: "project-ref-only" };
  }
  if (hasAction) {
    return { intent: "dev", confidence: 0.45, reason: "action-only" };
  }

  // --- task ---
  const hasTaskFile = TASK_FILE_RE.test(text);
  const hasTaskVerb = TASK_VERB_EN_RE.test(text) || FA_TASK_RE.test(text);

  if (hasTaskFile && hasTaskVerb) {
    return { intent: "task", confidence: 0.85, reason: "file+verb" };
  }
  if (hasTaskFile) {
    return { intent: "task", confidence: 0.55, reason: "file-only" };
  }
  if (hasTaskVerb) {
    return { intent: "task", confidence: 0.45, reason: "verb-only" };
  }

  return { intent: "chat", confidence: 0.9, reason: "no-signal" };
}

// LLM classify prompt — never sends the raw message without sanitizing it.
const LLM_SYSTEM =
  "You are a message classifier. Given a user message, output ONLY valid JSON: " +
  '{"intent":"chat"|"dev"|"task","confidence":0.0-1.0,"reason":"<short>"}. ' +
  "dev = request to change/add/fix code in THIS project. " +
  "task = file processing/conversion request. " +
  "chat = everything else. No explanation, no markdown, just JSON.";

// ── Worker base URL: single resolution point ────────────────────────────────
// No env variable and no request-derived URL feeds the self-call anywhere in
// src/ — the only source is the hardcoded deployed Worker URL. A full
// env/request-derived fix is a separate step and is NOT done here.
export function workerBaseUrl() {
  return "https://my-agent.nova-02aa82bffef8.workers.dev";
}

// ── Model intent classifier, Part 1: pure function + call, NO wiring ────────
// The classifier always uses combo "chat": never the user's preferred combo and
// never "fast" (combo/fast errored in earlier combo tests; a silent fallback to
// fast is forbidden). Its contract: system instruction + current message only,
// capped at 300 chars; output one JSON object; amount/date/currency fields are
// ignored, never read.
export const MODEL_INTENT_COMBO = "chat";
export const MODEL_INTENT_MAX_TOKENS = 80;
export const MODEL_INTENT_TIMEOUT_MS = 8000;
export const MODEL_INTENT_SYSTEM =
  "You are a message classifier for a personal assistant. Output ONLY valid JSON, " +
  'no explanation, no markdown: {"intent":"...","followup":"yes"|"no"|null,"target":"en"|"fa"|"ar"|null}. ' +
  "intents: expense = money spent; income = money received; note = save a note; " +
  "reminder = remind later; translate = translate text; remember = save a setting; " +
  "expense-query = ask about past spending; note-query = ask about saved notes; " +
  "last-expense = ask about the most recent expense; file-reference = refer to a recent file; " +
  "dev = request a code change; chat = anything else. " +
  'followup is "yes" or "no" only when the message answers the bot\'s previous question, otherwise null. ' +
  "target is a language code only for translate, otherwise null.";

// classifyDailyWithModel: (env, text, pendingQuestion?) -> parseModelIntent
// result | null. Combo "chat", 80 output tokens, temperature 0, 8s timeout, no
// retries, no fallback combo. Missing ROUTER_KEY -> skipped (null). Any error,
// non-OK status, or unparseable output -> null (or the {invalid:"target"}
// sentinel). No message text or key is ever logged. pendingQuestion is the
// bot's OWN previous ask text — never user data, history, or D1 records.
export async function classifyDailyWithModel(env, text, pendingQuestion = null) {
  if (!env || !env.ROUTER_KEY) return null;
  const userContent = pendingQuestion
    ? `پرسش قبلی بات: ${pendingQuestion}\nپیام کاربر: ${String(text).slice(0, 300)}`
    : String(text).slice(0, 300);
  const body = {
    model: `combo/${MODEL_INTENT_COMBO}`,
    messages: [
      { role: "system", content: MODEL_INTENT_SYSTEM },
      { role: "user", content: userContent },
    ],
    max_tokens: MODEL_INTENT_MAX_TOKENS,
    temperature: 0,
  };
  try {
    const res = await fetch(`${workerBaseUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.ROUTER_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MODEL_INTENT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content ?? "";
    return parseModelIntent(raw);
  } catch {
    return null;
  }
}

// callFastCombo: (env, text) -> Promise<{intent,confidence,reason}|null>
// Worker runtime only — uses Web Crypto and fetch. Any error returns null (caller -> chat).
async function callFastCombo(env, text) {
  if (!env.ROUTER_KEY) return null;
  const body = {
    model: "combo/fast",
    messages: [
      { role: "system", content: LLM_SYSTEM },
      { role: "user", content: String(text).slice(0, 300) },
    ],
    max_tokens: 80,
    temperature: 0,
  };
  try {
    const res = await fetch(`${workerBaseUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.ROUTER_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content ?? "";
    let parsed;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      const m = /\{[^}]+\}/.exec(raw);
      if (!m) return null;
      parsed = JSON.parse(m[0]);
    }
    const intent = ["chat", "dev", "task"].includes(parsed?.intent) ? parsed.intent : null;
    if (!intent) return null;
    const confidence = typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5;
    return { intent, confidence, reason: String(parsed.reason ?? "llm").slice(0, 60) };
  } catch {
    return null;
  }
}

// classifyIntent: main export — rule-based + optional LLM fallback.
// ctx: { callLLM: boolean, env: object } — env is only for the LLM, never logged.
// Phase 1-e Pillar 2 overload: classifyIntent(env, text, context) — first arg an
// object, second a string — routes to the NLU interpreter (classifyIntentNlu).
// The legacy (message, ctx) form is untouched.
export async function classifyIntent(message, ctx = {}, nluContext = {}, opts = {}) {
  if (message && typeof message === "object" && typeof ctx === "string") {
    const mergedOpts = { ...opts };
    if (typeof nluContext?.callFn === "function" && typeof mergedOpts.callFn !== "function") mergedOpts.callFn = nluContext.callFn;
    if (typeof nluContext?.model === "string" && typeof mergedOpts.model !== "string") mergedOpts.model = nluContext.model;
    if (typeof nluContext?.timeoutMs === "number" && typeof mergedOpts.timeoutMs !== "number") mergedOpts.timeoutMs = nluContext.timeoutMs;
    return classifyIntentNlu(message, ctx, nluContext, mergedOpts);
  }
  const sync = classifyIntentSync(message);

  const needsLLM =
    ctx.callLLM !== false &&
    ctx.env &&
    ctx.env.ROUTER_KEY &&
    (sync.intent === "dev" || sync.intent === "task") &&
    sync.confidence < DEV_THRESHOLD;

  if (!needsLLM) return sync;

  const llm = await callFastCombo(ctx.env, message);
  if (!llm) return { ...sync, intent: "chat", reason: "llm-fail->chat" };
  return llm;
}

// Free-text dev never executes: the 1b-2 suggestion text, used by index.js.
// Only an explicit /dev dispatches a run.
export function freeTextDevSuggestion() {
  return "این یک درخواست تغییر کد به نظر می‌رسد. برای اجرا، آن را با /dev بفرست.\nThis looks like a code-change request. Send it with /dev to run it.";
}
