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
// message at 4096 chars; chunks are hard slices (no word-boundary
// guarantee needed — the caller passes already-safe text).
export function splitTelegramText(text) {
  const s = String(text ?? "");
  const chunks = [];
  for (let i = 0; i < s.length; i += 4096) chunks.push(s.slice(i, i + 4096));
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
      // edit failed: fall through to plain sends below
    }
  }
  await sendRest(0);
}
