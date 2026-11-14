import { resolveKey, safeJson, PERSIAN_RE, b64ToBytes, bytesToBase64, connectorDiag, resolveFetch } from "./helpers.js";
import { createDeadline } from "./deadline-translate.js";

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
  const budget = createDeadline();

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
        for (const model of ["gemini-2.5-flash", "gemini-2.0-flash"]) {
          try {
            const res = await fn(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
              body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: visionPrompt }, { inlineData: { mimeType, data: b64 } }] }],
              }),
              signal: budget.signal(8000),
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
    } catch (e) { errors.push(connectorDiag("gemini", e)); }

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
                  { type: "text", text: visionPrompt },
                  { type: "image_url", image_url: { url: dataUri } },
                ] }],
                max_tokens: 600,
              }),
              signal: budget.signal(12000),
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
    } catch (e) { errors.push(connectorDiag("nvidia", e)); }
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
