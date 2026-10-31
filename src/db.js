// D1 access layer (Step 1a foundation only).
// No everyday intent, extraction, or Telegram logic lives here.
// Every function is safe when env.DB is missing or a query fails:
// it returns an empty/false result instead of throwing, so the caller
// can fall back to the plain chat path. Nothing here logs message
// content, keys, or secrets — functions return only ok/rows/values.
export function normalizeKind(kind) {
  return kind === "daily" || kind === "pending" ? kind : "chat";
}

function dbOf(envOrDb) {
  if (envOrDb && typeof envOrDb.prepare === "function") return envOrDb;
  const db = envOrDb && envOrDb.DB;
  return db && typeof db.prepare === "function" ? db : null;
}

function validUserId(userId) {
  const n = Number(userId);
  return Number.isFinite(n) ? n : null;
}

// Save one message row. kind defaults to "chat" (see normalizeKind).
// createdAt is ISO (Gregorian) by construction; callers may pass a fixed
// value only for tests. Returns { ok: true } or { ok: false }.
export async function saveMessage(envOrDb, msg) {
  const db = dbOf(envOrDb);
  const userId = validUserId(msg?.userId);
  const content = typeof msg?.content === "string" ? msg.content : "";
  if (!db || userId === null || !content) return { ok: false };
  try {
    await db
      .prepare(
        "INSERT INTO messages (user_id, role, content, model, created_at, kind, tg_file_id, file_name, file_mime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        userId,
        typeof msg.role === "string" && msg.role ? msg.role : "user",
        content,
        typeof msg.model === "string" ? msg.model : null,
        typeof msg.createdAt === "string" && msg.createdAt ? msg.createdAt : new Date().toISOString(),
        normalizeKind(msg.kind),
        typeof msg.tgFileId === "string" ? msg.tgFileId : null,
        typeof msg.fileName === "string" ? msg.fileName : null,
        typeof msg.fileMime === "string" ? msg.fileMime : null,
      )
      .run();
    const row = await db.prepare("SELECT last_insert_rowid() AS id").bind().first();
    return { ok: true, id: row?.id ?? null };
  } catch {
    return { ok: false };
  }
}

// Finalise a store-first row: pending -> chat|daily, scoped by user id. A
// row left pending (Worker died mid-interpretation) is ignored by every
// reader (chat context reads kind='chat' in SQL; queries read their own
// tables) and is never resurrected by a later message.
export async function finalizeMessageKind(envOrDb, id, userId, kind) {
  const db = dbOf(envOrDb);
  if (!db || !Number.isFinite(Number(id)) || validUserId(userId) === null || (kind !== "chat" && kind !== "daily")) return { ok: false };
  try { await db.prepare("UPDATE messages SET kind = ? WHERE id = ? AND user_id = ?").bind(kind, Number(id), Number(userId)).run(); return { ok: true }; } catch { return { ok: false }; }
}

// Chat context only: kind = 'chat', newest-first from D1, returned oldest-first.
// Daily messages are excluded by the SQL itself, never by post-filtering.
// Returns [] when the DB is missing or the query fails.
export async function getChatMessages(envOrDb, userId, limit = 50) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  if (!db || id === null) return [];
  const n = Math.max(1, Math.min(50, Number(limit) || 50));
  try {
    const res = await db
      .prepare(
        "SELECT role, content FROM messages WHERE user_id = ? AND kind = 'chat' ORDER BY id DESC LIMIT ?",
      )
      .bind(id, n)
      .all();
    const rows = Array.isArray(res?.results) ? res.results : [];
    return rows.reverse();
  } catch {
    return [];
  }
}

// Latest message carrying a Telegram file id, for 1b file reference.
// The files table is untouched in Step 1; only messages.tg_file_id is read.
export async function getLatestFileMessage(envOrDb, userId) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  if (!db || id === null) return null;
  try {
    const row = await db
      .prepare(
        "SELECT tg_file_id, file_name, file_mime, created_at FROM messages WHERE user_id = ? AND tg_file_id IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .bind(id)
      .first();
    return row && typeof row === "object" ? row : null;
  } catch {
    return null;
  }
}

// Durable memory facts (memories table). No automatic writer: only
// explicit calls (1b "remember" intent) write here.
export async function getMemory(envOrDb, userId, kind, key) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  if (!db || id === null || !kind || !key) return null;
  try {
    const row = await db
      .prepare("SELECT value FROM memories WHERE user_id = ? AND kind = ? AND key = ? LIMIT 1")
      .bind(id, kind, key)
      .first();
    return typeof row?.value === "string" ? row.value : null;
  } catch {
    return null;
  }
}

export async function setMemory(envOrDb, userId, kind, key, value) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  if (!db || id === null || !kind || !key || typeof value !== "string" || !value) return { ok: false };
  try {
    await db
      .prepare(
        "INSERT INTO memories (user_id, kind, key, value, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, kind, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .bind(id, kind, key, value, new Date().toISOString())
      .run();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
