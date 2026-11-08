// Memory layer (Step 1a): chat context + explicit settings only.
// Chat context is kind='chat' rows only; daily rows (expenses, notes,
// reminders) are never sent to a model as chat context. The default
// currency is a fixed constant unless the user explicitly remembers a
// different one — it is never inferred from an expense.
import { getChatMessages, getMemory, setMemory, listActiveUserFactsResult, getMessageRow } from "./db.js";

export const CHAT_CONTEXT_LIMIT = 50;
export const DEFAULT_CURRENCY = "TOMAN";
export const SETTING_KEYS = ["name", "language", "currency", "timezone"];

// Messages ready for a router body: [{ role, content }], oldest first,
// at most CHAT_CONTEXT_LIMIT rows. Returns [] when the DB is unavailable.
export async function getChatContext(envOrDb, userId) {
  const rows = await getChatMessages(envOrDb, userId, CHAT_CONTEXT_LIMIT);
  return rows
    .filter((r) => r && typeof r.content === "string" && r.content)
    .map((r) => ({ id: r.id, role: r.role === "assistant" ? "assistant" : "user", content: r.content }))
    .slice(-CHAT_CONTEXT_LIMIT);
}

// Explicit settings only. Unknown keys and empty values are refused;
// there is no automatic writer in Step 1a.
function isSettingKey(key) {
  return SETTING_KEYS.includes(key) || (typeof key === "string" && /^conn_[a-z0-9_]+$/i.test(key));
}
export async function getSetting(envOrDb, userId, key) {
  if (!isSettingKey(key)) return null;
  const v = await getMemory(envOrDb, userId, "setting", key);
  return typeof v === "string" ? v : null;
}

export async function setSetting(envOrDb, userId, key, value) {
  if (!isSettingKey(key)) return { ok: false };
  if (typeof value !== "string" || !value) return { ok: false };
  return setMemory(envOrDb, userId, "setting", key, value);
}

export async function getAllSettings(envOrDb, userId) {
  const db = resolveMemoryDb(envOrDb);
  if (!db) return {};
  const id = Number(userId);
  if (!Number.isFinite(id)) return {};
  try {
    const res = await db.prepare("SELECT key, value FROM memories WHERE user_id = ? AND kind = 'setting' ORDER BY key ASC").bind(id).all();
    const rows = Array.isArray(res?.results) ? res.results : [];
    const out = {};
    for (const r of rows) {
      const k = typeof r?.key === "string" ? r.key : "";
      if (!isSettingKey(k)) continue;
      out[k] = typeof r?.value === "string" ? r.value : String(r?.value ?? "");
    }
    return out;
  } catch { return {}; }
}

export async function getDefaultCurrency(envOrDb, userId) {
  const saved = await getSetting(envOrDb, userId, "currency");
  return saved || DEFAULT_CURRENCY;
}

function resolveMemoryDb(envOrDb) {
  if (envOrDb && typeof envOrDb.prepare === "function") return envOrDb;
  const db = envOrDb && envOrDb.DB;
  return db && typeof db.prepare === "function" ? db : null;
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\s+/g, " ");
}

function searchTokens(query) {
  const n = normalizeSearchText(query);
  if (!n) return [];
  return n.split(" ").filter(Boolean);
}

function matchesQuery(haystacks, query, tokens) {
  if (!tokens.length) return false;
  const full = normalizeSearchText(query);
  const hay = haystacks.map((h) => normalizeSearchText(h)).filter(Boolean);
  if (!hay.length) return false;
  if (full && hay.some((h) => h.includes(full))) return true;
  return tokens.some((t) => t.length > 0 && hay.some((h) => h.includes(t)));
}

export async function searchPersonalMemoryResult(envOrDb, userId, query, { limit = 5 } = {}) {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) return { ok: false, error: "invalid user" };
  const lim = Math.max(1, Math.min(100, Number(limit) || 5));
  const tokens = searchTokens(query);
  try {
    const factsRes = await listActiveUserFactsResult(envOrDb, uid);
    if (!factsRes || !factsRes.ok) return { ok: false, error: (factsRes && factsRes.error) || "db error" };
    const db = resolveMemoryDb(envOrDb);
    if (!db) return { ok: false, error: "db unavailable" };
    let noteRows = [];
    let taskRows = [];
    try {
      const nres = await db.prepare("SELECT id, text, source, created_at FROM notes WHERE user_id = ? ORDER BY id DESC LIMIT 100").bind(uid).all();
      noteRows = Array.isArray(nres?.results) ? nres.results : [];
    } catch (e) {
      return { ok: false, error: e && e.message ? String(e.message) : "db error" };
    }
    try {
      const tres = await db.prepare("SELECT id, title, status, source, source_message_id, created_at FROM tasks WHERE user_id = ? AND COALESCE(status, 'open') != 'deleted' ORDER BY id DESC LIMIT 100").bind(uid).all();
      taskRows = Array.isArray(tres?.results) ? tres.results : [];
    } catch (e) {
      return { ok: false, error: e && e.message ? String(e.message) : "db error" };
    }
    const facts = (factsRes.rows || [])
      .filter((r) => r && r.status === "active" && matchesQuery([r.fact_key, r.fact_value, r.category], query, tokens))
      .slice(0, lim)
      .map((r) => ({
        id: r.id,
        source: "user_fact",
        origin: "user_fact",
        kind: "fact",
        fact_key: r.fact_key,
        factKey: r.fact_key,
        fact_value: r.fact_value,
        factValue: r.fact_value,
        value: r.fact_value,
        category: r.category || "general",
        source_msg_id: r.source_msg_id ?? null,
        sourceMsgId: r.source_msg_id ?? null,
        status: r.status,
        superseded_by: r.superseded_by ?? null,
        created_at: typeof r.updated_at === "number" && Number.isFinite(r.updated_at) ? new Date(r.updated_at).toISOString() : r.updated_at ?? null,
        updated_at: r.updated_at ?? null,
      }));
    const notes = noteRows
      .filter((r) => r && typeof r.text === "string" && matchesQuery([r.text], query, tokens))
      .slice(0, lim)
      .map((r) => ({
        id: r.id,
        source: "note",
        origin: "note",
        kind: "note",
        original_source: r.source ?? null,
        text: r.text,
        created_at: r.created_at ?? null,
        source_msg_id: r.source_msg_id ?? null,
        sourceMsgId: r.source_msg_id ?? null,
      }));
    const tasks = taskRows
      .filter((r) => r && typeof r.title === "string" && matchesQuery([r.title], query, tokens))
      .slice(0, lim)
      .map((r) => ({
        id: r.id,
        source: "task",
        origin: "task",
        kind: "task",
        original_source: r.source ?? null,
        title: r.title,
        text: r.title,
        status: r.status ?? null,
        created_at: r.created_at ?? null,
        source_msg_id: r.source_message_id ?? null,
        sourceMsgId: r.source_message_id ?? null,
      }));
    return { ok: true, facts, notes, tasks };
  } catch (e) {
    return { ok: false, error: e && e.message ? String(e.message) : "db error" };
  }
}

export async function buildUserMemoryHeader(envOrDb, userId, { replyToMessageId, recentEntities } = {}) {
  try {
    const uid = Number(userId);
    if (!Number.isFinite(uid)) return "";
    const parts = [];
    const seen = new Set();
    for (const key of SETTING_KEYS) {
      try {
        const v = await getSetting(envOrDb, uid, key);
        if (typeof v === "string" && v.trim()) {
          parts.push(`${key}=${v.trim()}`);
          seen.add(key);
        }
      } catch {}
    }
    try {
      const fr = await listActiveUserFactsResult(envOrDb, uid);
      if (fr && fr.ok && Array.isArray(fr.rows)) {
        for (const r of fr.rows) {
          if (!r || r.status !== "active") continue;
          const k = typeof r.fact_key === "string" ? r.fact_key.trim() : "";
          const v = typeof r.fact_value === "string" ? r.fact_value.trim() : "";
          if (!k || !v) continue;
          const base = k.startsWith("user.") ? k.slice(5) : k;
          if (seen.has(base) || seen.has(k)) continue;
          parts.push(`${k}=${v}`);
          seen.add(k);
          seen.add(base);
        }
      }
    } catch {}
    if (replyToMessageId != null && replyToMessageId !== "") {
      try {
        const res = await getMessageRow(envOrDb, uid, replyToMessageId);
        const content = res && res.ok && res.row && typeof res.row.content === "string" ? res.row.content.trim() : "";
        if (content) parts.push(`reply_to=${content.slice(0, 80)}`);
      } catch {}
    }
    if (Array.isArray(recentEntities) && recentEntities.length) {
      const ents = recentEntities
        .map((e) => (typeof e === "string" ? e.trim() : e && typeof e === "object" ? String(e.text ?? e.name ?? e.value ?? "").trim() : ""))
        .filter(Boolean)
        .slice(0, 5);
      if (ents.length) parts.push(`entities=${ents.join(",")}`);
    }
    if (!parts.length) return "";
    return parts.join("; ").slice(0, 299);
  } catch {
    return "";
  }
}
