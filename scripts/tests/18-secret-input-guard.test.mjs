// R0 PR-B: R-2d — secret-shaped input outside vault_save/command gets static
// guidance: no LLM, no network, no messages row, no echo of the digits.
import fs from "node:fs";
import { check, fakeKV, DatabaseSync } from "./harness.mjs";
import { handleDailyText, SECRET_INPUT_GUIDANCE } from "../../src/pipeline/dispatch.js";
import { markDaily } from "../../src/pipeline/context.js";
import { looksSecret } from "../../src/pipeline/secret-shape.js";
import { classifyDaily } from "../../src/daily.js";
import { VAULT_REDACTED_TEXT } from "../../src/pipeline/daily-helpers.js";

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const CARD = "9999-8888-7777-6666";
const SHEBA = "IR062960000000100324200001";
const CARD_DIGITS = "9999888877776666";
const SHEBA_DIGITS = "062960000000100324200001";
const FA = "۰۱۲۳۴۵۶۷۸۹";
const AR = "٠١٢٣٤٥٦٧٨٩";
const toLatin = (s) => String(s).replace(/[۰-۹]/g, (d) => String(FA.indexOf(d))).replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)));
const toFa = (s) => String(s).replace(/[0-9]/g, (d) => FA[Number(d)]);
const digitsOnly = (s) => toLatin(s).replace(/\D/g, "");

function freshDb() {
  const sq = new DatabaseSync(":memory:");
  for (const f of ["0001_init.sql", "0002_step1_columns.sql", "0003_tasks_projects.sql"]) sq.exec(fs.readFileSync(new URL("../../migrations/" + f, import.meta.url), "utf8"));
  sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
  const db = { prepare(sql) { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; } };
  return { sq, db };
}

function baseEnv(db) {
  const env = { STATE: fakeKV(), VAULT_SECRET: "test-secret", TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242" };
  if (db) env.DB = db;
  return env;
}

function installRecorders(env, aiResponse, { withAi = true } = {}) {
  const records = [];
  const logs = [];
  const sent = [];
  const origFetch = globalThis.fetch;
  const orig = { log: console.log, warn: console.warn, error: console.error };
  if (withAi) env.AI = { run: async (model, body) => { records.push({ kind: "ai", model, body }); return aiResponse; } };
  globalThis.fetch = async (url, init = {}) => {
    records.push({ kind: "fetch", url: String(url), body: String(init.body ?? "") });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  for (const k of ["log", "warn", "error"]) console[k] = (...a) => { logs.push(a.map(String).join(" ")); };
  return {
    records, logs, sent,
    restore: () => { globalThis.fetch = origFetch; console.log = orig.log; console.warn = orig.warn; console.error = orig.error; },
  };
}

const rowContents = (sq) => sq.prepare("SELECT content FROM messages").all().map((r) => String(r.content ?? ""));

function runGuardCase(label, text, { db } = {}) {
  const env = baseEnv(db);
  const rec = installRecorders(env, { response: "{}" });
  const send = async (t) => { rec.sent.push(String(t)); };
  return (async () => {
    try {
      const ret = await handleDailyText(env, { chatId: 1, userId: 1, chatType: "private", text, send, chat: async () => {}, nowMs: NOW });
      check(ret === "handled", `${label}: returns the handled value (got ${JSON.stringify(ret)})`);
      check(rec.records.filter((r) => r.kind === "ai").length === 0, `${label}: zero AI.run calls`);
      check(rec.records.filter((r) => r.kind === "fetch").length === 0, `${label}: zero fetch calls`);
      check(rec.sent.length === 1 && rec.sent[0] === SECRET_INPUT_GUIDANCE, `${label}: exactly one reply equal to SECRET_INPUT_GUIDANCE (got ${rec.sent.length})`);
      const out = digitsOnly(rec.sent.join("\n") + "\n" + rec.logs.join("\n"));
      check(!out.includes(CARD_DIGITS) && !out.includes(SHEBA_DIGITS), `${label}: fake digits never appear in replies/console`);
      if (db) {
        const rows = rowContents(db.__sq);
        check(rows.length === 0, `${label}: messages has no new row (got ${rows.length})`);
        check(!digitsOnly(rows.join("\n")).includes(CARD_DIGITS) && !digitsOnly(rows.join("\n")).includes(SHEBA_DIGITS), `${label}: no fake digits in DB rows`);
      }
    } finally { rec.restore(); }
  })();
}

export async function run() {
  if (!DatabaseSync) return;

  const longPrefix = "امروز درباره کارهای خانه و خرید و برنامه‌های آخر هفته و دیدار دوستان و خانواده صحبت کردیم و تصمیم گرفتیم همه چیز را مرتب کنیم. ".repeat(2);
  const cases = [
    ["T1a original Sheba order", "شبای من\nIR062960000000100324200001\nذخیره کن\nممنون"],
    ["T1b card bare", `این شماره کارت منه ${CARD}`],
    ["T1c long text ending in a card", `${longPrefix}کارتم ${CARD} ثبتش کن`],
    ["T1d account lookup", `شماره حسابم ${CARD}`],
    ["T1e Sheba with Persian digits", toFa("شبای من\nIR062960000000100324200001\nذخیره کن\nممنون")],
    ["T1f card split by newlines", `این شماره کارت منه\n9999\n8888\n7777\n6666`],
    ["T1f card split by U+2013", `این شماره کارت منه 9999\u20138888\u20137777\u20136666`],
  ];
  for (const [label, text] of cases) {
    check(classifyDaily(text, { nowMs: NOW }).intent !== "vault_save", `${label}: deterministic intent is not vault_save`);
    const { sq, db } = freshDb(); db.__sq = sq;
    await runGuardCase(label, text, { db });
  }

  // T1b: no DB at all — the guard runs before the dbOf(env) check.
  {
    const env = baseEnv();
    const rec = installRecorders(env, { response: "{}" });
    const send = async (t) => { rec.sent.push(String(t)); };
    try {
      const ret = await handleDailyText(env, { chatId: 1, userId: 1, chatType: "private", text: `این شماره کارت منه ${CARD}`, send, chat: async () => {}, nowMs: NOW });
      check(ret === "handled" && ret !== "chat", `T1b no-DB: guard fires before dbOf (got ${JSON.stringify(ret)})`);
      check(rec.sent.length === 1 && rec.sent[0] === SECRET_INPUT_GUIDANCE, "T1b no-DB: static guidance sent");
      check(rec.records.length === 0, "T1b no-DB: no AI/fetch call");
    } finally { rec.restore(); }
  }

  // T2: a long note that mentions the vault/card words but has no 13+ digit run.
  {
    const lines = ["یادداشت کن", "امروز رفتم بانک", "با کارمند شعبه حرف زدم", "درباره گاوصندوق و شماره کارت پرسیدم", "او توضیح داد", "که باید فرم پر کنم", "بعد به خانه برگشتم", "ناهار خوردم", "کمی استراحت کردم", "بعد کتاب خواندم", "شب با خانواده صحبت کردم", "و همه چیز را یادداشت کردم"];
    const text = lines.join("\n");
    check(looksSecret(text) === false, "T2: long note is not secret-shaped");
    const { sq, db } = freshDb(); db.__sq = sq;
    const env = baseEnv(db);
    const rec = installRecorders(env, { response: "{}" }, { withAi: false });
    const send = async (t) => { rec.sent.push(String(t)); };
    try {
      await handleDailyText(env, { chatId: 1, userId: 1, chatType: "private", text, send, chat: async () => {}, nowMs: NOW });
      check(!rec.sent.includes(SECRET_INPUT_GUIDANCE), "T2: guard does not fire for a non-secret long note");
    } finally { rec.restore(); }
  }

  // T2b: ordinary numbers/dates/amounts are not secret-shaped.
  {
    for (const text of ["+98 912 345 6789", "2026-11-16", "50,000,000"]) {
      check(looksSecret(text) === false, `T2b: looksSecret false for ${JSON.stringify(text)}`);
      const { sq, db } = freshDb(); db.__sq = sq;
      const env = baseEnv(db);
      const rec = installRecorders(env, { response: "{}" }, { withAi: false });
      const send = async (t) => { rec.sent.push(String(t)); };
      try {
        await handleDailyText(env, { chatId: 1, userId: 1, chatType: "private", text, send, chat: async () => {}, nowMs: NOW });
        check(!rec.sent.includes(SECRET_INPUT_GUIDANCE), `T2b: guard does not fire for ${JSON.stringify(text)}`);
      } finally { rec.restore(); }
    }
  }

  // T3: a real vault_save (healthy control) is not blocked, is redacted, no LLM.
  {
    const text = `کارت بانک رسالت\n${CARD}\nثبتش کن`;
    check(classifyDaily(text, { nowMs: NOW }).intent === "vault_save", "T3: control classifies as vault_save");
    const { sq, db } = freshDb(); db.__sq = sq;
    const env = baseEnv(db);
    const rec = installRecorders(env, { response: "{}" });
    const send = async (t) => { rec.sent.push(String(t)); };
    try {
      const ret = await handleDailyText(env, { chatId: 1, userId: 1, chatType: "private", text, send, chat: async () => {}, nowMs: NOW });
      check(!rec.sent.includes(SECRET_INPUT_GUIDANCE), "T3: guard does not fire for vault_save");
      check(ret !== "handled" || rec.sent.length > 0, "T3: vault_save runs its own branch");
      check(rec.records.filter((r) => r.kind === "ai").length === 0, "T3: no LLM call");
      const userRows = sq.prepare("SELECT content, kind FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 1").all();
      check(userRows.length === 1 && userRows[0].content === VAULT_REDACTED_TEXT, `T3: stored user row is redacted (got ${JSON.stringify(userRows[0]?.content)})`);
      check(!digitsOnly(rowContents(sq).join("\n")).includes(CARD_DIGITS), "T3: fake card digits never stored");
    } finally { rec.restore(); }

    const filled = SECRET_INPUT_GUIDANCE.split("\n").slice(-3).map((l) => l === "عنوان" ? "کارت بانک رسالت" : l === "مقدار" ? CARD : l).join("\n");
    check(classifyDaily(filled, { nowMs: NOW }).intent === "vault_save", "T3: the guidance example, filled in, classifies as vault_save");
  }

  // T4: slash command with a 13+ digit argument — documented gap, guard skips.
  {
    const text = `/ثبت ${CARD_DIGITS}`;
    check(classifyDaily(text, { nowMs: NOW }).intent === "command", "T4: slash text is a command");
    const { sq, db } = freshDb(); db.__sq = sq;
    const env = baseEnv(db);
    const rec = installRecorders(env, { response: "{}" }, { withAi: false });
    const send = async (t) => { rec.sent.push(String(t)); };
    try {
      const ret = await handleDailyText(env, { chatId: 1, userId: 1, chatType: "private", text, send, chat: async () => {}, nowMs: NOW });
      check(!rec.sent.includes(SECRET_INPUT_GUIDANCE), "T4: guard does not fire on the command path (documented gap)");
      check(ret === "chat", `T4: command still returns chat (got ${JSON.stringify(ret)})`);
    } finally { rec.restore(); }
  }

  // T5: markDaily without an entryMessageId must redact secret-shaped text.
  {
    const text = `کارت بانک رسالت\n${CARD}\nثبتش کن`;
    check(classifyDaily(text, { nowMs: NOW }).intent === "vault_save", "T5: source text is a vault_save");
    const { sq, db } = freshDb(); db.__sq = sq;
    const env = baseEnv(db);
    await markDaily(env, { userId: 1, text });
    const rows = sq.prepare("SELECT content, kind FROM messages ORDER BY id DESC LIMIT 1").all();
    check(rows.length === 1 && rows[0].kind === "daily" && rows[0].content === VAULT_REDACTED_TEXT, `T5: markDaily saves redacted text (got ${JSON.stringify(rows[0]?.content)})`);
    check(!digitsOnly(rows[0]?.content ?? "").includes(CARD_DIGITS), "T5: fake card digits never stored by markDaily");
  }
}
