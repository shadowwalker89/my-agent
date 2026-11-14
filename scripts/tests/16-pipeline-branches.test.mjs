// R0.8a: pipeline branch extraction — context/policy/interp/model/nlu.
// Given/When/Then on the modules moved out of src/everyday.js; the same
// contracts must hold for the re-exports everyday.js keeps for callers.
import fs from "node:fs";
import { check, fakeKV, DatabaseSync } from "./harness.mjs";
import { saveMessage, getMessageRow } from "../../src/db.js";
import { CHAT_CONTEXT_CHAR_LIMIT, buildChatContext, chatFailureNotice, formatFailureDetail, resolveQuickConvertCallback, resolveChatRetryCallback, EXPIRED_TEXT } from "../../src/pipeline/context.js";
import { runInterpPolicy, interpKey, interpTypeKeyboard, newInterpRecord } from "../../src/pipeline/policy.js";
import { breakerFlag, recordInterpError, callBackupModel, runBackupInterpretation, interpretAndExecute } from "../../src/pipeline/interp-runner.js";
import { resolveInterpCallback } from "../../src/pipeline/interp-callbacks.js";
import { runTaskConversion } from "../../src/pipeline/interp-conversions.js";
import { runModelBranch } from "../../src/pipeline/model-branch.js";
import { resolveAskCallback } from "../../src/pipeline/ask-callback.js";
import { setPendingAsk, askText } from "../../src/pipeline/route.js";
import { isUnambiguousQuestion, REF_RE } from "../../src/pipeline/nlu-skip.js";
import { runNluBranch } from "../../src/pipeline/nlu-branch.js";

const T = Date.UTC(2026, 10, 2, 12, 0, 0);
const mkS = () => { const sent = []; const chats = []; let edits = 0; return { sent, chats, edits: () => edits, send: async (t, opts) => { sent.push({ text: t, opts }); }, chat: async (t, opts) => { chats.push({ text: t, opts }); }, editMarkup: async () => { edits++; } }; };

export async function run() {
  // ── Given a chat history, When buildChatContext runs, Then fake headers drop
  {
    const rows = [
      { role: "assistant", content: "✅ **یادداشت جدید** چیزی" },
      { role: "user", content: "سؤال من" },
      { role: "assistant", content: "پاسخ واقعی" },
    ];
    const ctx = buildChatContext(rows, { memoryHeader: "🧠 حافظه: کاربر اهل گلبهار است" });
    check(ctx[0].role === "system" && ctx[0].content.includes("گلبهار"), "R0.8a: memory header is prepended as a system turn");
    check(ctx.some((m) => m.content === "سؤال من") && !ctx.some((m) => m.content.includes("یادداشت جدید")), "R0.8a: hallucinated confirmation header is filtered out");
    check(CHAT_CONTEXT_CHAR_LIMIT === 8000, "R0.8a: context char limit re-exported from everyday.js's old home");
  }

  // ── Given a failure notice, When built, Then retry button re-taps the raw callback (R0.8a regression)
  {
    const n2 = chatFailureNotice("خلاصه‌سازی", null, { retryData: "note:sum:all" });
    const kb = n2.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data);
    check(n2.text === "❌ مرحله‌ی خلاصه‌سازی شکست خورد." && kb.includes("note:sum:all"), "R0.8a: raw retryData rides verbatim as the retry callback (summary re-tap)");
    check(chatFailureNotice("چت", null, {}).replyMarkup === undefined, "R0.8a: notice without ids carries no buttons");
    check(formatFailureDetail(["a: 1", "b: 2", "c: 3", "d: 4"]).includes("+1 مورد دیگر"), "R0.8a: failure detail caps at 3 lines + overflow");
    check(formatFailureDetail([]) === "", "R0.8a: empty failure detail stays empty");
  }

  // ── Given an unambiguous question, When asked, Then the NLU is skipped entirely
  {
    check(isUnambiguousQuestion("تفاوت ری‌اکت و ویو چیه؟") === true, "R0.8a: question-word + no action keyword never reaches the NLU");
    check(isUnambiguousQuestion("خلاصه یادداشت‌هام چیه؟") === false, "R0.8a: note/summary keywords keep the NLU path");
    check(isUnambiguousQuestion("یادداشت کن فردا جلسه") === false, "R0.8a: capture-style text never skips the NLU");
    check(REF_RE.test("همونو برای فردا بذار") === true && REF_RE.test("یه چیز دیگه") === false, "R0.8a: reference regex matches only همان/اون/این family");
    let aiCalled = false;
    const envAi = { STATE: fakeKV(), AI: { run: async () => { aiCalled = true; throw new Error("AI must not run"); } } };
    const out = await runNluBranch(envAi, { userId: 1, text: "تفاوت ری‌اکت و ویو چیه؟", send: async () => {}, chat: async () => {} }, { now: T, remembered: "TOMAN" }, { runDailyBranch: async () => "handled" });
    check(out === null && aiCalled === false, "R0.8a: unambiguous question returns null with zero AI calls");
  }

  // ── Given a model-free environment, When the model slot runs, Then the injected dispatcher is used
  {
    let threw = false;
    try { await runModelBranch({ STATE: fakeKV() }, { userId: 1, text: "سلام", send: async () => {}, chat: async () => {} }, { intent: "ask", question: "amount" }, { now: T, remembered: "TOMAN" }); } catch (e) { threw = /runDailyBranch/.test(String(e?.message)); }
    check(threw, "R0.8a: model branch without deps.runDailyBranch fails loudly, never silently");
    const s = mkS();
    const out = await runModelBranch({ STATE: fakeKV() }, { userId: 1, text: "سلام", send: s.send, chat: s.chat }, { intent: "ask", question: "amount" }, { now: T, remembered: "TOMAN" }, { runDailyBranch: async () => "handled" });
    check(out.ret === "handled" && out.outcome === "asked", "R0.8a: ask rule with no model routes through the injected dispatcher");
  }

  // ── Given an hour-ambiguous slot, When the user taps cancel, Then the ask is dropped politely
  {
    const env = { STATE: fakeKV() };
    await setPendingAsk(env, 1, askText("hour-ambiguous"), undefined, "hour-ambiguous", "یادم بنداز فردا ساعت ۸ جلسه");
    const s = mkS();
    await resolveAskCallback(env, { fromId: 1, data: "ask:cancel", send: s.send, editMarkup: s.editMarkup, nowMs: T });
    check(s.sent[0].text === "❌ یادآوری لغو شد.", "R0.8a: ask:cancel clears the pending hour-ambiguous slot");
  }

  // ── Given a circuit breaker, When errors accumulate, Then the interpreter stays dark
  {
    const env = { STATE: fakeKV() };
    await recordInterpError(env, "other");
    await recordInterpError(env, "other");
    check((await breakerFlag(env)) === null, "R0.8a: breaker opens only after 3 errors in the window");
    await recordInterpError(env, "other");
    check(Boolean(await breakerFlag(env)), "R0.8a: third consecutive error opens the breaker");
    const s = mkS(); let ai = 0;
    await interpretAndExecute(env, { userId: 1, text: "یادداشت کن تست", send: s.send, interpreterCallFn: async () => { ai++; return "[]"; } }, { now: T, remembered: "TOMAN" }, "یادداشت کن تست", null, async () => ({ ok: true }));
    const flat = s.sent[0].opts.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data);
    check(s.sent[0].text === "تفسیر خودکار الان در دسترس نیست؛ خودت نوعش را بگو:" && flat.some((d) => d.startsWith("interp:backup:")) && ai === 0, "R0.8a: open breaker sends unavailable reply with zero model calls");
  }

  // ── Given a sensitive payload, When backed up, Then the model never sees the raw digits
  {
    let captured = "";
    const s = mkS();
    await runBackupInterpretation({ STATE: fakeKV() }, { userId: 1, fromId: 1, text: "شماره کارت 6037701234567890 یادداشت کن", send: s.send, backupCallFn: async (m) => { captured = m; return "[]"; } }, "شماره کارت 6037701234567890 یادداشت کن", null, async () => ({ ok: true }));
    check(captured.length > 0 && !captured.includes("6037701234567890"), "R0.8a: backup masking removes the card number before the model sees it");
    const s2 = mkS();
    await runBackupInterpretation({ STATE: fakeKV() }, { userId: 1, fromId: 1, text: "متن", send: s2.send }, "متن", null, async () => ({ ok: true }));
    check(s2.sent[0].text === "مدل بیرونی وصل نیست؛ خودت نوعش را بگو:", "R0.8a: no backup binding reports not-connected, never chat, never drop");
    const raw = await callBackupModel("x", async () => "y");
    check(raw.ok === true && raw.text === "y", "R0.8a: callBackupModel seam returns the raw model string");
    check((await callBackupModel("x", null)).reason === "no-provider-binding", "R0.8a: no binding is honest, not a silent drop");
  }

  if (!DatabaseSync) { console.warn("⚠ node:sqlite در دسترس نیست — آزمون‌های D1 شاخه‌ها رد شد."); return; }

  const sq = new DatabaseSync(":memory:");
  sq.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sq.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sq.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
  sq.prepare("INSERT INTO users (id, telegram_id) VALUES (1, '1'), (2, '2')").run();
  const base = (sql) => { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
  const db = { prepare(sql) { return base(sql); } };
  const env = { STATE: fakeKV(), DB: db };
  const rows = (sql, p = []) => sq.prepare(sql).all(...p);

  // ── Given a stored user message, When qconv is tapped, Then it converts once
  {
    await saveMessage(db, { userId: 1, role: "user", content: "متن تبدیل من", kind: "chat" });
    const mine = rows("SELECT id FROM messages WHERE user_id = 1")[0].id;
    const s = mkS();
    await resolveQuickConvertCallback(env, { fromId: 1, data: `qconv:note:${mine}`, send: s.send, chat: s.chat, editMarkup: s.editMarkup, nowMs: T });
    check(s.sent[0].text === "✅ به یادداشت تبدیل شد." && rows("SELECT text FROM notes WHERE user_id = 1")[0].text === "متن تبدیل من", "R0.8a: qconv:note stores the stored text as a note");
    const s2 = mkS();
    await resolveChatRetryCallback(env, { fromId: 1, data: `chat:retry:${mine}`, send: s2.send, chat: s2.chat, editMarkup: s2.editMarkup, nowMs: T });
    check(s2.chats.length === 1 && s2.chats[0].opts.saveText === "" && s2.chats[0].text === "متن تبدیل من", "R0.8a: chat:retry re-runs the stored text with no second save");
  }

  // ── Given an interpreter record, When a type button is tapped, Then the note is stored
  {
    await newInterpRecord(env, 1, { text: "یادداشت من" });
    const id = [...env.STATE.store.keys()].map((k) => k.replace(/^interp:/, ""))[0];
    const s = mkS();
    await resolveInterpCallback(env, { fromId: 1, data: `interp:type:note:${id}`, send: s.send, chat: s.chat, editMarkup: s.editMarkup, nowMs: T });
    check(s.sent[0].text.includes("یادداشت ذخیره شد") && rows("SELECT text FROM notes WHERE user_id = 1 AND text = 'یادداشت من'").length === 1, "R0.8a: interp:type:note stores the note and confirms");
    const sMissing = mkS();
    await resolveInterpCallback(env, { fromId: 1, data: "retry:999999", send: sMissing.send, chat: sMissing.chat, editMarkup: sMissing.editMarkup, nowMs: T });
    check(sMissing.sent[0].text.includes("متن پیام پیدا نشد"), "R0.8a: retry with a missing pending row offers the type buttons, never a silent tap");
  }

  // ── Given a validated chat action, When policy runs, Then direct chat flows through
  {
    const s = mkS(); let finalized = "";
    await runInterpPolicy(env, { userId: 1, text: "سلام", send: s.send, chat: s.chat }, { now: T, remembered: "TOMAN" }, [{ type: "chat", text: "سلام", confidence: 1, needs: "none" }], async (kind) => { finalized = kind; return { ok: true }; });
    check(s.chats.length === 1 && s.chats[0].text === "سلام" && finalized === "chat", "R0.8a: direct chat action finalises as chat, message sent once");
    const sLow = mkS();
    await runInterpPolicy(env, { userId: 1, text: "ترموگراف", send: sLow.send, chat: sLow.chat }, { now: T, remembered: "TOMAN" }, [{ type: "note", text: "ترموگراف", confidence: 0.2, needs: "none" }], async () => ({ ok: true }));
    check(sLow.sent[0].text === "نوعش را بگو:", "R0.8a: low-confidence action falls back to the type buttons, never a guess");
  }

  // ── Given a task-change record with target task, When conversion runs, Then no-op + record dropped
  {
    sq.prepare("INSERT INTO tasks (user_id, title, status, created_at) VALUES (1, 'تسک من', 'open', '2026-11-02T00:00:00Z')").run();
    const taskId = rows("SELECT id FROM tasks WHERE user_id = 1")[0].id;
    const { putKv, getKv } = await import("../../src/pipeline/context.js");
    await putKv(env, interpKey("rec1"), { owner: 1, changeTaskId: taskId, text: "تسک من", target: "task" });
    const s = mkS();
    await runTaskConversion(env, { userId: 1, send: s.send, nowMs: T }, { owner: 1, changeTaskId: taskId, text: "تسک من", target: "task" }, "task", "rec1");
    check(s.sent[0].text === "این مورد همین حالا تسک است." && (await getKv(env, interpKey("rec1"))) === null, "R0.8a: task→task conversion is a clean no-op that drops the record");
  }

  // ── Given the extracted modules, When re-exported through everyday.js, Then the back-compat surface holds
  {
    const everyday = await import("../../src/everyday.js");
    check(everyday.CHAT_CONTEXT_CHAR_LIMIT === CHAT_CONTEXT_CHAR_LIMIT, "R0.8a: everyday re-exports the pipeline chart constant");
    check(everyday.buildChatContext === buildChatContext && everyday.quickConvertKeyboard !== undefined && everyday.resolveInterpCallback === resolveInterpCallback, "R0.8a: everyday re-exports pipeline functions verbatim");
    check(typeof everyday.runNluBranch === "function" && typeof everyday.runModelBranch === "function" && typeof everyday.resolveAskCallback === "function", "R0.8a: everyday exposes the DI wrappers for model/nlu/ask branches");
    check(EXPIRED_TEXT.length > 0, "R0.8a: shared expiry text travels with the pipeline modules");
  }
}
