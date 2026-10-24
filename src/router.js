import { PROVIDERS } from "./providers.js";
import { RULES, pickModels, interleaveByProvider, compilePrefer, scoreModel } from "./combos.js";
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

function errorFor(target, cause) {
  const entry =
    typeof cause === "number"
      ? { target, status: cause }
      : { target, reason: truncate(cause) };
  return entry;
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
    .map((m) => ({ ...m, score: scoreModel(m, compiled) }))
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

  const ordered = interleaveByProvider(
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
    return {
      error: errorFor(used, err?.reason === "timeout" ? "timeout" : `network: ${err && err.message}`),
      cause: err?.reason === "timeout" ? "timeout" : "network error",
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    return { error: errorFor(used, res.status), cause: res.status };
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

  for (const t of targets) {
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
      errors.push(attempt.error);
      if (env.STATE) {
        try {
          await markFailure(env, usedModel, attempt.cause);
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
