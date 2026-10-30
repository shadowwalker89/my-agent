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
    const workerBase = "https://my-agent.nova-02aa82bffef8.workers.dev";
    const res = await fetch(`${workerBase}/v1/chat/completions`, {
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
export async function classifyIntent(message, ctx = {}) {
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
