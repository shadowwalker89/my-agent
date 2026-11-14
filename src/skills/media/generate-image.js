import { resolveKey, safeJson, PERSIAN_RE, b64ToBytes, connectorDiag, resolveFetch, extractGeminiImage, extractTogetherImage, extractNvidiaImage, extractPuterImage, IMAGE_USER_AGENT } from "./helpers.js";
import { createDeadline, toEnglishImagePrompt } from "./deadline-translate.js";

export async function generateFreeImage(env, prompt, opts = {}) {
  const clean = String(prompt ?? "").trim();
  const diagErrors = [];
  const budget = createDeadline();
  if (!clean) return { ok: false, error: "image_gen_failed", diagErrors };
  const fn = resolveFetch(opts);
  const userId = opts.userId ?? null;
  if (typeof fn !== "function") return { ok: false, error: "image_gen_failed", diagErrors: ["fetch_unavailable"] };
  const translated = await toEnglishImagePrompt(env, userId, clean, fn, opts, budget);
  const visualBase = PERSIAN_RE.test(translated) ? fallbackEnglishPrompt(translated) : translated;
  const visual = /^(?:photorealistic|cinematic|hyperrealistic|ultra[- ]?detailed)/i.test(visualBase)
    ? visualBase
    : `Photorealistic, high detail, 8k, no watermark: ${visualBase}`;

  const seed = Number.isFinite(Number(opts.seed)) ? Math.floor(Number(opts.seed)) : Math.floor(Math.random() * 1e9);

  // Tier 0: Puter AI free image generation (/setup puter <token>). Top-tier
  // because it fronts several strong models (Flux-2-Pro / Gemini-3-Image /
  // GPT-Image) behind one key with no per-model billing.
  try {
    const puterToken = await resolveKey(env, userId, "puter", "PUTER_API_TOKEN");
    if (puterToken) {
      for (const model of [
        "black-forest-labs/FLUX.1-schnell",
        "black-forest-labs/FLUX-2-pro",
        "google/gemini-3-image",
        "openai/gpt-image-1",
      ]) {
        if (budget.remaining() <= 0) break;
        try {
          const res = await fn("https://api.puter.com/drivers/call", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${puterToken}` },
            body: JSON.stringify({
              interface: "puter-image-generation",
              driver: "together",
              method: "generate",
              args: { prompt: visual, model },
            }),
            signal: budget.signal(12000),
          });
          if (res?.ok) {
            const json = await safeJson(res);
            const hit = extractPuterImage(json);
            let bytes = hit?.b64 ? b64ToBytes(hit.b64) : null;
            if (!bytes && hit?.url) {
              const img = await fn(hit.url, { method: "GET", signal: budget.signal(12000) });
              if (img?.ok && typeof img.arrayBuffer === "function") {
                const buf = await img.arrayBuffer();
                bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
              }
            }
            if (bytes && bytes.length) return { ok: true, bytes, mimeType: "image/png", provider: "puter", diagErrors };
            diagErrors.push("puter:empty");
          } else {
            diagErrors.push("puter:" + (res?.status || "not_ok"));
          }
        } catch (e) { diagErrors.push("puter:" + (e?.message || "error")); }
      }
    }
  } catch (e) { diagErrors.push(connectorDiag("puter", e)); }

  // Tier 1: configured Together AI / HuggingFace token (10s each).
  try {
    const togetherKey = await resolveKey(env, userId, "together", "TOGETHER_API_KEY");
    if (togetherKey) {
      try {
        const res = await fn("https://api.together.xyz/v1/images/generations", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${togetherKey}` },
          body: JSON.stringify({ model: "black-forest-labs/FLUX.1-schnell-Free", prompt: visual, width: 1024, height: 1024, n: 1, response_format: "b64_json" }),
          signal: budget.signal(10000),
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
  } catch (e) { diagErrors.push(connectorDiag("together", e)); }

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
            signal: budget.signal(10000),
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
  } catch (e) { diagErrors.push(connectorDiag("huggingface", e)); }

  // Tier 2: NVIDIA NIM parallel race. All 3 endpoints share one 11s
  // window (NVIDIA can take >5s to generate + transfer 1.5MB base64), and
  // the fastest working endpoint wins via Promise.any.
  try {
    const nvidiaKey = await resolveKey(env, userId, "nvidia", "NVIDIA_API_KEY");
    if (nvidiaKey) {
      const branchSignal = () => budget.signal(11000);
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
  } catch (e) { diagErrors.push(connectorDiag("nvidia", e)); }

  try {
    const geminiKey = await resolveKey(env, userId, "gemini", "GEMINI_API_KEY");
    if (geminiKey && geminiKey.startsWith("AIza")) {
      try {
        const res = await fn("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: visual }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
          }),
          signal: budget.signal(10000),
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
  } catch (e) { diagErrors.push(connectorDiag("gemini", e)); }

  // Tier 3: keyless HuggingFace ZeroGPU FLUX.1-schnell Space.
  try {
    const hfSpace = await generateViaHfFluxSpace(visual, fn, seed, budget);
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
        signal: budget.signal(timeoutMs),
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

