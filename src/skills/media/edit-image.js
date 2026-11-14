import { isConnectorSecretError } from "../../connectors.js";
import { resolveKey, safeJson, PERSIAN_RE, b64ToBytes, bytesToB64, connectorDiag, resolveFetch, extractGeminiImage } from "./helpers.js";
import { createDeadline, toEnglishImagePrompt } from "./deadline-translate.js";
import { isVisionQuestionCaption } from "./vision-core.js";

export function isImageEditCaption(caption) {
  const s = String(caption ?? "").trim();
  if (!s || isVisionQuestionCaption(s)) return false;
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
  const budget = createDeadline();
  let secretError = null;
  if (!imageBytes || !instruction || typeof fn !== "function") return { ok: false, reason: "نیاز به تنظیم کلید GEMINI_API_KEY یا HF_TOKEN در /setup برای ویرایش تصویر است." };

  try {
    const geminiKey = await resolveKey(env, userId, "gemini", "GEMINI_API_KEY");
    if (geminiKey) {
      try {
        const b64 = bytesToB64(imageBytes);
        const res = await fn("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: instruction }, { inlineData: { mimeType, data: b64 } }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
          }),
          signal: budget.signal(10000),
        });
        if (res?.ok) {
          const json = await safeJson(res);
          const outB64 = extractGeminiImage(json);
          const bytes = outB64 ? b64ToBytes(outB64) : null;
          if (bytes && bytes.length) return { ok: true, bytes, mimeType: "image/png", provider: "gemini-edit" };
        }
      } catch {}
    }
  } catch (e) { if (isConnectorSecretError(e)) secretError = e; }

  try {
    const hfKey = await resolveKey(env, userId, "huggingface", "HF_TOKEN");
    if (hfKey) {
      try {
        const res = await fn("https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${hfKey}`, Accept: "image/png" },
          body: JSON.stringify({ inputs: instruction, image: bytesToB64(imageBytes) }),
          signal: budget.signal(10000),
        });
        if (res?.ok && typeof res.arrayBuffer === "function") {
          const buf = await res.arrayBuffer();
          const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
          if (bytes && bytes.length) return { ok: true, bytes, mimeType: "image/png", provider: "huggingface-edit" };
        }
      } catch {}
    }
  } catch (e) { if (isConnectorSecretError(e)) secretError = e; }

  return { ok: false, reason: "نیاز به تنظیم کلید GEMINI_API_KEY یا HF_TOKEN در /setup برای ویرایش تصویر است.", ...(secretError ? { error: "connector_secret_unavailable", reasonCode: secretError.reason || "error" } : {}) };
}

