// Memory layer (Step 1a): chat context + explicit settings only.
// Chat context is kind='chat' rows only; daily rows (expenses, notes,
// reminders) are never sent to a model as chat context. The default
// currency is a fixed constant unless the user explicitly remembers a
// different one — it is never inferred from an expense.
import { getChatMessages, getMemory, setMemory } from "./db.js";

export const CHAT_CONTEXT_LIMIT = 50;
export const DEFAULT_CURRENCY = "TOMAN";
export const SETTING_KEYS = ["name", "language", "currency", "timezone"];

// Messages ready for a router body: [{ role, content }], oldest first,
// at most CHAT_CONTEXT_LIMIT rows. Returns [] when the DB is unavailable.
export async function getChatContext(envOrDb, userId) {
  const rows = await getChatMessages(envOrDb, userId, CHAT_CONTEXT_LIMIT);
  return rows
    .filter((r) => r && typeof r.content === "string" && r.content)
    .map((r) => ({ role: r.role === "assistant" ? "assistant" : "user", content: r.content }))
    .slice(-CHAT_CONTEXT_LIMIT);
}

// Explicit settings only. Unknown keys and empty values are refused;
// there is no automatic writer in Step 1a.
export async function getSetting(envOrDb, userId, key) {
  if (!SETTING_KEYS.includes(key)) return null;
  return getMemory(envOrDb, userId, "setting", key);
}

export async function setSetting(envOrDb, userId, key, value) {
  if (!SETTING_KEYS.includes(key)) return { ok: false };
  return setMemory(envOrDb, userId, "setting", key, value);
}

export async function getDefaultCurrency(envOrDb, userId) {
  const saved = await getSetting(envOrDb, userId, "currency");
  return saved || DEFAULT_CURRENCY;
}
