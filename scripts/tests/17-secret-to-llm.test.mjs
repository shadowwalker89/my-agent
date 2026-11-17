// R0 PR-A: D5 — secret (card/Sheba/vault output) must never reach an LLM.
// Given/When/Then: vault_save is never deferred to the model; reply-to text
// that looks like a secret is dropped before the chat/NLU prompts.
import fs from "node:fs";
import { check, fakeKV, DatabaseSync } from "./harness.mjs";
import { handleDailyText } from "../../src/pipeline/dispatch.js";
import { buildChatContext } from "../../src/pipeline/context.js";
import { isUnambiguousQuestion } from "../../src/pipeline/nlu-skip.js";
import { looksSecret } from "../../src/pipeline/secret-shape.js";
import { classifyDaily } from "../../src/daily.js";

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const FA = "۰۱۲۳۴۵۶۷۸۹";
const AR = "٠١٢٣٤٥٦٧٨٩";
const toLatin = (s) => String(s).replace(/[۰-۹]/g, (d) => String(FA.indexOf(d))).replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)));
const digitsOnly = (s) => toLatin(s).replace(/[ \u00A0-]/g, "");
const isMultiClause = (t) => String(t).length > 160 || ((String(t).match(/[.،؛;!?؟\n]/g) || []).length >= 3);

function freshDb() {
  const sq = new DatabaseSync(":memory:");
  for (const f of ["0001_init.sql", "0002_step1_columns.sql", "0003_tasks_projects.sql"]) sq.exec(fs.readFileSync(new URL("../../migrations/" + f, import.meta.url), "utf8"));
  sq.exec("INSERT INTO users (id, telegram_id) VALUES (1, '1')");
  const db = { prepare(sql) { const st = sq.prepare(sql); return { bind(...p) { return { run: async () => { const r = st.run(...p); return { success: true, meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } }; }, all: async () => ({ results: st.all(...p) }), first: async () => st.get(...p) ?? null }; } }; } };
  return { sq, db };
}

function mkEnv(db) {
  return { STATE: fakeKV(), DB: db, VAULT_SECRET: "test-secret", TG_TOKEN: "fake-token", TG_SECRET: "fake-tg-secret", ALLOWED_TG_IDS: "4242" };
}

function installRecorders(env, aiResponse) {
  const records = [];
  const origFetch = globalThis.fetch;
  env.AI = { run: async (model, body) => { records.push({ kind: "ai", model, body }); return aiResponse; } };
  globalThis.fetch = async (url, init = {}) => {
    records.push({ kind: "fetch", url: String(url), body: String(init.body ?? "") });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { records, text: () => records.map((r) => r.kind === "ai" ? JSON.stringify(r.body) : r.url + "\n" + r.body).join("\n"), restore: () => { globalThis.fetch = origFetch; } };
}

const noteReply = JSON.stringify({ intent: "note", confidence: 0.9, project: null, body: "کنترل رکوردر", date_ref: null, time_ref: null, daypart: null, summary_target: null });

export async function run() {
  if (!DatabaseSync) return;

  // ── T1: multi-clause vault_save never reaches the LLM (R-2a) ──────────────
  {
    const cardMsg = "کارت بانک رسالت\n9999-8888-7777-6666\nثبتش کن";
    const shebaMsg = "شبای من\nIR062960000000100324200001\nممنون\nذخیره کن";
    check(classifyDaily(cardMsg, { nowMs: NOW }).intent === "vault_save", "T1: fake-card message classifies as vault_save");
    check(classifyDaily(shebaMsg, { nowMs: NOW }).intent === "vault_save", "T1: fake-Sheba message classifies as vault_save");
    check(isMultiClause(shebaMsg), "T1: Sheba message is multi-clause, so pre-fix it was deferred to the LLM");
    const env = mkEnv(freshDb().db);
    const rec = installRecorders(env, { response: noteReply });
    try {
      const send = async () => {};
      await handleDailyText(env, { chatId: 1, userId: 1, chatType: "private", text: cardMsg, send, chat: async () => {}, nowMs: NOW });
      await handleDailyText(env, { chatId: 1, userId: 1, chatType: "private", text: shebaMsg, send, chat: async () => {}, nowMs: NOW });
      const outbound = digitsOnly(rec.text());
      check(!outbound.includes("9999888877776666"), "T1: fake card digits never reach the LLM/network");
      check(!outbound.includes("062960000000100324200001"), "T1: fake Sheba digits never reach the LLM/network");
      check(rec.records.filter((r) => r.kind === "ai").length === 0, "T1: no vault_save message triggers an LLM request");
    } finally { rec.restore(); }
  }

  // ── T1-control: the recorder is not vacuous ──────────────────────────────
  {
    const controlMsg = "یادم بنداز فردا ساعت ۹ زنگ بزنم. بعدش خرید. بعدش پرداخت.";
    const controlClass = classifyDaily(controlMsg, { nowMs: NOW });
    check(controlClass.intent === "reminder" && isMultiClause(controlMsg), `T1-control: multi-clause reminder is the deferred shape (intent=${controlClass.intent}, ask=${controlClass.ask}, multi=${isMultiClause(controlMsg)})`);
    const env = mkEnv(freshDb().db);
    const rec = installRecorders(env, { response: noteReply });
    try {
      await handleDailyText(env, { chatId: 1, userId: 1, chatType: "private", text: controlMsg, send: async () => {}, chat: async () => {}, nowMs: NOW });
      check(rec.records.some((r) => r.kind === "ai"), `T1-control: a multi-clause reminder DOES produce an LLM request (records=${rec.records.length})`);
    } finally { rec.restore(); }
  }

  // ── T2: reply-to text that looks secret is dropped from prompts (R-2c) ────
  {
    const secrets = ["9999-8888-7777-6666", "IR062960000000100324200001", "🔒 x"];
    const tags = { "9999-8888-7777-6666": "9999888877776666", "IR062960000000100324200001": "062960000000100324200001" };
    const containsTrace = (haystack, secret) => secret === "🔒 x" ? haystack.includes("🔒") : digitsOnly(haystack).includes(tags[secret]);
    const texts = ["این چیه؟", "حذفش کن"];
    for (const secret of secrets) {
      for (const text of texts) {
        const chatPrompt = JSON.stringify(buildChatContext([], { replyToText: secret }));
        check(!containsTrace(chatPrompt, secret), `T2: chat prompt drops the secret reply for «${text}»`);
        const env = mkEnv(freshDb().db);
        const rec = installRecorders(env, { response: noteReply });
        try {
          const ret = await handleDailyText(env, { chatId: 1, userId: 1, chatType: "private", text, replyToText: secret, send: async () => {}, chat: async () => {}, nowMs: NOW });
          check(!containsTrace(rec.text(), secret), `T2: NLU prompt drops the secret reply for «${text}» (ret=${ret})`);
        } finally { rec.restore(); }
      }
    }
  }

  // ── T2-control: an ordinary reply IS present in the prompts ───────────────
  {
    const reply = "✅ ثبت شد. ناهار ۵۰ هزار تومان";
    // «حذفش کن» must reach the NLU; «این چیه؟» is an unambiguous question, so
    // its reply can only ride the chat prompt (NLU skipped by design, no AI
    // request — reported, not weakened).
    for (const text of ["حذفش کن", "این چیه؟"]) {
      const chatPrompt = JSON.stringify(buildChatContext([], { replyToText: reply }));
      check(chatPrompt.includes("ناهار"), `T2-control: ordinary reply text is present in the chat prompt for «${text}»`);
      const env = mkEnv(freshDb().db);
      const rec = installRecorders(env, { response: noteReply });
      try {
        await handleDailyText(env, { chatId: 1, userId: 1, chatType: "private", text, replyToText: reply, send: async () => {}, chat: async () => {}, nowMs: NOW });
        const sawAi = rec.records.some((r) => r.kind === "ai");
        if (sawAi) check(rec.records.some((r) => r.kind === "ai" && JSON.stringify(r.body).includes("ناهار")), `T2-control: ordinary reply text is present in the NLU prompt for «${text}»`);
        else check(isUnambiguousQuestion(text), `T2-control: no AI request for «${text}» is only allowed for an unambiguous question`);
      } finally { rec.restore(); }
    }
  }

  // ── T3: looksSecret unit cases ───────────────────────────────────────────
  {
    const yes = ["9999 8888 7777 6666", "9999-8888-7777-6666", "۹۹۹۹۸۸۸۸۷۷۷۷۶۶۶۶", "ir06 2960 0000 0010 0324 2000 01", "🔒 x",
      "IR06-2960-0000-0010-0324-2000-01", "062960000000100324200001", "9999\n8888\n7777\n6666", "9999.8888.7777.6666",
      "9999\u200c8888\u200c7777\u200c6666", "12345678901234567890"];
    const no = ["09123456789", "سفارش ۱۲۳۴۵۶", "1731600000", "۵۰٬۰۰۰٬۰۰۰", "1405/08/23", "123456789012",
      "2026-11-16", "021-88776655", "1405/08/23 14:30", "50,000,000", "+98 912 345 6789", "10.5 and 20.5"];
    for (const s of yes) check(looksSecret(s) === true, `T3: looksSecret true for ${JSON.stringify(s)}`);
    for (const s of no) check(looksSecret(s) === false, `T3: looksSecret false for ${JSON.stringify(s)}`);
    for (const s of [null, undefined, 123, {}, []]) check(looksSecret(s) === false, "T3: non-string input is false");
  }
}
