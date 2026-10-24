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

async function fetchModelsJson(env, provider) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider: ${provider}`);
  const key = env[p.keyEnv];
  if (!key) throw new Error(`missing ${p.keyEnv}`);
  let res;
  try {
    res = await fetch(`${p.baseUrl}/models`, {
      headers: {
        authorization: `Bearer ${key}`,
        "user-agent": LIST_USER_AGENT,
        ...(p.extraHeaders ?? {}),
      },
    });
  } catch (err) {
    throw new UpstreamError({
      provider,
      status: null,
      snippet: "",
      message: `network error: ${err && err.message}`,
    });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new UpstreamError({
      provider,
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
      provider,
      status: res.status,
      snippet: redact(text, [key], 300),
      message: `bad json from provider: ${err && err.message}`,
    });
  }
  const list = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  return list.filter((m) => m && typeof m.id === "string");
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

const LISTERS = {
  openrouter: async (env) => mapOpenRouter(await fetchModelsJson(env, "openrouter")),
  xkiro: async (env) => mapXkiro(await fetchModelsJson(env, "xkiro")),
  nvidia: async (env) => mapNvidia(await fetchModelsJson(env, "nvidia")),
};

export function listFreeModels(env, provider) {
  const fn = LISTERS[provider];
  if (!fn) throw new Error(`unknown provider: ${provider}`);
  return fn(env);
}
