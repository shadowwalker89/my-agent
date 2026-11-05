import { redact } from "./providers.js";
import { RULES, pickModels, diversify, compilePrefer, scoreModel } from "./combos.js";
import { getProviderCtx, getConfig } from "./config.js";
import { loadCatalog } from "./catalog.js";
import { getOverrides, resolvePins } from "./overrides.js";
import {
  getUnhealthyProviders,
  isModelHealthy,
  markFailure,
  recordLatency,
  getMedianLatency,
} from "./health.js";
import {
  getOpenProviderCircuits,
  getVerifiedLatencies,
  recordProviderCircuitFailure,
  recordProviderCircuitSuccess,
  resetCircuitForTests,
} from "./circuit.js";

const DEADLINE_MS = 25000;
const PER_TARGET_TIMEOUT_MS = 20000;
const MAX_HEALTH_CHECKS = 20;
// Phase 2-i: 7.5s per attempt inside the 22s total budget. Two hung
// targets used to eat 13s + 8s of the budget, leaving #3..#8 untried;
// 7.5s allows 3-4 attempts even when multiple targets time out.
const DEFAULT_ATTEMPT_TIMEOUT_MS = 7500;
const DEFAULT_TOTAL_TIMEOUT_MS = 22000;

// Phase 2-b Pillar A: in-memory target health circuit-breaker. This is
// separate from the KV health layer (markFailure): the map lives in
// the isolate and deprioritizes a target for 10 minutes after a
// breaker-listed failure, so the next request tries healthy targets
// first in 0 ms instead of re-hitting the same dead 503/404/timeout
// at the top of the list. Success clears the entry.
const TARGET_HEALTH_COOLDOWN_MS = 600_000;
const BREAKER_FAILURE_STATUSES = new Set([404, 503, 502, 504, 401, 402, 429]);
const targetHealthMap = new Map();
// Phase 2-i: in-memory per-provider consecutive-failure streaks. A single
// dead provider (e.g. xkiro returning 503 for every model) used to be
// demoted one model at a time, so each turn picked another xkiro model
// first. After two consecutive transient failures the provider is
// deprioritized for 5 minutes, but only while another provider is healthy;
// single-provider combos never lose or drop targets.
const PROVIDER_STREAK_COOLDOWN_MS = 5 * 60 * 1000;
const PROVIDER_STREAK_THRESHOLD = 2;
const providerStreakMap = new Map();
export function resetProviderStreaks() { providerStreakMap.clear(); }
export function resetRouterHealthForTests() { targetHealthMap.clear(); providerStreakMap.clear(); resetCircuitForTests(); }
// Phase 2-d: admin "Unblock" clears one target's in-memory breaker entry
// (the KV health:<target> delete alone would leave the 10-minute
// in-memory cooldown in place for the rest of the isolate's life).
export function clearRouterHealthTarget(used) { targetHealthMap.delete(used); }
export function clearRouterHealthForProvider(provider) {
  const prefix = `${provider}/`;
  for (const k of [...targetHealthMap.keys()]) {
    if (k.startsWith(prefix)) targetHealthMap.delete(k);
  }
}
// Test-only snapshot (copy) of the in-memory breaker map, so tests can
// assert a failure was actually recorded — same precedent as
// resetRouterHealthForTests above.
export function getRouterHealthSnapshotForTests() {
  return new Map(targetHealthMap);
}

// Phase 2-f: in-memory Empty-final (24h) counters for /admin. Incremented
// whenever in-combo failover records an empty_response for a target.
// Deliberately NOT KV: KV is capped at 1000 writes/day, and a counter
// write per empty response would burn that budget. LIMITATION (stated
// plainly in the completion note): this is per-isolate memory, so it
// resets when the isolate recycles and is NOT a true durable 24h window
// — the Models tab label follows the directive, but the value is a
// since-isolate-start count, displayed as 0 when unknown.
const emptyFinalCounts = new Map();
export function getEmptyFinalCounts() {
  return new Map(emptyFinalCounts);
}
export function resetEmptyFinalCountsForTests() { emptyFinalCounts.clear(); }

// Phase 2-c: Workers/V8 abort surfacing. Aborting with a string reason
// (controller.abort("timeout")) or a runtime timeout does NOT reliably
// surface as AbortError with reason "timeout": it can arrive as the bare
// string "timeout", or as an Error whose message is "timeout" (name
// "Error", reason undefined). The old narrow check (reason/AbortError/
// TimeoutError only) let those fall into the else branch and become
// "network: timeout" — mislabeling a Worker-side abort as a network
// throw. Any of these shapes is a timeout.
export function isTimeoutError(err) {
  if (err === "timeout") return true;
  if (err?.reason === "timeout") return true;
  if (err?.name === "AbortError" || err?.name === "TimeoutError") return true;
  return typeof err?.message === "string" && /\b(?:timeout|timed?\s*out|aborted)\b/i.test(err.message);
}
function recordTargetFailure(used, statusOrReason) {
  const prev = targetHealthMap.get(used);
  targetHealthMap.set(used, {
    failCount: (prev?.failCount ?? 0) + 1,
    lastFailAt: Date.now(),
    lastStatus: statusOrReason,
  });
}
// A provider is deprioritized only when its streak is current and at
// least one target from another provider is healthy (count < threshold).
function currentProviderStreak(provider) {
  const entry = providerStreakMap.get(provider);
  return entry && entry.until > Date.now() ? entry : null;
}
function providerStreakActive(provider) {
  const entry = currentProviderStreak(provider);
  return Boolean(entry && entry.count >= PROVIDER_STREAK_THRESHOLD);
}
function recordProviderFailure(provider) {
  const prev = currentProviderStreak(provider);
  providerStreakMap.set(provider, {
    count: (prev?.count ?? 0) + 1,
    until: Date.now() + PROVIDER_STREAK_COOLDOWN_MS,
  });
}
function recordProviderSuccess(provider) { providerStreakMap.delete(provider); }
// Stable partition: healthy providers first, streak-failing providers last.
// Never reorders when every candidate is from the same failing provider (or
// when there is no healthy alternative), so single-provider combos are intact.
function partitionTargetsByProviderStreak(targets) {
  const failing = targets.filter((t) => providerStreakActive(t.provider));
  if (!failing.length) return targets;
  const failingProviders = new Set(failing.map((t) => t.provider));
  const hasHealthyOther = targets.some((t) => !failingProviders.has(t.provider));
  if (!hasHealthyOther) return targets;
  const healthy = targets.filter((t) => !failingProviders.has(t.provider));
  return [...healthy, ...failing];
}
// Phase 2-j: an open D1/memory provider circuit demotes that provider's
// targets below every other provider, but never drops them — a combo with
// no healthy alternative keeps its original order.
function partitionTargetsByOpenProviders(targets, open) {
  if (!open || !open.size) return targets;
  const failing = targets.filter((t) => open.has(t.provider));
  if (!failing.length) return targets;
  const failingProviders = new Set(failing.map((t) => t.provider));
  const hasHealthyOther = targets.some((t) => !failingProviders.has(t.provider));
  if (!hasHealthyOther) return targets;
  return [...targets.filter((t) => !failingProviders.has(t.provider)), ...failing];
}
// Phase 2-j: live-probe verified models (median/last success < 6s) form a
// tier-0 block ahead of unverified targets in auto combos.
function tierVerifiedFast(targets, latencies) {
  if (!latencies || !latencies.size) return targets;
  const fast = [];
  const rest = [];
  for (const t of targets) {
    const ms = latencies.get(`${t.provider}/${t.model}`.toLowerCase());
    if (ms != null && ms < 6000) fast.push(t);
    else rest.push(t);
  }
  return fast.length ? [...fast, ...rest] : targets;
}
function partitionTargetsByHealth(targets) {
  const now = Date.now();
  const healthy = [];
  const cooled = [];
  for (const t of targets) {
    const key = `${t.provider}/${t.model}`;
    const entry = targetHealthMap.get(key);
    if (!entry || now - entry.lastFailAt >= TARGET_HEALTH_COOLDOWN_MS) healthy.push(t);
    else cooled.push({ t, failCount: entry.failCount, lastFailAt: entry.lastFailAt });
  }
  // Cooled-down targets sort by fewest failures, then oldest failure,
  // and are only tried after every healthy target has failed.
  cooled.sort((a, b) => a.failCount - b.failCount || a.lastFailAt - b.lastFailAt);
  return [...healthy, ...cooled.map((c) => c.t)];
}

// Phase 2-b Pillar A: reasoning-model text extraction. Reasoning /
// thinking models often leave content empty and put the generation in
// reasoning_content / reasoning, or return an unclosed <think> block
// when max_tokens cuts them off. Only when content, reasoning_content
// AND reasoning are all empty is the response an "empty assistant
// message" — a fast HTTP 200 must not be thrown away.
export function extractAssistantText(message) {
  const msg = message ?? {};
  let raw = typeof msg.content === "string" ? msg.content : "";
  if (Array.isArray(msg.content)) {
    raw = msg.content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  }
  let text = String(raw).replace(/<think>[\s\S]*?<\/think>/g, "");
  const openIdx = text.indexOf("<think>");
  if (openIdx !== -1 && !text.slice(openIdx).includes("</think>")) {
    // Unclosed <think>: stripping "<think>[\s\S]*$" would empty it, so
    // the text INSIDE the tag is the fallback, not an empty string.
    const before = text.slice(0, openIdx).trim();
    const inner = text.slice(openIdx + "<think>".length).trim();
    text = before ? `${before} ${inner}` : inner;
  }
  text = text.trim();
  if (text) return text;
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
    return msg.reasoning_content.trim();
  }
  if (typeof msg.reasoning === "string" && msg.reasoning.trim()) {
    return msg.reasoning.trim();
  }
  return "";
}

// Stable v1 addendum (Telegram presentation only — the router//v1 layer keeps
// extractAssistantText above): FINAL assistant content, never reasoning.
// Closed <think> blocks are stripped without losing final text outside them;
// an unclosed <think> block is dropped entirely (only text BEFORE it is kept),
// never exposed as the answer; reasoning_content/reasoning are NEVER a fallback.
// Returns "" for reasoning-only, unclosed-think-only, and genuinely empty output.
export function extractFinalText(message) {
  const msg = message ?? {};
  let raw = typeof msg.content === "string" ? msg.content : "";
  if (Array.isArray(msg.content)) {
    raw = msg.content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  }
  let text = String(raw).replace(/<think>[\s\S]*?<\/think>/g, "");
  const openIdx = text.indexOf("<think>");
  if (openIdx !== -1) text = text.slice(0, openIdx);
  return text.trim();
}

function truncate(text) {
  const s = String(text ?? "");
  return s.length > 200 ? s.slice(0, 200) : s;
}

// نرمال‌سازی پاسخ upstream برای سازگاری با کلاینت استاندارد:
// - usage جاافتاده → صفر (شکل object حفظ می‌شود؛ فیلد extra حذف نمی‌شود)
// - finish_reason جاافتاده → از روی پیام استنباط می‌شود
// - role جاافتاده → assistant
// هیچ فیلد extra ای (مثل reasoning_content) حذف نمی‌شود.
export function normalizeOpenAiChat(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  if (Array.isArray(data.choices)) {
    for (const choice of data.choices) {
      if (!choice || typeof choice !== "object") continue;
      if (choice.message && typeof choice.message === "object" && choice.message.role == null) {
        choice.message.role = "assistant";
      }
      if (choice.finish_reason == null) {
        const m = choice.message;
        choice.finish_reason =
          Array.isArray(m?.tool_calls) && m.tool_calls.length > 0 ? "tool_calls" : "stop";
      }
    }
  }
  if (data.object == null) data.object = "chat.completion";
  if (data.created == null) data.created = Math.floor(Date.now() / 1000);
  if (!data.usage || typeof data.usage !== "object") {
    data.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  } else {
    // usage ناقص هم کامل می‌شود — فیلدهای موجود دست‌نخورده
    const u = data.usage;
    if (u.prompt_tokens == null) u.prompt_tokens = 0;
    if (u.completion_tokens == null) u.completion_tokens = 0;
    if (u.total_tokens == null) u.total_tokens = u.prompt_tokens + u.completion_tokens;
  }
  return data;
}

// طبقه‌بندی شکست upstream — تک‌نقطه‌ی تصمیم برای دامنه و مدت سردی:
// scope "model" = فقط همین مدل سرد می‌شود؛ scope "provider" = کل provider.
// برچسب فقط از status عددی ساخته می‌شود؛ هیچ‌وقت چیزی مثل "http undefined" نمی‌شود.
export function classifyFailure(status, bodySnippet, isTimeout) {
  if (isTimeout) return { scope: "model", cooldownSec: 600, label: "timeout" };
  if (status === 401 || status === 403) {
    return { scope: "provider", cooldownSec: 3600, label: "key rejected" };
  }
  const body = String(bodySnippet ?? "");
  if (status === 404) {
    const matched =
      /Function .* Not found for account/i.test(body) || body.includes("404 page not found");
    return {
      scope: "model",
      cooldownSec: 86400,
      label: matched ? "model not available (http 404)" : "http 404",
    };
  }
  if (status === 400 || status === 410) {
    return { scope: "model", cooldownSec: 86400, label: `http ${status}` };
  }
  if (typeof status === "number" && (status === 429 || status >= 500)) {
    return { scope: "model", cooldownSec: 900, label: `http ${status}` };
  }
  return {
    scope: "model",
    cooldownSec: 600,
    label: typeof status === "number" ? `http ${status}` : "upstream error",
  };
}

// ترتیب هدف‌ها بر حسب استراتژی combo دستی (pure؛ برای تست آفلاین هم قابل استفاده)
// - priority: ترتیب ذخیره‌شده (fallback ترتیبی)
// - round-robin: چرخش از اندیس ذخیره‌شده‌ی KV
// - fastest: صعودیِ میانه‌ی تأخیر؛ بدون داده → ترتیب اولویت (stable)
export function sortForStrategy(targets, strategy, { rrStart = 0, medians = {} } = {}) {
  const list = [...targets];
  if (!list.length) return [];
  if (strategy === "round-robin") {
    const start = ((rrStart % list.length) + list.length) % list.length;
    return list.slice(start).concat(list.slice(0, start));
  }
  if (strategy === "fastest") {
    return list
      .map((t, i) => ({ t, i, ms: medians[String(`${t.provider}/${t.model}`)] }))
      .sort(
        (a, b) =>
          (a.ms ?? Infinity) - (b.ms ?? Infinity) ||
          a.score - b.score ||
          a.i - b.i,
      )
      .map((x) => x.t);
  }
  return list;
}

export async function getComboTargets(env, name, opts = {}) {
  const cfg = env.STATE ? await getConfig(env) : { providers: [], combos: [] };
  const manual = (cfg.combos ?? []).find((c) => c.name === name);
  if (manual) return getManualComboTargets(env, manual, cfg, opts);

  const rule = RULES[name];
  if (!rule) return { error: `unknown combo: ${name}` };

  const [catalog, ov, unhealthyProviders] = await Promise.all([
    loadCatalog(env),
    getOverrides(env),
    getUnhealthyProviders(env),
  ]);
  if (!catalog.length) {
    return {
      error: "catalog is empty - run /refresh (or POST /admin/refresh) first, then retry",
    };
  }

  const preferPatterns = ov.prefer?.[name] ?? null;
  const compiled = compilePrefer(preferPatterns ?? rule.prefer);
  // Phase 2-d safe pinning: pins are still resolved first, but a pin
  // that is currently KV-cooling must NOT sit ahead of healthy
  // targets — it is demoted after the healthy scored targets instead
  // of being skipped outright, so it stays visible and is still tried
  // when budget remains. Provider-level blocks still drop pins fully.
  const pinModels = resolvePins(ov.pins?.[name], catalog)
    .map((m) => ({
      ...m,
      score: scoreModel(m, compiled, { skipVlPenalty: rule.needsVision === true }),
    }))
    .filter((m) => !unhealthyProviders[m.provider]);
  const healthyPins = [];
  const cooledPins = [];
  for (const m of pinModels) {
    if (await isModelHealthy(env, `${m.provider}/${m.id}`)) healthyPins.push(m);
    else cooledPins.push(m);
  }
  const pinKeys = new Set(pinModels.map((m) => `${m.provider}/${m.id}`.toLowerCase()));
  const scored = pickModels(catalog, rule, {
    prefer: preferPatterns,
    bans: ov.bans ?? [],
  })
    .filter((m) => !pinKeys.has(`${m.provider}/${m.id}`.toLowerCase()))
    .filter((m) => !unhealthyProviders[m.provider]);

  const need = Math.max(0, rule.maxTargets - healthyPins.length);
  const healthy = [];
  let checks = 0;
  for (const m of scored) {
    if (healthy.length >= need || checks >= MAX_HEALTH_CHECKS) break;
    checks++;
    if (await isModelHealthy(env, `${m.provider}/${m.id}`)) healthy.push(m);
  }

  const ordered = diversify(
    healthyPins.map((m) => ({ ...m, pinned: true })),
    healthy,
    rule.maxTargets,
  );
  // Demoted cooled pins ride at the tail (still marked pinned), capped
  // by maxTargets like everything else.
  for (const m of cooledPins) {
    if (ordered.length >= rule.maxTargets) break;
    ordered.push({ ...m, pinned: true });
  }
  // Phase 2-i: a provider with >= 2 consecutive transient failures drops
  // behind healthy providers for 5 minutes (auto combos only). Single
  // provider combos keep their order because no healthy alternative exists.
  // Phase 2-j: live-probe verified models get tier-0 priority, and a
  // durable provider circuit (open after 2 failures / 120s, 180s cooldown)
  // demotes that provider the same way, across isolates.
  const verified = await getVerifiedLatencies(env);
  const openCircuits = await getOpenProviderCircuits(env);
  const reordered = partitionTargetsByOpenProviders(
    partitionTargetsByProviderStreak(tierVerifiedFast(ordered, verified)),
    openCircuits,
  );
  return {
    name,
    targets: reordered.map((m) => ({
      provider: m.provider,
      model: m.id,
      score: m.score,
      pinned: Boolean(m.pinned),
      caps: m.capabilities ?? null,
    })),
  };
}

// comboهای دستی از config:v1 — استراتژی، skip سردشده‌ها، بدون diversify
async function getManualComboTargets(env, combo, cfg, opts = {}) {
  const providerMap = new Map(cfg.providers.map((p) => [p.id, p]));
  const ov = await getOverrides(env);
  const banSet = new Set((ov.bans ?? []).map((b) => String(b).toLowerCase()));
  const unhealthy = await getUnhealthyProviders(env);

  const candidate = [];
  for (const t of combo.targets ?? []) {
    if (t.enabled === false) continue;
    const p = providerMap.get(t.provider);
    if (!p || p.enabled === false) continue; // provider جاافتاده/خاموش — بی‌صدا رد
    const used = `${t.provider}/${t.model}`;
    if (banSet.has(used.toLowerCase())) continue;
    if (unhealthy[t.provider]) continue; // منع کل provider
    if (!(await isModelHealthy(env, used))) continue; // کول‌داون مدل
    candidate.push({
      provider: t.provider,
      model: t.model,
      score: 0,
      ctx: { id: p.id, baseUrl: p.baseUrl, secretName: p.secretName, extraHeaders: p.extraHeaders ?? undefined },
    });
  }

  let rrStart = 0;
  // Phase 2-d: read-only previews (Telegram /models display, the admin
  // /admin/catalog endpoint, GET /admin/api/auto/<name>) must NOT
  // advance the rr:<combo> pointer — only actual routing calls do.
  // Default preview = false, so direct getComboTargets(env, name)
  // calls (tests, routing) keep advancing exactly as before.
  if (combo.strategy === "round-robin" && env.STATE && !opts.preview) {
    const cur = Number((await env.STATE.get(`rr:${combo.name}`)) ?? 0);
    rrStart = Number.isFinite(cur) ? cur : 0;
    const n = candidate.length || 1;
    await env.STATE.put(`rr:${combo.name}`, String((rrStart + 1) % n));
  }

  let medians = {};
  if (combo.strategy === "fastest") {
    for (const c of candidate) medians[`${c.provider}/${c.model}`] = await getMedianLatency(env, `${c.provider}/${c.model}`);
  }

  const ordered = sortForStrategy(candidate, combo.strategy, { rrStart, medians });
  return {
    name: combo.name,
    manual: {
      strategy: combo.strategy,
      timeoutMs: combo.timeoutMs,
      retries: combo.retries ?? 0,
    },
    targets: ordered.map((m) => ({
      provider: m.provider,
      model: m.model,
      score: m.score,
      pinned: false,
      ctx: m.ctx,
    })),
  };
}

// direct provider/model — با همه‌ی providerهای پیکربندی‌شده کار می‌کند (داخلی + دستی)
async function resolveDirect(nameOrProviderModel, env) {
  const s = String(nameOrProviderModel);
  const slash = s.indexOf("/");
  if (slash <= 0) return null;
  const provider = s.slice(0, slash);
  const model = s.slice(slash + 1);
  if (!model || /^\s*$/s.test(model)) return null;
  const ctx = await getProviderCtx(env, provider);
  if (!ctx) return null;
  return { provider, model, ctx };
}

// ctx = { id, baseUrl, secretName, extraHeaders } — همه‌ی providerها از config
async function tryTarget(env, ctx, model, body, timeoutMs) {
  if (!ctx) return { skipReason: "unknown provider" };
  const key = env[ctx.secretName];
  if (!key) return { skipReason: `missing ${ctx.secretName}` };

  const used = `${ctx.id}/${model}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  let res;
  try {
    res = await fetch(`${ctx.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        ...(ctx.extraHeaders ?? {}),
      },
      body: JSON.stringify({ ...body, model }),
    });
  } catch (err) {
    // Phase 2-c: use the broad isTimeoutError predicate (see above) —
    // a Worker timer abort can surface as the bare string "timeout" or
    // an Error with message "timeout", not only as AbortError.
    // Stable v1 addendum: record ABORT PROVENANCE, not just the string.
    // controller.signal.aborted is true ONLY when OUR timer fired; a
    // network throw that merely says "timeout" (e.g. the gateway's own
    // timeout surfacing as Error("timeout")) leaves it false. The two
    // cases share the reason string but have different timerFired values.
    const isTimeout = isTimeoutError(err);
    return {
      error: {
        target: used,
        reason: isTimeout ? "timeout" : truncate(`network: ${err && err.message}`),
      },
      cause: isTimeout ? "timeout" : `network: ${err && err.message}`,
      timerFired: controller.signal.aborted,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    return {
      error: { target: used, reason: `http ${res.status}` },
      cause: res.status,
      status: res.status,
      raw: redact(raw, [key], 200),
    };
  }
  return { res };
}

// مدلِ درخواستی از /v1: «combo/<name>» فقط combo؛ نام ساده یا «provider/model» هم قبول است.
// خروجی: { sel } (targets کامل) یا { direct } (فراخوانی مستقیم) یا { fail }  (خطای قطعی)
async function resolveRouterTarget(env, wanted) {
  const isComboRef = wanted.startsWith("combo/");
  const name = isComboRef ? wanted.slice("combo/".length) : wanted;

  if (!name) {
    return { fail: [{ target: truncate(wanted), reason: "unknown combo: empty combo name" }] };
  }
  // combo دستی: هم برای نام ساده و هم بعد از پیشوند combo/
  const cfg = env.STATE ? await getConfig(env) : { providers: [], combos: [] };
  if (RULES[name] || (cfg.combos ?? []).some((c) => c.name === name)) {
    return { name, sel: await getComboTargets(env, name) };
  }
  const unknownErr = [{ target: truncate(name), reason: `unknown combo: ${truncate(name)}` }];
  if (isComboRef) {
    // داده شده combo/<x> — بازگشت مستقیم روی provider نیست؛ فقط combo
    return { fail: unknownErr };
  }
  const direct = await resolveDirect(wanted, env);
  if (direct) {
    return { direct };
  }
  return { fail: [{ target: truncate(wanted), reason: `unknown combo or provider/model: ${truncate(wanted)}` }] };
}

export async function runCombo(
  env,
  comboNameOrProviderModel,
  body,
  { deadlineMs, perTargetTimeoutMs, attemptTimeoutMs: attemptOpt, totalTimeoutMs: totalOpt, stream = false, requireFinalText = false } = {},
) {
  const wanted = String(comboNameOrProviderModel);
  const resolved = await resolveRouterTarget(env, wanted);
  let targets;
  let manualCfg = null;
  let comboName = null;
  if (resolved.fail) {
    return { ok: false, errors: resolved.fail, tried: [] };
  } else if (resolved.direct) {
    const d = resolved.direct;
    targets = [{ provider: d.provider, model: d.model, score: 0, pinned: false, ctx: d.ctx }];
  } else {
    const sel = resolved.sel;
    if (sel.error) {
      return { ok: false, errors: [{ target: truncate(resolved.name), reason: truncate(sel.error) }], tried: [] };
    }
    targets = sel.targets;
    manualCfg = sel.manual ?? null;
    comboName = resolved.name;
  }

  // Phase 1-e Pillar 1: hard wall-clock budgets, always. Phase 2-i:
  // per-attempt timeout defaults to 7.5s (capped at 15s) — inside the
  // [5s, 20s) window pinned by test-dev.mjs. The old 13s default let two
  // hung targets eat the whole 22s budget, leaving #3..#8 untried; 7.5s
  // still fits working nvidia/* generations while allowing 3-4 attempts.
  // The total deadline across all targets/retries defaults to 22s and is
  // capped at 22s, leaving >= 8s before Cloudflare's 30s waitUntil limit.
  // The legacy deadlineMs / perTargetTimeoutMs knobs keep working as
  // aliases, capped by the same bounds. A manual combo's old up-to-55s
  // deadline is capped by the total budget too — that was the
  // silent-death hole.
  const attemptTimeoutMs = Math.min(attemptOpt ?? perTargetTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS, 15000);
  const totalTimeoutMs = Math.min(totalOpt ?? deadlineMs ?? DEFAULT_TOTAL_TIMEOUT_MS, 22000);
  const started = Date.now();
  const errors = [];
  // Phase 2-f: empty-final attempts skipped by in-combo failover, in
  // order, as `${target}: empty_response` strings. Returned on both ok
  // and ok:false results (the ok:false rendering still comes from
  // `errors` via formatFailureDetail; `tried` is the failover audit trail
  // and the test hook for Task 1).
  const tried = [];
  const maxRetries = manualCfg?.retries ?? 0;
  const perTargetTimeout = manualCfg?.timeoutMs
    ? Math.min(manualCfg.timeoutMs, attemptTimeoutMs)
    : attemptTimeoutMs;
  const needsTools = Array.isArray(body?.tools) && body.tools.length > 0;
  const deadline = totalTimeoutMs;
  // اگر کلید یک provider رد شد (401/403)، بقیه‌ی هدف‌های همان provider در این
  // فراخوانی بی‌خیال می‌شوند — فقط یک پیام «key rejected» برمی‌گردد و provider
  // یک ساعت در health منع می‌شود (markFailure خودش این را ثبت می‌کند).
  const rejectedProviders = new Set();
  let lastErr = null;
  // Phase 2-b Pillar A: healthy targets first; cooled-down targets
  // (breaker-listed failure within the last 10 minutes) only after
  // every healthy target has failed. Phase 2-i then demotes targets of a
  // provider with an active failure streak behind healthy providers.
  targets = partitionTargetsByProviderStreak(partitionTargetsByHealth(targets));

  // Phase 2-j: in a multi-provider combo, one transient failure is enough
  // to skip that provider's remaining targets for THIS call (strict
  // per-provider skip, observed: a 503 on xkiro/a then a timeout on
  // nvidia/b must not spend the budget on xkiro/c). Single-provider combos
  // keep trying every target — there is no alternative to skip to.
  const multiProvider = new Set(targets.map((t) => t.provider)).size > 1;
  const skippedProviders = new Set();

  for (let ti = 0; ti < targets.length; ti++) {
    // Re-evaluate provider streaks each iteration: a failure earlier in
    // this same call can push a provider over the threshold.
    if (ti > 0 && ti < targets.length) {
      const rest = targets.slice(ti);
      const reordered = partitionTargetsByProviderStreak(rest);
      targets.splice(ti, rest.length, ...reordered);
    }
    const t = targets[ti];
    if (rejectedProviders.has(t.provider) || skippedProviders.has(t.provider)) continue;
    const usedModel = `${t.provider}/${t.model}`;
    const remaining = deadline - (Date.now() - started);
    if (remaining < 1200) {
      // Phase 2-c: never push a fake entry for a target that was
      // never fetched. Only when the whole call started with < 1200ms
      // of budget (errors still empty) is an entry pushed, preserving
      // the test-dev empty-budget behavior.
      if (errors.length === 0) errors.push({ target: usedModel, reason: lastErr || "timeout" });
      break;
    }

    if (t.model.startsWith("PLACEHOLDER")) {
      errors.push({ target: usedModel, reason: "placeholder model id" });
      lastErr = "placeholder model id";
      continue;
    }
    // هدف بدون پشتیبانی ابزار وقتی tools خواسته شده — رد (فقط اگر metadata گویا باشد)
    if (needsTools && t.caps && t.caps.tools === false) {
      errors.push({ target: usedModel, reason: "no tool support" });
      lastErr = "no tool support";
      continue;
    }

    let ctx = t.ctx;
    if (!ctx) ctx = await getProviderCtx(env, t.provider);
    if (!ctx) {
      errors.push({ target: usedModel, reason: "unknown provider" });
      lastErr = "unknown provider";
      continue;
    }
    if (ctx.enabled === false) continue;

    const t0 = Date.now();
    // retries برای combo دستی: فقط خطاهای گذرا (timeout/429/5xx) دوباره امتحان می‌شوند
    let attempt = null;
    let failure = null;
    for (let attemptNo = 0; ; attemptNo++) {
      const rem = deadline - (Date.now() - started);
      if (rem < 1200) {
        attempt = { error: { target: usedModel, reason: lastErr || "timeout" }, cause: "timeout" };
        failure = { isTimeout: true, cls: classifyFailure(null, "", true), cause: "timeout" };
        break;
      }
      attempt = await tryTarget(env, ctx, t.model, body, Math.min(perTargetTimeout, rem));
      if (attempt.skipReason || !attempt.error) break;
      const isTimeout = attempt.cause === "timeout";
      const cls = classifyFailure(
        typeof attempt.cause === "number" ? attempt.cause : null,
        attempt.raw,
        isTimeout,
      );
      const retryable =
        isTimeout ||
        (typeof attempt.cause === "number" && (attempt.cause === 429 || attempt.cause >= 500));
      if (retryable && attemptNo < maxRetries) continue;
      failure = { isTimeout, cls, cause: attempt.cause, timerFired: attempt.timerFired ?? null };
      break;
    }

    const latencyMs = Date.now() - t0;

    if (attempt.skipReason) {
      errors.push({ target: usedModel, reason: attempt.skipReason });
      lastErr = attempt.skipReason;
    } else if (failure) {
      const { isTimeout, cls, cause, timerFired } = failure;
      if (isTimeout) console.log(JSON.stringify({ event: "router_timeout", target: usedModel, ms: latencyMs }));
      if (cls.scope === "provider") {
        rejectedProviders.add(t.provider);
        await recordProviderCircuitFailure(env, t.provider, cause);
        errors.push({
          target: usedModel,
          reason: `provider ${t.provider}: key rejected (${cause})`,
        });
        lastErr = `provider ${t.provider}: key rejected (${cause})`;
      } else {
        const entry = { target: usedModel };
        if (typeof cause === "number") {
          entry.reason = cls.label;
          entry.status = cause;
        } else if (isTimeout) {
          entry.reason = cls.label;
        } else {
          entry.reason = truncate(cause);
        }
        // Stable v1 addendum: abort provenance for diagnostics. Present
        // only when the attempt reported it (tryTarget failures); the
        // budget-floor and key-rejected entries carry none (null in diag).
        if (timerFired != null) entry.timerFired = timerFired;
        errors.push(entry);
        lastErr = entry.reason;
      }
      if (env.STATE) {
        try {
          await markFailure(env, usedModel, cls, isTimeout ? "timeout" : truncate(cause));
        } catch (err) {
          console.error("markFailure failed:", err && err.message);
        }
      }
      // Phase 2-b: breaker-listed failures deprioritize this target
      // for 10 minutes on the next request. Phase 2-c: a "network:
      // timeout" string also cools its target (it is a timing-out
      // target by another name), and 504 joins the breaker statuses.
      // Bad json and other network errors still do not cool a target.
      if (isTimeout) recordTargetFailure(usedModel, "timeout");
      else if (cause === "network: timeout") recordTargetFailure(usedModel, cause);
      else if (typeof cause === "number" && BREAKER_FAILURE_STATUSES.has(cause)) {
        recordTargetFailure(usedModel, cause);
      }
      // Phase 2-c / 2-i: intra-call provider demotion. When a provider
      // returns 503/502/504/429 or times out, its remaining untried
      // targets in this call move to the end of the remaining list, so
      // healthy providers get the full attempt budget immediately. The
      // provider streak also increments, so later calls and auto-combo
      // selection deprioritize it after two consecutive failures. Demoted
      // targets stay at the tail and are still tried, so same-provider
      // fallback pairs (e.g. [m1, m2]) keep working.
      const transientProviderFailure =
        isTimeout ||
        (typeof cause === "number" && [500, 502, 503, 504, 429].includes(cause));
      if (transientProviderFailure) {
        recordProviderFailure(t.provider);
        await recordProviderCircuitFailure(env, t.provider, isTimeout ? "timeout" : cause);
        if (multiProvider) skippedProviders.add(t.provider);
      }
    } else if (stream) {
      const res = attempt.res;
      if (res.body) {
        try {
          await recordLatency(env, usedModel, latencyMs);
        } catch (err) {
          console.error("recordLatency failed:", err && err.message);
        }
        targetHealthMap.delete(usedModel);
        recordProviderSuccess(t.provider);
        await recordProviderCircuitSuccess(env, t.provider);
        return {
          ok: true,
          stream: res.body,
          contentType: res.headers.get("content-type"),
          used: usedModel,
          combo: comboName,
          latencyMs,
        };
      }
      errors.push({ target: usedModel, reason: "no stream body" });
      lastErr = "no stream body";
      await markFailure(env, usedModel, classifyFailure(null, "", false), "no stream body");
    } else {
      const res = attempt.res;
      let data;
      // The body read itself must respect the total budget too: a
      // stalled body stream must not outlive the <= 22s guarantee.
      const remJson = deadline - (Date.now() - started);
      if (remJson < 1200) {
        // Phase 2-c: same phantom rule as the loop floor — never
        // attribute the previous error to this target, whose body was
        // never read, when real attempts already failed.
        if (errors.length === 0) errors.push({ target: usedModel, reason: lastErr || "timeout" });
        lastErr = lastErr || "timeout";
        continue;
      }
      let jsonTimer;
      let jsonTimerFired = false;
      try {
        data = await Promise.race([
          res.json(),
          new Promise((_, rej) => { jsonTimer = setTimeout(() => { jsonTimerFired = true; rej(new Error("timeout")); }, remJson); }),
        ]);
      } catch (err) {
        // Phase 2-c: the body-read race uses the same broad timeout
        // predicate as tryTarget (a body-stream abort can surface as
        // AbortError or a "timeout"/"timed out" message, not only as
        // the race's own Error("timeout")). Stable v1 addendum: the
        // provenance flag records whether OUR jsonTimer fired, not
        // merely whether the error string looks like a timeout — a
        // body-stream network throw with a timeout-ish message must
        // not be misreported as a local deadline.
        if (isTimeoutError(err)) {
          console.log(JSON.stringify({ event: "router_timeout", target: usedModel, ms: Date.now() - t0 }));
          errors.push({ target: usedModel, reason: "timeout", timerFired: jsonTimerFired });
          lastErr = "timeout";
          await markFailure(env, usedModel, classifyFailure(null, "", true), "timeout");
          recordTargetFailure(usedModel, "timeout");
          recordProviderFailure(t.provider);
          await recordProviderCircuitFailure(env, t.provider, "timeout");
          if (multiProvider) skippedProviders.add(t.provider);
          continue;
        }
        errors.push({ target: usedModel, reason: truncate(`bad json: ${err && err.message}`), timerFired: false });
        lastErr = `bad json: ${err && err.message}`;
        await markFailure(env, usedModel, classifyFailure(null, "", false), "bad json response");
        continue;
      } finally {
        if (jsonTimer) clearTimeout(jsonTimer);
      }

      const { message } = data?.choices?.[0] ?? {};
      const hasToolCalls =
        Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
      // Phase 2-b: reasoning/thinking models may carry the generation
      // in reasoning_content / reasoning or in an unclosed <think>
      // block. Only when all three are empty is this an "empty
      // assistant message". Array content keeps the old length check.
      const content = message?.content;
      const text = Array.isArray(content) ? null : extractAssistantText(message);
      const empty =
        !hasToolCalls &&
        (Array.isArray(content) ? content.length === 0 : !text);
      if (empty) {
        errors.push({ target: usedModel, reason: "empty assistant message" });
        lastErr = "empty assistant message";
        await markFailure(env, usedModel, classifyFailure(null, "", false), "empty assistant message");
        recordTargetFailure(usedModel, "empty assistant message");
        continue;
      }
      // Stable v1 addendum: Telegram presentation metadata, computed from
      // the RAW message BEFORE surfacing/normalization below. Surfacing
      // would overwrite content with reasoning text (making a
      // reasoning-only response indistinguishable from a final answer),
      // and normalizeOpenAiChat fabricates usage zeros when absent — so
      // both finalText and usage must be captured here, raw. /v1 keeps
      // receiving result.data unchanged; answerChatText (Telegram) uses
      // answerMeta.finalText. finishReason is raw too: a supplied
      // "length" must survive (normalize only fills when null).
      const answerMeta = {
        finalText: extractFinalText(message),
        reasoningChars:
          (typeof message?.reasoning_content === "string" ? message.reasoning_content.length : 0) +
          (typeof message?.reasoning === "string" ? message.reasoning.length : 0),
        finishReason: data?.choices?.[0]?.finish_reason ?? null,
        usage: data?.usage ?? null,
        toolCalls: hasToolCalls,
      };
      // Phase 2-f Task 1: in-combo failover on empty final answer
      // (OPT-IN, Telegram only — requireFinalText, default false, so
      // /v1 and callRouter keep returning reasoning-only and
      // tool-call-only responses verbatim). A HTTP 200 whose cleaned
      // visible answer is empty and which carries no tool_calls is NOT
      // a usable Telegram answer: record it as empty_response, cool the
      // target briefly via the existing markFailure path (transient-5xx
      // family: model scope, 900s — a SHORT transient cooldown, never a
      // ban), count it for the /admin Empty-final counter, and try the
      // next target in the SAME combo inside the shared budget. The
      // in-memory breaker entry matches the transient-5xx pattern.
      if (requireFinalText && !hasToolCalls && answerMeta.finalText === "") {
        tried.push(`${usedModel}: empty_response`);
        errors.push({ target: usedModel, reason: "empty_response" });
        lastErr = "empty_response";
        emptyFinalCounts.set(usedModel, (emptyFinalCounts.get(usedModel) ?? 0) + 1);
        if (env.STATE) {
          try {
            await markFailure(env, usedModel, { scope: "model", cooldownSec: 900, label: "empty_response" }, "empty_response");
          } catch (err) {
            console.error("markFailure failed:", err && err.message);
          }
        }
        recordTargetFailure(usedModel, "empty_response");
        // Budget discipline: a further failover attempt needs >= 1500ms
        // of the shared budget left (the directive's floor — stricter
        // than runCombo's 1200ms loop/JSON floors, which still govern
        // ordinary attempts; the 1500ms figure is also the chat
        // fallback gate in answerChatText). Below that, stop cleanly
        // with a budget-floor entry and attempt no further fetch. The
        // entry names the already-attempted target, never an
        // unattempted one (no phantom entries, per Phase 2-c).
        const remAfter = deadline - (Date.now() - started);
        if (remAfter < 1500) {
          errors.push({ target: usedModel, reason: "budget floor" });
          lastErr = "budget floor";
          break;
        }
        continue;
      }
      // Surface the extracted text as the message content so the
      // router//v1 callers (callRouter, chatCompletions) see the
      // generation exactly as before. answerChatText does NOT use this
      // surfaced content — it uses answerMeta.finalText (see above).
      if (text && typeof content === "string" && text !== content) {
        data.choices[0].message.content = text;
      }

      try {
        await recordLatency(env, usedModel, latencyMs);
      } catch (err) {
        console.error("recordLatency failed:", err && err.message);
      }
      targetHealthMap.delete(usedModel);
      recordProviderSuccess(t.provider);
      await recordProviderCircuitSuccess(env, t.provider);
      return {
        ok: true,
        data: normalizeOpenAiChat(data),
        used: usedModel,
        combo: comboName,
        latencyMs,
        answerMeta,
        tried,
      };
    }
  }

  return { ok: false, errors, tried };
}

// فراخوانی مستقیم یک هدف (همان کد مسیر روتتر؛ بدون فیلتر سلامت) برای /test.
// خروجی امن است: فقط status، تأخیر و اسنیپت رازپاک‌شده.
export async function directCall(env, providerName, model, body, { timeoutMs = 20000 } = {}) {
  const ctx = await getProviderCtx(env, providerName);
  if (!ctx) {
    return { ok: false, status: null, latencyMs: 0, snippet: `unknown provider: ${providerName}` };
  }
  const key = env[ctx.secretName];
  if (!key) {
    return { ok: false, status: null, latencyMs: 0, snippet: `missing ${ctx.secretName}` };
  }
  const started = Date.now();
  const attempt = await tryTarget(env, ctx, model, body, timeoutMs);
  const latencyMs = Date.now() - started;
  if (attempt.skipReason) {
    return { ok: false, status: null, latencyMs, snippet: attempt.skipReason };
  }
  if (attempt.error) {
    const isTimeout = attempt.cause === "timeout";
    const snippet = isTimeout
      ? `timeout بعد از ${Math.max(1, Math.round(timeoutMs / 1000))}s`
      : attempt.raw ||
        (typeof attempt.cause === "string" && attempt.cause !== "timeout"
          ? truncate(attempt.cause)
          : `http ${attempt.status ?? ""}`.trim());
    return {
      ok: false,
      status: attempt.status ?? null,
      latencyMs,
      snippet,
    };
  }
  let data;
  try {
    data = await attempt.res.json();
  } catch (err) {
    return { ok: false, status: attempt.res.status, latencyMs, snippet: `bad json: ${err && err.message}` };
  }
  const message = data?.choices?.[0]?.message;
  const content = message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((p) => p?.text ?? "").join("")
        : JSON.stringify(data ?? {});
  const finalChars = extractFinalText(message).length;
  const reasoningChars =
    (typeof message?.reasoning_content === "string" ? message.reasoning_content.length : 0) +
    (typeof message?.reasoning === "string" ? message.reasoning.length : 0);
  return {
    ok: true,
    status: attempt.res.status,
    latencyMs,
    snippet: redact(text, [key], 200),
    finalChars,
    reasoningChars,
  };
}

// Phase 1-e Pillar 1: thin directive-shaped wrapper over runCombo.
// The production paths keep runCombo's established { ok, errors } shape;
// this wrapper normalizes to { ok, text, model, error } for callers and
// tests that need the timeout contract directly. Streaming is forced off
// (a stream has no single text). Timeouts are runCombo's capped budgets.
export async function callRouter(env, comboNameOrProviderModel, body, opts = {}) {
  const r = await runCombo(env, comboNameOrProviderModel, body, { ...opts, stream: false });
  if (r.ok) {
    // Phase 2-b: reasoning/think extraction (see extractAssistantText).
    const text = extractAssistantText(r.data?.choices?.[0]?.message);
    return { ok: true, text, model: r.used ?? null, error: null };
  }
  const first = Array.isArray(r.errors) && r.errors.length ? r.errors[0] : null;
  return { ok: false, text: "", model: null, error: (first?.reason ?? null) || "timeout" };
}
