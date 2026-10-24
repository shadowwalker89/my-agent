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

const NON_CHAT_RE =
  /embed|rerank|reward|guard|safety|tts|asr|whisper|parakeet|stable-diffusion|sdxl|cosmos|clip|retriev|riva|fugatto|maxine|segment/i;
const NVIDIA_VISION_RE = /vision|\bvl\b|llava|pixtral|paligemma|vila|-vl-/i;
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
      headers: { authorization: `Bearer ${key}`, ...(p.extraHeaders ?? {}) },
    });
  } catch (err) {
    throw new Error(`network error: ${err && err.message}`);
  }
  if (!res.ok) throw new Error(`provider returned ${res.status}`);
  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error(`bad json from provider: ${err && err.message}`);
  }
  const list = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  return list.filter((m) => m && typeof m.id === "string");
}

const LISTERS = {
  openrouter: async (env) => {
    const list = await fetchModelsJson(env, "openrouter");
    return list
      .filter((m) => m.id.endsWith(":free"))
      .map((m) => ({
        id: m.id,
        provider: "openrouter",
        context: contextOf(m),
        vision: imageInput(m) ?? false,
        created: createdOf(m),
      }));
  },
  xkiro: async (env) => {
    const list = await fetchModelsJson(env, "xkiro");
    return list
      .filter((m) => m.id.endsWith(":free"))
      .map((m) => ({
        id: m.id,
        provider: "xkiro",
        context: contextOf(m),
        vision: imageInput(m) ?? null,
        created: createdOf(m),
      }));
  },
  nvidia: async (env) => {
    const list = await fetchModelsJson(env, "nvidia");
    return list
      .filter((m) => !NON_CHAT_RE.test(m.id))
      .map((m) => ({
        id: m.id,
        provider: "nvidia",
        context: contextOf(m),
        vision: NVIDIA_VISION_RE.test(m.id),
        created: createdOf(m),
      }));
  },
};

export function listFreeModels(env, provider) {
  const fn = LISTERS[provider];
  if (!fn) throw new Error(`unknown provider: ${provider}`);
  return fn(env);
}
