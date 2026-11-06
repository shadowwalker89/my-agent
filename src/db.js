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

// Positive safe-integer row id (D1 AUTOINCREMENT ids). Number or digit
// string (trimmed) -> id; anything else -> null (the caller maps it to
// a null result, never to a failure). Shared by getTask and
// addProjectAlias.
function parseRowId(v) {
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    }
  }
  return null;
}

// Alias/name normalization, identical to matchProject (interpreter.js):
// Arabic yeh/kaf folded to Persian, ZWNJ to space, then trim. Kept
// local so db.js stays dependency-free.
function normalizeAliasName(v) {
  return String(v ?? "").replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/‌/g, " ").trim();
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

// 1-d-2: parse a stored aliases JSON value into a string list; malformed -> [].
function parseAliasesJson(raw) {
  try {
    const v = JSON.parse(typeof raw === "string" ? raw : "[]");
    return Array.isArray(v) ? v.filter((a) => typeof a === "string") : [];
  } catch { return []; }
}

// 1-d-2: insert one project. Validates owner + normalized non-empty
// name; a duplicate normalized name OR alias among the user's ACTIVE
// projects returns { ok: true, created: false, duplicate: true,
// project: existing } (no insert attempted). Otherwise inserts with
// status = 'active', is_default = 0 and returns { ok: true,
// created: true, project } (the stored row). Any D1 failure, bad user,
// or empty name returns { ok: false }. The stored name is the
// normalized form, so duplicate detection and display agree.
export async function insertProject(envOrDb, userId, name, aliases = []) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  const norm = normalizeAliasName(name);
  if (!db || id === null || !norm) return { ok: false };
  const cleanAliases = (Array.isArray(aliases) ? aliases : []).map((a) => normalizeAliasName(a)).filter(Boolean);
  try {
    const res = await db
      .prepare("SELECT id, name, aliases, status, is_default FROM projects WHERE user_id = ? AND status = 'active' ORDER BY id ASC")
      .bind(id)
      .all();
    const rows = Array.isArray(res?.results) ? res.results : [];
    for (const p of rows) {
      if (normalizeAliasName(p.name) === norm || parseAliasesJson(p.aliases).some((a) => normalizeAliasName(a) === norm)) {
        return { ok: true, created: false, duplicate: true, project: p };
      }
    }
    await db
      .prepare("INSERT INTO projects (user_id, name, aliases, status, is_default, created_at) VALUES (?, ?, ?, 'active', 0, ?)")
      .bind(id, norm, JSON.stringify(cleanAliases), new Date().toISOString())
      .run();
    const row = await db.prepare("SELECT id, name, aliases, status, is_default FROM projects WHERE id = last_insert_rowid() AND user_id = ? LIMIT 1").bind(id).first();
    if (!row || typeof row !== "object") return { ok: false };
    return { ok: true, created: true, project: row };
  } catch {
    return { ok: false };
  }
}

// 1-d-3: newest-first notes with project/date paging. created_at mixes +03:30 and Z forms in live rows (1-c-3 Issue A),
// so date bounds use datetime() normalization, never raw text comparison. {ok:false} ONLY on a read failure.
export async function listNotesResult(envOrDb, userId, { projectId = null, sinceIso = null, untilIso = null, limit = 8, offset = 0 } = {}) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  if (!db || id === null) return { ok: false, notes: [] };
  const n = Math.max(1, Math.min(100, Number(limit) || 8));
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const pid = optInt(projectId);
  let sql = "SELECT id, project_id, created_at, text FROM notes WHERE user_id = ?";
  const params = [id];
  if (pid !== null) { sql += " AND project_id = ?"; params.push(pid); }
  if (sinceIso) { sql += " AND datetime(created_at) >= datetime(?)"; params.push(sinceIso); }
  if (untilIso) { sql += " AND datetime(created_at) < datetime(?)"; params.push(untilIso); }
  sql += " ORDER BY id DESC LIMIT ? OFFSET ?";
  params.push(n, off);
  try {
    const res = await db.prepare(sql).bind(...params).all();
    return { ok: true, notes: Array.isArray(res?.results) ? res.results : [] };
  } catch {
    return { ok: false, notes: [] };
  }
}

// 1-d-3: owner-scoped note delete. Invalid ids never reach SQL; a foreign/missing row deletes 0 rows.
export async function deleteNote(envOrDb, userId, noteId) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  if (!db || id === null || !(Number.isSafeInteger(noteId) && noteId > 0)) return { ok: false, deleted: false };
  try {
    const res = await db.prepare("DELETE FROM notes WHERE id = ? AND user_id = ?").bind(noteId, id).run();
    return { ok: true, deleted: (res?.meta?.changes ?? 0) > 0 };
  } catch {
    return { ok: false, deleted: false };
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
// Phase 2-g: opts.remindOnly restricts to tasks with a reminder set
// (remind_at IS NOT NULL) — the reminder-list render. Default callers
// are unaffected: the generated SQL is identical without the option.
export async function listOpenTasksResult(envOrDb, userId, projectId = null, limit = 50, offset = 0, opts = {}) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  if (!db || id === null) return { ok: false, tasks: [] };
  const n = Math.max(1, Math.min(100, Number(limit) || 50));
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  try {
    const pid = optInt(projectId);
    const where = ["user_id = ?", "status = 'open'", ...(pid === null ? [] : ["project_id = ?"]), ...(opts?.remindOnly === true ? ["remind_at IS NOT NULL"] : [])].join(" AND ");
    const params = pid === null ? [id, n, off] : [id, pid, n, off];
    const res = await db.prepare(`SELECT id, title, project_id, status, due_at, remind_at, reminded_at, remind_attempts, source, created_at, completed_at FROM tasks WHERE ${where} ORDER BY id ASC LIMIT ? OFFSET ?`).bind(...params).all();
    return { ok: true, tasks: Array.isArray(res?.results) ? res.results : [] };
  } catch {
    return { ok: false, tasks: [] };
  }
}

// Open tasks only, oldest first, optionally filtered by project. The
// done/deleted archive is never listed here. [] when DB/user missing/failing.
// Thin delegate over listOpenTasksResult; observable behaviour unchanged.
export async function listOpenTasks(envOrDb, userId, projectId = null, limit = 50, offset = 0) {
  const r = await listOpenTasksResult(envOrDb, userId, projectId, limit, offset);
  return r.tasks ?? [];
}

// Phase 1-b-0b (Fix A, amendment 7b): result-shaped done-task read.
// {ok: true} even when empty; {ok: false} ONLY on a real D1 failure.
// Done only, newest first (archive reading order; open lists stay
// oldest-first). The archive handler MUST call this core, never the
// wrapper, so a failure is never rendered as an "empty archive".
export async function listDoneTasksResult(envOrDb, userId, projectId = null, limit = 50, offset = 0) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  if (!db || id === null) return { ok: false, tasks: [] };
  const n = Math.max(1, Math.min(100, Number(limit) || 50));
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  try {
    const pid = optInt(projectId);
    const res = pid === null
      ? await db.prepare("SELECT id, title, project_id, status, due_at, remind_at, reminded_at, remind_attempts, source, created_at, completed_at FROM tasks WHERE user_id = ? AND status = 'done' ORDER BY id DESC LIMIT ? OFFSET ?").bind(id, n, off).all()
      : await db.prepare("SELECT id, title, project_id, status, due_at, remind_at, reminded_at, remind_attempts, source, created_at, completed_at FROM tasks WHERE user_id = ? AND status = 'done' AND project_id = ? ORDER BY id DESC LIMIT ? OFFSET ?").bind(id, pid, n, off).all();
    return { ok: true, tasks: Array.isArray(res?.results) ? res.results : [] };
  } catch {
    return { ok: false, tasks: [] };
  }
}

// Done tasks only, newest first. Thin delegate over the core; its []
// must NEVER be read as "empty archive" (see the core note).
export async function listDoneTasks(envOrDb, userId, projectId = null, limit = 50, offset = 0) {
  const r = await listDoneTasksResult(envOrDb, userId, projectId, limit, offset);
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

// 1-b-4: task correction is UPDATE-ONLY, user-scoped, and field
// allow-listed to {title, dueAt, remindAt}. Status is NEVER changed
// here (status changes go only through setTaskStatus), and the row is
// never deleted + recreated (its id, and any 1-c reminder claim on it,
// survive). Unknown fields or invalid values -> { ok: false }, nothing
// written. Returns { ok: true } only when the row was actually updated
// (changes === 1), so a foreign/missing task yields { ok: false }.
const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
function validIsoDt(v) { return typeof v === "string" && ISO_DT.test(v) && Number.isFinite(Date.parse(v)); }
export async function updateTaskFields(envOrDb, userId, taskId, fields) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  const tid = optInt(taskId);
  if (!db || id === null || tid === null || !fields || typeof fields !== "object") return { ok: false };
  const allowed = new Set(["title", "dueAt", "remindAt"]);
  for (const k of Object.keys(fields)) if (!allowed.has(k)) return { ok: false };
  const sets = [], params = [];
  if (Object.prototype.hasOwnProperty.call(fields, "title")) {
    const title = typeof fields.title === "string" ? fields.title.trim() : "";
    if (!title) return { ok: false };
    sets.push("title = ?"); params.push(title);
  }
  for (const [key, col] of [["dueAt", "due_at"], ["remindAt", "remind_at"]]) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      const v = fields[key];
      if (v !== null && !validIsoDt(v)) return { ok: false };
      sets.push(`${col} = ?`); params.push(v ?? null);
    }
  }
  if (sets.length === 0) return { ok: false };
  try {
    const res = await db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).bind(...params, tid, id).run();
    return res?.meta?.changes === 1 ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

// Phase 1-b-3 (amendment 6): run several prepared statements as ONE
// db.batch() unit — D1's only atomicity unit (all commit or none on a
// statement error). Follows the same safety contract as the other
// readers: a missing/failing DB, or a binding without batch(), yields
// {ok: false}, never a throw. The caller MUST still read the returned
// metas and re-read state afterwards: a conditional UPDATE matching zero
// rows is NOT a batch error, so batch success alone never proves the
// second write landed.
export async function runDbBatch(envOrDb, statements) {
  const db = dbOf(envOrDb);
  if (!db || typeof db.batch !== "function" || !Array.isArray(statements)) return { ok: false, results: [] };
  try {
    const prepared = statements.map((s) => db.prepare(s.sql).bind(...(s.params ?? [])));
    const results = await db.batch(prepared);
    return { ok: true, results: Array.isArray(results) ? results : [] };
  } catch {
    return { ok: false, results: [] };
  }
}

// Phase 1-b-0b (Fix B, amendment 3 — single approved contract):
// {ok: false, task: null} ONLY on a real D1 failure (missing DB, bad
// user id, thrown query). {ok: true, task: null} for an invalid /
// unparseable / missing / foreign-owned id (deliberately ambiguous —
// callers treat all three identically). {ok: true, task: row} for a
// task owned by the user, in ANY status (open, done, deleted), so
// callers can distinguish "open" from "already consumed".
export async function getTask(envOrDb, userId, taskId) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  if (!db || id === null) return { ok: false, task: null };
  const tid = parseRowId(taskId);
  if (tid === null) return { ok: true, task: null };
  try {
    const row = await db.prepare("SELECT id, title, project_id, status, due_at, remind_at, reminded_at, remind_attempts, source, source_message_id, created_at, completed_at FROM tasks WHERE id = ? AND user_id = ? LIMIT 1").bind(tid, id).first();
    return { ok: true, task: row && typeof row === "object" ? row : null };
  } catch {
    return { ok: false, task: null };
  }
}

// 1-d-5: user-scoped message read for quick-convert + chat retry. The id
// is validated before SQL; a foreign/missing row yields row null (the
// caller stays silent), a D1 throw yields ok false.
export async function getMessageRow(envOrDb, userId, messageId) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  if (!db || id === null) return { ok: false, row: null };
  const mid = parseRowId(messageId);
  if (mid === null) return { ok: false, row: null };
  try {
    const row = await db.prepare("SELECT id, role, content FROM messages WHERE id = ? AND user_id = ? LIMIT 1").bind(mid, id).first();
    return { ok: true, row: row && typeof row === "object" ? row : null };
  } catch {
    return { ok: false, row: null };
  }
}

// Phase 1-c-1: reminder claiming for scheduled() delivery. The claim is
// ONE atomic UPDATE ... RETURNING: the WHERE clause re-validates every
// claim predicate, so two concurrent ticks can never double-claim the
// same row — the loser updates zero rows for it. RETURNING yields exactly
// the rows THIS call claimed. Owner telegram_id is resolved by a second
// read over the claimed user_ids only (SQLite RETURNING cannot reference
// joined tables); claimed rows are guaranteed a non-null telegram_id by
// the EXISTS clause, and if the mapping read itself fails the claims are
// released again and {ok: false} is returned, so a failure never burns
// an attempt silently. {ok: false} ONLY on a real D1 failure.
// Phase 1-c-3: remind_at is compared through datetime() normalization,
// NOT as raw text: parseReminder stores Tehran offset strings (+03:30)
// while runReminderTick binds a UTC Z string, and raw text comparison
// delayed every fresh reminder by exactly 3.5 hours (live QA). datetime()
// compares true UTC instants across both forms, so no data migration is
// needed for the already-stored +03:30 rows; rows datetime() cannot
// parse are excluded from claiming rather than mis-claimed.
export async function claimDueReminders(envOrDb, nowIso, limit = 20) {
  const db = dbOf(envOrDb);
  if (!db || typeof nowIso !== "string" || !Number.isFinite(Date.parse(nowIso))) return { ok: false, reminders: [] };
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  try {
    const res = await db.prepare("UPDATE tasks SET reminded_at = ?, remind_attempts = remind_attempts + 1 WHERE id IN (SELECT t.id FROM tasks t WHERE t.status = 'open' AND t.remind_at IS NOT NULL AND datetime(t.remind_at) IS NOT NULL AND datetime(t.remind_at) <= datetime(?) AND t.reminded_at IS NULL AND t.remind_attempts < 3 AND EXISTS (SELECT 1 FROM users u WHERE u.id = t.user_id AND u.telegram_id IS NOT NULL) ORDER BY datetime(t.remind_at) ASC, t.id ASC LIMIT ?) RETURNING id, user_id, title, remind_at, remind_attempts").bind(nowIso, nowIso, n).all();
    const rows = Array.isArray(res?.results) ? res.results : [];
    if (rows.length === 0) return { ok: true, reminders: [] };
    let owners;
    try {
      const ores = await db.prepare(`SELECT id, telegram_id FROM users WHERE id IN (${[...new Set(rows.map((r) => r.user_id))].map(() => "?").join(",")})`).bind(...[...new Set(rows.map((r) => r.user_id))]).all();
      owners = new Map((Array.isArray(ores?.results) ? ores.results : []).map((u) => [u.id, u.telegram_id]));
    } catch {
      await db.prepare(`UPDATE tasks SET reminded_at = NULL WHERE id IN (${rows.map(() => "?").join(",")}) AND status = 'open'`).bind(...rows.map((r) => r.id)).run().catch(() => {});
      return { ok: false, reminders: [] };
    }
    return { ok: true, reminders: rows.filter((r) => owners.get(r.user_id) != null).map((r) => ({ id: r.id, user_id: r.user_id, telegram_id: owners.get(r.user_id), title: r.title, remind_at: r.remind_at, remind_attempts: r.remind_attempts })) };
  } catch {
    return { ok: false, reminders: [] };
  }
}

// Phase 1-c-1: delivery-failure recovery. Clears reminded_at on open
// tasks only, preserving the incremented remind_attempts, so a failed
// send retries up to 3 total attempts and stops once attempts >= 3.
// {ok: true} when the statement ran — a 0-change result (already
// done/deleted, nothing left claimed) is still a success; {ok: false}
// ONLY on a real D1 failure (missing DB, bad id, thrown query).
export async function releaseReminderClaim(envOrDb, taskId) {
  const db = dbOf(envOrDb);
  const tid = parseRowId(taskId);
  if (!db || tid === null) return { ok: false };
  try {
    await db.prepare("UPDATE tasks SET reminded_at = NULL WHERE id = ? AND status = 'open'").bind(tid).run();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// Phase 1-c-1: snooze is an atomic owner-scoped UPDATE on open tasks
// only: new remind_at, reminded_at cleared, attempts reset to 0 (a fresh
// 3-attempt budget for the new time). {ok: false} ONLY on a real D1
// failure (missing DB, bad ids, invalid ISO, thrown query); {ok: true,
// updated: false} when the row is foreign/missing/non-open.
export async function snoozeTaskReminder(envOrDb, userId, taskId, newRemindAtIso) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  const tid = parseRowId(taskId);
  if (!db || id === null || tid === null || !validIsoDt(newRemindAtIso)) return { ok: false, updated: false };
  try {
    const res = await db.prepare("UPDATE tasks SET remind_at = ?, reminded_at = NULL, remind_attempts = 0 WHERE id = ? AND user_id = ? AND status = 'open'").bind(newRemindAtIso, tid, id).run();
    return { ok: true, updated: res?.meta?.changes === 1 };
  } catch {
    return { ok: false, updated: false };
  }
}

// Phase 1-c-1: 30-day purge of closed tasks only. A done/deleted task
// counts as old by completed_at, falling back to created_at when
// completed_at is null (legacy rows). Open tasks are never touched.
// Phase 1-c-3: the cutoff comparison also runs through datetime(), so an
// offset-stored timestamp is compared as a true instant, not as text
// (for the Z-form timestamps already in practice this is identity).
// {ok: false, deleted: 0} ONLY on a real D1 failure.
export async function purgeOldClosedTasks(envOrDb, cutoffIso) {
  const db = dbOf(envOrDb);
  if (!db || typeof cutoffIso !== "string" || !Number.isFinite(Date.parse(cutoffIso))) return { ok: false, deleted: 0 };
  try {
    const res = await db.prepare("DELETE FROM tasks WHERE status IN ('done', 'deleted') AND datetime(COALESCE(completed_at, created_at)) < datetime(?)").bind(cutoffIso).run();
    return { ok: true, deleted: res?.meta?.changes ?? 0 };
  } catch {
    return { ok: false, deleted: 0 };
  }
}

// Conditional-UPDATE fallback for addProjectAlias, used ONLY when the
// JSON form is unavailable in the binding (error "no such function").
// 3 attempts total, each re-reading the current value first. A
// malformed stored value is an honest {ok: false} — the corrupt value
// is NEVER overwritten with a fresh array.
async function addProjectAliasConditional(db, uid, pid, name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let stored;
    try {
      const row = await db.prepare("SELECT aliases FROM projects WHERE id = ? AND user_id = ? LIMIT 1").bind(pid, uid).first();
      stored = row?.aliases ?? null;
    } catch { return { ok: false }; }
    if (stored !== null && typeof stored !== "string") return { ok: false };
    const text = stored === null ? "[]" : stored;
    let list;
    try {
      list = JSON.parse(text);
    } catch { return { ok: false }; }
    if (!Array.isArray(list)) return { ok: false };
    if (list.some((a) => normalizeAliasName(a) === name)) return { ok: true, added: false };
    try {
      const res = await db.prepare("UPDATE projects SET aliases = ? WHERE id = ? AND user_id = ? AND COALESCE(aliases, '[]') = ?").bind(JSON.stringify([...list, name]), pid, uid, text).run();
      if (res?.meta?.changes === 1) return { ok: true, added: true };
      // changes 0 -> another writer won the race; retry with a fresh read.
    } catch { return { ok: false }; }
  }
  return { ok: false };
}

// Phase 1-b-0b (amendment 2): lost-update-proof alias append. The
// alias is normalised exactly as matchProject normalises. ONE atomic
// UPDATE appends with in-database dedupe (json_insert guarded by
// NOT EXISTS over json_each), scoped by id AND user_id, so two
// concurrent appends of different aliases both survive and two of
// the same alias yield one entry. Ownership is established by a
// user-scoped pre-read (project names never change in 1-b, so the
// pre-read cannot race the array). Alias == name -> no-op success.
// changes 1 -> added; changes 0 after an owned pre-read -> already
// present. Foreign/missing project or empty alias -> {ok: false}.
// Malformed stored JSON -> the UPDATE errors -> {ok: false}; the
// corrupt value is never overwritten.
export async function addProjectAlias(envOrDb, userId, projectId, alias) {
  const db = dbOf(envOrDb);
  const uid = validUserId(userId);
  const pid = parseRowId(projectId);
  const name = normalizeAliasName(alias);
  if (!db || uid === null || pid === null || !name) return { ok: false };
  let project;
  try {
    project = await db.prepare("SELECT id, name FROM projects WHERE id = ? AND user_id = ? LIMIT 1").bind(pid, uid).first();
  } catch { return { ok: false }; }
  if (!project || typeof project !== "object") return { ok: false };
  if (normalizeAliasName(project.name) === name) return { ok: true, added: false };
  try {
    const res = await db.prepare("UPDATE projects SET aliases = json_insert(COALESCE(aliases, '[]'), '$[#]', ?) WHERE id = ? AND user_id = ? AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(aliases, '[]')) WHERE value = ?)").bind(name, pid, uid, name).run();
    if (res?.meta?.changes === 1) return { ok: true, added: true };
    if (res?.meta?.changes === 0) return { ok: true, added: false };
    return { ok: false };
  } catch (e) {
    if (!/no such function/i.test(e?.message ?? "")) return { ok: false };
    return addProjectAliasConditional(db, uid, pid, name);
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

// Phase 3-A: encrypted vault items. The table is created lazily (like
// the router circuit tables) so no migration is required; value_enc is
// AES-GCM ciphertext and is never selected by the list helper.
const vaultReadyDbs = new WeakSet();
const VAULT_KINDS = ["text", "file"];

async function ensureVaultTable(db) {
  if (!db) return false;
  if (vaultReadyDbs.has(db)) return true;
  try {
    await db
      .prepare(
        "CREATE TABLE IF NOT EXISTS vault_items (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL, value_enc TEXT, file_name TEXT, file_mime TEXT, google_id TEXT, sync_status TEXT NOT NULL DEFAULT 'local', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
      )
      .bind()
      .run();
    vaultReadyDbs.add(db);
    return true;
  } catch {
    return false;
  }
}

export async function saveVaultItem(envOrDb, item) {
  const db = dbOf(envOrDb);
  const userId = validUserId(item?.userId);
  const label = typeof item?.label === "string" ? item.label.trim() : "";
  const kind = VAULT_KINDS.includes(item?.kind) ? item.kind : "text";
  if (!db || userId === null || !label) return { ok: false };
  if (kind === "text" && typeof item?.valueEnc !== "string") return { ok: false };
  if (kind === "file" && typeof item?.fileName !== "string") return { ok: false };
  if (!(await ensureVaultTable(db))) return { ok: false };
  const now = typeof item?.createdAt === "string" && item.createdAt ? item.createdAt : new Date().toISOString();
  const syncStatus = typeof item?.syncStatus === "string" && item.syncStatus ? item.syncStatus : "local";
  const id = Number(item?.id);
  try {
    if (Number.isInteger(id) && id > 0) {
      await db
        .prepare(
          "UPDATE vault_items SET label = ?, kind = ?, value_enc = ?, file_name = ?, file_mime = ?, google_id = ?, sync_status = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        )
        .bind(label, kind, item?.valueEnc ?? null, item?.fileName ?? null, item?.mimeType ?? null, item?.googleId ?? null, syncStatus, now, id, userId)
        .run();
      return { ok: true, id };
    }
    await db
      .prepare(
        "INSERT INTO vault_items (user_id, label, kind, value_enc, file_name, file_mime, google_id, sync_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(userId, label, kind, item?.valueEnc ?? null, item?.fileName ?? null, item?.mimeType ?? null, item?.googleId ?? null, syncStatus, now, now)
      .run();
    const row = await db.prepare("SELECT last_insert_rowid() AS id").bind().first();
    return { ok: true, id: row?.id ?? null };
  } catch {
    return { ok: false };
  }
}

export async function listVaultItems(envOrDb, userId, { limit = 20, offset = 0 } = {}) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  if (!db || id === null) return { ok: false, items: [] };
  if (!(await ensureVaultTable(db))) return { ok: false, items: [] };
  const n = Math.max(1, Math.min(50, Number(limit) || 20));
  const off = Math.max(0, Number(offset) || 0);
  try {
    const res = await db
      .prepare(
        "SELECT id, label, kind, file_name, file_mime, google_id, sync_status, created_at, updated_at FROM vault_items WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
      )
      .bind(id, n, off)
      .all();
    return { ok: true, items: Array.isArray(res?.results) ? res.results : [] };
  } catch {
    return { ok: false, items: [] };
  }
}

export async function getVaultItem(envOrDb, userId, itemId) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  const vaultId = Number(itemId);
  if (!db || id === null || !Number.isInteger(vaultId) || vaultId <= 0) return null;
  if (!(await ensureVaultTable(db))) return null;
  try {
    return await db.prepare("SELECT * FROM vault_items WHERE id = ? AND user_id = ? LIMIT 1").bind(vaultId, id).first();
  } catch {
    return null;
  }
}

export async function deleteVaultItem(envOrDb, userId, itemId) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  const vaultId = Number(itemId);
  if (!db || id === null || !Number.isInteger(vaultId) || vaultId <= 0) return { ok: false, deleted: false };
  if (!(await ensureVaultTable(db))) return { ok: false, deleted: false };
  try {
    const res = await db.prepare("DELETE FROM vault_items WHERE id = ? AND user_id = ?").bind(vaultId, id).run();
    return { ok: true, deleted: (res?.meta?.changes ?? 0) > 0 };
  } catch {
    return { ok: false, deleted: false };
  }
}

export async function setVaultSyncStatus(envOrDb, userId, itemId, status, googleId = null) {
  const db = dbOf(envOrDb);
  const id = validUserId(userId);
  const vaultId = Number(itemId);
  const syncStatus = typeof status === "string" && status ? status : "local";
  if (!db || id === null || !Number.isInteger(vaultId) || vaultId <= 0) return { ok: false };
  if (!(await ensureVaultTable(db))) return { ok: false };
  try {
    await db
      .prepare("UPDATE vault_items SET sync_status = ?, google_id = COALESCE(?, google_id), updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(syncStatus, googleId, new Date().toISOString(), vaultId, id)
      .run();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
