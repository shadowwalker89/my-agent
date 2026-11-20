// N-6b: privacy-safe shape description for failed Workers AI NLU calls.
// Produces only fixed enums, booleans and counts — never user or model text.
import { extractJsonObject } from "./validate.js";

const TOP_KEYS = ["response", "text", "choices", "result", "usage", "tool_calls", "intent", "domain", "confidence"];
const typeName = (v) => v === null ? "null" : typeof v;

export function coerceNluRaw(res) {
  if (typeof res === "string") return res;
  if (res === null || typeof res !== "object") return "";
  const value = res.response ?? res.text;
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    try { return JSON.stringify(value); } catch { return ""; }
  }
  return "";
}

function firstCharClass(raw) {
  if (!raw.length) return "empty";
  const c = raw[0];
  if (c === "{" || c === "}") return "brace";
  if (c === '"' || c === "'") return "quote";
  if (c === "`") return "backtick";
  if (c === "<") return "angle";
  if (/\s/.test(c)) return "space";
  if (/[A-Za-z\u00C0-\u024F\u0600-\u06FF]/.test(c)) return "letter";
  if (/[0-9]/.test(c)) return "digit";
  return "other";
}

function lengthClass(n) {
  if (n === 0) return "0";
  if (n < 50) return "<50";
  if (n < 200) return "<200";
  if (n < 512) return "<512";
  return ">=512";
}

function braceDelta(raw) {
  let open = 0, close = 0;
  for (const c of raw) { if (c === "{") open++; else if (c === "}") close++; }
  return Math.max(-9, Math.min(9, open - close));
}

export function describeNluResult(res, raw) {
  const obj = res !== null && typeof res === "object" ? res : {};
  const keys = Object.keys(obj);
  const topKeys = TOP_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(obj, k));
  const usage = obj.usage;
  const completionTokens = usage && typeof usage === "object" && Number.isFinite(usage.completion_tokens)
    ? usage.completion_tokens : null;
  return {
    resType: typeName(res),
    responseType: typeName(obj.response),
    textType: typeName(obj.text),
    topKeys,
    otherKeys: keys.filter((k) => !TOP_KEYS.includes(k)).length,
    rawLenClass: lengthClass(raw.length),
    firstCharClass: firstCharClass(raw),
    braceDelta: braceDelta(raw),
    hasFence: raw.includes("```"),
    hasIntentToken: /"intent"\s*:/.test(raw),
    extractOk: Boolean(extractJsonObject(raw)),
    completionTokens,
  };
}
