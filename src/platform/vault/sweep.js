import { CONNECTORS, CONNECTOR_MAP, maskKey, connectorDb, readConnectorSetting, classifyStoredConnectorValue, isConnectorCiphertext, normalizeConnectorCiphertext, SWEEP_MASTER_KEY_ERROR, connectorLog, verifyConnectorUpdate } from "./connectors-core.js";
const CONNECTOR_KEY_NAMES = CONNECTORS.map((c) => `conn_${c.id}`);
import { encryptVaultValue, decryptVaultValue, isBareLegacyVaultValue, isVaultMasterKeyConfigured, isVaultSecretConfigured } from "./crypto.js";
import { setSetting } from "../../memory.js";
import { getConfig } from "../../config.js";
import { redact } from "../../providers.js";

export async function resolveConnectorSweepOwner(env) {
  const db = connectorDb(env);
  if (!db) return { ok: false, error: "db unavailable" };
  try {
    const q = await db.prepare("SELECT id, telegram_id FROM users ORDER BY id ASC LIMIT 2").bind().all();
    const rows = Array.isArray(q?.results) ? q.results : [];
    if (rows.length === 0) return { ok: false, error: "owner identity is not configured" };
    if (rows.length > 1) return { ok: false, error: "owner identity is ambiguous" };
    const id = Number(rows[0]?.id);
    const telegramId = rows[0]?.telegram_id;
    if (!Number.isFinite(id) || telegramId == null || String(telegramId) === "") {
      return { ok: false, error: "owner identity is incomplete" };
    }
    return { ok: true, userId: id, telegramId: String(telegramId) };
  } catch { return { ok: false, error: "db read failed" }; }
}

async function readOwnerConnectorRows(db, userId) {
  const placeholders = CONNECTOR_KEY_NAMES.map(() => "?").join(", ");
  const q = await db.prepare(`SELECT user_id, key, value FROM memories WHERE user_id = ? AND kind = 'setting' AND key IN (${placeholders}) ORDER BY key ASC`).bind(userId, ...CONNECTOR_KEY_NAMES).all();
  return Array.isArray(q?.results) ? q.results : [];
}

async function countOwnerUnknownConnectorRows(db, userId) {
  const placeholders = CONNECTOR_KEY_NAMES.map(() => "?").join(", ");
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND kind = 'setting' AND substr(key, 1, 5) = 'conn_' AND key NOT IN (${placeholders})`).bind(userId, ...CONNECTOR_KEY_NAMES).first();
  return Number(row?.n ?? 0);
}

// Bounded, idempotent, resumable, owner-scoped sweep. Only counts are returned.
// Invalid rows are reported but never read, rewritten, or deleted; they are
// excluded from the candidate query so they cannot starve valid rows.
export async function sweepConnectorSecrets(env, { limit = 100, callerId = null } = {}) {
  const cap = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Math.floor(Number(limit)))) : 100;
  const res = { ok: false, complete: false, limit: cap, ownerId: null, scanned: 0, encrypted: 0, concurrent: 0, changed: 0, failed: 0, alreadyEncrypted: 0, decryptFailed: 0, invalid: 0, invalidUnknown: 0, invalidEmpty: 0, pending: 0, remaining: 0 };
  if (!isVaultMasterKeyConfigured(env)) { res.error = SWEEP_MASTER_KEY_ERROR; return res; }
  const db = connectorDb(env);
  if (!db) { res.error = "db unavailable"; return res; }
  const owner = await resolveConnectorSweepOwner(env);
  if (!owner.ok) { res.error = owner.error; return res; }
  if (callerId == null || String(callerId) !== owner.telegramId) { res.error = "owner authorization required"; return res; }
  res.ownerId = owner.userId;

  let rows = [];
  try { rows = await readOwnerConnectorRows(db, owner.userId); }
  catch { res.error = "db read failed"; return res; }
  const plaintext = [];
  for (const row of rows) {
    const key = typeof row?.key === "string" ? row.key : "";
    const id = key.replace(/^conn_/, "");
    if (!CONNECTOR_MAP[id]) continue;
    const stored = await classifyStoredConnectorValue(env, row?.value);
    if (stored.kind === "encrypted") res.alreadyEncrypted++;
    else if (stored.kind === "decrypt_failed") res.decryptFailed++;
    else if (stored.kind === "plaintext") plaintext.push({ key, value: stored.value });
    else { res.invalidEmpty++; res.invalid++; }
  }
  try { res.invalidUnknown = await countOwnerUnknownConnectorRows(db, owner.userId); }
  catch { res.error = "db read failed"; return res; }
  res.invalid += res.invalidUnknown;

  for (const item of plaintext.slice(0, cap)) {
    res.scanned++;
    try {
      const enc = await encryptVaultValue({ VAULT_MASTER_KEY: env.VAULT_MASTER_KEY }, item.value);
      const run = await db.prepare("UPDATE memories SET value = ?, updated_at = ? WHERE user_id = ? AND kind = 'setting' AND key = ? AND value = ?").bind(enc, new Date().toISOString(), owner.userId, item.key, item.value).run();
      const outcome = await verifyConnectorUpdate(env, db, owner.userId, item.key, item.value, run);
      if (outcome === "encrypted") { res.encrypted++; connectorLog(item.key.replace(/^conn_/, ""), "encrypted"); }
      else if (outcome === "concurrent") { res.encrypted++; res.concurrent++; connectorLog(item.key.replace(/^conn_/, ""), "encrypted_concurrent"); }
      else if (outcome === "decrypt_failed") { res.decryptFailed++; connectorLog(item.key.replace(/^conn_/, ""), "decrypt_failed"); }
      else if (outcome === "concurrent_changed") { res.concurrent++; res.changed++; connectorLog(item.key.replace(/^conn_/, ""), "concurrent_changed"); }
      else { res.failed++; connectorLog(item.key.replace(/^conn_/, ""), "sweep_failed"); }
    } catch { res.failed++; connectorLog(item.key.replace(/^conn_/, ""), "sweep_failed"); }
  }

  // Re-read the scope after the batch for an exact remaining count. If that
  // read fails, report "unknown" and never claim success.
  try {
    const after = await readOwnerConnectorRows(db, owner.userId);
    let remaining = 0;
    for (const row of after) {
      const id = String(row?.key ?? "").replace(/^conn_/, "");
      if (!CONNECTOR_MAP[id]) continue;
      const stored = await classifyStoredConnectorValue(env, row?.value);
      if (stored.kind === "plaintext") remaining++;
    }
    res.remaining = remaining;
    res.pending = remaining;
  } catch {
    res.remaining = "unknown";
    res.pending = "unknown";
  }
  // A concurrent write to a different value (including an invalid one) means
  // this batch did not fully account for the scope; never claim success.
  res.ok = res.decryptFailed === 0 && res.failed === 0 && res.changed === 0 && res.remaining === 0;
  res.complete = res.ok && res.invalid === 0;
  return res;
}

export function renderSetupStatusText(statuses) {
  const list = Array.isArray(statuses) ? statuses : Object.values(statuses ?? {});
  const lines = ["⚙️ **وضعیت کانکتورها**\n"];
  for (const s of list) {
    const icon = s.error ? "⚠️ خطای کلید" : s.configured ? "✅ متصل" : "⚙️ تنظیم‌نشده";
    const masked = s.masked ? ` (${s.masked})` : "";
    lines.push(`${icon} **${s.id}**: ${s.label}${masked}\n  تنظیم: \`/setup ${s.id} <key>\` یا \`تنظیم کانکتور ${s.id} <key>\``);
  }
  lines.push("\nبرای تنظیم/به‌روزرسانی هر کلید: `تنظیم کانکتور <id> <key>` یا `/setup <id> <key>` (مثلاً `/setup gemini AIzaSy...` یا `/setup together ...`)");
  return lines.join("\n");
}
