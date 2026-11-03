import { getConfig } from "./config.js";

// سلامت هر هدف در KV: کلید "health:<provider>/<model>" با expirationTtl.
// اگر کلید موجود باشد یعنی هدف ناسالم است؛ با پایان TTL خوانده نمی‌شود و سالم حساب می‌شود.
// خطای احراز هویت (401/403) کل provider را در "health:provider:<name>" می‌بندد (۱ ساعت).
// طبقه‌بندی شکست در classifyFailure داخل src/router.js تمرکز دارد — اینجا فقط نمایش.

// ثبت شکست بر پایه‌ی همان طبقه‌بندی classifyFailure؛ put هر بار TTL را تازه می‌کند
// تا شکست‌های تکراری هم سردی را تمدید کنند. Phase 2-c: the old
// `old !== value` guard skipped the put on identical repeat failures,
// so a repeatedly failing target never refreshed its KV expirationTtl
// (the audit's glm-5.3-repeat hypothesis) — always put now. No unit
// test pins skipping duplicate puts, so no test contract is broken.
// Phase 2-d: the stored value also carries failedAt + ttlSec so the
// admin models table can show the cooldown reason and the remaining
// TTL estimate (expiry = failedAt + ttlSec). Old readers only check
// key existence (isModelHealthy) or parse label/reason, so the extra
// fields are backward-compatible.
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
    failedAt: Date.now(),
    ttlSec: Math.max(60, classification.cooldownSec),
  });
  await env.STATE.put(key, value, { expirationTtl: Math.max(60, classification.cooldownSec) });
}

// Phase 2-d: parsed cooldown entry for one model, or null when healthy
// or unparseable. Remaining seconds are estimated from the stored put
// time + TTL (KV itself exposes no TTL introspection).
export async function getHealthEntry(env, target) {
  if (!env.STATE) return null;
  let raw;
  try {
    raw = await env.STATE.get(`health:${target}`);
  } catch {
    return null;
  }
  if (!raw) return null;
  let v = null;
  try {
    v = JSON.parse(raw);
  } catch {
    v = null;
  }
  if (!v || typeof v !== "object") return { label: null, reason: String(raw).slice(0, 200), failedAt: null, ttlSec: null, remainingSec: null };
  const failedAt = Number.isFinite(Number(v.failedAt)) ? Number(v.failedAt) : null;
  const ttlSec = Number.isFinite(Number(v.ttlSec)) ? Number(v.ttlSec) : null;
  const remainingSec =
    failedAt !== null && ttlSec !== null ? Math.max(0, Math.round((failedAt + ttlSec * 1000 - Date.now()) / 1000)) : null;
  return {
    label: v.label ?? null,
    reason: v.reason ?? null,
    failedAt,
    ttlSec,
    remainingSec,
  };
}

// منع‌های سطح provider — لیست providerها از config می‌آید (داخلی + دستی)
export async function getUnhealthyProviders(env) {
  const state = {};
  if (!env.STATE) return state;
  const cfg = await getConfig(env);
  await Promise.all(
    cfg.providers.map(async (p) => {
      state[p.id] = Boolean(await env.STATE.get(`health:provider:${p.id}`));
    }),
  );
  return state;
}

export async function isModelHealthy(env, target) {
  if (!env.STATE) return true;
  return !(await env.STATE.get(`health:${target}`));
}

// ── تأخیر per-target برای استراتژی «fastest» ───────────────────────────────
// آخرین ۵ نمونه در "lat:<provider>/<model>" نگه داشته می‌شود؛ میانه می‌گیریم.

export async function recordLatency(env, target, ms) {
  if (!env.STATE) return;
  const key = `lat:${target}`;
  const old = await env.STATE.get(key, "json");
  const arr = Array.isArray(old) ? old : [];
  arr.push(Math.round(ms));
  while (arr.length > 5) arr.shift();
  await env.STATE.put(key, JSON.stringify(arr));
}

export function medianOf(samples) {
  if (!Array.isArray(samples) || !samples.length) return null;
  const s = [...samples].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export async function getMedianLatency(env, target) {
  if (!env.STATE) return null;
  const arr = await env.STATE.get(`lat:${target}`, "json");
  return medianOf(arr);
}

// تعداد هدف‌های سردِ فعلی به تفکیک provider — از کلیدهای موجود health:*
// (کلیدهای "health:provider:*" جدا شمرده می‌شوند: منع کل provider).
export async function healthCounts(env) {
  const counts = {};
  const providerBlocked = [];
  if (!env.STATE) return { counts, providerBlocked };
  const cfg = await getConfig(env);
  for (const p of cfg.providers) counts[p.id] = 0;
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
