// Phase 3-A: encrypted personal vault + best-effort Google mirror.
// Values are AES-256-GCM ciphertext before they touch D1/KV; the key is
// derived from VAULT_MASTER_KEY / VAULT_SECRET (falling back to
// ADMIN_SECRET / the bot token so existing deployments keep working).
// Google sync is optional and never blocks local storage: callers save
// locally first and mark the row pending_google when no backend is
// configured.
import { getConfig } from "./config.js";

const ENC_PREFIX = "v1:";
const LEGACY_ENC_PREFIX = "enc:v1:";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
].join(" ");

function vaultSecret(env) {
  const s = env?.VAULT_MASTER_KEY || env?.VAULT_SECRET || env?.ADMIN_SECRET || env?.TELEGRAM_BOT_TOKEN || env?.TG_TOKEN;
  return typeof s === "string" && s ? s : null;
}

async function vaultKey(env) {
  const secret = vaultSecret(env);
  if (!secret) throw new Error("vault secret is not configured");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function bytesToB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(String(b64));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function b64url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlText(text) {
  return b64url(new TextEncoder().encode(String(text)));
}

function pemToBytes(pem) {
  const body = String(pem ?? "")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return b64ToBytes(body);
}

// A19: new rows are "v1:<iv_b64>:<cipher_b64>". Existing rows use the old
// "enc:v1:<iv_b64>:<cipher_b64>" prefix, and pre-release rows may be bare
// "<iv_b64>:<cipher_b64>" (12-byte IV = 16 base64 chars, then ciphertext).
const BARE_LEGACY_RE = /^[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]{16,}={0,2}$/;

function vaultCipherBody(value) {
  if (typeof value !== "string") return null;
  if (value.startsWith(ENC_PREFIX)) return value.slice(ENC_PREFIX.length);
  if (value.startsWith(LEGACY_ENC_PREFIX)) return value.slice(LEGACY_ENC_PREFIX.length);
  if (BARE_LEGACY_RE.test(value)) return value;
  return null;
}

export function isEncryptedVaultValue(value) {
  return vaultCipherBody(value) !== null;
}

export async function encryptVaultValue(env, plaintext) {
  const key = await vaultKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(String(plaintext ?? "")));
  return `${ENC_PREFIX}${bytesToB64(iv)}:${bytesToB64(new Uint8Array(cipher))}`;
}

export async function decryptVaultValue(env, value) {
  const s = String(value ?? "");
  const body = vaultCipherBody(s);
  if (body === null) return s;
  const [ivB64, cipherB64] = body.split(":");
  if (!ivB64 || !cipherB64) throw new Error("invalid vault ciphertext");
  const key = await vaultKey(env);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(ivB64) }, key, b64ToBytes(cipherB64));
  return new TextDecoder().decode(plain);
}

export async function getGoogleVaultConfig(env) {
  let stored = null;
  if (env?.STATE) {
    try {
      const cfg = await getConfig(env);
      stored = cfg?.googleVault && typeof cfg.googleVault === "object" ? cfg.googleVault : null;
    } catch {
      stored = null;
    }
  }
  const src = stored ?? {};
  return {
    sheetId: env?.GOOGLE_VAULT_SHEET_ID || src.sheetId || "",
    docId: env?.GOOGLE_VAULT_DOC_ID || src.docId || "",
    driveFolderId: env?.GOOGLE_VAULT_DRIVE_FOLDER_ID || src.driveFolderId || "",
    webhookUrl: env?.GOOGLE_VAULT_WEBHOOK_URL || src.webhookUrl || "",
    webhookSecret: env?.GOOGLE_VAULT_WEBHOOK_SECRET || src.webhookSecret || "",
    clientId: env?.GOOGLE_VAULT_CLIENT_ID || src.clientId || "",
    clientSecret: env?.GOOGLE_VAULT_CLIENT_SECRET || src.clientSecret || "",
    refreshToken: env?.GOOGLE_VAULT_REFRESH_TOKEN || src.refreshToken || "",
    serviceAccountJson: env?.GOOGLE_VAULT_SERVICE_ACCOUNT_JSON || src.serviceAccountJson || "",
    accessToken: env?.GOOGLE_VAULT_ACCESS_TOKEN || src.accessToken || "",
  };
}

export function googleVaultStatus(cfg) {
  const modes = [];
  if (cfg?.webhookUrl) modes.push("webhook");
  if (cfg?.sheetId) modes.push("sheets");
  if (cfg?.docId) modes.push("docs");
  if (cfg?.driveFolderId) modes.push("drive");
  return { configured: modes.length > 0, modes };
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function serviceAccountToken(cfg, fetchImpl) {
  let sa;
  try {
    sa = JSON.parse(String(cfg.serviceAccountJson ?? ""));
  } catch {
    return null;
  }
  if (!sa?.client_email || !sa?.private_key) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64urlText(
    JSON.stringify({
      iss: sa.client_email,
      scope: GOOGLE_SCOPES,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claim}`;
  try {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemToBytes(sa.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
    const assertion = `${unsigned}.${b64url(new Uint8Array(sig))}`;
    const res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    const json = await safeJson(res);
    return res.ok && typeof json?.access_token === "string" ? json.access_token : null;
  } catch {
    return null;
  }
}

async function googleAccessToken(cfg, fetchImpl) {
  if (cfg?.accessToken) return cfg.accessToken;
  if (cfg?.refreshToken && cfg?.clientId && cfg?.clientSecret) {
    try {
      const res = await fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          refresh_token: cfg.refreshToken,
          grant_type: "refresh_token",
        }),
      });
      const json = await safeJson(res);
      return res.ok && typeof json?.access_token === "string" ? json.access_token : null;
    } catch {
      return null;
    }
  }
  if (cfg?.serviceAccountJson) return await serviceAccountToken(cfg, fetchImpl);
  return null;
}

function webhookHeaders(cfg) {
  return {
    "content-type": "application/json",
    ...(cfg.webhookSecret ? { "X-Vault-Secret": cfg.webhookSecret } : {}),
  };
}

// Mirrors one text item. Returns {ok, mode, googleId?, error?}; error
// strings are short and never include the value or any credential.
export async function syncVaultItemToGoogle(env, item, fetchImpl = fetch) {
  const cfg = await getGoogleVaultConfig(env);
  const payload = {
    id: item?.id ?? null,
    userId: item?.userId ?? null,
    label: item?.label ?? "",
    value: item?.value ?? "",
    kind: "text",
    createdAt: item?.createdAt ?? new Date().toISOString(),
  };
  if (cfg.webhookUrl) {
    try {
      const res = await fetchImpl(cfg.webhookUrl, {
        method: "POST",
        headers: webhookHeaders(cfg),
        body: JSON.stringify(payload),
      });
      const json = await safeJson(res);
      if (!res.ok || json?.ok === false) return { ok: false, mode: "webhook", error: `webhook http ${res.status}` };
      return { ok: true, mode: "webhook", googleId: json?.id ?? null };
    } catch {
      return { ok: false, mode: "webhook", error: "webhook request failed" };
    }
  }
  if (cfg.sheetId) {
    const token = await googleAccessToken(cfg, fetchImpl);
    if (!token) return { ok: false, mode: "sheets", error: "google auth is not configured" };
    try {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cfg.sheetId)}/values/A1:append?valueInputOption=RAW`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          values: [[String(payload.id ?? ""), payload.label, payload.value, payload.createdAt]],
        }),
      });
      const json = await safeJson(res);
      if (!res.ok) return { ok: false, mode: "sheets", error: `sheets http ${res.status}` };
      return { ok: true, mode: "sheets", googleId: json?.updates?.updatedRange ?? null };
    } catch {
      return { ok: false, mode: "sheets", error: "sheets request failed" };
    }
  }
  if (cfg.docId) {
    const token = await googleAccessToken(cfg, fetchImpl);
    if (!token) return { ok: false, mode: "docs", error: "google auth is not configured" };
    try {
      const url = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(cfg.docId)}:batchUpdate`;
      const text = `\n${payload.label}\n${payload.value}\n`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ requests: [{ insertText: { endOfSegmentLocation: {}, text } }] }),
      });
      if (!res.ok) return { ok: false, mode: "docs", error: `docs http ${res.status}` };
      return { ok: true, mode: "docs", googleId: cfg.docId };
    } catch {
      return { ok: false, mode: "docs", error: "docs request failed" };
    }
  }
  return { ok: false, mode: "none", error: "google vault is not configured" };
}

// Mirrors one binary file. Webhook mode carries base64; Drive mode uses
// the multipart upload endpoint and stores only the returned file id.
export async function syncVaultFileToGoogle(env, file, fetchImpl = fetch) {
  const cfg = await getGoogleVaultConfig(env);
  const data = file?.data instanceof Uint8Array ? file.data : new Uint8Array(file?.data ?? []);
  if (cfg.webhookUrl) {
    try {
      const res = await fetchImpl(cfg.webhookUrl, {
        method: "POST",
        headers: webhookHeaders(cfg),
        body: JSON.stringify({
          id: file?.id ?? null,
          userId: file?.userId ?? null,
          label: file?.label ?? file?.fileName ?? "",
          kind: "file",
          fileName: file?.fileName ?? "",
          mimeType: file?.mimeType ?? "application/octet-stream",
          dataB64: bytesToB64(data),
          createdAt: file?.createdAt ?? new Date().toISOString(),
        }),
      });
      const json = await safeJson(res);
      if (!res.ok || json?.ok === false) return { ok: false, mode: "webhook", error: `webhook http ${res.status}` };
      return { ok: true, mode: "webhook", googleId: json?.id ?? null };
    } catch {
      return { ok: false, mode: "webhook", error: "webhook request failed" };
    }
  }
  if (!cfg.driveFolderId) return { ok: false, mode: "none", error: "google drive is not configured" };
  const token = await googleAccessToken(cfg, fetchImpl);
  if (!token) return { ok: false, mode: "drive", error: "google auth is not configured" };
  try {
    const boundary = `vault_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const meta = JSON.stringify({ name: file?.fileName || "vault-file", parents: [cfg.driveFolderId] });
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${file?.mimeType || "application/octet-stream"}\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    const res = await fetchImpl("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
      body: new Blob([head, data, tail]),
    });
    const json = await safeJson(res);
    if (!res.ok || !json?.id) return { ok: false, mode: "drive", error: `drive http ${res.status}` };
    return { ok: true, mode: "drive", googleId: json.id };
  } catch {
    return { ok: false, mode: "drive", error: "drive request failed" };
  }
}

// Pulls the mirror back for a user. Webhook/Sheets return structured
// items; Docs has no row model, so it returns the document text only.
export async function fetchVaultFromGoogle(env, { userId = null } = {}, fetchImpl = fetch) {
  const cfg = await getGoogleVaultConfig(env);
  if (cfg.webhookUrl) {
    try {
      const url = new URL(cfg.webhookUrl);
      if (userId != null) url.searchParams.set("userId", String(userId));
      const res = await fetchImpl(url.toString(), { method: "GET", headers: webhookHeaders(cfg) });
      const json = await safeJson(res);
      if (!res.ok || json?.ok === false) return { ok: false, mode: "webhook", items: [], error: `webhook http ${res.status}` };
      return { ok: true, mode: "webhook", items: Array.isArray(json?.items) ? json.items : [] };
    } catch {
      return { ok: false, mode: "webhook", items: [], error: "webhook request failed" };
    }
  }
  if (cfg.sheetId) {
    const token = await googleAccessToken(cfg, fetchImpl);
    if (!token) return { ok: false, mode: "sheets", items: [], error: "google auth is not configured" };
    try {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cfg.sheetId)}/values/A1:D1000`;
      const res = await fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${token}` } });
      const json = await safeJson(res);
      if (!res.ok) return { ok: false, mode: "sheets", items: [], error: `sheets http ${res.status}` };
      const rows = Array.isArray(json?.values) ? json.values : [];
      return {
        ok: true,
        mode: "sheets",
        items: rows.map((row) => ({
          id: row?.[0] ?? null,
          label: row?.[1] ?? "",
          value: row?.[2] ?? "",
          createdAt: row?.[3] ?? null,
        })),
      };
    } catch {
      return { ok: false, mode: "sheets", items: [], error: "sheets request failed" };
    }
  }
  if (cfg.docId) {
    const token = await googleAccessToken(cfg, fetchImpl);
    if (!token) return { ok: false, mode: "docs", items: [], error: "google auth is not configured" };
    try {
      const url = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(cfg.docId)}`;
      const res = await fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${token}` } });
      const json = await safeJson(res);
      if (!res.ok) return { ok: false, mode: "docs", items: [], error: `docs http ${res.status}` };
      const text = (json?.body?.content ?? [])
        .flatMap((el) => el?.paragraph?.elements ?? [])
        .map((el) => el?.textRun?.content ?? "")
        .join("");
      return { ok: true, mode: "docs", items: [], text };
    } catch {
      return { ok: false, mode: "docs", items: [], error: "docs request failed" };
    }
  }
  return { ok: false, mode: "none", items: [], error: "google vault is not configured" };
}
