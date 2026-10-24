import { PROVIDERS } from "./providers.js";
import { COMBOS } from "./combos.js";
import { runCombo } from "./router.js";

const TG_API = "https://api.telegram.org";

const CHAT_SYSTEM_PROMPT =
  "You are a concise, helpful personal assistant. Reply in the user's language (Persian if they write Persian).";

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

function routerAuth(request, env) {
  if (!env.ROUTER_KEY) {
    return Response.json(
      { ok: false, error: "missing secret: ROUTER_KEY" },
      { status: 500 },
    );
  }
  const auth = request.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!safeEqual(bearer, env.ROUTER_KEY)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}

function splitMessage(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) {
    chunks.push(text.slice(i, i + 4000));
  }
  return chunks;
}

async function answerChatText(env, chatId, text) {
  await telegramApi(env, "sendChatAction", { chat_id: chatId, action: "typing" });

  const result = await runCombo(
    env,
    "chat",
    {
      messages: [
        { role: "system", content: CHAT_SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      temperature: 0.7,
    },
    { deadlineMs: 25000 },
  );

  if (!result.ok) {
    const lines = result.errors
      .map((e) => `${e.target}: ${e.status ?? e.reason}`)
      .join("\n");
    await sendMessage(env, chatId, `همه‌ی مدل‌ها شکست خوردند 🙁\n${lines}`);
    return;
  }

  const content = result.data?.choices?.[0]?.message?.content;
  let answer =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((p) => p?.text ?? "").join("")
        : "";
  if (!answer.trim()) {
    await sendMessage(env, chatId, "پاسخ خالی بود 🙁");
    return;
  }
  if (env.SHOW_MODEL === "1") answer += `\n— ${result.used}`;
  for (const chunk of splitMessage(answer)) {
    await sendMessage(env, chatId, chunk);
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
  } else if (text.startsWith("/")) {
    await sendMessage(
      env,
      msg.chat.id,
      "دستور ناشناس! دستورهای فعلی: /start /ping /id — برای چت، متن ساده بفرست.",
    );
  } else {
    await answerChatText(env, msg.chat.id, text);
  }
}

async function chatCompletions(request, env) {
  const auth = routerAuth(request, env);
  if (auth) return auth;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    console.error("invalid chat body:", err && err.message);
    return Response.json({ ok: false, error: "invalid json body" }, { status: 400 });
  }
  if (!body || typeof body.model !== "string" || !body.model) {
    return Response.json({ ok: false, error: "body.model is required" }, { status: 400 });
  }

  const stream = body.stream === true;
  const result = await runCombo(env, body.model, body, { stream });

  if (result.ok) {
    if (stream) {
      return new Response(result.stream, {
        headers: {
          "content-type": result.contentType ?? "text/event-stream",
          "X-Router-Used": result.used,
        },
      });
    }
    return new Response(JSON.stringify(result.data), {
      headers: { "content-type": "application/json", "X-Router-Used": result.used },
    });
  }

  return Response.json(
    { ok: false, errors: result.errors },
    { status: 502 },
  );
}

function comboModels() {
  return {
    object: "list",
    data: Object.keys(COMBOS).map((name) => ({ id: name, object: "model" })),
  };
}

async function adminModels(request, env) {
  const key = request.headers.get("X-Setup-Key") ?? "";
  if (!safeEqual(key, env.TG_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const providerName = url.searchParams.get("provider") ?? "";
  const provider = PROVIDERS[providerName];
  if (!provider) {
    return Response.json(
      { ok: false, error: "provider must be nvidia or openrouter" },
      { status: 400 },
    );
  }
  const apiKey = env[provider.keyEnv];
  if (!apiKey) {
    return Response.json(
      { ok: false, error: `missing secret: ${provider.keyEnv}` },
      { status: 500 },
    );
  }

  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  const all = url.searchParams.get("all") === "1";

  let json;
  try {
    const res = await fetch(`${provider.baseUrl}/models`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(provider.extraHeaders ?? {}),
      },
    });
    if (!res.ok) {
      return Response.json(
        { ok: false, error: `provider returned ${res.status}` },
        { status: 502 },
      );
    }
    json = await res.json();
  } catch (err) {
    console.error("provider models fetch failed:", err && err.message);
    return Response.json({ ok: false, error: "provider request failed" }, { status: 502 });
  }

  const list = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  let models = list
    .filter((m) => m && typeof m.id === "string")
    .map((m) => {
      const entry = { id: m.id };
      if (providerName === "openrouter") {
        entry.context_length = typeof m.context_length === "number" ? m.context_length : null;
        entry.vision = Array.isArray(m.architecture?.input_modalities)
          ? m.architecture.input_modalities.includes("image")
          : false;
      }
      return entry;
    });

  if (providerName === "openrouter" && !all) {
    models = models.filter((m) => m.id.endsWith(":free"));
  }
  if (q) {
    models = models.filter((m) => m.id.toLowerCase().includes(q));
  }
  models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return Response.json(models);
}

async function route(request, env, ctx) {
  const { pathname } = new URL(request.url);

  if (request.method === "GET" && pathname === "/") {
    return new Response("ok");
  }

  if (request.method === "POST" && pathname === "/v1/chat/completions") {
    return chatCompletions(request, env);
  }

  if (request.method === "GET" && pathname === "/v1/models") {
    const auth = routerAuth(request, env);
    if (auth) return auth;
    return Response.json(comboModels());
  }

  if (request.method === "GET" && pathname === "/admin/models") {
    if (!env.TG_SECRET) return missingSecretResponse(env);
    return adminModels(request, env);
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
