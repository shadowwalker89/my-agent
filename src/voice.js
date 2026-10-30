// Voice input, v1: Telegram voice -> Gemini 3.5-transcribe -> the existing
// plain-text path (dev -> everyday -> chat). No separate command.
// Audio bytes are never stored (not in D1, not in R2) and never logged.
// GEMINI_API_KEY is read from env only; it is never logged or returned.
import { tgApi } from "./telegram.js";

export const VOICE_MAX_DURATION_SEC = 600;
export const VOICE_LANGUAGE = "fa-IR";
export const VOICE_CUSTOM_VOCABULARY = ["Next.js", "JavaScript", "Cloudflare Workers", "Telegram"];
export const VOICE_TOO_LONG_TEXT = "صدایت طولانی‌تر از ۱۰ دقیقه است؛ لطفاً کوتاه‌تر بفرست 🙏";
export const VOICE_FAILED_TEXT = "صدا را نفهمیدم یا رونویسی نشد؛ دوباره بفرست یا تایپ کن 🙏";

const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function firstText(node) {
  if (!node) return "";
  if (typeof node === "string") return "";
  if (typeof node.text === "string" && node.text) return node.text;
  const values = Array.isArray(node) ? node : Object.values(node);
  for (const v of values) { const t = firstText(v); if (t) return t; }
  return "";
}

// Telegram getFile + download. Bot API download limit (20 MB) still applies;
// a download failure is a fallback, never a crash.
export async function downloadTelegramVoice(env, fileId) {
  try {
    const info = await tgApi(env, "getFile", { file_id: fileId });
    const path = info?.result?.file_path;
    if (!info?.ok || !path) return { ok: false };
    const res = await fetch(`${"https://api.telegram.org"}/file/bot${env.TG_TOKEN}/${path}`);
    if (!res.ok) return { ok: false };
    return { ok: true, bytes: await res.arrayBuffer() };
  } catch { return { ok: false }; }
}

// Gemini 3.5-transcribe via the Files API + Interactions API, mirroring the
// proven helper flow: multipart upload, poll until ACTIVE, interact, then
// best-effort delete of the uploaded file (a delete failure never blocks).
export async function transcribeWithGemini(env, audioBytes, mimeType, opts = {}) {
  const started = Date.now();
  const key = env?.GEMINI_API_KEY;
  const log = (ok, reason) => console.log(JSON.stringify({ voiceTranscribe: "gemini-3.5-transcribe", ms: Date.now() - started, ok, reason: reason ?? null }));
  if (!key) { log(false, "missing-key"); return { ok: false, reason: "missing-key" }; }
  const headers = { "x-goog-api-key": key };
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const maxPolls = opts.maxPolls ?? 30;
  let name = null;
  try {
    const boundary = `----voice${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const enc = new TextEncoder();
    const meta = JSON.stringify({ file: { display_name: "voice.ogg" } });
    const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType || "audio/ogg"}\r\n\r\n`);
    const tail = enc.encode(`\r\n--${boundary}--\r\n`);
    const up = await fetch(`${GEMINI_BASE}/upload/v1beta/files`, { method: "POST", headers: { ...headers, "Content-Type": `multipart/related; boundary=${boundary}`, "X-Goog-Upload-Protocol": "multipart" }, body: new Blob([head, audioBytes, tail]) });
    const upJson = await up.json().catch(() => null);
    name = upJson?.file?.name ?? upJson?.name ?? null;
    if (!up.ok || !name) { log(false, "upload"); return { ok: false, reason: "upload" }; }
    let uri = null;
    for (let i = 0; i < maxPolls; i++) {
      const poll = await fetch(`${GEMINI_BASE}/v1beta/${name}`, { headers });
      const info = await poll.json().catch(() => null);
      if (info?.state === "ACTIVE" && info?.uri) { uri = info.uri; break; }
      if (info?.state === "FAILED" || !poll.ok) { log(false, "processing"); return { ok: false, reason: "processing" }; }
      if (i < maxPolls - 1) await sleep(pollIntervalMs);
    }
    if (!uri) { log(false, "not-active"); return { ok: false, reason: "not-active" }; }
    const res = await fetch(`${GEMINI_BASE}/v1beta/interactions`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gemini-3.5-transcribe", input: [{ type: "audio", uri, mime_type: mimeType || "audio/ogg" }], generation_config: { transcription_config: { language_codes: [VOICE_LANGUAGE], custom_vocabulary: VOICE_CUSTOM_VOCABULARY } } }) });
    const data = await res.json().catch(() => null);
    if (!res.ok) { log(false, "interactions"); return { ok: false, reason: "interactions" }; }
    const text = (data?.output_text || (data?.output && typeof data.output === "object" ? data.output.text : "") || firstText(data) || "").trim();
    if (!text) { log(false, "empty"); return { ok: false, reason: "empty" }; }
    log(true, null);
    return { ok: true, text };
  } catch { log(false, "error"); return { ok: false, reason: "error" }; }
  finally {
    if (name) { try { await fetch(`${GEMINI_BASE}/v1beta/${name}`, { method: "DELETE", headers }); } catch {} }
  }
}

// Voice orchestration for handleUpdate. Over-cap voices get a clear reply
// with no model call and nothing stored; every other failure gets the same
// clear fallback reply, never a silent chat fallback that invents content.
export async function handleVoice(env, o) {
  const voice = o.voice ?? {};
  const duration = Number(voice.duration);
  if (Number.isFinite(duration) && duration > VOICE_MAX_DURATION_SEC) { await o.send(VOICE_TOO_LONG_TEXT); return "too-long"; }
  const dl = await downloadTelegramVoice(env, voice.file_id);
  if (!dl.ok) { await o.send(VOICE_FAILED_TEXT); return "failed"; }
  const tr = await transcribeWithGemini(env, dl.bytes, voice.mime_type || "audio/ogg", o.transcribeOpts ?? {});
  if (!tr.ok) { await o.send(VOICE_FAILED_TEXT); return "failed"; }
  await o.route(tr.text);
  return "routed";
}
