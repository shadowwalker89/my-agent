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
  if (!env.TG_TOKEN) return;
  try {
    await fetch(`${TG_API}/bot${env.TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}) }),
    });
  } catch (err) {
    console.error("sendMessage failed:", err && err.message);
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
      const res = await tgApi(env, "editMessageText", {
        chat_id: chatId,
        message_id: progressMsgId,
        text: chunks[0],
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
