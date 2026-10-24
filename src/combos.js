// قانون هر combo: «prefer» الگوهای regex (i) به ترتیب اهمیت؛ هرچه اول‌تر، امتیاز بیشتر.
// «exclude» الگوهای رد شدن، «minContext» حداقل کانتکست (اگر کانتکست معلوم باشد)،
// «needsVision» فقط مدل‌های ویژن، «maxTargets» حداکثر تعداد هدف‌ها.
export const RULES = {
  chat: {
    prefer: [
      "qwen3\\.[6-9]",
      "nemotron-3-(super|ultra)",
      "gemma-4",
      "kimi",
      "glm",
      "deepseek",
      "mistral-large",
    ],
    exclude: [],
    minContext: 32000,
    needsVision: false,
    maxTargets: 8,
  },
  code: {
    prefer: [
      "coder",
      "kimi",
      "glm",
      "deepseek",
      "qwen3\\.[5-9]",
      "gpt-oss",
      "nemotron-3",
      "laguna",
    ],
    exclude: [],
    minContext: 64000,
    needsVision: false,
    maxTargets: 8,
  },
  vision: {
    prefer: ["qwen3\\.[5-9]", "vl", "nemotron-3\\.5-super-vl", "vision"],
    exclude: [],
    minContext: 32000,
    needsVision: true,
    maxTargets: 8,
  },
  fast: {
    prefer: ["flash", "lightning", "bolt", "nano", "glm-.*flash", "minimax.*flash"],
    exclude: [],
    minContext: 8000,
    needsVision: false,
    maxTargets: 8,
  },
};

// ── SCORING — برای تنظیم فقط این ثابت‌ها را تغییر بده ──────────────────────
export const WEIGHTS = {
  preferBase: 20, // امتیاز اولین الگوی prefer که oid بخورد
  preferStep: 2,  // هر اندیس بعدیِ prefer این‌قدر از امتیاز کم می‌کند
  contextPer100k: 1, // بونوس به ازای هر ۱۰۰k کانتکست
  contextCap: 5,   // سقف بونوس کانتکست
  freshnessCap: 3, // بونوس «تازه بودن» مدل بر اساس created (۲ سال = صفر)
  noveltyPenalty: 6, // جریمه‌ی id های preview/beta/alpha (اگر prefer نخورده باشند)
  versionBonus: 3,  // هیوریستیک نسخه: بالاترین نسخه‌ی هر خانواده
  versionStep: 1,   // هر رتبه‌ی نسخه‌ی پایین‌تر یک پله بونوس کمتر (تا صفر)
  sizeSmallPenalty: 20, // مدل کوچک ≤14B — برای combo کدنویسی خیلی ضعیف است
  sizeMidPenalty: 5,    // 15B تا 40B — مرزی
  sizeHugeBonus: 5,     // ≥100B — مدل بزرگ، معمولاً خانواده‌ی قوی‌تر
  legacyPenalty: 15,    // نسل‌های قدیمی: llama2/3.0/3.1، mixtral، gemma-2/3، ...
};

const NOVELTY_RE = /preview|beta|alpha|exp|-rc\d/i;
const LEGACY_RE =
  /llama-3\.[01]|llama3-|mixtral|mistral-7b|mistral-nemo|gemma-2|gemma-3-|phi-3|yi-large|dbrx|jamba-1|granite|arctic|zamba|recurrentgemma|palmyra|codestral|minitron|chatqa|nemotron-4|nemotron-51b|nemotron-70b/i;

function compileSafe(pattern, flags) {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

export function compilePrefer(patterns) {
  return (patterns ?? []).map((raw) => ({
    raw,
    re: typeof raw === "string" ? compileSafe(raw, "i") : null,
  }));
}

export function namePartOf(id) {
  const s = String(id);
  return s.slice(s.lastIndexOf("/") + 1).replace(/:\S+$/, "");
}

// بزرگ‌ترین توکن «<عدد>b» در نام مدل — MoE مثل a12b مؤلفه‌ی فعال است،
// پس مجموعِ واقعی = بزرگ‌ترین عدد (مثلاً 30b-a3b → 30).
const SIZE_TOKEN_RE = /(\d+(?:\.\d+)?)b(?![a-z0-9.])/gi;
export function sizeBOf(name) {
  let max = 0;
  let match;
  SIZE_TOKEN_RE.lastIndex = 0;
  while ((match = SIZE_TOKEN_RE.exec(String(name)))) {
    const v = parseFloat(match[1]);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

function sizeAdjust(sizeB) {
  if (sizeB <= 0) return 0;
  if (sizeB <= 14) return -WEIGHTS.sizeSmallPenalty;
  if (sizeB <= 40) return -WEIGHTS.sizeMidPenalty;
  if (sizeB >= 100) return WEIGHTS.sizeHugeBonus;
  return 0;
}

// کلید خانواده: بخش نام مدل (بعد از آخرین «/»)، بریده قبل از اولین رقم:
// "qwen3.8-max" → "qwen" ، "glm-5.3-flash" → "glm-"
export function familyOf(id) {
  return namePartOf(id).toLowerCase().split(/\d/)[0];
}

// نسخه‌ی عددی: اولین عدد نام مدل (مثل 3.8 یا 5.3)؛ بزرگ‌تر از ۲۰ معتبر نیست
// (مثل سال در "qwen-plus-2025-07-28"). بدون نسخه → -1.
export function versionOf(id) {
  const m = namePartOf(id).match(/\d+(?:\.\d+)?/);
  if (!m) return -1;
  const v = parseFloat(m[0]);
  return Number.isFinite(v) && v <= 20 ? v : -1;
}

// هیوریستیک نسخه: درون هر provider+family، مدل‌های نسخه‌ی بالاتر بونوس کوچک
// می‌گیرند تا نسل جدیدترِ همان خانواده اول بیاید. صرفاً هیوریستیک است.
export function applyVersionBonus(scored) {
  const groups = new Map();
  for (const m of scored) {
    const ver = versionOf(m.id);
    if (ver < 0) continue;
    const key = `${m.provider}|${familyOf(m.id)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ver, m });
  }
  for (const members of groups.values()) {
    const versions = [...new Set(members.map((x) => x.ver))].sort((a, b) => b - a);
    if (versions.length < 2) continue;
    for (const { ver, m } of members) {
      const rank = versions.indexOf(ver);
      const bonus = Math.max(0, WEIGHTS.versionBonus - rank * WEIGHTS.versionStep);
      m.score = Math.round((m.score + bonus) * 10) / 10;
    }
  }
}

export function scoreModel(m, compiledPrefer) {
  const name = namePartOf(m.id);
  const sizeAdj = sizeAdjust(sizeBOf(name));
  let score = sizeAdj;
  compiledPrefer.forEach((entry, i) => {
    if (!entry?.re) return;
    // الگوی «coder» فقط وقتی مدل جریمه‌ی اندازه نخورده اعمال می‌شود —
    // coderهای خیلی کوچک (مثل deepseek-coder-6.7b) به ترکیب کدنویسی کمکی نمی‌کنند.
    if (entry.raw === "coder" && sizeAdj < 0) return;
    if (entry.re.test(m.id)) {
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
  const preferHit = compiledPrefer.some((entry) => entry?.re?.test(m.id));
  if (!preferHit && NOVELTY_RE.test(m.id)) score -= WEIGHTS.noveltyPenalty;
  if (LEGACY_RE.test(name)) score -= WEIGHTS.legacyPenalty;
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
  applyVersionBonus(scored);
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored;
}

// تنوع provider:
// ۱) هرگز سه هدف پشت‌سرهم از یک provider نمی‌آید (حداکثر دو تا).
// ۲) اگر بیش از یک provider کاندید دارد، سه هدف اول حداقل یکی از هر provider را
//    دارد — جای خالی‌ها با بهترین امتیازِ همان provider پر می‌شود.
// «prefix» (pin ها) اول می‌آید؛ pin ها نظم خودشان را نگه می‌دارند.
export function diversify(prefix, items, maxTotal) {
  const out = [...(prefix ?? [])];
  const pool = [...(items ?? [])];
  const providers = [...new Set([...pool, ...out].map((m) => m.provider))];

  // پوشش providerها در سه هدف اول (فقط موقعیت‌های خالی بعد از pin ها)
  while (out.length < 3 && out.length < maxTotal) {
    const covered = new Set(out.map((m) => m.provider));
    const left = providers.filter((p) => !covered.has(p));
    if (!left.length) break;
    let bestIdx = -1;
    for (const p of left) {
      const idx = pool.findIndex((m) => m.provider === p);
      if (idx >= 0 && (bestIdx === -1 || pool[idx].score > pool[bestIdx].score)) bestIdx = idx;
    }
    if (bestIdx === -1) break;
    out.push(pool.splice(bestIdx, 1)[0]);
  }

  // بقیه: ترتیب امتیاز، ولی هدف سومِ پشت‌سرهمِ یک provider نمی‌گیریم
  while (out.length < maxTotal && pool.length) {
    const last2 = out.slice(-2);
    let idx = pool.findIndex(
      (m) => !(last2.length === 2 && last2.every((x) => x.provider === m.provider)),
    );
    if (idx === -1) idx = 0; // فقط یک provider مانده — به‌ناچار ادامه می‌دهیم
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}
