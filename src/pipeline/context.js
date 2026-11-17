// Chat context and shared D1/KV helpers, extracted from src/everyday.js (R0.8a).
// Pipeline rank 3; D1 access goes through this module. No channel imports.
import { saveMessage, finalizeMessageKind, getMessageRow, insertTask } from "../db.js";
import { defaultProjectId } from "../domain/tasks/projects.js";
import { IRAN_OFFSET_MIN } from "../daily.js";
import { looksSecret } from "./secret-shape.js";

export const CHAT_CONTEXT_CHAR_LIMIT = 8000;
const DRAFT_TTL_SEC = 600;
export const EXPIRED_TEXT = "قبلاً ثبت شد یا مهلتش گذشته";
export const NOT_SAVED_TEXT = "ذخیره نشد، دوباره تلاش کن";
export const UNSUPPORTED_ACTION_TEXT = "در حال حاضر ابزار اتصال و ارسال مستقیم ایمیل فعال نیست؛ چیزی ارسال نشد. اگر بخواهی می‌توانم متنش را به‌عنوان یادداشت یا کار ذخیره کنم.";
export const iranIso = (ms) => new Date((ms ?? Date.now()) + IRAN_OFFSET_MIN * 60000).toISOString().replace(/Z$/, "+03:30");

// Chat context: last 50 rows plus the 8,000-char cap, oldest dropped first.
// Phase 1-e Pillar 3: anti-hallucination filter — historical assistant
// turns that START with a fake confirmation header are skipped, so a
// hallucinated "stored" message can never be quoted back as fact by a
// later chat turn (the live 2026-11-03 case: an old fake ✅ note header
// was repeated to the user as if it had been stored).
// A04: `excludeMessageId` drops the in-flight user row (already appended by
// the caller) so it is sent to the model exactly once. An oversized single
// turn is truncated instead of clearing all older history.
export function buildChatContext(rows, opts = {}) {
  const headerRaw = typeof opts === "string" ? opts : opts && typeof opts === "object" ? (opts.memoryHeader ?? opts.userMemoryHeader ?? opts.header ?? opts.memory ?? null) : null;
  const memoryHeader = typeof headerRaw === "string" && headerRaw.trim() ? headerRaw.trim() : "";
  const replyRaw = opts && typeof opts === "object" && typeof opts.replyToText === "string" ? opts.replyToText.trim().slice(0, 1200) : "";
  const replyToText = replyRaw && !looksSecret(replyRaw) ? replyRaw : "";
  const excludeId = opts && opts.excludeMessageId != null ? Number(opts.excludeMessageId) : null;
  const msgs = (rows || []).filter((r) => r && typeof r.content === "string" && r.content && (excludeId === null || Number(r.id) !== excludeId)).slice(-50);
  const kept = []; let total = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant" && (/^✅\s*\*\*یادداشت جدید/.test(msgs[i].content) || /^✅\s*(?:یادداشت|تسک|هزینه)/.test(msgs[i].content) || /^⏰\s*یادآوری/.test(msgs[i].content))) continue;
    const remaining = CHAT_CONTEXT_CHAR_LIMIT - total;
    if (remaining <= 0) break;
    let content = msgs[i].content;
    if (content.length > remaining) {
      const cap = Math.min(2000, remaining);
      if (cap <= 3) break;
      content = content.slice(0, cap - 3) + "...";
    }
    kept.push({ role: msgs[i].role === "assistant" ? "assistant" : "user", content }); total += content.length;
  }
  const result = kept.reverse();
  if (replyToText) result.unshift({ role: "system", content: `[در پاسخ به پیام قبلی: «${replyToText}»]` });
  if (memoryHeader) result.unshift({ role: "system", content: memoryHeader });
  return result;
}

export function dbOf(env) { const db = env && env.DB; return db && typeof db.prepare === "function" ? db : null; }
export async function runDb(env, sql, params) { const db = dbOf(env); if (!db) return { ok: false }; try { await db.prepare(sql).bind(...params).run(); return { ok: true }; } catch { return { ok: false }; } }
export async function allDb(env, sql, params) { const db = dbOf(env); if (!db) return []; try { const res = await db.prepare(sql).bind(...params).all(); return Array.isArray(res?.results) ? res.results : []; } catch { return []; } }
// Single-row read that distinguishes "no row" from "query failed".
export async function firstDb(env, sql, params) { const db = dbOf(env); if (!db) return { ok: false, row: null }; try { const res = await db.prepare(sql).bind(...params).first(); return { ok: true, row: res ?? null }; } catch { return { ok: false, row: null }; } }

export async function recentMessages(env, userId, limit = 10) { return allDb(env, "SELECT role, content, kind, tg_file_id, file_name, file_mime FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?", [userId, limit]); }

// User row: allow-list FIRST (callers guarantee it), then INSERT OR IGNORE.
export async function ensureUserRow(env, userId) { const id = Number(userId); if (!Number.isFinite(id)) return { ok: false }; return runDb(env, "INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)", [id, String(id)]); }

// Keys carry only the short id; owner is checked after load (forbidden = silent, not expired).
export function draftKey(id) { return `daily:draft:${id}`; }
export function askKey(id) { return `daily:ask:${id}`; }
// Pending-ask slot (Part 3): ONE slot per user, 600s TTL like money drafts.
// {question, askId?, kind?, pendingBody?}: question is always the bot's own
// ask text; askId points at the existing daily:ask record. Part 3b adds kind
// (a stable identifier like "note-text", never a Persian-text comparison) and
// pendingBody (a body already known while a language ask is pending).
export function pendingKey(id) { return `daily:pending-ask:${id}`; }
// Correction pointer (0-b3): last created item, 10-minute TTL via putKv.
// {table: "notes"|"expenses", id}: only tables that exist pre-0003.
export function correctionKey(id) { return `interp:last-item:${id}`; }
// 1-d-1: 1-tap quick-convert buttons for chat replies. The callback
// handlers (qconv:note:<msgId> / qconv:task:<msgId>) land in 1-d-5;
// messageId is the saved user message row id (o.entryMessageId), never
// user text, so the tap saves exactly that stored message.
export function quickConvertKeyboard(messageId) {
  return [[{ text: "📝 ذخیره یادداشت", callback_data: `qconv:note:${messageId}` }, { text: "☑️ ثبت تسک", callback_data: `qconv:task:${messageId}` }]];
}
// 1-d-5: pure stage failure notice. label names the failed stage
// ("chat" or "summary stage"); detail carries the model error when known.
// retryEntryId -> a chat:retry button; retryData -> a raw callback_data
// retry (the sum re-tap); quickConvertId -> the quick-convert row. No ids
// -> text only, so a notice is never dropped silently for lack of buttons.
export function chatFailureNotice(label, detail, opts = {}) {
  const text = `❌ مرحله‌ی ${label} شکست خورد.${detail ? `\n${detail}` : ""}`;
  const keyboard = [];
  if (opts.retryEntryId) keyboard.push([{ text: "🔄 تلاش دوباره", callback_data: `chat:retry:${opts.retryEntryId}` }]);
  if (opts.retryData) keyboard.push([{ text: "🔄 تلاش دوباره", callback_data: opts.retryData }]);
  if (opts.quickConvertId) keyboard.push(...quickConvertKeyboard(opts.quickConvertId));
  return { text, replyMarkup: keyboard.length ? { inline_keyboard: keyboard } : undefined };
}
// Phase 2-d: compact failure detail for the chat path (answerChatText).
// Line 1 of the notice itself stays the stage line (chatFailureNotice
// adds it); this detail is: a Persian count line, at most the first 3
// target: status lines, and a (+N مورد دیگر) overflow line. A 7-target
// failure therefore never dumps a wall of raw model:status lines.
export function formatFailureDetail(lines) {
  const arr = (lines ?? []).filter((l) => String(l ?? "").trim() !== "");
  if (!arr.length) return "";
  const parts = [`تعداد مدل‌های بررسی‌شده: ${arr.length}`, ...arr.slice(0, 3)];
  if (arr.length > 3) parts.push(`(+${arr.length - 3} مورد دیگر)`);
  return parts.join("\n");
}

export function newId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
export async function putKv(env, key, value) { if (!env.STATE) return; try { await env.STATE.put(key, JSON.stringify(value), { expirationTtl: DRAFT_TTL_SEC }); } catch {} }
export async function getKv(env, key) { if (!env.STATE) return null; try { const raw = await env.STATE.get(key, "json"); return raw && typeof raw === "object" ? raw : null; } catch { return null; } }
export async function delKv(env, key) { if (!env.STATE) return; try { await env.STATE.delete(key); } catch {} }

// Save-first reconciliation (Phase 0-b fix): when handleDailyText saved an
// entry row for this message, everyday branches finalise it instead of
// saving a second user row; without an entry row (D1 unavailable, commands)
// they save exactly as before. _entryFinalised keeps every exit to one
// finalise; markChat finalises only when an entry row exists (chat answers
// otherwise save their user row through answerChatText as before).
export async function markDaily(env, o) {
  if (o.entryMessageId) { if (!o._entryFinalised) { o._entryFinalised = true; await finalizeMessageKind(env, o.entryMessageId, o.userId, "daily"); } return; }
  await saveMessage(env, { userId: o.userId, role: "user", content: looksSecret(o.text) ? "[🔒 محتوای حساس گاوصندوق]" : o.text, kind: "daily" });
}
export async function markChat(env, o) {
  if (o.entryMessageId && !o._entryFinalised) { o._entryFinalised = true; await finalizeMessageKind(env, o.entryMessageId, o.userId, "chat"); }
}

// 1-d-5: 1-tap quick convert (qconv:note:<msgId> / qconv:task:<msgId>).
// The tap carries only the message id; the row is re-read user-scoped
// and must be a non-empty USER row — foreign/missing/assistant/empty
// taps stay silent (no data leak). A note lands in the D1 default
// project when one exists (same rule as the note branch); a task does
// the same (the spec's "default/resolved project"). D1 failure ->
// standard not-saved text, buttons kept so the user can retry; success
// -> buttons removed, then the spec-exact confirmation. Normal double-
// tap is prevented by markup removal; a replayed/forged tap could
// duplicate (no conversion record exists, and adding one would need a
// migration, which is forbidden) — the realistic exposure is nil
// (Telegram dedupes callback deliveries; the allow-list gate ran first).
export async function resolveQuickConvertCallback(env, o) {
  const m = /^qconv:(note|task):(\d+)$/.exec(o.data);
  if (!m) return false;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return true; // invalid: silent
  const g = await getMessageRow(env, o.fromId, id);
  if (!g.ok) { await o.send(NOT_SAVED_TEXT); return true; } // D1 failure: buttons kept
  if (!g.row || g.row.role !== "user" || !(g.row.content ?? "").trim()) return true; // foreign/missing/assistant/empty: silent
  const pid = await defaultProjectId(env, o.fromId);
  if (m[1] === "note") {
    const r = pid == null ? await runDb(env, "INSERT INTO notes (user_id, text, source, created_at) VALUES (?, ?, 'text', ?)", [o.fromId, g.row.content, new Date(o.nowMs ?? Date.now()).toISOString()]) : await runDb(env, "INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (?, ?, 'text', ?, ?)", [o.fromId, g.row.content, new Date(o.nowMs ?? Date.now()).toISOString(), pid]);
    if (!r.ok) { await o.send(NOT_SAVED_TEXT); return true; } // write failure: buttons kept
    if (o.editMarkup) await o.editMarkup();
    await o.send("✅ به یادداشت تبدیل شد.");
    return true;
  }
  const t = await insertTask(env, { userId: o.fromId, title: g.row.content, projectId: pid, source: "text", sourceMessageId: null });
  if (!t.ok) { await o.send(NOT_SAVED_TEXT); return true; } // write failure: buttons kept
  if (o.editMarkup) await o.editMarkup();
  await o.send("✅ به تسک تبدیل شد.");
  return true;
}

// 1-d-5: chat retry (chat:retry:<msgId>), distinct from the interpreter
// retry:<rowId>. Same ownership rules as quick convert. The entry
// already owns the user row (save-first), so the retry saves no second
// user row (saveText ""); its answer carries fresh quick-convert
// buttons, and a second failure still offers retry + quick-convert (the
// ids ride along in the retry's own chat options). The transcript
// header is NOT re-echoed on retry: messages rows carry no source
// column, so a retry cannot know the original was voice (the original
// failure notice already carried it).
export async function resolveChatRetryCallback(env, o) {
  const m = /^chat:retry:(\d+)$/.exec(o.data);
  if (!m) return false;
  const id = Number(m[1]);
  if (!Number.isSafeInteger(id) || id <= 0) return true; // invalid: silent
  const g = await getMessageRow(env, o.fromId, id);
  if (!g.ok) { await o.send(NOT_SAVED_TEXT); return true; } // D1 failure: buttons kept
  if (!g.row || g.row.role !== "user" || !(g.row.content ?? "").trim()) return true; // foreign/missing/assistant/empty: silent
  if (o.editMarkup) await o.editMarkup();
  await o.chat(g.row.content, { saveText: "", retryEntryId: id, quickConvertId: id, replyMarkup: { inline_keyboard: quickConvertKeyboard(id) } });
  return true;
}
