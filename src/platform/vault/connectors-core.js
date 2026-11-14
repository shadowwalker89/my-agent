import { setSetting } from "../../memory.js";
import { getConfig } from "../../config.js";
import { encryptVaultValue, decryptVaultValue, isVaultSecretConfigured, isVaultMasterKeyConfigured, isBareLegacyVaultValue } from "./crypto.js";
import { redact } from "../../providers.js";

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

export function maskKey(v) {
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

export class ConnectorSecretError extends Error {
  constructor(connectorId, reason) {
    super(`connector secret unavailable: ${reason}`);
    this.name = "ConnectorSecretError"; this.code = "connector_secret_unavailable";
    this.connectorId = connectorId; this.reason = reason;
  }
}

export const isConnectorSecretError = (e) => Boolean(e) && (e instanceof ConnectorSecretError || e?.code === "connector_secret_unavailable");

const CONNECTOR_KEY_NAMES = CONNECTORS.map((c) => `conn_${c.id}`);
export const SWEEP_MASTER_KEY_ERROR = "vault master key is not configured";

// Format detection is intentionally case-insensitive so "V1:" / "ENC:V1:"
// cannot be mistaken for plaintext, but the ciphertext body is left untouched.
export function isConnectorCiphertext(value) {
  return typeof value === "string" && /^(?:enc:)?v1:/i.test(value);
}

export function normalizeConnectorCiphertext(value) {
  const m = /^(enc:)?v1:/i.exec(value);
  return m ? `${m[1] ? "enc:v1:" : "v1:"}${value.slice(m[0].length)}` : value;
}

export function connectorDb(envOrDb) {
  const db = envOrDb && typeof envOrDb.prepare === "function" ? envOrDb : envOrDb?.DB;
  return db && typeof db.prepare === "function" ? db : null;
}

export function connectorLog(connectorId, result) { try { console.log(JSON.stringify({ connector: connectorId ?? "unknown", result: redact(result, [], 64) })); } catch {} }

export async function readConnectorSetting(envOrDb, userId, key) {
  const db = connectorDb(envOrDb), id = Number(userId);
  if (!db || !Number.isFinite(id)) return { present: false, value: null, failed: false, noDb: !db };
  try {
    const row = await db.prepare("SELECT value FROM memories WHERE user_id = ? AND kind = 'setting' AND key = ? LIMIT 1").bind(id, key).first();
    return row && typeof row.value === "string" && row.value ? { present: true, value: row.value, failed: false } : { present: false, value: null, failed: false };
  } catch { return { present: true, value: null, failed: true, noDb: false }; }
}

// One classifier for reads and sweeps. A ciphertext prefix is never proof of
// decryptability: encrypted values must decrypt under the configured keyring.
// Bare `iv:cipher` is ambiguous. Connector rows were never written that way,
// so it is only treated as ciphertext when it actually decrypts; otherwise it
// remains ordinary plaintext. This keeps it from being silently rewritten.
export async function classifyStoredConnectorValue(env, raw) {
  const value = typeof raw === "string" ? raw : "";
  if (!value || !value.trim()) return { kind: "invalid", reason: "empty" };
  if (isConnectorCiphertext(value)) {
    if (!isVaultSecretConfigured(env)) return { kind: "decrypt_failed", reason: "key_missing" };
    try {
      const plain = await decryptVaultValue(env, normalizeConnectorCiphertext(value));
      if (typeof plain === "string" && plain) return { kind: "encrypted", plaintext: plain };
      return { kind: "decrypt_failed", reason: "empty_plaintext" };
    } catch {
      return { kind: "decrypt_failed", reason: "decrypt_failed" };
    }
  }
  if (isBareLegacyVaultValue(value) && isVaultSecretConfigured(env)) {
    try {
      const plain = await decryptVaultValue(env, value);
      if (typeof plain === "string" && plain) return { kind: "encrypted", plaintext: plain, legacy: "bare" };
    } catch {}
  }
  return { kind: "plaintext", value };
}

// A conditional UPDATE that changes zero rows may mean another writer already
// did the work. Re-read before classifying it as a failure or a success.
export async function verifyConnectorUpdate(env, db, userId, key, originalPlaintext, run) {
  const runOk = run?.success !== false;
  const rawChanges = run?.meta?.changes;
  const changes = rawChanges === undefined || rawChanges === null ? null : Number(rawChanges);
  if (runOk && changes !== null && changes > 0) return "encrypted";
  const current = await readConnectorSetting(db, userId, key);
  if (current.failed) return "failed";
  if (!current.present || !current.value) return "skipped";
  const c = await classifyStoredConnectorValue(env, current.value);
  if (c.kind === "encrypted") return c.plaintext === originalPlaintext ? "concurrent" : "concurrent_changed";
  if (c.kind === "decrypt_failed") return "decrypt_failed";
  if (c.kind === "plaintext") return c.value === originalPlaintext ? "failed" : "concurrent_changed";
  return "skipped";
}

async function lazyReencryptConnector(env, userId, key, plaintext, connectorId) {
  const db = connectorDb(env), id = Number(userId);
  if (!isVaultMasterKeyConfigured(env) || !db || !Number.isFinite(id)) return false;
  try {
    const enc = await encryptVaultValue({ VAULT_MASTER_KEY: env.VAULT_MASTER_KEY }, plaintext);
    const run = await db.prepare("UPDATE memories SET value = ?, updated_at = ? WHERE user_id = ? AND kind = 'setting' AND key = ? AND value = ?").bind(enc, new Date().toISOString(), id, key, plaintext).run();
    const outcome = await verifyConnectorUpdate(env, db, id, key, plaintext, run);
    connectorLog(connectorId, outcome === "encrypted" ? "reencrypted" : outcome === "concurrent" ? "reencrypted_concurrent" : "reencrypt_failed");
    return outcome === "encrypted" || outcome === "concurrent";
  } catch { connectorLog(connectorId, "reencrypt_failed"); return false; }
}

export async function getConnectorSecret(env, userId, connectorId) {
  const def = CONNECTOR_MAP[String(connectorId ?? "").trim().toLowerCase()];
  if (!def) return null;
  if (userId != null) {
    const row = await readConnectorSetting(env, userId, `conn_${def.id}`);
    if (row.failed) {
      connectorLog(def.id, "read_failed");
      throw new ConnectorSecretError(def.id, "db_read_failed");
    }
    if (!row.noDb && row.present && row.value) {
      const stored = await classifyStoredConnectorValue(env, row.value);
      if (stored.kind === "encrypted") return stored.plaintext;
      if (stored.kind === "decrypt_failed") {
        connectorLog(def.id, stored.reason);
        throw new ConnectorSecretError(def.id, stored.reason);
      }
      if (stored.kind === "plaintext") {
        await lazyReencryptConnector(env, userId, `conn_${def.id}`, stored.value, def.id);
        return stored.value;
      }
    }
  }
  const fromEnv = readEnvKey(env, ENV_KEY_ALIASES[def.id] ?? [def.keyName]);
  if (fromEnv) return fromEnv;
  return readConfigKey(env, def.id, def);
}

export async function setConnectorSecret(env, userId, connectorId, value) {
  const def = CONNECTOR_MAP[String(connectorId ?? "").trim().toLowerCase()];
  const v = typeof value === "string" ? value.trim() : "";
  if (!def || !v) return { ok: false, error: !def ? "unknown connector" : "empty value" };
  if (!isVaultMasterKeyConfigured(env)) {
    connectorLog(def.id, "write_failed_missing_key");
    return { ok: false, error: SWEEP_MASTER_KEY_ERROR };
  }
  try {
    const r = await setSetting(env, userId, `conn_${def.id}`, await encryptVaultValue({ VAULT_MASTER_KEY: env.VAULT_MASTER_KEY }, v));
    connectorLog(def.id, r?.ok === false ? "write_failed" : "written");
    return r;
  } catch { connectorLog(def.id, "write_failed"); return { ok: false, error: "connector secret could not be encrypted" }; }
}

export async function getConnectorStatuses(env, userSettings = {}, userId = null) {
  const settings = userSettings && typeof userSettings === "object" ? userSettings : {};
  const out = [];
  for (const def of CONNECTORS) {
    let raw = settings[`conn_${def.id}`] ?? settings[def.keyName] ?? null;
    let source = raw ? "user" : null;
    let secret = null;
    let error = null;
    if (!raw && userId != null) {
      const row = await readConnectorSetting(env, userId, `conn_${def.id}`);
      if (row.failed) { error = "db_read_failed"; }
      else if (row.present && row.value) { raw = row.value; source = "user"; }
    }
    if (!error && typeof raw === "string" && raw) {
      const stored = await classifyStoredConnectorValue(env, raw);
      if (stored.kind === "encrypted") secret = stored.plaintext;
      else if (stored.kind === "decrypt_failed") { error = stored.reason; connectorLog(def.id, stored.reason); }
      else if (stored.kind === "plaintext") secret = stored.value;
    }
    // A corrupt/undecryptable user row must not fall back to env for this
    // provider. Other providers are unaffected (M2 isolation).
    if (!secret && !error) {
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
      error,
      hint: `/setup ${def.id} <key>`,
      setupCommand: `/setup ${def.id} <key>`,
    });
  }
  return out;
}

// The project is single-user. The canonical owner is the one row in `users`
// (its id is the Telegram id; ensureUserRow keeps both equal). The allow-list
// is only an access gate and is deliberately not used as owner identity here.
