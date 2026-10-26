// تست آفلاین (بدون شبکه/KV/راز): از فایل‌های فیکسچر در ریشه‌ی پروژه استفاده می‌کند.
// xk-models.json، nv-models.json، or-models.json — فقط آی‌دی‌های عمومی؛ gitignored
// و هرگز کامیت نمی‌شوند. فایل نبود → رد با پیام؛ or-models.json اگر object خطا بود
// نه لیست → رد با پیام. اجرا: node scripts/test-combos.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RULES, pickModels, diversify, WEIGHTS } from "../src/combos.js";
import { mapNvidia, mapXkiro, mapOpenRouter } from "../src/providers.js";
import { classifyFailure, sortForStrategy, normalizeOpenAiChat, runCombo } from "../src/router.js";
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
import {
  classifyTask,
  comboCandidates,
  fallbackCombo,
  selectCombo,
  BUILTIN_COMBOS,
  updateHasImage,
} from "../src/task-route.js";
import { DEFAULT_PREFS, normalizePrefs, getPrefs, setPrefs, prefsKey } from "../src/tgprefs.js";

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

// فیکسچرها gitignored هستند؛ نبودشان فقط بخش‌های وابسته به کاتالوگ را رد می‌کند.
const hasCatalog = catalog.length > 0;
if (!hasCatalog) {
  console.warn(
    "⚠ هیچ فیکسچری در دسترس نبود — assertهای وابسته به کاتالوگ رد می‌شوند؛ بقیه اجرا می‌شوند.",
  );
} else {
  console.log(`کاتالوگ آزمایشی: ${catalog.length} مدل [${[...new Set(catalog.map((m) => m.provider))].join(", ")}]`);
}

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
if (hasCatalog) {
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
} else {
  console.log("\n== combo scoring ==\n  (بدون فیکسچر رد شد)");
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

// ── patch 3e: xkiro 48 free models sync & combo kinds / capability tags ──────
import { mapXkiroDetailed, listProviderModelsDetailed } from "../src/providers.js";
import { COMBO_KINDS, capabilityTags, orderCombosForModel, autoFillTargets } from "../src/combos.js";

const mockXkiroList = [];
// پسوند :free بدون access_tier → fallback رایگان؛ tier همیشه برنده است.
for (let i = 0; i < 20; i++) {
  mockXkiroList.push({ id: `xkiro/model-suffix-${i}:free` });
}
for (let i = 0; i < 28; i++) {
  mockXkiroList.push({ id: `xkiro/model-tier-${i}`, access_tier: "free", pricing: { input: 0, output: 0 } });
}
for (let i = 0; i < 5; i++) {
  mockXkiroList.push({ id: `xkiro/paid-model-${i}`, access_tier: "paid", pricing: { input: "0.05" } });
}
const xkRes = mapXkiroDetailed(mockXkiroList);
check(xkRes.models.length === 48, `xkiro باید دقیقا 48 مدل رایگان نگه دارد (${xkRes.models.length})`);
check(xkRes.dropped.length === 5, `xkiro باید 5 مدل پولی را حذف کند (${xkRes.dropped.length})`);
// tier paid حتی با پسوند :free و قیمت صفر باید رد شود (قاعده‌ی عمدی)
const xkStrict = mapXkiroDetailed([{ id: "xkiro/ghost:free", access_tier: "paid", pricing: { input: 0, output: 0 } }]);
check(xkStrict.models.length === 0 && xkStrict.dropped.length === 1, "tier paid با پسوند :free هم باید رد شود");

const env3e = { STATE: fakeKV(), XKIRO_API_KEY: "fake-key" };
const mockFetch = global.fetch;
global.fetch = async () => new Response(JSON.stringify({ object: "list", data: mockXkiroList }), { status: 200 });
try {
  await upsertProvider(env3e, { id: "xkiro", baseUrl: "https://api.xkiro.com/v1", secretName: "XKIRO_API_KEY", builtin: true });
  const sr = await listProviderModelsDetailed(env3e, { id: "xkiro", baseUrl: "https://api.xkiro.com/v1", secretName: "XKIRO_API_KEY", builtin: true });
  check(sr.sync.fetched === 53 && sr.sync.kept === 48 && sr.sync.droppedCount === 5, `گزارش sync نامعتبر: ${JSON.stringify(sr.sync)}`);
} finally {
  global.fetch = mockFetch;
}

check(COMBO_KINDS.includes("code") && COMBO_KINDS.includes("vision") && COMBO_KINDS.includes("custom"), "COMBO_KINDS ناقص");
const tags1 = capabilityTags({ id: "qwen/qwen3-vl-plus:free", capabilities: { vision: true } });
check(tags1.includes("vision"), "تشخیص تگ vision ناموفق");
const tags2 = capabilityTags({ id: "deepseek/deepseek-r1-distill" });
check(tags2.includes("reasoning"), "تشخیص تگ reasoning ناموفق");

const ordered = orderCombosForModel([{ name: "codeCombo", kind: "code" }, { name: "textCombo", kind: "text" }], ["coder"]);
check(ordered[0].combo.name === "codeCombo", "مرتبسازی comboها بر اساس قابلیت coder اشتباه است");

const fakeResults = {
  "xkiro/qwen3-coder:free": { ok: true, latencyMs: 150, testedAt: Date.now() },
  "xkiro/qwen3-vision:free": { ok: true, latencyMs: 100, testedAt: Date.now() }
};
const autoFilled = autoFillTargets(fakeResults, { kind: "code", limit: 5, tagsByKey: { "xkiro/qwen3-coder:free": ["coder"], "xkiro/qwen3-vision:free": ["vision"] } });
check(autoFilled.length === 1 && autoFilled[0].model === "qwen3-coder:free", `auto-fill برای kind code باید فقط مدل coder را بردارد (${JSON.stringify(autoFilled)})`);

// ── patch 3f: مسیریابی تسک تلگرام، prefs هر کاربر، 502 با available ─────────

// 1) classifyTask — en/fa/خالی/مختلط/hasImage
check(classifyTask("hello there") === "chat", "متن عادی باید chat باشد");
check(classifyTask("") === "chat", "متن خالی باید chat باشد");
check(classifyTask(undefined) === "chat", ".undefined باید chat باشد");
check(classifyTask("hi, how was your day?") === "chat", "جمله‌ی عادی انگلیسی باید chat باشد");
check(classifyTask("```js\nconst x = 1;\n```") === "code", "fence باید code باشد");
check(classifyTask("def foo(x):\n    return x") === "code", "def باید code باشد");
check(classifyTask("function foo() { return 1; }") === "code", "function باید code باشد");
check(classifyTask("class Foo { }") === "code", "class باید code باشد");
check(
  classifyTask("TypeError: x is not a function\n    at foo (app.js:10:5)") === "code",
  "stack trace باید code باشد",
);
check(
  classifyTask("python says:\nTraceback (most recent call last):\n  File \"x.py\", line 3") === "code",
  "python traceback باید code باشد",
);
check(classifyTask("look at src/index.ts") === "code", "پسوند ts باید code باشد");
check(classifyTask("open main.go and main.py") === "code", "پسوند go/py باید code باشد");
check(classifyTask("I have a bug in this") === "code", "bug باید code باشد");
check(classifyTask("write a SQL query please") === "code", "sql باید code باشد");
check(classifyTask("این کد را بررسی کن") === "code", "کد فارسی باید code باشد");
check(classifyTask("باگ دارد این") === "code", "باگ باید code باشد");
check(classifyTask("این خطا چیست؟") === "code", "خطا باید code باشد");
check(classifyTask("این تابع را توضیح بده") === "code", "تابع باید code باشد");
check(classifyTask("کدام مدل بهتر است؟") === "chat", "کدام نباید کد حساب شود");
check(classifyTask("سلام، خوبی؟") === "chat", "جمله‌ی عادی فارسی باید chat باشد");
check(classifyTask("hello", { hasImage: true }) === "vision", "hasImage باید vision بدهد");
check(classifyTask("", { hasImage: true }) === "vision", "عکس بدون متن باید vision بدهد");
check(classifyTask({ text: "hello", photo: [{ file_id: "x" }] }) === "vision", "photo در update باید vision بدهد");
check(classifyTask({ text: "hello", document: { mime_type: "image/png" } }) === "vision", "document تصویری باید vision بدهد");
check(classifyTask({ text: "hello", document: { mime_type: "application/pdf" } }) === "chat", "pdf باید chat بماند");
check(updateHasImage({ photo: [{}] }) === true, "updateHasImage photo");
check(updateHasImage({ document: { mime_type: "text/plain" } }) === false, "updateHasImage غیرتصویری");

// 2) prefs — validate/defaults/cap/unknown fields + KV
check(normalizePrefs(null).combo === null && normalizePrefs(null).auto === true && normalizePrefs(null).show === false, "پیش‌فرض prefs");
check(normalizePrefs("x").auto === true, "بدنه‌ی غیر object باید پیش‌فرض بدهد");
check(!("junk" in normalizePrefs({ combo: "code", auto: false, show: true, junk: "x" })), "فیلد ناشناس نادیده گرفته شود");
const bad1 = normalizePrefs({ combo: "BAD NAME", auto: "yes", show: 1 });
check(bad1.combo === null && bad1.auto === true && bad1.show === false, "مقادیر نامعتبر باید پیش‌فرض بمانند");
check(normalizePrefs({ combo: "a".repeat(100) }).combo === null, "سقف طول combo باید رعایت شود");
check(normalizePrefs({ combo: "my-co.1_x" }).combo === "my-co.1_x", "نام معتبر باید بماند");
const persistDefaults = await getPrefs({ STATE: null }, 1);
check(persistDefaults.combo === null && persistDefaults.auto === true && persistDefaults.show === false, "بدون KV پیش‌فرض");

const kvPrefs = fakeKV();
const envPrefs = { STATE: kvPrefs };
const p0 = await getPrefs(envPrefs, 123);
check(p0.combo === null && p0.auto === true && p0.show === false, "getPrefs بدون کلید = پیش‌فرض");
const p1 = await setPrefs(envPrefs, 123, { combo: "code", auto: false });
check(p1.combo === "code" && p1.auto === false && p1.show === false, "setPrefs");
check(kvPrefs.store.has(prefsKey(123)), "کلید tgprefs:<userId>");
check(JSON.stringify(kvPrefs.store.get(prefsKey(123))) !== null && !String(kvPrefs.store.get(prefsKey(123))).includes("junk"), "KV فقط فیلدهای معتبر");
const p2 = await setPrefs(envPrefs, 123, { show: true, evil: "h" });
check(p2.show === true && p2.combo === "code" && !("evil" in p2), "patch روی مقادیر فعلی و بدون فیلد ناشناس");
check((await getPrefs(envPrefs, "abc")).auto === true, "userId غیر عددی باید پیش‌فرض بدهد");

// 3) ترتیب انتخاب combo (auto on/off، کمبود، fallback)
const baseP = { combo: null, auto: true, show: false };
check(comboCandidates(baseP, "code").join(",") === "code,chat", `auto روشن: ترتیب ${comboCandidates(baseP, "code")}`);
check(comboCandidates({ ...baseP, auto: false }, "code").join(",") === "chat", "auto خاموش چون فقط پیش‌فرض");
check(comboCandidates({ ...baseP, combo: "mine" }, "code").join(",") === "code,mine,chat", "auto + پیش‌فرض دستی");
check(comboCandidates({ ...baseP, combo: "mine" }, "chat").join(",") === "chat,mine", "task chat: chat اول (auto)");
check(comboCandidates(null, undefined).join(",") === "chat", "بدون prefs/task = chat");
check(fallbackCombo("mine", "code") === "mine", "fallback به پیش‌فرض کاربر");
check(fallbackCombo("mine", "mine") === "chat", "fallback پیش‌فرض == انتخاب → chat");
check(fallbackCombo("chat", "chat") === null, "fallback همان chat → هیچ");
check(fallbackCombo(null, "chat") === null, "پیش‌فرض null == chat → هیچ");
const selKnown = selectCombo({ combo: "mine", auto: true, show: false }, "code", {
  isKnown: (n) => ["mine", "chat"].includes(n),
  isUsable: () => true,
});
check(selKnown.combo === "mine" && selKnown.fallback === "chat", `combo گمشده → پیش‌فرض (${JSON.stringify(selKnown)})`);
const selUnusable = selectCombo({ combo: "mine", auto: true, show: false }, "code", {
  isKnown: () => true,
  isUsable: (n) => n === "chat",
});
check(selUnusable.combo === "chat", `هدف نداشتن → chat (${JSON.stringify(selUnusable)})`);
const selChat = selectCombo(baseP, "chat", { isKnown: (n) => BUILTIN_COMBOS.includes(n), isUsable: () => true });
check(selChat.combo === "chat", "task chat → chat");
check(BUILTIN_COMBOS.join(",") === "chat,code,vision,fast", "BUILTIN_COMBOS");

// 4) 502 با available
const env502 = { STATE: fakeKV(), ROUTER_KEY: "fake-router-key" };
await upsertCombo(env502, {
  name: "apicomb",
  kind: "custom",
  strategy: "priority",
  timeoutMs: 20000,
  retries: 0,
  targets: [{ provider: "nvidia", model: "z-ai/glm-5.3" }],
});
const res502 = await workerDefault.fetch(
  new Request("https://admin.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer fake-router-key" },
    body: JSON.stringify({ model: "no-such-combo", messages: [{ role: "user", content: "hi" }] }),
  }),
  env502,
  ctxNull,
);
check(res502.status === 502, `unknown body.model باید 502 بماند (${res502.status})`);
const j502 = await res502.json();
check(
  j502.ok === false &&
    Array.isArray(j502.available) &&
    j502.available.includes("apicomb") &&
    j502.available.includes("chat") &&
    j502.available.includes("code") &&
    j502.available.length <= 50,
  `502 باید available معتبر بدهد (${JSON.stringify(j502.available)})`,
);

// 5) /admin/api/auto/<name> — انتخاب زنده با کاتالوگ seeder شده
const envAuto = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: TG_SECRET_FAKE };
await envAuto.STATE.put(
  "catalog:nvidia",
  JSON.stringify({ updatedAt: new Date().toISOString(), models: catalog.filter((m) => m.provider === "nvidia") }),
);
const rAuto404 = await workerDefault.fetch(
  new Request("https://admin.test/admin/api/auto/ghost", { headers: { "X-Setup-Key": TG_SECRET_FAKE } }),
  envAuto,
  ctxNull,
);
check(rAuto404.status === 404, `auto ناشناس باید 404 (${rAuto404.status})`);
const rAuto = await workerDefault.fetch(
  new Request("https://admin.test/admin/api/auto/code", { headers: { "X-Setup-Key": TG_SECRET_FAKE } }),
  envAuto,
  ctxNull,
);
if (hasCatalog) {
  check(rAuto.status === 200, `auto code باید 200 (${rAuto.status})`);
  const jAuto = await rAuto.json();
  check(
    jAuto.ok === true && jAuto.name === "code" && jAuto.kind === "code" && Array.isArray(jAuto.targets) &&
      jAuto.targets.length >= 1 && jAuto.targets.length <= 8 &&
      jAuto.targets.every((t) => t.provider && t.model && t.enabled === true),
    `شکل auto code: ${JSON.stringify(jAuto)}`,
  );
} else {
  check(rAuto.status === 400, `auto بدون کاتالوگ باید 400 (${rAuto.status})`);
}

// 6) دستورهای تلگرام — /combo list/set/reject/clear، /route، /showmodel، /help
function tgCapture() {
  const sent = [];
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    const m = /\/bot[^/]+\/(\w+)$/.exec(u);
    let payload = null;
    try {
      payload = JSON.parse(String(init?.body ?? "{}"));
    } catch {
      payload = {};
    }
    if (m) sent.push({ method: m[1], payload });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    sent,
    restore() {
      global.fetch = orig;
    },
  };
}

const envTg = { STATE: fakeKV(), TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret-cmd", ALLOWED_TG_IDS: "4242" };
await upsertCombo(envTg, {
  name: "mine",
  kind: "custom",
  strategy: "priority",
  timeoutMs: 20000,
  retries: 0,
  targets: [{ provider: "nvidia", model: "z-ai/glm-5.3" }],
});

async function sendTg(env, rawUpdate, userId = 4242) {
  const cap = tgCapture();
  const pending = [];
  try {
    const res = await workerDefault.fetch(
      new Request("https://admin.test/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": env.TG_SECRET },
        body: JSON.stringify(rawUpdate), // اگر string بود مستقیم می‌شود innerText، ولی به JSON.stringify سپرده می‌شود
      }),
      env,
      { waitUntil: (p) => pending.push(p) },
    );
    check(res.status === 200, `/telegram باید 200 بدهد (${res.status})`);
    await Promise.all(pending);
  } finally {
    cap.restore();
  }
  return cap.sent
    .filter((c) => c.method === "sendMessage" && typeof c.payload.text === "string")
    .map((c) => c.payload.text)
    .join("\n---\n");
}

const tgUpdate = (text, userId = 4242) => ({
  message: { text, from: { id: userId }, chat: { id: userId } },
});

const outList = await sendTg(envTg, tgUpdate("/combo"));
check(outList.includes("mine") && outList.includes("chat") && outList.includes("code") && outList.includes("vision") && outList.includes("fast"), `/combo باید دستی + داخلی را لیست کند: ${outList.slice(0, 200)}`);
check(outList.includes("auto") && outList.includes("combo فعلی: chat"), `/combo باید انتخاب فعلی را بگوید: ${outList.slice(0, 160)}`);

await sendTg(envTg, tgUpdate("/combo mine"));
let prefsCmd = await getPrefs(envTg, 4242);
check(prefsCmd.combo === "mine" && prefsCmd.auto === true && prefsCmd.show === false, `پس از /combo mine: ${JSON.stringify(prefsCmd)}`);

const outReject = await sendTg(envTg, tgUpdate("/combo nope"));
check(outReject.includes("nope") && outReject.includes("mine") && outReject.includes("chat"), `/combo ناشناس باید معتبرها را لیست کند: ${outReject.slice(0, 200)}`);
prefsCmd = await getPrefs(envTg, 4242);
check(prefsCmd.combo === "mine", "رد شدن نباید selection را عوض کند");

const outSwitch = await sendTg(envTg, tgUpdate("/combo code"));
check(outSwitch.includes("code"), `/combo code باید تایید شود: ${outSwitch}`);
check((await getPrefs(envTg, 4242)).combo === "code", "کامبوی داخلی هم انتخاب می‌شود");

await sendTg(envTg, tgUpdate("/combo clear"));
prefsCmd = await getPrefs(envTg, 4242);
check(prefsCmd.combo === null, "clear باید combo=null");

await sendTg(envTg, tgUpdate("/route off"));
prefsCmd = await getPrefs(envTg, 4242);
check(prefsCmd.auto === false && prefsCmd.combo === null, `پس از /route off: ${JSON.stringify(prefsCmd)}`);

const outToggleBad = await sendTg(envTg, tgUpdate("/route maybe"));
check(outToggleBad.includes("on|off"), "فرمت غلط toggle باید راهنما بدهد");
check((await getPrefs(envTg, 4242)).auto === false, "فرمت غلط نباید مقدار را عوض کند");

await sendTg(envTg, tgUpdate("/route on"));
check((await getPrefs(envTg, 4242)).auto === true, "/route on");

await sendTg(envTg, tgUpdate("/showmodel on"));
prefsCmd = await getPrefs(envTg, 4242);
check(prefsCmd.show === true, "/showmodel on");

await sendTg(envTg, tgUpdate("/showmodel off"));
check((await getPrefs(envTg, 4242)).show === false, "/showmodel off");

const outHelp = await sendTg(envTg, tgUpdate("/help"));
check(
  outHelp.includes("/combo") && outHelp.includes("/route") && outHelp.includes("/showmodel") && outHelp.includes("/models"),
  `/help باید دستورهای تازه را بگوید: ${outHelp.slice(0, 160)}`,
);

// کاربر غیر از allowlist پاسخی نمی‌گیرد
const outStranger = await sendTg(envTg, tgUpdate("/combo", 9999));
check(outStranger === "", `کاربر خارج از allowlist نباید جواب بگیرد (${outStranger.slice(0, 80)})`);

// 7) پنل: کلیدهای i18n تازه (en/fa)، autoList، بدون innerHTML، هدرها بدون تغییر
const keys3f = [
  "autoCombos", "autoHelp", "autoBadge", "autoReadonly", "createManualCopy",
  "copyCreated", "copyExists", "copyEmpty", "manualCombos",
];
for (const k of keys3f) {
  const n = occurrences(html2, k + ":");
  check(n >= 2, `کلید i18n «${k}» باید در هر دو زبان باشد (${n})`);
}
check(html2.includes('id="autoList"'), "ظرف کارت‌های auto در تب Comboها");
check(html2.includes('data-i18n="autoCombos"') && html2.includes('data-i18n="manualCombos"'), "سرصفحه‌های auto/دستی باید data-i18n داشته باشند");
check(html2.includes("AUTO_KINDS") && html2.includes("createManualCopy"), "منطق ساخت نسخه‌ی دستی در JS");
check(!html2.includes("innerHTML"), "باز باید بدون innerHTML باشد");
const adminHdr = await workerDefault.fetch(new Request("https://admin.test/admin"), env3b, ctxNull);
check(
  adminHdr.headers.get("content-security-policy") === csp &&
    adminHdr.headers.get("x-frame-options") === "DENY" &&
    adminHdr.headers.get("cache-control") === "no-store",
  "هدرهای /admin نباید تغییر کنند",
);

// ── patch 3g: /v1 API — auth/streایm/tool_calls/fallback/models ─────────────

const ROUTER_KEY_3G = "router-key-3g";
const bearerHeaders = (key = ROUTER_KEY_3G) => ({
  "content-type": "application/json",
  authorization: `Bearer ${key}`,
});

function v1Env() {
  return {
    STATE: fakeKV(),
    TG_TOKEN: "fake-provider-key-1",
    TG_SECRET: "fake-tg-secret-3g",
    ROUTER_KEY: ROUTER_KEY_3G,
  };
}

// combo دستی «vc» روی provider مستقل (secret هم TG_TOKEN است — جعلی)
async function seedV1(env, targets) {
  await upsertProvider(env, {
    id: "gwprov",
    name: "gwprov",
    baseUrl: "https://gw.example.com/v1",
    secretName: "TG_TOKEN",
    enabled: true,
  });
  await upsertCombo(env, {
    name: "vc",
    kind: "custom",
    strategy: "priority",
    timeoutMs: 8000,
    retries: 0,
    targets,
  });
}

const v1Target = (model) => ({ provider: "gwprov", model, enabled: true });

function mockUpstreamQueue(responses) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init ? String(init.body) : null });
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected upstream call #${calls.length}`);
    return typeof next === "function" ? next(calls[calls.length - 1], calls) : next;
  };
  return {
    calls,
    restore() {
      global.fetch = real;
    },
  };
}

function sseResponse(lines) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function brokenSseResponse(lines) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line));
      // error() صف‌ها را خالی می‌کند — خطا بعد از تحویل chunk اول تریگر می‌شود
      setTimeout(() => controller.error(new Error("upstream died mid-stream")), 20);
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const chatOk = () => ({
  id: "cmpl-1",
  object: "chat.completion",
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "OK!" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
});

const v1ChatReq = (extra, key = ROUTER_KEY_3G) =>
  new Request("https://v1.test/v1/chat/completions", {
    method: "POST",
    headers: bearerHeaders(key),
    body: JSON.stringify({
      model: "combo/vc",
      messages: [{ role: "user", content: "say OK" }],
      ...extra,
    }),
  });

// 1) نرمال‌سازی پاسخ (pure)
{
  const n = normalizeOpenAiChat({
    id: "x",
    choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function" }] } }],
    reasoning_note: "keep-me",
  });
  check(n.usage && n.usage.prompt_tokens === 0, "usage جاافتاده باید نرمال شود (صفر)");
  check(n.choices[0].finish_reason === "tool_calls", "finish_reason جاافتاده برای tool_calls");
  check(n.reasoning_note === "keep-me", "فیلد extra نباید حذف شود");
  check(n.object === "chat.completion" && Number.isInteger(n.created), "object/created جاافتاده");
  const n2 = normalizeOpenAiChat({
    choices: [{ message: { content: "hi" }, reasoning_content: "step" }],
    usage: { prompt_tokens: 5 },
  });
  check(n2.choices[0].finish_reason === "stop" && n2.choices[0].message.role === "assistant", "نرمال پیام ساده");
  check(n2.choices[0].reasoning_content === "step", "reasoning_content حفظ شود");
  check(n2.usage.completion_tokens === 0 && n2.usage.prompt_tokens === 5, "usage partial merge");
}

// 2) ROUTER_KEY ست نشده → /v1 باید 503 بدهد (بسته، نه باز)
{
  const env = v1Env();
  delete env.ROUTER_KEY;
  const r1 = await workerDefault.fetch(v1ChatReq({}), env, ctxNull);
  check(r1.status === 503, `بدون ROUTER_KEY باید 503 (${r1.status})`);
  const j1 = await r1.json();
  check(j1.error && j1.error.type === "api_error", `503 باید OpenAI error بدهد (${JSON.stringify(j1)})`);
  await seedV1(env, [v1Target("m1")]);
  const r2 = await workerDefault.fetch(
    new Request("https://v1.test/v1/models", { headers: bearerHeaders() }),
    env,
    ctxNull,
  );
  check(r2.status === 503, `/v1/models بدون ROUTER_KEY باید 503 (${r2.status})`);
}

// 3) کلید غلط/نبودن هدر → 401 با error.style OpenAI
{
  const env = v1Env();
  const mk = (e) =>
    workerDefault.fetch(
      new Request("https://v1.test/v1/chat/completions", {
        method: "POST",
        headers: e,
        body: JSON.stringify({ model: "combo/vc", messages: [{ role: "user", content: "x" }] }),
      }),
      env,
      ctxNull,
    );
  const noHeader = await mk({ "content-type": "application/json" });
  check(noHeader.status === 401, `بدون هدر باید 401 (${noHeader.status})`);
  const wrong = await mk({ "content-type": "application/json", authorization: "Bearer wrong" });
  const jw = await wrong.json();
  check(wrong.status === 401 && jw.error?.type === "authentication_error", `401 OpenAI style: ${JSON.stringify(jw)}`);
  check(!JSON.stringify(jw).includes(ROUTER_KEY_3G), "کلید درست در 401 نباید نشت کند");
}

// 4) چت non-stream — body کامل forward و پاسخ نرمال
{
  const env = v1Env();
  await seedV1(env, [v1Target("m1")]);
  const mock = mockUpstreamQueue([
    new Response(
      JSON.stringify({
        id: "cmpl-2",
        choices: [{ index: 0, message: { content: "OK!" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  ]);
  let res;
  try {
    res = await workerDefault.fetch(
      v1ChatReq({
        temperature: 0.5,
        max_tokens: 123,
        tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
        tool_choice: "auto",
      }),
      env,
      ctxNull,
    );
  } finally {
    mock.restore();
  }
  check(res.status === 200, `non-stream باید 200 (${res.status})`);
  const j = await res.json();
  check(j.choices?.[0]?.message?.content === "OK!", `محتوای پاسخ: ${JSON.stringify(j).slice(0, 120)}`);
  check(typeof j.usage === "object" && j.choices[0].finish_reason === "stop", "پاسخ نرمال usage/finish_reason");
  check(res.headers.get("X-Router-Used") === "gwprov/m1", `X-Router-Used: ${res.headers.get("X-Router-Used")}`);
  const sent = JSON.parse(mock.calls[0].body);
  check(Array.isArray(sent.tools) && sent.tool_choice === "auto", "tools/tool_choice باید forward شود");
  check(sent.temperature === 0.5 && sent.max_tokens === 123, "temperature/max_tokens باید forward شود");
  check(Array.isArray(sent.messages) && sent.stream === undefined, "messages forward و بدون stream");
  check(sent.model === "m1", `model upstream باید m1 باشد (${sent.model})`);
  check(!sent.model.includes("combo/"), "پیشوند combo/ نباید به upstream برود");
}

// 5) استریم — chunks متوالی و [DONE]
{
  const env = v1Env();
  await seedV1(env, [v1Target("m1")]);
  const mock = mockUpstreamQueue([
    sseResponse([
      'data: {"id":"s1","choices":[{"delta":{"content":"He"}}]}\n\n',
      'data: {"id":"s1","choices":[{"delta":{"content":"y"}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  ]);
  let res;
  try {
    res = await workerDefault.fetch(v1ChatReq({ stream: true }), env, ctxNull);
  } finally {
    mock.restore();
  }
  check(res.status === 200, `stream باید 200 (${res.status})`);
  check(String(res.headers.get("content-type")).includes("event-stream"), "content-type stream");
  const text = await res.text();
  check(text.includes('"content":"He"') && text.includes('"content":"y"'), "هر دو chunk باید برسند");
  check(text.trimEnd().endsWith("[DONE]"), "استریم باید با [DONE] تمام شود");
}

// 6) tool_calls non-stream — content null + tool_calls باید موفق بماند
{
  const env = v1Env();
  await seedV1(env, [v1Target("m1")]);
  const toolCalls = [
    { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Tehran"}' } },
  ];
  const mock = mockUpstreamQueue([
    new Response(
      JSON.stringify({
        id: "cmpl-3",
        choices: [
          { index: 0, message: { role: "assistant", content: null, tool_calls: toolCalls }, finish_reason: "tool_calls" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  ]);
  let res;
  try {
    res = await workerDefault.fetch(
      v1ChatReq({
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
      }),
      env,
      ctxNull,
    );
  } finally {
    mock.restore();
  }
  check(res.status === 200, `tool-only reply نباید رد شود (${res.status})`);
  const j = await res.json();
  check(JSON.stringify(j.choices?.[0]?.message?.tool_calls) === JSON.stringify(toolCalls), "tool_calls باید بدون تغییر پاس شوند");
}

// 7) tool_calls در استریم — delta.tool_calls پاس می‌شود
{
  const env = v1Env();
  await seedV1(env, [v1Target("m1")]);
  const mock = mockUpstreamQueue([
    sseResponse([
      'data: {"id":"s2","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Tehran\\"}"}}]}}]}\n\n',
      'data: {"id":"s2","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  ]);
  let res;
  try {
    res = await workerDefault.fetch(v1ChatReq({ stream: true, tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }] }), env, ctxNull);
  } finally {
    mock.restore();
  }
  const text = await res.text();
  check(res.status === 200 && text.includes('"name":"get_weather"') && /"arguments":"\{\\"city\\"/.test(text), "delta.tool_calls پاس شد");
  check(text.trimEnd().endsWith("[DONE]"), "استریم tool با [DONE]");
}

// 8) fallback روی 429 و 5xx — قبل از اولین بایت مجاز است
for (const [label, status] of [["429", 429], ["5xx", 500]]) {
  const env = v1Env();
  await seedV1(env, [v1Target("m1"), v1Target("m2")]);
  const mock = mockUpstreamQueue([
    new Response(JSON.stringify({ error: { message: "slow down" } }), { status }),
    new Response(JSON.stringify(chatOk()), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  let res;
  try {
    res = await workerDefault.fetch(v1ChatReq({}), env, ctxNull);
  } finally {
    mock.restore();
  }
  check(res.status === 200, `fallback ${label} باید 200 بدهد (${res.status})`);
  check(mock.calls.length === 2, `fallback ${label}: دو بار فراخوانی (${mock.calls.length})`);
  const sent2 = JSON.parse(mock.calls[1].body);
  check(sent2.model === "m2", `هدف دوم باید m2 باشد (${sent2.model})`);
  check(String(res.headers.get("X-Router-Used")).includes("m2"), "X-Router-Used هدف دوم");
  const j = await res.json();
  check(j.choices?.[0]?.message?.content === "OK!", `fallback ${label}: محتوا`);
}

// 9) خطا در میانه‌ی استریم — بدون fallback؛ رویداد SSE خطا و پایان تمیز
{
  const env = v1Env();
  await seedV1(env, [v1Target("m1"), v1Target("m2")]);
  const mock = mockUpstreamQueue([brokenSseResponse(['data: {"id":"s3","choices":[{"delta":{"content":"first"}}]}\n\n'])]);
  let res;
  try {
    res = await workerDefault.fetch(v1ChatReq({ stream: true }), env, ctxNull);
  } finally {
    mock.restore();
  }
  check(res.status === 200, `استریم باید 200 شروع شود (${res.status})`);
  const text = await res.text();
  check(
    mock.calls.length === 1,
    `بعد از اولین بایت نباید fallback باشد (${mock.calls.length} فراخوانی)`,
  );
  check(text.includes('"content":"first"'), "chunk اول باید رسیده باشد");
  check(text.includes('"error"') && text.includes("upstream_stream_failed"), "رویداد خطای SSE");
}

// 10) مدل ناشناس → 502 با شکل OpenAI + available
{
  const env = v1Env();
  await seedV1(env, [v1Target("m1")]);
  const res = await workerDefault.fetch(
    new Request("https://v1.test/v1/chat/completions", {
      method: "POST",
      headers: bearerHeaders(),
      body: JSON.stringify({ model: "combo/ghost", messages: [{ role: "user", content: "x" }] }),
    }),
    env,
    ctxNull,
  );
  check(res.status === 502, `مدل ناشناس باید 502 (${res.status})`);
  const j = await res.json();
  check(j.error?.message && j.error?.type === "api_error" && j.error?.code === "combo_unavailable", `OpenAI error: ${JSON.stringify(j.error)}`);
  check(Array.isArray(j.available) && j.available.includes("vc") && j.available.includes("chat"), `available: ${JSON.stringify(j.available)}`);
}

// 11) /v1/models — comboها با combo/<name> و owned_by "router"
{
  const env = v1Env();
  await seedV1(env, [v1Target("m1")]);
  const res = await workerDefault.fetch(
    new Request("https://v1.test/v1/models", { headers: bearerHeaders() }),
    env,
    ctxNull,
  );
  check(res.status === 200, `/v1/models باید 200 (${res.status})`);
  const j = await res.json();
  const ids = (j.data ?? []).map((m) => m.id);
  check(j.object === "list" && Array.isArray(j.data), "شکل list");
  check(ids.includes("combo/vc") && ids.includes("combo/chat") && ids.includes("combo/code"), `combo/<name>: ${JSON.stringify(ids)}`);
  const vc = j.data.find((m) => m.id === "combo/vc");
  check(vc.owned_by === "router" && vc.object === "model", `owned_by router: ${JSON.stringify(vc)}`);
  check(!JSON.stringify(j).includes(ROUTER_KEY_3G) && !JSON.stringify(j).includes(env.TG_TOKEN), "هیچ رازی در models نباید بیاید");
}

// 12) runCombo مستقیم با نام ساده‌ی combo دستی (رفتار سازگار تلگرام)
{
  const env = v1Env();
  await seedV1(env, [v1Target("m1")]);
  const mock = mockUpstreamQueue([new Response(JSON.stringify(chatOk()), { status: 200, headers: { "content-type": "application/json" } })]);
  let r;
  try {
    r = await runCombo(env, "vc", { messages: [{ role: "user", content: "ok" }] }, {});
  } finally {
    mock.restore();
  }
  check(r.ok === true && r.used === "gwprov/m1" && r.data?.choices?.[0]?.message?.content === "OK!", `runCombo نام ساده: ${JSON.stringify(r).slice(0, 200)}`);
}

if (failures.length) {
  console.error("\nFailures found:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\n✓ همه‌ی assertهای آفلاین برقرار شد.");
