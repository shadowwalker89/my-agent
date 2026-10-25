import { BUILTIN_PROVIDERS } from "./providers.js";

// config:v1 — پیکربندی دستی providerها (فقط سازگار با OpenAI) و comboها.
// { providers: [{id,name,baseUrl,secretName,enabled,builtin?,extraHeaders?}],
//   combos: [{name,strategy,timeoutMs,retries,targets:[{provider,model,enabled}]}] }
// مقدارِ کلید هرگز در KV ذخیره نمی‌شود و از هیچ API برگردانده نمی‌شود؛
// فقط نام راز (secretName) که Worker از env می‌خواند.

const KEY = "config:v1";

export const NAME_RE = /^[a-z0-9._-]{1,40}$/;
const SECRET_RE = /^[A-Za-z0-9_]{1,60}$/;
const PROVIDER_LIMIT = 20;
const COMBO_LIMIT = 20;
export const TARGET_LIMIT = 30;
export const STRATEGIES = ["priority", "round-robin", "fastest"];

function apiError(msg) {
  const err = new Error(msg);
  err.apiError = true;
  return err;
}

export async function getConfig(env) {
  let cfg = { providers: [], combos: [] };
  if (env.STATE) {
    const raw = await env.STATE.get(KEY, "json");
    if (raw && typeof raw === "object") cfg = raw;
  }
  cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
  cfg.combos = Array.isArray(cfg.combos) ? cfg.combos : [];

  // seed داخلی‌ها در اولین خواندن اگر جاافتاده باشند
  let changed = false;
  for (const builtin of BUILTIN_PROVIDERS) {
    if (!cfg.providers.some((p) => p.id === builtin.id)) {
      cfg.providers.push({ ...builtin });
      changed = true;
    }
  }
  if (changed && env.STATE) return setConfig(env, cfg);
  return cfg;
}

export async function setConfig(env, cfg) {
  if (!env.STATE) throw apiError("KV (STATE) not available");
  await env.STATE.put(KEY, JSON.stringify(cfg));
  return cfg;
}

export async function getProviderCtx(env, id) {
  const cfg = await getConfig(env);
  const p = cfg.providers.find((x) => x.id === id);
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    secretName: p.secretName,
    enabled: p.enabled !== false,
    builtin: Boolean(p.builtin),
    extraHeaders: p.extraHeaders ?? undefined,
  };
}

// ── اعتبارسنجی (pure؛ env فقط برای «وجود» secretName — مقدار هرگز خوانده نمی‌شود)

export function validateProvider(env, input) {
  if (!input || typeof input !== "object") throw apiError("body required");
  const id = String(input.id ?? "");
  if (!NAME_RE.test(id)) throw apiError("invalid provider id (a-z0-9._-, max 40)");
  if (!SECRET_RE.test(String(input.secretName ?? ""))) {
    throw apiError("invalid secretName (A-Za-z0-9_, max 60)");
  }
  if (!(input.secretName in env)) {
    throw apiError("unknown secretName (no such secret in env)");
  }
  const rawUrl = String(input.baseUrl ?? "");
  if (!/^https:\/\//i.test(rawUrl)) throw apiError("baseUrl must be https");
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw apiError("baseUrl invalid");
  }
  if (!u.hostname) throw apiError("baseUrl invalid");
  const name = String(input.name ?? id);
  if (!name || name.length > 80) throw apiError("name too long (max 80)");
  return {
    id,
    name,
    baseUrl: rawUrl.replace(/\/+$/, ""),
    secretName: String(input.secretName),
    enabled: input.enabled !== false,
    builtin: Boolean(input.builtin),
  };
}

export function validateCombo(env, input, cfg) {
  if (!input || typeof input !== "object") throw apiError("body required");
  const name = String(input.name ?? "");
  if (!NAME_RE.test(name)) throw apiError("invalid combo name (a-z0-9._-, max 40)");
  const strategy = input.strategy ?? "priority";
  if (!STRATEGIES.includes(strategy)) {
    throw apiError(`strategy must be one of: ${STRATEGIES.join(", ")}`);
  }
  const timeoutMs = Math.round(Number(input.timeoutMs ?? 20000));
  if (!(timeoutMs >= 1000 && timeoutMs <= 60000)) throw apiError("timeoutMs must be 1000..60000");
  const retries = Math.round(Number(input.retries ?? 0));
  if (!(retries >= 0 && retries <= 3)) throw apiError("retries must be 0..3");
  const targets = Array.isArray(input.targets) ? input.targets : [];
  if (targets.length > TARGET_LIMIT) throw apiError(`max ${TARGET_LIMIT} targets per combo`);
  const providers = new Map(cfg.providers.map((p) => [p.id, p]));
  const clean = targets.map((t) => {
    if (!t || typeof t !== "object") throw apiError("invalid target");
    if (!providers.has(String(t.provider))) throw apiError(`unknown provider: ${t.provider}`);
    const model = String(t.model ?? "");
    if (!/^[A-Za-z0-9._/:-]{1,200}$/.test(model)) {
      throw apiError(`invalid model id: ${model.slice(0, 60)}`);
    }
    return { provider: String(t.provider), model, enabled: t.enabled !== false };
  });
  return { name, strategy, timeoutMs, retries, targets: clean };
}

// ── عملیات تغییر (برای admin API و تست آفلاین) ─────────────────────────────

export async function upsertProvider(env, input) {
  const cfg = await getConfig(env);
  const p = validateProvider(env, input);
  const existing = cfg.providers.find((x) => x.id === p.id);
  if (!existing) {
    if (cfg.providers.length >= PROVIDER_LIMIT) throw apiError(`max ${PROVIDER_LIMIT} providers`);
    cfg.providers.push(p);
  } else {
    // builtin بودن حفظ می‌شود؛ extraHeaders داخلی‌ها (مثل X-Title) دست‌نخورده می‌ماند
    existing.name = p.name;
    existing.baseUrl = p.baseUrl;
    existing.secretName = p.secretName;
    existing.enabled = p.enabled;
  }
  await setConfig(env, cfg);
  return existing ?? p;
}

export async function removeProvider(env, id) {
  const cfg = await getConfig(env);
  const idx = cfg.providers.findIndex((x) => x.id === id);
  if (idx === -1) throw apiError(`no such provider: ${id}`);
  if (cfg.providers[idx].builtin) throw apiError("cannot delete builtin provider (disable it)");
  cfg.providers.splice(idx, 1);
  return setConfig(env, cfg);
}

export async function upsertCombo(env, input) {
  const cfg = await getConfig(env);
  const c = validateCombo(env, input, cfg);
  const existing = cfg.combos.find((x) => x.name === c.name);
  if (!existing) {
    if (cfg.combos.length >= COMBO_LIMIT) throw apiError(`max ${COMBO_LIMIT} combos`);
    cfg.combos.push(c);
  } else {
    Object.assign(existing, c);
  }
  await setConfig(env, cfg);
  return c;
}

export async function removeCombo(env, name) {
  const cfg = await getConfig(env);
  const idx = cfg.combos.findIndex((x) => x.name === name);
  if (idx === -1) throw apiError(`no such combo: ${name}`);
  cfg.combos.splice(idx, 1);
  return setConfig(env, cfg);
}
