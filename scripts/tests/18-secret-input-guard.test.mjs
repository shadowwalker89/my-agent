// R0 PR-B: R-2d — secret-shaped input outside vault_save/command gets static
// guidance: no LLM, no network, no messages row, no echo of the digits.
import fs from "node:fs";
import { check, fakeKV, DatabaseSync } from "./harness.mjs";
import { handleDailyText, SECRET_INPUT_GUIDANCE } from "../../src/pipeline/dispatch.js";
import { markDaily } from "../../src/pipeline/context.js";
import { looksSecret } from "../../src/pipeline/secret-shape.js";
import { classifyDaily } from "../../src/daily.js";
import { VAULT_REDACTED_TEXT } from "../../src/pipeline/daily-helpers.js";
import { decryptVaultValue } from "../../src/vault.js";
import { handleVaultFile } from "../../src/everyday.js";
import { runPreDispatch } from "../../src/pipeline/pre-dispatch.js";

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const CARD = "9999-8888-7777-6666";
const SHEBA = "IR062960000000100324200001";
const CARD_DIGITS = "9999888877776666";
const SHEBA_DIGITS = "062960000000100324200001";
const SECRET_CAPTION_NOTICE = "🔒 کپشن شبیه شماره کارت یا شبا بود؛ برای امنیت نادیده گرفته شد و ذخیره نشد. فایل بدون کپشن بایگانی شد.";
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
    ["T1g bare dashed card", CARD],
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

  // G-1: dashed/spaced card and three-line guidance save the full value.
  for (const [label, text, expected] of [
    ["G1a contiguous card", `کارت رسالت ${CARD_DIGITS} ثبتش کن`, CARD_DIGITS],
    ["G1b dashed card", `کارت رسالت ${CARD} ثبتش کن`, CARD_DIGITS],
    ["G1c spaced card", "کارت رسالت 9999 8888 7777 6666 ثبتش کن", CARD_DIGITS],
    ["G1d three-line card", `کارت رسالت\n${CARD}\nثبتش کن`, CARD_DIGITS],
    ["G1e Sheba", `شبا من ${SHEBA} ثبتش کن`, SHEBA],
  ]) {
    const c = classifyDaily(text, { nowMs: NOW });
    check(c.intent === "vault_save", `${label}: classifies as vault_save (got ${c.intent})`);
    check(c.value === expected, `${label}: extracted value is ${expected} (got ${JSON.stringify(c.value)})`);
    const expectedDigits = digitsOnly(expected);
    const { sq, db } = freshDb(); db.__sq = sq;
    const env = baseEnv(db);
    const rec = installRecorders(env, { response: "{}" });
    const send = async (t) => { rec.sent.push(String(t)); };
    try {
      const ret = await handleDailyText(env, { chatId: 1, userId: 1, chatType: "private", text, send, chat: async () => {}, nowMs: NOW });
      check(ret === "handled", `${label}: returns handled (got ${JSON.stringify(ret)})`);
      check(!rec.sent.includes(SECRET_INPUT_GUIDANCE), `${label}: guard does not fire for vault_save`);
      check(rec.records.filter((r) => r.kind === "ai").length === 0, `${label}: zero AI.run calls`);
      const outbound = rec.records.map((r) => r.kind === "ai" ? JSON.stringify(r.body) : r.url + "\n" + r.body).join("\n");
      check(!digitsOnly(outbound + "\n" + rec.logs.join("\n")).includes(expectedDigits), `${label}: fake value never reaches a mocked LLM request or log`);
      const rows = rowContents(sq);
      check(!digitsOnly(rows.join("\n")).includes(expectedDigits), `${label}: no fake digits in messages rows`);
      check(rows.some((r) => r === VAULT_REDACTED_TEXT), `${label}: pending message row is redacted`);
      const item = sq.prepare("SELECT label, category, value_enc FROM vault_items ORDER BY id DESC LIMIT 1").all()[0];
      check(Boolean(item) && !String(item.value_enc).includes(expectedDigits), `${label}: vault stores ciphertext, never plaintext`);
      check(Boolean(item) && (await decryptVaultValue(env, item.value_enc)) === expected, `${label}: decrypted vault value is complete`);
    } finally { rec.restore(); }
  }

  // G-1: a CVV/OTP-sized value is still rejected and never stored.
  {
    const text = "کارت رسالت 1234 رو ثبت کن";
    check(classifyDaily(text, { nowMs: NOW }).value === "", "G1-CVV: no 8+ digit value is extracted");
    const { sq, db } = freshDb(); db.__sq = sq;
    const env = baseEnv(db);
    const rec = installRecorders(env, { response: "{}" }, { withAi: false });
    const send = async (t) => { rec.sent.push(String(t)); };
    try {
      await handleDailyText(env, { chatId: 1, userId: 1, chatType: "private", text, send, chat: async () => {}, nowMs: NOW });
      const table = sq.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vault_items'").all();
      const items = table.length ? sq.prepare("SELECT id FROM vault_items").all() : [];
      check(items.length === 0, "G1-CVV: CVV/OTP-sized value is not stored in the vault");
      check(rec.sent.some((t) => String(t).includes("عنوان و مقدار")) && !rec.sent.some((t) => String(t).includes("ذخیره شد")), "G1-CVV: user is told title/value are missing, nothing saved");
    } finally { rec.restore(); }
  }

  // S7-H1: file/photo captions, reply-to-photo captions and file names are
  // secret-shaped; they must never reach an LLM/provider or vault_files.
  const outboundText = (rec) => digitsOnly(rec.records.map((r) => r.kind === "ai" ? JSON.stringify(r.body) : r.url + "\n" + r.body).join("\n") + "\n" + rec.logs.join("\n") + "\n" + rec.sent.join("\n"));
  const vaultFileRow = (sq) => {
    const t = sq.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vault_files'").all();
    return t.length ? sq.prepare("SELECT title, caption, file_name FROM vault_files ORDER BY id DESC LIMIT 1").get() : null;
  };

  // C1: photo caption with an analysis keyword + fake card.
  {
    const { sq, db } = freshDb(); db.__sq = sq;
    const env = baseEnv(db); env.GEMINI_API_KEY = "k";
    const rec = installRecorders(env, { response: "{}" });
    const sent = [];
    const send = async (t) => { sent.push(String(t)); rec.sent.push(String(t)); };
    try {
      const handled = await handleVaultFile(env, { userId: 1, chatId: 1, tgFileId: "secret-cap-photo", fileType: "photo", mimeType: "image/jpeg", fileName: null, caption: `این عکس رو تحلیل کن ${CARD}`, send }, { getFileDownloadData: async () => new Uint8Array([1, 2, 3]) });
      check(handled === true, "S7H1-C1: secret photo caption is handled (file archived)");
      check(rec.records.filter((r) => r.kind === "fetch").length === 0, "S7H1-C1: zero provider fetch calls because of the caption");
      check(rec.records.filter((r) => r.kind === "ai").length === 0, "S7H1-C1: zero AI.run calls because of the caption");
      check(sent.some((t) => t.includes(SECRET_CAPTION_NOTICE)), "S7H1-C1: fixed Persian notice is sent");
      const row = vaultFileRow(sq);
      check(Boolean(row), "S7H1-C1: file is archived in vault_files");
      check(row?.caption == null && !digitsOnly(JSON.stringify(row)).includes(CARD_DIGITS), "S7H1-C1: vault_files stores no secret caption/digits");
      check(!outboundText(rec).includes(CARD_DIGITS), "S7H1-C1: fake card never appears in a provider request, log or reply");
    } finally { rec.restore(); }
  }

  // C2: PDF caption with an analysis keyword + fake Sheba.
  {
    const { sq, db } = freshDb(); db.__sq = sq;
    const env = baseEnv(db); env.GEMINI_API_KEY = "k";
    const rec = installRecorders(env, { response: "{}" });
    const sent = [];
    const send = async (t) => { sent.push(String(t)); rec.sent.push(String(t)); };
    try {
      const handled = await handleVaultFile(env, { userId: 1, chatId: 1, tgFileId: "secret-cap-pdf", fileType: "document", mimeType: "application/pdf", fileName: "scan.pdf", caption: `این پی‌دی‌اف رو تحلیل کن ${SHEBA}`, fetchFn: globalThis.fetch, send }, { getFileDownloadData: async () => new Uint8Array([1, 2, 3]) });
      check(handled === true, "S7H1-C2: secret PDF caption is handled (file archived)");
      check(rec.records.filter((r) => r.kind === "fetch").length === 0, "S7H1-C2: zero provider fetch calls because of the caption");
      check(sent.some((t) => t.includes(SECRET_CAPTION_NOTICE)), "S7H1-C2: fixed Persian notice is sent");
      const row = vaultFileRow(sq);
      check(Boolean(row), "S7H1-C2: file is archived in vault_files");
      check(row?.caption == null && !digitsOnly(JSON.stringify(row)).includes(SHEBA_DIGITS), "S7H1-C2: vault_files stores no secret caption/digits");
      check(!outboundText(rec).includes(SHEBA_DIGITS), "S7H1-C2: fake Sheba never appears in a provider request, log or reply");
    } finally { rec.restore(); }
  }

  // C3: document file name with a fake Sheba is never stored or forwarded.
  {
    const { sq, db } = freshDb(); db.__sq = sq;
    const env = baseEnv(db); env.GOOGLE_VAULT_DRIVE_FOLDER_ID = "folder"; env.GOOGLE_VAULT_ACCESS_TOKEN = "tok";
    const rec = installRecorders(env, { response: "{}" });
    const sent = [];
    const send = async (t) => { sent.push(String(t)); rec.sent.push(String(t)); };
    try {
      const handled = await handleVaultFile(env, { userId: 1, chatId: 1, tgFileId: "secret-name-doc", fileType: "document", mimeType: "application/pdf", fileName: `scan-${SHEBA}.pdf`, caption: "ذخیره کن آزمایش خون", send }, { getFileDownloadData: async () => new Uint8Array([1, 2, 3]) });
      check(handled === true, "S7H1-C3: secret file name upload still works");
      const row = vaultFileRow(sq);
      check(Boolean(row) && row.file_name == null, "S7H1-C3: vault_files.file_name does not store the secret name");
      check(Boolean(row) && !digitsOnly(JSON.stringify(row)).includes(SHEBA_DIGITS), "S7H1-C3: vault_files keeps no secret file-name digits");
      check(!outboundText(rec).includes(SHEBA_DIGITS), "S7H1-C3: fake Sheba from the file name is never forwarded");
      check(sent.some((t) => t.includes("آرشیو امن")), "S7H1-C3: normal archive reply is still sent");
    } finally { rec.restore(); }
  }

  // C4: reply-to-photo caption with a fake card + an edit request.
  {
    const env = baseEnv(); env.GEMINI_API_KEY = "k";
    const rec = installRecorders(env, { response: "{}" });
    const sent = [];
    const send = async (t) => { sent.push(String(t)); rec.sent.push(String(t)); };
    try {
      const ret = await runPreDispatch(env, {
        userId: 1,
        chatId: 1,
        text: "این عکس رو ویرایش کن و رنگش رو قرمز کن",
        replyToPhoto: { fileId: "reply-photo", caption: `تصویر قبلی ${CARD}` },
        fetchFn: globalThis.fetch,
        send,
      }, { getFileDownloadData: async () => new Uint8Array([1, 2, 3]), tgApi: async () => ({ ok: true }) });
      check(ret === "handled", "S7H1-C4: reply-to-photo edit is handled");
      check(!outboundText(rec).includes(CARD_DIGITS), "S7H1-C4: reply caption fake card never reaches the image provider, log or echo");
    } finally { rec.restore(); }
  }

  // C5: save-keyword photo caption (matches VAULT_CAPTION_RE) + fake card.
  // Before the fix this caption was stored as vault_files.title/caption and
  // the title was synced to Google.
  {
    const { sq, db } = freshDb(); db.__sq = sq;
    const env = baseEnv(db); env.GEMINI_API_KEY = "k"; env.GOOGLE_VAULT_DRIVE_FOLDER_ID = "folder"; env.GOOGLE_VAULT_ACCESS_TOKEN = "tok";
    const rec = installRecorders(env, { response: "{}" });
    const sent = [];
    const send = async (t) => { sent.push(String(t)); rec.sent.push(String(t)); };
    const caption = `ذخیره کن کارت ${CARD}`;
    try {
      const handled = await handleVaultFile(env, { userId: 1, chatId: 1, tgFileId: "secret-save-cap-photo", fileType: "photo", mimeType: "image/jpeg", fileName: null, caption, send }, { getFileDownloadData: async () => new Uint8Array([1, 2, 3]) });
      check(handled === true, "S7H1-C5: save-keyword secret photo caption is handled (file archived)");
      check(rec.records.filter((r) => r.kind === "fetch").length === 0, "S7H1-C5: zero provider fetch calls (no Google sync of the secret title either)");
      check(rec.records.filter((r) => r.kind === "ai").length === 0, "S7H1-C5: zero AI.run calls because of the caption");
      check(sent.some((t) => t.includes(SECRET_CAPTION_NOTICE)), "S7H1-C5: fixed Persian notice is sent");
      const row = vaultFileRow(sq);
      check(Boolean(row), "S7H1-C5: file is archived in vault_files");
      check(row?.caption == null, "S7H1-C5: vault_files.caption is NULL");
      check(Boolean(row) && !String(row.title ?? "").includes(caption) && !digitsOnly(String(row.title ?? "")).includes(CARD_DIGITS), "S7H1-C5: title does not contain the caption or fake digits");
      check(Boolean(row) && !digitsOnly(JSON.stringify(row)).includes(CARD_DIGITS), "S7H1-C5: no fake digits anywhere in the vault_files row");
      check(!outboundText(rec).includes(CARD_DIGITS), "S7H1-C5: fake card never appears in a provider request, log or reply");
    } finally { rec.restore(); }
  }

  // C6: save-keyword PDF caption (matches VAULT_CAPTION_RE) + fake Sheba.
  {
    const { sq, db } = freshDb(); db.__sq = sq;
    const env = baseEnv(db); env.GEMINI_API_KEY = "k"; env.GOOGLE_VAULT_DRIVE_FOLDER_ID = "folder"; env.GOOGLE_VAULT_ACCESS_TOKEN = "tok";
    const rec = installRecorders(env, { response: "{}" });
    const sent = [];
    const send = async (t) => { sent.push(String(t)); rec.sent.push(String(t)); };
    const caption = `ثبت - شبا ${SHEBA}`;
    try {
      const handled = await handleVaultFile(env, { userId: 1, chatId: 1, tgFileId: "secret-save-cap-pdf", fileType: "document", mimeType: "application/pdf", fileName: "scan.pdf", caption, fetchFn: globalThis.fetch, send }, { getFileDownloadData: async () => new Uint8Array([1, 2, 3]) });
      check(handled === true, "S7H1-C6: save-keyword secret PDF caption is handled (file archived)");
      check(rec.records.filter((r) => r.kind === "fetch").length === 0, "S7H1-C6: zero provider fetch calls (no Google sync of the secret title either)");
      check(rec.records.filter((r) => r.kind === "ai").length === 0, "S7H1-C6: zero AI.run calls because of the caption");
      check(sent.some((t) => t.includes(SECRET_CAPTION_NOTICE)), "S7H1-C6: fixed Persian notice is sent");
      const row = vaultFileRow(sq);
      check(Boolean(row), "S7H1-C6: file is archived in vault_files");
      check(row?.caption == null, "S7H1-C6: vault_files.caption is NULL");
      check(Boolean(row) && !String(row.title ?? "").includes(caption) && !digitsOnly(String(row.title ?? "")).includes(SHEBA_DIGITS), "S7H1-C6: title does not contain the caption or fake digits");
      check(Boolean(row) && !digitsOnly(JSON.stringify(row)).includes(SHEBA_DIGITS), "S7H1-C6: no fake digits anywhere in the vault_files row");
      check(!outboundText(rec).includes(SHEBA_DIGITS), "S7H1-C6: fake Sheba never appears in a provider request, log or reply");
    } finally { rec.restore(); }
  }
}
