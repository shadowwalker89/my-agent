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
