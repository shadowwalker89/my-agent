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

function bytesToB64(bytes) {
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
  if (Array.isArray(json) && json[0]) {
    const b = json[0]?.base64 || json[0]?.image || json[0]?.data;
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

const FA_IMAGE_WORDS = [
  ["آینده‌نگر", "futuristic"], ["آینده نگر", "futuristic"], ["آینده", "futuristic"],
  ["خودروی", "car"], ["خودرو", "car"], ["ماشین", "car"],
  ["خیابان‌های", "streets"], ["خیابان های", "streets"], ["خیابان", "street"],
  ["تهران", "Tehran"], ["عکس", "image"], ["تصویر", "image"],
  ["سگ", "dog"], ["گربه", "cat"], ["اسب", "horse"], ["پرنده", "bird"], ["ماهی", "fish"],
  ["درخت", "tree"], ["جنگل", "forest"], ["کوه", "mountain"], ["دریا", "sea"], ["آسمان", "sky"],
  ["شهر", "city"], ["روستا", "village"], ["خانه", "house"], ["مرد", "man"], ["زن", "woman"],
  ["دختر", "girl"], ["پسر", "boy"], ["کودک", "child"], ["غذا", "food"], ["قهوه", "coffee"],
  ["گل", "flower"], ["رنگارنگ", "colorful"], ["زیبا", "beautiful"], ["بزرگ", "big"], ["کوچک", "small"],
  ["شب", "night"], ["روز", "day"], ["غروب", "sunset"], ["طلوع", "sunrise"], ["باران", "rain"], ["برف", "snow"],
];
function fallbackEnglishPrompt(prompt) {
  let s = String(prompt || "");
  if (!PERSIAN_RE.test(s)) return s.trim() || "abstract colorful digital art";
  for (const [fa, en] of FA_IMAGE_WORDS) s = s.split(fa).join(" " + en + " ");
  s = s.replace(/[\u0600-\u06FF\u200C\u200D]+/g, " ").replace(/[^\x20-\x7E]+/g, " ").replace(/\s+/g, " ").trim();
  return s || "abstract colorful digital art";
}

// Pollinations and several free endpoints block non-browser user agents from
// Workers, and Persian prompts generate poorly. Translate to English via a
// caller-supplied translateFn, NVIDIA (the preferred live key), or Gemini.
// If translation fails, a built-in dictionary fallback guarantees the image
// providers never receive raw Persian characters.
function acceptEnglish(t) { return typeof t === "string" && t.trim() && !PERSIAN_RE.test(t); }
function outText(out) {
  if (typeof out === "string") return out;
  if (out && typeof out === "object") {
    const t = out.text || out.finalText || out.answer || out?.data?.choices?.[0]?.message?.content || out?.data?.message?.content || "";
    if (typeof t === "string") return t;
  }
  return "";
}
async function toEnglishImagePrompt(env, userId, prompt, fn, opts = {}) {
  if (!PERSIAN_RE.test(prompt)) return prompt;
  if (typeof opts.translateFn === "function") {
    try { const t = await opts.translateFn(prompt); if (acceptEnglish(t)) return t.trim(); } catch {}
  }
  // Prefer the router's low-latency combos for a detailed cinematic prompt.
  if (typeof opts.routerCallFn === "function") {
    for (const model of ["fast", "chat"]) {
      try {
        const out = await opts.routerCallFn({
          model,
          messages: [{ role: "user", content: `Translate this image prompt into a detailed, cinematic English prompt for a photorealistic image model. Return only the English prompt, no quotes:\n${prompt}` }],
        });
        const t = outText(out);
        if (acceptEnglish(t)) return t.trim();
      } catch {}
    }
  }
  if (typeof fn === "function") {
    try {
      const nvidiaKey = await resolveKey(env, userId, "nvidia", "NVIDIA_API_KEY");
      if (nvidiaKey) {
        for (const model of ["meta/llama-3.1-70b-instruct", "qwen/qwen2.5-72b-instruct"]) {
          try {
            const res = await fn("https://integrate.api.nvidia.com/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${nvidiaKey}` },
              body: JSON.stringify({ model, messages: [{ role: "user", content: `Translate this image prompt into a detailed, cinematic English prompt for a photorealistic image model. Return only the English prompt, no quotes:\n${prompt}` }], max_tokens: 160, temperature: 0.2 }),
              signal: timeoutSignal(4000),
            });
            if (res?.ok) {
              const json = await safeJson(res);
              const text = json?.choices?.[0]?.message?.content;
              if (acceptEnglish(text)) return text.trim();
            }
          } catch {}
        }
      }
    } catch {}
    const key = await resolveKey(env, userId, "gemini", "GEMINI_API_KEY");
    if (key) {
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
        if (res?.ok) {
          const json = await safeJson(res);
          const text = (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(" ").trim();
          if (text && !PERSIAN_RE.test(text)) return text;
        }
      } catch {}
    }
  }
  return fallbackEnglishPrompt(prompt);
}

export async function generateFreeImage(env, prompt, opts = {}) {
  const clean = String(prompt ?? "").trim();
  const diagErrors = [];
  if (!clean) return { ok: false, error: "image_gen_failed", diagErrors };
  const fn = resolveFetch(opts);
  const userId = opts.userId ?? null;
  if (typeof fn !== "function") return { ok: false, error: "image_gen_failed", diagErrors: ["fetch_unavailable"] };
  const translated = await toEnglishImagePrompt(env, userId, clean, fn, opts);
  const visualBase = PERSIAN_RE.test(translated) ? fallbackEnglishPrompt(translated) : translated;
  const visual = /^(?:photorealistic|cinematic|hyperrealistic|ultra[- ]?detailed)/i.test(visualBase)
    ? visualBase
    : `Photorealistic, high detail, 8k, no watermark: ${visualBase}`;

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
          diagErrors.push("together:empty");
        } else {
          diagErrors.push("together:" + (res?.status || "not_ok"));
        }
      } catch (e) { diagErrors.push("together:" + (e?.message || "error")); }
    }
  } catch (e) { diagErrors.push("together:" + (e?.message || "error")); }

  try {
    const nvidiaKey = await resolveKey(env, userId, "nvidia", "NVIDIA_API_KEY");
    if (nvidiaKey) {
      const tryNvidia = async (url, body, label) => {
        try {
          const res = await fn(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${nvidiaKey}`, Accept: "application/json" },
            body: JSON.stringify(body),
            signal: timeoutSignal(8000),
          });
          if (res?.ok) {
            const json = await safeJson(res);
            const b64 = extractNvidiaImage(json);
            const bytes = b64 ? b64ToBytes(b64) : null;
            if (bytes && bytes.length) return { bytes, status: res?.status || 200 };
            diagErrors.push(label + ":empty");
          } else {
            diagErrors.push(label + ":" + (res?.status || "not_ok"));
          }
          return { bytes: null, status: res?.status || null };
        } catch (e) { diagErrors.push(label + ":" + (e?.message || "error")); return { bytes: null, status: null }; }
      };
      // SD3 accepts the full schema. FLUX.1-schnell rejects width/height with
      // HTTP 422, so send the minimal body and retry prompt-only on 422.
      let nbytes = (await tryNvidia("https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-3-medium", { prompt: visual, cfg_scale: 5, aspect_ratio: "1:1", seed: 0, steps: 30, negative_prompt: "watermark, text, logo, blurry, low quality, deformed" }, "nvidia-sd3")).bytes;
      if (!nbytes) {
        let flux = await tryNvidia("https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell", { prompt: visual, steps: 4, seed: 0 }, "nvidia-flux");
        if (!flux.bytes && flux.status === 422) flux = await tryNvidia("https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell", { prompt: visual }, "nvidia-flux-min");
        nbytes = flux.bytes;
      }
      if (nbytes) return { ok: true, bytes: nbytes, mimeType: "image/png", provider: "nvidia" };
    }
  } catch (e) { diagErrors.push("nvidia:" + (e?.message || "error")); }

  try {
    const geminiKey = await resolveKey(env, userId, "gemini", "GEMINI_API_KEY");
    if (geminiKey && geminiKey.startsWith("AIza")) {
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
          diagErrors.push("gemini:empty");
        } else {
          diagErrors.push("gemini:" + (res?.status || "not_ok"));
        }
      } catch (e) { diagErrors.push("gemini:" + (e?.message || "error")); }
    }
  } catch (e) { diagErrors.push("gemini:" + (e?.message || "error")); }

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
          diagErrors.push("huggingface:empty");
        } else {
          diagErrors.push("huggingface:" + (res?.status || "not_ok"));
        }
      } catch (e) { diagErrors.push("huggingface:" + (e?.message || "error")); }
    }
  } catch (e) { diagErrors.push("huggingface:" + (e?.message || "error")); }

  try {
    const englishPrompt = PERSIAN_RE.test(visual) ? fallbackEnglishPrompt(visual) : visual;
    const seed = Number.isFinite(Number(opts.seed)) ? Math.floor(Number(opts.seed)) : Math.floor(Math.random() * 1e9);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(englishPrompt)}?model=flux&width=1024&height=1024&nologo=true&private=true&enhance=true&seed=${seed}`;
    const res = await fn(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Accept: "image/*",
        Referer: "https://pollinations.ai/",
      },
      redirect: "follow",
      signal: timeoutSignal(10000),
    });
    if (res?.ok) {
      const buf = await res.arrayBuffer();
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      if (bytes && bytes.length) return { ok: true, bytes, mimeType: "image/jpeg", provider: "pollinations" };
      diagErrors.push("pollinations:empty");
    } else {
      diagErrors.push("pollinations:" + (res?.status || "not_ok"));
    }
  } catch (e) { diagErrors.push("pollinations:" + (e?.message || "error")); }

  return { ok: false, error: "image_gen_failed", diagErrors };
}

export function isImageEditCaption(caption) {
  const s = String(caption ?? "").trim();
  if (!s) return false;
  if (/^\s*(ویرایش\s*عکس|ویرایش|ادیت)\s*[:：-]/u.test(s)) return true;
  if (/^(ویرایش|ادیت)\s+/.test(s)) return true;
  const markers = ["ویرایش عکس", "ادیت", "ویرایش کن", "ادیت کن", "پس‌زمینه", "پسزمینه", "کارتونی کن", "کارتونی", "تغییر بده", "تغییر", "نور عکس", "بهتر کن", "حذف کن", "حذف", "کم کن", "اضافه کن", "عوض کن", "اصلاح کن", "رنگ", "رنگش", "قرمز", "آبی", "سبز", "زرد", "بلندتر", "بلند تر", "کوتاه‌تر", "کوتاه تر", "بزرگ‌تر", "بزرگ تر", "کوچک‌تر", "کوچک تر", "روشن‌تر", "روشن تر", "تیره‌تر", "تیره تر", "تبدیل کن", "color", "recolor", "change", "modify"];
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

export const VISION_PERSIAN_INSTRUCTION =
  "فقط پاسخ نهایی را به زبان فارسی روان و طبیعی بنویس. هرگز به انگلیسی فکر نکن، عبارت _IMAGE_ یا wait ننویس و از کلمات فرانسوی/انگلیسی وسط فارسی استفاده نکن.";

export function cleanVisionPersianText(raw) {
  let s = String(raw ?? "");
  if (!s.trim()) return "";
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, " ");
  s = s.replace(/_IMAGE_/g, " ");
  s = s.replace(/\.\.\.\s*wait,\s*let me look[\s\S]*?(?=\n\n[\u0600-\u06FF]|$)/gi, " ");
  s = s.replace(/\bwait,\s*let me look[^\n]*/gi, " ");
  s = s.replace(/(?:,\s*)?[}\]]{2,}\]?/g, " ");
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

export async function analyzeImage(env, opts = {}) {
  const imageBytes = opts.imageBytes ?? opts.bytes ?? null;
  const mimeType = opts.mimeType || "image/jpeg";
  const prompt = String(opts.prompt ?? "این تصویر را به فارسی تحلیل کن.").trim() || "این تصویر را به فارسی تحلیل کن.";
  const visionPrompt = `${VISION_PERSIAN_INSTRUCTION}\n${prompt}`;
  const userId = opts.userId ?? null;
  const fn = resolveFetch(opts);
  const routerCallFn = opts.routerCallFn ?? null;
  const errors = [];
  if (!imageBytes) return { ok: false, error: "no_image", text: "تحلیل تصویر ممکن نشد؛ هیچ تصویری دریافت نشد." };
  const b64 = bytesToBase64(imageBytes);
  const dataUri = `data:${mimeType || "image/jpeg"};base64,${b64}`;

  if (typeof routerCallFn === "function") {
    try {
      const body = {
        model: "vision",
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUri } }, { type: "text", text: visionPrompt }] }],
      };
      const out = await routerCallFn(body);
      let text = "";
      if (typeof out === "string") text = out.trim();
      else if (out && typeof out === "object") {
        text = out.text || out.finalText || out.answer || out?.data?.choices?.[0]?.message?.content || out?.data?.message?.content || "";
        if (typeof text !== "string") text = String(text ?? "").trim();
      }
      const cleaned = cleanVisionPersianText(text);
      if (cleaned) return { ok: true, text: cleaned };
      errors.push("router:empty");
    } catch (e) { errors.push("router:" + (e?.message || "error")); }
  }

  if (typeof fn === "function") {
    try {
      const geminiKey = await resolveKey(env, userId, "gemini", "GEMINI_API_KEY");
      if (geminiKey) {
        const geminiSignal = geminiKey.startsWith("AIza") ? undefined : timeoutSignal(4000);
        for (const model of ["gemini-2.5-flash", "gemini-2.0-flash"]) {
          try {
            const res = await fn(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: visionPrompt }, { inlineData: { mimeType, data: b64 } }] }],
              }),
              signal: geminiSignal,
            });
            if (res?.ok) {
              const json = await safeJson(res);
              const text = (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
              const cleaned = cleanVisionPersianText(text);
              if (cleaned) return { ok: true, text: cleaned };
              errors.push(`gemini-${model}:empty`);
            } else {
              errors.push(`gemini-${model}:${res?.status || "not_ok"}`);
            }
          } catch (e) { errors.push(`gemini-${model}:` + (e?.message || "error")); }
        }
      }
    } catch (e) { errors.push("gemini:" + (e?.message || "error")); }

    try {
      const nvidiaKey = await resolveKey(env, userId, "nvidia", "NVIDIA_API_KEY");
      if (nvidiaKey) {
        for (const model of ["meta/llama-3.2-90b-vision-instruct", "meta/llama-3.2-11b-vision-instruct", "nvidia/nemotron-3.5-super-vl-120b-a12b"]) {
          try {
            const res = await fn("https://integrate.api.nvidia.com/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${nvidiaKey}` },
              body: JSON.stringify({
                model,
                messages: [{ role: "user", content: [
                  { type: "text", text: visionPrompt + "\nبه این سوال درباره تصویر پاسخ بده: " + prompt },
                  { type: "image_url", image_url: { url: dataUri } },
                ] }],
                max_tokens: 600,
              }),
              signal: timeoutSignal(12000),
            });
            if (res?.ok) {
              const json = await safeJson(res);
              const text = json?.choices?.[0]?.message?.content;
              const cleaned = cleanVisionPersianText(text);
              if (cleaned) return { ok: true, text: cleaned };
              errors.push(`nvidia-${model}:empty`);
            } else {
              errors.push(`nvidia-${model}:${res?.status || "not_ok"}`);
            }
          } catch (e) { errors.push(`nvidia-${model}:` + (e?.message || "error")); }
        }
      }
    } catch (e) { errors.push("nvidia:" + (e?.message || "error")); }
  }

  return {
    ok: false,
    text: "تحلیل تصویر ممکن نشد؛ کلید GEMINI_API_KEY تنظیم نشده و مدل vision هم در دسترس نیست.",
    error: errors.length ? "vision_unavailable: " + errors.join("; ") : "vision_unavailable",
  };
}

export function isVisionQuestionCaption(caption) {
  const s = String(caption ?? "").trim();
  if (!s) return false;
  if (s.endsWith("?") || s.endsWith("؟")) return true;
  const markers = ["این چیه", "چیه", "چی نوشته", "ترجمه", "توضیح بده", "تحلیل کن", "تفسیر کن", "تفسیر", "فیش", "فاکتور", "کیلومتر", "متن داخل عکس", "متن عکس", "چنده", "چیست", "بخون", "بخوان", "توضیح", "خلاصه", "بررسی", "OCR", "بگو چیه", "تحلیل"];
  return markers.some((m) => s.includes(m));
}
