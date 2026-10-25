import { PROVIDERS, redact } from "./providers.js";
import { RULES, pickModels, diversify, compilePrefer, scoreModel } from "./combos.js";
import { loadCatalog } from "./catalog.js";
import { getOverrides, resolvePins } from "./overrides.js";
import { getUnhealthyProviders, isModelHealthy, markFailure } from "./health.js";

const DEADLINE_MS = 25000;
const PER_TARGET_TIMEOUT_MS = 20000;
const MAX_HEALTH_CHECKS = 20;

function truncate(text) {
  const s = String(text ?? "");
  return s.length > 200 ? s.slice(0, 200) : s;
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

export async function getComboTargets(env, name) {
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
    })),
  };
}

function resolveDirect(nameOrProviderModel) {
  const s = String(nameOrProviderModel);
  const slash = s.indexOf("/");
  if (slash <= 0) return null;
  const provider = s.slice(0, slash);
  const model = s.slice(slash + 1);
  if (!PROVIDERS[provider] || !model) return null;
  return { provider, model };
}

async function tryTarget(env, providerName, model, body, timeoutMs) {
  const provider = PROVIDERS[providerName];
  if (!provider) return { skipReason: `unknown provider: ${providerName}` };
  const key = env[provider.keyEnv];
  if (!key) return { skipReason: `missing ${provider.keyEnv}` };

  const used = `${providerName}/${model}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  let res;
  try {
    res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        ...(provider.extraHeaders ?? {}),
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
      error: errorFor(used, res.status),
      cause: res.status,
      status: res.status,
      raw: redact(raw, [key], 200),
    };
  }
  return { res };
}

export async function runCombo(
  env,
  comboNameOrProviderModel,
  body,
  { deadlineMs = DEADLINE_MS, perTargetTimeoutMs = PER_TARGET_TIMEOUT_MS, stream = false } = {},
) {
  const wanted = String(comboNameOrProviderModel);
  let targets;
  if (RULES[wanted]) {
    const sel = await getComboTargets(env, wanted);
    if (sel.error) {
      return { ok: false, errors: [{ target: wanted, reason: truncate(sel.error) }] };
    }
    targets = sel.targets;
  } else {
    const direct = resolveDirect(wanted);
    if (!direct) {
      return {
        ok: false,
        errors: [{ target: truncate(wanted), reason: `unknown combo or provider/model: ${truncate(wanted)}` }],
      };
    }
    targets = [{ ...direct, score: 0, pinned: false }];
  }

  const started = Date.now();
  const errors = [];
  // اگر کلید یک provider رد شد (401/403)، بقیه‌ی هدف‌های همان provider در این
  // فراخوانی بی‌خیال می‌شوند — فقط یک پیام «key rejected» برمی‌گردد و provider
  // یک ساعت در health منع می‌شود (markFailure خودش این را ثبت می‌کند).
  const rejectedProviders = new Set();

  for (const t of targets) {
    if (rejectedProviders.has(t.provider)) continue;
    const usedModel = `${t.provider}/${t.model}`;
    const remaining = deadlineMs - (Date.now() - started);
    if (remaining <= 0) {
      errors.push({ target: usedModel, reason: "deadline exceeded" });
      break;
    }

    if (t.model.startsWith("PLACEHOLDER")) {
      errors.push({ target: usedModel, reason: "placeholder model id" });
      continue;
    }

    const attempt = await tryTarget(env, t.provider, t.model, body, Math.min(perTargetTimeoutMs, remaining));
    if (attempt.skipReason) {
      errors.push({ target: usedModel, reason: attempt.skipReason });
    } else if (attempt.error) {
      const isTimeout = attempt.cause === "timeout";
      const cls = classifyFailure(
        typeof attempt.cause === "number" ? attempt.cause : null,
        attempt.raw,
        isTimeout,
      );
      if (cls.scope === "provider") {
        rejectedProviders.add(t.provider);
        errors.push({
          target: usedModel,
          reason: `provider ${t.provider}: key rejected (${attempt.cause})`,
        });
      } else {
        const entry = { target: usedModel };
        if (typeof attempt.cause === "number") {
          entry.reason = cls.label;
          entry.status = attempt.cause;
        } else if (isTimeout) {
          entry.reason = cls.label;
        } else {
          entry.reason = truncate(attempt.cause);
        }
        errors.push(entry);
      }
      if (env.STATE) {
        try {
          await markFailure(env, usedModel, cls, isTimeout ? "timeout" : truncate(attempt.cause));
        } catch (err) {
          console.error("markFailure failed:", err && err.message);
        }
      }
    } else if (stream) {
      const res = attempt.res;
      if (res.body) {
        return {
          ok: true,
          stream: res.body,
          contentType: res.headers.get("content-type"),
          used: usedModel,
        };
      }
      errors.push({ target: usedModel, reason: "no stream body" });
      await markFailure(env, usedModel, "no stream body");
    } else {
      const res = attempt.res;
      let data;
      try {
        data = await res.json();
      } catch (err) {
        errors.push({ target: usedModel, reason: truncate(`bad json: ${err && err.message}`) });
        await markFailure(env, usedModel, "bad json response");
        continue;
      }

      const message = data?.choices?.[0]?.message?.content;
      const empty =
        !message ||
        (typeof message === "string" && !message.trim()) ||
        (Array.isArray(message) && message.length === 0);
      if (empty) {
        errors.push({ target: usedModel, reason: "empty assistant message" });
        await markFailure(env, usedModel, "empty assistant message");
        continue;
      }

      return { ok: true, data, used: usedModel };
    }
  }

  return { ok: false, errors };
}

// فراخوانی مستقیم یک هدف (همان کد مسیر روتتر؛ بدون فیلتر سلامت) برای /test.
// خروجی امن است: فقط status، تأخیر و اسنیپت رازپاک‌شده.
export async function directCall(env, providerName, model, body, { timeoutMs = 20000 } = {}) {
  const provider = PROVIDERS[providerName];
  if (!provider) {
    return { ok: false, status: null, latencyMs: 0, snippet: `unknown provider: ${providerName}` };
  }
  const key = env[provider.keyEnv];
  if (!key) {
    return { ok: false, status: null, latencyMs: 0, snippet: `missing ${provider.keyEnv}` };
  }
  const started = Date.now();
  const attempt = await tryTarget(env, providerName, model, body, timeoutMs);
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
