import { resolveKey, safeJson, PERSIAN_RE, b64ToBytes, bytesToBase64, resolveFetch } from "./helpers.js";
import { createDeadline } from "./deadline-translate.js";
import { GEMINI_VISION_MODELS } from "../../platform/gemini-models.js";

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

export const VISION_UNAVAILABLE_TEXT = "❌ تحلیل تصویر الان ممکن نشد. کمی بعد دوباره امتحان کن.";

const GEMINI_ATTEMPT_MS = 12000;
const VISION_TOTAL_MS = 25000;

export async function analyzeImage(env, opts = {}) {
  const imageBytes = opts.imageBytes ?? opts.bytes ?? null;
  const mimeType = opts.mimeType || "image/jpeg";
  const prompt = String(opts.prompt ?? "این تصویر را به فارسی تحلیل کن.").trim() || "این تصویر را به فارسی تحلیل کن.";
  const visionPrompt = `${VISION_PERSIAN_INSTRUCTION}\n${prompt}`;
  const userId = opts.userId ?? null;
  const fn = resolveFetch(opts);
  const errors = [];
  if (!imageBytes) {
    const text = "تحلیل تصویر ممکن نشد؛ هیچ تصویری دریافت نشد.";
    return { ok: false, error: "no_image", text, userText: text };
  }
  const b64 = bytesToBase64(imageBytes);
  const budget = createDeadline(VISION_TOTAL_MS);

  let geminiKey = null;
  try {
    geminiKey = await resolveKey(env, userId, "gemini", "GEMINI_API_KEY");
  } catch {
    geminiKey = null;
  }
  if (!geminiKey) {
    const text = "تحلیل تصویر ممکن نشد؛ کلید GEMINI_API_KEY تنظیم نشده و مدل vision هم در دسترس نیست.";
    return { ok: false, error: "vision_unavailable: no_key", text, userText: text };
  }

  if (typeof fn === "function") {
    for (const model of GEMINI_VISION_MODELS) {
      try {
        const res = await fn(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: visionPrompt }, { inlineData: { mimeType, data: b64 } }] }],
          }),
          signal: budget.signal(GEMINI_ATTEMPT_MS),
        });
        if (res?.ok) {
          const json = await safeJson(res);
          const text = (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
          const cleaned = cleanVisionPersianText(text);
          if (cleaned) return { ok: true, text: cleaned };
          errors.push(`${model}:empty`);
        } else {
          errors.push(`${model}:${res?.status || "not_ok"}`);
        }
      } catch (e) {
        const code = e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : "error";
        errors.push(`${model}:${code}`);
      }
    }
  } else {
    errors.push("no_fetch");
  }

  console.warn("vision_failed", { reasons: errors });
  return {
    ok: false,
    error: "vision_unavailable: " + errors.join("; "),
    text: VISION_UNAVAILABLE_TEXT,
    userText: VISION_UNAVAILABLE_TEXT,
  };
}

export function isVisionQuestionCaption(caption) {
  const s = String(caption ?? "").trim();
  if (!s) return false;
  if (s.endsWith("?") || s.endsWith("؟")) return true;
  const markers = ["این چیه", "چیه", "چی نوشته", "ترجمه", "توضیح بده", "تحلیل کن", "تفسیر کن", "تفسیر", "فیش", "فاکتور", "کیلومتر", "متن داخل عکس", "متن عکس", "چنده", "چیست", "بخون", "بخوان", "توضیح", "خلاصه", "بررسی", "OCR", "بگو چیه", "تحلیل"];
  return markers.some((m) => s.includes(m));
}
