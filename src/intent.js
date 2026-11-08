// مسیریابی intent پیام تلگرام — تابع خالص + یک فراخوانی اختیاری LLM برای موارد مبهم.
// classifyIntent(message, ctx) -> { intent: "chat"|"dev"|"task"|"ask", confidence, reason }
//
// dev  = درخواست تغییر/افزودن/رفع/refactor کد این پروژه
// task = پردازش فایل/تبدیل/دانلود (pdf، docx، عکس، zip، convert)
// ask  = سوال عمومی غیرچت (در آینده قابل توسعه)
// chat = هر چیز دیگر (پیشفرض محافظهکارانه)
//
// اگر اطمینان کمتر از DEV_THRESHOLD است و intent dev|task است،
// تابع callFastCombo (اختیاری) با یک prompt JSON-only صدا میشود.
// شکست LLM → chat.
// هیچ محتوای پیام یا کلیدی لاگ نمیشود.

const DEV_THRESHOLD = 0.7;
const DEV_CONFIRM_THRESHOLD = 0.85;

// ── سیگنالهای dev ────────────────────────────────────────────────────────────
// فعلهای عملیاتی انگلیسی
const EN_ACTION_RE =
  /\b(?:add|fix|change|refactor|update|implement|create|remove|delete|rename|edit|rewrite|debug|improve)\b/i;

// فعلهای عملیاتی فارسی
const FA_LETTER = "\\u0600-\\u06FF\\u0750-\\u077F\\uFB50-\\uFDFF\\uFE70-\\uFEFF";
const FA_ACTION_RE = new RegExp(
  `(?:^|[^${FA_LETTER}])(?:بساز|بنویس|اضافه\\s*کن|درست\\s*کن|تغییر\\s*بده|حذف\\s*کن|ریفکتور|بهتر\\s*کن|بروزرسانی|آپدیت)(?=$|[^${FA_LETTER}])`,
  "um",
);

// اشاره به پروژه/اجزای آن (انگلیسی + فارسی)
const PROJECT_REF_EN_RE =
  /\b(?:worker|router|panel|endpoint|bot|telegram|combo|catalog|src\/|index\.js|admin[-_]?page|health\.js|config\.js|providers?\.js|combos?\.js|overrides?\.js|task[-_]?route|tgprefs|intent|dev\.js|executor)\b/i;
const PROJECT_REF_FA_RE = new RegExp(
  `(?:^|[^${FA_LETTER}])(?:پروژه|ایجنت|ورکر|روتر|پنل|اندپوینت|ربات|کاتالوگ)(?=$|[^${FA_LETTER}])`,
  "um",
);

// ── سیگنالهای task ───────────────────────────────────────────────────────────
const TASK_FILE_RE =
  /\b(?:pdf|docx?|xlsx?|csv|zip|tar|gz|mp3|mp4|wav|avi|mov|png|jpg|jpeg|gif|webp)\b/i;
const TASK_VERB_EN_RE =
  /\b(?:convert|download|upload|process|extract|compress|resize|transcribe|translate|summarize)\b/i;
const FA_TASK_RE = new RegExp(
  `(?:^|[^${FA_LETTER}])(?:تبدیل|استخراج|دانلود|آپلود|فشرده|خلاصه|ترجمه|پردازش)(?=$|[^${FA_LETTER}])`,
  "um",
);

// ── طبقهبندی خالص (بدون شبکه) ───────────────────────────────────────────────
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

// LLM classify prompt — هیچ محتوای اصلی پیام را بدون sanitize نمیفرستد
const LLM_SYSTEM =
  "You are a message classifier. Given a user message, output ONLY valid JSON: " +
  '{"intent":"chat"|"dev"|"task","confidence":0.0-1.0,"reason":"<short>"}. ' +
  "dev = request to change/add/fix code in THIS project. " +
  "task = file processing/conversion request. " +
  "chat = everything else. No explanation, no markdown, just JSON.";

// ── Worker base URL: single resolution point ───────────────────────────────
// Part 1 investigation finding: no env variable and no request-derived URL
// feeds the self-call anywhere in src/ — the only source is the hardcoded
// deployed Worker URL below (previously a local const inside callFastCombo).
// Both callFastCombo and classifyDailyWithModel use this one helper, so there
// is still exactly one failure point, not two. A full env/request-derived
// fix is a separate step and is NOT done here.
export function workerBaseUrl() {
  return "https://my-agent.nova-02aa82bffef8.workers.dev";
}

// ── Model intent classifier, Part 1: pure function + call, NO wiring ────────
// classifyDailyWithModel is NOT called by any bot path yet (Part 2 wires it).
// Contract (approved design): system instruction + current message only,
// capped at 300 chars for classification; output one JSON object; no
// confidence field; amount/date/currency fields are ignored, never read.
// The classifier always uses combo "chat": never the user's preferred combo
// and never "fast" (combo/fast errored in earlier combo tests; silent
// fallback to fast is forbidden).
export const MODEL_INTENT_COMBO = "chat";
export const MODEL_INTENT_MAX_TOKENS = 80;
export const MODEL_INTENT_TIMEOUT_MS = 8000;
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

// parseModelIntent: raw model text -> {intent, followup, target}
//   | {invalid: "target"} (translate with an out-of-list target: the caller
//     asks for the language later, it must NOT be guessed) | null (failure).
// Unparseable, out-of-allow-list intent (including "task"), non-object JSON,
// and empty input are all null — never a guessed intent. A confidence field
// and any amount/date/currency fields are ignored, never read, and never
// appear in the returned object. followup outside yes/no becomes null.
// The brace-extraction fallback is the same pattern as callFastCombo.
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

// classifyDailyWithModel: (env, text) -> parseModelIntent result | null.
// Same request mechanism as callFastCombo, but combo "chat", 80 output
// tokens, temperature 0, 8s timeout, no retries, no fallback combo.
// Missing ROUTER_KEY -> skipped (null). Any error, non-OK status, or
// unparseable/invalid output -> null (or the {invalid: "target"} sentinel
// from parseModelIntent). No message text or key is ever logged here.
// classifyDailyWithModel: (env, text, pendingQuestion?) -> result | null.
// pendingQuestion (Part 3) is the bot's OWN previous ask text, sent as one labelled line — never user data, history, or D1 records.
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
// Worker runtime فقط — از Web Crypto و fetch استفاده میکند.
// در صورت هر خطا null برمیگردد (caller → chat).
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

// classifyIntent: main export — rule-based + optional LLM fallback
// ctx: { callLLM: boolean, env: object } — env فقط برای LLM؛ هرگز لاگ نمیشود
// Phase 1-e Pillar 2 overload: classifyIntent(env, text, context) —
// first arg an object, second a string — routes to the NLU interpreter
// (classifyIntentNlu). The legacy (message, ctx) form is untouched.
export async function classifyIntent(message, ctx = {}, nluContext = {}) {
  if (message && typeof message === "object" && typeof ctx === "string") {
    return classifyIntentNlu(message, ctx, nluContext);
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

// needsConfirmation: آیا این intent باید قبل از اجرا تأیید بگیرد؟
export function needsConfirmation(result) {
  return (result.intent === "dev" || result.intent === "task") && result.confidence < DEV_CONFIRM_THRESHOLD;
}

// Free-text dev never executes: 1b-2 suggestion text, used by index.js.
// Only an explicit /dev dispatches a run.
export function freeTextDevSuggestion() {
  return "این یک درخواست تغییر کد به نظر می‌رسد. برای اجرا، آن را با /dev بفرست.\nThis looks like a code-change request. Send it with /dev to run it.";
}

// ── Phase 1-e Pillar 2: context-aware AI NLU interpreter ─────────────
// Separate from the Phase-0 interpreter (src/interpreter.js), which
// stays gated on INTERPRETER_MODEL / o.interpreterCallFn. This layer
// activates on the Workers AI binding alone — no wrangler.jsonc edit —
// because resolveInterpreterModel falls back to the default model when
// the binding exists and INTERPRETER_MODEL is unset ("off"/"none"
// disables it). The caller (everyday.js) runs deterministic rules FIRST
// and only calls this when they return chat, so the model never decides
// numbers, dates, projects, or D1 writes — it only proposes an intent,
// and the caller re-validates everything deterministically.
export const DEFAULT_INTERPRETER_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const NLU_TIMEOUT_MS = 4500;
export const NLU_MAX_TOKENS = 512;
export const NLU_VALID_INTENTS = Object.freeze([
  "note", "task", "reminder", "expense", "income", "note_list", "task_list",
  "project_list", "project_create", "summary", "daypart_reply", "chat",
  "vault_save", "vault_get", "vault_list", "vault_file_get",
  "memory_save", "unsupported_action",
]);

export function resolveInterpreterModel(env) {
  const v = env?.INTERPRETER_MODEL;
  if (v === "off" || v === "none") return null;
  if (typeof v === "string" && v.trim()) {
    const t = v.trim();
    if (t.startsWith("@cf/") || !env?.AI || typeof env.AI.run !== "function") return t;
    return DEFAULT_INTERPRETER_MODEL;
  }
  if (env?.AI && typeof env.AI.run === "function") return DEFAULT_INTERPRETER_MODEL;
  return null;
}

// extractJsonObject(raw): strip <think> blocks (closed and unclosed)
// and markdown fences, then parse the FIRST balanced {...} object with
// string awareness (braces inside quoted strings do not count). Any
// failure returns null — never a partial object.
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
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
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

function buildNluPrompt(text, context = {}) {
  const projects = Array.isArray(context.projects) && context.projects.length
    ? context.projects.join("، ")
    : "none";
  const pending = context.pendingAsk
    ? JSON.stringify(context.pendingAsk)
    : "none";
  const source = context.source === "voice" ? "voice" : "text";
  const nowIso = typeof context.nowIso === "string" && context.nowIso ? context.nowIso : "unknown";
  const openTasks = Array.isArray(context.openTasks) && context.openTasks.length
    ? context.openTasks.map((t) => (typeof t === "string" ? t : t?.title ?? "")).filter(Boolean).join("، ")
    : "none";
  const recentNotes = Array.isArray(context.recentNotes) && context.recentNotes.length
    ? context.recentNotes.map((t) => (typeof t === "string" ? t : t?.text ?? "")).filter(Boolean).join("، ")
    : "none";
  const lastAction = context.lastAction
    ? (typeof context.lastAction === "string" ? context.lastAction : JSON.stringify(context.lastAction))
    : "none";
  const system = [
    "You are a Persian intent classifier for a single-user personal assistant bot.",
    "Output ONLY one JSON object, no other text, no markdown fences:",
    '{"intent": "...", "confidence": 0.0-1.0, "project": "name or null", "title": "key or null", "body": "text or null", "date_ref": "امروز|فردا|پسفردا|null", "time_ref": "HH:MM or hour text or null", "daypart": "صبح|عصر|شب|cancel|null", "summary_target": "notes|tasks|null", "leading_framing": "exact text or null", "trailing_framing": "exact text or null"}',
    "Intents: note, task, reminder, expense, income, note_list, task_list, project_list, project_create, summary, daypart_reply, vault_save, vault_get, vault_list, vault_file_get, memory_save, unsupported_action, chat.",
    "Rules:",
    "- Classify by semantic meaning, not rigid keywords. Information/explanation questions (e.g. تفاوت Cloudflare D1 و KV چیه؟, چطور توی پایتون...) are ALWAYS chat, including questions about the user's own stored facts (e.g. 'اسم من چیه؟', 'من کجا زندگی می‌کنم؟'). Negated commands ('ثبت نکن') are chat.",
    "- memory_save: user is stating a personal fact, attribute, name, location, vehicle, preference, or static info to keep in mind (e.g. 'یادت باشه اسم من محمده', 'یادت بمونه من تهران می‌شینم', 'ماشین من پژو ۲۰۷ هست', 'فراموش نکن تولدم مهره', 'این را به خاطر بسپار: ...'). Extract the clean fact into body (e.g. 'اسم من محمد است') and the key/topic into title (e.g. 'name'). NEVER classify personal facts with 'یادت باشه' as reminder.",
    "- reminder: user wants a time-based future alert/notification to do an action (e.g. 'برای ۲ دقیقه دیگه یادآوری کن...', 'یادم بنداز فردا ساعت ۸...', 'یادت باشه فردا به علی زنگ بزنم', 'یادم بنداز فردا ساعت ۵ عصر به علی زنگ بزنم'). body = title, date_ref, time_ref, daypart, project.",
    "- note: user is dictating or sending text/thoughts/plans to be saved as a note (regardless of how the command is phrased at the start, middle, or end). Embedded mentions of vaults, cards, hours, or emails inside the note body are passive content, NOT commands. 'این را یادداشت کن: ...' is note, NOT memory_save.",
    "- vault_save: user is explicitly asking to store a sensitive credential (card number, IBAN, account, national ID, password) in the vault (e.g. 'شماره کارت رسالت 6037... ثبتش کن').",
    "- unsupported_action: user asks to execute an external unimplemented action right now (like sending an email or SMS, e.g. 'الان ایمیل بفرست به ...') — never chat and never a note/task; the caller replies honestly that the connector is not connected.",
    "- Money received (حقوق گرفتم، واریز شد، درآمد) is income, money spent is expense. The caller validates amounts deterministically.",
    "- Reference phrases ('همونو برای فردا بذار', 'اونو ...'): resolve against the single recent open task/note listed below when exactly one exists; if multiple open targets exist, return chat with low confidence so the caller asks a clarification question instead of guessing.",
    "- A natural conversational note request — even if it starts with a greeting (سلام, درود), a politeness word (لطفاً, بیزحمت, ممنون), or a modal opener (میخوام, میخواستم, میشه) — is note with confidence >= 0.85. Strip ALL framing words from body; body must be ONLY the clean content to store. Examples: 'سلام یه یادداشت برام ثبت کن که فردا سیمان میرسه' → note, body='فردا سیمان میرسه'; 'میخوام یه یادداشت ثبت کنی فردا جلسه با مهندس ناظر ساعت ۱۰' → note, body='فردا جلسه با مهندس ناظر ساعت ۱۰'; 'فردا باید قرارداد رو امضا کنیم، اینو برام یادداشت کن' → note, body='فردا باید قرارداد رو امضا کنیم'.",
    "- A natural conversational task request — even with greetings or modal openers — is task with confidence >= 0.85. body = the clean task title only. Examples: 'سلام یه تسک جدید برام ثبت کن برای پروژه یوتیوب ادیت ویدیو' → task, body='ادیت ویدیو', project='یوتیوب'; 'یه کار جدید برام ثبت کن بررسی قرارداد پیمانکار' → task, body='بررسی قرارداد پیمانکار'.",
    "- A time-based request (e.g. یادم بنداز فردا ساعت ۵ عصر به علی زنگ بزنم, یادت نره فردا به علی زنگ بزنم) is reminder: body = title, date_ref, time_ref, daypart, project.",
    "- Summarize requests (e.g. یه خلاصه از یادداشتهام بده, یادداشتهای گلبهار رو جدول کن) are summary with summary_target notes/tasks and project.",
    "- Vault requests: saving a card/sheba/account/ID ('شماره کارت رسالت 6037... ثبتش کن') is vault_save; asking for one ('شماره کارتم چنده؟') is vault_get; listing them ('کارت‌هام رو نشون بده') is vault_list; asking for an archived file/photo ('آخرین آزمایشم رو بفرست') is vault_file_get. The caller validates and decrypts values deterministically — never trust NLU-extracted amounts.",
    "- When a pending hour-ambiguous question is active and the message is a time/daypart clarification or cancellation, even with typos or conversational phrasing (صبخ, واسه صبح, عصری, کنسل), it is daypart_reply with daypart صبح/عصر/شب/cancel.",
    "- Never invent a project: project must be one of the listed names or null. Never invent numbers: the caller validates any amount deterministically.",
    "- body must never contain command framing words like 'یادداشت کن', 'ثبت کن', 'بذار', 'تسک', 'یادداشت', 'برام', 'واسم', 'لطفاً', 'سلام', 'میخوام'. Extract only the meaningful content.",
    "- For a note, copy framing words verbatim into leading_framing/trailing_framing when they sit at the very start/end of the user text; never summarize, rewrite, or truncate a long body.",
    "- If unsure, return chat with low confidence.",
    `Projects: ${projects}`,
    `Pending question: ${pending}`,
    `Message source: ${source}`,
    `Now (Iran time, +03:30): ${nowIso}`,
    `Last action: ${lastAction}`,
    `Open tasks: ${openTasks}`,
    `Recent notes: ${recentNotes}`,
  ].join("\n");
  return { system, user: String(text ?? "") };
}

// classifyIntentNlu(env, text, context, opts) -> { ok, intent,
// confidence, project, body, date_ref, time_ref, daypart,
// summary_target } | { ok: false, reason }. Timeout is a Promise.race
// (env.AI.run takes no abort signal); a timeout, a bad parse, or an
// unknown intent all return { ok: false } so the caller falls through
// to chat — never a drop, never a guessed write.
export async function classifyIntentNlu(env, text, context = {}, opts = {}) {
  const model = resolveInterpreterModel(env);
  if (!model) return { ok: false, reason: "no-model" };
  const timeoutMs = opts.timeoutMs || NLU_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("nlu timeout")), timeoutMs);
  });
  try {
    const prompt = buildNluPrompt(text, context);
    const res = await Promise.race([
       env.AI.run(model, {
         messages: [
           { role: "system", content: prompt.system },
           { role: "user", content: prompt.user },
         ],
         temperature: 0.1,
         max_tokens: NLU_MAX_TOKENS,
       }),
      timeout,
    ]);
    const raw = typeof res === "string" ? res : (res?.response ?? res?.text ?? "");
    const obj = extractJsonObject(raw);
    if (!obj) return { ok: false, reason: "bad-json" };
    if (!NLU_VALID_INTENTS.includes(obj.intent)) return { ok: false, reason: "bad-intent" };
    const conf = typeof obj.confidence === "number" ? obj.confidence : Number(obj.confidence);
    const str = (v) => (typeof v === "string" ? v : null);
    return {
      ok: true,
      intent: obj.intent,
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0,
      project: str(obj.project),
      title: str(obj.title),
      body: str(obj.body),
      date_ref: str(obj.date_ref),
      time_ref: str(obj.time_ref),
      daypart: str(obj.daypart),
      summary_target: str(obj.summary_target),
      leading_framing: str(obj.leading_framing),
      trailing_framing: str(obj.trailing_framing),
    };
  } catch (err) {
    return { ok: false, reason: err?.message === "nlu timeout" ? "timeout" : "error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
