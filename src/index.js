import { PROVIDERS, listFreeModels } from "./providers.js";
import { RULES } from "./combos.js";
import { runCombo, getComboTargets, directCall } from "./router.js";
import { syncProvider } from "./catalog.js";
import {
  getOverrides,
  addPin,
  removePin,
  addBan,
  removeBan,
  setPrefer,
  validatePattern,
} from "./overrides.js";
import { tgApi, tgSend, tgBroadcast } from "./telegram.js";
import { healthCounts } from "./health.js";

const TG_ERROR_LIMIT = 120;

const CHAT_SYSTEM_PROMPT =
  "You are a concise, helpful personal assistant. Reply in the user's language (Persian if they write Persian).";

// هر cron به یک provider: 0 → openrouter، 10 → nvidia، 20 → xkiro
const CRON_PROVIDER = {
  "0 */6 * * *": "openrouter",
  "10 */6 * * *": "nvidia",
  "20 */6 * * *": "xkiro",
};

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
  await tgApi(env, "sendChatAction", { chat_id: chatId, action: "typing" });

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
    await tgSend(env, chatId, `همه‌ی مدل‌ها شکست خوردند 🙁\n${lines}`);
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
    await tgSend(env, chatId, "پاسخ خالی بود 🙁");
    return;
  }
  if (env.SHOW_MODEL === "1") answer += `\n— ${result.used}`;
  for (const chunk of splitMessage(answer)) {
    await tgSend(env, chatId, chunk);
  }
}

const HELP_TEXT =
  "دستورها: /models [combo] /refresh [provider] /test <provider/model> /pin <combo> <provider/model> " +
  "/unpin <combo> <provider/model> /ban <provider/model> /unban <provider/model> " +
  "/prefer <combo> <rx1,rx2,...|reset> /status /ping /start — برای چت، متن ساده بفرست.";

async function tgModels(env, chatId, combo) {
  try {
    if (!RULES[combo]) {
      await tgSend(env, chatId, `combo ناشناس: ${combo}\ncomboها: ${Object.keys(RULES).join(", ")}`);
      return;
    }
    const sel = await getComboTargets(env, combo);
    if (sel.error) {
      const msg = sel.error.startsWith("catalog is empty")
        ? "کاتالوگ خالی است؛ اول /refresh بزن 🙏"
        : sel.error;
      await tgSend(env, chatId, msg);
      return;
    }
    const lines = sel.targets
      .slice(0, 8)
      .map(
        (t, i) =>
          `${i + 1}. ${t.provider}/${t.model} — ${t.score}${t.pinned ? " 📌" : ""}`,
      );
    // پانویس: تعداد هدف‌های سردِ فعلی هر provider از کلیدهای موجود health:*
    const counts = await healthCounts(env);
    const footer = Object.keys(PROVIDERS)
      .map((p) => `${p}: ${counts.counts[p] ?? 0}`)
      .join(" | ");
    await tgSend(env, chatId, `combo «${combo}»:\n${lines.join("\n")}\n❄ کول‌داونِ فعلی — ${footer}`);
  } catch (err) {
    await tgSend(
      env,
      chatId,
      `❌ نمایش مدل‌ها شکست خورد: ${String(err && err.name).slice(0, 40)}`,
    );
  }
}

async function tgRefresh(env, chatId, provider) {
  const list =
    provider === "all" || !provider
      ? Object.keys(PROVIDERS)
      : PROVIDERS[provider]
        ? [provider]
        : null;
  if (!list) {
    await tgSend(env, chatId, `provider ناشناس: ${provider}\nproviderها: ${Object.keys(PROVIDERS).join(", ")}`);
    return;
  }
  const lines = [];
  for (const p of list) {
    try {
      const r = await syncProvider(env, p, { notify: false });
      lines.push(`${p}: +${r.added.length} -${r.removed.length}`);
    } catch (err) {
      const info = err?.info;
      if (info) {
        lines.push(`${p}: شکست (HTTP ${info.status ?? "?"}) — ${info.snippet || "بدون پاسخ"}`);
      } else {
        lines.push(`${p}: شکست (${String(err && err.message).slice(0, TG_ERROR_LIMIT)})`);
      }
    }
  }
  await tgSend(env, chatId, `بروزرسانی کاتالوگ:\n${lines.join("\n")}`);
}

const TEST_BODY = {
  messages: [{ role: "user", content: "Reply with exactly: OK" }],
  max_tokens: 20,
};

async function runTestTarget(env, target) {
  const slash = target.indexOf("/");
  const provider = target.slice(0, slash);
  const model = target.slice(slash + 1);
  return {
    provider,
    model,
    ...(await directCall(env, provider, model, TEST_BODY, { timeoutMs: 20000 })),
  };
}

async function tgTest(env, chatId, target) {
  if (!PROVIDERS[target.slice(0, target.indexOf("/"))] || !TARGET_RE.test(target)) {
    await tgSend(env, chatId, "فرمت: /test <provider/model>  (مثال: /test nvidia/z-ai/glm-5.3)");
    return;
  }
  await tgSend(env, chatId, `⏳ تست ${target}...`);
  const r = await runTestTarget(env, target);
  const status = r.status ?? "—";
  await tgSend(
    env,
    chatId,
    `${r.ok ? "✅" : "❌"} ${r.provider}/${r.model} — ${status}، ${r.latencyMs}ms\n${r.snippet || "(بدون متن)"}`,
  );
}

const TARGET_RE = /^[^/\s]+\/\S+$/;

async function tgCommand(env, chatId, text) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (cmd === "/models") {
    return tgModels(env, chatId, args[0] ?? "chat");
  }
  if (cmd === "/refresh") {
    return tgRefresh(env, chatId, args[0] ?? "all");
  }
  if (cmd === "/test") {
    return tgTest(env, chatId, (args[0] ?? "").trim());
  }
  if (cmd === "/pin" || cmd === "/unpin") {
    const [combo, target] = args;
    if (!RULES[combo] || !TARGET_RE.test(target ?? "")) {
      await tgSend(env, chatId, "فرمت: /pin <combo> <provider/model>  (مثال: /pin chat openrouter/qwen3-coder:free)");
      return;
    }
    if (cmd === "/pin") await addPin(env, combo, target);
    else await removePin(env, combo, target);
    await tgSend(env, chatId, cmd === "/pin" ? `📌 ${combo}: ${target}` : `✅ حذف pin ${combo}: ${target}`);
    return;
  }
  if (cmd === "/ban" || cmd === "/unban") {
    const target = args[0];
    if (!TARGET_RE.test(target ?? "")) {
      await tgSend(env, chatId, "فرمت: /ban <provider/model>");
      return;
    }
    if (cmd === "/ban") await addBan(env, target);
    else await removeBan(env, target);
    await tgSend(env, chatId, cmd === "/ban" ? `🚫 بن شد: ${target}` : `✅ بن برداشته شد: ${target}`);
    return;
  }
  if (cmd === "/prefer") {
    const [combo, rest] = args;
    if (!RULES[combo] || rest === undefined) {
      await tgSend(env, chatId, "فرمت: /prefer <combo> <rx1,rx2,...> یا /prefer <combo> reset");
      return;
    }
    if (rest.toLowerCase() === "reset") {
      await setPrefer(env, combo, null);
      await tgSend(env, chatId, `✅ prefer پیش‌فرض ${combo} برگشت`);
      return;
    }
    const patterns = rest.split(",").map((p) => p.trim()).filter(Boolean);
    const bad = patterns.find((p) => !validatePattern(p));
    if (bad) {
      await tgSend(env, chatId, `regex نامعتبر: ${bad.slice(0, 60)}`);
      return;
    }
    await setPrefer(env, combo, patterns);
    await tgSend(env, chatId, `✅ prefer ${combo}: ${patterns.join(", ")}`);
    return;
  }
  if (cmd === "/status") {
    await tgStatus(env, chatId);
    return;
  }
  await tgSend(env, chatId, "دستور ناشناس!\n" + HELP_TEXT);
}

async function tgStatus(env, chatId) {
  if (!env.STATE) {
    await tgSend(env, chatId, "KV (STATE) در دسترس نیست.");
    return;
  }
  const [nv, or_, xk, ov] = await Promise.all([
    env.STATE.get("catalog:nvidia", "json"),
    env.STATE.get("catalog:openrouter", "json"),
    env.STATE.get("catalog:xkiro", "json"),
    getOverrides(env),
  ]);
  const pinnedTotal = Object.values(ov.pins).reduce((n, l) => n + l.length, 0);
  const counts = await healthCounts(env);
  const cooldownLine = Object.keys(PROVIDERS)
    .map((p) => `${p}: ${counts.counts[p] ?? 0}`)
    .join(" | ");
  const lines = [
    `nvidia: ${nv?.models?.length ?? 0} مدل${nv?.updatedAt ? ` — آخرین sync: ${ageString(nv.updatedAt)}` : " — هنوز sync نشده"}`,
    `openrouter: ${or_?.models?.length ?? 0} مدل${or_?.updatedAt ? ` — آخرین sync: ${ageString(or_.updatedAt)}` : ""}`,
    `xkiro: ${xk?.models?.length ?? 0} مدل${xk?.updatedAt ? ` — آخرین sync: ${ageString(xk.updatedAt)}` : ""}`,
    `بن‌شده: ${ov.bans.length} | pin‌شده: ${pinnedTotal}`,
    `❄ کول‌داونِ فعلی — ${cooldownLine}${counts.providerBlocked.length ? `\nمنع کل provider: ${counts.providerBlocked.join(", ")}` : ""}`,
  ];
  await tgSend(env, chatId, lines.join("\n"));
}

function ageString(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return iso;
  if (mins < 60) return `${mins} دقیقه پیش`;
  if (mins < 1440) return `${Math.round(mins / 60)} ساعت پیش`;
  return `${Math.round(mins / 1440)} روز پیش`;
}

async function handleUpdate(env, update) {
  const msg = update.message;
  if (!msg || !msg.from || !msg.chat) return;

  const text = typeof msg.text === "string" ? msg.text.trim() : undefined;

  if (text === "/id") {
    await tgSend(env, msg.chat.id, String(msg.from.id));
    return;
  }

  if (!isAllowed(env.ALLOWED_TG_IDS, msg.from.id)) return;

  if (!text) {
    await tgSend(env, msg.chat.id, "فعلاً فقط پیام متنی پشتیبانی می‌شود 🙏");
    return;
  }

  if (text === "/start") {
    await tgSend(env, msg.chat.id, "سلام! من ایجنت شخصی تو هستم ✅ هر متنی بفرستی، مدل‌روتر جواب می‌دهد. لیست دستورها: /models");
  } else if (text === "/ping") {
    await tgSend(env, msg.chat.id, "pong");
  } else if (text.startsWith("/")) {
    await tgCommand(env, msg.chat.id, text);
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

  return Response.json({ ok: false, errors: result.errors }, { status: 502 });
}

function comboModels() {
  return {
    object: "list",
    data: Object.keys(RULES).map((name) => ({ id: name, object: "model" })),
  };
}

async function adminModels(request, env) {
  const key = request.headers.get("X-Setup-Key") ?? "";
  if (!safeEqual(key, env.TG_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const providerName = url.searchParams.get("provider") ?? "";
  if (!PROVIDERS[providerName]) {
    return Response.json(
      { ok: false, error: "provider must be nvidia, openrouter or xkiro" },
      { status: 400 },
    );
  }

  let models;
  try {
    models = await listFreeModels(env, providerName);
  } catch (err) {
    if (err?.info) return Response.json(err.info, { status: 502 });
    return Response.json(
      { ok: false, error: String(err && err.message).slice(0, 200) },
      { status: 502 },
    );
  }

  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  const all = url.searchParams.get("all") === "1";
  let out = models;
  if (providerName !== "nvidia" && !all) {
    out = out.filter((m) => m.id.endsWith(":free"));
  }
  if (q) out = out.filter((m) => m.id.toLowerCase().includes(q));
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  out = out.map((m) => {
    const entry = { id: m.id };
    if (providerName !== "nvidia") {
      if (m.context !== null) entry.context_length = m.context;
      if (m.vision !== null) entry.vision = m.vision;
    }
    return entry;
  });
  return Response.json(out);
}

async function adminRefresh(request, env) {
  const key = request.headers.get("X-Setup-Key") ?? "";
  if (!safeEqual(key, env.TG_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }

  const provider = new URL(request.url).searchParams.get("provider") ?? "all";
  const list = provider === "all" ? Object.keys(PROVIDERS) : [provider];
  if (provider !== "all" && !PROVIDERS[provider]) {
    return Response.json(
      { ok: false, error: "provider must be nvidia, openrouter, xkiro or all" },
      { status: 400 },
    );
  }

  const result = {};
  for (const p of list) {
    try {
      const r = await syncProvider(env, p);
      result[p] = { added: r.added.length, removed: r.removed.length };
    } catch (err) {
      result[p] =
        err?.info ??
        { ok: false, provider: p, status: null, snippet: String(err && err.message).slice(0, 300) };
    }
  }
  return Response.json(result);
}

async function adminTest(request, env) {
  const key = request.headers.get("X-Setup-Key") ?? "";
  if (!safeEqual(key, env.TG_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }
  const target = new URL(request.url).searchParams.get("target") ?? "";
  const slash = target.indexOf("/");
  if (slash <= 0 || !PROVIDERS[target.slice(0, slash)] || !target.slice(slash + 1)) {
    return Response.json(
      { ok: false, error: "target must be provider/model" },
      { status: 400 },
    );
  }
  const r = await runTestTarget(env, target);
  return Response.json({
    ok: r.ok,
    provider: r.provider,
    model: r.model,
    status: r.status ?? null,
    latencyMs: r.latencyMs,
    snippet: r.snippet,
  });
}

async function adminCatalog(request, env) {
  const key = request.headers.get("X-Setup-Key") ?? "";
  if (!safeEqual(key, env.TG_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }
  const combo = new URL(request.url).searchParams.get("combo") ?? "chat";
  const sel = await getComboTargets(env, combo);
  if (sel.error) {
    return Response.json({ ok: false, error: sel.error }, { status: 400 });
  }
  return Response.json({
    combo,
    targets: sel.targets.map((t) => ({
      target: `${t.provider}/${t.model}`,
      score: t.score,
      pinned: t.pinned,
      healthy: true,
    })),
  });
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
    if (missingSecretName(env)) return missingSecretResponse(env);
    return adminModels(request, env);
  }

  if (request.method === "POST" && pathname === "/admin/refresh") {
    if (missingSecretName(env)) return missingSecretResponse(env);
    return adminRefresh(request, env);
  }

  if (request.method === "GET" && pathname === "/admin/test") {
    if (missingSecretName(env)) return missingSecretResponse(env);
    return adminTest(request, env);
  }

  if (request.method === "GET" && pathname === "/admin/catalog") {
    if (missingSecretName(env)) return missingSecretResponse(env);
    return adminCatalog(request, env);
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
        json = await tgApi(env, "getWebhookInfo");
      } else {
        json = await tgApi(env, "setWebhook", {
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
  async scheduled(event, env, ctx) {
    const provider = CRON_PROVIDER[event.cron];
    if (!provider) return;
    ctx.waitUntil(
      (async () => {
        try {
          await syncProvider(env, provider);
        } catch (err) {
          console.error(`syncProvider(${provider}) failed:`, err && err.message);
        }
      })(),
    );
  },
};
