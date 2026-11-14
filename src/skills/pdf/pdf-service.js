import { resolveKey, safeJson, chatText, bytesToB64, SCANNED_PDF_MESSAGE } from "./pdf-helpers.js";
import { extractTextFromPdfBytes } from "./pdf-extract-text.js";

export async function analyzePdfDocument(env, opts = {}) {
  const pdfBytes = opts.pdfBytes instanceof Uint8Array ? opts.pdfBytes : new Uint8Array(opts.pdfBytes || []); const prompt = String(opts.prompt ?? "").trim() || "این پی‌دی‌اف را به فارسی خلاصه و معرفی کن.";
  const userId = opts.userId ?? null; const fn = opts.fetchFn || (typeof fetch === "function" ? fetch : null);
  if (!pdfBytes?.length) return { ok: false, error: "متن قابل استخراج نیست" };
  const key = await resolveKey(env, userId, "gemini", "GEMINI_API_KEY");
  if (key && typeof fn === "function") { const b64 = bytesToB64(pdfBytes); const full = prompt + "\nلطفاً این PDF را به فارسی خلاصه/ترجمه کن، سؤال کاربر را دقیق پاسخ بده و خلاصه فارسی روان تحویل بده.";
    for (const model of ["gemini-2.5-flash", "gemini-2.0-flash"]) { try { const res = await fn("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + key, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: full }, { inlineData: { mimeType: "application/pdf", data: b64 } }] }] }) }); if (res?.ok) { const js = await safeJson(res); const text = (js?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim(); if (text) return { ok: true, text }; } } catch {} }
  }
  const ext = await extractTextFromPdfBytes(pdfBytes); if (!ext) return { ok: false, error: "متن قابل استخراج نیست" };
  if (ext === SCANNED_PDF_MESSAGE) return { ok: true, text: SCANNED_PDF_MESSAGE };
  const chatFn = opts.chatFn || opts.chat || null; const router = opts.routerCallFn || null; const full2 = prompt + "\n\nمتن استخراج‌شده از PDF:\n" + ext.slice(0, 8000) + "\n\nپاسخ را به فارسی روان، خلاصه و دقیق بده.";
  if (typeof chatFn === "function") { try { const out = await chatFn(full2, { saveText: "", noHistory: true }); const t = chatText(out); if (t) return { ok: true, text: t }; } catch {} }
  if (typeof router === "function") { try { const out3 = await router({ model: "chat", messages: [{ role: "user", content: full2 }] }); const t3 = chatText(out3); if (t3) return { ok: true, text: t3 }; } catch {} }
  return { ok: true, text: ext.slice(0, 8000) };
}
