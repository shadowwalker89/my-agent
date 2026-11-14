import { getConnectorSecret, isConnectorSecretError } from "../../connectors.js";
import { getConfig } from "../../config.js";

export function cleanPrompt(s) {
  return String(s ?? "").trim().replace(/\s+/g, " ").replace(/[.!؟?۔]+$/u, "").trim();
}

export function b64ToBytes(b64) {
  let s = String(b64 ?? "").trim();
  if (s.startsWith("data:")) {
    const i = s.indexOf(",");
    if (i >= 0) s = s.slice(i + 1);
  }
  s = s.replace(/\s+/g, "");
  if (typeof atob === "function") {
    try {
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {}
  }
  if (typeof globalThis !== "undefined" && typeof globalThis.atob === "function") {
    try {
      const bin = globalThis.atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {}
  }
  if (typeof Buffer !== "undefined") {
    try {
      return new Uint8Array(Buffer.from(s, "base64"));
    } catch {}
  }
  return null;
}

export function bytesToBase64(bytes) {
  if (!bytes) return "";
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof Buffer !== "undefined") {
    try {
      return Buffer.from(u8).toString("base64");
    } catch {}
  }
  let bin = "";
  for (let i = 0; i < u8.length; i += 8192) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  }
  if (typeof btoa === "function") return btoa(bin);
  return bin;
}

export function bytesToB64(bytes) {
  return bytesToBase64(bytes);
}

async function toBytes(out) {
  if (!out) return null;
  if (out instanceof Uint8Array) return out;
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(out)) return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  if (out && typeof out === "object" && "image" in out) {
    const img = out.image;
    if (img instanceof Uint8Array) return img;
    if (img instanceof ArrayBuffer) return new Uint8Array(img);
    if (typeof img === "string") {
      const b = b64ToBytes(img);
      if (b && b.length) return b;
    }
    if (img && typeof img === "object" && typeof img.getReader === "function") {
      const buf = await new Response(img).arrayBuffer();
      return new Uint8Array(buf);
    }
  }
  if (typeof ReadableStream !== "undefined" && out instanceof ReadableStream) {
    const buf = await new Response(out).arrayBuffer();
    return new Uint8Array(buf);
  }
  if (out && typeof out.getReader === "function") {
    const buf = await new Response(out).arrayBuffer();
    return new Uint8Array(buf);
  }
  return null;
}


export async function resolveKey(env, userId, connectorId, fallbackEnvName) {
  let v = null;
  try {
    v = await getConnectorSecret(env, userId, connectorId);
  } catch (e) {
    if (isConnectorSecretError(e)) throw e;
  }
  if (typeof v === "string" && v) return v;
  const fromEnv = env?.[fallbackEnvName];
  if (typeof fromEnv === "string" && fromEnv) return fromEnv;
  // Config-backed keys: the admin/config store may hold the key on the
  // provider entry (providers[].apiKey) or under a top-level alias.
  try {
    const cfg = await getConfig(env);
    const id = String(connectorId ?? "").toLowerCase();
    const provider = (cfg?.providers ?? []).find((p) => String(p?.id ?? "").toLowerCase() === id);
    const candidates = [
      provider?.apiKey, provider?.key, provider?.secret,
      cfg?.providers?.[id]?.apiKey,
      cfg?.[`${id}ApiKey`], cfg?.[`${id}_api_key`], cfg?.[id]?.apiKey,
    ];
    for (const v of candidates) if (typeof v === "string" && v) return v;
  } catch {}
  return null;
}

// Provider-isolated diagnostics: a corrupt secret for one connector must not
// abort providers whose credentials come from a different connector.
export function connectorDiag(prefix, e) {
  if (isConnectorSecretError(e)) return `${prefix}:connector_secret_unavailable:${e?.reason || "error"}`;
  return `${prefix}:${e?.message || "error"}`;
}

export function resolveFetch(opts) {
  return opts?.fetchFn || (typeof fetch === "function" ? fetch : null);
}

export async function safeJson(res) {
  try {
    if (typeof res?.json === "function") return await res.json();
  } catch {}
  try {
    if (typeof res?.text === "function") {
      const t = await res.text();
      return t ? JSON.parse(t) : null;
    }
  } catch {}
  return null;
}

export function extractGeminiImage(json) {
  const c = json?.candidates?.[0]?.content?.parts || [];
  for (const p of c) {
    const d = p?.inlineData?.data || p?.inline_data?.data || p?.inlineData || p?.inline_data;
    if (typeof d === "string" && d) return d;
  }
  const cand = json?.candidates?.[0];
  if (cand) {
    const direct = cand?.content?.parts?.[0]?.inlineData?.data || cand?.content?.parts?.[0]?.inline_data?.data;
    if (direct) return direct;
  }
  return null;
}

export function extractTogetherImage(json) {
  const arr = json?.data || json?.images || null;
  if (Array.isArray(arr) && arr[0]) {
    const first = arr[0];
    const b = first?.b64_json || first?.base64 || first?.image || first?.data;
    if (typeof b === "string" && b) return b;
  }
  if (typeof json?.b64_json === "string") return json.b64_json;
  if (typeof json?.base64 === "string") return json.base64;
  return null;
}

export function extractNvidiaImage(json) {
  if (typeof json?.image === "string" && json.image) return json.image;
  if (typeof json?.base64 === "string" && json.base64) return json.base64;
  if (Array.isArray(json?.artifacts) && json.artifacts[0]) {
    const b = json.artifacts[0]?.base64 || json.artifacts[0]?.image || json.artifacts[0]?.data;
    if (typeof b === "string" && b) return b;
  }
  if (Array.isArray(json) && json[0]) {
    const b = json[0]?.base64 || json[0]?.image || json[0]?.data;
    if (typeof b === "string" && b) return b;
  }
  return null;
}

// Puter's driver-call responses vary by driver: the image may arrive as a
// data URL, a plain base64 string, a remote URL, or nested under result/data.
export function extractPuterImage(json) {
  const scan = (v, depth) => {
    if (v == null || depth > 5) return null;
    if (typeof v === "string") {
      if (/^data:image\//i.test(v)) return { b64: v };
      if (/^https?:\/\//i.test(v)) return { url: v };
      if (v.length > 200 && /^[A-Za-z0-9+/=\r\n]+$/.test(v)) return { b64: v };
      return null;
    }
    if (Array.isArray(v)) {
      for (const item of v) { const hit = scan(item, depth + 1); if (hit) return hit; }
      return null;
    }
    if (typeof v === "object") {
      for (const key of ["b64_json", "base64", "image_base64"]) {
        if (typeof v[key] === "string" && v[key]) return { b64: v[key] };
      }
      for (const key of ["url", "image_url", "src", "image", "data", "result", "output", "outputs", "images"]) {
        if (key in v) { const hit = scan(v[key], depth + 1); if (hit) return hit; }
      }
    }
    return null;
  };
  return scan(json, 0);
}

export const IMAGE_USER_AGENT = "Mozilla/5.0 (compatible; my-agent/1.0)";
export const PERSIAN_RE = /[\u0600-\u06FF]/;

export function timeoutSignal(ms) {
  try { if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms); } catch {}
  return undefined;
}

