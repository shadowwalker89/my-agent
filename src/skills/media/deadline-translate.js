import { resolveKey, safeJson, PERSIAN_RE, timeoutSignal, connectorDiag, resolveFetch, IMAGE_USER_AGENT } from "./helpers.js";

export function createDeadline(budgetMs = 22000) {
  const end = Date.now() + budgetMs;
  return {
    remaining() { return Math.max(0, end - Date.now()); },
    signal(stepMaxMs) { return timeoutSignal(Math.max(500, Math.min(stepMaxMs, this.remaining()))); },
  };
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
export async function toEnglishImagePrompt(env, userId, prompt, fn, opts = {}, budget = createDeadline()) {
  if (!PERSIAN_RE.test(prompt)) return prompt;
  // Primary fast translator: free, no key, broad Persian vocabulary. This
  // must run before any LLM fallback so unknown names/objects are never
  // dropped from the prompt.
  if (typeof fn === "function") {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=fa&tl=en&dt=t&q=${encodeURIComponent(prompt)}`;
      const res = await fn(url, { method: "GET", signal: budget.signal(2500) });
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
              signal: budget.signal(4000),
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
    try {
      const key = await resolveKey(env, userId, "gemini", "GEMINI_API_KEY");
      if (key) {
        try {
          const res = await fn("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: `Translate this image prompt into concise English for an image model. Return only the English prompt, no quotes:\n${prompt}` }] }],
              generationConfig: { temperature: 0.2, maxOutputTokens: 120 },
            }),
            signal: budget.signal(4000),
          });
          if (res?.ok) {
            const json = await safeJson(res);
            const text = (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(" ").trim();
            if (text && !PERSIAN_RE.test(text)) return text;
          }
        } catch {}
      }
    } catch {}
  }
  return fallbackEnglishPrompt(prompt);
}

// Tier 3: HuggingFace ZeroGPU official FLUX.1-schnell Gradio Space. Free,
// no key, genuine FLUX.1 on H200. Gradio uses an async call/SSE protocol:
// POST returns an event_id, then GET streams events until "complete".
export async function generateViaHfFluxSpace(englishPrompt, fetchFn, seed = 0, budget = createDeadline()) {
  const diagErrors = [];
  const base = "https://black-forest-labs-flux-1-schnell.hf.space";
  const body = JSON.stringify({ data: [englishPrompt, Number(seed) || 0, true, 1024, 1024, 4] });
  const postInfer = (url) => fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: budget.signal(12000),
  });
  try {
    let callPath = "/gradio_api/call/infer";
    let post = await postInfer(`${base}${callPath}`);
    if (post?.status === 404) {
      callPath = "/call/infer";
      post = await postInfer(`${base}${callPath}`);
    }
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
    const sse = await fetchFn(`${base}${callPath}/${eventId}`, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal: budget.signal(12000),
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
    const img = await fetchFn(imageUrl, { method: "GET", signal: budget.signal(12000) });
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

