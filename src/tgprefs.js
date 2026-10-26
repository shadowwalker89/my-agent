// تنظیم هر کاربر تلگرام: کلید KV "tgprefs:<userId>".
// { combo: string|null, auto: boolean, show: boolean, intent: boolean }
// پیش‌فرض: combo null (یعنی «chat») — auto روشن — show خاموش.
// فیلدهای ناشناس نادیده گرفته می‌شوند؛ سقف اندازه: combo با NAME_RE (a-z0-9._-، ۴۰ نویسه).
import { NAME_RE } from "./config.js";

const KEY_PREFIX = "tgprefs:";

export const DEFAULT_PREFS = Object.freeze({ combo: null, auto: true, show: false, intent: true });

// validate + cap + ignore-unknown — تابع خالص برای تست آفلاین
export function normalizePrefs(raw) {
  const out = { ...DEFAULT_PREFS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  if (raw.combo === null) out.combo = null;
  else if (typeof raw.combo === "string" && NAME_RE.test(raw.combo)) out.combo = raw.combo;
  if (typeof raw.auto === "boolean") out.auto = raw.auto;
  if (typeof raw.show === "boolean") out.show = raw.show;
  if (typeof raw.intent === "boolean") out.intent = raw.intent;
  return out;
}

export function isUserId(userId) {
  return /^\d{1,32}$/.test(String(userId ?? ""));
}

export function prefsKey(userId) {
  return `${KEY_PREFIX}${String(userId ?? "")}`;
}

export async function getPrefs(env, userId) {
  if (!env.STATE || !isUserId(userId)) return { ...DEFAULT_PREFS };
  const raw = await env.STATE.get(prefsKey(userId), "json");
  return normalizePrefs(raw);
}

export async function setPrefs(env, userId, patch) {
  const current = await getPrefs(env, userId);
  if (!env.STATE || !isUserId(userId)) return current;
  const extra = patch && typeof patch === "object" ? patch : {};
  const next = normalizePrefs({ ...current, ...extra });
  await env.STATE.put(prefsKey(userId), JSON.stringify(next));
  return next;
}
