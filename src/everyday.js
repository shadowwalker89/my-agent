// Step 1b-2: everyday wiring (money, notes, reminders, translate,
// remember, queries, file reference + file branch). Pure classifier in
// daily.js; side effects here. D1 failures never throw.
import { classifyDaily, parseExpense, parseReminder, normalizeText, formatJalali, resolveHourAmbiguousFollowup, mergeHourAmbiguousFollowup, hasDaypartReply, normalizeDaypartToken } from "./daily.js";
import { isRecallQuestionReminder } from "./domain/reminders/parse.js";
export { isRecallQuestionReminder };
import { classifyIntent, MODEL_INTENT_COMBO } from "./intent.js";
import { saveMessage, finalizeMessageKind, redactMessageContent, listProjectsResult, listOpenTasksResult, insertTask, insertProject, listNotesResult, saveVaultItem, listVaultItems, getVaultItem, saveVaultFile, listVaultFiles, getVaultFile, resolvePendingVaultFile, setFileSyncStatus, setVaultSyncStatus, upsertUserFact, exportUserBackupSnapshot } from "./db.js";
import { getDefaultCurrency, setSetting } from "./memory.js";
import { tgApi, sendProgressMessage, sendDocument, sendPhoto, getFileDownloadData } from "./channels/telegram.js"; import { escapeHtml, formatTelegramHtml } from "./pipeline/respond.js";
import { encryptVaultValue, decryptVaultValue, syncVaultItemToGoogle, syncVaultFileToGoogle } from "./vault.js";
import { parseImageGenCommand, generateFreeImage, editImage, analyzeImage, isVisionQuestionCaption, isImageEditCaption } from "./media.js";
import { getConnectorSecret, isConnectorSecretError } from "./connectors.js";
import { handleSetupCommand } from "./admin/setup.js"; import { isPdfAnalysisRequest, analyzePdfDocument, buildImageToPdfBytes, buildTextPdfOrHtmlReport, parsePdfCreateCommand } from "./pdf.js";
import { runReminderTick as runSchedulerReminderTick, makeTelegramSendMessage } from "./platform/scheduler/index.js";
import { mapQuestion, askText, setPendingAsk, slotKind, kindForAskKey, getPendingAsk, clearPendingAsk, askKeyboard, hourAmbiguousKeyboard, sendHourAmbiguousAsk } from "./pipeline/route.js";
import { SEED_PROJECTS, resolveProjects, defaultProjectId, resolveFolderTag, findProjectByName } from "./domain/tasks/projects.js";
import { renderTaskList, resolveTaskCallback as resolveTaskCallbackCore, sendListMessage, TASK_LIST_FAILED_TEXT } from "./domain/tasks/service.js";
export { SEED_PROJECTS, resolveProjects, renderTaskList, TASK_LIST_FAILED_TEXT };
import { renderNoteList, stripLeadingNotePunct, tehranParts, NOTE_LIST_FAILED_TEXT } from "./domain/notes/render.js";
import { resolveNoteCallback as resolveNoteCallbackCore } from "./domain/notes/service.js";
import { startConfirm, confirmExpenseDraft, queryExpenseSums } from "./domain/expenses/service.js";
export { renderNoteList, stripLeadingNotePunct, deriveNoteTitle } from "./domain/notes/render.js";
export { startConfirm, confirmExpenseDraft, rangeForPeriod, queryExpenseSums } from "./domain/expenses/service.js";
import { dbOf, recentMessages, runDb, firstDb, draftKey, askKey, correctionKey, newId, putKv, getKv, delKv, markDaily, markChat, EXPIRED_TEXT, NOT_SAVED_TEXT, UNSUPPORTED_ACTION_TEXT, iranIso, CHAT_CONTEXT_CHAR_LIMIT, buildChatContext, ensureUserRow, quickConvertKeyboard, chatFailureNotice, formatFailureDetail, resolveQuickConvertCallback, resolveChatRetryCallback } from "./pipeline/context.js";
import { runInterpPolicy } from "./pipeline/policy.js";
import { handleInterpreterText } from "./pipeline/interp-runner.js";
import { resolveInterpCallback } from "./pipeline/interp-callbacks.js";
import { runModelBranch as runModelBranchCore } from "./pipeline/model-branch.js";
import { resolveAskCallback } from "./pipeline/ask-callback.js";
import { runNluBranch as runNluBranchCore } from "./pipeline/nlu-branch.js";
import { REF_RE, isUnambiguousQuestion } from "./pipeline/nlu-skip.js";
import { runDailyBranch as runDailyBranchCore } from "./pipeline/daily-branch.js";
import { runSummary as runSummaryCore, SUMMARY_SYSTEM } from "./pipeline/summary.js";
import { VAULT_REDACTED_TEXT } from "./pipeline/daily-helpers.js";
export { SUMMARY_SYSTEM };

export const DAILY_CHAT_PROMPT = "هرگز دستورهای اسلش جعلی مثل /یادداشت، /تسکم، یا /اضافه کردن هزینه به کاربر پیشنهاد نده. کاربر برای ثبت موارد فقط کافی است با زبان طبیعی بنویسد یا ویس بدهد (مثلاً: «یادداشت کن فردا جلسه دارم» یا «امروز ۲۰۰ تومن نون خریدم» یا «خرجای امروز»).";

// Re-exported for back-compat (R0.6): definitions moved to ./pipeline/route.js.
export { mapQuestion, askText, hourAmbiguousKeyboard };
// Re-exported for back-compat (R0.8a): definitions moved to ./pipeline/*, see
// the imports above. The everyday branch dispatcher stays here (R0.8b), so
// runModelBranch / runNluBranch are wrappers injecting it as a dependency.
export { CHAT_CONTEXT_CHAR_LIMIT, buildChatContext, ensureUserRow, quickConvertKeyboard, chatFailureNotice, formatFailureDetail, resolveQuickConvertCallback, resolveChatRetryCallback };
export { runInterpPolicy, handleInterpreterText, resolveInterpCallback, resolveAskCallback, REF_RE, isUnambiguousQuestion };
export async function runModelBranch(env, o, rule, ctx) { return runModelBranchCore(env, o, rule, ctx, { runDailyBranch }); }
export async function runNluBranch(env, o, ctx) { return runNluBranchCore(env, o, ctx, { runDailyBranch, fallbackSendPhoto: sendPhoto }); }

const CONNECTOR_PRIVATE_ONLY_TEXT = "🔒 تنظیم کلید کانکتور فقط در چت خصوصی مجاز است.";





async function runDailyBranch(env, o, c, ctx) {
  return runDailyBranchCore(env, o, c, ctx, { tgApi, sendProgressMessage });
}

async function runSummary(env, o, kind, projectId, userId, retryData = null) {
  return runSummaryCore(env, o, kind, projectId, userId, retryData, { sendProgressMessage });
}


// 1-d-3: note: namespace (delegated to the domain service). The summary
// tap needs runSummary, which stays in this file (it also serves tasks),
// so it is passed in as a dependency instead of an upward import.
export async function resolveNoteCallback(env, o) {
  return resolveNoteCallbackCore(env, o, { runSummary });
}

// 1-b-2: full task: namespace (delegated to the domain service). The
// summary tap needs runSummary, which stays in this file (it also serves
// notes), so it is passed in as a dependency instead of an upward import.
export async function resolveTaskCallback(env, o) {
  return resolveTaskCallbackCore(env, o, { runSummary });
}

export async function runReminderTick(env, opts = {}) {
  return runSchedulerReminderTick(env, {
    ...opts,
    sendMessage: opts.sendMessage ?? makeTelegramSendMessage(tgApi, env),
  });
}
// Phase 3-A: secure file/archive vault helpers.

function stripCaptionPrefix(caption) {
  return String(caption ?? "").replace(/^(?:ذخیره\s*[-:]\s*|ثبت\s*[-:]\s*|ذخیره‌اش\s*کن\s*|ثبت‌اش\s*کن\s*|بذر\s*)/u, "").trim() || null;
}

// Strips a conversational naming prefix ("بذار آخرین آزمایش" -> "آخرین آزمایش").
// Returns null unless an actual naming prefix was present, so a pending
// upload is never renamed by an unrelated message.
function stripNamingPrefix(text) {
  const t = String(text ?? "");
      const m = /^(?:بذار\s+|اسمش\s+رو\s+بذار\s+|عنوانش\s+رو\s+بذار\s+|ذخیره\s*[-:]\s*کن\s*به\s*اسم\s*|ثبت\s*[-:]\s*کن\s+|ذخیره\s+به\s*اسم\s*|ثبت\s+به\s*اسم\s*)\s*([\s\S]+)$/u.exec(t);
  return m ? m[1].trim() || null : null;
}

// Escapes Telegram markdown metacharacters so user content stays literal.
function mdEscape(s) { return String(s ?? "").replace(/\*\*/g, "* *").replace(/`/g, "\\`"); }

function csvField(v) {
  const s = String(v ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function csvRow(...fields) { return fields.map(csvField).join(","); }

async function fileBytesFromTelegram(env, tgFileId) {
  const data = await getFileDownloadData(env, tgFileId);
  if (!data) return null;
  // getFileDownloadData returns { data: ArrayBuffer, filePath, contentType };
  // accept { bytes } / { ok, bytes } too so callers never silently drop a
  // photo because of a shape mismatch.
  const raw = data.bytes ?? data.data ?? data.arrayBuffer ?? data.body ?? null;
  if (raw == null) return null;
  if (raw instanceof Uint8Array) return raw;
  if (typeof raw === "string") {
    try { return raw ? new Uint8Array([...raw].map((c) => c.charCodeAt(0))) : new Uint8Array(0); } catch { return null; }
  }
  try { return new Uint8Array(raw); } catch { return null; }
}

const VAULT_CAPTION_RE = /(?:ذخیره|آرشیو|گاوصندوق|ثبت)\s*(?:کن)?|(?:کارت\s*ملی|شناسنامه|پاسپورت|گواهینامه|بیمه\s*نامه|بیمه‌نامه|آزمایش|سند|مدرک|قرارداد)/i;
const VISION_CAPTION_RE = /(?:تحلیل|بررسی|بخون|بخوان|ترجمه|توضیح|چیه|چیست|خلاصه|OCR)/i;

async function analyzeVaultImage(env, file, prompt, userId = null) {
  const arr = await fileBytesFromTelegram(env, file.tg_file_id);
  let key = null;
  try { key = await getConnectorSecret(env, userId ?? file.user_id ?? null, "gemini"); } catch (e) { if (isConnectorSecretError(e)) throw e; }
  if (!arr || !arr.length || !key) return null;
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  const b64 = btoa(bin);
  const mime = file.mime_type || "image/jpeg";
  const userPrompt = prompt ? `${prompt}\\n` : "";
  const fullPrompt = `${userPrompt}لطفاً این تصویر/فایل را تحلیل کن، متن آن را استخراج کن و به فارسی پاسخ بده.`;
  for (const model of ["gemini-2.5-flash", "gemini-2.0-flash"]) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: fullPrompt }, { inline_data: { mime_type: mime, data: b64 } }] }] }) });
      const json = await res.json().catch(() => null);
      const text = (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
      if (res.ok && text) return text;
    } catch {}
  }
  return null;
}

export async function handleIncomingFile(env, o) {
  return handleVaultFile(env, o);
}

// Case A (caption) / Case B (no caption) for incoming document/photo uploads.
export async function handleVaultFile(env, o) {
  try {
  const { userId, chatId, tgFileId, fileType, mimeType, fileName, caption, send } = o;
  if (!dbOf(env)) return false;
  const cap = typeof caption === "string" ? caption.trim() : "";
  const kind = o.kind || fileType;
  const isPhoto = kind === "photo" || fileType === "photo" || (typeof mimeType === "string" && mimeType.startsWith("image/"));
  if (cap && isPdfAnalysisRequest(cap, mimeType, fileName)) {
    const pdfBytesPdf = await fileBytesFromTelegram(env, tgFileId);
    if (!pdfBytesPdf || !pdfBytesPdf.length) { await send("تحلیل ممکن نشد."); return true; }
    const chatFn = typeof o.chatFn === "function" ? o.chatFn : null;
    const resultPdf = await analyzePdfDocument(env, { pdfBytes: pdfBytesPdf, prompt: cap, userId, fetchFn: o.fetchFn, chatFn, routerCallFn: o.routerCallFn });
    if (resultPdf && resultPdf.ok && resultPdf.text) await send(resultPdf.text);
    else await send(resultPdf?.text || resultPdf?.error || "تحلیل ممکن نشد.");
    return true;
  }
  const mentionsPdf = isPhoto && cap && /(?:\bpdf\b|پی‌دی‌اف|پی\s*دی\s*اف)/i.test(cap);
  const wantsPdf = mentionsPdf && (/^\s*pdf\s*$/i.test(cap) || /(?:تبدیل|ساخت|درست|کن|بساز|بده|برام|برایم|convert|make)/i.test(cap));
  if (wantsPdf) {
    const photoBytesPdf = await fileBytesFromTelegram(env, tgFileId);
    if (!photoBytesPdf || !photoBytesPdf.length) { await send("تبدیل به PDF ممکن نشد."); return true; }
    const pdfBytesOut = buildImageToPdfBytes(photoBytesPdf);
    let pdfSent = false;
    if (typeof o.sendDocument === "function") {
      try { const r = await o.sendDocument(pdfBytesOut, { filename: "photo.pdf", contentType: "application/pdf" }); pdfSent = !(r && r.ok === false); } catch {}
    }
    if (!pdfSent && (env?.TELEGRAM_BOT_TOKEN || env?.TG_TOKEN) && chatId) {
      try { const r = await sendDocument({ ...env, TG_TOKEN: env.TG_TOKEN || env.TELEGRAM_BOT_TOKEN }, chatId, "photo.pdf", pdfBytesOut, { contentType: "application/pdf" }); pdfSent = !(r && r.ok === false); } catch {}
    }
    if (!pdfSent && typeof send === "function") await send("تبدیل به PDF ممکن نشد.");
    return true;
  }
  if (isPhoto && cap && isImageEditCaption(cap)) {
    const bytes = await fileBytesFromTelegram(env, tgFileId);
    if (!bytes || !bytes.length) { await send("ویرایش تصویر ممکن نشد."); return true; }
    const edited = await editImage(env, { imageBytes: bytes, mimeType: mimeType || "image/jpeg", instruction: cap, userId, fetchFn: o.fetchFn });
    if (edited && edited.ok) {
      let photoSent = false;
      if (typeof o.sendPhoto === "function") { await o.sendPhoto(edited.bytes, { caption: "🖼️ تصویر ویرایش‌شده", mimeType: edited.mimeType }); photoSent = true; }
      else if (env?.TELEGRAM_BOT_TOKEN && chatId) { await sendPhoto(env, chatId, "edited.jpg", edited.bytes, { caption: "🖼️ تصویر ویرایش‌شده", contentType: edited.mimeType }); photoSent = true; }
      else if (env?.TG_TOKEN && chatId) { await sendPhoto({ ...env, TELEGRAM_BOT_TOKEN: env.TG_TOKEN }, chatId, "edited.jpg", edited.bytes, { caption: "🖼️ تصویر ویرایش‌شده", contentType: edited.mimeType }); photoSent = true; }
      if (!photoSent && typeof send === "function") await send("🖼️ تصویر ویرایش‌شده آماده شد.");
    } else {
      if (typeof send === "function") await send(edited?.reason || "ویرایش تصویر ممکن نشد.");
    }
    return true;
  }
  if (isPhoto && cap && !VAULT_CAPTION_RE.test(cap)) {
    try {
      const bytes = await fileBytesFromTelegram(env, tgFileId);
      if (!bytes || !bytes.length) { await send("تحلیل ممکن نشد."); return true; }
      const result = await analyzeImage(env, { imageBytes: bytes, mimeType: mimeType || "image/jpeg", prompt: cap, userId, fetchFn: o.fetchFn, routerCallFn: o.routerCallFn });
      if (result && result.ok && result.text) await send(result.text);
      else await send("❌ خطا در تحلیل تصویر: " + (result?.error || result?.text || "vision_unavailable"));
    } catch (e) {
      await send("❌ خطا در تحلیل تصویر: " + (e?.message || "vision_unavailable"));
    }
    return true;
  }
  // Case 1: explicit vault caption
  if (cap && VAULT_CAPTION_RE.test(cap)) {
    const title = stripCaptionPrefix(cap) || stripNamingPrefix(cap) || cap;
    const saved = await saveVaultFile(env, { userId, tgFileId, fileType, mimeType, title, fileName, caption: cap, syncStatus: "local" });
    if (!saved || !saved.ok) { await send(NOT_SAVED_TEXT); return true; }
    let syncInfo = "";
    if (saved.ok) {
      const bytes = await fileBytesFromTelegram(env, tgFileId);
      const sync = await syncVaultFileToGoogle(env, { id: saved.id, userId, label: title, fileName, mimeType, data: bytes ?? new Uint8Array(0), createdAt: new Date().toISOString() });
      await setFileSyncStatus(env, userId, saved.id, sync.ok ? "synced" : "pending_google", sync.googleId ?? null, null);
      syncInfo = sync.ok ? `\\n✅ گوگل Docs/Drive${sync.googleId ? ` (${sync.googleId})` : ""}: ذخیره شد` : "\\n⏳ در انتظار همگام‌سازی گوگل";
    }
    await send(`🔒📁 مدرک «**${mdEscape(title)}**» در آرشیو امن ذخیره شد.${syncInfo}`);
    return true;
  }
  // Case 2: explicit vision/analysis caption
  if (cap && VISION_CAPTION_RE.test(cap)) {
    const bytes2 = await fileBytesFromTelegram(env, tgFileId);
    let visionError = null;
    if (bytes2 && bytes2.length) {
      const r2 = await analyzeImage(env, { imageBytes: bytes2, mimeType: mimeType || "image/jpeg", prompt: cap, userId, fetchFn: o.fetchFn, routerCallFn: o.routerCallFn });
      if (r2 && r2.ok && r2.text) { await send(r2.text); return true; }
      visionError = r2?.error || r2?.text || null;
    }
    const f = { tg_file_id: tgFileId, mime_type: mimeType, file_type: fileType };
    const text = await analyzeVaultImage(env, f, cap, userId);
    await send(text || ("❌ خطا در تحلیل تصویر: " + (visionError || "vision_unavailable")));
    return true;
  }
  // Case 3: no caption / general caption -> choice buttons
  const saved = await saveVaultFile(env, { userId, tgFileId, fileType, mimeType, title: "__choice__", fileName, caption: cap || null, syncStatus: "local" });
  if (!saved.ok) { await send(NOT_SAVED_TEXT); return true; }
  await send("📎 <b>تصویر/فایل دریافت شد. چه کاری انجام دهم؟</b>", { replyMarkup: { inline_keyboard: [
    [{ text: "🔍 تحلیل تصویر / استخراج متن", callback_data: `vault:analyze:${saved.id}` }],
    [{ text: "🔒 ذخیره در گاوصندوق امن", callback_data: `vault:askname:${saved.id}` }],
    [{ text: "❌ انصراف", callback_data: `vault:cancel:${saved.id}` }],
  ] } });
  return true;
  } catch (e) {
    if (isConnectorSecretError(e)) {
      if (typeof o.send === "function") await o.send("❌ کلید کانکتور قابل خواندن نیست؛ لطفاً دوباره تنظیم کنید.");
      return true;
    }
    throw e;
  }
}

// Next-turn naming for a pending __pending__ vault upload. Returns true when
// the incoming text/voice named the file.
async function namePendingVaultFile(env, o) {
  const { userId, text, send } = o;
  if (!text || /^\s*\//.test(text)) return false;
  // A07 escape hatch: never consume the user's next turn as a pending-file
  // name when the turn is actually an actionable message or a command.
  const trimmed = String(text).trim();
  const cg = classifyDaily(trimmed, { nowMs: o.nowMs ?? Date.now() });
  if (["note", "task", "task-create", "task-delete", "reminder", "expense", "income", "memory_save", "unsupported_action", "vault_save", "vault_get", "vault_list", "vault_file_get", "command"].includes(cg.intent)) return false;
  if (/(?:یادداشت|تسک|یادآوری)\s*کن/u.test(trimmed) || /یادداشت[^\n]{0,24}(?:ثبت|ذخیره)\s*کن/u.test(trimmed) || /^ثبت\s*کن(?:\s|$)/u.test(trimmed)) return false;
  if (/لغو|انصراف/.test(trimmed)) return false;
  const cleanTitle = stripNamingPrefix(text) || trimmed;
  if (!cleanTitle) return false;
  let pend = await resolvePendingVaultFile(env, Number(userId), cleanTitle);
  if (!pend.ok || !pend.file) {
    pend = await resolvePendingVaultFile(env, userId, cleanTitle);
  }
  if (!pend.ok || !pend.file) return false;
  const f = pend.file;
  const bytes = await fileBytesFromTelegram(env, f.tg_file_id);
  const sync = await syncVaultFileToGoogle(env, { id: f.id, userId, label: f.title, fileName: f.fileName, mimeType: f.mimeType, data: bytes ?? new Uint8Array(0), createdAt: f.created_at });
  await setFileSyncStatus(env, userId, f.id, sync.ok ? "synced" : "pending_google", sync.googleId ?? null, null);
  // A15 honesty: claim Google Docs only when Google actually synced with an id.
  if (sync.ok && sync.googleId) {
    await send(`🔒📁 مدرک «<b>${cleanTitle}</b>» در آرشیو امن و Google Docs ثبت شد.`);
  } else {
    await send(`✅ نام فایل ثبت شد: **${cleanTitle}**${sync.ok ? "" : "\n⏳ در انتظار همگام‌سازی گوگل"}`);
  }
  return true;
}

// Vault callbacks: vault:csv, vault:sync, vault:file:<id>.
export async function resolveVaultCallback(env, o) {
  try {
  const analyze = /^vault:analyze:(\d+)$/.exec(o.data);
  if (analyze) {
    const id = Number(analyze[1]);
    const f = await getVaultFile(env, o.fromId, id);
    if (!f) { await o.send("مدرکی پیدا نشد."); return true; }
    const text = await analyzeVaultImage(env, f, null, o.fromId);
    await o.send(text || "تحلیل ممکن نشد.");
    return true;
  }
  const askname = /^vault:askname:(\d+)$/.exec(o.data);
  if (askname) {
    const id = Number(askname[1]);
    const f = await getVaultFile(env, o.fromId, id);
    if (!f) { await o.send("مدرکی پیدا نشد."); return true; }
    const cap = typeof f.caption === "string" ? f.caption.trim() : "";
    if (cap) {
      await runDb(env, "UPDATE vault_files SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?", [cap, new Date().toISOString(), id, o.fromId]);
      const row = await getVaultFile(env, o.fromId, id);
      const bytes = await fileBytesFromTelegram(env, f.tg_file_id);
      const sync = await syncVaultFileToGoogle(env, { id, userId: o.fromId, label: cap, fileName: f.file_name, mimeType: f.mime_type, data: bytes ?? new Uint8Array(0), createdAt: f.created_at });
      await setFileSyncStatus(env, o.fromId, id, sync.ok ? "synced" : "pending_google", sync.googleId ?? null, null);
      await o.send(`🔒📁 مدرک «<b>${cap}</b>» در گاوصندوق امن ذخیره شد.`);
      return true;
    }
    await runDb(env, "UPDATE vault_files SET title = '__pending__', updated_at = ? WHERE id = ? AND user_id = ?", [new Date().toISOString(), id, o.fromId]);
    await o.send("🔒 با چه عنوانی در گاوصندوق امن ذخیره شود؟ (مثلاً بنویسید یا ویس بدهید: «بیمه نامه ۲۰۶» یا «آخرین آزمایش»)");
    return true;
  }
  const cancel = /^vault:cancel:(\d+)$/.exec(o.data);
  if (cancel) {
    const id = Number(cancel[1]);
    await runDb(env, "DELETE FROM vault_files WHERE id = ? AND user_id = ?", [id, o.fromId]);
    if (typeof o.editText === "function") { try { const r = await o.editText("❌ لغو شد."); if (r && r.ok !== false) return true; } catch {} }
    await o.send("❌ لغو شد.");
    return true;
  }
  const csv = /^vault:csv$/.exec(o.data);
  if (csv) {
    const items = (await listVaultItems(env, o.fromId)).items || [];
    const lines = ["ID,Category,Title,Value,Extra,UpdatedAt"];
    for (const it of items) {
      const row = await getVaultItem(env, o.fromId, it.id);
      let value = "";
      try { if (row) value = await decryptVaultValue(env, row.value_enc); } catch {}
      lines.push(csvRow(it.id, it.category ?? "", it.label ?? "", value, it.extra ?? "", it.updated_at ?? ""));
    }
    const body = "\uFEFF" + lines.join("\r\n") + "\r\n";
    await sendDocument(env, o.chatId, "personal-vault.csv", body, { contentType: "text/csv" });
    return true;
  }
  const sync = /^vault:sync$/.exec(o.data);
  if (sync) {
    let done = 0, failed = 0;
    const items = (await listVaultItems(env, o.fromId)).items || [];
    for (const it of items) {
      if (it.sync_status === "synced") continue;
      let value = "";
      try { value = await decryptVaultValue(env, it.value_enc); } catch {}
      const r = await syncVaultItemToGoogle(env, { id: it.id, userId: o.fromId, label: it.label, value, kind: "text", createdAt: it.created_at });
      await setVaultSyncStatus(env, o.fromId, it.id, r.ok ? "synced" : "pending_google", r.googleId ?? null);
      r.ok ? done++ : failed++;
    }
    const files = (await listVaultFiles(env, o.fromId)).files || [];
    for (const f of files) {
      if (f.sync_status === "synced") continue;
      const bytes = await fileBytesFromTelegram(env, f.tg_file_id);
      const r = await syncVaultFileToGoogle(env, { id: f.id, userId: o.fromId, label: f.title, fileName: f.fileName, mimeType: f.mimeType, data: bytes ?? new Uint8Array(0), createdAt: f.created_at });
      await setFileSyncStatus(env, o.fromId, f.id, r.ok ? "synced" : "pending_google", r.googleId ?? null, null);
      r.ok ? done++ : failed++;
    }
    await o.send(`✅ همگام‌سازی گوگل تمام شد: ${done} موفق، ${failed} ناموفق.`);
    return true;
  }
  const file = /^vault:file:(\d+)$/.exec(o.data);
  if (file) {
    const fid = Number(file[1]);
    if (!Number.isSafeInteger(fid) || fid <= 0) return true;
    const f = await getVaultFile(env, o.fromId, fid);
    if (!f) { await o.send("مدرکی پیدا نشد."); return true; }
    const tp = tehranParts(f.created_at);
    const when = tp ? `${formatJalali(tp.date) || tp.date} ${tp.hhmm}` : "";
    const caption = `🔒📁 **${f.title ?? ""}**${when ? `\n🗓 ${when}` : ""}${f.doc_url ? `\n${f.doc_url}` : ""}`;
    const formatted = formatTelegramHtml(caption);
    const payload = { chat_id: o.chatId, caption: formatted, ...(formatted !== caption ? { parse_mode: "HTML" } : {}) };
    if (f.file_type === "photo") await tgApi(env, "sendPhoto", { ...payload, photo: f.tg_file_id });
    else await tgApi(env, "sendDocument", { ...payload, document: f.tg_file_id });
    return true;
  }
  return false;
  } catch (e) {
    if (isConnectorSecretError(e)) {
      if (typeof o.send === "function") await o.send("❌ کلید کانکتور قابل خواندن نیست؛ لطفاً دوباره تنظیم کنید.");
      return true;
    }
    throw e;
  }
}

export async function handleDailyText(env, o) {
  try {
  const { userId, text } = o;
  const now = o.nowMs ?? Date.now();
  if (!dbOf(env)) { await clearPendingAsk(env, userId); return "chat"; } // D1 unavailable: everyday off, chat keeps working
  {
    const raw = String(text ?? "").trim();
    const isBackup = raw === "/backup" || raw === "بکاپ اطلاعات" || raw === "پشتیبان‌گیری";
    const handled = await handleSetupCommand(env, o);
    if (handled === "handled") return "handled";
    if (isBackup) {
      const snap = await exportUserBackupSnapshot(env, userId, { nowMs: now });
      const json = JSON.stringify(snap, null, 2);
      const c = snap.counts ?? {};
      try {
        if (typeof o.sendDocument === "function") { await o.sendDocument(json, { filename: `backup-${userId}.json`, contentType: "application/json" }); }
        else if ((env?.TELEGRAM_BOT_TOKEN || env?.TG_TOKEN) && o.chatId) {
          await sendDocument({ ...env, TG_TOKEN: env.TG_TOKEN || env.TELEGRAM_BOT_TOKEN }, o.chatId, `backup-${userId}.json`, json, { contentType: "application/json" });
        }
      } catch {}
      if (typeof o.send === "function") await o.send(`📦 بکاپ اطلاعات آماده شد:\nیادداشت‌ها: ${c.notes ?? 0}\nتسک‌ها: ${c.tasks ?? 0}\nهزینه‌ها: ${c.expenses ?? 0}\nپروژه‌ها: ${c.projects ?? 0}\nتنظیمات: ${c.settings ?? 0}\nحقایق حافظه: ${c.user_facts ?? 0}\nگاوصندوق رمزنگاری‌شده: ${c.vault_items ?? 0}`);
      return "handled";
    }
  }
  // Reply-to-photo: a reply to a generated image is ALWAYS a follow-up edit,
  // whatever the wording. Editing uses the original scene + the new request.
  // Every other photo reply goes to vision. A photo reply must never fall
  // through to blind text-only chat.
  const replyPhoto = o.replyToPhoto && (o.replyToPhoto.fileId || o.replyToPhoto.file_id) ? o.replyToPhoto : null;
  const replyUserText = String(text ?? "").trim();
  if (replyPhoto && !replyUserText.startsWith("/")) {
    const rpFileId = replyPhoto.fileId || replyPhoto.file_id;
    const rpCaption = String(replyPhoto.caption ?? "");
    const userText = replyUserText;
    const targetChatId = o.chatId ?? o.userId ?? userId;
    const isGeneratedCaption = /🎨 تصویر (?:ساخته|ویرایش) شد/.test(rpCaption);
    const isPureQuestion = /[?؟]|(?:^|[^\u0600-\u06FF])(?:چیه|کیه|کجاست|چنده|چقدر)(?![\u0600-\u06FF])/u.test(userText);
    const askedQuestion = isPureQuestion || isVisionQuestionCaption(userText);
    const generatedFollowUp = isGeneratedCaption && !isPureQuestion;
    const askedEdit = generatedFollowUp || (!isGeneratedCaption && !askedQuestion && isImageEditCaption(userText));
    const sendEditedPhoto = async (bytes, mimeType, caption) => {
      let ok = false;
      if (typeof o.sendPhoto === "function") {
        try { const r = await o.sendPhoto(bytes, { caption, mimeType, filename: "edited.png" }); ok = !(r && r.ok === false); } catch {}
      }
      if (!ok && (env?.TELEGRAM_BOT_TOKEN || env?.TG_TOKEN) && targetChatId) {
        try { const r = await sendPhoto({ ...env, TG_TOKEN: env.TG_TOKEN || env.TELEGRAM_BOT_TOKEN }, targetChatId, "edited.png", bytes, { caption, contentType: mimeType }); ok = !(r && r.ok === false); } catch {}
      }
      if (!ok && typeof o.send === "function") await o.send("❌ ارسال تصویر به تلگرام ناموفق بود؛ دوباره تلاش کن.");
      return ok;
    };
    if (askedEdit) {
      if (typeof o.send === "function") await o.send("🎨 در حال ویرایش تصویر، لطفاً چند ثانیه صبر کنید...");
      let basePrompt = rpCaption.replace(/^🎨 تصویر (?:ساخته|ویرایش) شد(?:\s*\([^)]*\))?\s*:\s*/u, "").trim();
      let result = null;
      if (generatedFollowUp) {
        const scene = basePrompt || "the scene in the generated image";
        const combined = `${scene} — تغییرات: ${userText}`;
        const generated = await generateFreeImage(env, combined, { userId: o.userId ?? userId, fetchFn: o.fetchFn, routerCallFn: o.routerCallFn });
        if (generated && generated.ok) result = generated;
      } else {
        const imageBytes = await fileBytesFromTelegram(env, rpFileId);
        if (!basePrompt && imageBytes && imageBytes.length) {
          const desc = await analyzeImage(env, { imageBytes, mimeType: "image/jpeg", prompt: "این تصویر را کوتاه و دقیق به فارسی توصیف کن.", userId, fetchFn: o.fetchFn, routerCallFn: o.routerCallFn });
          if (desc && desc.ok && desc.text) basePrompt = desc.text;
        }
        if (!basePrompt) basePrompt = "the scene in the attached image";
        const negatives = [];
        if (/(ادم|آدم|افراد|مردم|person|people)/i.test(userText)) negatives.push("no people, empty street");
        if (/(الودگی|آلای|دود|مه‌آلود|مه آلود|pollution|smog)/i.test(userText)) negatives.push("clear blue sky without pollution");
        const negativeText = negatives.length ? ` Negative constraints: ${negatives.join(", ")}.` : "";
        const instruction = `Apply this edit to the scene: ${basePrompt}. User edit request: ${userText}.${negativeText}`;
        if (imageBytes && imageBytes.length) {
          const edited = await editImage(env, { imageBytes, mimeType: "image/jpeg", instruction, userId, fetchFn: o.fetchFn });
          if (edited && edited.ok) result = edited;
        }
        if (!result) {
          const generated = await generateFreeImage(env, instruction, { userId: o.userId ?? userId, fetchFn: o.fetchFn, routerCallFn: o.routerCallFn });
          if (generated && generated.ok) result = generated;
        }
      }
      if (result && result.ok) {
        const captionScene = basePrompt || "the scene in the attached image";
        let editCaption = `🎨 تصویر ویرایش شد (${result.provider}): ${captionScene} (${userText})`;
        if (result.provider === "pollinations" && result.diagErrors?.length) editCaption += `\n⚠️ دیباگ موتور اصلی: ${result.diagErrors.slice(0, 3).join(" | ")}`;
        await sendEditedPhoto(result.bytes, result.mimeType, editCaption);
      } else if (typeof o.send === "function") {
        await o.send("ویرایش تصویر ممکن نشد؛ دوباره تلاش کن.");
      }
      return "handled";
    }
    // Not an edit: analyze/answer with vision using the user's own wording.
    const imageBytes = await fileBytesFromTelegram(env, rpFileId);
    if (!imageBytes || !imageBytes.length) {
      if (typeof o.send === "function") await o.send("تحلیل تصویر ممکن نشد.");
      return "handled";
    }
    const result = await analyzeImage(env, { imageBytes, mimeType: "image/jpeg", prompt: userText, userId: o.userId ?? userId, fetchFn: o.fetchFn, routerCallFn: o.routerCallFn });
    if (typeof o.send === "function") {
      await o.send(result && result.ok && result.text ? result.text : "❌ خطا در تحلیل تصویر: " + (result?.error || result?.text || "vision_unavailable"));
    }
    return "handled";
  }
  const parsedImage = parseImageGenCommand(text);
  if (parsedImage.isImageGen) {
    const targetChatId = o.chatId ?? o.userId ?? userId;
    try {
      if (typeof o.send === "function") await o.send("🎨 در حال ساخت تصویر، لطفاً چند ثانیه صبر کنید...");
      const res = await generateFreeImage(env, parsedImage.prompt, { userId, fetchFn: o.fetchFn, routerCallFn: o.routerCallFn });
      if (res && res.ok) {
        let caption = `🎨 تصویر ساخته شد (${res.provider || "auto"}): ${parsedImage.prompt}`;
        if (res.provider === "pollinations" && res.diagErrors?.length) caption += `\n⚠️ دیباگ موتور اصلی: ${res.diagErrors.slice(0, 3).join(" | ")}`;
        let photoSent = false;
        if (typeof o.sendPhoto === "function") {
          try {
            const tgRes = await o.sendPhoto(res.bytes, { caption, mimeType: res.mimeType, filename: "generated.png" });
            photoSent = !(tgRes && tgRes.ok === false);
          } catch {}
        }
        if (!photoSent && (env?.TELEGRAM_BOT_TOKEN || env?.TG_TOKEN) && targetChatId) {
          try {
            const tgRes = await sendPhoto({ ...env, TG_TOKEN: env.TG_TOKEN || env.TELEGRAM_BOT_TOKEN }, targetChatId, "generated.png", res.bytes, { caption, contentType: res.mimeType });
            photoSent = !(tgRes && tgRes.ok === false);
          } catch {}
        }
        if (!photoSent && typeof o.send === "function") await o.send("❌ ارسال تصویر به تلگرام ناموفق بود؛ دوباره تلاش کن.");
      } else {
        if (typeof o.send === "function") await o.send(`❌ تولید تصویر در حال حاضر ناموفق بود (${res?.error || "خطای سرویس"})؛ دوباره تلاش کن.`);
      }
    } catch {
      if (typeof o.send === "function") await o.send("❌ تولید تصویر در حال حاضر ناموفق بود؛ دوباره تلاش کن.");
    }
    return "handled";
  }
  const parsedPdf = parsePdfCreateCommand(text);
  if (parsedPdf && parsedPdf.isPdfCreate && parsedPdf.text) {
    const reportPdf = buildTextPdfOrHtmlReport(parsedPdf.title || "سند", parsedPdf.bodyText || parsedPdf.text);
    let pdfSent = false;
    if (typeof o.sendDocument === "function") { await o.sendDocument(reportPdf.pdfBytes, { filename: "report.pdf", contentType: "application/pdf" }); pdfSent = true; }
    else if ((env?.TELEGRAM_BOT_TOKEN || env?.TG_TOKEN) && o.chatId) { await sendDocument({ ...env, TG_TOKEN: env.TG_TOKEN || env.TELEGRAM_BOT_TOKEN }, o.chatId, "report.pdf", reportPdf.pdfBytes, { contentType: "application/pdf" }); pdfSent = true; }
    if (typeof o.send === "function") await o.send("📄 PDF آماده شد.");
    return "handled";
  }
  // Phase 3-A: name a pending __pending__ vault upload on the next turn
  // (text message or voice transcript). At the very top, before classifyDaily.
  if (text && !/^\s*\//.test(text)) {
    const named = await namePendingVaultFile(env, o);
    if (named) { return "handled"; }
  }
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
  const entry = await saveMessage(env, { userId, role: "user", content: c.intent === "vault_save" ? VAULT_REDACTED_TEXT : text, kind: "pending" });
  if (entry.ok) o.entryMessageId = entry.id; else o._entrySaveFailed = true;
  // 1-d-5 voice echo + chat wrap (placed AFTER the entry save so the
  // entry id is known, BEFORE any branch sends):
  // (a) send wrap: the voice header prepends to the FIRST o.send only
  // (a flag, not per-call), so list chunks after the first stay clean.
  // (b) chat wrap: every model call's options inherit the voice header
  // and the retry/quick-convert ids (the entry id) UNLESS the call site
  // set them explicitly; a call site that set retryData (the summary
  // re-tap) suppresses the chat retry, so a failed summary offers exactly
  // one retry — the summary itself — plus quick-convert for the entry.
  if (o.voiceHeader && o.send) { const rawSend = o.send; let headerSent = false; o.send = async (t, sopts) => { if (!headerSent) { headerSent = true; return rawSend(o.voiceHeader + t, sopts); } return rawSend(t, sopts); }; }
  if (o.chat) { const rawChat = o.chat; o.chat = (t, copts = {}) => rawChat(t, { ...copts, ...(o.voiceHeader && !copts.voiceHeader ? { voiceHeader: o.voiceHeader } : {}), ...(o.entryMessageId && copts.excludeMessageId == null ? { excludeMessageId: o.entryMessageId } : {}), ...(o.entryMessageId && !copts.retryEntryId && !copts.retryData ? { retryEntryId: o.entryMessageId } : {}), ...(o.entryMessageId && !copts.quickConvertId ? { quickConvertId: o.entryMessageId } : {}) }); }
  const finalizeEntry = async (kind) => { if (o.entryMessageId && !o._entryFinalised) { o._entryFinalised = true; await finalizeMessageKind(env, o.entryMessageId, userId, kind); } };
  const viaBranch = async (cc) => { const r = await runDailyBranch(env, o, cc, ctx); await finalizeEntry(r === "chat" ? "chat" : "daily"); return r; };
  if ((c.intent === "reminder" || c.intent === "remember") && isRecallQuestionReminder(text)) { await clearPendingAsk(env, userId); await finalizeEntry("chat"); return "chat"; }
  // Bare-note ask bypasses the model step: the model is exactly what
  // failed live for bare notes (chat verdict -> hallucinated storage).
  // runDailyBranch asks for the text and sets the note-text slot itself.
  if (c.intent === "ask" && c.question === "note-text") { await clearPendingAsk(env, userId); return viaBranch(c); }
  // Fast money path (unchanged): rule-confident expense/income only.
  if (c.intent === "expense" || c.intent === "income") { await clearPendingAsk(env, userId); return viaBranch(c); }
  // Rule task list (1-b-1): direct to the list render, never to the model
  // step or the interpreter gate; clears any stale slot first.
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
  // Answers to an open bot question keep the existing slot path.
  let slot = await getPendingAsk(env, userId);
  // 1-d-6: an hour-ambiguous slot must be fully discharged HERE, before
  // any model branch — the 1-c-3 fill alone left a trap: when it
  // returned null, the slot stayed set and runModelBranch re-asked the
  // same question forever (model-failure re-ask, or a chat+followup
  // verdict). Discharge rules, in order:
  //   filled -> clear + store the reminder (unchanged 1-c-3 path);
  //   merged but still-ambiguous -> re-ask ONCE with the ORIGINAL
  //     pendingBody preserved (routing the reply itself would lose it);
  //   merged but otherwise unparseable (past/empty/...) -> clear +
  //     normal reminder branch with that ask, so the user gets a
  //     meaningful message, never the same question again;
  //   unfillable (no daypart shape, or no usable pendingBody) -> clear
  //     the slot and fall through to the normal pipeline below (slot
  //     nulled, so the model branch below cannot re-ask it).
  if (slot && slotKind(slot) === "hour-ambiguous") {
    // Phase 1-e Pillar 3: cancel text never reaches free chat — it
    // clears the slot and confirms, with 0 model calls.
    if (normalizeDaypartToken(text) === "cancel") {
      await clearPendingAsk(env, userId);
      await o.send("❌ یادآوری لغو شد.");
      await finalizeEntry("daily");
      return "handled";
    }
    // Phase 1-e Pillar 3: a short 1-word token (<= 10 chars, no spaces,
    // not a question, not a daypart shape, no rule match) is held, not
    // dumped into chat — but only after the AI interpreter gets its
    // chance when available: a confident daypart_reply resolves through
    // the fill below with the canonical daypart word, and any other
    // confident non-chat verdict discharges the slot into the normal
    // pipeline (which re-runs the NLU). Longer messages and real
    // questions skip this block entirely and discharge below.
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
  // 1-d-1: interpreter unconfigured -> NO model classifier for UNMATCHED
  // (chat-tier) messages. The 80-token classifyDailyWithModel misroutes
  // voice/chat messages, so an unmatched message goes straight to the
  // chat combo (the caller builds full buildChatContext) with zero
  // model calls. Ask-tier messages DID match a deterministic rule, so
  // above (runModelBranch), where a model verdict is only a branch
  // picker re-validated by rule code. Ask-tier messages DID match a
  // deterministic rule (the ask), so they keep the model path below.
  // Phase 2-l: NLU path — runs when the Workers AI binding exists AND no
  // explicit legacy interpreter is configured on this call object. The outer
  // guard no longer checks env.INTERPRETER_MODEL so the NLU activates in
  // production even when wrangler.jsonc sets INTERPRETER_MODEL (that var only
  // governs resolveInterpreterModel, which the NLU prompt uses internally).
  // Legacy interpreter tests always supply o.interpreterCallFn or
  // o.interpreterModel on mkO(), so they fall through to handleInterpreterText
  // unchanged — no existing test is affected.
  if (!o.interpreterCallFn && !o.interpreterModel) {
    if (env?.AI && typeof env.AI.run === "function") {
      const nluHandled = await runNluBranch(env, o, ctx);
      if (nluHandled !== null) { await finalizeEntry(nluHandled === "chat" ? "chat" : "daily"); return nluHandled; }
    }
    if (c.intent === "chat") { await finalizeEntry("chat"); return "chat"; }
    // ask-tier with no AI binding: use the 80-token model slot picker.
    if (!env.INTERPRETER_MODEL) {
      const { ret, outcome, ms } = await runModelBranch(env, o, c, ctx);
      console.log(JSON.stringify({ modelIntent: MODEL_INTENT_COMBO, tier: c.intent, ms, outcome }));
      await finalizeEntry(ret === "handled" ? "daily" : "chat");
      return ret;
    }
    // INTERPRETER_MODEL set but no AI binding and no interpreterCallFn/Model:
    // fall through to the legacy interpreter path below.
  }
  // Everything else goes to the interpreter, never directly to chat.
  return handleInterpreterText(env, o, ctx);
  } catch (e) {
    if (isConnectorSecretError(e)) {
      if (typeof o.send === "function") await o.send("❌ کلید کانکتور قابل خواندن نیست؛ لطفاً دوباره تنظیم کنید.");
      return "handled";
    }
    throw e;
  }
}

// daily: callbacks. Returns true when the data was a daily: callback.
// Forbidden callbacks send nothing, store nothing, and delete nothing.
export async function resolveDailyCallback(env, o) {
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
    // 1-b-3 (amendment 6): compensation — the expense is stored and the
    // task was separately completed, so it stays in the archive; the
    // expense becomes the correction pointer, never a delete claim.
    if (r.status === "converted-done") { if (r.id) await putKv(env, correctionKey(o.fromId), { table: "expenses", id: r.id }); await o.editMarkup(); await o.send("💰 خرج ذخیره شد؛ تسک پیش‌تر جداگانه انجام شده بود و در بایگانی می‌ماند."); return true; }
    // 1-b-3 (amendment 6): an expense row for this draft already exists
    // but the task is gone — the conversion did not complete; the draft
    // is kept and Cancel stays available, retry re-checks, never re-inserts.
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
    send: (msgText, opts) => {
      const formatted = formatTelegramHtml(String(msgText ?? ""));
      return tgApi(env, "sendMessage", { chat_id: chatId, text: formatted, ...(formatted !== String(msgText ?? "") ? { parse_mode: "HTML" } : {}), ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}) });
    },
    editMarkup: () => tgApi(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    // Phase 2-d: edit the original message's text in place and drop
    // its buttons (reply_markup: []); null when there is no message
    // id to edit, so callers fall back to markup-clear + send.
    editText: (text) => Number.isInteger(messageId) && messageId > 0
      ? tgApi(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } })
      : Promise.resolve(null),
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
