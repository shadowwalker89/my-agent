import {
  VOICE_MAX_DURATION_SEC,
  VOICE_LANGUAGE,
  VOICE_CUSTOM_VOCABULARY,
  VOICE_TOO_LONG_TEXT,
  VOICE_FAILED_TEXT,
} from "./voice-constants.js";
import { transcribeWithGemini } from "./voice-transcribe.js";

const VOICE_STASH_TTL_SEC = 3600;
function voiceStashKey(id) { return `voice:stash:${id}`; }
async function stashVoice(env, userId, fileId, mimeType) {
  if (!env.STATE || !fileId) return null;
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const mime = String(mimeType || "audio/ogg").split(";")[0].trim();
  try { await env.STATE.put(voiceStashKey(id), JSON.stringify({ owner: userId, file_id: fileId, mime_type: mime }), { expirationTtl: VOICE_STASH_TTL_SEC }); return id; } catch { return null; }
}
async function sendVoiceFailure(o, stashId, result) {
  // Fixed messages/codes only: a phone user can report the failure without logs.
  const status = result?.failure?.status;
  let text = VOICE_FAILED_TEXT;
  if (["telegram-info", "telegram-download"].includes(result?.failure?.stage)) text = "دریافت فایل صدا از تلگرام ناموفق بود؛ رونویسی هنوز شروع نشده است. دوباره تلاش کن. [VOICE-DOWNLOAD]";
  else if (status === 429) {
    const quota = result.failure.quota;
    const type = quota?.kind === "daily" ? "DAILY" : quota?.kind === "rate" ? "RATE" : "UNKNOWN";
    const stage = { upload: "UPLOAD", "file-poll": "FILE", interaction: "INTERACTION", generation: "GENERATION" }[result.failure.stage] ?? "GOOGLE";
    text = type === "DAILY" ? "گوگل اتمام سهمیهٔ روزانهٔ رونویسی را گزارش کرده؛ تلاش پیاپی کمکی نمی‌کند."
      : type === "RATE" ? "گوگل محدودیت نرخ درخواست رونویسی را گزارش کرده؛ کمی بعد دوباره تلاش کن."
      : "گوگل خطای محدودیت درخواست یا سهمیه داده؛ نوع محدودیت هنوز مشخص نیست.";
    if (quota?.scope === "project") text += " دامنهٔ محدودیت: پروژه.";
    else if (quota?.scope === "model") text += " دامنهٔ محدودیت: مدل.";
    if (quota?.retryAfterSeconds != null) text += ` زمان پیشنهادی سرویس برای تلاش مجدد: ${quota.retryAfterSeconds} ثانیه.`;
    text += ` [VOICE-429-${type}/${stage}]`;
  }
  else if ([500, 502, 503, 504].includes(status)) text = "سرویس رونویسی پاسخ موفق نداد؛ مشکل از نامفهوم بودن صدایت نیست. کمی بعد دوباره تلاش کن. [VOICE-SERVICE]";
  else if ([401, 403].includes(status)) text = "سرویس رونویسی اجازهٔ دسترسی نداد؛ تنظیمات اتصال باید بررسی شود. [VOICE-AUTH]";
  else if (result?.reason === "timeout" || result?.failure?.kind === "timeout") text = "مهلت پردازش صدا تمام شد؛ این به معنی نامفهوم بودن صدایت نیست. دوباره تلاش کن. [VOICE-TIMEOUT]";
  if (stashId) await o.send(text, { replyMarkup: { inline_keyboard: [[{ text: "🔄 ارسال مجدد", callback_data: `voice:retry:${stashId}` }]] } });
  else await o.send(text);
}
export async function handleVoiceRetry(env, o) {
  let rec = null;
  try { rec = env.STATE ? await env.STATE.get(voiceStashKey(o.stashId), "json") : null; } catch { rec = null; }
  if (!rec) { await o.send(VOICE_FAILED_TEXT); return "missing"; }
  if (Number(rec.owner) !== Number(o.userId)) return "forbidden";
  if (o.editMarkup) await o.editMarkup();
  const dl = await o.downloadTelegramVoice(env, rec.file_id);
  if (!dl.ok) { await sendVoiceFailure(o, o.stashId, dl); return "failed"; }
  const tr = await transcribeWithGemini(env, dl.bytes, rec.mime_type, o.transcribeOpts ?? {});
  if (!tr.ok) { await sendVoiceFailure(o, o.stashId, tr); return "failed"; }
  try { if (env.STATE) await env.STATE.delete(voiceStashKey(o.stashId)); } catch {}
  await o.route(tr.text);
  return "routed";
}
export async function handleVoice(env, o) {
  const voice = o.voice ?? {};
  const duration = Number(voice.duration);
  if (Number.isFinite(duration) && duration > VOICE_MAX_DURATION_SEC) { await o.send(VOICE_TOO_LONG_TEXT); return "too-long"; }
  const stashId = await stashVoice(env, o.userId, voice.file_id, voice.mime_type);
  const dl = await o.downloadTelegramVoice(env, voice.file_id);
  if (!dl.ok) { await sendVoiceFailure(o, stashId, dl); return "failed"; }
  const tr = await transcribeWithGemini(env, dl.bytes, voice.mime_type || "audio/ogg", o.transcribeOpts ?? {});
  if (!tr.ok) { await sendVoiceFailure(o, stashId, tr); return "failed"; }
  try { if (env.STATE && stashId) await env.STATE.delete(voiceStashKey(stashId)); } catch {}
  await o.route(tr.text);
  return "routed";
}
