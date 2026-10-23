const TG_API = "https://api.telegram.org";

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function missingSecretName(env) {
  if (!env.TG_TOKEN) return "TG_TOKEN";
  if (!env.TG_SECRET) return "TG_SECRET";
  return "";
}

function missingSecretResponse(env) {
  return Response.json(
    { ok: false, error: `missing secret: ${missingSecretName(env)}` },
    { status: 500 },
  );
}

function isAllowed(raw, userId) {
  if (!raw) return false;
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(String(userId));
}

async function telegramApi(env, method, body) {
  const res = await fetch(`${TG_API}/bot${env.TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return await res.json();
}

async function sendMessage(env, chatId, text) {
  try {
    await fetch(`${TG_API}/bot${env.TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error("sendMessage failed:", err && err.message);
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

async function route(request, env, ctx) {
  const { pathname } = new URL(request.url);

  if (request.method === "GET" && pathname === "/") {
    return new Response("ok");
  }

  if (request.method === "POST" && pathname === "/telegram") {
    if (missingSecretName(env)) return missingSecretResponse(env);

    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (!safeEqual(secret, env.TG_SECRET)) {
      return new Response("unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch (err) {
      console.error("invalid update json:", err && err.message);
      return new Response("ok");
    }

    ctx.waitUntil(
      (async () => {
        try {
          await handleUpdate(env, update);
        } catch (err) {
          console.error("handleUpdate failed:", err && err.message);
        }
      })(),
    );
    return new Response("ok");
  }

  if (pathname === "/setup") {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    if (missingSecretName(env)) return missingSecretResponse(env);

    const key = request.headers.get("X-Setup-Key") ?? "";
    if (!safeEqual(key, env.TG_SECRET)) {
      return new Response("unauthorized", { status: 401 });
    }

    let json;
    try {
      if (new URL(request.url).searchParams.get("info") === "1") {
        json = await telegramApi(env, "getWebhookInfo");
      } else {
        json = await telegramApi(env, "setWebhook", {
          url: new URL(request.url).origin + "/telegram",
          secret_token: env.TG_SECRET,
          allowed_updates: ["message"],
          drop_pending_updates: true,
        });
      }
    } catch (err) {
      console.error("telegram api call failed");
      json = { ok: false, error: "telegram request failed" };
    }

    return Response.json(json);
  }

  return new Response("not found", { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      console.error("handler error:", err && err.message);
      return Response.json({ ok: false, error: "internal error" }, { status: 500 });
    }
  },
};
