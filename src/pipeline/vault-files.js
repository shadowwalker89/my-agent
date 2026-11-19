import { dbOf, NOT_SAVED_TEXT } from "./context.js";
import { classifyDaily } from "../daily.js";
import { saveVaultFile, setFileSyncStatus, resolvePendingVaultFile } from "../db.js";
import { syncVaultFileToGoogle } from "../vault.js";
import { getConnectorSecret, isConnectorSecretError } from "../connectors.js";
import { isPdfAnalysisRequest, analyzePdfDocument, buildImageToPdfBytes } from "../pdf.js";
import { analyzeImage, editImage, isImageEditCaption } from "../media.js";
import { looksSecret } from "./secret-shape.js";

export const SECRET_CAPTION_NOTICE = "🔒 کپشن شبیه شماره کارت یا شبا بود؛ برای امنیت نادیده گرفته شد و ذخیره نشد. فایل بدون کپشن بایگانی شد.";

export function stripCaptionPrefix(caption) {
  return String(caption ?? "").replace(/^(?:ذخیره\s*[-:]\s*|ثبت\s*[-:]\s*|ذخیره‌اش\s*کن\s*|ثبت‌اش\s*کن\s*|بذر\s*)/u, "").trim() || null;
}

export function stripNamingPrefix(text) {
  const t = String(text ?? "");
  const m = /^(?:بذار\s+|اسمش\s+رو\s+بذار\s+|عنوانش\s+رو\s+بذار\s+|ذخیره\s*[-:]\s*کن\s*به\s*اسم\s*|ثبت\s*[-:]\s*کن\s+|ذخیره\s+به\s*اسم\s*|ثبت\s+به\s*اسم\s*)\s*([\s\S]+)$/u.exec(t);
  return m ? m[1].trim() || null : null;
}

function mdEscape(s) { return String(s ?? "").replace(/\*\*/g, "* *").replace(/`/g, "\\`"); }

function csvField(v) {
  const s = String(v ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(...fields) { return fields.map(csvField).join(","); }

export async function fileBytesFromTelegram(env, tgFileId, deps = {}) {
  const getFileDownloadData = deps.getFileDownloadData;
  if (!getFileDownloadData) return null;
  const data = await getFileDownloadData(env, tgFileId);
  if (!data) return null;
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

export async function analyzeVaultImageDetailed(env, file, prompt, userId = null, deps = {}) {
  const arr = await fileBytesFromTelegram(env, file.tg_file_id, deps);
  if (!arr || !arr.length) return { ok: false, reason: "no_download" };
  let key = null;
  try { key = await getConnectorSecret(env, userId ?? file.user_id ?? null, "gemini"); } catch (e) { if (isConnectorSecretError(e)) throw e; }
  if (!key) return { ok: false, reason: "no_key" };
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  const b64 = btoa(bin);
  const mime = file.mime_type || "image/jpeg";
  const userPrompt = prompt ? `${prompt}\n` : "";
  const fullPrompt = `${userPrompt}لطفاً این تصویر/فایل را تحلیل کن، متن آن را استخراج کن و به فارسی پاسخ بده.`;
  let primaryReason = null;
  for (const model of ["gemini-2.5-flash", "gemini-2.0-flash"]) {
    let reason = null;
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: fullPrompt }, { inline_data: { mime_type: mime, data: b64 } }] }] }) });
      const json = await res.json().catch(() => null);
      const text = (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
      if (res.ok && text) return { ok: true, text };
      const status = Number(res.status);
      reason = res.ok ? "empty_response" : (Number.isInteger(status) && status > 0 ? `http_${status}` : "network_error");
    } catch { reason = "network_error"; }
    if (primaryReason === null) primaryReason = reason;
    console.warn("vault_analyze_failed", { model, reason });
  }
  return { ok: false, reason: primaryReason };
}

export async function analyzeVaultImage(env, file, prompt, userId = null, deps = {}) {
  const r = await analyzeVaultImageDetailed(env, file, prompt, userId, deps);
  return r.ok ? r.text : null;
}

export function vaultAnalyzeFailureText(reason) {
  const r = String(reason ?? "");
  if (r === "no_download") return "تحلیل ممکن نشد: دانلود فایل از تلگرام انجام نشد.";
  if (r === "no_key") return "تحلیل ممکن نشد: کلید Gemini تنظیم نشده است.";
  if (r === "empty_response") return "تحلیل ممکن نشد: Gemini متنی برنگرداند.";
  if (r === "network_error") return "تحلیل ممکن نشد: ارتباط با Gemini برقرار نشد.";
  const m = /^http_(\d+)$/.exec(r);
  if (m) return `تحلیل ممکن نشد: Gemini خطا داد (کد ${m[1]}).`;
  return "تحلیل ممکن نشد.";
}

export async function handleIncomingFile(env, o, deps = {}) {
  return handleVaultFile(env, o, deps);
}

export async function handleVaultFile(env, o, deps = {}) {
  try {
  const { userId, chatId, tgFileId, fileType, mimeType, fileName, caption, send } = o;
  if (!dbOf(env)) return false;
  const rawFileName = fileName ?? null;
  const safeFileName = looksSecret(rawFileName) ? null : rawFileName;
  const rawCaption = typeof caption === "string" ? caption.trim() : "";
  const secretCaption = looksSecret(rawCaption);
  const cap = secretCaption ? "" : rawCaption;
  const kind = o.kind || fileType;
  const isPhoto = kind === "photo" || fileType === "photo" || (typeof mimeType === "string" && mimeType.startsWith("image/"));
  if (cap && isPdfAnalysisRequest(cap, mimeType, rawFileName)) {
    const pdfBytesPdf = await fileBytesFromTelegram(env, tgFileId, deps);
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
    const photoBytesPdf = await fileBytesFromTelegram(env, tgFileId, deps);
    if (!photoBytesPdf || !photoBytesPdf.length) { await send("تبدیل به PDF ممکن نشد."); return true; }
    const pdfBytesOut = buildImageToPdfBytes(photoBytesPdf);
    let pdfSent = false;
    if (typeof o.sendDocument === "function") {
      try { const r = await o.sendDocument(pdfBytesOut, { filename: "photo.pdf", contentType: "application/pdf" }); pdfSent = !(r && r.ok === false); } catch {}
    }
    if (!pdfSent && deps.sendDocument && (env?.TELEGRAM_BOT_TOKEN || env?.TG_TOKEN) && chatId) {
      try { const pdfEnv = env?.TG_TOKEN ? env : { ...env, TG_TOKEN: env.TELEGRAM_BOT_TOKEN }; const r = await deps.sendDocument(pdfEnv, chatId, "photo.pdf", pdfBytesOut, { contentType: "application/pdf" }); pdfSent = !(r && r.ok === false); } catch {}
    }
    if (!pdfSent && typeof send === "function") await send("تبدیل به PDF ممکن نشد.");
    return true;
  }
  if (isPhoto && cap && isImageEditCaption(cap)) {
    const bytes = await fileBytesFromTelegram(env, tgFileId, deps);
    if (!bytes || !bytes.length) { await send("ویرایش تصویر ممکن نشد."); return true; }
    const edited = await editImage(env, { imageBytes: bytes, mimeType: mimeType || "image/jpeg", instruction: cap, userId, fetchFn: o.fetchFn });
    if (edited && edited.ok) {
      let photoSent = false;
      if (typeof o.sendPhoto === "function") { await o.sendPhoto(edited.bytes, { caption: "🖼️ تصویر ویرایش‌شده", mimeType: edited.mimeType }); photoSent = true; }
      else if (deps.sendPhoto && (env?.TELEGRAM_BOT_TOKEN || env?.TG_TOKEN) && chatId) { const photoEnv = env?.TG_TOKEN ? env : { ...env, TG_TOKEN: env.TELEGRAM_BOT_TOKEN }; await deps.sendPhoto(photoEnv, chatId, "edited.jpg", edited.bytes, { caption: "🖼️ تصویر ویرایش‌شده", contentType: edited.mimeType }); photoSent = true; }
      if (!photoSent && typeof send === "function") await send("🖼️ تصویر ویرایش‌شده آماده شد.");
    } else {
      if (typeof send === "function") await send(edited?.reason || "ویرایش تصویر ممکن نشد.");
    }
    return true;
  }
  if (isPhoto && cap && !VAULT_CAPTION_RE.test(cap)) {
    try {
      const bytes = await fileBytesFromTelegram(env, tgFileId, deps);
      if (!bytes || !bytes.length) { await send("تحلیل ممکن نشد."); return true; }
      const result = await analyzeImage(env, { imageBytes: bytes, mimeType: mimeType || "image/jpeg", prompt: cap, userId, fetchFn: o.fetchFn, routerCallFn: o.routerCallFn });
      if (result && result.ok && result.text) await send(result.text);
      else await send("❌ خطا در تحلیل تصویر: " + (result?.error || result?.text || "vision_unavailable"));
    } catch (e) {
      await send("❌ خطا در تحلیل تصویر: " + (e?.message || "vision_unavailable"));
    }
    return true;
  }
  if (cap && VAULT_CAPTION_RE.test(cap)) {
    const title = stripCaptionPrefix(cap) || stripNamingPrefix(cap) || cap;
    const saved = await saveVaultFile(env, { userId, tgFileId, fileType, mimeType, title, fileName: safeFileName, caption: cap, syncStatus: "local" });
    if (!saved || !saved.ok) { await send(NOT_SAVED_TEXT); return true; }
    let syncInfo = "";
    if (saved.ok) {
      const bytes = await fileBytesFromTelegram(env, tgFileId, deps);
      const sync = await syncVaultFileToGoogle(env, { id: saved.id, userId, label: title, fileName: safeFileName, mimeType, data: bytes ?? new Uint8Array(0), createdAt: new Date().toISOString() });
      await setFileSyncStatus(env, userId, saved.id, sync.ok ? "synced" : "pending_google", sync.googleId ?? null, null);
      syncInfo = sync.ok ? `\n✅ گوگل Docs/Drive${sync.googleId ? ` (${sync.googleId})` : ""}: ذخیره شد` : "\n⏳ در انتظار همگام‌سازی گوگل";
    }
    await send(`🔒📁 مدرک «**${mdEscape(title)}**» در آرشیو امن ذخیره شد.${syncInfo}`);
    return true;
  }
  if (cap && VISION_CAPTION_RE.test(cap)) {
    const bytes2 = await fileBytesFromTelegram(env, tgFileId, deps);
    let visionError = null;
    if (bytes2 && bytes2.length) {
      const r2 = await analyzeImage(env, { imageBytes: bytes2, mimeType: mimeType || "image/jpeg", prompt: cap, userId, fetchFn: o.fetchFn, routerCallFn: o.routerCallFn });
      if (r2 && r2.ok && r2.text) { await send(r2.text); return true; }
      visionError = r2?.error || r2?.text || null;
    }
    const f = { tg_file_id: tgFileId, mime_type: mimeType, file_type: fileType };
    const detailed = await analyzeVaultImageDetailed(env, f, cap, userId, deps);
    const text = detailed.ok ? detailed.text : null;
    await send(text || ("❌ خطا در تحلیل تصویر: " + (visionError || "vision_unavailable")));
    return true;
  }
  const saved = await saveVaultFile(env, { userId, tgFileId, fileType, mimeType, title: "__choice__", fileName: safeFileName, caption: cap || null, syncStatus: "local" });
  if (!saved.ok) { await send(NOT_SAVED_TEXT); return true; }
  await send("📎 <b>تصویر/فایل دریافت شد. چه کاری انجام دهم؟</b>" + (secretCaption ? `\n${SECRET_CAPTION_NOTICE}` : ""), { replyMarkup: { inline_keyboard: [
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

export async function namePendingVaultFile(env, o, deps = {}) {
  const { userId, text, send } = o;
  if (!text || /^\s*\//.test(text)) return false;
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
  const bytes = await fileBytesFromTelegram(env, f.tg_file_id, deps);
  const sync = await syncVaultFileToGoogle(env, { id: f.id, userId, label: f.title, fileName: f.fileName, mimeType: f.mimeType, data: bytes ?? new Uint8Array(0), createdAt: f.created_at });
  await setFileSyncStatus(env, userId, f.id, sync.ok ? "synced" : "pending_google", sync.googleId ?? null, null);
  if (sync.ok && sync.googleId) {
    await send(`🔒📁 مدرک «<b>${cleanTitle}</b>» در آرشیو امن و Google Docs ثبت شد.`);
  } else {
    await send(`✅ نام فایل ثبت شد: **${cleanTitle}**${sync.ok ? "" : "\n⏳ در انتظار همگام‌سازی گوگل"}`);
  }
  return true;
}
