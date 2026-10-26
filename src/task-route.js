// مسیریابی تسکِ پیام تلگرام — تابع خالص، بدون شبکه/env.
// خروجی classifyTask فقط یکی از: "vision" | "code" | "chat" — هرجا شک، «chat».
// توجه: رنگ کد فقط وقتی signal واضح باشد؛ کلمه‌ی مثلاً «خطا» در جمله‌ی عادی فارسی/انگلیسی
// مطابق مشخصاتِ پچ، سیگنال کد حساب می‌شود — ولی فواصل/بستن بازشده‌ها محافظه‌کارانه است.

const IMAGE_MIME_RE = /^image\//i;

// update تلگرام عکس دارد؟ (photo یا document تصویری)
export function updateHasImage(update) {
  if (!update || typeof update !== "object") return false;
  if (Array.isArray(update.photo) && update.photo.length) return true;
  const doc = update.document;
  if (doc && typeof doc === "object") {
    if (IMAGE_MIME_RE.test(String(doc.mime_type ?? ""))) return true;
    if (Array.isArray(doc.thumbnail) || Array.isArray(doc.thumbnails)) return true;
  }
  return false;
}

// ── سیگنال‌های کد ────────────────────────────────────────────────────────────
const FENCE_RE = /```/;

// خطوط stack trace: "at foo (app.js:10:5)" / "at foo (app.js:10)" / "at /path/file.js:10:5"
const STACK_TRACE_RE = /^\s*at\s+(?:\S+\s+)?\(?[^\s()]+:\d+(?::\d+)?\)?\s*$/m;

// Python: "Traceback (most recent call last):" یا «File "x.py", line 3»
const PY_TRACE_RE = /Traceback \(most recent call last\):/;
const PY_FILE_RE = /^\s*File "[^"]+", line \d+/m;

// def/function/class + brace یا colon — مثل: def f(x):  function f() {  class Foo:  class Foo<T> {
const DEF_RE = /^\s*(?:async\s+)?def\s+[A-Za-z_]\w*\s*\([^)]*\)\s*:/m;
const FUNC_RE = /^\s*(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/m;
const CLASS_RE = /^\s*class\s+[A-Za-z_$][\w$]*(?:\s*(?:<[^>]*>|\([^)]*\)))?\s*[:{]/m;

// پسوندهای رایج فایل
const FILE_EXT_RE = /(?:^|[\s"'(`=:,])[\w./\\~-]+\.(?:js|mjs|cjs|jsx|ts|tsx|py|go)\b/i;

// واژه‌های کلیدی انگلیسی (مطابق مشخصات: bug/error/compile/regex/sql/function/refactor)
const KEYWORD_RE = /\b(?:bug|error|compile|compiler|regex|regexp|sql|function|refactor)\b/i;

// معادل‌های فارسی با مرز واژه‌ی دستی (حروف فارسی = مرز). فرم‌های(strip) محدود — «کدام» نمی‌خورد.
const FA_LETTER = "\\u0600-\\u06FF\\u0750-\\u077F\\uFB50-\\uFDFF\\uFE70-\\uFEFF";
const FA_CODES = [
  "کد(?:نویسی|ها|های|ی)?",
  "باگ(?:ش|ها|های|ی)?",
  "خطا(?:ی|ها|های)?",
  "تابع(?:ی|ها|های)?",
  "کامپایل",
  "رفکتور",
  "ریجکس",
];
const FA_CODE_RE = new RegExp(
  `(?:^|[^${FA_LETTER}])(?:${FA_CODES.join("|")})(?=$|[^${FA_LETTER}])`,
  "um",
);

// ── مسیریابی combo ──────────────────────────────────────────────────────────
export const BUILTIN_COMBOS = Object.freeze(["chat", "code", "vision", "fast"]);

// ترتیب گزینه‌های combo برای پیام کاربر:
// [task (فقط وقتی auto روشن)]، پیش‌فرض کاربر، «chat» — runtime اولین گزینه‌ی شناخته‌شده‌ی پُراِستفاده را برمی‌دارد.
export function comboCandidates(prefs, task) {
  const p = prefs && typeof prefs === "object" && !Array.isArray(prefs) ? prefs : {};
  const auto = p.auto !== false;
  const def = typeof p.combo === "string" && p.combo ? p.combo : "chat";
  const out = [];
  const push = (n) => {
    if (n && out.indexOf(n) === -1) out.push(n);
  };
  if (auto && typeof task === "string" && task) push(task);
  push(def);
  push("chat");
  return out;
}

// هدفِ جایگزینِ تنها (بدون حلقه): اگر انتخاب != پیش‌فرض → پیش‌فرض؛ وگرنه اگر != «chat» → «chat»؛ وگرنه هیچ.
export function fallbackCombo(def, chosen) {
  const d = typeof def === "string" && def ? def : "chat";
  if (chosen !== d) return d;
  if (chosen !== "chat") return "chat";
  return null;
}

// انتخاب ترکیبی برای تست آفلاین: در میان candidates اولین «شناخته و دارای هدف» را برمی‌دارد.
export function selectCombo(prefs, task, availability = {}) {
  const known = availability.isKnown ?? (() => true);
  const usable = availability.isUsable ?? (() => true);
  const candidates = comboCandidates(prefs, task);
  const def = typeof prefs?.combo === "string" && prefs.combo ? prefs.combo : "chat";
  for (const name of candidates) {
    if (known(name) && usable(name)) {
      return { combo: name, candidates, fallback: fallbackCombo(def, name) };
    }
  }
  return { combo: "chat", candidates, fallback: null };
}

export function classifyTask(input, opts = {}) {
  let text = "";
  let hasImage = opts.hasImage === true;
  if (typeof input === "string") {
    text = input;
  } else if (input && typeof input === "object") {
    if (typeof input.text === "string") text = input.text;
    hasImage = hasImage || updateHasImage(input) || input.hasImage === true;
  }

  if (hasImage) return "vision";
  if (!text) return "chat";

  if (FENCE_RE.test(text)) return "code";
  if (STACK_TRACE_RE.test(text)) return "code";
  if (PY_TRACE_RE.test(text) || PY_FILE_RE.test(text)) return "code";
  if (DEF_RE.test(text) || FUNC_RE.test(text) || CLASS_RE.test(text)) return "code";
  if (FILE_EXT_RE.test(text)) return "code";
  if (KEYWORD_RE.test(text) || FA_CODE_RE.test(text)) return "code";

  return "chat";
}
