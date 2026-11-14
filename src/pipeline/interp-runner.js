// Interpreter run loop: breaker, backup model, and the v3 3.1 entry path,
// extracted from src/everyday.js (R0.8a). Rank 3; no channel imports, and
// masked backup calls keep the sensitive-text protection from R0.6.
import { finalizeMessageKind } from "../db.js";
import { buildInterpreterPrompt, interpretText, parseInterpreterOutput } from "../interpreter.js";
import { maskSensitive, unmaskAction } from "./interpret.js";
import { resolveProjects } from "../domain/tasks/projects.js";
import { getDefaultCurrency } from "../memory.js";
import { getKv, recentMessages, iranIso } from "./context.js";
import { runInterpPolicy, sendInterpUnavailable, newInterpRecord, interpTypeKeyboard } from "./policy.js";

// Shared interpreter run (initial + retry): prompt -> interpret -> policy.
// The caller owns the pending row; on failure the row STAYS pending (the
// Phase 0 no-drop invariant) and the reply gains a Retry button. No
// re-gating, no re-save: the retry re-runs interpretation only, and each
// tap is a user action, so a repeated failure is not a loop.
export async function interpretAndExecute(env, o, ctx, text, rowId, finalize) {
  const recent = (await recentMessages(env, o.userId, 4)).filter((r) => r.kind !== "pending").reverse().slice(-3).map((r) => r.content).filter((c) => typeof c === "string" && c);
  // Circuit breaker (0-b2): while flagged, no Workers AI call is attempted;
  // the failure reply (with the backup button) is sent instead. A suppressed
  // attempt records no new breaker error or breaker state — the flag's TTL
  // governs lifting — but the failure reply still creates its KV failure
  // record, so the Retry/Backup buttons on that message keep working.
  if (await breakerFlag(env)) { await sendInterpUnavailable(env, o, text, rowId); return "handled"; }
  // 1-b-1: the prompt uses the resolved list; on a project-read failure
  // the failure path runs instead (no seed names shown).
  const rp = await resolveProjects(env, o.userId);
  if (!rp.ok) { await sendInterpUnavailable(env, o, text, rowId); return "handled"; }
  const prompt = buildInterpreterPrompt({ text, source: o.source === "voice" ? "voice" : "text", recentTurns: recent, openQuestion: null, projects: rp.projects, nowIso: iranIso(ctx.now), defaultCurrency: ctx.remembered });
  const res = await interpretText(env, o.interpreterModel ?? env.INTERPRETER_MODEL ?? null, prompt, o.interpreterCallFn ?? null);
  if (!res.ok) { await recordInterpError(env, res.reason); await sendInterpUnavailable(env, o, text, rowId); return "handled"; }
  return runInterpPolicy(env, o, ctx, res.actions, finalize);
}

// ── Phase 0-b2: external backup + circuit breaker (v3 3.7) ──
// Breaker state is written ONLY on interpreter error: the error-timestamp
// list and the breaker flag. (The failure reply's KV record, which the
// Retry/Backup buttons need, is UI state, not breaker state, and is
// written for suppressed attempts too.) A successful call writes nothing, so "3 consecutive
// errors" is approximated by 3 errors inside a rolling 2-minute window
// (a success between errors does not clear the list — see diff header).
const BREAKER_FLAG_KEY = "interp:breaker:flag";
const BREAKER_ERRORS_KEY = "interp:breaker:errors";
const BREAKER_WINDOW_MS = 120000, BREAKER_MAX_ERRORS = 3, BREAKER_TTL_SEC = 300;
export async function putKvTtl(env, key, value, ttlSec) { if (!env.STATE) return; try { await env.STATE.put(key, JSON.stringify(value), { expirationTtl: ttlSec }); } catch {} }
export function quotaResetMs(now) { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); }
export async function breakerFlag(env) {
  const f = await getKv(env, BREAKER_FLAG_KEY);
  if (!f) return null;
  if (f.until === "quota") return Date.now() < quotaResetMs(Date.now()) ? f : null;
  return typeof f.until === "number" && Date.now() < f.until ? f : null;
}
export async function recordInterpError(env, reason) {
  if (!env.STATE) return;
  const now = Date.now();
  if (reason === "quota") { await putKvTtl(env, BREAKER_FLAG_KEY, { until: "quota" }, Math.max(60, Math.round((quotaResetMs(now) - now) / 1000))); return; }
  const prev = (await getKv(env, BREAKER_ERRORS_KEY)) || {};
  const list = (Array.isArray(prev.list) ? prev.list : []).filter((t) => now - t < BREAKER_WINDOW_MS);
  list.push(now);
  await putKvTtl(env, BREAKER_ERRORS_KEY, { list }, Math.round(BREAKER_WINDOW_MS / 1000));
  if (list.length >= BREAKER_MAX_ERRORS) await putKvTtl(env, BREAKER_FLAG_KEY, { until: now + BREAKER_TTL_SEC * 1000 }, BREAKER_TTL_SEC);
}
// Backup masking (R0.6) lives in ./pipeline/interpret.js.
// Backup call seam: tests inject o.backupCallFn (masked text -> raw JSON
// string), mirroring interpreterCallFn. No provider endpoint is guessed:
// the backup provider is still unchosen (the 3.7 human step), so without
// a seam the production tap reports backup as not connected — never chat,
// never a silent drop. Binding the seam to the chosen provider's endpoint
// is one function, with no masking/policy change.
export async function callBackupModel(maskedText, callFn) {
  if (typeof callFn === "function") { try { const raw = await callFn(maskedText); return { ok: true, text: typeof raw === "string" ? raw : "" }; } catch { return { ok: false }; } }
  return { ok: false, reason: "no-provider-binding" };
}
const BACKUP_UNAVAILABLE_TEXT = "مدل بیرونی وصل نیست؛ خودت نوعش را بگو:";
const BACKUP_FAILED_TEXT = "تفسیر با مدل بیرونی هم نشد؛ خودت نوعش را بگو:";
export async function runBackupInterpretation(env, o, text, rowId, finalize) {
  const userId = o.fromId ?? o.userId;
  const oo = { ...o, userId, text };
  if (!o.backupCallFn && (!env.INTERPRETER_BACKUP_MODEL || !env.INTERPRETER_BACKUP_KEY)) {
    const id = await newInterpRecord(env, userId, { text });
    await oo.send(BACKUP_UNAVAILABLE_TEXT, { replyMarkup: { inline_keyboard: interpTypeKeyboard(id) } });
    return true;
  }
  const { masked, table } = maskSensitive(text);
  const raw = await callBackupModel(masked, o.backupCallFn ?? null);
  const parsed = raw.ok ? parseInterpreterOutput(raw.text) : { ok: false };
  if (!parsed.ok) {
    const id = await newInterpRecord(env, userId, { text });
    await oo.send(BACKUP_FAILED_TEXT, { replyMarkup: { inline_keyboard: interpTypeKeyboard(id) } });
    return true;
  }
  const ctx = { now: o.nowMs ?? Date.now(), remembered: await getDefaultCurrency(env, userId) };
  return runInterpPolicy(env, oo, ctx, parsed.actions.map((a) => unmaskAction(a, table)), finalize);
}
// Interpreter path (v3 3.1): the entry row was already saved as pending by
// handleDailyText, so this only finalises it. An entry-save failure falls
// back to today's chat path with no crash, as before.
export async function handleInterpreterText(env, o, ctx) {
  if (o._entrySaveFailed) return "chat";
  const { userId, text } = o;
  const finalize = (kind) => { if (o.entryMessageId && !o._entryFinalised) { o._entryFinalised = true; return finalizeMessageKind(env, o.entryMessageId, userId, kind); } return Promise.resolve({ ok: false }); };
  return interpretAndExecute(env, o, ctx, text, o.entryMessageId ?? null, finalize);
}
