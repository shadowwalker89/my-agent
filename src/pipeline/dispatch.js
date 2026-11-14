import { classifyDaily, parseExpense, parseReminder, normalizeText, formatJalali, resolveHourAmbiguousFollowup, mergeHourAmbiguousFollowup, hasDaypartReply, normalizeDaypartToken } from "../daily.js";
import { isRecallQuestionReminder } from "../domain/reminders/parse.js";
import { classifyIntent, MODEL_INTENT_COMBO } from "../intent.js";
import { runDailyBranch as runDailyBranchCore } from "./daily-branch.js";
import { runModelBranch as runModelBranchCore } from "./model-branch.js";
import { runNluBranch as runNluBranchCore } from "./nlu-branch.js";
import { handleInterpreterText } from "./interp-runner.js";
import { resolveProjects } from "../domain/tasks/projects.js";
import { saveMessage, finalizeMessageKind } from "../db.js";
import { getDefaultCurrency } from "../memory.js";
import { startConfirm, confirmExpenseDraft } from "../domain/expenses/service.js";
import { askKey, getKv, putKv, delKv, draftKey, correctionKey, EXPIRED_TEXT, NOT_SAVED_TEXT, iranIso, dbOf } from "./context.js";
import { mapQuestion, askText, setPendingAsk, slotKind, hourAmbiguousKeyboard, sendHourAmbiguousAsk, getPendingAsk, clearPendingAsk } from "./route.js";
import { isConnectorSecretError } from "../connectors.js";
import { VAULT_REDACTED_TEXT } from "./daily-helpers.js";
import { runPreDispatch } from "./pre-dispatch.js";

export const DAILY_CHAT_PROMPT = "هرگز دستورهای اسلش جعلی مثل /یادداشت، /تسکم، یا /اضافه کردن هزینه به کاربر پیشنهاد نده. کاربر برای ثبت موارد فقط کافی است با زبان طبیعی بنویسد یا ویس بدهد (مثلاً: «یادداشت کن فردا جلسه دارم» یا «امروز ۲۰۰ تومن نون خریدم» یا «خرجای امروز»).";

export async function handleDailyText(env, o, deps = {}) {
  try {
  const { userId, text } = o;
  const now = o.nowMs ?? Date.now();
  if (!dbOf(env)) { await clearPendingAsk(env, userId); return "chat"; }
  const pre = await runPreDispatch(env, o, deps);
  if (pre) return pre;
  const remembered = await getDefaultCurrency(env, userId);
  const c = classifyDaily(text, { nowMs: now, rememberedCurrency: remembered });
  if (c.intent === "command") { await clearPendingAsk(env, userId); return "chat"; }
  const ctx = { now, remembered };
  const baseDeps = { ...deps, tgApi: deps.tgApi || o.tgApi, sendProgressMessage: deps.sendProgressMessage || o.sendProgressMessage };
  const runDailyBranch = (a, b, cc, dd) => runDailyBranchCore(a, b, cc, dd, baseDeps);
  const runModelBranch = (a, b, rule, dd) => runModelBranchCore(a, b, rule, dd, { runDailyBranch });
  const runNluBranch = (a, b, dd) => runNluBranchCore(a, b, dd, { runDailyBranch, fallbackSendPhoto: deps.sendPhoto || o.fallbackSendPhoto });
  const entry = await saveMessage(env, { userId, role: "user", content: c.intent === "vault_save" ? VAULT_REDACTED_TEXT : text, kind: "pending" });
  if (entry.ok) o.entryMessageId = entry.id; else o._entrySaveFailed = true;
  if (o.voiceHeader && o.send) { const rawSend = o.send; let headerSent = false; o.send = async (t, sopts) => { if (!headerSent) { headerSent = true; return rawSend(o.voiceHeader + t, sopts); } return rawSend(t, sopts); }; }
  if (o.chat) { const rawChat = o.chat; o.chat = (t, copts = {}) => rawChat(t, { ...copts, ...(o.voiceHeader && !copts.voiceHeader ? { voiceHeader: o.voiceHeader } : {}), ...(o.entryMessageId && copts.excludeMessageId == null ? { excludeMessageId: o.entryMessageId } : {}), ...(o.entryMessageId && !copts.retryEntryId && !copts.retryData ? { retryEntryId: o.entryMessageId } : {}), ...(o.entryMessageId && !copts.quickConvertId ? { quickConvertId: o.entryMessageId } : {}) }); }
  const finalizeEntry = async (kind) => { if (o.entryMessageId && !o._entryFinalised) { o._entryFinalised = true; await finalizeMessageKind(env, o.entryMessageId, userId, kind); } };
  const viaBranch = async (cc) => { const r = await runDailyBranch(env, o, cc, ctx); await finalizeEntry(r === "chat" ? "chat" : "daily"); return r; };
  if ((c.intent === "reminder" || c.intent === "remember") && isRecallQuestionReminder(text)) { await clearPendingAsk(env, userId); await finalizeEntry("chat"); return "chat"; }
  if (c.intent === "ask" && c.question === "note-text") { await clearPendingAsk(env, userId); return viaBranch(c); }
  if (c.intent === "expense" || c.intent === "income") { await clearPendingAsk(env, userId); return viaBranch(c); }
  if (c.intent === "task-list") { await clearPendingAsk(env, userId); return viaBranch(c); }
  const aiAvailableForNlu = (env?.AI && typeof env.AI.run === "function") || o.interpreterCallFn || o.interpreterModel;
  const isMultiClause = String(text ?? "").length > 160 || ((String(text ?? "").match(/[.،؛;!?؟\n]/g) || []).length >= 3);
  const hasFactMarker = /(اسم\s*من|اسمم|نام\s*من|نامم|شهر\s*من|شهرم|ماشین\s*من|ماشینم|تولدم|تولد\s*من|سنم|شغلم)/u.test(String(text ?? ""));
  const greedyShouldDeferToAi = Boolean(aiAvailableForNlu) && (
    (c.intent === "reminder" && c.ask && c.ask !== "hour-ambiguous" && hasFactMarker) ||
    ((c.intent === "reminder" || c.intent === "vault_save") && isMultiClause) ||
    (c.confidence < 1 && c.intent === "reminder" && hasFactMarker)
  );
  if (!greedyShouldDeferToAi && c.intent !== "chat" && c.intent !== "ask") { await clearPendingAsk(env, userId); return viaBranch(c); }
  let slot = await getPendingAsk(env, userId);
  if (slot && slotKind(slot) === "hour-ambiguous") {
    if (normalizeDaypartToken(text) === "cancel") {
      await clearPendingAsk(env, userId);
      await o.send("❌ یادآوری لغو شد.");
      await finalizeEntry("daily");
      return "handled";
    }
    const trimmed = text.trim();
    const shortUnknown = trimmed.length > 0 && trimmed.length <= 10 && !/\s/.test(trimmed) && !/[؟?]/.test(trimmed) && !hasDaypartReply(text) && c.intent === "chat";
    let answerText = text;
    if (shortUnknown && !o.interpreterCallFn && !o.interpreterModel && !env.INTERPRETER_MODEL && env?.AI && typeof env.AI.run === "function") {
      const pres = await resolveProjects(env, userId);
      const nlu = await classifyIntent(env, text, { projects: (pres.projects || []).map((p) => p.name), pendingAsk: { kind: "reminder", reason: "hour-ambiguous", pendingBody: slot.pendingBody ?? null }, source: o.source || "text", nowIso: iranIso(now), lastAction: null, openTasks: [], recentNotes: [] });
      if (nlu.ok && nlu.confidence >= 0.75 && nlu.intent === "daypart_reply") {
        if (nlu.daypart === "cancel") {
          await clearPendingAsk(env, userId);
          await o.send("❌ یادآوری لغو شد.");
          await finalizeEntry("daily");
          return "handled";
        }
        if (["صبح", "عصر", "شب"].includes(nlu.daypart)) answerText = nlu.daypart;
      } else if (nlu.ok && nlu.confidence >= 0.75 && nlu.intent !== "chat") {
        await clearPendingAsk(env, userId);
        slot = null;
      }
    }
    if (slot && shortUnknown && answerText === text) {
      await o.send("متوجه نشدم؛ لطفاً روی یکی از دکمه‌های «☀️ صبح» یا «🌇 عصر» بزنید یا ساعت دقیق را بنویسید.", { replyMarkup: { inline_keyboard: hourAmbiguousKeyboard() } });
      await finalizeEntry("daily");
      return "handled";
    }
    if (slot && typeof slot.pendingBody === "string" && slot.pendingBody) {
      const filled = resolveHourAmbiguousFollowup(answerText, slot.pendingBody, now);
      if (filled) { await clearPendingAsk(env, userId); return viaBranch({ intent: "reminder", text: filled.text, due: filled.due }); }
      const merged = mergeHourAmbiguousFollowup(answerText, slot.pendingBody);
      if (merged) {
        const r = parseReminder(normalizeText(merged), now, merged);
        if (r.ask === "hour-ambiguous") {
          await setPendingAsk(env, userId, askText("hour-ambiguous"), undefined, "hour-ambiguous", slot.pendingBody);
          await sendHourAmbiguousAsk(o);
          await finalizeEntry("daily");
          return "handled";
        }
        await clearPendingAsk(env, userId);
        return viaBranch(r.ask ? { intent: "reminder", ask: r.ask } : { intent: "reminder", text: r.text, due: r.due });
      }
    }
    if (slot) { await clearPendingAsk(env, userId); slot = null; }
  }
  if (slot) { const { ret, outcome, ms } = await runModelBranch(env, o, c, ctx); console.log(JSON.stringify({ modelIntent: MODEL_INTENT_COMBO, tier: c.intent, ms, outcome })); await finalizeEntry(ret === "handled" ? "daily" : "chat"); return ret; }
  if (!o.interpreterCallFn && !o.interpreterModel) {
    if (env?.AI && typeof env.AI.run === "function") {
      const nluHandled = await runNluBranch(env, o, ctx);
      if (nluHandled !== null) { await finalizeEntry(nluHandled === "chat" ? "chat" : "daily"); return nluHandled; }
    }
    if (c.intent === "chat") { await finalizeEntry("chat"); return "chat"; }
    if (!env.INTERPRETER_MODEL) {
      const { ret, outcome, ms } = await runModelBranch(env, o, c, ctx);
      console.log(JSON.stringify({ modelIntent: MODEL_INTENT_COMBO, tier: c.intent, ms, outcome }));
      await finalizeEntry(ret === "handled" ? "daily" : "chat");
      return ret;
    }
  }
  return handleInterpreterText(env, o, ctx);
  } catch (e) {
    if (isConnectorSecretError(e)) {
      if (typeof o.send === "function") await o.send("❌ کلید کانکتور قابل خواندن نیست؛ لطفاً دوباره تنظیم کنید.");
      return "handled";
    }
    throw e;
  }
}

export async function resolveDailyCallback(env, o, deps = {}) {
  const md = /^money:dir:(spend|income):(.+)$/.exec(o.data);
  if (md) {
    const direction = md[1] === "spend" ? "expense" : "income";
    const id = md[2];
    const ask = await getKv(env, askKey(id));
    const text = ask?.text ?? null;
    if (!text) { await o.send(EXPIRED_TEXT); return true; }
    const ex = parseExpense(text, { nowMs: o.nowMs ?? Date.now(), rememberedCurrency: await getDefaultCurrency(env, o.fromId) }, text);
    if (ex?.error) { const q = askText(mapQuestion(ex.error)); await o.send(q); return true; }
    await putKv(env, draftKey(id), { owner: o.fromId, type: direction, ...ex });
    const r = await confirmExpenseDraft(env, o.fromId, id);
    if (r.status === "forbidden") return true;
    if (r.status === "missing") { await o.send(EXPIRED_TEXT); return true; }
    if (r.status === "failed") { await o.send(NOT_SAVED_TEXT); return true; }
    if (ask) await delKv(env, askKey(id));
    await o.editMarkup?.();
    await o.send("✅ ثبت شد.");
    return true;
  }
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
    if (r.status === "converted-done") { if (r.id) await putKv(env, correctionKey(o.fromId), { table: "expenses", id: r.id }); await o.editMarkup(); await o.send("💰 خرج ذخیره شد؛ تسک پیش‌تر جداگانه انجام شده بود و در بایگانی می‌ماند."); return true; }
    if (r.status === "expense-exists") { await o.send("💰 خرجی برای این پیش‌نویس از قبل ثبت شده است، ولی تسک پیدا نشد؛ تبدیل کامل نشد."); return true; }
    if (action === "confirm" && r.id) await putKv(env, correctionKey(o.fromId), { table: "expenses", id: r.id });
    await o.editMarkup();
    await o.send(action === "confirm" ? "✅ ثبت شد." : "لغو شد.");
    return true;
  }
  const ask = await getKv(env, askKey(id));
  if (!ask) { await o.send(EXPIRED_TEXT); return true; }
  if (Number(ask.owner) !== Number(o.fromId)) return true;
  await delKv(env, askKey(id));
  await o.editMarkup();
  if (choice === "chat") { await o.chat(ask.text, { saveText: "" }); return true; }
  const ex = parseExpense(ask.text, { nowMs: o.nowMs ?? Date.now() }, ask.text);
  if (ex?.error) { const q = askText(mapQuestion(ex.error)); await setPendingAsk(env, o.fromId, q, undefined, mapQuestion(ex.error)); await o.send(q); return true; }
  await startConfirm(env, o, choice, ex);
  return true;
}
