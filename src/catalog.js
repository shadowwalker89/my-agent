import { listFreeModels } from "./providers.js";
import { tgBroadcast } from "./telegram.js";

const NOTIFY_LIMIT = 15;

export async function syncProvider(env, provider, { notify = true } = {}) {
  const models = await listFreeModels(env, provider);
  const key = `catalog:${provider}`;
  const prev = await env.STATE.get(key, "json");
  await env.STATE.put(key, JSON.stringify({ updatedAt: new Date().toISOString(), models }));

  const prevIds = new Set(prev?.models?.map((m) => m.id) ?? []);
  const nextIds = new Set(models.map((m) => m.id));
  const added = models.map((m) => m.id).filter((id) => !prevIds.has(id));
  const removed = (prev?.models?.map((m) => m.id) ?? []).filter((id) => !nextIds.has(id));

  if (notify && prev && added.length) {
    await tgBroadcast(env, notifyText(provider, added));
  }
  return { added, removed };
}

function notifyText(provider, added) {
  const shown = added.slice(0, NOTIFY_LIMIT).map((id) => `- ${provider}/${id}`);
  const more = added.length > NOTIFY_LIMIT ? `\n(+${added.length - NOTIFY_LIMIT} مورد دیگر)` : "";
  return `🔔 مدل‌های رایگان جدید (${provider}):\n${shown.join("\n")}${more}\nبرای مرور بفرست: /models`;
}

const PROVIDER_KEYS = { nvidia: 1, openrouter: 1, xkiro: 1 };

export async function loadCatalog(env) {
  if (!env.STATE) return [];
  const parts = await Promise.all(
    Object.keys(PROVIDER_KEYS).map((p) => env.STATE.get(`catalog:${p}`, "json")),
  );
  return parts.flatMap((r) => (r?.models ?? []).filter((m) => m && typeof m.id === "string"));
}
