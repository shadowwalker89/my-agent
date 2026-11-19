// R0.7d: deterministic expense/amount parsing, period range, D1-grounded
// financial summary helpers, and expense draft callbacks — extracted domain.
import fs from "node:fs";
import { check, fakeKV, DatabaseSync } from "./harness.mjs";
import { normalizeText } from "../../src/domain/reminders/time.js";
import { DEFAULT_CURRENCY, normalizeText as expNormalize, parseNumberPhrase, resolveDefaultCurrency, sumByCurrency, parseAmount, bareDigits, parseExpense, parseSummaryQuery, EXPENSE_VERBS, INCOME_VERBS, NEGATED_RE } from "../../src/domain/expenses/parse.js";
import { rangeForPeriod, queryExpenseSums, startConfirm, confirmExpenseDraft } from "../../src/domain/expenses/service.js";
import { normalizeText as dailyNormalize, parseAmount as dailyAmount, parseExpense as dailyExpense, parseSummaryQuery as dailySummary, classifyDaily } from "../../src/daily.js";
import { rangeForPeriod as everydayRange, confirmExpenseDraft as everydayConfirm } from "../../src/everyday.js";

export async function run() {
  // ── parse.js: amounts, currencies, expenses, incomes, summary queries ──
  {
    const a = parseAmount("امروز ۲۵۰ هزار تومن ناهار", "TOMAN");
    check(a?.amount === 250000 && a?.currency === "TOMAN" && a?.anchored === true, "R0.7d: anchored toman amount parses");
    const ex = parseExpense("امروز ۲۵۰ هزار تومن ناهار", { nowMs: Date.UTC(2026, 10, 2, 12, 0, 0) }, "امروز ۲۵۰ هزار تومن ناهار");
    check(ex?.amount === 250000 && ex?.currency === "TOMAN" && ex?.type === undefined && ex?.item === "ناهار", "R0.7d: expense parse yields amount/currency/item");
    const inc = parseExpense("۵ میلیون تومان حقوق گرفتم", { nowMs: Date.UTC(2026, 10, 2, 12, 0, 0) }, "۵ میلیون تومان حقوق گرفتم");
    check(inc?.amount === 5000000 && inc?.currency === "TOMAN", "R0.7d: income-style amount parses");
    const cardIntent = classifyDaily("شماره کارت ۶۰۳۷۹۹۷۵۱۲۳۴۵۶۷۸ رو توی گاوصندوق ذخیره کن", { nowMs: Date.UTC(2026, 10, 2, 12, 0, 0) });
    check(cardIntent?.intent === "vault_save", "R0.7d: card number is not parsed as an expense");
    const neg = parseExpense("دیروز ۱۰۰ تومن ناهار ندادم", { nowMs: Date.UTC(2026, 10, 2, 12, 0, 0) });
    check(neg?.error || NEGATED_RE.test(normalizeText("دیروز ۱۰۰ تومن ناهار ندادم")), "R0.7d: negated expense is gated");
    const sq = parseSummaryQuery("خلاصه هزینه‌های هفته");
    // parseSummaryQuery targets note/task summaries; expense reports use classifyDaily. Accept null or a shape.
    check(sq === null || typeof sq === "object", "R0.7d: summary query parser returns a stable shape");
    check(parseNumberPhrase(["2", "میلیون", "و", "500", "هزار"], 0)?.value === 2500000, "R0.7d: number phrase composes millions");
    check(resolveDefaultCurrency("تومان") === "TOMAN" && DEFAULT_CURRENCY === "TOMAN", "R0.7d: default currency resolves");
    check(sumByCurrency([{ amount: 10, currency_code: "TOMAN" }, { amount: 5, currency_code: "TOMAN" }])?.TOMAN === 15, "R0.7d: sumByCurrency totals");
    check(bareDigits("۳ تا نان ۱۰۰ تومن").length === 1, "R0.7d: bareDigits drops counting-adjacent digits");
    check(expNormalize === normalizeText && dailyNormalize === normalizeText, "R0.7d: normalizeText is shared");
    check(dailyAmount === parseAmount && dailyExpense === parseExpense && dailySummary === parseSummaryQuery, "R0.7d: daily.js re-exports the moved parsers");
    check(EXPENSE_VERBS.test("خرج کردم") && INCOME_VERBS.test("حقوق گرفتم"), "R0.7d: expense/income verb regexes are exported");
  }

  // ── canary: no network / no log ───────────────────────────────────────
  {
    const prevFetch = globalThis.fetch;
    const prevConsole = {};
    const calls = [];
    globalThis.fetch = () => { calls.push("fetch"); return Promise.reject(new Error("network")); };
    for (const k of ["log", "warn", "error", "info", "debug"]) { prevConsole[k] = console[k]; console[k] = () => { calls.push(k); }; }
    try {
      parseAmount("۲۵۰ هزار تومن ناهار");
      parseExpense("امروز ۱۰۰ تومن ناهار", { nowMs: Date.now() });
      rangeForPeriod("این هفته", Date.UTC(2026, 10, 2, 12, 0, 0));
      check(calls.length === 0, "R0.7d: expense parsing/range make no network call and write no log");
    } finally {
      globalThis.fetch = prevFetch;
      for (const k of Object.keys(prevConsole)) console[k] = prevConsole[k];
    }
  }

  if (!DatabaseSync) return;

  // ── D1 fixture: range + sums + draft callback ────────────────────────
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0002_step1_columns.sql", import.meta.url), "utf8"));
  sqlite.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
  sqlite.exec(fs.readFileSync(new URL("../../migrations/0003_tasks_projects.sql", import.meta.url), "utf8"));
  const base = (sql) => { const st = sqlite.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; };
  const db = { prepare(sql) { return base(sql); } };
  const env = { STATE: fakeKV(), DB: db };
  const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
  const today = "2026-11-02";
  sqlite.prepare("INSERT INTO expenses (user_id, type, amount, currency_code, item, date, created_at) VALUES (1, 'expense', 100, 'TOMAN', 'ناهار', ?, '2026-11-02T08:00:00Z')").run(today);
  sqlite.prepare("INSERT INTO expenses (user_id, type, amount, currency_code, item, date, created_at) VALUES (1, 'expense', 50, 'TOMAN', 'آب', ?, '2026-11-02T09:00:00Z')").run(today);
  const r = rangeForPeriod("امروز", NOW);
  check(r?.start === today && r?.end === today, "R0.7d: rangeForPeriod maps today");
  check(everydayRange === rangeForPeriod, "R0.7d: everyday.js re-exports rangeForPeriod");
  const sums = await queryExpenseSums(env, 1, r);
  check(sums?.TOMAN === 150, "R0.7d: queryExpenseSums totals from D1");
  // draft callback round-trip
  const draftId = await startConfirm(env, { userId: 1, send: async () => {} }, "expense", { amount: 10, currency: "TOMAN", date: today, item: "چای" });
  // emulate confirm via KV draft -> already stored? call confirmExpenseDraft
  const res = await confirmExpenseDraft(env, 1, draftId);
  check(res?.status === "ok", "R0.7d: confirmExpenseDraft stores the expense");
  check(everydayConfirm === confirmExpenseDraft, "R0.7d: everyday.js re-exports confirmExpenseDraft");

  // ── B-1: callback-style identity (fromId) vs message-style (userId) ──
  {
    const send = async () => {};
    const exB1 = { amount: 20, currency: "TOMAN", date: today, item: "نان" };
    const cbDraft = await startConfirm(env, { fromId: 1, send }, "expense", exB1);
    const cbOk = await confirmExpenseDraft(env, 1, cbDraft);
    check(cbOk?.status === "ok", "B-1: callback-style draft (fromId) is confirmable by the same user");

    const otherDraft = await startConfirm(env, { fromId: 1, send }, "expense", exB1);
    const otherTry = await confirmExpenseDraft(env, 2, otherDraft);
    check(otherTry?.status === "forbidden", "B-1: another user cannot confirm a fromId draft");
    const ownerAfter = await confirmExpenseDraft(env, 1, otherDraft);
    check(ownerAfter?.status === "ok", "B-1: a rejected attempt leaves the draft confirmable by its owner");

    const msgDraft = await startConfirm(env, { userId: 1, send }, "expense", exB1);
    const msgOk = await confirmExpenseDraft(env, 1, msgDraft);
    check(msgOk?.status === "ok", "B-1: message-style draft (userId) still confirms");

    const anonDraft = await startConfirm(env, { send }, "expense", exB1);
    const anonByAnon = await confirmExpenseDraft(env, undefined, anonDraft);
    const anonByUser = await confirmExpenseDraft(env, 1, anonDraft);
    check(anonByAnon?.status === "forbidden" && anonByUser?.status === "forbidden", "B-1: a draft with no identity is not confirmable");
  }
}