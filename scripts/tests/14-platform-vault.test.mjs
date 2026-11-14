// R0.7e: platform vault crypto round-trip and connector secret helpers.
import fs from "node:fs";
import { check, fakeKV, DatabaseSync } from "./harness.mjs";
import { encryptVaultValue, decryptVaultValue, isEncryptedVaultValue, isVaultSecretConfigured } from "../../src/platform/vault/crypto.js";
import { ConnectorSecretError, isConnectorSecretError, CONNECTORS } from "../../src/platform/vault/connectors-core.js";

export async function run() {
  const env = { VAULT_MASTER_KEY: "test-secret-key" };
  const plain = "رمز مودم ۹۸۷۶۵۴";
  const cipher = await encryptVaultValue(env, plain);
  check(typeof cipher === "string" && cipher.startsWith("v1:"), "R0.7e: ciphertext uses v1: prefix");
  check(isEncryptedVaultValue(cipher), "R0.7e: ciphertext is detected as encrypted");
  const dec = await decryptVaultValue(env, cipher);
  check(dec === plain, "R0.7e: ciphertext round-trips");
  check(isVaultSecretConfigured(env), "R0.7e: vault secret configured");
  const noKey = {};
  let failed = false;
  try { await encryptVaultValue(noKey, plain); } catch { failed = true; }
  check(failed, "R0.7e: missing key fails closed");
  // canary
  const prevFetch = globalThis.fetch;
  const prevConsole = {};
  const calls = [];
  globalThis.fetch = () => { calls.push("fetch"); return Promise.reject(new Error("network")); };
  for (const k of ["log", "warn", "error", "info", "debug"]) { prevConsole[k] = console[k]; console[k] = () => { calls.push(k); }; }
  try {
    await encryptVaultValue(env, plain);
    await decryptVaultValue(env, cipher);
    check(calls.length === 0, "R0.7e: vault crypto makes no network call and writes no log");
  } finally {
    globalThis.fetch = prevFetch;
    for (const k of Object.keys(prevConsole)) console[k] = prevConsole[k];
  }
  check(Array.isArray(CONNECTORS) && CONNECTORS.length > 0, "R0.7e: connectors catalog exported");
  const e = new ConnectorSecretError("gemini", "key_missing");
  check(isConnectorSecretError(e), "R0.7e: ConnectorSecretError is recognized");
}