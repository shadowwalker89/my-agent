import { getConnectorSecret } from "./connectors.js";

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

function bytesToB64(bytes) {
  if (!bytes) return "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof Buffer !== "undefined") {
    try {
      return Buffer.from(arr).toString("base64");
    } catch {}
  }
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  if (typeof btoa === "function") return btoa(bin);
  return bin;
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

async function resolveKey(env, userId, connectorId, fallbackEnvName) {
  try {
    const v = await getConnectorSecret(env, userId, connectorId);
    if (typeof v === "string" && v) return v;
  } catch {}
  const fromEnv = env?.[fallbackEnvName];
  return typeof fromEnv === "string" && fromEnv ? fromEnv : null;
}

function resolveFetch(opts) {
  return opts?.fetchFn || (typeof fetch === "function" ? fetch : null);
}

async function safeJson(res) {
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

function extractGeminiImage(json) {
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

function extractTogetherImage(json) {
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

function extractNvidiaImage(json) {
  if (typeof json?.image === "string" && json.image) return json.image;
  if (typeof json?.base64 === "string" && json.base64) return json.base64;
  if (Array.isArray(json?.artifacts) && json.artifacts[0]) {
    const b = json.artifacts[0]?.base64 || json.artifacts[0]?.image || json.artifacts[0]?.data;
    if (typeof b === "string" && b) return b;
  }
  return null;
}

const IMAGE_USER_AGENT = "Mozilla/5.0 (compatible; my-agent/1.0)";
const PERSIAN_RE = /[\u0600-\u06FF]/;

function timeoutSignal(ms) {
  try { if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms); } catch {}
  return undefined;
}

// Pollinations and several free endpoints block non-browser user agents from
// Workers, and Persian prompts generate poorly. Translate to English via a
// caller-supplied translateFn, NVIDIA (the preferred live key), or Gemini.
// Always fall back to the original text when translation is unavailable.
async function toEnglishImagePrompt(env, userId, prompt, fn, opts = {}) {
  if (!PERSIAN_RE.test(prompt) || typeof fn !== "function") return prompt;
  if (typeof opts.translateFn === "function") {
    try { const t = await opts.translateFn(prompt); if (typeof t === "string" && t.trim() && !PERSIAN_RE.test(t)) return t.trim(); } catch {}
  }
  try {
    const nvidiaKey = await resolveKey(env, userId, "nvidia", "NVIDIA_API_KEY");
    if (nvidiaKey) {
      const res = await fn("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${nvidiaKey}` },
        body: JSON.stringify({ model: "meta/llama-3.1-70b-instruct", messages: [{ role: "user", content: `Translate this image prompt into concise English for an image model. Return only the English prompt, no quotes:\n${prompt}` }], max_tokens: 120, temperature: 0.2 }),
        signal: timeoutSignal(3000),
      });
      if (res?.ok) {
        const json = await safeJson(res);
        const text = json?.choices?.[0]?.message?.content;
        if (typeof text === "string" && text.trim()) return text.trim();
      }
    }
  } catch {}
  const key = await resolveKey(env, userId, "gemini", "GEMINI_API_KEY");
  if (!key) return prompt;
  try {
    const res = await fn(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `Translate this image prompt into concise English for an image model. Return only the English prompt, no quotes:\n${prompt}` }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 120 },
      }),
      signal: timeoutSignal(4000),
    });
    if (!res?.ok) return prompt;
    const json = await safeJson(res);
    const text = (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(" ").trim();
    return text || prompt;
  } catch {
    return prompt;
  }
}

export async function generateFreeImage(env, prompt, opts = {}) {
  const clean = String(prompt ?? "").trim();
  if (!clean) return { ok: false, error: "image_gen_failed" };
  const fn = resolveFetch(opts);
  const userId = opts.userId ?? null;
  if (typeof fn !== "function") return { ok: false, error: "image_gen_failed" };
  const visual = await toEnglishImagePrompt(env, userId, clean, fn, opts);

  try {
    const togetherKey = await resolveKey(env, userId, "together", "TOGETHER_API_KEY");
    if (togetherKey) {
      try {
        const res = await fn("https://api.together.xyz/v1/images/generations", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${togetherKey}` },
          body: JSON.stringify({ model: "black-forest-labs/FLUX.1-schnell-Free", prompt: visual, width: 1024, height: 1024, n: 1, response_format: "b64_json" }),
          signal: timeoutSignal(8000),
        });
        if (res?.ok) {
          const json = await safeJson(res);
          const b64 = extractTogetherImage(json);
          const bytes = b64 ? b64ToBytes(b64) : null;
          if (bytes && bytes.length) return { ok: true, bytes, mimeType: "image/png", provider: "together" };
        }
      } catch {}
    }
  } catch {}

  try {
    const nvidiaKey = await resolveKey(env, userId, "nvidia", "NVIDIA_API_KEY");
    if (nvidiaKey) {
      const tryNvidia = async (body) => {
        try {
          const res = await fn("https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${nvidiaKey}`, Accept: "application/json" },
            body: JSON.stringify(body),
            signal: timeoutSignal(8000),
          });
          if (res?.ok) {
            const json = await safeJson(res);
            const b64 = extractNvidiaImage(json);
            const bytes = b64 ? b64ToBytes(b64) : null;
            if (bytes && bytes.length) return bytes;
          }
        } catch {}
        return null;
      };
      let nbytes = await tryNvidia({ prompt: visual, width: 1024, height: 1024, steps: 4 });
      if (!nbytes) nbytes = await tryNvidia({ prompt: visual });
      if (nbytes) return { ok: true, bytes: nbytes, mimeType: "image/png", provider: "nvidia" };
    }
  } catch {}

  try {
    const geminiKey = await resolveKey(env, userId, "gemini", "GEMINI_API_KEY");
    if (geminiKey) {
      try {
        const res = await fn(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${geminiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: visual }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
          }),
          signal: timeoutSignal(8000),
        });
        if (res?.ok) {
          const json = await safeJson(res);
          const b64 = extractGeminiImage(json);
          const bytes = b64 ? b64ToBytes(b64) : null;
          if (bytes && bytes.length) return { ok: true, bytes, mimeType: "image/png", provider: "gemini" };
        }
      } catch {}
    }
  } catch {}

  try {
    const hfKey = await resolveKey(env, userId, "huggingface", "HF_TOKEN");
    if (hfKey) {
      try {
        const res = await fn("https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${hfKey}`, Accept: "image/png" },
          body: JSON.stringify({ inputs: visual }),
          signal: timeoutSignal(8000),
        });
        if (res?.ok && typeof res.arrayBuffer === "function") {
          const buf = await res.arrayBuffer();
          const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
          if (bytes && bytes.length) return { ok: true, bytes, mimeType: "image/png", provider: "huggingface" };
        }
      } catch {}
    }
  } catch {}

  try {
    let visualForUrl = visual;
    if (PERSIAN_RE.test(visualForUrl)) visualForUrl = visualForUrl.replace(/[\u0600-\u06FF\u200C\u200D]+/g, " ").replace(/\s+/g, " ").trim() || "abstract colorful art";
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(visualForUrl)}?width=768&height=768&nologo=true`;
    const res = await fn(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "image/*" }, signal: timeoutSignal(10000) });
    if (res?.ok) {
      const buf = await res.arrayBuffer();
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      if (bytes && bytes.length) return { ok: true, bytes, mimeType: "image/jpeg", provider: "pollinations" };
    }
  } catch {}
  return { ok: false, error: "image_gen_failed" };
}

export function isImageEditCaption(caption) {
  const s = String(caption ?? "").trim();
  if (!s) return false;
  if (/^\s*(ویرایش\s*عکس|ویرایش|ادیت)\s*[:：-]/u.test(s)) return true;
  if (/^(ویرایش|ادیت)\s+/.test(s)) return true;
  const markers = ["ویرایش عکس", "ادیت", "ویرایش کن", "ادیت کن", "پس‌زمینه", "پسزمینه", "کارتونی کن", "کارتونی", "تغییر بده", "نور عکس", "بهتر کن", "حذف کن", "تغییر بده", "اصلاح کن"];
  return markers.some((m) => s.includes(m));
}

export async function editImage(env, opts = {}) {
  const imageBytes = opts.imageBytes ?? opts.bytes ?? null;
  const mimeType = opts.mimeType || "image/jpeg";
  const instruction = String(opts.instruction ?? "").trim();
  const userId = opts.userId ?? null;
  const fn = resolveFetch(opts);
  if (!imageBytes || !instruction || typeof fn !== "function") return { ok: false, reason: "نیاز به تنظیم کلید GEMINI_API_KEY یا HF_TOKEN در /setup برای ویرایش تصویر است." };

  try {
    const geminiKey = await resolveKey(env, userId, "gemini", "GEMINI_API_KEY");
    if (geminiKey) {
      try {
        const b64 = bytesToB64(imageBytes);
        const res = await fn(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${geminiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: instruction }, { inlineData: { mimeType, data: b64 } }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
          }),
        });
        if (res?.ok) {
          const json = await safeJson(res);
          const outB64 = extractGeminiImage(json);
          const bytes = outB64 ? b64ToBytes(outB64) : null;
          if (bytes && bytes.length) return { ok: true, bytes, mimeType: "image/png", provider: "gemini-edit" };
        }
      } catch {}
    }
  } catch {}

  try {
    const hfKey = await resolveKey(env, userId, "huggingface", "HF_TOKEN");
    if (hfKey) {
      try {
        const res = await fn("https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${hfKey}`, Accept: "image/png" },
          body: JSON.stringify({ inputs: instruction, image: bytesToB64(imageBytes) }),
        });
        if (res?.ok && typeof res.arrayBuffer === "function") {
          const buf = await res.arrayBuffer();
          const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
          if (bytes && bytes.length) return { ok: true, bytes, mimeType: "image/png", provider: "huggingface-edit" };
        }
      } catch {}
    }
  } catch {}

  return { ok: false, reason: "نیاز به تنظیم کلید GEMINI_API_KEY یا HF_TOKEN در /setup برای ویرایش تصویر است." };
}

export async function analyzeImage(env, opts = {}) {
  const imageBytes = opts.imageBytes ?? opts.bytes ?? null;
  const mimeType = opts.mimeType || "image/jpeg";
  const prompt = String(opts.prompt ?? "این تصویر را به فارسی تحلیل کن.").trim() || "این تصویر را به فارسی تحلیل کن.";
  const userId = opts.userId ?? null;
  const fn = resolveFetch(opts);
  const routerCallFn = opts.routerCallFn ?? null;
  if (!imageBytes) return { ok: false, error: "image_gen_failed", text: "تحلیل تصویر ممکن نشد؛ هیچ تصویری دریافت نشد." };

  try {
    const geminiKey = await resolveKey(env, userId, "gemini", "GEMINI_API_KEY");
    if (geminiKey && typeof fn === "function") {
      const b64 = bytesToB64(imageBytes);
      const geminiSignal = geminiKey.startsWith("AIza") ? undefined : timeoutSignal(4000);
      for (const model of ["gemini-2.5-flash", "gemini-2.0-flash"]) {
        try {
          const res = await fn(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: b64 } }] }],
            }),
            signal: geminiSignal,
          });
          if (res?.ok) {
            const json = await safeJson(res);
            const text = (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
            if (text) return { ok: true, text };
          }
        } catch {}
      }
    }
  } catch {}

  try {
    const nvidiaKey = await resolveKey(env, userId, "nvidia", "NVIDIA_API_KEY");
    if (nvidiaKey && typeof fn === "function") {
      const b64 = bytesToB64(imageBytes);
      const dataUri = `data:${mimeType || "image/jpeg"};base64,${b64}`;
      for (const model of ["meta/llama-3.2-90b-vision-instruct", "nvidia/nemotron-3.5-super-vl-120b-a12b"]) {
        try {
          const res = await fn("https://integrate.api.nvidia.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${nvidiaKey}` },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: [
                { type: "text", text: "به فارسی دقیق به این سوال درباره تصویر پاسخ بده: " + prompt },
                { type: "image_url", image_url: { url: dataUri } },
              ] }],
              max_tokens: 600,
            }),
            signal: timeoutSignal(12000),
          });
          if (res?.ok) {
            const json = await safeJson(res);
            const text = json?.choices?.[0]?.message?.content;
            if (typeof text === "string" && text.trim()) return { ok: true, text: text.trim() };
          }
        } catch {}
      }
    }
  } catch {}

  if (typeof routerCallFn === "function") {
    try {
      const b64 = bytesToB64(imageBytes);
      const dataUri = `data:${mimeType};base64,${b64}`;
      const models = ["vision", "nvidia/nemotron-3.5-super-vl-120b-a12b", "qwen/qwen3.8-omni-flash:free", "meta/llama-3.2-90b-vision-instruct"];
      for (const model of models) {
        try {
          const body = {
            model,
            messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUri } }, { type: "text", text: prompt }] }],
          };
          const out = await routerCallFn(body);
          let text = "";
          if (typeof out === "string") text = out.trim();
          else if (out && typeof out === "object") {
            text = out.text || out.finalText || out.answer || out?.data?.choices?.[0]?.message?.content || out?.data?.message?.content || "";
            if (typeof text !== "string") text = String(text ?? "").trim();
          }
          if (text && String(text).trim()) return { ok: true, text: String(text).trim() };
        } catch {}
      }
    } catch {}
  }

  return { ok: false, text: "تحلیل تصویر ممکن نشد؛ کلید GEMINI_API_KEY تنظیم نشده و مدل vision هم در دسترس نیست.", error: "vision_unavailable" };
}

export function isVisionQuestionCaption(caption) {
  const s = String(caption ?? "").trim();
  if (!s) return false;
  if (s.endsWith("?") || s.endsWith("؟")) return true;
  const markers = ["این چیه", "چی نوشته", "ترجمه", "توضیح بده", "تحلیل کن", "تفسیر کن", "تفسیر", "فیش", "فاکتور", "کیلومتر", "متن داخل عکس", "متن عکس", "چنده", "چیست", "بخون", "بخوان", "توضیح", "خلاصه", "بررسی", "OCR", "بگو چیه", "تحلیل"];
  return markers.some((m) => s.includes(m));
}
