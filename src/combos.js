// TODO: replace every PLACEHOLDER model id with a real id.
// Get the real ids from: GET /admin/models?provider=nvidia|openrouter|xkiro
// (see README.md, section "مدل‌روتر").
export const COMBOS = {
  chat: [
    { provider: "nvidia", model: "PLACEHOLDER-nvidia-1" },
    { provider: "openrouter", model: "PLACEHOLDER-openrouter-1" },
    { provider: "xkiro", model: "PLACEHOLDER-xkiro-1" },
  ],
  code: [
    { provider: "nvidia", model: "PLACEHOLDER-nvidia-1" },
    { provider: "openrouter", model: "PLACEHOLDER-openrouter-1" },
    { provider: "xkiro", model: "PLACEHOLDER-xkiro-1" },
  ],
  vision: [
    { provider: "openrouter", model: "PLACEHOLDER-openrouter-1" },
    { provider: "nvidia", model: "PLACEHOLDER-nvidia-1" },
    { provider: "xkiro", model: "PLACEHOLDER-xkiro-1" },
  ],
  fast: [
    { provider: "nvidia", model: "PLACEHOLDER-nvidia-1" },
    { provider: "openrouter", model: "PLACEHOLDER-openrouter-1" },
    { provider: "xkiro", model: "PLACEHOLDER-xkiro-1" },
  ],
};
