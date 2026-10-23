const TG_API = "https://api.telegram.org";

function safeEqual(a, b) {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function isAllowed(raw, userId) {
  if (!raw) return false;
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(String(userId));
}

async function sendMessage(env, chatId, text) {
  try {
    await fetch(`${TG_API}/bot${env.TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error("sendMessage failed:", err);
  }
}

async function handleUpdate(env, update) {
  const msg = update.message;
  if (!msg || !msg.from || !msg.chat) return;

  const text = typeof msg.text === "string" ? msg.text.trim() : undefined;

  if (text === "/id") {
    await sendMessage(env, msg.chat.id, String(msg.from.id));
    return;
  }

  if (!isAllowed(env.ALLOWED_TG_IDS, msg.from.id)) return;

  if (!text) {
    await sendMessage(env, msg.chat.id, "فعلاً فقط پیام متنی پشتیبانی می‌شود 🙏");
    return;
  }

  if (text === "/start") {
    await sendMessage(env, msg.chat.id, "سلام! من ایجنت شخصی تو هستم ✅ فعلاً هر متنی بفرستی، برمی‌گردانمش.");
  } else if (text === "/ping") {
    await sendMessage(env, msg.chat.id, "pong");
  } else {
    await sendMessage(env, msg.chat.id, `✅ ${text}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/") {
      return new Response("ok");
    }

    if (request.method === "POST" && pathname === "/telegram") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
      if (!env.TG_SECRET || !safeEqual(secret, env.TG_SECRET)) {
        return new Response("unauthorized", { status: 401 });
      }

      let update;
      try {
        update = await request.json();
      } catch (err) {
        console.error("invalid update json:", err);
        return new Response("ok");
      }

      ctx.waitUntil(
        (async () => {
          try {
            await handleUpdate(env, update);
          } catch (err) {
            console.error("handleUpdate failed:", err);
          }
        })(),
      );
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },
};
