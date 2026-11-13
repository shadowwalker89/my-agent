// R0.2 offline safety net: golden Persian cases + deterministic parsers +
// real migration SQL on node:sqlite. Zero network calls.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAmountText, validateDateTexts, matchProject } from "../src/interpreter.js";
import { classifyDaily, parseReminder } from "../src/daily.js";
import { mapOutcome } from "./eval-intent.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
const ALLOW = ["task", "note", "reminder", "expense", "income", "query", "translate", "setting", "correction", "dev_hint", "chat", "ask", "multi"];

let checks = 0;
const failures = [];
const eq = (ok, id, message) => { checks++; if (!ok) failures.push(`${id}: ${message}`); };

const synthetic = readJson("eval/intent-synthetic.json");
const golden = readJson("eval/golden-persian.json");
const all = [...synthetic, ...golden];
const ids = all.map((c) => c.id);
const texts = all.map((c) => String(c.text ?? "").replace(/\s+/g, " ").trim());

eq(Array.isArray(synthetic) && synthetic.length === 70, "dataset", `synthetic count is ${synthetic.length}, expected 70`);
eq(Array.isArray(golden) && golden.length >= 85, "dataset", `golden count is ${golden.length}, expected >=85`);
eq(all.length >= 150, "dataset", `combined count is ${all.length}, expected >=150`);
eq(new Set(ids).size === ids.length, "dataset", "case ids must be unique");
eq(new Set(texts).size === texts.length, "dataset", "utterance texts must be unique");
eq(texts.every((t) => t.length > 0), "dataset", "every case needs non-empty text");

for (const c of synthetic) {
  eq(ALLOW.includes(c.expected), c.id, "synthetic expected intent is allow-listed");
  if (c.expected === "multi") eq(Array.isArray(c.types) && c.types.length > 1, c.id, "multi case needs types");
  if (c.expected === "ask") eq(["none", "type", "project", "time", "amount"].includes(c.needs), c.id, "ask case needs a need");
  if (c.expected === "expense" || c.expected === "income") eq(typeof c.slots?.amount_text === "string" && c.slots.amount_text, c.id, "money case needs amount_text");
}
for (const c of golden) {
  eq(ALLOW.includes(c.expected_intent), c.id, "expected_intent is allow-listed");
  eq(typeof c.text === "string" && c.text.trim().length > 0, c.id, "text is required");
  if (c.amount_text !== undefined) eq(typeof c.amount_text === "string" && c.amount_text.trim().length > 0, c.id, "amount_text is non-empty");
  if (c.amount !== undefined) eq(Number.isInteger(c.amount) && c.amount > 0, c.id, "amount is a positive integer");
  if (c.amount !== undefined) eq(typeof c.currency === "string" && c.currency.length > 0, c.id, "currency is explicit");
  if (c.amount_text !== undefined) eq(c.amount !== undefined || c.validator_error !== undefined, c.id, "amount_text needs amount or validator_error");
  if (c.due_text !== undefined) eq(c.due_at !== undefined || c.date_errors !== undefined, c.id, "due_text needs due_at or date_errors");
  if (c.remind_text !== undefined) eq(c.remind_at !== undefined || c.date_errors !== undefined, c.id, "remind_text needs remind_at or date_errors");
  if (c.reminder_phrase !== undefined) eq(c.reminder_due !== undefined || c.expected_ask !== undefined, c.id, "reminder_phrase needs reminder_due or expected_ask");
}

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
const CTX = {
  projects: [
    { name: "گلبهار", aliases: ["گل"] },
    { name: "قرارها و ملاقات‌ها", aliases: ["قرارها"] },
    { name: "عمومی", aliases: [] },
    { name: "ایجنت", aliases: [] },
  ],
  nowMs: NOW,
  defaultCurrency: "TOMAN",
};
let knownGaps = 0;

for (const c of golden) {
  if (c.amount_text !== undefined) {
    const r = validateAmountText(c.amount_text, CTX.defaultCurrency);
    if (c.validator_error !== undefined) {
      eq(!r.ok && r.error === c.validator_error, c.id, `expected validator error ${c.validator_error}, got ${r.ok ? "ok" : r.error}`);
    } else {
      eq(r.ok, c.id, `amount validator failed: ${r.error ?? "unknown"}`);
      eq(r.amount === c.amount, c.id, `amount ${r.amount} != ${c.amount}`);
      eq(r.currency === c.currency, c.id, `currency ${r.currency} != ${c.currency}`);
    }
  }
  if (c.due_text !== undefined || c.remind_text !== undefined) {
    const d = validateDateTexts(c.due_text ?? null, c.remind_text ?? null, NOW);
    if (c.date_errors !== undefined) {
      eq(JSON.stringify(d.errors) === JSON.stringify(c.date_errors), c.id, `date errors ${JSON.stringify(d.errors)} != ${JSON.stringify(c.date_errors)}`);
    } else {
      eq(d.ok, c.id, `date validation failed: ${JSON.stringify(d.errors)}`);
      if (c.due_at !== undefined) eq(d.due_at === c.due_at, c.id, `due_at ${d.due_at} != ${c.due_at}`);
      if (c.remind_at !== undefined) eq(d.remind_at === c.remind_at, c.id, `remind_at ${d.remind_at} != ${c.remind_at}`);
    }
  }
  if (c.reminder_phrase !== undefined) {
    const r = parseReminder(c.reminder_phrase, NOW);
    if (c.expected_ask !== undefined) eq(r.ask === c.expected_ask, c.id, `reminder ask ${r.ask} != ${c.expected_ask}`);
    else {
      eq(r.due === c.reminder_due, c.id, `reminder due ${r.due} != ${c.reminder_due}`);
      if (c.reminder_body !== undefined) eq(r.text === c.reminder_body, c.id, `reminder body "${r.text}" != "${c.reminder_body}"`);
    }
  }
  if (c.project_text !== undefined) {
    const matched = matchProject(c.project_text, CTX.projects);
    eq((matched?.name ?? null) === c.project, c.id, `project ${matched?.name ?? null} != ${c.project}`);
  }
  if (c.classify !== undefined) {
    const got = classifyDaily(c.text, CTX);
    eq(got.intent === c.classify, c.id, `classify ${got.intent} != ${c.classify}`);
  }
  if (c.must_not_be_expense) {
    const got = classifyDaily(c.text, CTX);
    eq(got.intent !== "expense" && got.intent !== "income", c.id, `false-positive money route: ${got.intent}`);
  }
  if (c.simulate_got !== undefined) {
    const action = {
      type: c.expected_intent,
      text: c.text,
      project: c.project_text ?? c.project ?? null,
      due_text: c.due_text ?? null,
      remind_text: c.remind_text ?? null,
      amount_text: c.amount_text ?? null,
      query: null,
      target: null,
      confidence: 1,
      needs: "none",
      ...(c.simulate_action ?? {}),
    };
    const mapped = mapOutcome({ ok: true }, [action], CTX);
    eq(mapped.got === c.simulate_got, c.id, `mapOutcome ${mapped.got} != ${c.simulate_got}`);
  }
  if (c.known_gap) knownGaps++;
}

let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch {
  console.error("node:sqlite is required (Node 22+); R0.2 offline D1 harness cannot run.");
  process.exit(2);
}

const db = new DatabaseSync(":memory:");
const tables = (query) => db.prepare(query).all().map((row) => row.name);
try {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(fs.readFileSync(path.join(root, "migrations", "0001_init.sql"), "utf8"));
  db.exec(fs.readFileSync(path.join(root, "migrations", "0002_step1_columns.sql"), "utf8"));
  db.prepare("INSERT INTO users (id, telegram_id, name, created_at) VALUES (?, ?, ?, ?)").run(1, "1001", "owner", "2026-10-31T00:00:00Z");
  db.exec(fs.readFileSync(path.join(root, "migrations", "0003_tasks_projects.sql"), "utf8"));

  const tableSet = new Set(tables("SELECT name FROM sqlite_master WHERE type = 'table'"));
  for (const name of ["notes", "tasks", "projects", "reminders", "expenses", "messages"]) {
    eq(tableSet.has(name), "d1", `missing T0 table ${name}`);
  }
  const columns = new Set(tables("PRAGMA table_info(messages)"));
  eq(columns.has("kind") && columns.has("tg_file_id"), "d1", "0002 columns missing on messages");
  const noteColumns = new Set(tables("PRAGMA table_info(notes)"));
  eq(noteColumns.has("project_id"), "d1", "0003 project_id missing on notes");

  const projectId = db.prepare("SELECT id FROM projects WHERE user_id = 1 AND name = ?").get("گلبهار").id;
  eq(db.prepare("SELECT COUNT(*) AS n FROM projects WHERE user_id = 1").get().n === 4, "d1", "seed projects were not created");

  db.prepare("INSERT INTO messages (user_id, role, content, kind, created_at) VALUES (?, ?, ?, ?, ?)").run(1, "user", "سلام", "note", "2026-10-31T10:00:00Z");
  db.prepare("INSERT INTO notes (user_id, text, source, project_id, created_at) VALUES (?, ?, ?, ?, ?)").run(1, "خرید نان", "text", projectId, "2026-10-31T10:01:00Z");
  db.prepare("INSERT INTO tasks (user_id, title, project_id, status, remind_at, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(1, "تماس با بانک", projectId, "open", "2026-11-01T09:00:00+03:30", "text", "2026-10-31T10:02:00Z");
  db.prepare("INSERT INTO reminders (user_id, text, due_at, status, created_at) VALUES (?, ?, ?, ?, ?)").run(1, "دارو", "2026-10-31T17:00:00+03:30", "pending", "2026-10-31T10:03:00Z");
  db.prepare("INSERT INTO expenses (user_id, type, amount, currency_code, item, date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(1, "expense", 50000, "TOMAN", "ناهار", "2026-10-31", "2026-10-31T10:04:00Z");

  eq(db.prepare("SELECT content, kind FROM messages WHERE user_id = 1").get().content === "سلام", "d1", "message round-trip failed");
  const note = db.prepare("SELECT text, project_id FROM notes WHERE user_id = 1").get();
  eq(note.text === "خرید نان" && note.project_id === projectId, "d1", "note round-trip failed");
  eq(db.prepare("SELECT title FROM tasks WHERE user_id = 1").get().title === "تماس با بانک", "d1", "task round-trip failed");
  eq(db.prepare("SELECT due_at FROM reminders WHERE user_id = 1").get().due_at === "2026-10-31T17:00:00+03:30", "d1", "reminder round-trip failed");
  const money = db.prepare("SELECT amount, currency_code, type FROM expenses WHERE user_id = 1").get();
  eq(money.amount === 50000 && money.currency_code === "TOMAN" && money.type === "expense", "d1", "expense round-trip failed");
} finally {
  db.close();
}

if (failures.length > 0) {
  console.error(`Golden suite FAILED: ${failures.length} failure(s) across ${checks} checks.`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Golden suite OK: ${synthetic.length} synthetic + ${golden.length} golden = ${all.length} unique Persian utterances.`);
console.log(`Deterministic checks: ${checks} passed, 0 failed; ${knownGaps} documented known gap(s).`);
console.log("D1 migrations 0001-0003: schema + T0 table round-trip OK (node:sqlite, in-memory).");
