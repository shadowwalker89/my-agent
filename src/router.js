import { redact } from "./providers.js";
import { RULES, pickModels, diversify, compilePrefer, scoreModel } from "./combos.js";
import { getProviderCtx, getConfig } from "./config.js";
import { loadCatalog } from "./catalog.js";
import { getOverrides, resolvePins } from "./overrides.js";
import {
  getUnhealthyProviders,
  isModelHealthy,
  markFailure,
  recordLatency,
  getMedianLatency,
} from "./health.js";

const DEADLINE_MS = 25000;
const PER_TARGET_TIMEOUT_MS = 20000;
const MAX_HEALTH_CHECKS = 20;

function truncate(text) {
  const s = String(text ?? "");
  return s.length > 200 ? s.slice(0, 200) : s;
}

// نرمال‌سازی پاسخ upstream برای سازگاری با کلاینت استاندارد:
// - usage جاافتاده → صفر (شکل object حفظ می‌شود؛ فیلد extra حذف نمی‌شود)
// - finish_reason جاافتاده → از روی پیام استنباط می‌شود
// - role جاافتاده → assistant
// هیچ فیلد extra ای (مثل reasoning_content) حذف نمی‌شود.
export function normalizeOpenAiChat(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  if (Array.isArray(data.choices)) {
    for (const choice of data.choices) {
      if (!choice || typeof choice !== "object") continue;
      if (choice.message && typeof choice.message === "object" && choice.message.role == null) {
        choice.message.role = "assistant";
      }
      if (choice.finish_reason == null) {
        const m = choice.message;
        choice.finish_reason =
          Array.isArray(m?.tool_calls) && m.tool_calls.length > 0 ? "tool_calls" : "stop";
      }
    }
  }
  if (data.object == null) data.object = "chat.completion";
  if (data.created == null) data.created = Math.floor(Date.now() / 1000);
  if (!data.usage || typeof data.usage !== "object") {
    data.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  } else {
    // usage ناقص هم کامل می‌شود — فیلدهای موجود دست‌نخورده
    const u = data.usage;
    if (u.prompt_tokens == null) u.prompt_tokens = 0;
    if (u.completion_tokens == null) u.completion_tokens = 0;
    if (u.total_tokens == null) u.total_tokens = u.prompt_tokens + u.completion_tokens;
  }
  return data;
}

// طبقه‌بندی شکست upstream — تک‌نقطه‌ی تصمیم برای دامنه و مدت سردی:
// scope "model" = فقط همین مدل سرد می‌شود؛ scope "provider" = کل provider.
// برچسب فقط از status عددی ساخته می‌شود؛ هیچ‌وقت چیزی مثل "http undefined" نمی‌شود.
export function classifyFailure(status, bodySnippet, isTimeout) {
  if (isTimeout) return { scope: "model", cooldownSec: 600, label: "timeout" };
  if (status === 401 || status === 403) {
    return { scope: "provider", cooldownSec: 3600, label: "key rejected" };
  }
  const body = String(bodySnippet ?? "");
  if (status === 404) {
    const matched =
      /Function .* Not found for account/i.test(body) || body.includes("404 page not found");
    return {
      scope: "model",
      cooldownSec: 86400,
      label: matched ? "model not available (http 404)" : "http 404",
    };
  }
  if (status === 400 || status === 410) {
    return { scope: "model", cooldownSec: 86400, label: `http ${status}` };
  }
  if (typeof status === "number" && (status === 429 || status >= 500)) {
    return { scope: "model", cooldownSec: 900, label: `http ${status}` };
  }
  return {
    scope: "model",
    cooldownSec: 600,
    label: typeof status === "number" ? `http ${status}` : "upstream error",
  };
}

// ترتیب هدف‌ها بر حسب استراتژی combo دستی (pure؛ برای تست آفلاین هم قابل استفاده)
// - priority: ترتیب ذخیره‌شده (fallback ترتیبی)
// - round-robin: چرخش از اندیس ذخیره‌شده‌ی KV
// - fastest: صعودیِ میانه‌ی تأخیر؛ بدون داده → ترتیب اولویت (stable)
export function sortForStrategy(targets, strategy, { rrStart = 0, medians = {} } = {}) {
  const list = [...targets];
  if (!list.length) return [];
  if (strategy === "round-robin") {
    const start = ((rrStart % list.length) + list.length) % list.length;
    return list.slice(start).concat(list.slice(0, start));
  }
  if (strategy === "fastest") {
    return list
      .map((t, i) => ({ t, i, ms: medians[String(`${t.provider}/${t.model}`)] }))
      .sort(
        (a, b) =>
          (a.ms ?? Infinity) - (b.ms ?? Infinity) ||
          a.score - b.score ||
          a.i - b.i,
      )
      .map((x) => x.t);
  }
  return list;
}

export async function getComboTargets(env, name) {
  const cfg = env.STATE ? await getConfig(env) : { providers: [], combos: [] };
  const manual = (cfg.combos ?? []).find((c) => c.name === name);
  if (manual) return getManualComboTargets(env, manual, cfg);

  const rule = RULES[name];
  if (!rule) return { error: `unknown combo: ${name}` };

  const [catalog, ov, unhealthyProviders] = await Promise.all([
    loadCatalog(env),
    getOverrides(env),
    getUnhealthyProviders(env),
  ]);
  if (!catalog.length) {
    return {
      error: "catalog is empty - run /refresh (or POST /admin/refresh) first, then retry",
    };
  }

  const preferPatterns = ov.prefer?.[name] ?? null;
  const compiled = compilePrefer(preferPatterns ?? rule.prefer);
  const pins = resolvePins(ov.pins?.[name], catalog)
    .map((m) => ({
      ...m,
      score: scoreModel(m, compiled, { skipVlPenalty: rule.needsVision === true }),
    }))
    .filter((m) => !unhealthyProviders[m.provider]);
  const pinKeys = new Set(pins.map((m) => `${m.provider}/${m.id}`.toLowerCase()));
  const scored = pickModels(catalog, rule, {
    prefer: preferPatterns,
    bans: ov.bans ?? [],
  })
    .filter((m) => !pinKeys.has(`${m.provider}/${m.id}`.toLowerCase()))
    .filter((m) => !unhealthyProviders[m.provider]);

  const need = Math.max(0, rule.maxTargets - pins.length);
  const healthy = [];
  let checks = 0;
  for (const m of scored) {
    if (healthy.length >= need || checks >= MAX_HEALTH_CHECKS) break;
    checks++;
    if (await isModelHealthy(env, `${m.provider}/${m.id}`)) healthy.push(m);
  }

  const ordered = diversify(
    pins.map((m) => ({ ...m, pinned: true })),
    healthy,
    rule.maxTargets,
  );
  return {
    name,
    targets: ordered.map((m) => ({
      provider: m.provider,
      model: m.id,
      score: m.score,
      pinned: Boolean(m.pinned),
      caps: m.capabilities ?? null,
    })),
  };
}

// comboهای دستی از config:v1 — استراتژی، skip سردشده‌ها، بدون diversify
async function getManualComboTargets(env, combo, cfg) {
  const providerMap = new Map(cfg.providers.map((p) => [p.id, p]));
  const ov = await getOverrides(env);
  const banSet = new Set((ov.bans ?? []).map((b) => String(b).toLowerCase()));
  const unhealthy = await getUnhealthyProviders(env);

  const candidate = [];
  for (const t of combo.targets ?? []) {
    if (t.enabled === false) continue;
    const p = providerMap.get(t.provider);
    if (!p || p.enabled === false) continue; // provider جاافتاده/خاموش — بی‌صدا رد
    const used = `${t.provider}/${t.model}`;
    if (banSet.has(used.toLowerCase())) continue;
    if (unhealthy[t.provider]) continue; // منع کل provider
    if (!(await isModelHealthy(env, used))) continue; // کول‌داون مدل
    candidate.push({
      provider: t.provider,
      model: t.model,
      score: 0,
      ctx: { id: p.id, baseUrl: p.baseUrl, secretName: p.secretName, extraHeaders: p.extraHeaders ?? undefined },
    });
  }

  let rrStart = 0;
  if (combo.strategy === "round-robin" && env.STATE) {
    const cur = Number((await env.STATE.get(`rr:${combo.name}`)) ?? 0);
    rrStart = Number.isFinite(cur) ? cur : 0;
    const n = candidate.length || 1;
    await env.STATE.put(`rr:${combo.name}`, String((rrStart + 1) % n));
  }

  let medians = {};
  if (combo.strategy === "fastest") {
    for (const c of candidate) medians[`${c.provider}/${c.model}`] = await getMedianLatency(env, `${c.provider}/${c.model}`);
  }

  const ordered = sortForStrategy(candidate, combo.strategy, { rrStart, medians });
  return {
    name: combo.name,
    manual: {
      strategy: combo.strategy,
      timeoutMs: combo.timeoutMs,
      retries: combo.retries ?? 0,
    },
    targets: ordered.map((m) => ({
      provider: m.provider,
      model: m.model,
      score: m.score,
      pinned: false,
      ctx: m.ctx,
    })),
  };
}

// direct provider/model — با همه‌ی providerهای پیکربندی‌شده کار می‌کند (داخلی + دستی)
async function resolveDirect(nameOrProviderModel, env) {
  const s = String(nameOrProviderModel);
  const slash = s.indexOf("/");
  if (slash <= 0) return null;
  const provider = s.slice(0, slash);
  const model = s.slice(slash + 1);
  if (!model || /^\s*$/s.test(model)) return null;
  const ctx = await getProviderCtx(env, provider);
  if (!ctx) return null;
  return { provider, model, ctx };
}

// ctx = { id, baseUrl, secretName, extraHeaders } — همه‌ی providerها از config
async function tryTarget(env, ctx, model, body, timeoutMs) {
  if (!ctx) return { skipReason: "unknown provider" };
  const key = env[ctx.secretName];
  if (!key) return { skipReason: `missing ${ctx.secretName}` };

  const used = `${ctx.id}/${model}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  let res;
  try {
    res = await fetch(`${ctx.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        ...(ctx.extraHeaders ?? {}),
      },
      body: JSON.stringify({ ...body, model }),
    });
  } catch (err) {
    const isTimeout = err?.reason === "timeout";
    return {
      error: {
        target: used,
        reason: isTimeout ? "timeout" : truncate(`network: ${err && err.message}`),
      },
      cause: isTimeout ? "timeout" : `network: ${err && err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    return {
      error: { target: used, reason: `http ${res.status}` },
      cause: res.status,
      status: res.status,
      raw: redact(raw, [key], 200),
    };
  }
  return { res };
}

// مدلِ درخواستی از /v1: «combo/<name>» فقط combo؛ نام ساده یا «provider/model» هم قبول است.
// خروجی: { sel } (targets کامل) یا { direct } (فراخوانی مستقیم) یا { fail }  (خطای قطعی)
async function resolveRouterTarget(env, wanted) {
  const isComboRef = wanted.startsWith("combo/");
  const name = isComboRef ? wanted.slice("combo/".length) : wanted;

  if (!name) {
    return { fail: [{ target: truncate(wanted), reason: "unknown combo: empty combo name" }] };
  }
  if (RULES[name]) {
    return { name, sel: await getComboTargets(env, name) };
  }
  // combo دستی: هم برای نام ساده و هم بعد از پیشوند combo/
  const cfg = env.STATE ? await getConfig(env) : { providers: [], combos: [] };
  if ((cfg.combos ?? []).some((c) => c.name === name)) {
    return { name, sel: await getComboTargets(env, name) };
  }
  const unknownErr = [{ target: truncate(name), reason: `unknown combo: ${truncate(name)}` }];
  if (isComboRef) {
    // داده شده combo/<x> — بازگشت مستقیم روی provider نیست؛ فقط combo
    return { fail: unknownErr };
  }
  const direct = await resolveDirect(wanted, env);
  if (direct) {
    return { direct };
  }
  return { fail: [{ target: truncate(wanted), reason: `unknown combo or provider/model: ${truncate(wanted)}` }] };
}

export async function runCombo(
  env,
  comboNameOrProviderModel,
  body,
  { deadlineMs = DEADLINE_MS, perTargetTimeoutMs = PER_TARGET_TIMEOUT_MS, stream = false } = {},
) {
  const wanted = String(comboNameOrProviderModel);
  const resolved = await resolveRouterTarget(env, wanted);
  let targets;
  let manualCfg = null;
  let comboName = null;
  if (resolved.fail) {
    return { ok: false, errors: resolved.fail };
  } else if (resolved.direct) {
    const d = resolved.direct;
    targets = [{ provider: d.provider, model: d.model, score: 0, pinned: false, ctx: d.ctx }];
  } else {
    const sel = resolved.sel;
    if (sel.error) {
      return { ok: false, errors: [{ target: truncate(resolved.name), reason: truncate(sel.error) }] };
    }
    targets = sel.targets;
    manualCfg = sel.manual ?? null;
    comboName = resolved.name;
  }

  const started = Date.now();
  const errors = [];
  const maxRetries = manualCfg?.retries ?? 0;
  const perTargetTimeout = manualCfg?.timeoutMs ?? perTargetTimeoutMs;
  const needsTools = Array.isArray(body?.tools) && body.tools.length > 0;
  const deadline = manualCfg
    ? Math.min(55000, Math.max(deadlineMs, perTargetTimeout * (maxRetries + 2)))
    : deadlineMs;
  // اگر کلید یک provider رد شد (401/403)، بقیه‌ی هدف‌های همان provider در این
  // فراخوانی بی‌خیال می‌شوند — فقط یک پیام «key rejected» برمی‌گردد و provider
  // یک ساعت در health منع می‌شود (markFailure خودش این را ثبت می‌کند).
  const rejectedProviders = new Set();

  for (const t of targets) {
    if (rejectedProviders.has(t.provider)) continue;
    const usedModel = `${t.provider}/${t.model}`;
    const remaining = deadline - (Date.now() - started);
    if (remaining <= 0) {
      errors.push({ target: usedModel, reason: "deadline exceeded" });
      break;
    }

    if (t.model.startsWith("PLACEHOLDER")) {
      errors.push({ target: usedModel, reason: "placeholder model id" });
      continue;
    }
    // هدف بدون پشتیبانی ابزار وقتی tools خواسته شده — رد (فقط اگر metadata گویا باشد)
    if (needsTools && t.caps && t.caps.tools === false) {
      errors.push({ target: usedModel, reason: "no tool support" });
      continue;
    }

    let ctx = t.ctx;
    if (!ctx) ctx = await getProviderCtx(env, t.provider);
    if (!ctx) {
      errors.push({ target: usedModel, reason: "unknown provider" });
      continue;
    }
    if (ctx.enabled === false) continue;

    const t0 = Date.now();
    // retries برای combo دستی: فقط خطاهای گذرا (timeout/429/5xx) دوباره امتحان می‌شوند
    let attempt = null;
    let failure = null;
    for (let attemptNo = 0; ; attemptNo++) {
      attempt = await tryTarget(env, ctx, t.model, body, Math.min(perTargetTimeout, remaining));
      if (attempt.skipReason || !attempt.error) break;
      const isTimeout = attempt.cause === "timeout";
      const cls = classifyFailure(
        typeof attempt.cause === "number" ? attempt.cause : null,
        attempt.raw,
        isTimeout,
      );
      const retryable =
        isTimeout ||
        (typeof attempt.cause === "number" && (attempt.cause === 429 || attempt.cause >= 500));
      if (retryable && attemptNo < maxRetries) continue;
      failure = { isTimeout, cls, cause: attempt.cause };
      break;
    }

    const latencyMs = Date.now() - t0;

    if (attempt.skipReason) {
      errors.push({ target: usedModel, reason: attempt.skipReason });
    } else if (failure) {
      const { isTimeout, cls, cause } = failure;
      if (cls.scope === "provider") {
        rejectedProviders.add(t.provider);
        errors.push({
          target: usedModel,
          reason: `provider ${t.provider}: key rejected (${cause})`,
        });
      } else {
        const entry = { target: usedModel };
        if (typeof cause === "number") {
          entry.reason = cls.label;
          entry.status = cause;
        } else if (isTimeout) {
          entry.reason = cls.label;
        } else {
          entry.reason = truncate(cause);
        }
        errors.push(entry);
      }
      if (env.STATE) {
        try {
          await markFailure(env, usedModel, cls, isTimeout ? "timeout" : truncate(cause));
        } catch (err) {
          console.error("markFailure failed:", err && err.message);
        }
      }
    } else if (stream) {
      const res = attempt.res;
      if (res.body) {
        try {
          await recordLatency(env, usedModel, latencyMs);
        } catch (err) {
          console.error("recordLatency failed:", err && err.message);
        }
        return {
          ok: true,
          stream: res.body,
          contentType: res.headers.get("content-type"),
          used: usedModel,
          combo: comboName,
          latencyMs,
        };
      }
      errors.push({ target: usedModel, reason: "no stream body" });
      await markFailure(env, usedModel, classifyFailure(null, "", false), "no stream body");
    } else {
      const res = attempt.res;
      let data;
      try {
        data = await res.json();
      } catch (err) {
        errors.push({ target: usedModel, reason: truncate(`bad json: ${err && err.message}`) });
        await markFailure(env, usedModel, classifyFailure(null, "", false), "bad json response");
        continue;
      }

      const { message } = data?.choices?.[0] ?? {};
      const hasToolCalls =
        Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
      const content = message?.content;
      const empty =
        !hasToolCalls &&
        (!content ||
          (typeof content === "string" && !content.trim()) ||
          (Array.isArray(content) && content.length === 0));
      if (empty) {
        errors.push({ target: usedModel, reason: "empty assistant message" });
        await markFailure(env, usedModel, classifyFailure(null, "", false), "empty assistant message");
        continue;
      }

      try {
        await recordLatency(env, usedModel, latencyMs);
      } catch (err) {
        console.error("recordLatency failed:", err && err.message);
      }
      return {
        ok: true,
        data: normalizeOpenAiChat(data),
        used: usedModel,
        combo: comboName,
        latencyMs,
      };
    }
  }

  return { ok: false, errors };
}

// فراخوانی مستقیم یک هدف (همان کد مسیر روتتر؛ بدون فیلتر سلامت) برای /test.
// خروجی امن است: فقط status، تأخیر و اسنیپت رازپاک‌شده.
export async function directCall(env, providerName, model, body, { timeoutMs = 20000 } = {}) {
  const ctx = await getProviderCtx(env, providerName);
  if (!ctx) {
    return { ok: false, status: null, latencyMs: 0, snippet: `unknown provider: ${providerName}` };
  }
  const key = env[ctx.secretName];
  if (!key) {
    return { ok: false, status: null, latencyMs: 0, snippet: `missing ${ctx.secretName}` };
  }
  const started = Date.now();
  const attempt = await tryTarget(env, ctx, model, body, timeoutMs);
  const latencyMs = Date.now() - started;
  if (attempt.skipReason) {
    return { ok: false, status: null, latencyMs, snippet: attempt.skipReason };
  }
  if (attempt.error) {
    const isTimeout = attempt.cause === "timeout";
    const snippet = isTimeout
      ? `timeout بعد از ${Math.max(1, Math.round(timeoutMs / 1000))}s`
      : attempt.raw ||
        (typeof attempt.cause === "string" && attempt.cause !== "timeout"
          ? truncate(attempt.cause)
          : `http ${attempt.status ?? ""}`.trim());
    return {
      ok: false,
      status: attempt.status ?? null,
      latencyMs,
      snippet,
    };
  }
  let data;
  try {
    data = await attempt.res.json();
  } catch (err) {
    return { ok: false, status: attempt.res.status, latencyMs, snippet: `bad json: ${err && err.message}` };
  }
  const content = data?.choices?.[0]?.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((p) => p?.text ?? "").join("")
        : JSON.stringify(data ?? {});
  return { ok: true, status: attempt.res.status, latencyMs, snippet: redact(text, [key], 200) };
}
