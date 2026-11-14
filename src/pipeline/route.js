// Pipeline routing (R0.6, contract v3 §3/§4): pure decisions only.
// Three groups: task/combo routing (from task-route.js), NLU model resolution
// (from intent.js), and pending-ask slot routing (from everyday.js).
// No channel import, no network: sends go through injected callbacks (o.send).
import { classifyDaily } from "../daily.js";

// ── Task routing (moved from task-route.js) ─────────────────────────────────
// Output of classifyTask is one of: "vision" | "code" | "chat" — when in
// doubt, "chat". Code colouring only on a clear signal.
const IMAGE_MIME_RE = /^image\//i;

// Does this update carry an image? (photo, or an image document)
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

// ── code signals ────────────────────────────────────────────────────────────
const FENCE_RE = /```/;
// stack-trace lines: "at foo (app.js:10:5)" / "at foo (app.js:10)" / "at /path/file.js:10:5"
const STACK_TRACE_RE = /^\s*at\s+(?:\S+\s+)?\(?[^\s()]+:\d+(?::\d+)?\)?\s*$/m;
// Python: "Traceback (most recent call last):" or «File "x.py", line 3»
const PY_TRACE_RE = /Traceback \(most recent call last\):/;
const PY_FILE_RE = /^\s*File "[^"]+", line \d+/m;
// def/function/class + brace or colon — def f(x):  function f() {  class Foo:
const DEF_RE = /^\s*(?:async\s+)?def\s+[A-Za-z_]\w*\s*\([^)]*\)\s*:/m;
const FUNC_RE = /^\s*(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/m;
const CLASS_RE = /^\s*class\s+[A-Za-z_$][\w$]*(?:\s*(?:<[^>]*>|\([^)]*\)))?\s*[:{]/m;
// common file extensions
const FILE_EXT_RE = /(?:^|[\s"'(`=:,])[\w./\\~-]+\.(?:js|mjs|cjs|jsx|ts|tsx|py|go)\b/i;
// English keywords (bug/error/compile/regex/sql/function/refactor)
const KEYWORD_RE = /\b(?:bug|error|compile|compiler|regex|regexp|sql|function|refactor)\b/i;

// Persian equivalents with a manual word boundary (Persian letters = the
// boundary). Stripping is limited so «کدام» does not match «کد».
const FA_LETTER = "\\u0600-\\u06FF\\u0750-\\u077F\\uFB50-\\uFDFF\\uFE70-\\uFEFF";
const FA_CODES = ["کد(?:نویسی|ها|های|ی)?", "باگ(?:ش|ها|های|ی)?", "خطا(?:ی|ها|های)?", "تابع(?:ی|ها|های)?", "کامپایل", "رفکتور", "ریجکس"];
const FA_CODE_RE = new RegExp(`(?:^|[^${FA_LETTER}])(?:${FA_CODES.join("|")})(?=$|[^${FA_LETTER}])`, "um");

// ── combo routing ───────────────────────────────────────────────────────────
export const BUILTIN_COMBOS = Object.freeze(["chat", "code", "vision", "fast"]);

// Candidate order: [task (only when auto is on)], the user default, "chat" —
// runtime takes the first known candidate. defaultCombo is the admin-set
// manual default: it fills the "no user preference" slot, so a manual default
// wins over the hardcoded "chat" without disabling auto-routing.
export function comboCandidates(prefs, task, defaultCombo = null) {
  const p = prefs && typeof prefs === "object" && !Array.isArray(prefs) ? prefs : {};
  const auto = p.auto !== false;
  const userDef = typeof p.combo === "string" && p.combo ? p.combo : null;
  const adminDef = typeof defaultCombo === "string" && defaultCombo ? defaultCombo : null;
  const def = userDef || adminDef || "chat";
  const out = [];
  const push = (n) => { if (n && out.indexOf(n) === -1) out.push(n); };
  if (auto && typeof task === "string" && task) push(task);
  push(def);
  push("chat");
  return out;
}

// Single fallback target (no loop): chosen != def -> def; else != "chat" -> "chat"; else none.
export function fallbackCombo(def, chosen) {
  const d = typeof def === "string" && def ? def : "chat";
  if (chosen !== d) return d;
  if (chosen !== "chat") return "chat";
  return null;
}

// Offline/test selector: the first known-and-usable candidate.
export function selectCombo(prefs, task, availability = {}) {
  const known = availability.isKnown ?? (() => true);
  const usable = availability.isUsable ?? (() => true);
  const candidates = comboCandidates(prefs, task);
  const def = typeof prefs?.combo === "string" && prefs.combo ? prefs.combo : "chat";
  for (const name of candidates) {
    if (known(name) && usable(name)) return { combo: name, candidates, fallback: fallbackCombo(def, name) };
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

// ── NLU model resolution (moved from intent.js) ─────────────────────────────
export const DEFAULT_INTERPRETER_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const NLU_TIMEOUT_MS = 4500;
export const NLU_MAX_TOKENS = 512;
export const NLU_VALID_INTENTS = Object.freeze([
  "note", "task", "reminder", "expense", "income", "note_list", "task_list",
  "project_list", "project_create", "summary", "daypart_reply", "chat",
  "vault_save", "vault_get", "vault_list", "vault_file_get",
  "memory_save", "unsupported_action", "image_gen",
]);

// resolveInterpreterModel: explicit model wins; "off"/"none" disables; a
// non-@cf id falls back to the default when the AI binding exists (no
// wrangler edit needed). null = the interpreter is off.
export function resolveInterpreterModel(env, opts = {}) {
  const v = opts?.model ?? env?.INTERPRETER_MODEL;
  if (v === "off" || v === "none") return null;
  if (typeof v === "string" && v.trim()) {
    const t = v.trim();
    if (t.startsWith("@cf/") || !env?.AI || typeof env.AI.run !== "function") return t;
    if (typeof opts?.callFn === "function") return t;
    return DEFAULT_INTERPRETER_MODEL;
  }
  if (env?.AI && typeof env.AI.run === "function") return DEFAULT_INTERPRETER_MODEL;
  return null;
}

// resolvePipelineMode(env, {aiAvailable}) -> "nlu" | "model_slot" | "interpreter".
// One explicit decision point for the branch ladder that used to be an
// implicit chain of env.INTERPRETER_MODEL / env.AI checks.
export function resolvePipelineMode(env, { aiAvailable = true } = {}) {
  if (aiAvailable && resolveInterpreterModel(env) !== null) return "nlu";
  if (!env?.INTERPRETER_MODEL) return "model_slot";
  return "interpreter";
}

// ── Pending-ask slot routing (moved from everyday.js) ───────────────────────
// ONE slot per user, 600s TTL like money drafts. {question, askId?, kind?,
// pendingBody?}: question is always the bot's own ask text; askId points at
// the existing daily:ask record; kind is a stable identifier (like
// "note-text"), never a Persian-text comparison.
const PENDING_TTL_SEC = 600;
const EXPIRED_TEXT = "قبلاً ثبت شد یا مهلتش گذشته";
const pendingKey = (id) => `daily:pending-ask:${id}`;
const askKey = (id) => `daily:ask:${id}`;
async function putKv(env, key, value) { if (!env.STATE) return; try { await env.STATE.put(key, JSON.stringify(value), { expirationTtl: PENDING_TTL_SEC }); } catch {} }
async function getKv(env, key) { if (!env.STATE) return null; try { const raw = await env.STATE.get(key, "json"); return raw && typeof raw === "object" ? raw : null; } catch { return null; } }
async function delKv(env, key) { if (!env.STATE) return; try { await env.STATE.delete(key); } catch {} }

export function mapQuestion(q) { return q === "ambiguous" ? "amount" : q; }
export function askText(q) {
  return { amount: "مبلغ چقدر بود؟", decimal: "مبلغ اعشاری در این قدم پذیرفته نیست؛ مبلغ را به عدد صحیح بگو.", period: "برای کدام دوره؟ امروز، دیروز، این هفته یا این ماه؟", date: "تاریخ را درست بگو؛ آن تاریخ معتبر نیست.", "hour-ambiguous": "ساعت را با صبح یا عصر مشخص کن.", "no-time": "ساعت یادآوری را بگو.", past: "آن زمان گذشته است؛ زمان آینده را بگو.", empty: "یادآوری برای چه کاری؟", text: "چه متنی را ترجمه کنم؟", "expense-or-chat": "این خرج است یا چت؟", "expense-or-income": "این خرج است یا درآمد؟", "note-text": "چه چیزی را یادداشت کنم؟", language: "به چه زبانی؟" }[q] ?? "دوباره بگو؟";
}

export async function setPendingAsk(env, userId, question, askId, kind, pendingBody) {
  const value = { question };
  if (askId) value.askId = askId;
  if (kind) value.kind = kind;
  if (pendingBody) value.pendingBody = pendingBody;
  await putKv(env, pendingKey(userId), value);
}

// Language-name mapper for deterministic language-slot answers (en/fa/ar
// only, the pre-existing everyday target restriction — "German" re-asks).
export function parseLanguageAnswer(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(/^به\s+/u, "").replace(/[؟?!.،,:：\s]+$/u, "");
  if (["en", "english", "انگلیسی", "انگليسي"].includes(t)) return "en";
  if (["fa", "persian", "farsi", "فارسی", "فارسي"].includes(t)) return "fa";
  if (["ar", "arabic", "عربی", "عربي"].includes(t)) return "ar";
  return null;
}

// Slot kind, with a defensive fallback for slots built without one: button
// slots by askId, otherwise reverse the ask text to its key.
export function slotKind(slot) {
  if (!slot || typeof slot !== "object") return "other";
  if (slot.kind) return slot.kind;
  if (slot.askId) return "button";
  for (const key of ["amount", "decimal", "period", "date", "hour-ambiguous", "no-time", "past", "empty", "text", "expense-or-chat", "expense-or-income", "note-text", "language"]) {
    if (slot.question === askText(key)) return key === "text" ? "translate-text" : key;
  }
  return "other";
}
// Slots whose question must survive a skipped/failed model call: dropping
// them would lose the question.
export function isBodySlot(slot) { return ["note-text", "translate-text", "language"].includes(slotKind(slot)); }
// Rule ask key -> slot kind ("text" is the translate-body ask).
export function kindForAskKey(key) { return key === "text" ? "translate-text" : key; }
export async function getPendingAsk(env, userId) { return getKv(env, pendingKey(userId)); }
export async function clearPendingAsk(env, userId) { await delKv(env, pendingKey(userId)); }

export function askKeyboard(question, id) {
  return question === "expense-or-chat"
    ? [[{ text: "💰 خرج", callback_data: `daily:ask:${id}:expense` }, { text: "💬 چت", callback_data: `daily:ask:${id}:chat` }]]
    : [[{ text: "💸 خرج", callback_data: `money:dir:spend:${id}` }, { text: "💰 درآمد", callback_data: `money:dir:income:${id}` }]];
}

// 1-tap disambiguation for hour-ambiguous asks. Attached EVERY time the bot
// sends "ساعت را با صبح یا عصر مشخص کن." so the user never has to type a daypart.
export function hourAmbiguousKeyboard() {
  return [[{ text: "☀️ صبح", callback_data: "ask:dp:صبح" }, { text: "🌇 عصر", callback_data: "ask:dp:عصر" }], [{ text: "❌ انصراف", callback_data: "ask:cancel" }]];
}
export async function sendHourAmbiguousAsk(o) {
  await o.send(askText("hour-ambiguous"), { replyMarkup: { inline_keyboard: hourAmbiguousKeyboard() } });
}

// Re-ask the pending question after a model failure; button asks reuse the SAME ask id.
export async function reaskPending(env, o, slot) {
  if (slot.askId) {
    const ask = await getKv(env, askKey(slot.askId));
    if (!ask || Number(ask.owner) !== Number(o.userId) || (ask.question !== "expense-or-chat" && ask.question !== "expense-or-income")) { await o.send(EXPIRED_TEXT); return; }
    await o.send(askText(ask.question), { replyMarkup: { inline_keyboard: askKeyboard(ask.question, slot.askId) } });
    await setPendingAsk(env, o.userId, askText(ask.question), slot.askId, "button", slot.pendingBody);
    return;
  }
  await o.send(slot.question);
  await setPendingAsk(env, o.userId, slot.question, undefined, slotKind(slot), slot.pendingBody);
}

// Translate body derivation, shared by the translate case and the
// invalid-target ask: rule body first, then a "text: body" colon fallback.
export function deriveTranslateBody(text, ctx) {
  const c2 = classifyDaily(text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered });
  let body = c2.intent === "translate" ? c2.text : null;
  if (!body) { const colon = /[:：]\s*([\s\S]+)/.exec(text); body = colon ? colon[1].trim() : null; }
  return body || null;
}
