function cleanPrompt(s) {
  return String(s ?? "").trim().replace(/\s+/g, " ").replace(/[.!؟?۔]+$/u, "").trim();
}

function b64ToBytes(b64) {
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

export function parseImageGenCommand(text) {
  const t = String(text ?? "").trim();
  if (!t) return { isImageGen: false, prompt: "" };
  if (/ذخیره\s*کن|گاوصندوق/u.test(t)) return { isImageGen: false, prompt: "" };
  const slash = t.match(/^\/(?:image|img)\s+(.+)$/i);
  if (slash) {
    const p = cleanPrompt(slash[1]);
    return p ? { isImageGen: true, prompt: p } : { isImageGen: false, prompt: "" };
  }
  const patterns = [
    /^\s*یک[\s\u200C]+تصویر[\s\u200C]+از[\s\u200C]+(.+?)[\s\u200C]+بساز[.!؟?۔]*\s*$/u,
    /^\s*یه[\s\u200C]+عکس[\s\u200C]+از[\s\u200C]+(.+?)[\s\u200C]+بساز[.!؟?۔]*\s*$/u,
    /^\s*تصویری[\s\u200C]+از[\s\u200C]+(.+?)[\s\u200C]+بساز[.!؟?۔]*\s*$/u,
    /^\s*تصویر[\s\u200C]+(.+?)[\s\u200C]+را[\s\u200C]+تولید[\s\u200C]+کن[.!؟?۔]*\s*$/u,
    /^\s*عکس[\s\u200C]+(.+?)[\s\u200C]+رو[\s\u200C]+بکش[.!؟?۔]*\s*$/u,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const p = cleanPrompt(m[1]);
      if (p) return { isImageGen: true, prompt: p };
    }
  }
  return { isImageGen: false, prompt: "" };
}

export async function generateFreeImage(env, prompt, opts = {}) {
  const clean = String(prompt ?? "").trim();
  if (!clean) return { ok: false, error: "image_gen_failed" };
  if (env?.AI && typeof env.AI.run === "function") {
    try {
      const out = await env.AI.run(opts.cfModel || "@cf/black-forest-labs/flux-1-schnell", { prompt: clean });
      const bytes = await toBytes(out);
      if (bytes && bytes.length) return { ok: true, bytes, mimeType: "image/png", provider: "cf-flux" };
    } catch {}
  }
  try {
    const fn = opts.fetchFn || fetch;
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(clean)}?width=1024&height=1024&nologo=true`;
    const res = await fn(url);
    if (res?.ok) {
      const buf = await res.arrayBuffer();
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      if (bytes && bytes.length) return { ok: true, bytes, mimeType: "image/jpeg", provider: "pollinations" };
    }
  } catch {}
  return { ok: false, error: "image_gen_failed" };
}

export function isVisionQuestionCaption(caption) {
  const s = String(caption ?? "").trim();
  if (!s) return false;
  if (s.endsWith("?") || s.endsWith("؟")) return true;
  const markers = ["این چیه", "چی نوشته", "ترجمه", "توضیح بده", "تحلیل کن", "فیش", "فاکتور", "کیلومتر", "چنده"];
  return markers.some((m) => s.includes(m));
}
