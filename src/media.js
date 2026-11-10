import { getConnectorSecret } from "./connectors.js";
import { getConfig } from "./config.js";

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
  // Creation verbs may end the sentence with punctuation. The image noun
  // may appear with or without "از", and tolerate common typos around it
  // ("به عکس", "ی عکس", "یک عکس", "عکسی").
  const verb = t.match(/(?:بساز|بکش|تولید[\s\u200C]+کن|درست[\s\u200C]+کن|طراحی[\s\u200C]+کن|بده)[.!؟?۔]*\s*$/u);
  if (!verb) return { isImageGen: false, prompt: "" };
  const before = t.slice(0, verb.index).trim();
  const noun = before.match(/(?:عکسی|عکس|تصویری|تصویر|نقاشی|پوستر|لوگو)/u);
  if (!noun) return { isImageGen: false, prompt: "" };
  let subject = before.slice(noun.index + noun[0].length).trim();
  subject = subject.replace(/^(?:از|را|رو)\s+/u, "").replace(/[\s،,؛;:：]+(?:را|رو)\s*$/u, "").trim();
  subject = subject.replace(/^(?:از|را|رو)\s+/u, "").trim();
  const p = cleanPrompt(subject);
  return p ? { isImageGen: true, prompt: p } : { isImageGen: false, prompt: "" };
}

async function resolveKey(env, userId, connectorId, fallbackEnvName) {
  try {
    const v = await getConnectorSecret(env, userId, connectorId);
    if (typeof v === "string" && v) return v;
  } catch {}
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
  // Primary fast translator: free, no key, broad Persian vocabulary. This
  // must run before any LLM fallback so unknown names/objects are never
  // dropped from the prompt.
  if (typeof fn === "function") {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=fa&tl=en&dt=t&q=${encodeURIComponent(prompt)}`;
      const res = await fn(url, { method: "GET", signal: timeoutSignal(2500) });
      if (res?.ok) {
        const data = await safeJson(res);
        const segments = Array.isArray(data?.[0])
          ? data[0].map((x) => (Array.isArray(x) ? x[0] : "")).filter(Boolean).join("")
          : "";
        if (acceptEnglish(segments)) return `${segments.trim()}, high resolution, detailed, photorealistic, 8k`;
      }
    } catch {}
  }
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

// Tier 3: HuggingFace ZeroGPU official FLUX.1-schnell Gradio Space. Free,
// no key, genuine FLUX.1 on H200. Gradio uses an async call/SSE protocol:
// POST returns an event_id, then GET streams events until "complete".
export async function generateViaHfFluxSpace(englishPrompt, fetchFn, seed = 0) {
  const diagErrors = [];
  const base = "https://black-forest-labs-flux-1-schnell.hf.space";
  const body = JSON.stringify({ data: [englishPrompt, Number(seed) || 0, true, 1024, 1024, 4] });
  const postInfer = (url) => fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: timeoutSignal(12000),
  });
  try {
    let post = await postInfer(`${base}/gradio_api/call/infer`);
    if (post?.status === 404) post = await postInfer(`${base}/call/infer`);
    if (!post?.ok) {
      diagErrors.push(`hf-space:${post?.status || "not_ok"}`);
      return { ok: false, diagErrors };
    }
    const meta = await safeJson(post);
    const eventId = meta?.event_id || meta?.eventId;
    if (!eventId) {
      diagErrors.push("hf-space:no_event_id");
      return { ok: false, diagErrors };
    }
    const sse = await fetchFn(`${base}/gradio_api/call/infer/${eventId}`, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal: timeoutSignal(12000),
    });
    if (!sse?.ok) {
      diagErrors.push(`hf-space:${sse?.status || "not_ok"}`);
      return { ok: false, diagErrors };
    }
    const raw = typeof sse.text === "function" ? await sse.text() : "";
    let completeData = null;
    for (const block of String(raw ?? "").split(/\r?\n\r?\n+/)) {
      if (!/event:\s*complete/i.test(block)) continue;
      const m = /data:\s*(.+)/.exec(block);
      if (m) { completeData = m[1].trim(); break; }
    }
    if (!completeData) {
      diagErrors.push("hf-space:no_complete");
      return { ok: false, diagErrors };
    }
    let parsed = null;
    try { parsed = JSON.parse(completeData); } catch {}
    const items = Array.isArray(parsed) ? parsed : [parsed];
    let imageUrl = null;
    for (const item of items) {
      const first = Array.isArray(item) ? item[0] : item;
      const u = first?.url || first?.path;
      if (typeof u === "string" && u) { imageUrl = u; break; }
    }
    if (!imageUrl) {
      diagErrors.push("hf-space:no_url");
      return { ok: false, diagErrors };
    }
    if (!/^https?:\/\//i.test(imageUrl)) imageUrl = `${base}${imageUrl.startsWith("/") ? "" : "/"}${imageUrl}`;
    const img = await fetchFn(imageUrl, { method: "GET", signal: timeoutSignal(12000) });
    if (!img?.ok || typeof img.arrayBuffer !== "function") {
      diagErrors.push(`hf-space-img:${img?.status || "not_ok"}`);
      return { ok: false, diagErrors };
    }
    const buf = await img.arrayBuffer();
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (!bytes.length) {
      diagErrors.push("hf-space:empty");
      return { ok: false, diagErrors };
    }
    return { ok: true, bytes, mimeType: "image/webp", provider: "hf-flux-space", diagErrors };
  } catch (e) {
    diagErrors.push("hf-space:" + (e?.message || "error"));
    return { ok: false, diagErrors };
  }
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

  const seed = Number.isFinite(Number(opts.seed)) ? Math.floor(Number(opts.seed)) : Math.floor(Math.random() * 1e9);

  // Tier 1: configured Together AI / HuggingFace token (10s each).
  try {
    const togetherKey = await resolveKey(env, userId, "together", "TOGETHER_API_KEY");
    if (togetherKey) {
      try {
        const res = await fn("https://api.together.xyz/v1/images/generations", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${togetherKey}` },
          body: JSON.stringify({ model: "black-forest-labs/FLUX.1-schnell-Free", prompt: visual, width: 1024, height: 1024, n: 1, response_format: "b64_json" }),
          signal: timeoutSignal(10000),
        });
        if (res?.ok) {
          const json = await safeJson(res);
          const b64 = extractTogetherImage(json);
          const bytes = b64 ? b64ToBytes(b64) : null;
          if (bytes && bytes.length) return { ok: true, bytes, mimeType: "image/png", provider: "together", diagErrors };
          diagErrors.push("together:empty");
        } else {
          diagErrors.push("together:" + (res?.status || "not_ok"));
        }
      } catch (e) { diagErrors.push("together:" + (e?.message || "error")); }
    }
  } catch (e) { diagErrors.push("together:" + (e?.message || "error")); }

  try {
    const hfKey = await resolveKey(env, userId, "huggingface", "HF_TOKEN");
    if (hfKey) {
      for (const url of [
        "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell",
        "https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell",
      ]) {
        try {
          const res = await fn(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${hfKey}`, Accept: "image/png" },
            body: JSON.stringify({ inputs: visual }),
            signal: timeoutSignal(10000),
          });
          if (res?.ok && typeof res.arrayBuffer === "function") {
            const buf = await res.arrayBuffer();
            const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
            if (bytes && bytes.length) return { ok: true, bytes, mimeType: "image/png", provider: "huggingface", diagErrors };
            diagErrors.push("huggingface:empty");
          } else {
            diagErrors.push("huggingface:" + (res?.status || "not_ok"));
          }
        } catch (e) { diagErrors.push("huggingface:" + (e?.message || "error")); }
      }
    }
  } catch (e) { diagErrors.push("huggingface:" + (e?.message || "error")); }

  // Tier 2: NVIDIA NIM parallel race. All 3 endpoints share one 11s
  // window (NVIDIA can take >5s to generate + transfer 1.5MB base64), and
  // the fastest working endpoint wins via Promise.any.
  try {
    const nvidiaKey = await resolveKey(env, userId, "nvidia", "NVIDIA_API_KEY");
    if (nvidiaKey) {
      const nvidiaDeadline = Date.now() + 11000;
      const branchSignal = () => timeoutSignal(Math.max(500, nvidiaDeadline - Date.now()));
      const nvidiaBranch = async (url, body, label) => {
        const res = await fn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${nvidiaKey}`, Accept: "application/json" },
          body: JSON.stringify(body),
          signal: branchSignal(),
        });
        if (!res || (res.status !== 200 && res.ok !== true)) {
          const json = await safeJson(res);
          const snippet = String(json?.error?.message || json?.error || json?.detail || json?.message || "").slice(0, 40) || "error";
          diagErrors.push(`${label}:${res?.status || "not_ok"}:${snippet}`);
          throw new Error(label);
        }
        const json = await safeJson(res);
        const b64 = json?.image || json?.artifacts?.[0]?.base64 || json?.data?.[0]?.b64_json;
        const bytes = b64 ? b64ToBytes(b64) : null;
        if (!bytes || !bytes.length) {
          diagErrors.push(`${label}:empty`);
          throw new Error(`${label}:empty`);
        }
        return bytes;
      };
      try {
        const bytes = await Promise.any([
          nvidiaBranch("https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell", { prompt: visual, width: 1024, height: 1024, seed: 0, steps: 4 }, "nvidia-flux"),
          nvidiaBranch("https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-3-medium", { prompt: visual, cfg_scale: 5, aspect_ratio: "1:1", seed: 0, steps: 28, negative_prompt: "" }, "nvidia-sd3"),
          nvidiaBranch("https://ai.api.nvidia.com/v1/genai/stabilityai/sdxl-turbo", { text_prompts: [{ text: visual, weight: 1 }], seed: 0, sampler: "K_EULER_ANCESTRAL", steps: 4 }, "nvidia-sdxl"),
        ]);
        if (bytes && bytes.length) return { ok: true, bytes, mimeType: "image/png", provider: "nvidia", diagErrors };
      } catch {}
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
          signal: timeoutSignal(10000),
        });
        if (res?.ok) {
          const json = await safeJson(res);
          const b64 = extractGeminiImage(json);
          const bytes = b64 ? b64ToBytes(b64) : null;
          if (bytes && bytes.length) return { ok: true, bytes, mimeType: "image/png", provider: "gemini", diagErrors };
          diagErrors.push("gemini:empty");
        } else {
          diagErrors.push("gemini:" + (res?.status || "not_ok"));
        }
      } catch (e) { diagErrors.push("gemini:" + (e?.message || "error")); }
    }
  } catch (e) { diagErrors.push("gemini:" + (e?.message || "error")); }

  // Tier 3: keyless HuggingFace ZeroGPU FLUX.1-schnell Space.
  try {
    const hfSpace = await generateViaHfFluxSpace(visual, fn, seed);
    if (hfSpace?.ok) return hfSpace;
    if (Array.isArray(hfSpace?.diagErrors)) diagErrors.push(...hfSpace.diagErrors);
  } catch (e) { diagErrors.push("hf-space:" + (e?.message || "error")); }

  try {
    const englishPrompt = PERSIAN_RE.test(visual) ? fallbackEnglishPrompt(visual) : visual;
    // No enhance/private flags: they made Pollinations hang and return
    // 502. Keep the exact fast URL shape that worked historically.
    const pollinationsAttempt = async (width, height, timeoutMs) => {
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(englishPrompt)}?width=${width}&height=${height}&nologo=true&seed=${seed}`;
      const res = await fn(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          Accept: "image/*",
          Referer: "https://pollinations.ai/",
        },
        redirect: "follow",
        signal: timeoutSignal(timeoutMs),
      });
      if (res?.ok) {
        const buf = await res.arrayBuffer();
        const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        if (bytes && bytes.length) return { ok: true, bytes, mimeType: "image/jpeg", provider: "pollinations", diagErrors };
        diagErrors.push("pollinations:empty");
      } else {
        diagErrors.push("pollinations:" + (res?.status || "not_ok"));
      }
      return null;
    };
    const big = await pollinationsAttempt(1024, 1024, 12000);
    if (big) return big;
    const small = await pollinationsAttempt(768, 768, 10000);
    if (small) return small;
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
