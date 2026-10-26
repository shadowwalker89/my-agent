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

function capabilitiesOf(m) {
  const src = m?.capabilities;
  if (!src || typeof src !== "object" || Array.isArray(src)) return null;
  const out = {};
  for (const key of ["vision", "tools", "reasoning"]) {
    if (typeof src[key] === "boolean") out[key] = src[key];
  }
  return Object.keys(out).length ? out : null;
}

function modalityOf(m) {
  return typeof m?.modality === "string" ? m.modality : null;
}

function toModel(m, providerId, vision) {
  return {
    id: m.id,
    provider: providerId,
    context: contextOf(m),
    vision,
    created: createdOf(m),
    capabilities: capabilitiesOf(m),
    modality: modalityOf(m),
  };
}

function idOf(m) {
  return m && typeof m.id === "string" ? m.id : "";
}

function collectModels(list, decide, mapModel) {
  const dropped = [];
  const models = [];
  const seen = new Set();
  for (const m of Array.isArray(list) ? list : []) {
    const id = idOf(m);
    if (!id) {
      dropped.push({ id: String(m?.id ?? "?").slice(0, 200), reason: "invalid_id" });
      continue;
    }
    const reason = decide(m);
    if (reason) {
      dropped.push({ id: id.slice(0, 200), reason });
      continue;
    }
    if (seen.has(id)) {
      dropped.push({ id: id.slice(0, 200), reason: "duplicate" });
      continue;
    }
    seen.add(id);
    models.push(mapModel(m));
  }
  return { models, dropped };
}

function pricingAllZero(pricing) {
  if (!pricing || typeof pricing !== "object") return false;
  const values = ["input", "output", "prompt", "completion", "request"]
    .filter((key) => pricing[key] !== undefined)
    .map((key) => Number(pricing[key]));
  return values.length > 0 && values.every((value) => Number.isFinite(value) && value === 0);
}

// Free بودن xkiro با access_tier تعیین می‌شود؛ پسوند :free و قیمت صفر فقط fallback
// برای پاسخ‌های قدیمی/فیکسچرها هستند. مدل‌های paid/premium حتی با قیمت صفر رد می‌شوند.
function isXkiroFree(m) {
  const tier = typeof m?.access_tier === "string" ? m.access_tier.toLowerCase() : "";
  if (tier === "free") return true;
  if (tier === "paid" || tier === "premium") return false;
  if (idOf(m).toLowerCase().endsWith(":free")) return true;
  if (m?.free === true || m?.is_free === true) return true;
  return pricingAllZero(m?.pricing);
}

// مپرهای خالص (بدون شبکه) — فایل‌های فیکسچر آفلاین هم همین را صدا می‌زنند.
// نسخه‌ی Detailed علاوه بر مدل‌ها، فهرست حذف‌شده‌ها را برای گزارش sync برمی‌گرداند.
export function mapGenericModelsDetailed(list, providerId) {
  return collectModels(list, () => null, (m) => toModel(m, providerId, imageInput(m) ?? false));
}

export function mapGenericModels(list, providerId) {
  return mapGenericModelsDetailed(list, providerId).models;
}

export function mapOpenRouterDetailed(list) {
  return collectModels(
    list,
    (m) => (idOf(m).endsWith(":free") ? null : "non_free"),
    (m) => toModel(m, "openrouter", imageInput(m) ?? false),
  );
}

export function mapOpenRouter(list) {
  return mapOpenRouterDetailed(list).models;
}

export function mapXkiroDetailed(list) {
  return collectModels(
    list,
    (m) => (isXkiroFree(m) ? null : "non_free"),
    (m) => toModel(m, "xkiro", imageInput(m) ?? null),
  );
}

export function mapXkiro(list) {
  return mapXkiroDetailed(list).models;
}

export function mapNvidiaDetailed(list) {
  return collectModels(
    list,
    (m) => (NON_CHAT_RE.test(idOf(m)) ? "non_chat" : null),
    (m) => toModel(m, "nvidia", NVIDIA_VISION_RE.test(idOf(m))),
  );
}

export function mapNvidia(list) {
  return mapNvidiaDetailed(list).models;
}

const DETAILED_LISTERS = {
  openrouter: mapOpenRouterDetailed,
  xkiro: mapXkiroDetailed,
  nvidia: mapNvidiaDetailed,
};

export function mapProviderModels(providerId, list, builtin) {
  if (builtin && DETAILED_LISTERS[providerId]) return DETAILED_LISTERS[providerId](list);
  return mapGenericModelsDetailed(list, providerId);
}

function buildSyncReport(raw, mapped) {
  const sample = Array.isArray(raw) ? raw.find((m) => m && typeof m === "object") : null;
  return {
    fetched: Array.isArray(raw) ? raw.length : 0,
    kept: mapped.models.length,
    droppedCount: mapped.dropped.length,
    dropped: mapped.dropped.slice(0, 100),
    sampleRawKeys: sample ? Object.keys(sample).slice(0, 40) : [],
    at: new Date().toISOString(),
  };
}

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
export async function listProviderModelsDetailed(env, ctx) {
  if (!ctx?.baseUrl || !ctx?.secretName) throw new Error(`unknown provider: ${ctx?.id ?? "?"}`);
  const key = env[ctx.secretName];
  if (!key) throw new Error(`missing ${ctx.secretName}`);
  const raw = await fetchOpenAiModels(ctx.id, ctx.baseUrl, key, ctx.extraHeaders ?? undefined);
  const mapped = mapProviderModels(ctx.id, raw, Boolean(ctx.builtin));
  return { models: mapped.models, sync: buildSyncReport(raw, mapped) };
}

export async function listProviderModels(env, ctx) {
  return (await listProviderModelsDetailed(env, ctx)).models;
}
