import { getSetting, setSetting } from "./memory.js";

export const CONNECTORS = [
  { id: "gemini", label: "Google Gemini (Vision / Image Edit / PDF)", keyName: "GEMINI_API_KEY" },
  { id: "nvidia", label: "NVIDIA NIM (Flux Image / Vision / Chat)", keyName: "NVIDIA_API_KEY" },
  { id: "together", label: "Together AI (FLUX.1-schnell-Free)", keyName: "TOGETHER_API_KEY" },
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

export async function getConnectorSecret(env, userId, connectorId) {
  const def = CONNECTOR_MAP[String(connectorId ?? "").trim().toLowerCase()];
  if (!def) return null;
  if (userId != null) {
    try {
      const v = await getSetting(env, userId, `conn_${def.id}`);
      if (typeof v === "string" && v) return v;
    } catch {}
  }
  const fromEnv = env?.[def.keyName];
  return typeof fromEnv === "string" && fromEnv ? fromEnv : null;
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
    if (!secret && env?.[def.keyName]) { secret = env[def.keyName]; source = "env"; }
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
