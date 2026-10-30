import { redact, listProviderModels } from "./providers.js";
import {
  getConfig,
  getProviderCtx,
  upsertProvider,
  removeProvider,
  upsertCombo,
  removeCombo,
} from "./config.js";
import { RULES, capabilityTags } from "./combos.js";
import { runCombo, getComboTargets, directCall } from "./router.js";
import { classifyTask, comboCandidates, fallbackCombo, updateHasImage } from "./task-route.js";
import { getPrefs, setPrefs } from "./tgprefs.js";
import { syncProvider, getSyncReport, loadCatalog } from "./catalog.js";
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
import { ADMIN_HTML } from "./admin-page.js";
import { classifyIntent, needsConfirmation, freeTextDevSuggestion } from "./intent.js";
import { getChatContext } from "./memory.js";
import { buildChatContext, handleDailyText, resolveDailyCallback, ensureUserRow, dailySenders, handleDailyFile } from "./everyday.js";
import { handleVoice } from "./voice.js";
import { saveMessage } from "./db.js";
import {
  dispatchDev,
  approveDevPR,
  rejectDevPR,
  verifyCallbackSignature,
  setDevActive,
  getPRCiStatus,
  getPRCiState,
  getCiRuns,
  ciStateEmoji,
  safeGithubUrl,
  devRepo,
  findLatestDispatchPR,
  getDiag,
} from "./dev.js";
import { runTask } from "./executor.js";

const TG_ERROR_LIMIT = 120;

const CHAT_SYSTEM_PROMPT =
  "You are a concise, helpful personal assistant. Reply in the user's language (Persian if they write Persian).";

// kind هر combo داخلی برای «ساخت نسخه‌ی دستی» در پنل
const AUTO_KINDS = { chat: "text", code: "code", vision: "vision", fast: "fast" };

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

// کلید مجزای صفحه‌ی مدیریت؛ اگر ست نشده باشد همان TG_SECRET (سازگاری با قبل)
function adminKey(env) {
  return env.ADMIN_KEY || env.TG_SECRET;
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

// خطای سبک OpenAI برای مسیر /v1: {error:{message,type,code}}
function openAiError(status, message, type, code) {
  return Response.json(
    { error: { message: String(message ?? "").slice(0, 500), type, code: code ?? null } },
    { status },
  );
}

function routerAuth(request, env) {
  if (!env.ROUTER_KEY) {
    // ROUTER_KEY ست نشده = /v1 خاموش (نه باز) — 503، نه باز تست
    return openAiError(
      503,
      "router disabled: ROUTER_KEY secret is not set on this Worker",
      "api_error",
      "router_disabled",
    );
  }
  const auth = request.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!safeEqual(bearer, env.ROUTER_KEY)) {
    return openAiError(401, "invalid or missing bearer token", "authentication_error", "invalid_api_key");
  }
  return null;
}

// عبور SSE: بدون بافر — هر chunk بلافاصله پاس می‌شود. اگر upstream وسط جواب مرد،
// خطا به شکل رویداد SSE خطا فرستاده و استریم تمیز بسته می‌شود (بدون درخواست مجدد).
const SSE_ENCODER = new TextEncoder();

function wrapSseStream(upstream, used) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const done = (async () => {
    const reader = upstream.getReader();
    try {
      for (;;) {
        const { done: ended, value } = await reader.read();
        if (ended) break;
        await writer.write(value);
      }
      await writer.close();
    } catch (err) {
      const payload = JSON.stringify({
        error: {
          message: `upstream stream failed (${used})`,
          type: "api_error",
          code: "upstream_stream_failed",
        },
      });
      try {
        await writer.write(SSE_ENCODER.encode(`data: ${payload}\n\n`));
        await writer.close();
      } catch {
        // کلاینت رفته — هیچ
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
      try {
        writer.releaseLock();
      } catch {}
    }
  })();
  return { readable, done };
}

function splitMessage(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) {
    chunks.push(text.slice(i, i + 4000));
  }
  return chunks;
}

// combo ای «قابل استفاده» باشد یعنی شناخته (دستی یا داخلی) و حداقل یک هدف سالم داشته باشد.
async function comboUsable(env, name) {
  try {
    const sel = await getComboTargets(env, name);
    if (sel.error) return false;
    return Array.isArray(sel.targets) && sel.targets.length > 0;
  } catch {
    return false;
  }
}

async function answerChatText(env, chatId, userId, text, hasImage, opts = {}) {
  await tgApi(env, "sendChatAction", { chat_id: chatId, action: "typing" });

  const prefs = await getPrefs(env, userId);
  const task = classifyTask(text, { hasImage: hasImage === true });
  // Chat context: last 50 chat-kind rows, capped at 8,000 characters.
  // Translate skips history entirely: a weak model let note-themed history
  // override the translate system prompt (observed in Telegram tests).
  const history = opts.noHistory ? [] : buildChatContext(await getChatContext(env, userId));
  const body = {
    messages: [
      { role: "system", content: opts.systemPrompt || CHAT_SYSTEM_PROMPT },
      ...history,
      { role: "user", content: text },
    ],
    temperature: 0.7,
  };

  const cfg = await getConfig(env);
  const isKnown = (name) => Boolean(RULES[name]) || cfg.combos.some((c) => c.name === name);
  const def = (prefs.combo && isKnown(prefs.combo) && prefs.combo) || "chat";

  // ترتیب: [task (فقط وقتی auto روشن)]، پیش‌فرض کاربر، chat — اولین شناخته‌ی دارای هدف سالم.
  let combo = null;
  for (const name of comboCandidates(prefs, task)) {
    if (!isKnown(name)) continue;
    if (await comboUsable(env, name)) {
      combo = name;
      break;
    }
  }
  if (!combo) combo = "chat";
  const autoPick = prefs.auto !== false && combo === task;
  const fallback = fallbackCombo(def, combo);

  let result = await runCombo(env, combo, body, { deadlineMs: 25000 });
  let usedCombo = combo;
  let routed = autoPick ? "auto" : "manual";
  if (!result.ok && fallback && fallback !== usedCombo) {
    // جایگزینِ تنها — بدون حلقه
    console.warn(`[tg] combo ${usedCombo} failed -> fallback ${fallback}`);
    routed = "manual";
    usedCombo = fallback;
    result = await runCombo(env, fallback, body, { deadlineMs: 25000 });
  }

  if (!result.ok) {
    const lines = result.errors
      .map((e) => `${e.target}: ${e.status ?? e.reason}`)
      .join("\n");
    await tgSend(env, chatId, `همه‌ی مدل‌ها شکست خوردند 🙁\n${lines}`);
    console.log(JSON.stringify({ combo: usedCombo, used: null, routed }));
    return; // failed turn stores nothing, neither side
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
    console.log(JSON.stringify({ combo: usedCombo, used: result.used ?? null, routed }));
    return; // empty turn stores nothing either
  }
  // Successful turn only: save user + assistant as kind chat.
  await saveMessage(env, { userId, role: "user", content: opts.saveText ?? text, kind: "chat" });
  await saveMessage(env, { userId, role: "assistant", content: answer, kind: "chat" });
  // show: ترجیح هر کاربر؛ SHOW_MODEL=1 همیشه override جهانی است.
  if (prefs.show === true || env.SHOW_MODEL === "1") {
    answer += `\n- ${usedCombo} / ${result.used}`;
  }
  console.log(JSON.stringify({ combo: usedCombo, used: result.used, routed }));
  for (const chunk of splitMessage(answer)) {
    await tgSend(env, chatId, chunk);
  }
}

const HELP_TEXT =
  "دستورها: /combo [name|clear] /route on|off /showmodel on|off /models [combo] /combos /refresh [provider] " +
  "/test <provider/model> /pin <combo> <provider/model> /unpin <combo> <provider/model> " +
  "/ban <provider/model> /unban <provider/model> /prefer <combo> <rx1,rx2,...|reset> " +
  "/intent on|off /dev <prompt> /status /ping /start — برای چت، متن ساده بفرست.";

async function providerIds(env) {
  const cfg = await getConfig(env);
  return cfg.providers.map((p) => p.id);
}

async function tgCombos(env, chatId) {
  const cfg = await getConfig(env);
  if (!cfg.combos.length) {
    await tgSend(env, chatId, "کامبوی دستی نداری. با POST /admin/api/combos بساز.");
    return;
  }
  const lines = cfg.combos.map(
    (c) =>
      `• ${c.name} — ${c.strategy}، ${c.targets.length} هدف، timeout ${c.timeoutMs}ms، retries ${c.retries}`,
  );
  await tgSend(env, chatId, `comboهای دستی:\n${lines.join("\n")}`);
}

async function tgModels(env, chatId, combo) {
  try {
    const cfg = await getConfig(env);
    const isManual = cfg.combos.some((c) => c.name === combo);
    if (!RULES[combo] && !isManual) {
      const names = [...Object.keys(RULES), ...cfg.combos.map((c) => c.name)];
      await tgSend(env, chatId, `combo ناشناس: ${combo}\ncomboها: ${[...new Set(names)].join(", ")}`);
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
    const footer = (await providerIds(env))
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
  const ids = await providerIds(env);
  const list = provider === "all" || !provider ? ids : ids.includes(provider) ? [provider] : null;
  if (!list) {
    await tgSend(env, chatId, `provider ناشناس: ${provider}\nproviderها: ${ids.join(", ")}`);
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
  const provider = target.slice(0, target.indexOf("/"));
  const okFormat = TARGET_RE.test(target) && (await getProviderCtx(env, provider));
  if (!okFormat) {
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

// ── تنظیم هر کاربر: combo پیش‌فرض، مسیریابی خودکار، نمایش مدل ───────────────

async function tgCombo(env, chatId, args, userId) {
  const [cfg, prefs] = await Promise.all([getConfig(env), getPrefs(env, userId)]);
  const builtins = Object.keys(RULES);
  if (!args.length) {
    const manual = cfg.combos.length
      ? cfg.combos
          .map((c) => `• ${c.name} — ${c.kind ?? "custom"}، ${(c.targets ?? []).length} هدف`)
          .join("\n")
      : "• (نه داری — با پنل بساز)";
    const auto = builtins.map((n) => `• ${n} — auto`).join("\n");
    await tgSend(
      env,
      chatId,
      `combo فعلی: ${prefs.combo ?? "chat"} | مسیریابی خودکار: ${prefs.auto ? "روشن" : "خاموش"}` +
        `\n\ncomboهای دستی:\n${manual}\n\nخودکار:\n${auto}\n\nانتخاب: /combo <name> یا /combo clear`,
    );
    return;
  }
  const name = args[0].toLowerCase();
  if (name === "clear") {
    await setPrefs(env, userId, { combo: null });
    await tgSend(env, chatId, "✅ پیش‌فرض combo پاک شد — از الان chat.");
    return;
  }
  const known = Boolean(RULES[name]) || cfg.combos.some((c) => c.name === name);
  if (!known) {
    const valid = [...cfg.combos.map((c) => c.name), ...builtins];
    await tgSend(env, chatId, `combo ناشناس: ${name}\ncomboهای معتبر: ${valid.join(", ")}`);
    return;
  }
  await setPrefs(env, userId, { combo: name });
  await tgSend(env, chatId, `✅ پیش‌فرض combo: ${name}`);
}

// /route on|off → auto؛ /showmodel on|off → show
function tgToggleValue(raw) {
  const v = String(raw ?? "").toLowerCase();
  if (v === "on" || v === "true" || v === "1") return { on: true, off: false, ok: true };
  if (v === "off" || v === "false" || v === "0") return { on: false, off: true, ok: true };
  return { on: false, off: false, ok: false };
}

async function tgCommand(env, chatId, text, userId) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (cmd === "/help") {
    await tgSend(env, chatId, HELP_TEXT);
    return;
  }
  if (cmd === "/combo") {
    return tgCombo(env, chatId, args, userId);
  }
  if (cmd === "/route" || cmd === "/showmodel") {
    const v = tgToggleValue(args[0]);
    if (!v.ok) {
      await tgSend(env, chatId, `فرمت: ${cmd} on|off`);
      return;
    }
    const field = cmd === "/route" ? "auto" : "show";
    await setPrefs(env, userId, { [field]: v.on });
    const label =
      cmd === "/route"
        ? `مسیریابی خودکار: ${v.on ? "روشن" : "خاموش"}`
        : `نمایش مدل در پاسخ: ${v.on ? "روشن" : "خاموش"}`;
    await tgSend(env, chatId, `✅ ${label}`);
    return;
  }
  if (cmd === "/intent") {
    const v = tgToggleValue(args[0]);
    if (!v.ok) {
      await tgSend(env, chatId, "فرمت: /intent on|off");
      return;
    }
    await setPrefs(env, userId, { intent: v.on });
    await tgSend(
      env,
      chatId,
      `✅ مسیریابی intent: ${v.on ? "روشن" : "خاموش"}\nIntent routing: ${v.on ? "on" : "off"}`,
    );
    return;
  }
  if (cmd === "/dev") {
    const prompt = text.slice(cmd.length).trim();
    if (!prompt) {
      await tgSend(
        env,
        chatId,
        "فرمت: /dev <prompt>\nمثال: /dev add a /health endpoint to the worker",
      );
      return;
    }
    const r = await dispatchDev(env, prompt, chatId, userId);
    await tgSend(env, chatId, r.text);
    return;
  }
  if (cmd === "/diag") {
    const prArg = (args[0] ?? "").trim();
    let prNumber = null;
    if (/^\d{1,12}$/.test(prArg)) prNumber = Number(prArg);
    else prNumber = await findLatestDispatchPR(env);
    if (!prNumber) {
      await tgSend(env, chatId, "PR dispatch پیدا نشد.\nNo dispatch PR found.");
      return;
    }
    const diagText = await getDiag(env, prNumber);
    await tgSend(env, chatId, diagText.slice(0, 4000));
    return;
  }
  if (cmd === "/models") {
    return tgModels(env, chatId, args[0] ?? "chat");
  }
  if (cmd === "/combos") {
    return tgCombos(env, chatId);
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
  const cfg = await getConfig(env);
  const [ov] = await Promise.all([getOverrides(env)]);
  const counts = await healthCounts(env);
  const lines = [];
  for (const p of cfg.providers) {
    const r = await env.STATE.get(`catalog:${p.id}`, "json");
    lines.push(
      `${p.id}${p.enabled === false ? " (خاموش)" : ""}: ${r?.models?.length ?? 0} مدل${
        r?.updatedAt ? ` — آخرین sync: ${ageString(r.updatedAt)}` : " — هنوز sync نشده"
      }`,
    );
  }
  const pinnedTotal = Object.values(ov.pins).reduce((n, l) => n + l.length, 0);
  const cooldownLine = cfg.providers
    .map((p) => `${p.id}: ${counts.counts[p.id] ?? 0}`)
    .join(" | ");
  lines.push(`بن‌شده: ${ov.bans.length} | pin‌شده: ${pinnedTotal}`);
  lines.push(
    `❄ کول‌داونِ فعلی — ${cooldownLine}${
      counts.providerBlocked.length ? `\nمنع کل provider: ${counts.providerBlocked.join(", ")}` : ""
    }`,
  );
  await tgSend(env, chatId, lines.join("\n"));
}

function ageString(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return iso;
  if (mins < 60) return `${mins} دقیقه پیش`;
  if (mins < 1440) return `${Math.round(mins / 60)} ساعت پیش`;
  return `${Math.round(mins / 1440)} روز پیش`;
}

// ── intent routing (chat | dev | task) ──────────────────────────────────────

const PENDING_TTL_SEC = 600;

function pendingIntentKey(userId) {
  return `intent:pending:${String(userId ?? "")}`;
}

async function setPendingIntent(env, userId, payload) {
  if (!env.STATE) return;
  await env.STATE.put(pendingIntentKey(userId), JSON.stringify(payload), {
    expirationTtl: PENDING_TTL_SEC,
  });
}

async function takePendingIntent(env, userId) {
  if (!env.STATE) return null;
  const raw = await env.STATE.get(pendingIntentKey(userId), "json");
  await env.STATE.delete(pendingIntentKey(userId));
  return raw && typeof raw === "object" ? raw : null;
}

function callbackChatId(cb) {
  return cb?.message?.chat?.id ?? cb?.from?.id;
}

async function runIntent(env, chatId, userId, text, intent, hasImage) {
  if (intent.intent === "dev") {
    const r = await dispatchDev(env, text, chatId, userId);
    await tgSend(env, chatId, r.text);
    return;
  }
  if (intent.intent === "task") {
    const r = await runTask(env, { kind: "task", prompt: text, chatId, userId });
    if (r.ok) {
      if (r.text) await tgSend(env, chatId, r.text);
      return;
    }
    // executor تنظیم نشده → پیام کوتاه + دکمه‌ی «فقط چت»
    await setPendingIntent(env, userId, { prompt: text, intent: "task", hasImage: hasImage === true });
    await tgApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        "⚙️ اجراکننده‌ی task پیکربندی نشده.\n" +
        "Task executor is not configured. Continue as chat?",
      reply_markup: {
        inline_keyboard: [[{ text: "💬 فقط چت / Just chat", callback_data: "intent:chat" }]],
      },
    });
    return;
  }
  await answerChatText(env, chatId, userId, text, hasImage);
}

async function handlePlainText(env, msg, text, opts = {}) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  // Allow-list already checked in handleUpdate; only then create the row.
  await ensureUserRow(env, userId);
  // Order: explicit /dev (tgCommand) -> everyday -> chat/task/dev.
  const daily = await handleDailyText(env, { chatId, userId, text, source: opts.source, hasImage: updateHasImage(msg), ...dailySenders(env, chatId),
    chat: (modelText, copts) => answerChatText(env, chatId, userId, modelText, updateHasImage(msg), copts) });
  // Model already said chat for a text message: answer directly, skip
  // classifyIntent (dev was in the model allow-list and was rejected).
  // Image messages keep today's path (they return "chat", not "chat-direct").
  if (daily === "chat-direct") { await answerChatText(env, chatId, userId, text, updateHasImage(msg)); return; }
  if (daily !== "chat") return;

  const prefs = await getPrefs(env, userId);
  if (prefs.intent === false) {
    await answerChatText(env, chatId, userId, text, updateHasImage(msg));
    return;
  }

  const intent = await classifyIntent(text, { env });
  if (intent.intent === "dev") {
    // Free-text dev only SUGGESTS /dev now; it never dispatches.
    await tgSend(env, chatId, freeTextDevSuggestion());
    return;
  }
  if (needsConfirmation(intent)) {
    await setPendingIntent(env, userId, {
      prompt: text,
      intent: intent.intent,
      hasImage: updateHasImage(msg) === true,
    });
    const pct = Math.round((Number(intent.confidence) || 0) * 100);
    await tgApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `🤔 حدس من: ${intent.intent} (اطمینان ${pct}٪)\n` +
        `My guess: ${intent.intent} (${pct}% confidence). Proceed?`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ بله / Yes", callback_data: "intent:yes" },
            { text: "💬 فقط چت / Just chat", callback_data: "intent:chat" },
          ],
        ],
      },
    });
    return;
  }

  await runIntent(env, chatId, userId, text, intent, updateHasImage(msg));
}

async function handleCallbackQuery(env, cb) {
  const fromId = cb?.from?.id;
  const chatId = callbackChatId(cb);
  const data = typeof cb?.data === "string" ? cb.data : "";

  try {
    await tgApi(env, "answerCallbackQuery", { callback_query_id: cb?.id });
  } catch {
    // پاسخ به callback اختیاری است
  }
  if (!fromId || !chatId || !isAllowed(env.ALLOWED_TG_IDS, fromId)) return;

  if (data.startsWith("daily:")) {
    await resolveDailyCallback(env, { fromId, chatId, data, ...dailySenders(env, chatId, cb?.message?.message_id),
      chat: (modelText, copts) => answerChatText(env, chatId, fromId, modelText, false, copts) });
    return;
  }

  const devMatch = /^dev:(approve|reject):(\d{1,12})$/.exec(data);
  if (devMatch) {
    const pr = Number(devMatch[2]);
    const result =
      devMatch[1] === "approve" ? await approveDevPR(env, pr) : await rejectDevPR(env, pr);
    if (result.ok) {
      await setDevActive(env, fromId, false);
      // Remove stale inline buttons from the original PR message (ignore errors).
      try {
        await tgApi(env, "editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: cb?.message?.message_id,
          reply_markup: { inline_keyboard: [] },
        });
      } catch {
        // ignore
      }
    }
    await tgSend(env, chatId, result.text);
    return;
  }

  const ciMatch = /^dev:ci:(\d{1,12})$/.exec(data);
  if (ciMatch) {
    const pr = Number(ciMatch[1]);
    let ciEmoji = "⏳";
    let ciState = "pending";
    let ciReason = "pending";
    let targetUrl = "";
    let extra = "";
    try {
      const ci = await getPRCiState(env, pr);
      ciState = ci.state;
      ciReason = ci.reason;
      ciEmoji = ciStateEmoji(ci.state === "success" ? "success" : ci.state === "failure" ? "failure" : "pending");
      const shaShort = ci.short_sha || String(ci.sha ?? "").slice(0, 7);
      const run = ci.run;
      targetUrl = run?.html_url ? String(run.html_url) : (ci.target_url ? String(ci.target_url) : "");
       if (run) {
          extra = `\nrun #${run.run_number ?? "?"} on ${shaShort}`;
          if (targetUrl) extra += `\n${targetUrl}`;
       } else {
         extra = "";
       }
      if (ci.state === "forbidden") {
        extra += "\nToken lacks 'Commit statuses: Read' permission.";
      } else if (ci.state === "error") {
        extra += ci.http_status ? `\nHTTP ${ci.http_status}` : "";
      } else if (ci.state === "no_ci") {
        extra += `\nhttps://github.com/${devRepo(env)}/pull/${pr}/checks`;
      }
    } catch {
      ciEmoji = "⏳";
    }
     const text =
       `PR #${pr} — CI: ${ciEmoji} (${ciReason})` +
       (extra ? `${extra}` : "");
    try {
      await tgApi(env, "editMessageText", {
        chat_id: chatId,
        message_id: cb?.message?.message_id,
        text: text.slice(0, 4000),
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Approve / تأیید", callback_data: `dev:approve:${pr}` },
              { text: "🗑 Reject / رد", callback_data: `dev:reject:${pr}` },
            ],
            [{ text: "🔄 بررسی CI", callback_data: `dev:ci:${pr}` }],
          ],
        },
      });
    } catch {
      await tgSend(env, chatId, text);
    }
    return;
  }

  if (data === "intent:yes") {
    const pending = await takePendingIntent(env, fromId);
    if (!pending || typeof pending.prompt !== "string" || !pending.prompt.trim()) {
      await tgSend(env, chatId, "درخواست منقضی شده؛ دوباره بفرست.\nThis request expired; send it again.");
      return;
    }
    await runIntent(
      env,
      chatId,
      fromId,
      pending.prompt,
      { intent: pending.intent === "task" ? "task" : "dev", confidence: 1, reason: "confirmed" },
      pending.hasImage === true,
    );
    return;
  }

  if (data === "intent:chat") {
    const pending = await takePendingIntent(env, fromId);
    if (!pending || typeof pending.prompt !== "string" || !pending.prompt.trim()) {
      await tgSend(env, chatId, "درخواست منقضی شده؛ دوباره بفرست.\nThis request expired; send it again.");
      return;
    }
    await answerChatText(env, chatId, fromId, pending.prompt, pending.hasImage === true);
  }
}

async function handleUpdate(env, update) {
  if (update?.callback_query) {
    await handleCallbackQuery(env, update.callback_query);
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from || !msg.chat) return;

  const text = typeof msg.text === "string" ? msg.text.trim() : undefined;

  if (text === "/id") {
    await tgSend(env, msg.chat.id, String(msg.from.id));
    return;
  }

  if (!isAllowed(env.ALLOWED_TG_IDS, msg.from.id)) return;

  // Voice input, v1: transcript goes through the plain-text path exactly as
  // if typed. Transcription runs inside the /telegram waitUntil, so a slow
  // transcription never blocks the webhook reply (200 is sent immediately).
  const voice = msg.voice && typeof msg.voice === "object" ? msg.voice : null;
  if (voice) {
    await ensureUserRow(env, msg.from.id);
    await handleVoice(env, { userId: msg.from.id, chatId: msg.chat.id, voice, send: (t) => tgSend(env, msg.chat.id, t), route: (transcript) => handlePlainText(env, msg, transcript, { source: "voice" }) });
    return;
  }

  if (!text) {
    // Non-text file: photo (largest size) or document. Saved as kind
    // daily, no R2 in Step 1; summarising comes with the file step.
    const photo = Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1] : null;
    const doc = msg.document && typeof msg.document === "object" ? msg.document : null;
    const fileId = photo?.file_id ?? doc?.file_id;
    if (fileId) {
      await ensureUserRow(env, msg.from.id);
      const handled = await handleDailyFile(env, { userId: msg.from.id, chatId: msg.chat.id, tgFileId: fileId, fileName: doc?.file_name ?? null, fileMime: doc?.mime_type ?? (photo ? "image/jpeg" : null), caption: typeof msg.caption === "string" ? msg.caption : null, send: (msgText) => tgSend(env, msg.chat.id, msgText) });
      if (handled) return;
    }
    await tgSend(env, msg.chat.id, "فعلاً فقط پیام متنی پشتیبانی می‌شود 🙏");
    return;
  }

  if (text === "/start") {
    await tgSend(env, msg.chat.id, "سلام! من ایجنت شخصی تو هستم ✅ هر متنی بفرستی، مدل‌روتر جواب می‌دهد. لیست دستورها: /models");
  } else if (text === "/ping") {
    await tgSend(env, msg.chat.id, "pong");
  } else if (text.startsWith("/")) {
    await tgCommand(env, msg.chat.id, text, msg.from.id);
  } else {
    // عکس/فایل تصویری هنوز هندل نمی‌شود (پیام متنی فقط)؛ hasImage فقط flag تابع طبقه‌بندی است.
    await handlePlainText(env, msg, text);
  }
}

// ── POST /dev/callback — امضاشده با HMAC از GitHub Actions ───────────────────
async function devCallback(request, env) {
  if (!env.DEV_CALLBACK_SECRET) {
    return Response.json({ ok: false, error: "dev callback not configured" }, { status: 503 });
  }
  let raw;
  try {
    raw = await request.text();
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  const verified = await verifyCallbackSignature(
    env,
    raw,
    request.headers.get("X-Signature") ?? "",
  );
  if (!verified.ok) {
    // فقط کد خطا — هرگز بدنه یا امضا لاگ نمی‌شود.
    console.log(JSON.stringify({ dev_callback: "rejected", code: verified.code }));
    return Response.json({ ok: false }, { status: 401 });
  }

  const body = verified.body;
  const pr = Number(body.pr);
  const ok = body.ok === true && Number.isInteger(pr) && pr > 0;
  const chatId = body.chat_id ?? body.user_id;
  const userId = body.user_id ?? body.chat_id;
  if (userId) await setDevActive(env, userId, false);

  if (!chatId) return Response.json({ ok: true, delivered: false });

  const reason =
    typeof body.reason === "string" ? body.reason.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  const noPr = !ok && reason === "no PR found";
  let text = ok
    ? `🤖 اجرای dev تمام شد — PR #${pr} آماده‌ی بررسی است.\nDev run finished — PR #${pr} is ready for review.`
    : noPr
      ? `ℹ️ تغییری ایجاد نشد — PR جدیدی ساخته نشد.\nNo change was created — no new PR.`
      : `❌ اجرای dev متوقف شد — ${reason || "بدون PR"}\nDev run blocked — ${reason || "no PR"}`;
  const url = safeGithubUrl(body.url);
  if (url) text += `\n${url.slice(0, 300)}`;

  if (ok) {
    // CI state line (usually still pending at first send).
    let ciEmoji = "⏳";
    let ciLine = "CI: ⏳";
    try {
      const ci = await getPRCiState(env, pr);
      ciEmoji = ciStateEmoji(ci.state === "success" ? "success" : ci.state === "failure" ? "failure" : "pending");
      const shaShort = ci.short_sha || String(ci.sha ?? "").slice(0, 7);
      if (ci.run) {
        ciLine = `CI: ${ciEmoji} run #${ci.run.run_number ?? "?"} on ${shaShort}`;
      } else {
        ciLine = `CI: ${ciEmoji} (${ci.state})`;
      }
    } catch {
      ciEmoji = "⏳";
    }
    text += `\n${ciLine}`;
  }

  const payload = { chat_id: chatId, text: text.slice(0, 4000) };
  if (ok) {
    payload.reply_markup = {
      inline_keyboard: [
        [
          { text: "✅ Approve / تأیید", callback_data: `dev:approve:${pr}` },
          { text: "🗑 Reject / رد", callback_data: `dev:reject:${pr}` },
        ],
        [{ text: "🔄 بررسی CI", callback_data: `dev:ci:${pr}` }],
      ],
    };
  }
  await tgApi(env, "sendMessage", payload);
  return Response.json({ ok: true, delivered: true });

}

function truncateV1(text, limit = 400) {
  const s = String(text ?? "");
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

async function chatCompletions(request, env) {
  const auth = routerAuth(request, env);
  if (auth) return auth;

  let body;
  try {
    body = await request.json();
  } catch {
    return openAiError(400, "invalid JSON body", "invalid_request_error", "invalid_body");
  }
  if (!body || typeof body !== "object" || typeof body.model !== "string" || !body.model) {
    return openAiError(400, "body.model is required", "invalid_request_error", "missing_model");
  }
  if (!Array.isArray(body.messages)) {
    return openAiError(400, "body.messages must be an array", "invalid_request_error", "missing_messages");
  }

  const stream = body.stream === true;
  const started = Date.now();
  const result = await runCombo(env, body.model, body, { stream });
  const latencyMs = Date.now() - started;

  // لاگ فقط metadata — هیچ محتوای پیام یا کلیدی اینجا نمی‌آید
  console.log(
    JSON.stringify({
      v1: "chat",
      model: truncateV1(body.model, 120),
      stream,
      ok: Boolean(result?.ok),
      used: truncateV1(result?.used ?? null, 120),
      latency: latencyMs,
      targetErrors: result?.ok ? 0 : (result?.errors ?? []).length,
    }),
  );

  if (result.ok) {
    if (stream) {
      const { readable } = wrapSseStream(result.stream, truncateV1(result.used ?? body.model, 120));
      const ct = String(result.contentType ?? "");
      return new Response(readable, {
        headers: {
          "content-type": ct.includes("event-stream") ? ct : "text/event-stream",
          "cache-control": "no-store",
          "X-Router-Used": result.used ?? "",
        },
      });
    }
    return new Response(JSON.stringify(result.data), {
      headers: { "content-type": "application/json", "X-Router-Used": result.used ?? "" },
    });
  }

  // 502: OpenAI error shape + (برای دیباگ) همان errors/available قبلی — شکل قبلی حفظ می‌شود
  const reasons = (result.errors ?? [])
    .map((e) => `${e.target}: ${e.reason ?? e.status ?? "?"}`)
    .join("; ");
  return Response.json(
    {
      error: {
        message: truncateV1(`no target succeeded for ${JSON.stringify(body.model)} — ${reasons}`),
        type: "api_error",
        code: "combo_unavailable",
      },
      ok: false,
      errors: result.errors ?? [],
      available: await comboNameList(env, 50),
    },
    { status: 502 },
  );
}

// لیست comboهای موجود (دستی + داخلی) — برای 502 و /v1/models؛ سقف اختیاری.
async function comboNameList(env, cap) {
  const cfg = await getConfig(env);
  const manualNames = cfg.combos.map((c) => c.name);
  const names = [...manualNames, ...Object.keys(RULES).filter((n) => !manualNames.includes(n))];
  return cap ? names.slice(0, cap) : names;
}

// GET /v1/models — comboها با آی‌دی «combo/<name>» و owned_by "router"؛
// مدل‌های sync‌شده‌ی providerها هم اضافه می‌شوند (اختیاری — خرابی کاتالوگ بی‌اثر).
async function v1Models(env) {
  const names = await comboNameList(env);
  const now = Math.floor(Date.now() / 1000);
  const data = names.map((name) => ({
    id: `combo/${name}`,
    object: "model",
    created: now,
    owned_by: "router",
  }));
  try {
    const catalog = await loadCatalog(env);
    for (const m of catalog) {
      data.push({ id: `${m.provider}/${m.id}`, object: "model", created: 0, owned_by: m.provider });
    }
  } catch {
    // بدون کاتالوگ هم comboها فهرست می‌شوند
  }
  return { object: "list", data };
}

async function adminModels(request, env) {
  const key = request.headers.get("X-Setup-Key") ?? "";
  if (!safeEqual(key, adminKey(env))) {
    return new Response("unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const providerName = url.searchParams.get("provider") ?? "";
  const pctx = await getProviderCtx(env, providerName);
  if (!pctx) {
    return Response.json(
      { ok: false, error: `unknown provider: ${providerName}` },
      { status: 400 },
    );
  }

  let models;
  try {
    models = await listProviderModels(env, pctx);
  } catch (err) {
    if (err?.info) return Response.json(err.info, { status: 502 });
    return Response.json(
      { ok: false, error: String(err && err.message).slice(0, 200) },
      { status: 502 },
    );
  }

  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  let out = models;
  if (q) out = out.filter((m) => m.id.toLowerCase().includes(q));
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  out = out.map((m) => {
    const entry = { id: m.id };
    if (!pctx.builtin || pctx.id !== "nvidia") {
      if (m.context !== null) entry.context_length = m.context;
      if (m.vision !== null) entry.vision = m.vision;
    }
    return entry;
  });
  return Response.json(out);
}

async function adminRefresh(request, env) {
  const key = request.headers.get("X-Setup-Key") ?? "";
  if (!safeEqual(key, adminKey(env))) {
    return new Response("unauthorized", { status: 401 });
  }

  const provider = new URL(request.url).searchParams.get("provider") ?? "all";
  const ids = await providerIds(env);
  const list = provider === "all" ? ids : [provider];
  if (provider !== "all" && !ids.includes(provider)) {
    return Response.json(
      { ok: false, error: `unknown provider: ${provider}` },
      { status: 400 },
    );
  }

  const result = {};
  for (const p of list) {
    try {
      const r = await syncProvider(env, p);
      result[p] = {
        added: r.added.length,
        removed: r.removed.length,
        fetched: r.sync.fetched,
        kept: r.sync.kept,
        dropped: r.sync.droppedCount,
      };
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
  if (!safeEqual(key, adminKey(env))) {
    return new Response("unauthorized", { status: 401 });
  }
  const target = new URL(request.url).searchParams.get("target") ?? "";
  const slash = target.indexOf("/");
  const providerOk = slash > 0 && Boolean(await getProviderCtx(env, target.slice(0, slash)));
  if (!providerOk || !target.slice(slash + 1)) {
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
  if (!safeEqual(key, adminKey(env))) {
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

// ── Admin JSON API (/admin/api/*) ──────────────────────────────────────────
// احراز هویت: هدر X-Setup-Key یا کوکی امضاشده admin_session — مقایسه constant-time.
// JSON فقط؛ مقادیر secret هرگز برایند نمی‌شوند.

function json(data, status = 200) {
  return Response.json(data, { status });
}

const SESSION_TTL_MS = 7 * 86400 * 1000;

async function signSessionToken(env, exp) {
  const enc = new TextEncoder();
  const macKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(adminKey(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", macKey, enc.encode(String(exp)));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${exp}.${hex}`;
}

async function adminApiAuthorized(request, env) {
  const key = request.headers.get("X-Setup-Key") ?? "";
  if (key && safeEqual(key, adminKey(env))) return true;
  const cookie = request.headers.get("Cookie") ?? "";
  const m = /(?:^|;\s*)admin_session=([^;\s]+)/.exec(cookie);
  if (!m) return false;
  let val;
  try {
    val = decodeURIComponent(m[1]);
  } catch {
    return false;
  }
  const dot = val.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(val.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now() || exp > Date.now() + SESSION_TTL_MS) return false;
  const expected = await signSessionToken(env, exp);
  return safeEqual(val, expected);
}

async function readJsonBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

async function adminPage() {
  return new Response(ADMIN_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';",
      "x-frame-options": "DENY",
      "cache-control": "no-store",
    },
  });
}

const SESSION_COOKIE = "admin_session";

function sessionCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

async function adminLogin(request, env) {
  const body = await readJsonBody(request);
  const key = body && String(body.key ?? "");
  if (!key || !safeEqual(key, adminKey(env))) {
    // خطای عمومی — key بازتابانده نمی‌شود
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  const exp = Date.now() + SESSION_TTL_MS;
  const token = await signSessionToken(env, exp);
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "content-type": "application/json",
      "set-cookie": sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)),
    },
  });
}

function adminLogout() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "content-type": "application/json",
      "set-cookie": sessionCookie("", 0),
    },
  });
}

async function adminApiListModels(request, env) {
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") ?? "";
  const ctx = await getProviderCtx(env, provider);
  if (!ctx) return json({ ok: false, error: `unknown provider: ${provider}` }, 400);
  const cat = await env.STATE.get(`catalog:${provider}`, "json");
  const q = (url.searchParams.get("q") ?? "").toLowerCase();

  const [ov] = await Promise.all([getOverrides(env)]);
  const banSet = new Set((ov.bans ?? []).map((b) => String(b).toLowerCase()));
  const cooled = new Set(
    (await env.STATE.list({ prefix: `health:${provider}/` })).keys.map((k) => k.name),
  );
  const out = (cat?.models ?? [])
    .filter((m) => !q || m.id.toLowerCase().includes(q))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((m) => {
      const target = `${provider}/${m.id}`.toLowerCase();
      const status = banSet.has(target) ? "banned" : cooled.has(`health:${target}`) ? "cooldown" : "ok";
      return { id: m.id, status, tags: capabilityTags(m), vision: m.vision === true };
    });
  return json({ ok: true, provider, models: out });
}

// کد استاندارد شکست برای نتیجه‌کارت صفحه‌ی admin: timeout|auth|notfound|ratelimit|server|unknown
function failLabelCode(r) {
  if (!r || r.ok) return null;
  const snippet = String(r.snippet ?? "");
  if (snippet.startsWith("timeout")) return "timeout";
  const unwrap = /key rejected/i.test(snippet) ? "auth" : null;
  const s = typeof r.status === "number" ? r.status : null;
  if ((s === 401 || s === 403) || (s === null && unwrap)) return "auth";
  if (s === 404) return "notfound";
  if (s === 429) return "ratelimit";
  if (s !== null && s >= 500) return "server";
  return "unknown";
}

// تعبیر reasonهای runCombo («key rejected (401)»، «http 429»، «timeout»، ...) به همان کدها
function comboFailLabelCode(reason) {
  const r = String(reason ?? "");
  if (r === "timeout" || r.startsWith("timeout")) return "timeout";
  if (/key rejected/i.test(r)) return "auth";
  const m = /http (\d{3})/.exec(r);
  if (m) {
    const s = Number(m[1]);
    if (s === 401 || s === 403) return "auth";
    if (s === 404) return "notfound";
    if (s === 429) return "ratelimit";
    if (s >= 500) return "server";
    return "unknown";
  }
  return "unknown";
}

async function adminApiTest(request, env) {
  const body = await readJsonBody(request);
  if (!body || (!body.provider && !body.combo)) {
    return json({ ok: false, error: "provider or combo is required" }, 400);
  }

  if (body.combo) {
    // تست combo از مسیر خود روتر — یک بار اجرا
    const name = String(body.combo);
    const started = Date.now();
    const res = await runCombo(env, name, TEST_BODY, { deadlineMs: 25000 });
    const latencyMs = Date.now() - started;
    if (res.ok) {
      const content = res.data?.choices?.[0]?.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((p) => p?.text ?? "").join("")
            : JSON.stringify(res.data ?? {});
      return json({
        ok: true,
        combo: name,
        used: res.used,
        status: 200,
        latencyMs,
        text: String(text).slice(0, 200),
        label: null,
      });
    }
    const e0 = res.errors?.[0] ?? null;
    return json({
      ok: false,
      combo: name,
      status: e0?.status ?? null,
      latencyMs,
      text: "",
      label: e0 ? comboFailLabelCode(e0.reason) : "unknown",
    });
  }

  const ctx = await getProviderCtx(env, String(body.provider));
  if (!ctx) return json({ ok: false, error: `unknown provider: ${body.provider}` }, 400);
  const model = body.model ? String(body.model) : "";
  if (!model) {
    // تست در سطح provider: یک GET /models سبک (بدون نشان دادن مقدار کلید)
    try {
      const list = await listProviderModels(env, ctx);
      return json({ ok: true, provider: ctx.id, kind: "models", count: list.length });
    } catch (err) {
      return err?.info
        ? json(err.info, 502)
        : json({ ok: false, error: String(err && err.message).slice(0, 200) }, 502);
    }
  }
  const r = await directCall(env, String(body.provider), String(body.model), TEST_BODY, {
    timeoutMs: 20000,
  });
  return json(normalizeTestResult(r, String(body.provider), String(body.model)));
}

// بدنه‌ی نهایی پاسخ تست مدل — شکل نرمال برای کارت نتیجه
function normalizeTestResult(r, provider, model) {
  const label = failLabelCode(r);
  return {
    ok: r.ok === true,
    provider,
    model,
    status: r.status ?? null,
    latencyMs: r.latencyMs ?? null,
    snippet: r.snippet ?? "",
    text: r.ok ? r.snippet ?? "" : "",
    label,
  };
}

// بدون mutation خطرناک: خطای apiError → 400 با پیام کوتاه؛ بقیه ۵۰۰ با نام خطا
async function adminApi(request, env, method, pathname) {
  const parts = pathname.split("/").filter(Boolean); // ["admin","api",...]
  const kind = parts[2];
  const id = parts[3] ?? "";
  const sub = parts[4] ?? "";

  try {
    if (method === "GET" && kind === "config") {
      const cfg = await getConfig(env);
      // فقط نام راز (secretName) — مقدار هرگز
      return json({ ok: true, providers: cfg.providers, combos: cfg.combos });
    }

    if (kind === "models" && method === "GET") return await adminApiListModels(request, env);
    if (kind === "test" && method === "POST") return await adminApiTest(request, env);

    if (kind === "providers") {
      if (method === "POST" && !id && !sub) {
        const body = await readJsonBody(request);
        if (!body) return json({ ok: false, error: "invalid json body" }, 400);
        const p = await upsertProvider(env, body);
        return json({
          ok: true,
          provider: { id: p.id, name: p.name, baseUrl: p.baseUrl, secretName: p.secretName, enabled: p.enabled },
        });
      }
      if (method === "PUT" && id && !sub) {
        const body = await readJsonBody(request);
        if (!body) return json({ ok: false, error: "invalid json body" }, 400);
        const p = await upsertProvider(env, { ...body, id });
        return json({
          ok: true,
          provider: { id: p.id, name: p.name, baseUrl: p.baseUrl, secretName: p.secretName, enabled: p.enabled },
        });
      }
      if (method === "DELETE" && id && !sub) {
        await removeProvider(env, id);
        return json({ ok: true, deleted: id });
      }
      if (method === "GET" && id && sub === "sync-report") {
        const pctx = await getProviderCtx(env, id);
        if (!pctx) return json({ ok: false, error: `unknown provider: ${id}` }, 400);
        const report = await getSyncReport(env, id);
        if (!report) return json({ ok: false, error: "no sync report yet" }, 404);
        return json({ ok: true, provider: id, ...report });
      }
      if (method === "POST" && id && sub === "refresh") {
        const r = await syncProvider(env, id);
        return json({
          ok: true,
          provider: id,
          added: r.added.length,
          removed: r.removed.length,
          fetched: r.sync.fetched,
          kept: r.sync.kept,
          dropped: r.sync.droppedCount,
        });
      }
    }

    // انتخاب زنده‌ی combo خودکار (chat/code/vision/fast) — targets cap ۸ برای «ساخت نسخه‌ی دستی»
    if (kind === "auto" && method === "GET" && id && !sub) {
      if (!Object.prototype.hasOwnProperty.call(RULES, id)) {
        return json({ ok: false, error: `unknown auto combo: ${id}` }, 404);
      }
      const sel = await getComboTargets(env, id);
      if (sel.error) return json({ ok: false, error: sel.error }, 400);
      return json({
        ok: true,
        name: id,
        kind: AUTO_KINDS[id] ?? "custom",
        targets: sel.targets.slice(0, 8).map((t) => ({ provider: t.provider, model: t.model, enabled: true })),
      });
    }

    if (kind === "combos") {
      if (method === "POST" && !id) {
        const body = await readJsonBody(request);
        if (!body) return json({ ok: false, error: "invalid json body" }, 400);
        const c = await upsertCombo(env, body);
        return json({ ok: true, combo: c });
      }
      if (method === "PUT" && id) {
        const body = await readJsonBody(request);
        if (!body) return json({ ok: false, error: "invalid json body" }, 400);
        const c = await upsertCombo(env, { ...body, name: id });
        return json({ ok: true, combo: c });
      }
      if (method === "DELETE" && id) {
        await removeCombo(env, id);
        return json({ ok: true, deleted: id });
      }
    }

    return json({ ok: false, error: "not found" }, 404);
  } catch (err) {
    return err?.apiError
      ? json({ ok: false, error: err.message }, 400)
      : json({ ok: false, error: String(err && err.name).slice(0, 60) }, 500);
  }
}

async function route(request, env, ctx) {
  const { pathname } = new URL(request.url);

  if (request.method === "GET" && pathname === "/") {
    return new Response("ok");
  }

  if (request.method === "GET" && pathname === "/health") {
    return Response.json({ ok: true });
  }

  if (request.method === "POST" && pathname === "/v1/chat/completions") {
    return chatCompletions(request, env);
  }

  if (request.method === "GET" && pathname === "/v1/models") {
    const auth = routerAuth(request, env);
    if (auth) return auth;
    return Response.json(await v1Models(env));
  }

  if (request.method === "POST" && pathname === "/dev/callback") {
    return devCallback(request, env);
  }

  if (request.method === "GET" && (pathname === "/admin" || pathname === "/admin/")) {
    if (missingSecretName(env)) return missingSecretResponse(env);
    return adminPage();
  }

  if (request.method === "POST" && pathname === "/admin/login") {
    if (missingSecretName(env)) return missingSecretResponse(env);
    return adminLogin(request, env);
  }

  if (request.method === "POST" && pathname === "/admin/logout") {
    return adminLogout();
  }

  if (request.method === "GET" && pathname === "/admin/models") {
    if (missingSecretName(env)) return missingSecretResponse(env);
    return adminModels(request, env);
  }

  if (pathname.startsWith("/admin/api/")) {
    if (missingSecretName(env)) return missingSecretResponse(env);
    if (!(await adminApiAuthorized(request, env))) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
    return adminApi(request, env, request.method, pathname);
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
    if (!safeEqual(key, adminKey(env))) {
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
          allowed_updates: ["message", "callback_query"],
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
