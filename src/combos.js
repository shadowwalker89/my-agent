// قانون هر combo: «prefer» الگوهای regex (i) به ترتیب اهمیت؛ هرچه اول‌تر، امتیاز بیشتر.
// «exclude» الگوهای رد شدن، «minContext» حداقل کانتکست (اگر کانتکست معلوم باشد)،
// «needsVision» فقط مدل‌های ویژن، «maxTargets» حداکثر تعداد هدف‌ها (پیش‌فرض ۶).
export const RULES = {
  chat: {
    prefer: ["qwen", "deepseek", "llama", "gemma", "mistral", "gpt-oss"],
    exclude: [],
    minContext: 16384,
    needsVision: false,
    maxTargets: 6,
  },
  code: {
    prefer: ["coder", "qwen", "deepseek", "kimi", "glm", "gpt-oss", "llama"],
    exclude: [],
    minContext: 16384,
    needsVision: false,
    maxTargets: 6,
  },
  vision: {
    prefer: ["qwen", "gemma", "pixtral", "internvl", "molmo", "llava"],
    exclude: [],
    minContext: 0,
    needsVision: true,
    maxTargets: 6,
  },
  fast: {
    prefer: ["flash", "mini", "small", "lite", "8b", "7b"],
    exclude: [],
    minContext: 0,
    needsVision: false,
    maxTargets: 4,
  },
};

// ── SCORING — برای تنظیم فقط این ثابت‌ها را تغییر بده ──────────────────────
export const WEIGHTS = {
  preferBase: 20, // امتیاز اولین الگوی prefer که oid بخورد
  preferStep: 5,  // هر اندیس بعدیِ prefer این‌قدر از امتیاز کم می‌کند
  contextPer100k: 1, // بونوس به ازای هر ۱۰۰k کانتکست
  contextCap: 5,   // سقف بونوس کانتکست
  freshnessCap: 3, // بونوس «تازه بودن» مدل بر اساس created (۲ سال = صفر)
  noveltyPenalty: 6, // جریمه‌ی id های preview/beta/alpha (اگر prefer نخورده باشند)
};

const NOVELTY_RE = /preview|beta|alpha|exp|-rc\d/i;

function compileSafe(pattern, flags) {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

export function compilePrefer(patterns) {
  return (patterns ?? []).map((p) => compileSafe(p, "i"));
}

export function scoreModel(m, compiledPrefer) {
  let score = 0;
  compiledPrefer.forEach((re, i) => {
    if (re && re.test(m.id)) {
      score += Math.max(0, WEIGHTS.preferBase - i * WEIGHTS.preferStep);
    }
  });
  if (typeof m.context === "number" && m.context > 0) {
    score += Math.min(WEIGHTS.contextCap, (m.context / 100000) * WEIGHTS.contextPer100k);
  }
  if (typeof m.created === "number" && m.created > 0) {
    const ageYears = Math.max(0, (Date.now() / 1000 - m.created) / 31536000);
    score += WEIGHTS.freshnessCap * (1 - Math.min(1, ageYears / 2));
  }
  const preferHit = compiledPrefer.some((re) => re && re.test(m.id));
  if (!preferHit && NOVELTY_RE.test(m.id)) score -= WEIGHTS.noveltyPenalty;
  return Math.round(score * 10) / 10;
}

export function pickModels(catalog, rule, { prefer = null, bans = [] } = {}) {
  const excludeRe = (rule.exclude ?? []).map((p) => compileSafe(p, "i")).filter(Boolean);
  const compiledPrefer = compilePrefer(prefer ?? rule.prefer ?? []);
  const banSet = new Set(bans.map((b) => String(b).toLowerCase()));
  const eligible = catalog.filter((m) => {
    if (banSet.has(`${m.provider}/${m.id}`.toLowerCase())) return false;
    if (excludeRe.some((re) => re.test(m.id))) return false;
    if (rule.minContext && typeof m.context === "number" && m.context < rule.minContext) return false;
    if (rule.needsVision && m.vision !== true) return false;
    return true;
  });
  const scored = eligible.map((m) => ({ ...m, score: scoreModel(m, compiledPrefer) }));
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored;
}

// «prefix» (pin ها اول می‌آیند) بعد بقیه؛ در هر گام تا وقتی دو هدف پشت‌سرهم از یک
// provider هستند، مدل provider بعدی انتخاب می‌شود.
export function interleaveByProvider(prefix, items, maxTotal) {
  const out = [...prefix];
  const rest = [...items];
  while (out.length < maxTotal && rest.length) {
    let idx = rest.findIndex((m) => {
      const last2 = out.slice(-2);
      return !(last2.length === 2 && last2.every((x) => x.provider === m.provider));
    });
    if (idx === -1) idx = 0;
    out.push(rest.splice(idx, 1)[0]);
  }
  return out;
}
