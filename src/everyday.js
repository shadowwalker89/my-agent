// Step 1b-2: everyday wiring (money, notes, reminders, translate,
// remember, queries, file reference + file branch). Pure classifier in
// daily.js; side effects here. D1 failures never throw.
import { classifyDaily, parseExpense, parseReminder, normalizeText, formatJalali, sumByCurrency, iranDate, weekRange, monthRange } from "./daily.js";
import { classifyDailyWithModel, freeTextDevSuggestion, MODEL_INTENT_COMBO } from "./intent.js";
import { saveMessage, finalizeMessageKind } from "./db.js";
import { buildInterpreterPrompt, interpretText, validateInterpreterAction } from "./interpreter.js";
import { getDefaultCurrency, setSetting } from "./memory.js";
import { tgApi } from "./telegram.js";

export const CHAT_CONTEXT_CHAR_LIMIT = 8000;
const DRAFT_TTL_SEC = 600;
const EXPIRED_TEXT = "قبلاً ثبت شد یا مهلتش گذشته";
const NOT_SAVED_TEXT = "ذخیره نشد، دوباره تلاش کن";

export function mapQuestion(q) { return q === "ambiguous" ? "amount" : q; } // TODO from 1b-1, resolved here
export function askText(q) {
  return { amount: "مبلغ چقدر بود؟", decimal: "مبلغ اعشاری در این قدم پذیرفته نیست؛ مبلغ را به عدد صحیح بگو.", period: "برای کدام دوره؟ امروز، دیروز، این هفته یا این ماه؟", date: "تاریخ را درست بگو؛ آن تاریخ معتبر نیست.", "hour-ambiguous": "ساعت را با صبح یا عصر مشخص کن.", "no-time": "ساعت یادآوری را بگو.", past: "آن زمان گذشته است؛ زمان آینده را بگو.", empty: "یادآوری برای چه کاری؟", text: "چه متنی را ترجمه کنم؟", "expense-or-chat": "این خرج است یا چت؟", "expense-or-income": "این خرج است یا درآمد؟", "note-text": "چه چیزی را یادداشت کنم؟", language: "به چه زبانی؟" }[q] ?? "دوباره بگو؟";
}

// Chat context: last 50 rows plus the 8,000-char cap, oldest dropped first.
export function buildChatContext(rows) {
  const msgs = (rows || []).filter((r) => r && typeof r.content === "string" && r.content).slice(-50);
  const kept = []; let total = 0;
  for (let i = msgs.length - 1; i >= 0; i--) { if (total + msgs[i].content.length > CHAT_CONTEXT_CHAR_LIMIT) break; kept.push({ role: msgs[i].role === "assistant" ? "assistant" : "user", content: msgs[i].content }); total += msgs[i].content.length; }
  return kept.reverse();
}

function dbOf(env) { const db = env && env.DB; return db && typeof db.prepare === "function" ? db : null; }
async function runDb(env, sql, params) { const db = dbOf(env); if (!db) return { ok: false }; try { await db.prepare(sql).bind(...params).run(); return { ok: true }; } catch { return { ok: false }; } }
async function allDb(env, sql, params) { const db = dbOf(env); if (!db) return []; try { const res = await db.prepare(sql).bind(...params).all(); return Array.isArray(res?.results) ? res.results : []; } catch { return []; } }
// Single-row read that distinguishes "no row" from "query failed".
async function firstDb(env, sql, params) { const db = dbOf(env); if (!db) return { ok: false, row: null }; try { const res = await db.prepare(sql).bind(...params).first(); return { ok: true, row: res ?? null }; } catch { return { ok: false, row: null }; } }
async function queryExpenseSums(env, userId, range) { return sumByCurrency(await allDb(env, "SELECT amount, currency_code FROM expenses WHERE user_id = ? AND type = 'expense' AND date BETWEEN ? AND ?", [userId, range.start, range.end])); }
async function recentMessages(env, userId, limit = 10) { return allDb(env, "SELECT role, content, kind, tg_file_id, file_name, file_mime FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?", [userId, limit]); }

// User row: allow-list FIRST (callers guarantee it), then INSERT OR IGNORE.
export async function ensureUserRow(env, userId) { const id = Number(userId); if (!Number.isFinite(id)) return { ok: false }; return runDb(env, "INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)", [id, String(id)]); }

// Keys carry only the short id; owner is checked after load (forbidden = silent, not expired).
function draftKey(id) { return `daily:draft:${id}`; }
function askKey(id) { return `daily:ask:${id}`; }
// Pending-ask slot (Part 3): ONE slot per user, 600s TTL like money drafts.
// {question, askId?, kind?, pendingBody?}: question is always the bot's own
// ask text; askId points at the existing daily:ask record. Part 3b adds kind
// (a stable identifier like "note-text", never a Persian-text comparison) and
// pendingBody (a body already known while a language ask is pending).
function pendingKey(id) { return `daily:pending-ask:${id}`; }
async function setPendingAsk(env, userId, question, askId, kind, pendingBody) {
  const value = { question };
  if (askId) value.askId = askId;
  if (kind) value.kind = kind;
  if (pendingBody) value.pendingBody = pendingBody;
  await putKv(env, pendingKey(userId), value);
}
// Language-name mapper for deterministic language-slot answers (en/fa/ar
// only, the pre-existing everyday target restriction — "German" re-asks).
function parseLanguageAnswer(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(/^به\s+/u, "").replace(/[؟?!.،,:：\s]+$/u, "");
  if (["en", "english", "انگلیسی", "انگليسي"].includes(t)) return "en";
  if (["fa", "persian", "farsi", "فارسی", "فارسي"].includes(t)) return "fa";
  if (["ar", "arabic", "عربی", "عربي"].includes(t)) return "ar";
  return null;
}

// Slot kind, with a defensive fallback for slots built without one (Part 3
// slots): button slots by askId, otherwise reverse the ask text to its key.
function slotKind(slot) {
  if (!slot || typeof slot !== "object") return "other";
  if (slot.kind) return slot.kind;
  if (slot.askId) return "button";
  for (const key of ["amount", "decimal", "period", "date", "hour-ambiguous", "no-time", "past", "empty", "text", "expense-or-chat", "expense-or-income", "note-text", "language"]) {
    if (slot.question === askText(key)) return key === "text" ? "translate-text" : key;
  }
  return "other";
}
// Slots whose question must survive a skipped/failed model call: dropping
// them would lose the question (Part 3b deviation from the generic skip rule).
function isBodySlot(slot) { return ["note-text", "translate-text", "language"].includes(slotKind(slot)); }
// Rule ask key -> slot kind ("text" is the translate-body ask).
function kindForAskKey(key) { return key === "text" ? "translate-text" : key; }
async function getPendingAsk(env, userId) { return getKv(env, pendingKey(userId)); }
async function clearPendingAsk(env, userId) { await delKv(env, pendingKey(userId)); }
function askKeyboard(question, id) {
  return question === "expense-or-chat"
    ? [[{ text: "💰 خرج", callback_data: `daily:ask:${id}:expense` }, { text: "💬 چت", callback_data: `daily:ask:${id}:chat` }]]
    : [[{ text: "💰 خرج", callback_data: `daily:ask:${id}:expense` }, { text: "📥 درآمد", callback_data: `daily:ask:${id}:income` }]];
}
function newId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
async function putKv(env, key, value) { if (!env.STATE) return; try { await env.STATE.put(key, JSON.stringify(value), { expirationTtl: DRAFT_TTL_SEC }); } catch {} }
async function getKv(env, key) { if (!env.STATE) return null; try { const raw = await env.STATE.get(key, "json"); return raw && typeof raw === "object" ? raw : null; } catch { return null; } }
async function delKv(env, key) { if (!env.STATE) return; try { await env.STATE.delete(key); } catch {} }

// Money always needs confirmation: draft in KV, buttons carry only the short draft id (< 64 bytes).
export async function startConfirm(env, o, type, ex) {
  const id = newId();
  await putKv(env, draftKey(id), { owner: o.userId, type, ...ex });
  const jalali = formatJalali(ex.date) || ex.date;
  await o.send(`💰 ${type === "income" ? "درآمد" : "خرج"}: ${ex.amount} ${ex.currency}${ex.item ? ` — ${ex.item}` : ""} — ${jalali}\nتأیید می‌کنی؟`, { replyMarkup: { inline_keyboard: [[{ text: "✅ تأیید", callback_data: `daily:confirm:${id}` }, { text: "❌ لغو", callback_data: `daily:cancel:${id}` }]] } });
  return id;
}

// Confirm: insert FIRST, delete the KV draft ONLY after success.
export async function confirmExpenseDraft(env, userId, id) {
  const draft = await getKv(env, draftKey(id));
  if (!draft) return { status: "missing" };
  if (Number(draft.owner) !== Number(userId)) return { status: "forbidden" };
  const r = await runDb(env, "INSERT OR IGNORE INTO expenses (user_id, type, amount, currency_code, item, category, date, draft_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [userId, draft.type, draft.amount, draft.currency, draft.item || null, null, draft.date, id, new Date().toISOString()]);
  if (!r.ok) return { status: "failed" };
  await delKv(env, draftKey(id));
  return { status: "ok", draft };
}

// Save-first reconciliation (Phase 0-b fix): when handleDailyText saved an
// entry row for this message, everyday branches finalise it instead of
// saving a second user row; without an entry row (D1 unavailable, commands)
// they save exactly as before. _entryFinalised keeps every exit to one
// finalise; markChat finalises only when an entry row exists (chat answers
// otherwise save their user row through answerChatText as before).
async function markDaily(env, o) {
  if (o.entryMessageId) { if (!o._entryFinalised) { o._entryFinalised = true; await finalizeMessageKind(env, o.entryMessageId, o.userId, "daily"); } return; }
  await saveMessage(env, { userId: o.userId, role: "user", content: o.text, kind: "daily" });
}
async function markChat(env, o) {
  if (o.entryMessageId && !o._entryFinalised) { o._entryFinalised = true; await finalizeMessageKind(env, o.entryMessageId, o.userId, "chat"); }
}

// Branch dispatch for a rule-classified intent. Returns "handled" or
// "chat" (fall through to the normal chat/task/dev path). Confident
// money messages are saved as kind daily; ask messages are not saved yet
// (choice asks live in KV until chosen, other asks await a corrected resend).
// Used by both the rule path and the model path: the model only picks the
// branch, and every branch below validates the ORIGINAL text again.
async function runDailyBranch(env, o, c, ctx) {
  const { userId, text } = o;
  if (c.intent === "expense" || c.intent === "income") {
    await markDaily(env, o);
    await startConfirm(env, o, c.intent, c.extraction);
    return "handled";
  }
  if (c.intent === "ask") {
    const question = mapQuestion(c.question);
    if (question === "expense-or-chat" || question === "expense-or-income") {
      const id = newId();
      await putKv(env, askKey(id), { owner: userId, text, question });
      await setPendingAsk(env, userId, askText(question), id, "button");
      await o.send(askText(question), { replyMarkup: { inline_keyboard: askKeyboard(question, id) } });
      return "handled";
    }
    await setPendingAsk(env, userId, askText(question), undefined, kindForAskKey(question));
    await o.send(askText(question));
    return "handled";
  }
  if (c.intent === "translate") {
    if (c.ask) { await setPendingAsk(env, userId, askText(c.ask), undefined, c.ask === "language" ? "language" : kindForAskKey(c.ask), c.ask === "language" ? c.text : undefined); await o.send(askText(c.ask)); return "handled"; }
    const targetName = c.target === "en" ? "English" : c.target === "fa" ? "Persian" : c.target;
    await markChat(env, o);
    await o.chat(c.text, { systemPrompt: `Translate the following text${targetName ? ` to ${targetName}` : ""}. Reply with only the translation.`, saveText: o.entryMessageId ? "" : text, noHistory: true });
    return "handled";
  }
  if (c.intent === "remember") {
    if (c.refused) { await o.send("در این قدم فقط تنظیم‌ها نگه داشته می‌شوند؛ خاطره‌های آزاد در قدم حافظه می‌آیند"); return "handled"; }
    const r = await setSetting(env, userId, c.setting.key, c.setting.value);
    await o.send(r.ok ? `✅ ذخیره شد: ${c.setting.key} = ${c.setting.value}` : NOT_SAVED_TEXT);
    return "handled";
  }
  if (c.intent === "note") {
    const r = await runDb(env, "INSERT INTO notes (user_id, text, source, created_at) VALUES (?, ?, ?, ?)", [userId, c.text, o.source === "voice" ? "voice" : "text", new Date().toISOString()]);
    await o.send(r.ok ? "✅ یادداشت ذخیره شد." : NOT_SAVED_TEXT);
    if (r.ok) await markDaily(env, o);
    return "handled";
  }
  if (c.intent === "reminder") {
    if (c.ask) { await setPendingAsk(env, userId, askText(c.ask), undefined, c.ask); await o.send(askText(c.ask)); return "handled"; }
    const r = await runDb(env, "INSERT INTO reminders (user_id, text, due_at, status, created_at) VALUES (?, ?, ?, ?, ?)", [userId, c.text, c.due, "pending", new Date().toISOString()]);
    await o.send(r.ok ? `⏰ یادآوری فقط ذخیره شد (ارسال سر وقت هنوز فعال نیست): ${c.text} — ${c.due}` : NOT_SAVED_TEXT);
    if (r.ok) await markDaily(env, o);
    return "handled";
  }
  if (c.intent === "expense-query") {
    if (c.ask) { await setPendingAsk(env, userId, askText(c.ask), undefined, c.ask); await o.send(askText(c.ask)); return "handled"; }
    const sums = await queryExpenseSums(env, userId, c.range);
    const keys = Object.keys(sums);
    await o.send(keys.length ? keys.map((k) => `${k}: ${sums[k]}`).join("\n") : "در این بازه خرجی ثبت نشده است.");
    await markDaily(env, o);
    return "handled";
  }
  if (c.intent === "last-expense") {
    // Answered from D1 only: the chat model must never claim anything
    // about the user's records. A failed read reports the standard error
    // and stores nothing extra.
    const r = await firstDb(env, "SELECT amount, currency_code, item, date FROM expenses WHERE user_id = ? AND type = 'expense' ORDER BY id DESC LIMIT 1", [userId]);
    if (!r.ok) { await o.send(NOT_SAVED_TEXT); return "handled"; }
    if (!r.row) { await o.send("هنوز خرجی ثبت نشده است."); }
    else await o.send(`💰 آخرین خرج: ${r.row.amount} ${r.row.currency_code}${r.row.item ? ` — ${r.row.item}` : ""} — ${formatJalali(r.row.date) || r.row.date}`);
    await markDaily(env, o);
    return "handled";
  }
  if (c.intent === "note-query") {
    if (c.ask) { await setPendingAsk(env, userId, askText(c.ask), undefined, c.ask); await o.send(askText(c.ask)); return "handled"; }
    const rows = await allDb(env, "SELECT text FROM notes WHERE user_id = ? ORDER BY id DESC LIMIT 5", [userId]);
    await o.send(rows.length ? rows.map((r) => `• ${r.text}`).join("\n") : "یادداشتی پیدا نشد.");
    await markDaily(env, o);
    return "handled";
  }
  if (c.intent === "file-reference") {
    const recent = await recentMessages(env, userId, 10);
    const file = recent.find((r) => r.tg_file_id);
    if (file) {
      const fileLabel = file.file_name || (typeof file.file_mime === "string" && file.file_mime.startsWith("image/") ? "عکس" : "فایل");
      await o.send(`📎 فایل پیدا شد: ${fileLabel} — خلاصه‌سازی با قدم فایل‌ها می‌آید، فعلاً فقط ذخیره شده است.`);
      await markDaily(env, o);
      return "handled";
    }
    const prev = recent[0];
    if (prev && prev.role === "user" && prev.kind === "chat" && !prev.tg_file_id) return "chat";
    await o.send("کدام فایل؟ در ۱۰ پیام اخیر فایلی پیدا نشد.");
    return "handled";
  }
  return "chat";
}

// Re-ask the pending question after a model failure (Part 3); button asks reuse the SAME ask id.
async function reaskPending(env, o, slot) {
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

// Follow-up resolution (Part 3): only with a slot AND a model followup.
// Returns {ret, outcome}, or null to fall through to the normal switch.
// Money safety is unchanged: rule extraction + confirm flow, no record without Confirm.
async function resolveFollowup(env, o, slot, m, ctx) {
  const { text } = o;
  if (slot.askId) {
    const ask = await getKv(env, askKey(slot.askId));
    if (!ask) { await o.send(EXPIRED_TEXT); return { ret: "handled", outcome: "routed" }; }
    if (Number(ask.owner) !== Number(o.userId)) return { ret: "handled", outcome: "routed" };
    if (ask.question !== "expense-or-chat" && ask.question !== "expense-or-income") return null;
    const choice = m.followup === "yes" ? "expense" : ask.question === "expense-or-chat" ? "chat" : "income";
    // Save-first: ask.text already has its entry row from the ask exit, so
    // the chat answer must not save it a second time (saveText "").
    if (choice === "chat") { await o.chat(ask.text, { saveText: "" }); return { ret: "handled", outcome: "chat" }; }
    const ex = parseExpense(ask.text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered }, ask.text);
    if (ex?.error) { const q = askText(mapQuestion(ex.error)); await o.send(q); await setPendingAsk(env, o.userId, q, undefined, mapQuestion(ex.error)); return { ret: "handled", outcome: "asked" }; }
    await startConfirm(env, o, choice, ex);
    return { ret: "handled", outcome: "routed" };
  }
  // Plain-text ask slot.
  if (m.followup === "no") { await o.send("باشه، ثبت نشد."); return { ret: "handled", outcome: "routed" }; }
  if (slot.question === askText("amount") && (m.intent === "expense" || m.intent === "income")) {
    const ex = parseExpense(text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered }, text);
    if (ex?.error) { await o.send(askText("amount")); await setPendingAsk(env, o.userId, askText("amount"), undefined, "amount"); return { ret: "handled", outcome: "asked" }; }
    return { ret: await runDailyBranch(env, o, { intent: m.intent, extraction: ex }, ctx), outcome: "routed" };
  }
  if (slot.question === askText("amount")) {
    // Bare "yes" (or a non-money verdict): "yes" alone answers no amount.
    await o.send(askText("amount")); await setPendingAsk(env, o.userId, askText("amount"), undefined, "amount"); return { ret: "handled", outcome: "asked" };
  }
  // Non-amount plain ask + "yes": a fresh everyday intent runs fresh (the
  // user answered with a full message); a bare "yes" answers nothing, so
  // the same question is re-asked instead of dumping "yes" into chat.
  if (m.intent !== "chat") return null;
  await o.send(slot.question); await setPendingAsk(env, o.userId, slot.question, undefined, slotKind(slot), slot.pendingBody); return { ret: "handled", outcome: "asked" };
}

// Translate body derivation, shared by the translate case and the
// invalid-target ask: rule body first, then a "text: body" colon fallback.
function deriveTranslateBody(text, ctx) {
  const c2 = classifyDaily(text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered });
  let body = c2.intent === "translate" ? c2.text : null;
  if (!body) { const colon = /[:：]\s*([\s\S]+)/.exec(text); body = colon ? colon[1].trim() : null; }
  return body || null;
}

// Model step (Part 3): the model only picks the branch; every branch below
// re-validates the ORIGINAL text with rule code, so model output fields are
// never read (parseModelIntent drops them). followup is consumed ONLY with a
// pending-ask slot; without one it is ignored, as in Part 2. Exported for tests (branch-level).
export async function runModelBranch(env, o, rule, ctx) {
  const t0 = Date.now();
  const slot = await getPendingAsk(env, o.userId);
  // A skipped call (missing key) is NOT a failure: Part 2 behaviour remains, stale slot just consumed.
  const keyMissing = !env || !env.ROUTER_KEY;
  const m = keyMissing ? null : await classifyDailyWithModel(env, o.text, slot?.question ?? null);
  const ms = () => Date.now() - t0;
  // Old slot consumed now: later paths resolve (stays cleared) or send a new ask (fresh slot).
  await clearPendingAsk(env, o.userId);
  // A validated translate intent with one bad field: ask the language,
  // on either tier — a targeted ask, not a generic failure. A body known
  // here (follow-up body, kept body, or derived body) rides in the slot.
  if (m && m.invalid === "target") {
    const keep = slot && slotKind(slot) === "language" ? slot.pendingBody : slot && slotKind(slot) === "translate-text" ? o.text : deriveTranslateBody(o.text, ctx);
    await setPendingAsk(env, o.userId, askText("language"), undefined, "language", keep || undefined); await o.send(askText("language")); return { ret: "handled", outcome: "asked", ms: ms() };
  }
  if (!m && rule.intent === "chat" && slot) {
    // Fallback body-slot handling: ONLY when the model gave nothing
    // (failure, timeout, unparseable output, or missing key). Model
    // successes keep the old 3b behaviour; the slot kind decides only
    // as a fallback, so a live model that never returns JSON cannot
    // loop on re-ask. Chat tier only: rule "ask" keeps the model path.
    const fallbackKind = slotKind(slot);
    if (fallbackKind === "note-text" || fallbackKind === "translate-text" || (fallbackKind === "language" && slot.pendingBody)) {
      if (fallbackKind === "note-text") {
        if (!o.text.trim()) { await setPendingAsk(env, o.userId, askText("note-text"), undefined, "note-text"); await o.send(askText("note-text")); return { ret: "handled", outcome: "asked", ms: ms() }; }
        return { ret: await runDailyBranch(env, o, { intent: "note", text: o.text }, ctx), outcome: "routed", ms: ms() };
      }
      if (fallbackKind === "translate-text") {
        if (!o.text.trim()) { await setPendingAsk(env, o.userId, askText("text"), undefined, "translate-text"); await o.send(askText("text")); return { ret: "handled", outcome: "asked", ms: ms() }; }
        await setPendingAsk(env, o.userId, askText("language"), undefined, "language", o.text); await o.send(askText("language")); return { ret: "handled", outcome: "asked", ms: ms() };
      }
      const target = parseLanguageAnswer(o.text);
      if (!target) { await setPendingAsk(env, o.userId, askText("language"), undefined, "language", slot.pendingBody); await o.send(askText("language")); return { ret: "handled", outcome: "asked", ms: ms() }; }
      return { ret: await runDailyBranch(env, o, { intent: "translate", text: slot.pendingBody, target }, ctx), outcome: "routed", ms: ms() };
    }
  }
  if (!m) {
    // Part 3b deviation: for body slots (note-text/translate-text/language)
    // a SKIPPED call (missing key) re-asks like a failure — the generic
    // skip-to-chat would silently drop the question. Other slots keep
    // Part 3 behaviour (skip -> rule ask / chat, slot consumed).
    if (slot && (!keyMissing || isBodySlot(slot))) { await reaskPending(env, o, slot); return { ret: "handled", outcome: "asked", ms: ms() }; }
    if (rule.intent === "ask") { const ret = await runDailyBranch(env, o, rule, ctx); return { ret, outcome: "asked", ms: ms() }; }
    return { ret: "chat", outcome: "chat", ms: ms() };
  }
  if (slot && m.followup) {
    const f = await resolveFollowup(env, o, slot, m, ctx);
    if (f) return { ret: f.ret, outcome: f.outcome, ms: ms() };
  }
  const { text } = o;
  const reclassify = () => classifyDaily(text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered });
  // Part 3b: slot-aware body consumption. When the pending slot asked for a
  // body and the model verdict matches it, the follow-up's FULL text IS the
  // body — the reclassification gate below must not loop on it. This bypass
  // applies ONLY to these slot cases; all non-slot verdicts keep Part 2/3
  // behaviour. Bodies always come from o.text (full), never the 300-char
  // classification payload (that cap lives only inside classifyDailyWithModel).
  const kind = slot ? slotKind(slot) : "other";
  if (slot && kind === "note-text" && m.intent === "note") {
    if (!text.trim()) { await setPendingAsk(env, o.userId, askText("note-text"), undefined, "note-text"); await o.send(askText("note-text")); return { ret: "handled", outcome: "asked", ms: ms() }; }
    return { ret: await runDailyBranch(env, o, { intent: "note", text }, ctx), outcome: "routed", ms: ms() };
  }
  if (slot && kind === "translate-text" && m.intent === "translate") {
    if (!text.trim()) { await setPendingAsk(env, o.userId, askText("text"), undefined, "translate-text"); await o.send(askText("text")); return { ret: "handled", outcome: "asked", ms: ms() }; }
    if (m.target) return { ret: await runDailyBranch(env, o, { intent: "translate", text, target: m.target }, ctx), outcome: "routed", ms: ms() };
    await setPendingAsk(env, o.userId, askText("language"), undefined, "language", text); await o.send(askText("language")); return { ret: "handled", outcome: "asked", ms: ms() };
  }
  if (slot && kind === "language" && m.intent === "translate" && slot.pendingBody) {
    if (m.target) return { ret: await runDailyBranch(env, o, { intent: "translate", text: slot.pendingBody, target: m.target }, ctx), outcome: "routed", ms: ms() };
    await setPendingAsk(env, o.userId, askText("language"), undefined, "language", slot.pendingBody); await o.send(askText("language")); return { ret: "handled", outcome: "asked", ms: ms() };
  }
  switch (m.intent) {
    case "chat":
      if (rule.intent === "ask") { const ret = await runDailyBranch(env, o, { intent: "ask", question: "expense-or-chat" }, ctx); return { ret, outcome: "asked", ms: ms() }; }
      if (o.hasImage) return { ret: "chat", outcome: "chat", ms: ms() };
      return { ret: "chat-direct", outcome: "chat", ms: ms() };
    case "dev": await o.send(freeTextDevSuggestion()); return { ret: "handled", outcome: "routed", ms: ms() };
    case "expense": case "income": {
      const ex = parseExpense(text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered }, text);
      if (ex?.error) { const ret = await runDailyBranch(env, o, { intent: "ask", question: ex.error }, ctx); return { ret, outcome: "asked", ms: ms() }; }
      return { ret: await runDailyBranch(env, o, { intent: m.intent, extraction: ex }, ctx), outcome: "routed", ms: ms() };
    }
    case "note": {
      const c2 = reclassify();
      if (c2.intent === "note") return { ret: await runDailyBranch(env, o, c2, ctx), outcome: "routed", ms: ms() };
      await setPendingAsk(env, o.userId, askText("note-text"), undefined, "note-text"); await o.send(askText("note-text")); return { ret: "handled", outcome: "asked", ms: ms() };
    }
    case "reminder": {
      const r = parseReminder(normalizeText(text), ctx.now, text);
      const c2 = r.ask ? { intent: "reminder", ask: r.ask } : { intent: "reminder", text: r.text, due: r.due };
      const ret = await runDailyBranch(env, o, c2, ctx);
      return { ret, outcome: r.ask ? "asked" : "routed", ms: ms() };
    }
    case "translate": {
      const c2 = reclassify();
      const body = deriveTranslateBody(text, ctx);
      if (!body) { await setPendingAsk(env, o.userId, askText("text"), undefined, "translate-text"); await o.send(askText("text")); return { ret: "handled", outcome: "asked", ms: ms() }; }
      const target = m.target || (c2.intent === "translate" && ["en", "fa", "ar"].includes(c2.target) ? c2.target : null);
      if (!target) { await setPendingAsk(env, o.userId, askText("language"), undefined, "language", body); await o.send(askText("language")); return { ret: "handled", outcome: "asked", ms: ms() }; }
      return { ret: await runDailyBranch(env, o, { intent: "translate", text: body, target }, ctx), outcome: "routed", ms: ms() };
    }
    case "remember": {
      const c2 = reclassify();
      if (c2.intent === "remember") return { ret: await runDailyBranch(env, o, c2, ctx), outcome: "routed", ms: ms() };
      await o.send("در این قدم فقط تنظیم‌ها نگه داشته می‌شوند؛ خاطره‌های آزاد در قدم حافظه می‌آیند");
      return { ret: "handled", outcome: "routed", ms: ms() };
    }
    case "expense-query": {
      const c2 = reclassify();
      if (c2.intent === "expense-query") { const ret = await runDailyBranch(env, o, c2, ctx); return { ret, outcome: c2.ask ? "asked" : "routed", ms: ms() }; }
      const ret = await runDailyBranch(env, o, { intent: "expense-query", ask: "period" }, ctx);
      return { ret, outcome: "asked", ms: ms() };
    }
    case "note-query": return { ret: await runDailyBranch(env, o, { intent: "note-query" }, ctx), outcome: "routed", ms: ms() };
    case "last-expense": return { ret: await runDailyBranch(env, o, { intent: "last-expense" }, ctx), outcome: "routed", ms: ms() };
    case "file-reference": {
      const ret = await runDailyBranch(env, o, { intent: "file-reference" }, ctx);
      return { ret, outcome: ret === "chat" ? "chat" : "routed", ms: ms() };
    }
    default: return { ret: "chat", outcome: "chat", ms: ms() };
  }
}

// ── Phase 0-b: interpreter wiring (design v3, 3.1-3.5; cards in 0-b2) ──
// Seed projects until migration 0003 lands (Phase 1-a swaps this constant
// for a D1 read). Never auto-create: unknown names get type buttons.
export const SEED_PROJECTS = [{ name: "عمومی", aliases: [] }, { name: "ایجنت", aliases: [] },
  { name: "گلبهار", aliases: ["گل"] }, { name: "قرارها و ملاقات‌ها", aliases: ["قرارها"] }];
const INTERP_UNAVAILABLE_TEXT = "تفسیر خودکار الان در دسترس نیست؛ خودت نوعش را بگو:";
function interpKey(id) { return `interp:${id}`; }
function interpTypeKeyboard(id) {
  return [[{ text: "📋 تسک", callback_data: `interp:type:task:${id}` }, { text: "📝 یادداشت", callback_data: `interp:type:note:${id}` }], [{ text: "💰 خرج", callback_data: `interp:type:expense:${id}` }, { text: "💬 چت", callback_data: `interp:type:chat:${id}` }]];
}
function noteCardKeyboard(id) { return [[{ text: "🗑 لغو", callback_data: `interp:del:${id}` }]]; }
async function newInterpRecord(env, userId, value) { const id = newId(); await putKv(env, interpKey(id), { owner: userId, ...value }); return id; }
async function insertNoteRow(env, userId, text, source) {
  const db = dbOf(env); if (!db) return { ok: false, id: null };
  try { await db.prepare("INSERT INTO notes (user_id, text, source, created_at) VALUES (?, ?, ?, ?)").bind(userId, text, source, new Date().toISOString()).run(); const row = await db.prepare("SELECT last_insert_rowid() AS id").bind().first(); return { ok: true, id: row?.id ?? null }; } catch { return { ok: false, id: null }; }
}
function rangeForPeriod(periodText, nowMs) {
  const t = normalizeText(periodText ?? ""), today = iranDate(nowMs);
  if (/دیروز/.test(t)) { const d = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10); return { start: d, end: d }; }
  if (/هفته/.test(t)) return weekRange(today);
  if (/ماه/.test(t)) return monthRange(today);
  return { start: today, end: today };
}
// Execute ONE validated interpreter action. Money/query/translate/setting/
// dev/chat send their own reply (direct: true); note/task/query return data
// for the caller to present. Money always re-derives from rule code and
// goes through the existing confirm card; the model never supplies numbers.
async function executeInterpAction(env, o, ctx, action, resolved) {
  const { userId } = o;
  if (action.type === "note") {
    const r = await insertNoteRow(env, userId, action.text, o.source === "voice" ? "voice" : "text");
    if (!r.ok) return { line: `📝 یادداشت: ${action.text} — ${NOT_SAVED_TEXT}` };
    return { line: `📝 یادداشت: ${action.text}`, note: { id: r.id, text: action.text }, kind: "daily" };
  }
  // 0-b2: task card, correction, and project choice. Until then a task or
  // correction action gets this honest line — never a silent note store.
  if (action.type === "task") return { line: "تسک‌ها با فاز ۱ می‌آیند.", kind: "daily" };
  if (action.type === "correction") return { line: "اصلاح با فاز ۱ می‌آید.", kind: "daily" };
  if (action.type === "expense" || action.type === "income") {
    const ex = parseExpense(action.text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered }, action.text);
    if (ex?.error || ex.amount !== resolved.amount || ex.currency !== resolved.currency) return { line: `💰 ${action.text} — مبلغ را دوباره بگو؟`, kind: "daily" };
    await startConfirm(env, o, action.type, ex);
    return { line: `💰 ${action.type === "income" ? "درآمد" : "خرج"}: ${ex.amount} ${ex.currency}${ex.item ? ` — ${ex.item}` : ""} (در انتظار تایید)`, direct: true, kind: "daily" };
  }
  if (action.type === "query") {
    const q = action.query;
    if (q.kind === "task") return { line: "تسک‌ها با فاز ۱ می‌آیند.", kind: "daily" };
    if (q.kind === "note") { const rows = await allDb(env, "SELECT text FROM notes WHERE user_id = ? ORDER BY id DESC LIMIT 5", [userId]); return { line: rows.length ? rows.map((r) => `• ${r.text}`).join("\n") : "یادداشتی پیدا نشد.", kind: "daily" }; }
    // The query action carries its own period phrase; no rule re-derivation.
    const sums = await queryExpenseSums(env, userId, rangeForPeriod(q.periodText, ctx.now));
    const keys = Object.keys(sums);
    return { line: keys.length ? keys.map((k) => `${k}: ${sums[k]}`).join("\n") : "در این بازه خرجی ثبت نشده است.", kind: "daily" };
  }
  if (action.type === "translate") {
    const targetName = action.target === "en" ? "English" : action.target === "fa" ? "Persian" : action.target === "ar" ? "Arabic" : "";
    await o.chat(action.text, { systemPrompt: `Translate the following text${targetName ? ` to ${targetName}` : ""}. Reply with only the translation.`, saveText: "", noHistory: true });
    return { line: `🌐 ترجمه: ${action.text}`, direct: true, kind: "chat" };
  }
  if (action.type === "setting") {
    const c2 = classifyDaily(action.text ?? o.text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered });
    if (c2.intent === "remember" && !c2.refused) {
      const r = await setSetting(env, userId, c2.setting.key, c2.setting.value);
      await o.send(r.ok ? `✅ ذخیره شد: ${c2.setting.key} = ${c2.setting.value}` : NOT_SAVED_TEXT);
    } else await o.send("در این قدم فقط تنظیم‌ها نگه داشته می‌شوند؛ خاطره‌های آزاد در قدم حافظه می‌آیند");
    return { line: `⚙️ تنظیم: ${action.text}`, direct: true, kind: "daily" };
  }
  if (action.type === "dev_hint") { await o.send(freeTextDevSuggestion()); return { line: "💻 پیشنهاد /dev", direct: true, kind: "chat" }; }
  if (action.type === "chat") { await o.chat(o.text, { saveText: "" }); return { line: "💬 چت", direct: true, kind: "chat" }; }
  return { line: "⏭ موردی اجرا نشد.", kind: "daily" };
}
// Validate + execute actions per v3 3.5 (0-b slice: task/correction/project
// choice arrive in 0-b2; here they get honest lines or type buttons).
export async function runInterpPolicy(env, o, ctx, actions, finalize) {
  const outcomes = [];
  for (const a of actions) {
    const v = validateInterpreterAction(a, { projects: SEED_PROJECTS, nowMs: ctx.now, defaultCurrency: ctx.remembered });
    if (!v.ok || a.confidence < 0.6 || a.needs !== "none") { outcomes.push({ skipped: true, action: a, errors: v.errors ?? [] }); continue; }
    outcomes.push(await executeInterpAction(env, o, ctx, a, v.resolved));
  }
  if (actions.length === 1) {
    const one = outcomes[0];
    // Unknown project falls to type buttons in 0-b; the choice card is 0-b2.
    if (one.skipped) { await finalize("daily"); const id = await newInterpRecord(env, o.userId, { text: o.text }); await o.send("نوعش را بگو:", { replyMarkup: { inline_keyboard: interpTypeKeyboard(id) } }); return "handled"; }
    if (one.direct) { await finalize(one.kind); return "handled"; }
    if (one.note) { await finalize("daily"); const id = await newInterpRecord(env, o.userId, { table: "notes", id: one.note.id, text: one.note.text }); await o.send("✅ یادداشت ذخیره شد.", { replyMarkup: { inline_keyboard: noteCardKeyboard(id) } }); return "handled"; }
    await finalize("daily");
    await o.send(one.line);
    return "handled";
  }
  await finalize("daily");
  await o.send(outcomes.map((r) => r.line).join("\n"));
  return "handled";
}
// Shared interpreter run (initial + retry): prompt -> interpret -> policy.
// The caller owns the pending row; on failure the row STAYS pending (the
// Phase 0 no-drop invariant) and the reply gains a Retry button. No
// re-gating, no re-save: the retry re-runs interpretation only, and each
// tap is a user action, so a repeated failure is not a loop.
async function interpretAndExecute(env, o, ctx, text, rowId, finalize) {
  const recent = (await recentMessages(env, o.userId, 4)).filter((r) => r.kind !== "pending").reverse().slice(-3).map((r) => r.content).filter((c) => typeof c === "string" && c);
  const prompt = buildInterpreterPrompt({ text, source: o.source === "voice" ? "voice" : "text", recentTurns: recent, openQuestion: null, projects: SEED_PROJECTS, nowIso: new Date(ctx.now + 210 * 60000).toISOString(), defaultCurrency: ctx.remembered });
  const res = await interpretText(env, o.interpreterModel ?? env.INTERPRETER_MODEL ?? null, prompt, o.interpreterCallFn ?? null);
  if (!res.ok) { await sendInterpUnavailable(env, o, text, rowId); return "handled"; }
  return runInterpPolicy(env, o, ctx, res.actions, finalize);
}
// Failure reply: the unavailable message + type buttons + a Retry button.
// The message row IS stored (pending); only the domain action is not.
async function sendInterpUnavailable(env, o, text, rowId) {
  const id = await newInterpRecord(env, o.userId, { text });
  const keyboard = [...interpTypeKeyboard(id)];
  if (rowId) keyboard.push([{ text: "🔄 ارسال مجدد", callback_data: `retry:${rowId}` }]);
  await o.send(INTERP_UNAVAILABLE_TEXT, { replyMarkup: { inline_keyboard: keyboard } });
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
// Interpreter callbacks: type choice, note delete/change, task-note/cancel,
// project choice. Owner-checked; expired records get the fixed message.
// Interpreter callbacks, 0-b set: type choice and note delete. Task card,
// change-type, and project choice are 0-b2; their buttons do not exist yet.
export async function resolveInterpCallback(env, o) {
  // Retry (Phase 0-b fix): callback_data retry:{pending D1 row id}. The row
  // id is used — not the Telegram message id — because the button must sit
  // inside the failure message itself, whose id is unknowable before it is
  // sent, and no tg-message-id column exists without a migration (out of
  // scope for 0-b). The original text is loaded from that pending row,
  // scoped by user id; interpretation re-runs only, with no re-gating and
  // no second row. A repeated failure re-shows the same reply + Retry.
  const rm = /^retry:(\d+)$/.exec(o.data);
  if (rm) {
    const rowId = Number(rm[1]);
    const row = await firstDb(env, "SELECT id, user_id, content FROM messages WHERE id = ? AND kind = 'pending'", [rowId]);
    if (!row.ok || !row.row) {
      const id = await newInterpRecord(env, o.fromId, { text: "" });
      await o.send("متن پیام پیدا نشد؛ لطفاً پیام را دوباره بفرست:", { replyMarkup: { inline_keyboard: interpTypeKeyboard(id) } });
      return true;
    }
    if (Number(row.row.user_id) !== Number(o.fromId)) return true;
    if (o.editMarkup) await o.editMarkup();
    const ctx = { now: o.nowMs ?? Date.now(), remembered: await getDefaultCurrency(env, o.fromId) };
    const oo = { ...o, userId: o.fromId, text: row.row.content, entryMessageId: rowId };
    const finalize = (kind) => { if (!oo._entryFinalised) { oo._entryFinalised = true; return finalizeMessageKind(env, rowId, o.fromId, kind); } return Promise.resolve({ ok: false }); };
    await interpretAndExecute(env, oo, ctx, row.row.content, rowId, finalize);
    return true;
  }
  const m = /^interp:(type|del):(.+)$/.exec(o.data);
  if (!m) return false;
  const [, action, rest] = m;
  if (action === "type") {
    const tm = /^(\w+):(.+)$/.exec(rest);
    if (!tm) return true;
    const [, choice, id] = tm;
    const rec = await getKv(env, interpKey(id));
    if (!rec) { await o.send(EXPIRED_TEXT); return true; }
    if (Number(rec.owner) !== Number(o.fromId)) return true;
    // Empty-text records exist only from the missing-retry-row fallback;
    // never store or answer from them, just say the text is gone.
    if (!rec.text?.trim()) { await o.send("متن پیام پیدا نشد؛ لطفاً پیام را دوباره بفرست:"); return true; }
    await delKv(env, interpKey(id));
    if (o.editMarkup) await o.editMarkup();
    const ctx = { now: o.nowMs ?? Date.now(), remembered: await getDefaultCurrency(env, o.fromId) };
    const oo = { ...o, userId: o.fromId, text: rec.text };
    if (choice === "task") { await o.send("تسک‌ها با فاز ۱ می‌آیند."); return true; }
    if (choice === "note") { const r = await insertNoteRow(env, o.fromId, rec.text, "text"); if (r.ok) { const nid = await newInterpRecord(env, o.fromId, { table: "notes", id: r.id, text: r.text }); await o.send("✅ یادداشت ذخیره شد.", { replyMarkup: { inline_keyboard: noteCardKeyboard(nid) } }); } else await o.send(NOT_SAVED_TEXT); return true; }
    if (choice === "expense") {
      const ex = parseExpense(rec.text, { nowMs: ctx.now, rememberedCurrency: ctx.remembered }, rec.text);
      if (ex?.error) { await setPendingAsk(env, o.fromId, askText("amount"), undefined, "amount"); await o.send(askText("amount")); return true; }
      await startConfirm(env, oo, "expense", ex); return true;
    }
    await o.chat(rec.text, { saveText: "" }); return true;
  }
  const rec = await getKv(env, interpKey(rest));
  if (!rec) { await o.send(EXPIRED_TEXT); return true; }
  if (Number(rec.owner) !== Number(o.fromId)) return true;
  await delKv(env, interpKey(rest));
  if (o.editMarkup) await o.editMarkup();
  if (rec.table === "notes" && rec.id) await runDb(env, "DELETE FROM notes WHERE id = ? AND user_id = ?", [rec.id, o.fromId]);
  await o.send("🗑 حذف شد."); return true;
}

// Everyday text, Phase 0-b: deterministic gates first (commands, bare-note
// ask, fast money, open-question answers), then the interpreter for
// everything else — never directly to chat. Part 2 comment below kept.
// uncertain (ask) or finds no everyday branch (chat). Confident rule
// results never reach a model. Returns "handled", "chat" (normal
// chat/task/dev path), or "chat-direct" (model already said chat for a
// text message, so the caller answers directly and skips classifyIntent).
export async function handleDailyText(env, o) {
  const { userId, text } = o;
  const now = o.nowMs ?? Date.now();
  if (!dbOf(env)) { await clearPendingAsk(env, userId); return "chat"; } // D1 unavailable: everyday off, chat keeps working
  const remembered = await getDefaultCurrency(env, userId);
  const c = classifyDaily(text, { nowMs: now, rememberedCurrency: remembered });
  // Commands never enter the everyday path and stay unstored (Step 1b rule);
  // the entry save below is the everyday-path entry, after command routing.
  if (c.intent === "command") { await clearPendingAsk(env, userId); return "chat"; }
  const ctx = { now, remembered };
  // Save-first (Phase 0-b fix): the message row is saved as pending BEFORE
  // any everyday gate (bare-note bypass, fast money, slot, rollout gate,
  // interpreter). The expense row is untouched by this: it is still
  // inserted only when the user taps Confirm. o.entryMessageId is visible
  // to the caller so downstream chat answers do not save a second user row.
  const entry = await saveMessage(env, { userId, role: "user", content: text, kind: "pending" });
  if (entry.ok) o.entryMessageId = entry.id; else o._entrySaveFailed = true;
  const finalizeEntry = async (kind) => { if (o.entryMessageId && !o._entryFinalised) { o._entryFinalised = true; await finalizeMessageKind(env, o.entryMessageId, userId, kind); } };
  const viaBranch = async (cc) => { const r = await runDailyBranch(env, o, cc, ctx); await finalizeEntry(r === "chat" ? "chat" : "daily"); return r; };
  // Bare-note ask bypasses the model step: the model is exactly what
  // failed live for bare notes (chat verdict -> hallucinated storage).
  // runDailyBranch asks for the text and sets the note-text slot itself.
  if (c.intent === "ask" && c.question === "note-text") { await clearPendingAsk(env, userId); return viaBranch(c); }
  // Fast money path (unchanged): rule-confident expense/income only.
  if (c.intent === "expense" || c.intent === "income") { await clearPendingAsk(env, userId); return viaBranch(c); }
  if (c.intent !== "chat" && c.intent !== "ask") { await clearPendingAsk(env, userId); return viaBranch(c); }
  // Answers to an open bot question keep the existing slot path.
  const slot = await getPendingAsk(env, userId);
  if (slot) { const { ret, outcome, ms } = await runModelBranch(env, o, c, ctx); console.log(JSON.stringify({ modelIntent: MODEL_INTENT_COMBO, tier: c.intent, ms, outcome })); await finalizeEntry(ret === "handled" ? "daily" : "chat"); return ret; }
  // Rollout gate: interpreter unconfigured -> today's model-intent path,
  // so merging 0-b cannot break non-money messages before a model is chosen.
  if (!o.interpreterCallFn && !o.interpreterModel && !env.INTERPRETER_MODEL) {
    const { ret, outcome, ms } = await runModelBranch(env, o, c, ctx);
    console.log(JSON.stringify({ modelIntent: MODEL_INTENT_COMBO, tier: c.intent, ms, outcome }));
    await finalizeEntry(ret === "handled" ? "daily" : "chat");
    return ret;
  }
  // Everything else goes to the interpreter, never directly to chat.
  return handleInterpreterText(env, o, ctx);
}

// daily: callbacks. Returns true when the data was a daily: callback.
// Forbidden callbacks send nothing, store nothing, and delete nothing.
export async function resolveDailyCallback(env, o) {
  const m = /^daily:(confirm|cancel|ask):([^:]+)(?::(chat|expense|income))?$/.exec(o.data);
  if (!m) return false;
  const [, action, id, choice] = m;
  await clearPendingAsk(env, o.fromId);
  if (action === "confirm" || action === "cancel") {
    let r;
    if (action === "confirm") r = await confirmExpenseDraft(env, o.fromId, id);
    else { const draft = await getKv(env, draftKey(id)); r = !draft ? { status: "missing" } : Number(draft.owner) !== Number(o.fromId) ? { status: "forbidden" } : (await delKv(env, draftKey(id)), { status: "ok" }); }
    if (r.status === "forbidden") return true;
    if (r.status === "missing") { await o.send(EXPIRED_TEXT); return true; }
    if (r.status === "failed") { await o.send(NOT_SAVED_TEXT); return true; }
    await o.editMarkup();
    await o.send(action === "confirm" ? "✅ ثبت شد." : "لغو شد.");
    return true;
  }
  const ask = await getKv(env, askKey(id));
  if (!ask) { await o.send(EXPIRED_TEXT); return true; }
  if (Number(ask.owner) !== Number(o.fromId)) return true;
  await delKv(env, askKey(id));
  await o.editMarkup();
  // Save-first: ask.text already has its entry row from the ask exit, so
  // the chat answer must not save it a second time (saveText "").
  if (choice === "chat") { await o.chat(ask.text, { saveText: "" }); return true; }
  const ex = parseExpense(ask.text, { nowMs: o.nowMs ?? Date.now() }, ask.text);
  if (ex?.error) { const q = askText(mapQuestion(ex.error)); await setPendingAsk(env, o.fromId, q, undefined, mapQuestion(ex.error)); await o.send(q); return true; }
  await startConfirm(env, o, choice, ex);
  return true;
}

// Telegram senders for the daily: branches in index.js.
export function dailySenders(env, chatId, messageId) {
  return {
    send: (msgText, opts) => tgApi(env, "sendMessage", { chat_id: chatId, text: msgText, ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}) }),
    editMarkup: () => tgApi(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
  };
}

// Non-text file message: save one messages row, kind daily, no R2 in
// Step 1. Returns false when D1 is missing (caller keeps the old reply).
export async function handleDailyFile(env, o) {
  if (!dbOf(env)) return false;
  const r = await saveMessage(env, { userId: o.userId, role: "user", content: o.caption || o.fileName || "file", kind: "daily", tgFileId: o.tgFileId, fileName: o.fileName || null, fileMime: o.fileMime || null });
  if (!r.ok) { await o.send(NOT_SAVED_TEXT); return true; }
  await o.send("📎 فایل ذخیره شد (فقط ذخیره؛ خلاصه‌سازی با قدم فایل‌ها می‌آید).");
  return true;
}
