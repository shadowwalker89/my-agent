export const VOICE_MAX_DURATION_SEC = 600;
export const VOICE_LANGUAGE = "fa-IR";
export const VOICE_CUSTOM_VOCABULARY = ["Next.js", "JavaScript", "Cloudflare Workers", "Telegram"];
export const VOICE_TOO_LONG_TEXT = "صدایت طولانی‌تر از ۱۰ دقیقه است؛ لطفاً کوتاه‌تر بفرست 🙏";
export const VOICE_FAILED_TEXT = "صدا را نفهمیدم یا رونویسی نشد؛ دوباره بفرست یا تایپ کن 🙏";
export const VOICE_RETRY_EXHAUSTED_TEXT = "تعداد تلاش‌های مجدد تمام شد؛ لطفاً پیام صوتی را کمی بعد دوباره بفرست.";

const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const GEMINI_TIMEOUT_MS = 20000; // Existing Telegram download timeout, unchanged.
// Voice-only limits; do not reuse/mutate chat-router settings.
// One 30s envelope bounds the sequential model attempts. It is a
// transcription-phase budget, NOT a guarantee for download + downstream chat.
export const TRANSCRIPTION_TOTAL_MS = 30000;
// A 12s per-attempt cap prevents two stalled requests from consuming the
// whole budget while still giving completed answers time to arrive.
export const TRANSCRIPTION_ATTEMPT_MS = 12000;
// Deletion is best-effort privacy cleanup, not part of transcription success.
// Allow a short 500ms attempt without holding a ready transcript for 30s.
export const TRANSCRIPTION_CLEANUP_MS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function transcriptText(data) {
  const candidate = data?.candidates?.[0];
  // Do not route reasoning, safety messages, or truncated transcripts as commands.
  if (candidate?.finishReason && candidate.finishReason !== "STOP") return "";
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text).join("").trim();
}


// Read only known result containers, never arbitrary nested metadata/errors.
function resultText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(resultText).join("");
  if (!value || value.thought || (value.type && !["text", "output_text", "transcript", "transcription"].includes(value.type))) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.text?.value === "string") return value.text.value;
  return resultText(value.content ?? value.parts ?? value.segments);
}
function interactionTranscript(data) {
  if (data?.error || (data?.status && data.status !== "completed")) return "";
  // Current Google SDK contract: Interaction.steps -> ModelOutputStep.content
  // -> TextContent.text (googleapis/python-genai/_gaos/types/interactions).
  if (Array.isArray(data?.steps)) {
    const text = data.steps.filter((step) => step?.type === "model_output" && !step.error && !step.thought)
      .map((step) => Array.isArray(step.content) ? step.content
        .filter((part) => part?.type === "text" && !part.thought && typeof part.text === "string")
        .map((part) => part.text).join("") : "").filter((text) => text.trim()).join("\n").trim();
    if (text) return text;
  }
  for (const value of [data?.output_text, data?.outputs, data?.output, data?.transcription, data?.transcript]) {
    const text = resultText(value).trim();
    if (text) return text;
  }
  return "";
}

export function interactionShape(data) {
  // Fixed booleans, counters, and allowlisted states only; no payload/key names,
  // transcript fragments, IDs, error messages, or unknown enum strings.
  const steps = Array.isArray(data?.steps) ? data.steps : [];
  const outputs = steps.filter((step) => step?.type === "model_output");
  return {
    status: ["completed", "in_progress", "queued", "failed", "cancelled", "incomplete", "requires_action", "budget_exceeded", "requires_continuation"].includes(data?.status) ? data.status : "unknown",
    hasSteps: Array.isArray(data?.steps), stepCount: steps.length,
    modelOutputSteps: outputs.length, stepErrors: outputs.filter((step) => Boolean(step.error)).length,
    textParts: outputs.reduce((n, step) => n + (Array.isArray(step.content) ? step.content.filter((part) => part?.type === "text" && !part.thought && typeof part.text === "string").length : 0), 0),
    hasLegacyOutput: typeof data?.output_text === "string" || data?.outputs != null || data?.output != null,
  };
}

// Like the chat router: enforce wall time through body consumption, not just
// response headers. Promise.race also bounds stalled mocks/abort-insensitive IO.
export async function boundedIO(work, timeoutMs) {
  if (timeoutMs <= 0) throw new Error("voice-timeout");
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([work(controller.signal), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("voice-timeout")); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// Only allow fixed API status codes in diagnostics, never raw error bodies.
export function apiErrorStatus(data) {
  const status = data?.error?.status;
  return ["NOT_FOUND", "UNAVAILABLE", "RESOURCE_EXHAUSTED", "INVALID_ARGUMENT",
    "PERMISSION_DENIED", "UNAUTHENTICATED", "INTERNAL", "DEADLINE_EXCEEDED"].includes(status) ? status : null;
}

// Google RPC error_details.proto: inspect structured quota fields only.
// Never retain subjects, descriptions, metric IDs, dimensions, or raw messages.
export function classifyVoiceQuota(data, headers, nowMs = Date.now()) {
  let daily = false, rate = false, project = false, model = false;
  let retryAfterSeconds = null;
  const delay = (seconds) => {
    if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 604800) {
      retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, Math.ceil(seconds));
    }
  };
  const header = headers?.get?.("retry-after");
  if (typeof header === "string") {
    if (/^\d+$/.test(header.trim())) delay(Number(header));
    else if (/^[A-Za-z]{3},/.test(header)) {
      const date = Date.parse(header);
      if (Number.isFinite(date)) delay(Math.max(0, (date - nowMs) / 1000));
    }
  }
  const details = Array.isArray(data?.error?.details) ? data.error.details : [];
  for (const item of details.slice(0, 32)) {
    if (item?.["@type"] === "type.googleapis.com/google.rpc.RetryInfo") {
      const value = item.retryDelay;
      if (typeof value === "string" && /^\d+(?:\.\d{1,9})?s$/.test(value)) delay(Number(value.slice(0, -1)));
    }
    if (item?.["@type"] !== "type.googleapis.com/google.rpc.QuotaFailure") continue;
    const violations = Array.isArray(item.violations) ? item.violations : [];
    for (const v of violations.slice(0, 64)) {
      const id = [v?.quotaId, v?.quotaMetric].filter((x) => typeof x === "string")
        .join(" ").toLowerCase().replace(/[_ -]/g, "");
      daily ||= /perday|daily/.test(id);
      rate ||= /persecond|perminute|perhour/.test(id);
      const dimensions = v?.quotaDimensions;
      const perModel = /permodel/.test(id) || Boolean(dimensions && typeof dimensions === "object"
        && Object.keys(dimensions).some((k) => /^model(?:_?id)?$/i.test(k)));
      model ||= perModel;
      project ||= !perModel && /perproject/.test(id);
    }
  }
  // RetryInfo says when to retry, not which quota was exhausted.
  return { kind: daily ? "daily" : rate ? "rate" : "unknown",
    scope: project ? "project" : model ? "model" : "unknown", retryAfterSeconds };
}

