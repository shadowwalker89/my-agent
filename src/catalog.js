import { listProviderModelsDetailed } from "./providers.js";
import { getProviderCtx, getConfig } from "./config.js";
import { tgBroadcast } from "./telegram.js";

const NOTIFY_LIMIT = 15;

// catalog:<providerId> برای همه‌ی providerهای پیکربندی‌شده (داخلی + دستی)
export async function syncProvider(env, providerId, { notify = true } = {}) {
  const ctx = await getProviderCtx(env, providerId);
  if (!ctx) throw new Error(`unknown provider: ${providerId}`);
  const { models, sync } = await listProviderModelsDetailed(env, ctx);
  const key = `catalog:${providerId}`;
  const prev = await env.STATE.get(key, "json");
  const updatedAt = new Date().toISOString();
  await env.STATE.put(key, JSON.stringify({ updatedAt, models, sync: { ...sync, at: updatedAt } }));

  const prevIds = new Set(prev?.models?.map((m) => m.id) ?? []);
  const nextIds = new Set(models.map((m) => m.id));
  const added = models.map((m) => m.id).filter((id) => !prevIds.has(id));
  const removed = (prev?.models?.map((m) => m.id) ?? []).filter((id) => !nextIds.has(id));

  if (notify && prev && added.length) {
    await tgBroadcast(env, notifyText(providerId, added));
  }
  return { added, removed, sync: { ...sync, at: updatedAt } };
}

// گزارش آخرین sync هر provider — بدون کلید/هدر/بدنه‌ی خام upstream.
export async function getSyncReport(env, providerId) {
  const r = await env.STATE.get(`catalog:${providerId}`, "json");
  if (!r) return null;
  const sync = r.sync && typeof r.sync === "object" ? r.sync : {};
  return {
    fetched: typeof sync.fetched === "number" ? sync.fetched : null,
    kept: typeof sync.kept === "number" ? sync.kept : (r.models?.length ?? 0),
    droppedCount:
      typeof sync.droppedCount === "number" ? sync.droppedCount : (Array.isArray(sync.dropped) ? sync.dropped.length : 0),
    dropped: Array.isArray(sync.dropped) ? sync.dropped.slice(0, 100) : [],
    sampleRawKeys: Array.isArray(sync.sampleRawKeys) ? sync.sampleRawKeys.slice(0, 40) : [],
    at: sync.at ?? r.updatedAt ?? null,
  };
}

function notifyText(provider, added) {
  const shown = added.slice(0, NOTIFY_LIMIT).map((id) => `- ${provider}/${id}`);
  const more = added.length > NOTIFY_LIMIT ? `\n(+${added.length - NOTIFY_LIMIT} مورد دیگر)` : "";
  return `🔔 مدل‌های رایگان جدید (${provider}):\n${shown.join("\n")}${more}\nبرای مرور بفرست: /models`;
}

export async function loadCatalog(env) {
  if (!env.STATE) return [];
  const cfg = await getConfig(env);
  const parts = await Promise.all(
    cfg.providers.map(async (p) => {
      const r = await env.STATE.get(`catalog:${p.id}`, "json");
      return r?.models ?? [];
    }),
  );
  return parts
    .flat()
    .filter((m) => m && typeof m.id === "string");
}
