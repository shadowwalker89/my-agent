// Platform vault crypto helpers extracted from src/vault.js (R0.7e).
// AES-GCM encryption for personal vault values; never touches logs/LLM.
const ENC_PREFIX = "v1:";
const LEGACY_ENC_PREFIX = "enc:v1:";

function vaultSecret(env) {
  const s = env?.VAULT_MASTER_KEY || env?.VAULT_SECRET || env?.ADMIN_SECRET || env?.TELEGRAM_BOT_TOKEN || env?.TG_TOKEN;
  return typeof s === "string" && s ? s : null;
}

export function isVaultSecretConfigured(env) {
  return vaultSecret(env) !== null;
}

export function isVaultMasterKeyConfigured(env) {
  return typeof env?.VAULT_MASTER_KEY === "string" && Boolean(env.VAULT_MASTER_KEY);
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

const BARE_LEGACY_RE = /^[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]{16,}={0,2}$/;

export function isBareLegacyVaultValue(value) {
  return typeof value === "string" && BARE_LEGACY_RE.test(value);
}

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

// Export helper for google module / tests
export { bytesToB64, b64ToBytes, b64url, b64urlText, pemToBytes, ENC_PREFIX, LEGACY_ENC_PREFIX, BARE_LEGACY_RE, vaultCipherBody };
