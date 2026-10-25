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

function occurrences(hay, needle) {
  return hay.split(needle).length - 1;
}

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

// ── patch 3b: صفحه‌ی /admin (لاگین، کوکی امضاشده، هدرهای امنیتی) ────────────
const workerDefault = (await import("../src/index.js")).default;
const TG_SECRET_FAKE = "fake-tg-secret-for-tests";
const env3b = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: TG_SECRET_FAKE };
const ctxNull = {};

const res0 = await workerDefault.fetch(new Request("https://admin.test/admin"), env3b, ctxNull);
check(res0.status === 200, `GET /admin باید 200 بدهد (${res0.status})`);
const csp = res0.headers.get("content-security-policy") ?? "";
check(
  csp.includes("default-src 'self'") && csp.includes("script-src 'self' 'unsafe-inline'"),
  `CSP وجود ندارد یا ناقص: ${csp}`,
);
check(res0.headers.get("x-frame-options") === "DENY", "X-Frame-Options DENY");
check(res0.headers.get("cache-control") === "no-store", "Cache-Control no-store");
const html = await res0.text();
check(html.includes("<!doctype html>"), "HTML دوباره نوشته نشده؟");
check(html.includes("en: {") && html.includes("fa: {"), "هر دو بسته‌ی زبان en/fa در DOM نیست");
check(
  html.includes("dir=\"rtl\"") || html.includes("dir='rtl'") || html.includes("rtl"),
  "XML dir rtl برای fa باید آماده باشد",
);
check(
  !html.includes(SECRET_VALUE) && !html.includes("fake-token") && !html.includes(TG_SECRET_FAKE),
  "راز جعلی در HTML نشت کرد!",
);
check(
  !html.includes("openrouter.ai") && !html.includes("integrate.api") && !html.includes("xkiro.com"),
  "داده‌ی کانفیگ (آدرس داخلی‌ها) نباید وابسته به HTML ثابت باشد",
);

// قبل از لاگین: /admin/api/config باید 401 بدهد
const pre = await workerDefault.fetch(
  new Request("https://admin.test/admin/api/config"),
  env3b,
  ctxNull,
);
check(pre.status === 401, `/config بدون احراز باید 401 بدهد (${pre.status})`);

// لاگین اشتباه: 401 و کوکی نه
const bad = await workerDefault.fetch(
  new Request("https://admin.test/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "wrong-key" }),
  }),
  env3b,
  ctxNull,
);
check(bad.status === 401, `لاگین با کلید غلط باید 401 (${bad.status})`);
check(bad.headers.get("set-cookie") === null, "کوکی با کلید غلط نباید ست شود");
check(String(await bad.text()).includes("unauthorized"), "خطای عمومی لاگین");

// لاگین درست: کوکی HttpOnly + SameSite=Strict + Secure
const good = await workerDefault.fetch(
  new Request("https://admin.test/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: TG_SECRET_FAKE }),
  }),
  env3b,
  ctxNull,
);
check(good.status === 200, `لاگین درست باید 200 (${good.status})`);
const gbody = await good.json();
check(gbody.ok === true, "بادی لاگین ok");
const sc = good.headers.get("set-cookie") ?? "";
check(
  sc.startsWith("admin_session=") && sc.includes("HttpOnly") && sc.includes("SameSite=Strict") && sc.includes("Secure"),
  `کوکی نامناسب: ${sc}`,
);
const cookieVal = sc.split(";")[0];

// کوکی امضاشده سبب دسترسی به /admin/api/config می‌شود
const authed = await workerDefault.fetch(
  new Request("https://admin.test/admin/api/config", { headers: { cookie: cookieVal } }),
  env3b,
  ctxNull,
);
check(authed.status === 200, `کوکی امضاشده کار نکرد (${authed.status})`);
const cfgJ = await authed.json();
check(cfgJ.ok === true && Array.isArray(cfgJ.providers), "با کوکی config ok");
check(
  !JSON.stringify(cfgJ).includes(TG_SECRET_FAKE),
  "مقدار راز در جواب config نشت کرد!",
);

// logout: کوکی پاک می‌شود
const out = await workerDefault.fetch(
  new Request("https://admin.test/admin/logout", { method: "POST" }),
  env3b,
  ctxNull,
);
check(out.status === 200, `logout باید 200 (${out.status})`);
const osc = out.headers.get("set-cookie") ?? "";
check(osc.includes("Max-Age=0") && osc.includes("HttpOnly"), `کوکی logout: ${osc}`);

// ── patch 3b-fix: ADMIN_KEY مجزا ────────────────────────────────────────────
const ADMIN_KEY_FAKE = "fake-admin-key-123";
const TG_SECRET_2 = "fake-tg-secret-456";
const envAk = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: TG_SECRET_2, ADMIN_KEY: ADMIN_KEY_FAKE };

// X-Setup-Key: فقط ADMIN_KEY قبول است، TG_SECRET رد می‌شود
const hAK = await workerDefault.fetch(
  new Request("https://admin.test/admin/api/config", { headers: { "X-Setup-Key": ADMIN_KEY_FAKE } }),
  envAk,
  ctxNull,
);
check(hAK.status === 200, `/api/config با ADMIN_KEY باید 200 (${hAK.status})`);
const hTG = await workerDefault.fetch(
  new Request("https://admin.test/admin/api/config", { headers: { "X-Setup-Key": TG_SECRET_2 } }),
  envAk,
  ctxNull,
);
check(hTG.status === 401, `TG_SECRET با ADMIN_KEY فعال باید رد شود (${hTG.status})`);

// لاگین با TG_SECRET رد می‌شود؛ با ADMIN_KEY قبول
const badTg = await workerDefault.fetch(
  new Request("https://admin.test/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: TG_SECRET_2 }),
  }),
  envAk,
  ctxNull,
);
check(badTg.status === 401, `لاگین TG_SECRET باید 401 باشد (${badTg.status})`);
const goodAk = await workerDefault.fetch(
  new Request("https://admin.test/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: ADMIN_KEY_FAKE }),
  }),
  envAk,
  ctxNull,
);
check(goodAk.status === 200, `لاگین ADMIN_KEY باید 200 (${goodAk.status})`);
const scAk = goodAk.headers.get("set-cookie") ?? "";
check(scAk.includes("HttpOnly") && scAk.includes("SameSite=Strict") && scAk.includes("Secure"), `کوکی: ${scAk}`);
const cookieAk = scAk.split(";")[0];
const cfgAk = await workerDefault.fetch(
  new Request("https://admin.test/admin/api/config", { headers: { cookie: cookieAk } }),
  envAk,
  ctxNull,
);
check(cfgAk.status === 200, `کوکی ADMIN_KEY باید config باز کند (${cfgAk.status})`);

// کوکی با کلید دیگری امضا شده در env دیگر (ADMIN_KEY متفاوت) کار نمی‌کند (HMAC کلید=ADMIN_KEY)
const envOther = {
  STATE: fakeKV(),
  TG_TOKEN: "fake-token",
  TG_SECRET: TG_SECRET_2,
  ADMIN_KEY: "another-admin-key-789",
};
const crossEnv = await workerDefault.fetch(
  new Request("https://admin.test/admin/api/config", { headers: { cookie: cookieAk } }),
  envOther,
  ctxNull,
);
check(crossEnv.status === 401, `کوکی ADMIN_KEY دوره‌زده باید 401 (${crossEnv.status})`);

// fallback: بدون ADMIN_KEY همان TG_SECRET کار می‌کند (X-Setup-Key و لاگین)
const hFallbackHeader = await workerDefault.fetch(
  new Request("https://admin.test/admin/api/config", { headers: { "X-Setup-Key": TG_SECRET_FAKE } }),
  env3b,
  ctxNull,
);
check(hFallbackHeader.status === 200, `fallback X-Setup-Key باید 200 (${hFallbackHeader.status})`);
// (fallback لاگین در تست 3b بالا پوشش داده می‌شود: لاگین با TG_SECRET در env3b → 200 + کوکی)

// وبهوک همچنان TG_SECRET می‌خواهد (ADMIN_KEY آن‌جا بی‌اثر است)
const ctxStub = { waitUntil: (p) => p && typeof p.catch === "function" && p.catch(() => {}) };
const tgOk = await workerDefault.fetch(
  new Request("https://admin.test/telegram", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": TG_SECRET_2 },
    body: "{}",
  }),
  envAk,
  ctxStub,
);
check(tgOk.status === 200, `/telegram با TG_SECRET باید 200 (${tgOk.status})`);
const tgVoid = await workerDefault.fetch(
  new Request("https://admin.test/telegram", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": ADMIN_KEY_FAKE },
    body: "{}",
  }),
  envAk,
  ctxNull,
);
check(tgVoid.status === 401, `/telegram با ADMIN_KEY باید 401 (${tgVoid.status})`);

// /setup (کلید X-Setup-Key) هم دیگر با TG_SECRET باز نمی‌شود وقتی ADMIN_KEY ست است
const suTg = await workerDefault.fetch(
  new Request("https://admin.test/setup", { method: "POST", headers: { "X-Setup-Key": TG_SECRET_2 } }),
  envAk,
  ctxNull,
);
check(suTg.status === 401, `/setup با TG_SECRET باید 401 (${suTg.status})`);

// ── patch 3c: UX — کانستنت‌ها، کلیدهای i18n، بدون innerHTML ─────────────────
const html2 = await (await workerDefault.fetch(new Request("https://admin.test/admin"), env3b, ctxNull)).text();
check(html2.includes("TEST_ALL_CONCURRENCY = 3"), "کانستنت concurrency باید ۳ باشد");
check(html2.includes("TEST_ALL_CAP = 60"), "کانستنت cap باید ۶۰ باشد");
check(!html2.includes("innerHTML"), "innerHTML نباید در صفحه باشد");
const keys3c = [
  "testAll", "stopBtn", "testing", "tooManyMsg", "showOnlyOk", "addedDone", "addToQ",
  "newComboOpt", "newComboHint", "testCombo", "lblTimeout", "lblAuth", "lblNotFound",
  "lblRate", "lblServer", "lblUnknown", "provHelp", "modelsHelp", "combosHelp",
  "runDone", "failedC", "fastest", "stAll", "providers", "models", "combos",
  "providerCol", "newCombo", "comboAdd", "nameRequired",
];
for (const k of keys3c) {
  const n = occurrences(html2, k + ":");
  check(n >= 2, `کلید i18n «${k}» باید در هر دو زبان باشد (${n})`);
}
// data-i18n استاتیک و دکمه‌های تب
check(html2.includes('data-tab="provTab"'), "تب provider");
check(html2.includes('data-tab="modelsTab"'), "تب models");
check(html2.includes('data-tab="combosTab"'), "تب combos");
check(html2.includes(".hidden{display:none"), "کلاس hidden باید در CSS باشد");
check(
  html2.includes('data-i18n="tabProviders"') &&
    html2.includes('data-i18n="tabModels"') &&
    html2.includes('data-i18n="tabCombos"') &&
    html2.includes('data-i18n="logout"'),
  "برچسب تب‌ها/خروج باید data-i18n داشته باشد",
);
check(!/window\.alert\s*\(/.test(html2), "alert() نباید به‌جای toast استفاده شود");

// ── patch 3d: تم، ذخیره‌ی نتایج، ریسپانسیو و کارت‌های provider ──────────────
const keys3d = [
  "themeSystem", "themeLight", "themeDark", "themeLabel", "langBtn",
  "onlyUntested", "clearAllResults", "clearProvResults", "clearConfirmAll",
  "clearConfirmProv", "clearedResults", "untested", "testedAgo", "stale",
  "nothingToTest", "noCombos", "addComboTitle", "createAndAdd", "comboNamePh",
  "goToCombo", "summaryProvider", "stoppedEarly", "saving", "loginInvalid",
  "showKey", "hideKey", "loggingIn", "adminKey", "loginTitle",
];
for (const k of keys3d) {
  const n = occurrences(html2, k + ":");
  check(n >= 2, `کلید i18n «${k}» باید در هر دو زبان باشد (${n})`);
}
check(html2.includes("admin_test_results_v1"), "کلید ذخیره‌ی نتایج تست");
check(html2.includes("admin_models_state_v1"), "کلید ذخیره‌ی وضعیت مدل‌ها");
check(html2.includes("admin_theme"), "کلید ذخیره‌ی تم");
check(html2.includes("admin_provider_status_v1"), "کلید ذخیره‌ی وضعیت provider");
check(html2.includes("RESULT_CAP = 500"), "سقف نتایج ذخیره‌شده باید ۵۰۰ باشد");
check(
  html2.includes("STALE_MS = 24 * 60 * 60 * 1000"),
  "آستانه‌ی کهنه‌شدن نتایج باید ۲۴ ساعت باشد",
);
check(
  html2.includes('[data-theme="dark"]') && html2.includes("color-scheme"),
  "متغیرهای تم تیره/روشن و color-scheme باید وجود داشته باشند",
);
check(
  html2.includes("prefers-color-scheme") && html2.includes("admin_theme"),
  "تشخیص تم سیستم و ذخیره‌سازی تم باید وجود داشته باشد",
);
check(
  html2.includes('data-theme-set="system"') &&
    html2.includes('data-theme-set="light"') &&
    html2.includes('data-theme-set="dark"'),
  "سه دکمه‌ی تم سیستم/روشن/تیره",
);
check(
  html2.includes('id="themeHeader"') && html2.includes('id="themeLogin"'),
  "کنترل تم باید هم در هدر و هم در لاگین باشد",
);
check(
  html2.includes("viewport-fit=cover"),
  "viewport باید viewport-fit=cover داشته باشد",
);
check(
  html2.includes('id="loginErr"') &&
    html2.includes('id="eyeBtn"') &&
    html2.includes('id="loginForm"') &&
    html2.includes("autofocus"),
  "فرم لاگین باید خطای درون‌خطی، نمایش کلید و autofocus داشته باشد",
);
check(
  html2.includes('id="provGrid"') &&
    html2.includes("status-area") &&
    !html2.includes("provResult") &&
    !html2.includes("provTbody"),
  "هر provider باید فقط یک ناحیه‌ی وضعیت داشته باشد",
);
check(
  html2.includes('id="mOnlyUntested"') &&
    html2.includes('id="mClearProv"') &&
    html2.includes('id="mClearAll"') &&
    html2.includes('id="mSummary"'),
  "کنترل‌های تست‌نشده/پاک‌سازی/خلاصه در تب مدل‌ها",
);
check(
  html2.includes("max-width:700px") && html2.includes("data-label"),
  "چیدمان موبایل و تبدیل جدول به کارت باید وجود داشته باشد",
);
check(
  csp ===
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';",
  `CSP نباید تغییر کند: ${csp}`,
);
check(!/\.innerHTML\s*=/.test(html2), "هیچ داده‌ای نباید با innerHTML به DOM برود");

// ── پاسخ نرمالِ تست combo ({ok,status,latencyMs,text,label}) ────────────────
const envCt = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: TG_SECRET_FAKE };
const putProv = await workerDefault.fetch(
  new Request("https://admin.test/admin/api/providers/ctprov", {
    method: "PUT",
    headers: { "content-type": "application/json", "X-Setup-Key": TG_SECRET_FAKE },
    body: JSON.stringify({ id: "ctprov", name: "ct", baseUrl: "https://127.0.0.1:9/v1", secretName: "TG_TOKEN" }),
  }),
  envCt,
  ctxNull,
);
check(putProv.status === 200, `PUT provider ctprov (${putProv.status})`);
const putCombo = await workerDefault.fetch(
  new Request("https://admin.test/admin/api/combos/ct", {
    method: "PUT",
    headers: { "content-type": "application/json", "X-Setup-Key": TG_SECRET_FAKE },
    body: JSON.stringify({
      name: "ct",
      strategy: "priority",
      timeoutMs: 2000,
      retries: 0,
      targets: [{ provider: "ctprov", model: "m1" }],
    }),
  }),
  envCt,
  ctxNull,
);
check(putCombo.status === 200, `PUT combo ct (${putCombo.status})`);

// شبکه را قطع می‌کنیم تا runCombo مسیر شکستِ «network» را برود (بدون درخواست واقعی)
const realFetch = global.fetch;
global.fetch = async () => {
  throw new Error("offline-test");
};
let comboRes;
try {
  comboRes = await workerDefault.fetch(
    new Request("https://admin.test/admin/api/test", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Setup-Key": TG_SECRET_FAKE },
      body: JSON.stringify({ combo: "ct" }),
    }),
    envCt,
    ctxNull,
  );
} finally {
  global.fetch = realFetch;
}
check(comboRes.status === 200, `تست combo باید 200 (${comboRes.status})`);
const cb = await comboRes.json();
check(
  cb.ok === false &&
    cb.combo === "ct" &&
    cb.status === null &&
    typeof cb.latencyMs === "number" &&
    cb.text === "" &&
    cb.label === "unknown",
  `شکل نرمال تست combo: ${JSON.stringify(cb)}`,
);

if (failures.length) {
  console.error("\n✖ شکست تست‌ها:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\n✓ همه‌ی assertهای آفلاین برقرار شد.");
