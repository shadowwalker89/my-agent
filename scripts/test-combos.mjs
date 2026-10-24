// تست آفلاین (بدون شبکه و KV): کاتالوگ ساختگی به scoring/selection می‌دهیم و نتیجه چاپ می‌شود.
// اجرا: node scripts/test-combos.mjs
import { RULES, pickModels, interleaveByProvider, compilePrefer, scoreModel } from "../src/combos.js";

const DAY = 86400;
const now = Date.now() / 1000;

const CATALOG = [
  { id: "qwen/qwen3-coder-480b:free", provider: "openrouter", context: 262144, vision: false, created: now - 20 * DAY },
  { id: "deepseek/deepseek-chat-v3.1:free", provider: "openrouter", context: 164000, vision: false, created: now - 15 * DAY },
  { id: "meta-llama/llama-4-maverick:free", provider: "openrouter", context: 1000000, vision: false, created: now - 40 * DAY },
  { id: "qwen/qwen2.5-vl-72b:free", provider: "openrouter", context: 32768, vision: true, created: now - 220 * DAY },
  { id: "mistralai/mistral-small-3.2-24b:free", provider: "openrouter", context: 96000, vision: true, created: now - 50 * DAY },
  { id: "google/gemma-3-27b-it:free", provider: "openrouter", context: 96000, vision: true, created: now - 80 * DAY },
  { id: "nvidia/gpt-oss-120b", provider: "nvidia", context: 131072, vision: false, created: now - 12 * DAY },
  { id: "qwen/qwen3-235b-a22b", provider: "nvidia", context: 262144, vision: false, created: now - 90 * DAY },
  { id: "meta/llama-3.3-70b-instruct", provider: "nvidia", context: 131072, vision: false, created: now - 420 * DAY },
  { id: "nvidia/llama-3.1-nemotron-ultra-253b-v1:preview", provider: "nvidia", context: 131072, vision: false, created: now - 60 * DAY },
  { id: "openai/gpt-oss-20b", provider: "nvidia", context: 131072, vision: false, created: now - 100 * DAY },
  { id: "mistralai/mistral-small-24b-instruct", provider: "nvidia", context: 131072, vision: false, created: now - 210 * DAY },
  { id: "qwen3-30b-a3b:free", provider: "xkiro", context: 40000, vision: false, created: now - 130 * DAY },
  { id: "deepseek-v3:free", provider: "xkiro", context: 64000, vision: false, created: now - 160 * DAY },
  { id: "gpt-4.1-mini:free", provider: "xkiro", context: 128000, vision: true, created: now - 550 * DAY },
  { id: "mistral-nemo:free", provider: "xkiro", context: 131000, vision: false, created: now - 300 * DAY },
];

function show(label, entries) {
  console.log(`\n== ${label} ==`);
  if (!entries.length) {
    console.log("  (خالی)");
    return;
  }
  entries.forEach((t, i) => {
    const pin = t.pinned ? " 📌" : "";
    console.log(
      `  ${i + 1}. ${t.provider}/${t.id} — score ${t.score}${pin}`,
    );
  });
}

// ۱) انتخاب پیش‌فرض هر combo (بدون pin/ban/prefer override)
for (const [name, rule] of Object.entries(RULES)) {
  const pins = [];
  const scored = pickModels(CATALOG, rule, {}).filter(
    (m) => !pins.some((p) => p.provider === m.provider && p.id === m.id),
  );
  show(`combo «${name}» — maxTargets ${rule.maxTargets}`, interleaveByProvider(pins, scored, rule.maxTargets));
}

// ۲) نمونه override: pin دو هدف، بنِ یک هدف، prefer جدا برای chat (pin ها هم مثل روتتر امتیاز می‌گیرند)
const ovPins = [
  CATALOG.find((m) => m.id === "gpt-4.1-mini:free"),
  CATALOG.find((m) => m.id === "nvidia/gpt-oss-120b"),
].map((m) => ({ ...m, score: scoreModel(m, compilePrefer(["flash", "small", "mini"])) }));
const banned = ["deepseek/deepseek-chat-v3.1:free"].map((t) => t);
const scored = pickModels(CATALOG, RULES.chat, {
  prefer: ["flash", "small", "mini"],
  bans: banned,
}).filter((m) => !ovPins.some((p) => p.provider === m.provider && p.id === m.id));
show(
  'combo «chat» با override: pin gpt-4.1-mini:free و nvidia/gpt-oss-120b؛ ban deepseek-chat-v3.1:free؛ prefer=["flash","small","mini"]',
  interleaveByProvider(ovPins.map((m) => ({ ...m, pinned: true })), scored, RULES.chat.maxTargets),
);
