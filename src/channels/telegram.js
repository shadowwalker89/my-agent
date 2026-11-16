import { escapeHtml, stripTelegramMarkup, formatTelegramHtml, splitTelegramText, normalizeReply } from "../pipeline/respond.js";

const TG_API = "https://api.telegram.org";

export const TELEGRAM_CAPABILITIES = Object.freeze({ buttons: true, editMessage: true, maxFileBytes: 50 * 1024 * 1024, maxTextLength: 4096 });

export async function tgApi(env, method, body) {
  const res = await fetch(`${TG_API}/bot${env.TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json().catch(() => ({ ok: false }));
  if (!json?.ok) console.warn(JSON.stringify({ tg: method, code: json?.error_code ?? res?.status }));
  return json;
}

function telegramPayload(chatId, text, opts = {}) {
  const formatted = formatTelegramHtml(text);
  const html = formatted !== String(text ?? "");
  return {
    html,
    body: {
      chat_id: chatId,
      text: html ? formatted : text,
      ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      ...(html ? { parse_mode: "HTML" } : {}),
    },
  };
}

async function sendWithFallback(env, method, body, text, html) {
  try {
    const res = await tgApi(env, method, body);
    if (html && res && res.ok === false) {
      return await tgApi(env, method, { ...body, text: stripTelegramMarkup(text), parse_mode: undefined });
    }
    return res;
  } catch (err) {
    console.error(`${method} failed:`, err && err.message);
    return null;
  }
}

export async function tgSend(env, chatId, text, opts) {
  if (!env.TG_TOKEN) return null;
  const { html, body } = telegramPayload(chatId, text, opts);
  return sendWithFallback(env, "sendMessage", body, text, html);
}

export async function sendMessage(env, chatId, text, opts = {}) {
  if (!env?.TG_TOKEN) return null;
  const { html, body } = telegramPayload(chatId, text, opts);
  return sendWithFallback(env, "sendMessage", body, text, html);
}

export async function editMessage(env, chatId, messageId, text, opts = {}) {
  if (!env?.TG_TOKEN) return null;
  const { html, body } = telegramPayload(chatId, text, opts);
  return sendWithFallback(env, "editMessageText", { ...body, message_id: messageId }, text, html);
}

async function tgMultipart(env, method, form) {
  if (!env?.TG_TOKEN) return null;
  try {
    const res = await fetch(`${TG_API}/bot${env.TG_TOKEN}/${method}`, { method: "POST", body: form });
    return await res.json();
  } catch (err) {
    console.error(`${method} failed:`, err && err.message);
    return null;
  }
}

export async function sendDocument(env, chatId, filename, data, opts = {}) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([data], { type: opts.contentType || "application/octet-stream" }), filename);
  if (opts.caption) form.append("caption", opts.caption);
  if (opts.replyMarkup) form.append("reply_markup", JSON.stringify(opts.replyMarkup));
  return await tgMultipart(env, "sendDocument", form);
}

export async function sendPhoto(env, chatId, filename, data, opts = {}) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", new Blob([data], { type: opts.contentType || "image/jpeg" }), filename);
  if (opts.caption) form.append("caption", opts.caption);
  if (opts.replyMarkup) form.append("reply_markup", JSON.stringify(opts.replyMarkup));
  return await tgMultipart(env, "sendPhoto", form);
}

export async function getFileDownloadData(env, fileId) {
  if (!env?.TG_TOKEN || !fileId) return null;
  try {
    const meta = await tgApi(env, "getFile", { file_id: fileId });
    const filePath = meta?.result?.file_path;
    if (!meta?.ok || !filePath) return null;
    const res = await fetch(`${TG_API}/file/bot${env.TG_TOKEN}/${filePath}`);
    if (!res.ok) return null;
    return {
      data: await res.arrayBuffer(),
      filePath,
      contentType: res.headers.get("content-type") || "application/octet-stream",
    };
  } catch (err) {
    console.error("getFile failed:", err && err.message);
    return null;
  }
}

export async function downloadTelegramVoice(env, fileId) {
  let stage = "telegram-info";
  const failed = (status, kind) => {
    const failure = { stage, status, apiStatus: null, kind };
    console.warn("voice_stage_fail", failure);
    return { ok: false, failure };
  };
  try {
    const infoRes = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/getFile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(10000),
    });
    const info = await infoRes.json().catch(() => ({ ok: false }));
    const path = info?.result?.file_path;
    if (!info?.ok || !path) return failed(Number.isInteger(info?.error_code) ? info.error_code : null, "telegram");
    stage = "telegram-download";
    const res = await fetch(`${"https://api.telegram.org"}/file/bot${env.TG_TOKEN}/${path}`, { signal: AbortSignal.timeout(20000) }); // same value as the former GEMINI_TIMEOUT_MS
    if (!res.ok) return failed(res.status, "http");
    return { ok: true, bytes: await res.arrayBuffer() };
  } catch { return failed(null, "network"); }
}

export async function tgBroadcast(env, text) {
  if (!env.TG_TOKEN) return;
  for (const raw of String(env.ALLOWED_TG_IDS ?? "").split(",")) {
    const id = raw.trim();
    if (id) await tgSend(env, id, text);
  }
}

export async function sendProgressMessage(env, chatId, text = "⏳ در حال پردازش...") {
  if (!env?.TG_TOKEN) return null;
  try {
    const res = await tgApi(env, "sendMessage", { chat_id: chatId, text });
    const id = res?.result?.message_id;
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export async function finalizeProgressMessage(env, chatId, progressMsgId, fullText, extra = {}) {
  const chunks = splitTelegramText(fullText);
  const markup = extra && typeof extra === "object" ? extra.replyMarkup : undefined;
  const sendRest = async (from) => {
    for (let i = from; i < chunks.length; i++) {
      await tgSend(env, chatId, chunks[i], i === chunks.length - 1 && markup ? { replyMarkup: markup } : undefined);
    }
  };
  if (Number.isInteger(progressMsgId) && progressMsgId > 0 && env?.TG_TOKEN) {
    try {
      const formattedFirst = formatTelegramHtml(chunks[0]);
      const res = await tgApi(env, "editMessageText", {
        chat_id: chatId,
        message_id: progressMsgId,
        text: formattedFirst,
        ...(formattedFirst !== chunks[0] ? { parse_mode: "HTML" } : {}),
        ...(chunks.length === 1 && markup ? { reply_markup: markup } : {}),
      });
      if (res && res.ok !== false) {
        await sendRest(1);
        return;
      }
    } catch {
      // edit failed: delete the orphan placeholder, then plain sends
    }
    try {
      await tgApi(env, "deleteMessage", { chat_id: chatId, message_id: progressMsgId });
    } catch {}
  }
  await sendRest(0);
}

function attachment(type, file) {
  return {
    type,
    file_id: file?.file_id ?? null,
    file_name: file?.file_name ?? null,
    mime_type: file?.mime_type ?? null,
    file_size: file?.file_size ?? null,
  };
}

function extractAttachments(msg) {
  if (!msg) return [];
  const out = [];
  const photo = Array.isArray(msg.photo) ? msg.photo[msg.photo.length - 1] : msg.photo;
  if (photo) out.push(attachment("photo", photo));
  for (const type of ["document", "voice", "audio", "video"]) {
    if (msg[type]) out.push(attachment(type, msg[type]));
  }
  return out;
}

export function toEnvelope(update) {
  const callback = update?.callback_query ?? null;
  const msg = update?.message ?? null;
  const cbMsg = callback?.message ?? null;
  const from = msg?.from ?? callback?.from ?? null;
  const chat = msg?.chat ?? cbMsg?.chat ?? null;
  const provenance = Boolean(msg?.forward_origin || msg?.forward_from || msg?.forward_from_chat || msg?.forward_sender_name || msg?.is_automatic_forward) ? "forwarded" : "user";
  return {
    channel: "telegram",
    update_id: update?.update_id ?? null,
    user_ref: String(from?.id ?? ""),
    chat_id: chat?.id ?? null,
    chat_type: chat?.type ?? null,
    message_id: msg?.message_id ?? null,
    text: String(msg?.text ?? msg?.caption ?? callback?.data ?? ""),
    attachments: extractAttachments(msg),
    reply_to: msg?.reply_to_message?.message_id ?? null,
    callback: callback ? { id: callback.id, data: callback.data ?? "", message_id: cbMsg?.message_id ?? null } : null,
    provenance,
    ts: msg?.date ? msg.date * 1000 : Date.now(),
  };
}

function inlineKeyboard(buttons) {
  const rows = buttons.length && Array.isArray(buttons[0]) ? buttons : [buttons];
  const inline_keyboard = rows
    .map((row) => (Array.isArray(row) ? row : [row]).map((b) => {
      const button = { text: String(b?.text ?? "") };
      if (b?.url) button.url = b.url;
      else if (b?.callback_data != null) button.callback_data = b.callback_data;
      return button;
    }))
    .filter((row) => row.length);
  return inline_keyboard.length ? { inline_keyboard } : undefined;
}

export async function renderReply(env, chatId, reply, opts = {}) {
  const r = normalizeReply(reply);
  const markup = opts.replyMarkup ?? inlineKeyboard(r.buttons);
  const extra = markup ? { replyMarkup: markup } : {};
  const results = [];
  if (r.edit_message_id != null) {
    results.push(await editMessage(env, chatId, r.edit_message_id, r.text, extra));
  }
  if (r.text) {
    const chunks = splitTelegramText(r.text, opts.maxTextLength ?? TELEGRAM_CAPABILITIES.maxTextLength);
    for (const chunk of chunks) results.push(await sendMessage(env, chatId, chunk, extra));
  }
  for (const file of r.files) {
    const f = file ?? {};
    const fileOpts = { ...extra, caption: f.caption };
    if (f.kind === "photo") results.push(await sendPhoto(env, chatId, f.filename ?? "photo.jpg", f.data, fileOpts));
    else if (f.kind === "document") results.push(await sendDocument(env, chatId, f.filename ?? "file.bin", f.data, fileOpts));
  }
  return results;
}
