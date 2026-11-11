import { getSetting, setSetting } from "./memory.js";
import { getConfig } from "./config.js";

export const CONNECTORS = [
  { id: "gemini", label: "Google Gemini (Vision / Image Edit / PDF)", keyName: "GEMINI_API_KEY" },
  { id: "nvidia", label: "NVIDIA NIM (Flux Image / Vision / Chat)", keyName: "NVIDIA_API_KEY" },
  { id: "together", label: "Together AI (FLUX.1-schnell-Free)", keyName: "TOGETHER_API_KEY" },
  { id: "puter", label: "Puter AI (Flux-2-Pro / Gemini-3-Image / GPT-Image)", keyName: "PUTER_API_TOKEN" },
  { id: "huggingface", label: "HuggingFace (Flux / Image Edit)", keyName: "HF_TOKEN" },
  { id: "upload_am", label: "Upload.am (اشتراک فایل غیرحساس)", keyName: "UPLOAD_AM_API_KEY", optionalKey: true },
  { id: "google_drive", label: "Google Drive (آرشیو اختیاری کاربر)", keyName: "GOOGLE_REFRESH_TOKEN" },
  { id: "weather_maps", label: "هواشناسی و نقشه (Open-Meteo / Neshan)", keyName: "NESHAN_API_KEY", optionalKey: true },
  { id: "gmail", label: "اتصال جیمیل (Gmail)", keyName: "GMAIL_ENABLED" },
];
export const CONNECTOR_MAP = Object.fromEntries(CONNECTORS.map((c) => [c.id, c]));

function maskKey(v) {
  const s = String(v ?? "");
  if (!s) return null;
  if (s.length <= 6) return `${s.slice(0, 2)}...`;
  return `${s.slice(0, 4)}...${s.slice(-2)}`;
}

// Production deployments use different names for the same Google key
// (voice.js reads GEMINI_API_KEY). Check every known alias so vision/PDF/
// image connectors reuse the key that already works elsewhere.
const ENV_KEY_ALIASES = {
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_AI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  nvidia: ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"],
  puter: ["PUTER_API_TOKEN", "PUTER_AUTH_TOKEN"],
};
const CONFIG_KEY_HINT = {
  gemini: /gemini|google/i,
  nvidia: /nvidia/i,
  puter: /puter/i,
};

function readEnvKey(env, names) {
  for (const name of names) {
    const v = env?.[name];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

async function readConfigKey(env, id, def) {
  try {
    const cfg = await getConfig(env);
    const hint = CONFIG_KEY_HINT[id] ?? null;
    for (const p of cfg?.providers ?? []) {
      if (!p || typeof p !== "object") continue;
      const matches = p.id === id || (hint && hint.test(String(p.secretName ?? "")));
      if (!matches) continue;
      const inline = p.apiKey ?? p.key ?? p.secret;
      if (typeof inline === "string" && inline) return inline;
      const names = [...(ENV_KEY_ALIASES[id] ?? [def.keyName]), p.secretName]
        .filter((n) => typeof n === "string" && n);
      const v = readEnvKey(env, names);
      if (v) return v;
    }
    const alias = cfg?.[`${id}ApiKey`] ?? cfg?.[`${id}_api_key`] ?? cfg?.[id]?.apiKey;
    if (typeof alias === "string" && alias) return alias;
  } catch {}
  return null;
}

export async function getConnectorSecret(env, userId, connectorId) {
  const def = CONNECTOR_MAP[String(connectorId ?? "").trim().toLowerCase()];
  if (!def) return null;
  if (userId != null) {
    try {
      const v = await getSetting(env, userId, `conn_${def.id}`);
      if (typeof v === "string" && v) return v;
    } catch {}
  }
  const fromEnv = readEnvKey(env, ENV_KEY_ALIASES[def.id] ?? [def.keyName]);
  if (fromEnv) return fromEnv;
  return readConfigKey(env, def.id, def);
}

export async function setConnectorSecret(env, userId, connectorId, value) {
  const def = CONNECTOR_MAP[String(connectorId ?? "").trim().toLowerCase()];
  const v = typeof value === "string" ? value.trim() : "";
  if (!def || !v) return { ok: false, error: !def ? "unknown connector" : "empty value" };
  try {
    return await setSetting(env, userId, `conn_${def.id}`, v);
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function getConnectorStatuses(env, userSettings = {}, userId = null) {
  const settings = userSettings && typeof userSettings === "object" ? userSettings : {};
  const out = [];
  for (const def of CONNECTORS) {
    let secret = settings[`conn_${def.id}`] ?? settings[def.keyName] ?? null;
    let source = secret ? "user" : null;
    if (!secret && userId != null) {
      try {
        const v = await getSetting(env, userId, `conn_${def.id}`);
        if (v) { secret = v; source = "user"; }
      } catch {}
    }
    if (!secret) {
      const fromEnv = readEnvKey(env, ENV_KEY_ALIASES[def.id] ?? [def.keyName]);
      if (fromEnv) { secret = fromEnv; source = "env"; }
    }
    out.push({
      id: def.id,
      label: def.label,
      keyName: def.keyName,
      optionalKey: Boolean(def.optionalKey),
      configured: Boolean(secret),
      masked: maskKey(secret),
      source,
      hint: `/setup ${def.id} <key>`,
      setupCommand: `/setup ${def.id} <key>`,
    });
  }
  return out;
}

export function renderSetupStatusText(statuses) {
  const list = Array.isArray(statuses) ? statuses : Object.values(statuses ?? {});
  const lines = ["⚙️ **وضعیت کانکتورها**\n"];
  for (const s of list) {
    const icon = s.configured ? "✅ متصل" : "⚙️ تنظیم‌نشده";
    const masked = s.masked ? ` (${s.masked})` : "";
    lines.push(`${icon} **${s.id}**: ${s.label}${masked}\n  تنظیم: \`/setup ${s.id} <key>\` یا \`تنظیم کانکتور ${s.id} <key>\``);
  }
  lines.push("\nبرای تنظیم/به‌روزرسانی هر کلید: `تنظیم کانکتور <id> <key>` یا `/setup <id> <key>` (مثلاً `/setup gemini AIzaSy...` یا `/setup together ...`)");
  return lines.join("\n");
}

export async function uploadToUploadAm(bytes, filename, { apiKey, fetchFn } = {}) {
  const f = fetchFn ?? globalThis.fetch;
  if (typeof f !== "function") return { ok: false, error: "fetch unavailable" };
  try {
    const form = new FormData();
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes ?? ""], { type: "application/octet-stream" });
    form.append("file", blob, filename || "file.bin");
    if (apiKey) { form.append("api_key", String(apiKey)); form.append("key", String(apiKey)); }
    const res = await f("https://upload.am/api/upload", {
      method: "POST",
      body: form,
      ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    });
    let data = null;
    try { data = typeof res?.json === "function" ? await res.json() : res; } catch {}
    const url = data?.url ?? data?.link ?? data?.file_url ?? data?.download_url ?? data?.data?.url ?? null;
    if (url) return { ok: true, url };
    if (res?.ok && data && typeof data === "object") return { ok: true, url: null, data };
    return { ok: false, error: data?.error ?? data?.message ?? `upload failed${res?.status ? ` ${res.status}` : ""}` };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
