const TG_API = "https://api.telegram.org";

export async function tgApi(env, method, body) {
  const res = await fetch(`${TG_API}/bot${env.TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return await res.json();
}

export async function tgSend(env, chatId, text, opts) {
  if (!env.TG_TOKEN) return null;
  const { html, body } = telegramPayload(chatId, text, opts);
  try {
    const res = await tgApi(env, "sendMessage", body);
    if (html && res && res.ok === false) {
      return await tgApi(env, "sendMessage", { ...body, text: stripTelegramMarkup(text), parse_mode: undefined });
    }
    return res;
  } catch (err) {
    console.error("sendMessage failed:", err && err.message);
    return null;
  }
}

// Phase 3-A: Telegram's HTML parse mode. Escape everything first, then
// apply the small markdown subset we emit (fenced/inline code, bold,
// strikethrough). Anything else stays literal, so a model answer can
// never inject tags.
export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Only these tags are allowed through untouched. Everything else is
// escaped, so a model answer can never inject arbitrary HTML.
const SAFE_TAG_RE = /<\/?(?:b|strong|i|em|u|s|code|pre|blockquote)>|<a\s+href="[^"]*"\s*>|<\/a>/gi;

function splitTableCells(line) {
  return String(line ?? "").trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function cleanTableHeader(cell) {
  return String(cell ?? "").replace(/\*\*/g, "").replace(/~~/g, "").replace(/`/g, "").trim();
}

// Mobile-friendly cards instead of broken ASCII pipes: every data row
// becomes one "▫️ header: value • header: value" bullet.
function renderMarkdownTables(text) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    const block = [];
    let j = i;
    while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
      block.push(lines[j]);
      j += 1;
    }
    const sepIdx = block.findIndex((line, idx) => idx > 0 && splitTableCells(line).every((cell) => /^:?-{2,}:?$/.test(cell)));
    if (sepIdx < 1) {
      out.push(...block);
      i = j - 1;
      continue;
    }
    const header = splitTableCells(block[sepIdx - 1]);
    const rows = block.slice(sepIdx + 1);
    if (!rows.length) {
      out.push(...block.filter((_, idx) => idx !== sepIdx));
      i = j - 1;
      continue;
    }
    for (const row of rows) {
      const cells = splitTableCells(row);
      const parts = [];
      for (let k = 0; k < Math.max(header.length, cells.length); k++) {
        const label = cleanTableHeader(header[k]);
        const value = cells[k] ?? "";
        if (!label && !value) continue;
        parts.push(label ? `<b>${label}:</b> ${value}` : value);
      }
      if (parts.length) out.push(`▫️ ${parts.join("  •  ")}`);
    }
    i = j - 1;
  }
  return out.join("\n");
}

// Plain-text fallback: Telegram rejected our HTML (e.g. a malformed
// entity), so drop markup symbols instead of showing them literally.
export function stripTelegramMarkup(text) {
  return String(text ?? "")
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/^#{1,4}[ \t]+/gm, "")
    .replace(/^[ \t]*(?:---|___|\*\*\*)[ \t]*$/gm, "───────────────")
    .replace(/^[ \t]*[-*]\s+/gm, "• ")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}

export function formatTelegramHtml(text) {
  const src = String(text ?? "");
  const blocks = [];
  const tags = [];
  let s = src.replace(/```([^\n]*)\n?([\s\S]*?)```/g, (_, info, code) => {
    const body = escapeHtml(code.replace(/\n$/, ""));
    // A language-tagged fence keeps the historical <pre> shape; a bare
    // fence gets the richer <pre><code> wrapper.
    const rendered = String(info).trim() ? `<pre>${body}</pre>` : `<pre><code>${body}</code></pre>`;
    const i = blocks.push(rendered) - 1;
    return `\u0000B${i}\u0000`;
  });
  // Stash already-safe HTML before escaping so <b>...</b> stays bold
  // instead of printing literally (and is never double-escaped).
  s = s.replace(SAFE_TAG_RE, (tag) => {
    const i = tags.push(tag) - 1;
    return `\u0000T${i}\u0000`;
  });
  s = escapeHtml(s);
  s = renderMarkdownTables(s);
  s = s.replace(/^#{1,4}[ \t]+(.+)$/gm, "\n📌 <b>$1</b>");
  s = s.replace(/^[ \t]*(?:---|___|\*\*\*)[ \t]*$/gm, "───────────────");
  s = s.replace(/^[ \t]*[-*]\s+(.+)$/gm, "• $1");
  s = s.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  s = s.replace(/\u0000T(\d+)\u0000/g, (_, i) => tags[Number(i)] ?? "");
  s = s.replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[Number(i)] ?? "");
  return s;
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

// Phase 3-A: rich send/edit with a plain-text retry. A rejected HTML
// payload must not lose the message, so any {ok:false} falls back once
// to the original text without parse_mode.
export async function sendMessage(env, chatId, text, opts = {}) {
  if (!env?.TG_TOKEN) return null;
  const { html, body } = telegramPayload(chatId, text, opts);
  try {
    const res = await tgApi(env, "sendMessage", body);
    if (html && res && res.ok === false) {
      return await tgApi(env, "sendMessage", { ...body, text: stripTelegramMarkup(text), parse_mode: undefined });
    }
    return res;
  } catch (err) {
    console.error("sendMessage failed:", err && err.message);
    return null;
  }
}

export async function editMessage(env, chatId, messageId, text, opts = {}) {
  if (!env?.TG_TOKEN) return null;
  const { html, body } = telegramPayload(chatId, text, opts);
  const payload = { ...body, message_id: messageId };
  try {
    const res = await tgApi(env, "editMessageText", payload);
    if (html && res && res.ok === false) {
      return await tgApi(env, "editMessageText", { ...payload, text: stripTelegramMarkup(text), parse_mode: undefined });
    }
    return res;
  } catch (err) {
    console.error("editMessageText failed:", err && err.message);
    return null;
  }
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

export async function tgBroadcast(env, text) {
  if (!env.TG_TOKEN) return;
  for (const raw of String(env.ALLOWED_TG_IDS ?? "").split(",")) {
    const id = raw.trim();
    if (id) await tgSend(env, id, text);
  }
}

// Phase 1-e Pillar 1: zero-drop progress feedback. Telegram caps a
// message at 4096 chars. Phase 2-d: chunks split on newline or space
// boundaries whenever possible within maxLen, so a multi-chunk answer
// never cuts a Persian word in half; only a single contiguous token
// longer than maxLen is hard-sliced at maxLen.
export function splitTelegramText(text, maxLen = 4096) {
  const s = String(text ?? "");
  const limit = Math.max(1, Math.floor(maxLen) || 4096);
  const chunks = [];
  let rest = s;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Prefer a newline break (drop the newline itself); else the last
    // space in the window (drop one space); else a hard slice.
    const nl = window.lastIndexOf("\n");
    if (nl > 0) {
      chunks.push(rest.slice(0, nl));
      rest = rest.slice(nl + 1);
      continue;
    }
    const sp = window.lastIndexOf(" ");
    if (sp > 0) {
      chunks.push(rest.slice(0, sp));
      rest = rest.slice(sp + 1);
      continue;
    }
    chunks.push(window);
    rest = rest.slice(limit);
  }
  chunks.push(rest);
  return chunks.length ? chunks : [""];
}

// Sends the ⏳ placeholder and returns its numeric message_id, or null
// when sending failed, returned no id, or no token exists (offline
// tests without TG_TOKEN never touch the network).
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

// Replaces the ⏳ placeholder with the full answer: edits the progress
// message with the first chunk (attaching extra, e.g. reply_markup, when
// there is only one chunk), then sends any further chunks sequentially,
// attaching extra's reply_markup to the final chunk only. When the edit
// fails ({ ok: false } or a throw) or no progress id exists, falls back
// to plain sends (tgSend no-ops without a token, so offline tests stay
// silent). extra is the tgApi-style options object ({ replyMarkup }).
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
    // Phase 2-d: an edit failure used to leave "⏳ در حال پردازش..."
    // stranded above the fresh answer. Best-effort delete first; a
    // failed delete is ignored (the sends below still deliver).
    try {
      await tgApi(env, "deleteMessage", { chat_id: chatId, message_id: progressMsgId });
    } catch {}
  }
  await sendRest(0);
}
