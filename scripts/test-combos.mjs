// تست آفلاین (بدون شبکه/KV/راز): از فایل‌های فیکسچر در ریشه‌ی پروژه استفاده می‌کند.
// xk-models.json، nv-models.json، or-models.json — فقط آی‌دی‌های عمومی؛ gitignored
// و هرگز کامیت نمی‌شوند. فایل نبود → رد با پیام؛ or-models.json اگر object خطا بود
// نه لیست → رد با پیام. اجرا: node scripts/test-combos.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RULES, pickModels, diversify } from "../src/combos.js";
import { mapNvidia, mapXkiro, mapOpenRouter } from "../src/providers.js";

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

if (failures.length) {
  console.error("\n✖ شکست تست‌ها:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\n✓ همه‌ی assertهای آفلاین برقرار شد.");
