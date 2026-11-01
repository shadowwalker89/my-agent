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

// Phase 1-a: projects + tasks + intent_feedback. Functions only — no
// wiring into everyday handling, the interpreter policy, or SEED_PROJECTS
// (those are 1-b). Never auto-creates a project: seed rows come from
// migration 0003 only. Same safety contract as above: missing/failing DB
// yields empty/false results, never a throw, and nothing logs content.
const TASK_STATUSES = ["open", "done", "deleted"];
function validTaskStatus(s) {
  return TASK_STATUSES.includes(s) ? s : null;
}
function optText(v) {
  return typeof v === "string" && v ? v : null;
}
function optInt(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// insertTask only. Contract: omitted/null -> null (no project); a
// positive safe integer (number, or a digit string, whitespace trimmed)
// -> that id; anything else supplied -> false, i.e. rejected, never
// silently null. Positive + safe matters: project ids come from D1
// AUTOINCREMENT, so 0, negatives, and integers beyond
// Number.MAX_SAFE_INTEGER (e.g. 9007199254740992) are never valid ids,
// and Number.isInteger alone would accept the unsafe ones. This
// deliberately differs from optInt, which coerces garbage to null.
function parseProjectId(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? v : false;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      return Number.isSafeInteger(n) && n > 0 ? n : false;
    }
  }
  return false;
}

// Phase 1-b-0a (Fix A): result-shaped project read. {ok: true} even
// when the list is empty; {ok: false} ONLY on a real D1 failure
// (missing DB, bad user id, thrown query) — never for "no projects".
// Full rows are returned (id, name, aliases, status, is_default);
// no projection in the chain may drop is_default (amendment 7c).
export async function listProjectsResult(envOrDb, userId) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  if (!db || id === null) return { ok: false, projects: [] };
  try {
    const res = await db
      .prepare("SELECT id, name, aliases, status, is_default FROM projects WHERE user_id = ? AND status = 'active' ORDER BY id ASC")
      .bind(id)
      .all();
    return { ok: true, projects: Array.isArray(res?.results) ? res.results : [] };
  } catch {
    return { ok: false, projects: [] };
  }
}

// Active projects for a user, oldest first. [] when DB/user missing/failing.
// Thin delegate over listProjectsResult; observable behaviour unchanged.
export async function listProjects(envOrDb, userId) {
  const r = await listProjectsResult(envOrDb, userId);
  return r.projects ?? [];
}

// One project by id, scoped by user. Null when missing/failing.
export async function getProject(envOrDb, userId, projectId) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  const pid = optInt(projectId);
  if (!db || id === null || pid === null) return null;
  try {
    const row = await db
      .prepare("SELECT id, name, aliases, status, is_default FROM projects WHERE user_id = ? AND id = ? LIMIT 1")
      .bind(id, pid)
      .first();
    return row && typeof row === "object" ? row : null;
  } catch {
    return null;
  }
}

// Insert one task. Omitted status defaults to 'open'; a provided but
// invalid status is rejected, never silently coerced (a silent 'open'
// would hide wiring bugs in 1-b). Likewise, an omitted/null project_id
// means no project and is accepted, but an explicitly supplied
// project_id that is not a valid integer is rejected, never silently
// turned into a null project; a valid integer must belong to the same
// user (same ownership check getProject already applies). User existence
// itself is NOT checked here — the caller allow-lists. Returns
// { ok: true, id } or { ok: false }.
export async function insertTask(envOrDb, task) {
  const db = dbOf(envOrDb);
  const id = validUserId(task?.userId);
  const title = typeof task?.title === "string" ? task.title.trim() : "";
  if (!db || id === null || !title) return { ok: false };
  const status = task?.status === undefined || task?.status === null ? "open" : validTaskStatus(task.status);
  if (status === null) return { ok: false };
  const pid = parseProjectId(task?.projectId);
  if (pid === false) return { ok: false };
  try {
    if (pid !== null) {
      const owner = await db.prepare("SELECT id FROM projects WHERE id = ? AND user_id = ? LIMIT 1").bind(pid, id).first();
      if (!owner) return { ok: false };
    }
    await db
      .prepare("INSERT INTO tasks (user_id, title, project_id, status, due_at, remind_at, source, source_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(
        id,
        title,
        pid,
        status,
        optText(task.dueAt),
        optText(task.remindAt),
        task.source === "voice" ? "voice" : "text",
        optInt(task.sourceMessageId),
        typeof task.createdAt === "string" && task.createdAt ? task.createdAt : new Date().toISOString(),
      )
      .run();
    const row = await db.prepare("SELECT last_insert_rowid() AS id").bind().first();
    return { ok: true, id: row?.id ?? null };
  } catch {
    return { ok: false };
  }
}

// Phase 1-b-0a (Fix A): result-shaped open-task read, same ok rule as
// listProjectsResult. The offset parameter lands with the core here;
// listOpenTasks gains it in 1-b-0b, so this slice's delegate passes 0.
export async function listOpenTasksResult(envOrDb, userId, projectId = null, limit = 50, offset = 0) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  if (!db || id === null) return { ok: false, tasks: [] };
  const n = Math.max(1, Math.min(100, Number(limit) || 50));
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  try {
    const pid = optInt(projectId);
    const res = pid === null
      ? await db.prepare("SELECT id, title, project_id, status, due_at, remind_at, reminded_at, remind_attempts, source, created_at, completed_at FROM tasks WHERE user_id = ? AND status = 'open' ORDER BY id ASC LIMIT ? OFFSET ?").bind(id, n, off).all()
      : await db.prepare("SELECT id, title, project_id, status, due_at, remind_at, reminded_at, remind_attempts, source, created_at, completed_at FROM tasks WHERE user_id = ? AND status = 'open' AND project_id = ? ORDER BY id ASC LIMIT ? OFFSET ?").bind(id, pid, n, off).all();
    return { ok: true, tasks: Array.isArray(res?.results) ? res.results : [] };
  } catch {
    return { ok: false, tasks: [] };
  }
}

// Open tasks only, oldest first, optionally filtered by project. The
// done/deleted archive is never listed here. [] when DB/user missing/failing.
// Thin delegate over listOpenTasksResult; observable behaviour unchanged.
export async function listOpenTasks(envOrDb, userId, projectId = null, limit = 50) {
  const r = await listOpenTasksResult(envOrDb, userId, projectId, limit, 0);
  return r.tasks ?? [];
}

// Change one task's status, only from 'open'. 'done' sets completed_at
// (the archive view); 'deleted' leaves completed_at untouched. Any other
// transition, unknown task, or wrong owner yields { ok: false }. The
// transition is a single atomic UPDATE with status = 'open' in the
// WHERE clause, decided by the affected-changes count, so the DB itself
// guarantees at most one transition out of 'open' succeeds even under
// concurrent Worker invocations (no SELECT-then-UPDATE race).
export async function setTaskStatus(envOrDb, userId, taskId, status) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  const tid = optInt(taskId);
  const next = validTaskStatus(status);
  if (!db || id === null || tid === null || next === null) return { ok: false };
  try {
    const res = next === "done"
      ? await db.prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ? AND user_id = ? AND status = 'open'").bind(new Date().toISOString(), tid, id).run()
      : await db.prepare("UPDATE tasks SET status = ? WHERE id = ? AND user_id = ? AND status = 'open'").bind(next, tid, id).run();
    return res?.meta?.changes === 1 ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

// Record one type correction for later tuning. Content stays in D1 only,
// never in logs. Returns { ok: true } or { ok: false }.
export async function insertIntentFeedback(envOrDb, fb) {
  const db = dbOf(envOrDb);
  const id = validUserId(fb?.userId);
  const text = typeof fb?.text === "string" ? fb.text : "";
  if (!db || id === null || !text || typeof fb.predictedType !== "string" || typeof fb.correctType !== "string") return { ok: false };
  try {
    await db
      .prepare("INSERT INTO intent_feedback (user_id, text, predicted_type, correct_type, project, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, text, fb.predictedType, fb.correctType, optText(fb.project), typeof fb.createdAt === "string" && fb.createdAt ? fb.createdAt : new Date().toISOString())
      .run();
    return { ok: true };
  } catch {
    return { ok: false };
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
