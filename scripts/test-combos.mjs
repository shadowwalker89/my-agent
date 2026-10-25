// تست آفلاین (بدون شبکه/KV/راز): از فایل‌های فیکسچر در ریشه‌ی پروژه استفاده می‌کند.
// xk-models.json، nv-models.json، or-models.json — فقط آی‌دی‌های عمومی؛ gitignored
// و هرگز کامیت نمی‌شوند. فایل نبود → رد با پیام؛ or-models.json اگر object خطا بود
// نه لیست → رد با پیام. اجرا: node scripts/test-combos.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RULES, pickModels, diversify, WEIGHTS } from "../src/combos.js";
import { mapNvidia, mapXkiro, mapOpenRouter } from "../src/providers.js";
import { classifyFailure, sortForStrategy } from "../src/router.js";
import {
  getConfig,
  upsertProvider,
  removeProvider,
  upsertCombo,
  removeCombo,
  validateProvider,
  validateCombo,
  TARGET_LIMIT,
} from "../src/config.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadFixture(name) {
  const p = path.join(rootDir, name);
  let buf;
  try {
    buf = readFileSync(p);
  } catch {
    console.log(`⚠ ${name}: یافت نشد — رد شد.`);
    return null;
  }
  // فیکسچرها با PowerShell ذخیره شده‌اند؛ ممکن است UTF-16 با BOM باشند.
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = new TextDecoder("utf-16le").decode(buf);
  else text = new TextDecoder("utf-8").decode(buf);
  let json;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    console.log(`⚠ ${name}: JSON نامعتبر (${err && err.message}) — رد شد.`);
    return null;
  }
  if (!Array.isArray(json)) {
    console.log(
      `⚠ ${name}: لیست نیست و object خطا برگردانده (${"ok=" + json.ok + " error=" + (json.error ?? "?")}) — رد شد.`,
    );
    return null;
  }
  if (!json.filter((m) => m && typeof m.id === "string").length) {
    console.log(`⚠ ${name}: لیست خالی — رد شد.`);
    return null;
  }
  console.log(`✓ ${name}: ${json.length} entry`);
  return json;
}

const catalog = [];
const or = loadFixture("or-models.json");
if (or) catalog.push(...mapOpenRouter(or));
const nv = loadFixture("nv-models.json");
if (nv) catalog.push(...mapNvidia(nv));
const xk = loadFixture("xk-models.json");
if (xk) catalog.push(...mapXkiro(xk));

if (!catalog.length) {
  console.error("هیچ فیکسچری در دسترس نبود؛ تست آفلاین قابل اجرا نیست.");
  process.exit(1);
}
console.log(`کاتالوگ آزمایشی: ${catalog.length} مدل [${[...new Set(catalog.map((m) => m.provider))].join(", ")}]`);

const failures = [];

function plainScored(rule) {
  return pickModels(catalog, rule, {});
}

function show(label, entries) {
  console.log(`\n== ${label} ==`);
  if (!entries.length) {
    console.log("  (خالی)");
    return;
  }
  entries.forEach((t, i) => {
    console.log(`  ${i + 1}. [${t.provider}] ${t.id} — score ${t.score}`);
  });
}

function check(cond, msg) {
  if (!cond) failures.push(msg);
}

// ── فیکسچرهای classifyFailure (طبقه‌بندی شکست upstream) ────────────────────
function checkCls(name, out, scope, cooldownSec, label) {
  let ok = out.scope === scope && out.cooldownSec === cooldownSec;
  if (label !== undefined) ok &&= out.label === label;
  // برچسب هرگز «http undefined» نمی‌شود
  ok &&= !/undefined/.test(String(out.label));
  check(ok, `classifyFailure ${name}: خروجی ${JSON.stringify(out)}`);
}

const fn404 =
  "Function qwen3-30b-a3b-instruct with id abc not found for account 123";
checkCls("404 function-not-found", classifyFailure(404, fn404, false), "model", 86400);
checkCls(
  "404 plain-page",
  classifyFailure(404, "404 page not found", false),
  "model",
  86400,
  "model not available (http 404)",
);
checkCls("timeout", classifyFailure(null, "", true), "model", 600, "timeout");
checkCls("503", classifyFailure(503, "", false), "model", 900, "http 503");
checkCls("429", classifyFailure(429, "", false), "model", 900);
checkCls("401", classifyFailure(401, "", false), "provider", 3600, "key rejected");
checkCls("no-status", classifyFailure(null, "", false), "model", 600, "upstream error");

// ── جریمه‌ی vl/omni در code — در vision معلق می‌شود ────────────────────────
const DAY = 86400;
const now = Date.now() / 1000;
const twinBase = { provider: "xkiro", context: 262144, created: now - 10 * DAY };
const twinPlus = { id: "qwen/qwen3.9-plus:free", ...twinBase, vision: true };
const twinOmni = { id: "qwen/qwen3.9-omni-flash:free", ...twinBase, vision: true };
const scoreOf = (m, rule) => pickModels([twinPlus, twinOmni], rule, {}).find((x) => x.id === m.id).score;
const codePlus = scoreOf(twinPlus, RULES.code);
const codeOmni = scoreOf(twinOmni, RULES.code);
check(
  Math.abs(codePlus - codeOmni - WEIGHTS.vlOmniPenalty) < 0.51,
  `code: جریمه‌ی vl/omni اعمال نشد (${codePlus} مقابل ${codeOmni})`,
);
const visPlus = scoreOf(twinPlus, RULES.vision);
const visOmni = scoreOf(twinOmni, RULES.vision);
check(
  Math.abs(visPlus - visOmni) < 0.51,
  `vision: جریمه‌ی vl/omni نباید اعمال می‌شد (${visPlus} مقابل ${visOmni})`,
);

const asserts = {
  code: (targets) => {
    const ids = targets.map((t) => t.id.toLowerCase());
    const good = /kimi|glm|deepseek-v4|nemotron-3|qwen3-coder/;
    if (!ids.some((id) => good.test(id))) failures.push("code: هیچ‌کدام از kimi/glm/deepseek-v4/nemotron-3/qwen3-coder در top 8 نیست");
    const bad = /starcoder|codellama|deepseek-coder-6\.7b|yi-large|llama2/;
    const badHit = ids.filter((id) => bad.test(id));
    if (badHit.length) failures.push(`code: مدل ممنوع در top 8: ${badHit.join(", ")}`);
  },
  vision: (targets) => {
    if (!targets.some((t) => t.provider === "nvidia")) {
      failures.push("vision: هیچ مدل ویژن NVIDIA در top 6 نیست");
    }
    const bad = targets.slice(0, 6).filter((t) => /embed|guard|parse|detector/i.test(t.id));
    if (bad.length) failures.push(`vision: مدل embed/guard/parse در نتایج: ${bad.map((t) => t.id).join(", ")}`);
  },
  chat: (targets) => {
    const providers = new Set(targets.slice(0, 6).map((t) => t.provider));
    if (!providers.has("xkiro") || !providers.has("nvidia")) {
      failures.push(`chat: هر دو provider در top 6 نیستند (${[...providers].join(", ")})`);
    }
  },
};

function diversityCheck(name, targets) {
  for (let i = 0; i < targets.length; i++) {
    if (
      i >= 2 &&
      targets[i].provider === targets[i - 1].provider &&
      targets[i - 1].provider === targets[i - 2].provider
    ) {
      failures.push(`${name}: سه هدف پشت‌سرهم از ${targets[i].provider} (موقعیت ${i})`);
    }
  }
  const all = new Set(targets.map((t) => t.provider));
  if (all.size > 1) {
    const first3 = new Set(targets.slice(0, 3).map((t) => t.provider));
    for (const p of all) {
      if (!first3.has(p)) failures.push(`${name}: provider ${p} در سه هدف اول نیست`);
    }
  }
}

const topTargets = {};
for (const [name, rule] of Object.entries(RULES)) {
  const scored = plainScored(rule);
  const targets = diversify([], scored, rule.maxTargets).map((m) => ({
    ...m,
    pinned: false,
  }));
  topTargets[name] = targets;
  show(`combo «${name}» — ${Math.min(8, targets.length)} هدف از ${targets.length}`, targets.slice(0, 8));
  diversityCheck(name, targets);
  asserts[name]?.(targets);
}

// ── patch 3a: config:v1 در KV، اعتبارسنجی، سقف‌ها و راز ────────────────────
function fakeKV() {
  const store = new Map();
  return {
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async list() {
      return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true };
    },
    store,
  };
}

const SECRET_VALUE = "mock-secret-token-xyz"; // مقدار جعلی — هرگز در خروجی نباید بیاید
const fakeEnv = { STATE: fakeKV(), [`${"MY_TEST_SECRET"}V`]: SECRET_VALUE };
const SECRET_NAME = "MY_TEST_SECRETV";

const seeded = await getConfig(fakeEnv);
check(seeded.providers.length >= 3, `seed: داخلی‌ها seed نشدند (${seeded.providers.length})`);
check(
  ["nvidia", "openrouter", "xkiro"].every((id) => seeded.providers.some((p) => p.id === id)),
  "seed: سه داخلی در config نیستند",
);

const throwsWithMsg = async (fn, re, label) => {
  try {
    await fn();
    check(false, `${label}: خطا نباید نداشت`);
  } catch (err) {
    check(
      re.test(String(err && err.message)),
      `${label}: پیام مناسب نبود (${err && err.message})`,
    );
  }
};

// اعتباربجایی provider
const goodProvider = { id: "my-gateway", baseUrl: "https://gw.example.com/v1", secretName: SECRET_NAME };
await upsertProvider(fakeEnv, goodProvider);
throwsWithMsg(
  () => validateProvider(fakeEnv, { id: "bad1", baseUrl: "http://no-https.example.com", secretName: SECRET_NAME }),
  /https/,
  "validateProvider bad url",
);
throwsWithMsg(
  () => validateProvider(fakeEnv, { id: "Bad ID!", baseUrl: "https://x.example.com", secretName: SECRET_NAME }),
  /invalid provider id/,
  "validateProvider bad name",
);
throwsWithMsg(
  () => validateProvider(fakeEnv, { id: "ok-id", baseUrl: "https://x.example.com", secretName: "NOT_PRESENT_SECRET" }),
  /unknown secretName/,
  "validateProvider unknown secret",
);
check(
  !/\s/.test(goodProvider.id) && /^[a-z0-9._-]{1,40}$/.test(goodProvider.id),
  "id pattern sanity",
);

// secret هرگز در خروجی/KV نیست
const afterUpsert = await getConfig(fakeEnv);
const storedStr = JSON.stringify(afterUpsert);
check(
  storedStr.includes(SECRET_NAME) && !storedStr.includes(SECRET_VALUE),
  "secret value leaked into config KV!",
);

// سقف‌ها: بعد از سقف، upsert خطا می‌دهد و لیست در ۲۰ می‌ماند
let limitHit = false;
for (let i = 0; i < 25; i++) {
  try {
    await upsertProvider(fakeEnv, {
      id: `p${String(i).padStart(2, "0")}`,
      baseUrl: "https://gw.example.com/v1",
      secretName: SECRET_NAME,
    });
  } catch (err) {
    limitHit = /max 20 providers/.test(String(err && err.message));
    break;
  }
}
check(limitHit, "سقف ۲۰ provider اعمال نشد");
check(
  (await getConfig(fakeEnv)).providers.length === 20,
  `تعداد providers باید ۲۰ باشد (${(await getConfig(fakeEnv)).providers.length})`,
);

// combo: نام/strategy/سقف targets
const comboBase = {
  name: "mine",
  strategy: "priority",
  timeoutMs: 20000,
  retries: 0,
  targets: [
    { provider: "my-gateway", model: "gpt-x" },
    { provider: "nvidia", model: "z-ai/glm-5.3" },
  ],
};
await upsertCombo(fakeEnv, comboBase);
throwsWithMsg(
  () => validateCombo(fakeEnv, { ...comboBase, strategy: "random" }, afterUpsert),
  /strategy/,
  "combo bad strategy",
);
throwsWithMsg(
  () => validateCombo(fakeEnv, { ...comboBase, name: "BAD!" }, afterUpsert),
  /invalid combo name/,
  "combo bad name",
);
throwsWithMsg(
  () => validateCombo(fakeEnv, { ...comboBase, targets: Array(31).fill(comboBase.targets[0]) }, afterUpsert),
  /max 30 targets/,
  "combo target limit",
);
throwsWithMsg(
  () => validateCombo(fakeEnv, { ...comboBase, targets: [{ provider: "ghost", model: "x" }] }, afterUpsert),
  /unknown provider/,
  "combo unknown provider",
);

// حذف: داخلی ممنوع، دستی مجاز، combo حذف می‌شود
throwsWithMsg(() => removeProvider(fakeEnv, "nvidia"), /builtin/, "delete builtin blocked");
await removeProvider(fakeEnv, "my-gateway");
await removeCombo(fakeEnv, "mine");

// ── استراتژی‌های combo دستی (ترتیب هدف‌ها) ──────────────────────────────────
const T = (p, m) => ({ provider: p, model: m });
const order = (strategy, opts) =>
  sortForStrategy(
    [T("a", "m1"), T("a", "m2"), T("b", "m3"), T("c", "m4")],
    strategy,
    opts,
  ).map((t) => `${t.provider}/${t.model}`);

const prio = order("priority");
check(
  prio.join(",") === "a/m1,a/m2,b/m3,c/m4",
  `priority ترتیب اشتباه: ${prio.join(",")}`,
);
const rr = order("round-robin", { rrStart: 2 });
check(
  rr.join(",") === "b/m3,c/m4,a/m1,a/m2",
  `round-robin ترتیب اشتباه: ${rr.join(",")}`,
);
const fastestWithData = order("fastest", {
  medians: { "a/m1": 500, "b/m3": 120, "c/m4": 900 },
});
check(
  fastestWithData.join(",") === "b/m3,a/m1,c/m4,a/m2",
  `fastest ترتیب اشتباه: ${fastestWithData.join(",")}`,
);
const fastestEmpty = order("fastest", {});
check(
  fastestEmpty.join(",") === prio.join(","),
  `fastest بدون داده باید = priority: ${fastestEmpty.join(",")}`,
);

if (failures.length) {
  console.error("\n✖ شکست تست‌ها:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\n✓ همه‌ی assertهای آفلاین برقرار شد.");
