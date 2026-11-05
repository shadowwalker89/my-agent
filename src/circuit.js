// Phase 2-j: durable provider circuit breaker + live-probe verification.
// D1 is optional: without a SQL-capable DB binding the module keeps working
// from per-isolate memory, so routing never fails because D1 is absent.
const FAILURE_WINDOW_MS = 120_000;
const COOLDOWN_MS = 180_000;
const CACHE_TTL_MS = 30_000;
const VERIFIED_FAST_MS = 10_000;
const OPEN_FAILURE_STATUSES = new Set([429, 500, 502, 503, 504, 401, 403]);

const providerFailures = new Map();
const memoryOpen = new Map();
const verifiedMemory = new Map();
let openCache = null;
let verifiedCache = null;
let readyDbs = new WeakSet();

function hasDb(env) {
  return Boolean(env && env.DB && typeof env.DB.prepare === "function");
}

async function ensureTables(env) {
  if (!hasDb(env)) return false;
  if (readyDbs.has(env.DB)) return true;
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS router_provider_cb (provider TEXT PRIMARY KEY, state TEXT, fail_count INTEGER, cooldown_until INTEGER, last_error TEXT, updated_at INTEGER)",
    ).bind().run();
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS router_model_verified (target TEXT PRIMARY KEY, provider TEXT, status TEXT, latency_ms INTEGER, last_checked INTEGER, last_error TEXT)",
    ).bind().run();
    readyDbs.add(env.DB);
    return true;
  } catch {
    return false;
  }
}

function keyOf(target) {
  return String(target ?? "").toLowerCase();
}

function isOpenableFailure(statusOrReason) {
  if (typeof statusOrReason === "number") return OPEN_FAILURE_STATUSES.has(statusOrReason);
  return statusOrReason === "timeout" || statusOrReason === "network: timeout";
}

async function persistCircuit(env, provider, state, failCount, cooldownUntil, lastError, now) {
  if (!(await ensureTables(env))) return;
  try {
    await env.DB.prepare(
      "INSERT INTO router_provider_cb (provider, state, fail_count, cooldown_until, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET state=excluded.state, fail_count=excluded.fail_count, cooldown_until=excluded.cooldown_until, last_error=excluded.last_error, updated_at=excluded.updated_at",
    )
      .bind(provider, state, failCount, cooldownUntil, String(lastError ?? "").slice(0, 200), now)
      .run();
  } catch {
    // D1 is an enhancement; memory still protects the current isolate.
  }
}

export async function recordProviderCircuitFailure(env, provider, statusOrReason) {
  const p = String(provider ?? "");
  if (!p || !isOpenableFailure(statusOrReason)) return;
  const now = Date.now();
  const prev = providerFailures.get(p);
  const inWindow = prev && now - prev.firstAt <= FAILURE_WINDOW_MS;
  const count = inWindow ? prev.count + 1 : 1;
  const firstAt = inWindow ? prev.firstAt : now;
  providerFailures.set(p, { count, firstAt });
  const reason = typeof statusOrReason === "number" ? `http ${statusOrReason}` : statusOrReason;
  if (count >= 2) {
    const until = now + COOLDOWN_MS;
    memoryOpen.set(p, until);
    openCache = null;
    await persistCircuit(env, p, "open", count, until, reason, now);
  } else {
    await persistCircuit(env, p, "closed", count, 0, reason, now);
  }
}

export async function recordProviderCircuitSuccess(env, provider, { force = false } = {}) {
  const p = String(provider ?? "");
  if (!p) return;
  const wasOpen = memoryOpen.has(p);
  providerFailures.delete(p);
  if (openCache?.providers) openCache.providers.delete(p);
  if (!wasOpen && !force) return;
  memoryOpen.delete(p);
  openCache = null;
  if (!(await ensureTables(env))) return;
  try {
    await env.DB.prepare("DELETE FROM router_provider_cb WHERE provider = ?").bind(p).run();
  } catch {
    // best effort
  }
}

export async function getOpenProviderCircuits(env) {
  const now = Date.now();
  const open = new Set();
  for (const [p, until] of memoryOpen) {
    if (until > now) open.add(p);
    else memoryOpen.delete(p);
  }
  const canQuery = await ensureTables(env);
  if (!canQuery) return open;
  if (openCache && openCache.db === env.DB && now - openCache.at < CACHE_TTL_MS) {
    for (const p of openCache.providers) open.add(p);
    return open;
  }
  let rows = [];
  try {
    rows = (await env.DB.prepare("SELECT provider FROM router_provider_cb WHERE cooldown_until > ?").bind(now).all())?.results ?? [];
  } catch {
    rows = [];
  }
  const providers = new Set(rows.map((r) => String(r.provider)));
  openCache = { db: env.DB, at: now, providers };
  for (const p of providers) open.add(p);
  return open;
}

export async function recordVerifiedModel(env, target, provider, latencyMs, error = null) {
  const key = keyOf(target);
  const now = Date.now();
  const ok = error == null && Number(latencyMs) > 0 && Number(latencyMs) < VERIFIED_FAST_MS;
  if (ok) verifiedMemory.set(key, { latencyMs: Number(latencyMs), at: now });
  else verifiedMemory.delete(key);
  verifiedCache = null;
  if (!(await ensureTables(env))) return;
  try {
    await env.DB.prepare(
      "INSERT INTO router_model_verified (target, provider, status, latency_ms, last_checked, last_error) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(target) DO UPDATE SET provider=excluded.provider, status=excluded.status, latency_ms=excluded.latency_ms, last_checked=excluded.last_checked, last_error=excluded.last_error",
    )
      .bind(key, String(provider ?? ""), ok ? "ok" : "failed", Number(latencyMs) || 0, now, error == null ? "" : String(error).slice(0, 200))
      .run();
  } catch {
    // best effort
  }
}

export async function getVerifiedLatencies(env) {
  const now = Date.now();
  const out = new Map();
  for (const [target, v] of verifiedMemory) {
    if (v.latencyMs > 0 && v.latencyMs < VERIFIED_FAST_MS) out.set(target, v.latencyMs);
  }
  const canQuery = await ensureTables(env);
  if (!canQuery) return out;
  if (verifiedCache && verifiedCache.db === env.DB && now - verifiedCache.at < CACHE_TTL_MS) {
    for (const [target, ms] of verifiedCache.map) out.set(target, ms);
    return out;
  }
  let rows = [];
  try {
    rows = (await env.DB.prepare(
      `SELECT target, latency_ms FROM router_model_verified WHERE status = 'ok' AND latency_ms > 0 AND latency_ms < ${VERIFIED_FAST_MS}`,
    ).all())?.results ?? [];
  } catch {
    rows = [];
  }
  const map = new Map(rows.map((r) => [keyOf(r.target), Number(r.latency_ms)]));
  verifiedCache = { db: env.DB, at: now, map };
  for (const [target, ms] of map) out.set(target, ms);
  return out;
}

export function resetCircuitForTests() {
  providerFailures.clear();
  memoryOpen.clear();
  verifiedMemory.clear();
  openCache = null;
  verifiedCache = null;
  readyDbs = new WeakSet();
}
