import { PROVIDERS } from "./providers.js";
import { COMBOS } from "./combos.js";

const DEADLINE_MS = 25000;
const PER_TARGET_TIMEOUT_MS = 20000;

function truncate(text) {
  const s = String(text ?? "");
  return s.length > 200 ? s.slice(0, 200) : s;
}

function resolveTargets(nameOrProviderModel) {
  const targets = COMBOS[nameOrProviderModel];
  if (targets) return { name: nameOrProviderModel, targets };

  const slash = String(nameOrProviderModel).indexOf("/");
  if (slash > 0) {
    const provider = String(nameOrProviderModel).slice(0, slash);
    const model = String(nameOrProviderModel).slice(slash + 1);
    if (PROVIDERS[provider] && model) {
      return { name: nameOrProviderModel, targets: [{ provider, model }] };
    }
  }
  return null;
}

async function tryTarget(env, target, body, usedModel, perTargetTimeoutMs) {
  const provider = PROVIDERS[target.provider];
  const key = env[provider.keyEnv];
  if (!key) return { skipReason: `missing ${provider.keyEnv}` };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort("timeout"),
    perTargetTimeoutMs,
  );
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
      body: JSON.stringify({ ...body, model: usedModel }),
    });
  } catch (err) {
    return {
      error: { target: usedModel, reason: truncate(err?.reason === "timeout" ? "timeout" : `network: ${err && err.message}`) },
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    return {
      error: { target: usedModel, status: res.status },
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
  const resolved = resolveTargets(comboNameOrProviderModel);
  if (!resolved) {
    return {
      ok: false,
      errors: [
        { target: String(comboNameOrProviderModel), reason: truncate(`unknown combo or provider/model: ${comboNameOrProviderModel}`) },
      ],
    };
  }

  const started = Date.now();
  const errors = [];

  for (const target of resolved.targets) {
    const remaining = deadlineMs - (Date.now() - started);
    if (remaining <= 0) {
      errors.push({ target: usedName(target), reason: "deadline exceeded" });
      break;
    }
    const timeout = Math.min(perTargetTimeoutMs, remaining);
    const usedModel = `${target.provider}/${target.model}`;

    if (target.model.startsWith("PLACEHOLDER")) {
      errors.push({
        target: usedModel,
        reason: "placeholder model id — replace it in src/combos.js with a real id from /admin/models",
      });
      continue;
    }

    const attempt = await tryTarget(env, target, body, usedModel, timeout);
    if (attempt.skipReason) {
      errors.push({ target: usedModel, reason: attempt.skipReason });
      continue;
    }
    if (attempt.error) {
      errors.push(attempt.error);
      continue;
    }

    const { res } = attempt;

    if (stream) {
      if (res.body) {
        return { ok: true, stream: res.body, contentType: res.headers.get("content-type"), used: usedModel };
      }
      errors.push({ target: usedModel, reason: "no stream body" });
      continue;
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      errors.push({ target: usedModel, reason: truncate(`bad json: ${err && err.message}`) });
      continue;
    }

    const message = data?.choices?.[0]?.message?.content;
    const empty =
      !message ||
      (typeof message === "string" && !message.trim()) ||
      (Array.isArray(message) && message.length === 0);
    if (empty) {
      errors.push({ target: usedModel, reason: "empty assistant message" });
      continue;
    }

    return { ok: true, data, used: usedModel };
  }

  return { ok: false, errors };
}

function usedName(target) {
  return `${target.provider}/${target.model}`;
}
