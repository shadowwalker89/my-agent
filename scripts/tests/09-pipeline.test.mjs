// R0.6 pipeline extraction tests: deterministic validators, model
// prompt/parse, routing/pending-ask slots, and sensitive-text masking.
import { check, fakeKV } from "./harness.mjs";
import {
  validateAmountText,
  validateDateTexts,
  matchProject,
  validateInterpreterAction,
  parseModelIntent,
  extractJsonObject,
  recoverFullNoteBody,
} from "../../src/pipeline/validate.js";
import {
  buildInterpreterPrompt,
  parseInterpreterOutput,
  interpretText,
  maskSensitive,
  unmaskAction,
} from "../../src/pipeline/interpret.js";
import {
  classifyTask,
  selectCombo,
  resolveInterpreterModel,
  resolvePipelineMode,
  setPendingAsk,
  getPendingAsk,
  clearPendingAsk,
  parseLanguageAnswer,
  deriveTranslateBody,
  DEFAULT_INTERPRETER_MODEL,
} from "../../src/pipeline/route.js";

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

export async function run() {
  // ── validate.js: money, dates, projects, actions ─────────────────────────
  {
    const a = validateAmountText("۲۰۰ تومن", "TOMAN");
    check(a.ok === true && a.amount === 200 && a.currency === "TOMAN", "R0.6: validateAmountText parses a currency amount");
    check(validateAmountText(null, "TOMAN").ok === true, "R0.6: null amount is valid but unresolved");
    check(validateAmountText("", "TOMAN").ok === false, "R0.6: empty amount text fails");
    check(validateAmountText("نه فلان هزار", "TOMAN").ok === false, "R0.6: unparsable amount fails");

    const d = validateDateTexts("امروز", "فردا ساعت ۹ صبح", NOW);
    check(d.ok === true && d.due_at === "2026-10-31T00:00:00+03:30", "R0.6: due date resolves today");
    check(d.remind_at === "2026-11-01T09:00:00+03:30", "R0.6: reminder date resolves tomorrow 09:00");
    const past = validateDateTexts("دیروز", null, NOW);
    check(past.ok === false && past.errors.includes("past"), "R0.6: past date is rejected");
    const needTime = validateDateTexts(null, "فردا", NOW);
    check(needTime.ok === false && needTime.errors.includes("time"), "R0.6: reminder needs a time");

    const projects = [{ name: "یوتیوب", aliases: ["یوتیوب"] }, { name: "خانه" }];
    check(matchProject("یوتیوب", projects)?.name === "یوتیوب", "R0.6: matchProject matches name/alias");
    check(matchProject("ناموجود", projects) === null, "R0.6: matchProject never invents a project");

    const ex = validateInterpreterAction({ type: "expense", text: "نان", amount_text: "۲۰۰ تومن" }, { defaultCurrency: "TOMAN", projects });
    check(ex.ok === true && ex.resolved.amount === 200 && ex.resolved.currency === "TOMAN", "R0.6: validateInterpreterAction resolves an amount");
    const bad = validateInterpreterAction({ type: "nope", text: "x" });
    check(bad.ok === false && bad.errors.includes("type"), "R0.6: unknown action type fails");
    const badProject = validateInterpreterAction({ type: "task", text: "x", project: "ناموجود" }, { projects });
    check(badProject.ok === false && badProject.errors.includes("project"), "R0.6: unknown project fails");
  }

  // ── validate.js: model-intent parsing / JSON repair ─────────────────────
  {
    check(parseModelIntent('{"intent":"expense"}')?.intent === "expense", "R0.6: parseModelIntent accepts an allowed intent");
    check(parseModelIntent('{"intent":"task"}') === null, "R0.6: parseModelIntent rejects out-of-list intent");
    const badTarget = parseModelIntent('{"intent":"translate","target":"de"}');
    check(badTarget?.invalid === "target", "R0.6: parseModelIntent flags an unknown translate target");
    check(parseModelIntent("not json") === null, "R0.6: parseModelIntent never guesses");

    const obj = extractJsonObject('<think>hidden</think>```json\n{"a":{"b":1}}\n```');
    check(obj?.a?.b === 1, "R0.6: extractJsonObject strips think/fences and parses nested JSON");
    check(extractJsonObject("no object here") === null, "R0.6: extractJsonObject returns null on no object");

    const body = recoverFullNoteBody("سلام یه یادداشت ثبت کن که فردا سیمان میرسه", "", null, null);
    check(body === "فردا سیمان میرسه", "R0.6: recoverFullNoteBody strips framing when the model body is empty");
  }

  // ── interpret.js: prompt, output parsing, one retry ─────────────────────
  {
    const prompt = buildInterpreterPrompt({ text: "یادداشت کن فردا جلسه", nowIso: "2026-10-31T12:00:00+03:30", defaultCurrency: "TOMAN" });
    check(prompt.system.includes("JSON array") && prompt.user.includes("[BEGIN USER MESSAGE"), "R0.6: buildInterpreterPrompt delimits user data");
    check(prompt.user.includes("یادداشت کن فردا جلسه") && prompt.user.includes("Default currency: TOMAN"), "R0.6: prompt carries text and currency context");

    const ok = parseInterpreterOutput('[{"type":"note","text":"جلسه","confidence":0.9,"needs":"none"}]');
    check(ok.ok === true && ok.actions.length === 1 && ok.actions[0].type === "note", "R0.6: parseInterpreterOutput accepts a valid action");
    check(parseInterpreterOutput("[]").ok === false, "R0.6: parseInterpreterOutput rejects an empty array");
    check(parseInterpreterOutput("garbage").reason === "invalid", "R0.6: parseInterpreterOutput rejects garbage");
    const tooMany = Array(7).fill('{"type":"chat","text":"x","confidence":1,"needs":"none"}');
    check(parseInterpreterOutput(`[${tooMany.join(",")}]`).reason === "too-many", "R0.6: parseInterpreterOutput enforces the action cap");

    let calls = 0;
    const valid = '[{"type":"chat","text":"سلام","confidence":1,"needs":"none"}]';
    const retried = await interpretText({ AI: { run: async () => valid } }, "m", prompt, async () => (++calls === 1 ? "bad" : valid));
    check(retried.ok === true && retried.calls === 2 && calls === 2, "R0.6: interpretText retries exactly once");
  }

  // ── interpret.js: sensitive-text masking canary ─────────────────────────
  {
    const secret = "شماره کارت 6037701234567890 و لینک https://example.com/secret";
    const { masked, table } = maskSensitive(secret);
    check(!/6037701234567890/.test(masked) && !masked.includes("https://example.com"), "R0.6: maskSensitive removes card number and URL before the model");
    check(/\{A\d+\}/.test(masked) && /\{U\d+\}/.test(masked), "R0.6: maskSensitive uses typed placeholders");
    const restored = unmaskAction({ type: "note", text: masked, due_text: masked }, table);
    check(restored.text === secret && restored.due_text === secret, "R0.6: unmaskAction restores the exact original text");
    check(secret.includes("6037701234567890"), "R0.6: canary input really contains the card number");
  }

  // ── route.js: task/combo routing and model resolution ───────────────────
  {
    check(classifyTask("```js\nconst x = 1;\n```") === "code", "R0.6: classifyTask detects a fenced code block");
    check(classifyTask("hello there") === "chat", "R0.6: classifyTask defaults to chat");
    check(classifyTask({ hasImage: true, text: "look" }) === "vision", "R0.6: classifyTask routes images to vision");
    check(selectCombo({ combo: "code" }, "vision").combo === "vision", "R0.6: selectCombo prefers the task combo");
    check(selectCombo({ auto: false, combo: "code" }, "vision").combo === "code", "R0.6: selectCombo honours auto=false");
    check(resolveInterpreterModel({}) === null, "R0.6: resolveInterpreterModel is off without AI/model");
    check(resolveInterpreterModel({ AI: { run: async () => "" } }) === DEFAULT_INTERPRETER_MODEL, "R0.6: AI binding resolves the default model");
    check(resolveInterpreterModel({ INTERPRETER_MODEL: "off" }) === null, "R0.6: INTERPRETER_MODEL=off disables the model");
    check(resolvePipelineMode({ AI: { run: async () => "" } }) === "nlu", "R0.6: pipeline mode is nlu with AI");
    check(resolvePipelineMode({}) === "model_slot", "R0.6: pipeline mode is model_slot without a model");
  }

  // ── route.js: pending-ask slot routing ──────────────────────────────────
  {
    const env = { STATE: fakeKV() };
    await setPendingAsk(env, 7, "چه چیزی را یادداشت کنم؟", undefined, "note-text", "body");
    const slot = await getPendingAsk(env, 7);
    check(slot?.kind === "note-text" && slot?.pendingBody === "body", "R0.6: setPendingAsk/getPendingAsk round-trip");
    await clearPendingAsk(env, 7);
    check((await getPendingAsk(env, 7)) === null, "R0.6: clearPendingAsk clears the slot");
    check(parseLanguageAnswer("انگلیسی") === "en" && parseLanguageAnswer("Deutsch") === null, "R0.6: parseLanguageAnswer maps only en/fa/ar");
    const body = deriveTranslateBody("whatever: hello world", { now: NOW, remembered: "TOMAN" });
    check(body === "hello world", "R0.6: deriveTranslateBody falls back to the colon body");
  }
}
