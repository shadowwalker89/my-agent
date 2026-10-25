export const PROVIDERS = {
  nvidia: {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    extraHeaders: { "X-Title": "my-agent" },
  },
  xkiro: {
    baseUrl: "https://api.xkiro.com/v1",
    keyEnv: "XKIRO_API_KEY",
  },
};

// خطای upstream با اطلاعاتی که امن است بیرون فرستاده شود:
// خروجی همان { ok:false, provider, status, snippet } — بدنه‌ی upstream با رازپاک‌سازی.
export class UpstreamError extends Error {
  constructor({ provider, status = null, snippet = "", message }) {
    super(
      message ??
        `provider ${provider} failed${status ? ` (http ${status})` : ""}`,
    );
    this.name = "UpstreamError";
    this.info = { ok: false, provider, status, snippet };
  }
}

// فقط برای درخواست‌های کشف مدل — هرگز هدرها لاگ/بازگردانده نمی‌شوند.
export const LIST_USER_AGENT = "Mozilla/5.0 (compatible; my-agent/1.0)";

const SECRET_TOKEN_RE = /(sk-or|sk-xt|sk|nvapi)[-_A-Za-z0-9]{8,}/g;

// سانسور رازها: مقدار کلیدهای provider + توکن‌هایی که شکل کلید دارند.
// خروجی حداکثر «limit» نویسه‌ی اول است.
export function redact(text, secrets, limit) {
  let s = String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 7) {
      s = s.split(secret).join("[REDACTED]");
    }
  }
  s = s.replace(SECRET_TOKEN_RE, "[REDACTED]");
  return s.length > limit ? s.slice(0, limit) : s;
}

const NON_CHAT_RE =
  /embed|rerank|reward|guard|safety|retriev|riva|fugatto|maxine|segment|cosmos|clip|tts|asr|whisper|parakeet|parse|detector|calibration|deplot|kosmos|nvclip|translate|diffusion|starcoder|llama2|codellama|vila|neva|fuyu/i;
const NVIDIA_VISION_RE = /vision|\bvl\b|llava|pixtral|paligemma|-vl-/i;
const CONTEXT_FIELDS = ["context_length", "contextLength", "context_size", "contextSize"];

function contextOf(m) {
  for (const k of CONTEXT_FIELDS) {
    if (typeof m?.[k] === "number") return m[k];
  }
  if (typeof m?.architecture?.context_length === "number") {
    return m.architecture.context_length;
  }
  return null;
}

function imageInput(m) {
  if (Array.isArray(m?.architecture?.input_modalities)) {
    return m.architecture.input_modalities.includes("image");
  }
  if (Array.isArray(m?.modalities)) {
    return m.modalities.some((x) => typeof x === "string" && x.toLowerCase().includes("image"));
  }
  const caps = m?.capabilities;
  if (Array.isArray(caps)) {
    return caps.some((x) => typeof x === "string" && /imag|vision/i.test(x));
  }
  if (caps && typeof caps === "object") {
    return Object.entries(caps).some(([k, v]) => /imag|vision/i.test(k) && v === true);
  }
  if (typeof m?.vision === "boolean") return m.vision;
  return undefined;
}

function createdOf(m) {
  return typeof m?.created === "number" ? m.created : null;
}

// مپر عمومی برای providerهای دستی (سازگار با OpenAI): همه‌ی مدل‌ها، بدون فیلتر خاص
export function mapGenericModels(list, providerId) {
  return list.map((m) => ({
    id: m.id,
    provider: providerId,
    context: contextOf(m),
    vision: imageInput(m) ?? false,
    created: createdOf(m),
  }));
}

// مپرهای خالص (بدون شبکه) — فایل‌های فیکسچر آفلاین هم همین را صدا می‌زنند.
export function mapOpenRouter(list) {
  return list
    .filter((m) => m.id.endsWith(":free"))
    .map((m) => ({
      id: m.id,
      provider: "openrouter",
      context: contextOf(m),
      vision: imageInput(m) ?? false,
      created: createdOf(m),
    }));
}

export function mapXkiro(list) {
  return list
    .filter((m) => m.id.endsWith(":free"))
    .map((m) => ({
      id: m.id,
      provider: "xkiro",
      context: contextOf(m),
      vision: imageInput(m) ?? null,
      created: createdOf(m),
    }));
}

export function mapNvidia(list) {
  return list
    .filter((m) => !NON_CHAT_RE.test(m.id))
    .map((m) => ({
      id: m.id,
      provider: "nvidia",
      context: contextOf(m),
      vision: NVIDIA_VISION_RE.test(m.id),
      created: createdOf(m),
    }));
}

const LISTERS_IDS = { openrouter: mapOpenRouter, xkiro: mapXkiro, nvidia: mapNvidia };

// داده‌ی seed برای config (مقادیر کلید هرگز اینجا نیستند — فقط نام راز)
export const BUILTIN_PROVIDERS = Object.entries(PROVIDERS).map(([id, p]) => ({
  id,
  name: id,
  baseUrl: p.baseUrl,
  secretName: p.keyEnv,
  enabled: true,
  builtin: true,
  extraHeaders: p.extraHeaders ? { ...p.extraHeaders } : null,
}));

// کشف مدل از endpoint سازگار با OpenAI — همان User-Agent/سانسورِ رازِ مسیر کشف مدل
export async function fetchOpenAiModels(providerId, baseUrl, key, extraHeaders) {
  let res;
  try {
    res = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/models`, {
      headers: {
        authorization: `Bearer ${key}`,
        "user-agent": LIST_USER_AGENT,
        ...(extraHeaders ?? {}),
      },
    });
  } catch (err) {
    throw new UpstreamError({
      provider: providerId,
      status: null,
      snippet: "",
      message: `network error: ${err && err.message}`,
    });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new UpstreamError({
      provider: providerId,
      status: res.status,
      snippet: redact(body, [key], 300),
    });
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new UpstreamError({
      provider: providerId,
      status: res.status,
      snippet: redact(text, [key], 300),
      message: `bad json from provider: ${err && err.message}`,
    });
  }
  const list = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  return list.filter((m) => m && typeof m.id === "string");
}

// هر provider پیکربندی‌شده (داخلی یا دستی) — ctx از config می‌آید
// ({ id, baseUrl, secretName, builtin, extraHeaders }); مقدار کلید فقط از env.
export async function listProviderModels(env, ctx) {
  if (!ctx?.baseUrl || !ctx?.secretName) throw new Error(`unknown provider: ${ctx?.id ?? "?"}`);
  const key = env[ctx.secretName];
  if (!key) throw new Error(`missing ${ctx.secretName}`);
  const list = await fetchOpenAiModels(ctx.id, ctx.baseUrl, key, ctx.extraHeaders ?? undefined);
  if (ctx.builtin && LISTERS_IDS[ctx.id]) return LISTERS_IDS[ctx.id](list);
  return mapGenericModels(list, ctx.id);
}
