// Phase 1-e Pillar 2: NLU branch (moved from src/everyday.js, R0.8a).
// Rank 3; no channel imports. The everyday.js branch dispatcher and the
// optional Telegram fallback send are injected as deps (runDailyBranch /
// fallbackSendPhoto). Runs ONLY after deterministic rules returned
// chat/ask, only when the legacy interpreter is unconfigured but the AI
// binding exists. Returns "handled" when an intent executed, null when
// the caller must fall through — never a drop. Every write is
// re-validated deterministically: note/task bodies non-empty, projects
// resolved against real D1 rows (folder phrase wins; seed fallback has
// no id and never attaches), reminders re-parsed by parseReminder,
// expenses ONLY via parseExpense's integer amount into the 10-minute
// confirm draft. An executed verdict saves an intent-feedback trace row.
import { classifyDaily, parseExpense, parseReminder } from "../daily.js";
import { classifyIntent, resolveInterpreterModel, recoverFullNoteBody } from "../intent.js";
import { insertIntentFeedback, listOpenTasksResult, listNotesResult, insertTask } from "../db.js";
import { generateFreeImage } from "../media.js";
import { resolveProjects, resolveFolderTag, defaultProjectId, findProjectByName } from "../domain/tasks/projects.js";
import { startConfirm } from "../domain/expenses/service.js";
import { setPendingAsk, askText, sendHourAmbiguousAsk } from "./route.js";
import { REF_RE, isUnambiguousQuestion } from "./nlu-skip.js";
import { iranIso, runDb, markDaily, NOT_SAVED_TEXT, UNSUPPORTED_ACTION_TEXT } from "./context.js";

const dailyRunner = (deps) => {
  const fn = deps?.runDailyBranch;
  if (typeof fn !== "function") throw new Error("nlu-branch requires deps.runDailyBranch");
  return fn;
};

export async function runNluBranch(env, o, ctx, deps = {}) {
  const runDailyBranch = dailyRunner(deps);
  const fallbackSendPhoto = typeof deps?.fallbackSendPhoto === "function" ? deps.fallbackSendPhoto : null;
  const { userId, text } = o;
  // Phase 2-c: unambiguous questions skip the NLU entirely (0 AI.run
  // calls, no D1 query) and fall through to chat; see isUnambiguousQuestion.
  if (isUnambiguousQuestion(text)) return null;
  const now = ctx.now ?? o.nowMs ?? Date.now();
  const pres = await resolveProjects(env, userId);
  // Phase 2-g: intent_nlu_diag — one privacy-safe console line per NLU
  // invocation (never message text/slots/bodies; no KV writes). Emitted
  // only when a model actually resolved; a no-model miss logs nothing.
  const nluModel = resolveInterpreterModel(env);
  const nluT0 = Date.now();
  const nowIso = iranIso(now);
  const source = o.source || "text";
  const replyContext = typeof o.replyToText === "string" && o.replyToText.trim() ? `[در پاسخ به پیام قبلی: «${o.replyToText.trim().slice(0, 1200)}»]` : "";
  const needsRefTargets = REF_RE.test(text) || Boolean(replyContext);
  let openTasks = [], recentNotes = [], lastAction = ctx.lastAction ?? null;
  if (needsRefTargets) {
    try { const tr = await listOpenTasksResult(env, userId, null, 5, 0); if (tr?.ok) openTasks = (tr.tasks || []).map((t) => t.title).filter(Boolean); } catch {}
    try { const nr = await listNotesResult(env, userId, { limit: 5, offset: 0 }); if (nr?.ok) recentNotes = (nr.notes || []).map((n) => n.text).filter(Boolean); } catch {}
  }
  if (replyContext) {
    const base = lastAction ? (typeof lastAction === "string" ? lastAction : JSON.stringify(lastAction)) : "";
    lastAction = base ? `${replyContext}; ${base}` : replyContext;
  }
  if (!lastAction) lastAction = openTasks[0] ? { kind: "task", title: openTasks[0] } : recentNotes[0] ? { kind: "note", title: recentNotes[0] } : null;
  const nlu = await classifyIntent(env, text, { projects: (pres.projects || []).map((p) => p.name), pendingAsk: null, source, nowIso, lastAction, openTasks, recentNotes });
  let nluRoutedTo = "chat";
  const emitNluDiag = (fallbackReason) => {
    if (!nluModel) return;
    const parts = String(nlu.intent || "").split("_");
    console.log(JSON.stringify({ event: "intent_nlu_diag", models: [nluModel], perModel: [{ model: nluModel, status: nlu.ok ? "ok" : nlu.reason }], parseOk: nlu.ok || nlu.reason === "bad-intent", finalDomain: nlu.ok ? parts[0] : null, finalAction: nlu.ok ? (parts.slice(1).join("_") || null) : null, confidence: nlu.ok ? nlu.confidence : null, routedTo: nluRoutedTo, elapsedMs: Date.now() - nluT0, fallbackReason }));
  };
  if (!nlu.ok || nlu.confidence < 0.75 || nlu.intent === "chat") { emitNluDiag(!nlu.ok ? nlu.reason : nlu.confidence < 0.75 ? "low-confidence" : "chat-intent"); return null; }
  // A05/A13 reference resolution: «همونو برای فردا بذار» etc. resolve
  // against the single recent task/note; with multiple open targets ask
  // a clarification question instead of guessing.
  const isRef = REF_RE.test(text);
  const refTargets = [...openTasks.map((t) => ({ kind: "task", title: t })), ...recentNotes.map((t) => ({ kind: "note", title: t }))];
  if (isRef && ["note", "task", "reminder"].includes(nlu.intent) && (!nlu.body || REF_RE.test(String(nlu.body ?? "")))) {
    if (refTargets.length > 1) {
      nluRoutedTo = nlu.intent;
      await o.send(`کدام مورد را منظورت است؟\n${refTargets.map((t, i) => `${i + 1}. ${t.title}`).join("\n")}`);
      emitNluDiag(null);
      return "handled";
    }
    if (refTargets.length === 1) nlu.body = refTargets[0].title;
  }
  const trace = async (projectName) => { try { await insertIntentFeedback(env, { userId, text, predictedType: nlu.intent, correctType: nlu.intent, project: projectName ?? null }); } catch {} };
  const tag = await resolveFolderTag(env, userId, text);
  const resolveProject = () => {
    if (tag) return { id: tag.project.id, name: tag.project.name };
    if (nlu.project && !pres.fallback) {
      const hit = findProjectByName(pres.projects, nlu.project);
      if (hit) return { id: hit.id, name: hit.name };
    }
    return null;
  };
  const viaBranch = async (cc) => { const r = await runDailyBranch(env, o, cc, ctx); if (r === "handled") nluRoutedTo = cc.intent; return r === "handled" ? "handled" : null; };
  // Phase 2-g: the switch runs inside this wrapper so every arm's
  // return lands in nluOut and exactly one diag line is emitted below
  // (the arms themselves are unchanged).
  const nluOut = await (async () => {
  switch (nlu.intent) {
    case "note":
    case "task": {
      if (!nlu.body || !nlu.body.trim()) return null;
      const proj = resolveProject();
      const body = nlu.intent === "note"
        ? recoverFullNoteBody(text, nlu.body, nlu.leading_framing, nlu.trailing_framing)
        : nlu.body.trim();
      if (!body) return null;
      let r;
      if (nlu.intent === "note") {
        const pid = proj ? proj.id : await defaultProjectId(env, userId);
        const pname = proj ? proj.name : null;
        r = pid === null
          ? await runDb(env, "INSERT INTO notes (user_id, text, source, created_at) VALUES (?, ?, ?, ?)", [userId, body, o.source || "text", new Date().toISOString()])
          : await runDb(env, "INSERT INTO notes (user_id, text, source, created_at, project_id) VALUES (?, ?, ?, ?, ?)", [userId, body, o.source || "text", new Date().toISOString(), pid]);
        await o.send(r.ok ? `✅ یادداشت ذخیره شد.${pname ? ` [📁 ${pname}]` : ""}` : NOT_SAVED_TEXT);
        if (r.ok) { await trace(pname); await markDaily(env, o); }
      } else {
        r = await insertTask(env, { userId, title: body, projectId: proj ? proj.id : null, source: o.source === "voice" ? "voice" : "text" });
        await o.send(r.ok ? `✅ تسک ثبت شد.${proj ? ` [📁 ${proj.name}]` : ""}` : NOT_SAVED_TEXT);
        if (r.ok) { await trace(proj ? proj.name : null); await markDaily(env, o); }
      }
      return "handled";
    }
    case "reminder": {
      if (!nlu.body || !nlu.body.trim()) return null;
      // With an explicit folder phrase, the folder-stripped ORIGINAL
      // message is the canonical string (it still carries trigger, date,
      // and hour words for parseReminder); otherwise the canonical
      // string is built from the NLU fields. Either way parseReminder
      // — never the model — decides the due time.
      let canonical;
      if (tag) canonical = tag.body;
      else {
        const datePart = ["امروز", "فردا", "پس‌فردا"].includes(nlu.date_ref) ? nlu.date_ref : "";
        const timePart = nlu.time_ref ? `ساعت ${nlu.time_ref}${nlu.daypart && ["صبح", "عصر", "شب"].includes(nlu.daypart) ? ` ${nlu.daypart}` : ""}` : "";
        canonical = `یادم بنداز ${datePart} ${timePart} ${nlu.body.trim()}`.replace(/\s+/g, " ").trim();
      }
      const r = parseReminder(canonical, now, canonical);
      if (r.ask === "hour-ambiguous" || r.ask === "no-time") {
        await setPendingAsk(env, userId, askText(r.ask), undefined, r.ask, r.ask === "hour-ambiguous" ? canonical : undefined);
        if (r.ask === "hour-ambiguous") await sendHourAmbiguousAsk(o); else await o.send(askText(r.ask));
        return "handled";
      }
      if (r.ask) return viaBranch({ intent: "reminder", ask: r.ask });
      const proj = resolveProject();
      const rr = await insertTask(env, { userId, title: r.text, remindAt: r.due, dueAt: null, projectId: proj ? proj.id : null, source: o.source === "voice" ? "voice" : "text" });
      await o.send(rr.ok ? `⏰ یادآوری به‌عنوان تسک ذخیره شد.${proj ? ` [📁 ${proj.name}]` : ""}` : NOT_SAVED_TEXT);
      if (rr.ok) { await trace(proj ? proj.name : null); await markDaily(env, o); }
      return "handled";
    }
    case "expense": {
      const ex = parseExpense(text, { nowMs: now }, text);
      if (!ex || ex.error || !Number.isInteger(ex.amount)) return null;
      await startConfirm(env, o, "expense", ex);
      return "handled";
    }
    case "income": {
      const ex = parseExpense(text, { nowMs: now, rememberedCurrency: ctx.remembered }, text);
      if (!ex || ex.error || !Number.isInteger(ex.amount)) return null;
      await startConfirm(env, o, "income", ex);
      await trace(null);
      return "handled";
    }
    case "vault_save": {
      const det = classifyDaily(text, { nowMs: now, rememberedCurrency: ctx.remembered });
      if (det.intent === "vault_save" && det.value) {
        if (!det.title || !String(det.title).trim() || !det.value || !String(det.value).trim() || String(det.value).trim().length < 4) { await trace(null); await o.send("برای ثبت در گاوصندوق، عنوان و مقدار را مشخص کن؛ هنوز چیزی ذخیره نشده است."); return "handled"; }
        await trace(null); return viaBranch(det);
      }
      const digits = String(text).replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).match(/\d+/g);
      const candValue = digits ? digits.join("") : (nlu.body && /\d/.test(nlu.body) ? nlu.body.replace(/\D/g, "") : "");
      const candTitle = nlu.body && !/\d/.test(nlu.body) ? nlu.body.trim() : (det.title ?? null);
      if (!candTitle || !String(candTitle).trim() || !candValue || !String(candValue).trim() || String(candValue).trim().length < 4) { await trace(null); await o.send("برای ثبت در گاوصندوق، عنوان و مقدار را مشخص کن؛ هنوز چیزی ذخیره نشده است."); return "handled"; }
      await trace(null);
      return viaBranch({ intent: "vault_save", value: candValue, title: candTitle, category: det.category ?? null, keywords: det.keywords ?? [], extra: det.extra ?? null });
    }
    case "vault_get": {
      const det = classifyDaily(text, { nowMs: now, rememberedCurrency: ctx.remembered });
      await trace(null);
      return viaBranch(det.intent === "vault_get" ? det : { intent: "vault_get", keywords: det.keywords ?? (nlu.body ? [nlu.body.trim()] : []), category: det.category ?? null, title: det.title ?? nlu.body ?? null });
    }
    case "vault_list": {
      const det = classifyDaily(text, { nowMs: now, rememberedCurrency: ctx.remembered });
      await trace(null);
      return viaBranch(det.intent === "vault_list" ? det : { intent: "vault_list", category: det.category ?? null, title: det.title ?? null, keywords: det.keywords ?? [], fileList: det.fileList ?? false });
    }
    case "vault_file_get": {
      const det = classifyDaily(text, { nowMs: now, rememberedCurrency: ctx.remembered });
      await trace(null);
      return viaBranch(det.intent === "vault_file_get" ? det : { intent: "vault_file_get", keywords: det.keywords ?? (nlu.body ? String(nlu.body).split(/\s+/).filter(Boolean) : []) });
    }
    case "memory_save": {
      const det = classifyDaily(text, { nowMs: now, rememberedCurrency: ctx.remembered });
      if (det.intent === "memory_save") { await trace(null); return viaBranch(det); }
      const body = (nlu.body || "").trim() || text.trim();
      if (!body) return null;
      const nameM = /^(?:اسمم|نامم|اسم\s+من|نام\s+من)\s+([\s\S]+?)(?:\s+(?:است|هست))?$/u.exec(body);
      if (nameM) { const v = nameM[1].trim(); if (!v) return null; await trace(null); return viaBranch({ intent: "memory_save", text: body, factKey: "name", factValue: v, setting: { key: "name", value: v } }); }
      await trace(null);
      return viaBranch({ intent: "memory_save", text: body, factKey: "general", factValue: body });
    }
    case "unsupported_action": {
      await o.send(UNSUPPORTED_ACTION_TEXT);
      await trace(null);
      return "handled";
    }
    case "note_list":
      return viaBranch({ intent: "note-query", date: null, projectName: nlu.project });
    case "task_list":
      return viaBranch({ intent: "task-list" });
    case "project_list":
      return viaBranch({ intent: "project-list" });
    case "project_create": {
      if (!nlu.body || !nlu.body.trim()) return null;
      return viaBranch({ intent: "project-create", name: nlu.body.trim() });
    }
    case "summary": {
      const kind = nlu.summary_target === "tasks" ? "task" : "note";
      return viaBranch({ intent: "summary", kind, projectName: nlu.project });
    }
    case "image_gen": {
      const prompt = String(nlu.body || nlu.title || text || "").trim();
      if (!prompt) return null;
      const targetChatId = o.chatId ?? o.userId ?? userId;
      if (typeof o.send === "function") await o.send("🎨 در حال ساخت تصویر، لطفاً چند ثانیه صبر کنید...");
      const res = await generateFreeImage(env, prompt, { userId, fetchFn: o.fetchFn, routerCallFn: o.routerCallFn });
      if (res && res.ok) {
        let caption = `🎨 تصویر ساخته شد (${res.provider || "auto"}): ${prompt}`;
        if (res.provider === "pollinations" && res.diagErrors?.length) caption += `\n⚠️ دیباگ موتور اصلی: ${res.diagErrors.slice(0, 3).join(" | ")}`;
        let photoSent = false;
        if (typeof o.sendPhoto === "function") {
          try { const tgRes = await o.sendPhoto(res.bytes, { caption, mimeType: res.mimeType, filename: "generated.png" }); photoSent = !(tgRes && tgRes.ok === false); } catch {}
        }
        if (!photoSent && fallbackSendPhoto && (env?.TELEGRAM_BOT_TOKEN || env?.TG_TOKEN) && targetChatId) {
          try { const tgRes = await fallbackSendPhoto({ ...env, TG_TOKEN: env.TG_TOKEN || env.TELEGRAM_BOT_TOKEN }, targetChatId, "generated.png", res.bytes, { caption, contentType: res.mimeType }); photoSent = !(tgRes && tgRes.ok === false); } catch {}
        }
        if (!photoSent && typeof o.send === "function") await o.send("❌ ارسال تصویر به تلگرام ناموفق بود؛ دوباره تلاش کن.");
      } else if (typeof o.send === "function") {
        await o.send(`❌ تولید تصویر در حال حاضر ناموفق بود (${res?.error || "خطای سرویس"})؛ دوباره تلاش کن.`);
      }
      return "handled";
    }
    default:
      return null;
  }
  })();
  if (nluOut === "handled" && nluRoutedTo === "chat") nluRoutedTo = "handled";
  emitNluDiag(null);
  return nluOut;
}
