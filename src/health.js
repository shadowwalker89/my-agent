// سلامت هر هدف در KV: کلید "health:<provider>/<model>" با expirationTtl.
// اگر کلید موجود باشد یعنی هدف ناسالم است؛ با پایان TTL خوانده نمی‌شود و سالم حساب می‌شود.
// خطای احراز هویت (401/403) کل provider را در "health:provider:<name>" می‌بندد (۱ ساعت).

const GONE_TTL = 86400; // 24h — مدل دیگر وجود ندارد / پشتیبانی نمی‌شود
const TRANSIENT_TTL = 600; // 10 min — 429، 5xx، timeout، empty
const AUTH_TTL = 3600; // 1h — 401/403 در سطح provider

export function classifyFailure(cause) {
  if (typeof cause === "number") {
    if (cause === 401 || cause === 403) return "auth";
    if (cause === 404 || cause === 410 || cause === 400) return "gone";
    return "transient";
  }
  return "transient";
}

function reasonOf(cause) {
  return (typeof cause === "number" ? `http ${cause}` : String(cause ?? "unknown")).slice(0, 200);
}

export async function markFailure(env, target, cause) {
  if (!env.STATE) return;
  const cls = classifyFailure(cause);
  const value = JSON.stringify({ cls, reason: reasonOf(cause) });
  if (cls === "auth") {
    const provider = String(target).split("/")[0];
    const key = `health:provider:${provider}`;
    const old = await env.STATE.get(key, "json");
    if (old?.cls !== cls) {
      await env.STATE.put(key, value, { expirationTtl: AUTH_TTL });
    }
    return;
  }
  const key = `health:${target}`;
  const old = await env.STATE.get(key, "json");
  if (old?.cls !== cls) {
    await env.STATE.put(key, value, {
      expirationTtl: cls === "gone" ? GONE_TTL : TRANSIENT_TTL,
    });
  }
}

const PROVIDERS = ["nvidia", "openrouter", "xkiro"];

export async function getUnhealthyProviders(env) {
  const state = {};
  if (!env.STATE) return state;
  await Promise.all(
    PROVIDERS.map(async (name) => {
      state[name] = Boolean(await env.STATE.get(`health:provider:${name}`));
    }),
  );
  return state;
}

export async function isModelHealthy(env, target) {
  if (!env.STATE) return true;
  return !(await env.STATE.get(`health:${target}`));
}
