// سلامت هر هدف در KV: کلید "health:<provider>/<model>" با expirationTtl.
// اگر کلید موجود باشد یعنی هدف ناسالم است؛ با پایان TTL خوانده نمی‌شود و سالم حساب می‌شود.
// خطای احراز هویت (401/403) کل provider را در "health:provider:<name>" می‌بندد (۱ ساعت).
// طبقه‌بندی شکست در classifyFailure داخل src/router.js تمرکز دارد — اینجا فقط نمایش.

// ثبت شکست بر پایه‌ی همان طبقه‌بندی classifyFailure؛ put هر بار TTL را تازه می‌کند
// تا شکست‌های تکراری، سردی را طولانی نکنند و همیشه old را هم بخوانیم (صرفه‌جویی نوشتن).
export async function markFailure(env, target, classification, reasonText) {
  if (!env.STATE || !classification) return;
  const key =
    classification.scope === "provider"
      ? `health:provider:${String(target).split("/")[0]}`
      : `health:${target}`;
  const value = JSON.stringify({
    cls: classification.scope,
    label: classification.label ?? null,
    reason: String(reasonText ?? "").slice(0, 200),
  });
  const old = await env.STATE.get(key);
  if (old !== value) {
    await env.STATE.put(key, value, { expirationTtl: Math.max(60, classification.cooldownSec) });
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

// تعداد هدف‌های سردِ فعلی به تفکیک provider — از کلیدهای موجود health:*
// (کلیدهای "health:provider:*" جدا شمرده می‌شوند: منع کل provider).
export async function healthCounts(env) {
  const counts = { nvidia: 0, openrouter: 0, xkiro: 0 };
  const providerBlocked = [];
  if (!env.STATE) return { counts, providerBlocked };
  let cursor;
  do {
    const page = await env.STATE.list({ prefix: "health:", cursor });
    for (const k of page.keys) {
      if (k.name.startsWith("health:provider:")) {
        providerBlocked.push(k.name.slice("health:provider:".length));
        continue;
      }
      const p = k.name.slice("health:".length).split("/")[0];
      counts[p] = (counts[p] ?? 0) + 1;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return { counts, providerBlocked };
}
