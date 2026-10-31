// Phase 0-c eval runner (design v3, 3.10): MANUAL and NETWORKED. This file
// is NOT part of `npm run test:offline` and must never run in CI — the
// offline suite only imports the pure functions below, which run no
// network. Credentials: CF_API_TOKEN and CF_ACCOUNT_ID come from
// environment variables ONLY, filled in locally by the person running the
// eval. They are never printed, logged, stored, or shared in chat, and
// they are never committed anywhere. Neuron cost is NOT read from the API
// response (the Workers AI REST response does not reliably return one):
// read it from the Cloudflare dashboard for the run window instead.
// Synthetic-only guard: this runner refuses any --cases path other than the
// bundled eval/intent-synthetic.json. Real user messages are never sent:
// they stay in D1 and are evaluated only on Workers AI models, if at all.
//
// Phase 0-c fix notes (what changed vs the reviewed slice, and why):
// - Slots ARE scored now (before, case.slots was ignored): amount, dates,
//   project, query fields, and target are compared on VALIDATED actions
//   (resolved values where the validator resolves them), with explicit
//   null/absence rules, and reported separately from type accuracy.
// - Ask needs ARE scored: a correct ask with the wrong need is not fully
//   correct. Ask accuracy and need accuracy are reported separately.
// - Extra actions are rejected: single cases need exactly one action;
//   multi cases need multiset equality of types (no extra types, no
//   duplicate padding). Set equality alone was too lenient.
// - Iran time is an explicit +03:30 ISO string from ONE captured instant
//   shared by prompt and validation context (no prompt/validator skew,
//   no misleading trailing Z).
// - Request errors are distinct from invalid JSON: outcome is one of
//   "valid" | "invalid_json" | "request_error". Transport failures are
//   excluded from accuracy denominators and reported separately.
// - Retry mirrors production interpretText (two attempts on call/parse
//   failures ONLY — transport error or unparseable output). Validation
//   (validateInterpreterAction) happens OUTSIDE interpretText, in the
//   caller's policy path, so valid JSON whose actions fail validation is
//   a FINAL outcome here too, never retried: first-attempt and post-retry
//   results are reported separately, plus retry count and recovery rates.
// - Median is the standard median (even counts average the two middles).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildInterpreterPrompt, parseInterpreterOutput, validateInterpreterAction, validateAmountText, validateDateTexts, matchProject, INTERPRETER_TYPES, INTERPRETER_NEEDS } from "../src/interpreter.js";
import { normalizeText } from "../src/daily.js";
import { SEED_PROJECTS } from "../src/everyday.js";

const BUNDLED_CASES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../eval/intent-synthetic.json");
const EXAMPLE_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/google/gemma-3-12b-it", "@cf/qwen/qwen2.5-7b-instruct"];

// iranNowIso(nowMs) -> Iran-local ISO string with an explicit +03:30
// offset for the SAME instant (not a shifted timestamp ending in Z, which
// mislabels Iran wall time as UTC and can confuse relative dates).
export function iranNowIso(nowMs = Date.now()) {
  const d = new Date(nowMs + 210 * 60000);
  const p = (n) => String(n).padStart(2, "0");
  // Milliseconds included: the +03:30 shift is whole minutes, so the
  // shifted instant's milliseconds ARE the original instant's — dropping
  // them (".000") would make nowIso up to 999ms older than nowMs.
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, "0")}+03:30`;
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const norm = (s) => normalizeText(String(s ?? "")).trim();

// scoreSlots(slots, action, validation, ctx) -> { fields, pass, total }.
// Slots are scored on the VALIDATED action, not raw JSON: amounts and
// dates compare RESOLVED values (so different phrasings of the same value
// pass), projects compare the resolved match OR the normalised raw name
// (so aliases pass and unknown-but-correctly-extracted names pass for ask
// cases), query periods compare normalised raw phrases, kinds and targets
// compare exactly. Explicit null/absence rules: a field ABSENT from slots
// is not counted at all; a field PRESENT with value null requires the
// model to claim nothing for it. A null action (invalid output) fails
// every listed field. Multi cases define no slots in this set, so the
// runner scores slots for single/ask cases only.
// Query-project resolution is explicit: production's
// validateInterpreterAction resolves action.query.project (for query
// actions) via matchProject into resolved.project — but resolved.project
// reflects the ACTION-level project whenever the action's type is not
// "query", so scoring query.project from it could pass/fail on the wrong
// project. The scorer therefore resolves the query's OWN project directly
// with matchProject; an unmatched name falls back to the normalised raw
// comparison (ask cases). The top-level "project" field is unchanged:
// for non-query actions resolved.project already is the action.project
// match under the same production contract, and no dataset case combines
// a top-level project slot with a query action.
export function scoreSlots(slots, action, validation, ctx = {}) {
  const names = [];
  if (slots && typeof slots === "object") {
    for (const k of ["amount_text", "due_text", "remind_text", "project", "target"]) if (k in slots) names.push(k);
    if (slots.query && typeof slots.query === "object") for (const k of ["kind", "period", "project"]) if (k in slots.query) names.push(`query.${k}`);
  }
  if (!names.length) return { fields: [], pass: 0, total: 0 };
  if (!action) return { fields: names.map((field) => ({ field, ok: false })), pass: 0, total: names.length };
  const resolved = validation?.resolved ?? {};
  const fields = [];
  const push = (field, ok) => fields.push({ field, ok: !!ok });
  const projectOk = (want, raw, resolvedName) => want == null ? raw == null : (resolvedName != null && norm(resolvedName) === norm(want)) || norm(raw) === norm(want);
  if ("amount_text" in slots) {
    if (slots.amount_text == null) push("amount_text", action.amount_text == null);
    else {
      const exp = validateAmountText(slots.amount_text, ctx.defaultCurrency);
      push("amount_text", exp.ok && resolved.amount === exp.amount && resolved.currency === exp.currency);
    }
  }
  for (const key of ["due_text", "remind_text"]) {
    if (!(key in slots)) continue;
    if (slots[key] == null) { push(key, action[key] == null); continue; }
    const exp = validateDateTexts(key === "due_text" ? slots[key] : null, key === "remind_text" ? slots[key] : null, ctx.nowMs);
    const want = key === "due_text" ? exp.due_at : exp.remind_at;
    const got = key === "due_text" ? resolved.due_at : resolved.remind_at;
    push(key, exp.ok && want != null && got === want);
  }
  if ("project" in slots) push("project", projectOk(slots.project, action.project, resolved.project?.name ?? null));
  if ("target" in slots) push("target", slots.target == null ? action.target == null : String(action.target ?? "").trim() === String(slots.target).trim());
  if (slots.query && typeof slots.query === "object") {
    const q = action.query ?? null;
    if ("kind" in slots.query) push("query.kind", q?.kind === slots.query.kind);
    if ("period" in slots.query) push("query.period", slots.query.period == null ? q?.periodText == null : norm(q?.periodText) === norm(slots.query.period));
    if ("project" in slots.query) {
      const qMatched = q?.project == null ? null : matchProject(q.project, ctx.projects ?? [])?.name ?? null;
      push("query.project", projectOk(slots.query.project, q?.project, qMatched));
    }
  }
  return { fields, pass: fields.filter((f) => f.ok).length, total: fields.length };
}

// Map one parsed model output to a scored outcome, using the production
// policy boundary: unparseable -> "invalid"; validation failure, low
// confidence (< 0.6), or a non-none need -> "ask"; otherwise the action
// types. gotNeeds: the model's own stated need first, else the first
// validation error, else "type" for a low-confidence ask (the policy
// would have to ask what type this is). validated carries each action
// with its production validation, for slot scoring.
export function mapOutcome(parseResult, actions, ctx) {
  if (!parseResult.ok || !actions.length) return { got: "invalid", gotTypes: [], gotActionCount: 0, gotNeeds: null, validJson: false, validated: [] };
  const validated = actions.map((a) => ({ action: a, validation: validateInterpreterAction(a, ctx) }));
  const ask = validated.some((v) => !v.validation.ok) || actions.some((a) => a.confidence < 0.6 || a.needs !== "none");
  if (ask) {
    const stated = actions.find((a) => a.needs !== "none")?.needs ?? null;
    const err = validated.find((v) => !v.validation.ok)?.validation.errors?.[0] ?? null;
    return { got: "ask", gotTypes: [...new Set(actions.map((a) => a.type))], gotActionCount: actions.length, gotNeeds: stated ?? err ?? "type", validJson: true, validated };
  }
  return { got: actions[0].type, gotTypes: [...new Set(actions.map((a) => a.type))], gotActionCount: actions.length, gotNeeds: actions[0]?.needs ?? null, validJson: true, validated };
}

// scoreEvalResults(results) -> full report. Each result: { id, expected,
// expectedTypes?, expectedNeeds?, got, gotTypes?, gotActionCount?,
// gotNeeds?, validJson, outcome? ("valid"|"invalid_json"|"request_error"),
// firstGot?, firstGotTypes?, firstActionCount?, firstValidJson?,
// firstOutcome?, retried?, recovered?, requestRecovered?, slot? }.
// Type correctness is STRICT: single cases need exactly one action of the
// expected type; multi cases need multiset equality of types. "Fully
// correct" (accuracyPct) additionally requires slots (where defined) and
// the ask need (for ask cases). Accuracy denominators EXCLUDE final
// request errors (transport, not model behaviour); valid-JSON % uses
// valid/(valid+invalid_json). No message text is ever included in
// failures — ids only.
export function scoreEvalResults(results) {
  const total = results.length;
  const pct = (n, d) => d ? Math.round((n / d) * 1000) / 10 : 0;
  const outcomeOf = (r) => r.outcome ?? (r.validJson ? "valid" : "invalid_json");
  const countOf = (r) => r.gotActionCount ?? (r.gotTypes ? r.gotTypes.length : 1);
  const typeOk = (r, got, gotTypes, count) => {
    if (r.expected === "multi") {
      // gotTypes is deduplicated, so the count check is what rejects
      // duplicate padding ([note, note, task] vs [note, task]).
      const a = [...(gotTypes ?? [])].sort(), b = [...(r.expectedTypes ?? [])].sort();
      return count === b.length && a.length === b.length && a.every((t, i) => t === b[i]);
    }
    return got === r.expected && count === 1;
  };
  let valid = 0, invalidJson = 0, requestErrors = 0;
  let typeCorrect = 0, fullyCorrect = 0;
  let askTotal = 0, askCorrect = 0, needCorrect = 0;
  let slotPass = 0, slotTotal = 0, slotCases = 0, slotCasesPass = 0;
  const slotFieldCounts = {};
  let firstValid = 0, firstInvalid = 0, firstRequestErrors = 0, firstTypeCorrect = 0, firstScored = 0;
  let retries = 0, recovered = 0, requestRecovered = 0, initiallyInvalid = 0, initiallyRequestError = 0;
  const failures = [], slotFailures = [], needFailures = [];
  let anyFirst = false;
  for (const r of results) {
    const outcome = outcomeOf(r);
    if (outcome === "request_error") requestErrors++;
    else if (outcome === "invalid_json") invalidJson++;
    else valid++;
    if (r.retried) retries++;
    if (r.recovered) recovered++;
    if (r.requestRecovered) requestRecovered++;
    if (r.firstOutcome === "invalid_json") initiallyInvalid++;
    if (r.firstOutcome === "request_error") initiallyRequestError++;
    if (r.firstOutcome !== undefined) {
      anyFirst = true;
      if (r.firstOutcome === "request_error") firstRequestErrors++;
      else if (r.firstOutcome === "invalid_json") firstInvalid++;
      else firstValid++;
      if (r.firstOutcome !== "request_error") {
        firstScored++;
        if (typeOk(r, r.firstGot, r.firstGotTypes, r.firstActionCount ?? 1)) firstTypeCorrect++;
      }
    }
    if (outcome === "request_error") continue;
    const tOk = typeOk(r, r.got, r.gotTypes, countOf(r));
    if (tOk) typeCorrect++;
    else failures.push({ id: r.id, expected: r.expected, got: r.got });
    if (r.expected === "ask") {
      askTotal++;
      if (r.got === "ask") {
        askCorrect++;
        if (r.gotNeeds === r.expectedNeeds) needCorrect++;
        else needFailures.push({ id: r.id, expectedNeeds: r.expectedNeeds, gotNeeds: r.gotNeeds ?? null });
      } else needFailures.push({ id: r.id, expectedNeeds: r.expectedNeeds, gotNeeds: r.gotNeeds ?? null });
    }
    const slot = r.slot ?? { fields: [], pass: 0, total: 0 };
    if (slot.total > 0) {
      slotCases++;
      slotPass += slot.pass;
      slotTotal += slot.total;
      if (slot.pass === slot.total) slotCasesPass++;
      for (const f of slot.fields) {
        slotFieldCounts[f.field] = slotFieldCounts[f.field] ?? { pass: 0, total: 0 };
        slotFieldCounts[f.field].total++;
        if (f.ok) slotFieldCounts[f.field].pass++;
        else slotFailures.push({ id: r.id, field: f.field });
      }
    }
    const slotOk = slot.total === 0 || slot.pass === slot.total;
    const needOk = r.expected !== "ask" || r.gotNeeds === r.expectedNeeds;
    if (tOk && slotOk && needOk) fullyCorrect++;
  }
  const scoredTotal = total - requestErrors;
  if (!anyFirst) { firstValid = valid; firstInvalid = invalidJson; firstRequestErrors = requestErrors; firstTypeCorrect = typeCorrect; firstScored = scoredTotal; }
  return {
    total, requestErrors, requestErrorPct: pct(requestErrors, total), scoredTotal,
    validJson: valid, invalidJson, validJsonPct: pct(valid, valid + invalidJson),
    typeCorrect, typeAccuracyPct: pct(typeCorrect, scoredTotal),
    correct: fullyCorrect, accuracyPct: pct(fullyCorrect, scoredTotal),
    askTotal, askCorrect, askAccuracyPct: pct(askCorrect, askTotal),
    needCorrect, needAccuracyPct: pct(needCorrect, askTotal),
    slotPass, slotTotal, slotAccuracyPct: pct(slotPass, slotTotal),
    slotCases, slotCasesPass, slotCaseAccuracyPct: pct(slotCasesPass, slotCases),
    slotFieldCounts,
    firstValidJsonPct: pct(firstValid, firstValid + firstInvalid),
    firstTypeAccuracyPct: pct(firstTypeCorrect, firstScored), firstRequestErrors,
    retries, recovered, requestRecovered, retryRecoveryPct: pct(recovered, initiallyInvalid),
    initiallyInvalid, initiallyRequestError,
    failures, slotFailures, needFailures,
  };
}

// runCaseEvaluation(c, ctx, attemptFn) -> one scored result. attemptFn is
// (prompt) => raw model string, or throws on transport failure (the
// runner passes the real Workers AI call; tests pass fakes). Retry
// boundary, verified against production interpretText (0-a): interpretText
// retries exactly once on call/parse failures (transport error or
// unparseable output) and NEVER calls validateInterpreterAction —
// validation happens outside it, in the caller's policy path (everyday.js
// runInterpPolicy; here in mapOutcome/scoreSlots). So a valid JSON
// response whose actions fail validation is a FINAL outcome with NO
// retry: the retry covers transport errors and unparseable output ONLY.
// (gotNeeds derivation matches the real validation contract: validation
// errors are only "type"/"amount"/"time"/"project" — "past" is collapsed
// to "time" inside validateInterpreterAction — all in INTERPRETER_NEEDS.)
// First-attempt fields record the raw model behaviour before any retry;
// final fields record the post-retry outcome. Transport failure on the
// final attempt yields outcome "request_error" (no slots scored — no
// model evidence).
export async function runCaseEvaluation(c, ctx, attemptFn) {
  const prompt = buildInterpreterPrompt({ text: c.text, source: "text", recentTurns: [], openQuestion: null, projects: ctx.projects, nowIso: ctx.nowIso, defaultCurrency: ctx.defaultCurrency });
  let firstOutcome = null, firstGot = null, firstGotTypes = [], firstActionCount = 0, firstValidJson = false;
  let retried = false, recovered = false, requestRecovered = false;
  let outcome = null, mapped = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw = null, err = null;
    try { raw = await attemptFn(prompt); } catch (e) { err = e; }
    if (err) {
      if (attempt === 0) { firstOutcome = "request_error"; firstGot = "request_error"; firstValidJson = false; retried = true; continue; }
      outcome = "request_error";
      mapped = { got: "request_error", gotTypes: [], gotActionCount: 0, gotNeeds: null, validJson: false, validated: [] };
      break;
    }
    const parsed = parseInterpreterOutput(raw);
    if (attempt === 0) {
      firstOutcome = parsed.ok ? "valid" : "invalid_json";
      firstValidJson = parsed.ok;
      if (parsed.ok) {
        const fm = mapOutcome(parsed, parsed.actions, ctx);
        firstGot = fm.got; firstGotTypes = fm.gotTypes; firstActionCount = fm.gotActionCount;
      } else { firstGot = "invalid"; firstActionCount = 0; }
    }
    if (parsed.ok) {
      if (attempt === 1 && firstOutcome === "invalid_json") recovered = true;
      if (attempt === 1 && firstOutcome === "request_error") requestRecovered = true;
      outcome = "valid";
      mapped = mapOutcome(parsed, parsed.actions, ctx);
      break;
    }
    if (attempt === 0) { retried = true; continue; }
    outcome = "invalid_json";
    mapped = { got: "invalid", gotTypes: [], gotActionCount: 0, gotNeeds: null, validJson: false, validated: [] };
  }
  let slot = { fields: [], pass: 0, total: 0 };
  if (c.expected !== "multi" && c.slots && outcome !== "request_error") {
    const primary = mapped.validated[0] ?? null;
    slot = scoreSlots(c.slots, primary?.action ?? null, primary?.validation ?? null, ctx);
  }
  return {
    id: c.id, expected: c.expected, expectedTypes: c.types ?? null, expectedNeeds: c.needs ?? null,
    got: mapped.got, gotTypes: mapped.gotTypes, gotActionCount: mapped.gotActionCount, gotNeeds: mapped.gotNeeds,
    validJson: mapped.validJson, outcome, firstGot, firstGotTypes, firstActionCount, firstValidJson, firstOutcome,
    retried, recovered, requestRecovered, slot,
  };
}

async function callWorkersAI(token, account, model, prompt) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], temperature: 0, max_tokens: 300 }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Workers AI HTTP ${res.status}`);
  const text = typeof body.result?.response === "string" ? body.result.response : typeof body.result === "string" ? body.result : "";
  return text;
}

async function main() {
  const args = process.argv.slice(2);
  let casesPath = BUNDLED_CASES;
  const models = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cases") { casesPath = path.resolve(args[++i]); continue; }
    models.push(args[i]);
  }
  if (casesPath !== BUNDLED_CASES) {
    console.error("Refused: only the bundled synthetic set may be evaluated. Real messages never leave D1.");
    process.exit(1);
  }
  if (!models.length) {
    console.log("Usage: CF_API_TOKEN=... CF_ACCOUNT_ID=... node scripts/eval-intent.mjs <model-id> [<model-id> ...]");
    console.log("No model is chosen by this script. Example candidates to verify against the current Workers AI list:");
    for (const m of EXAMPLE_MODELS) console.log(`  ${m}`);
    return;
  }
  const token = process.env.CF_API_TOKEN, account = process.env.CF_ACCOUNT_ID;
  if (!token || !account) {
    console.error("Missing CF_API_TOKEN or CF_ACCOUNT_ID in the environment. Fill them locally; never share them in chat.");
    process.exit(1);
  }
  const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  // ONE captured instant for the whole run: prompt and validation context
  // share it, so relative dates cannot skew between the two.
  const nowMs = Date.now();
  const ctx = { projects: SEED_PROJECTS, nowMs, nowIso: iranNowIso(nowMs), defaultCurrency: "TOMAN" };
  for (const model of models) {
    const results = [], latencies = [];
    for (const c of cases) {
      const start = Date.now();
      results.push(await runCaseEvaluation(c, ctx, (prompt) => callWorkersAI(token, account, model, prompt)));
      latencies.push(Date.now() - start);
    }
    const s = scoreEvalResults(results);
    console.log(`\n== ${model} ==`);
    console.log(`cases: ${s.total}, scored: ${s.scoredTotal}, type accuracy: ${s.typeAccuracyPct}% (${s.typeCorrect}/${s.scoredTotal}), fully correct: ${s.accuracyPct}% (${s.correct}/${s.scoredTotal})`);
    console.log(`slot accuracy: ${s.slotAccuracyPct}% (${s.slotPass}/${s.slotTotal} fields, ${s.slotCasesPass}/${s.slotCases} slot cases fully correct)`);
    console.log(`ask accuracy: ${s.askAccuracyPct}% (${s.askCorrect}/${s.askTotal}), need accuracy: ${s.needAccuracyPct}% (${s.needCorrect}/${s.askTotal})`);
    console.log(`valid JSON (final, among responses): ${s.validJsonPct}% (${s.validJson}/${s.validJson + s.invalidJson}); first-attempt valid JSON: ${s.firstValidJsonPct}%, first-attempt type accuracy: ${s.firstTypeAccuracyPct}%`);
    console.log(`request errors: ${s.requestErrors} (${s.requestErrorPct}% of cases; first-attempt: ${s.firstRequestErrors}); retries: ${s.retries}, retry recovery (invalid->valid): ${s.retryRecoveryPct}% (${s.recovered}/${s.initiallyInvalid}), request-error recovery: ${s.requestRecovered}`);
    console.log(`median latency (per case, incl. retries): ${median(latencies)}ms`);
    console.log("Neuron cost: read from the Cloudflare dashboard for this run window (not in the API response).");
    for (const f of s.failures) console.log(`  FAIL ${f.id}: expected ${f.expected}, got ${f.got}`);
    for (const f of s.slotFailures) console.log(`  SLOT-FAIL ${f.id}: field ${f.field}`);
    for (const f of s.needFailures) console.log(`  NEED-FAIL ${f.id}: expected need ${f.expectedNeeds}, got ${f.gotNeeds}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
export { INTERPRETER_TYPES, INTERPRETER_NEEDS };
