import { check, newEnv, workerDefault } from "./harness.mjs";
import {
  CRON_PROVIDER,
  buildReminderMessage,
  isMidnightUtc,
  makeTelegramSendMessage,
  runReminderTick,
  runScheduledTick,
} from "../../src/platform/scheduler/index.js";

function mkState(reminders = []) {
  return { reminders, claimed: false, claimThrows: false, releases: [], purges: [], purgeDeleted: 2 };
}

function fakeDb(state) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async all() {
              if (/UPDATE tasks SET reminded_at/i.test(sql)) {
                if (state.claimThrows) throw new Error("claim boom");
                if (state.claimed) return { results: [] };
                state.claimed = true;
                return {
                  results: state.reminders.map((r) => ({ id: r.id, user_id: r.user_id, title: r.title, remind_at: r.remind_at, remind_attempts: 1 })),
                };
              }
              if (/SELECT id, telegram_id FROM users/i.test(sql)) {
                const seen = new Map();
                for (const r of state.reminders) seen.set(r.user_id, { id: r.user_id, telegram_id: r.telegram_id });
                return { results: [...seen.values()] };
              }
              return { results: [] };
            },
            async run() {
              if (/UPDATE tasks SET reminded_at = NULL/i.test(sql)) {
                state.releases.push(params[0]);
                return { success: true, meta: { changes: 1 } };
              }
              if (/DELETE FROM tasks/i.test(sql)) {
                state.purges.push(params[0]);
                return { success: true, meta: { changes: state.purgeDeleted } };
              }
              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
}

function envOf(state) {
  return { ...newEnv(), DB: fakeDb(state) };
}

async function captureLogs(fn) {
  const logs = [];
  const orig = console.error;
  console.error = (...args) => { logs.push(args.map((a) => String(a)).join(" ")); };
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return logs;
}

const DUE = { id: 1, user_id: 1, telegram_id: "1", title: "خرید نان", remind_at: "2026-10-31T11:59:00.000Z" };
const NOON = Date.UTC(2026, 9, 31, 12, 0, 0);
const NOWISO = "2026-10-31T12:00:00.000Z";

export async function run() {
  {
    check(Object.isFrozen(CRON_PROVIDER), "R0.5: CRON_PROVIDER is frozen");
    check(CRON_PROVIDER["0 */6 * * *"] === "openrouter" && CRON_PROVIDER["10 */6 * * *"] === "nvidia" && CRON_PROVIDER["20 */6 * * *"] === "xkiro", "R0.5: cron → provider mapping");
  }
  {
    const now = Date.parse(NOWISO);
    const onTime = buildReminderMessage({ id: 7, title: "خرید نان", remind_at: "2026-10-31T11:59:00.000Z" }, now);
    check(onTime.text === "⏰ یادآوری: خرید نان", "R0.5: buildReminderMessage on-time label");
    check(onTime.reply_markup?.inline_keyboard?.flat().map((b) => b.callback_data).join(",") === "task:done:7,task:snooze:7", "R0.5: buildReminderMessage done/snooze callbacks");
    const late = buildReminderMessage({ id: 8, title: "دیر", remind_at: "2026-10-31T11:54:59.000Z" }, now);
    check(late.text === "⏰ (تأخیری) یادآوری: دیر", "R0.5: buildReminderMessage delayed label past 5-minute boundary");
    const edge = buildReminderMessage({ id: 9, title: "سر وقت", remind_at: "2026-10-31T11:55:00.000Z" }, now);
    check(edge.text === "⏰ یادآوری: سر وقت", "R0.5: buildReminderMessage exactly 5 minutes stays on-time");
  }
  {
    check(isMidnightUtc(null) === false && isMidnightUtc(undefined) === false, "R0.5: isMidnightUtc(null/undefined) is false");
    check(isMidnightUtc("not-a-date") === false, "R0.5: isMidnightUtc(invalid) is false");
    check(isMidnightUtc(Date.UTC(2026, 10, 1, 0, 0, 0)) === true, "R0.5: 00:00 UTC is midnight");
    check(isMidnightUtc(NOON) === false, "R0.5: noon UTC is not midnight");
    check(isMidnightUtc("2026-11-01T00:00:00.000Z") === true, "R0.5: ISO 00:00 UTC is midnight");
  }
  {
    const calls = [];
    const tgApi = async (env, method, body) => { calls.push({ env, method, body }); return { ok: true }; };
    const env = newEnv();
    const send = makeTelegramSendMessage(tgApi, env);
    const raw = { inline_keyboard: [[{ text: "✅", callback_data: "task:done:1" }]] };
    await send("4242", "متن", raw);
    check(calls[0].method === "sendMessage" && calls[0].env === env && calls[0].body.chat_id === "4242" && calls[0].body.text === "متن", "R0.5: default send calls tgApi sendMessage with chat/text");
    check(JSON.stringify(calls[0].body.reply_markup) === JSON.stringify(raw) && calls[0].body.inline_keyboard === undefined, "R0.5: raw keyboard becomes reply_markup, no top-level inline_keyboard");
    await send("4242", "x", { reply_markup: { inline_keyboard: [] } });
    check(JSON.stringify(calls[1].body.reply_markup) === JSON.stringify({ inline_keyboard: [] }), "R0.5: already-wrapped reply_markup is not double-wrapped");
    check(calls[0].body.reply_markup !== calls[1].body.reply_markup, "R0.5: no shared mutable markup");
  }
  {
    const state = mkState([DUE]);
    const sent = [];
    const r = await runReminderTick(envOf(state), {
      nowIso: NOWISO,
      scheduledTime: NOON,
      sendMessage: async (chatId, text, markup) => { sent.push({ chatId, text, markup }); },
    });
    check(r.ok === true && r.sent === 1 && r.failed === 0 && r.purged === null, "R0.5: runReminderTick claims and sends due reminder");
    check(sent[0].chatId === "1" && sent[0].text === "⏰ یادآوری: خرید نان", "R0.5: runtime keeps legacy label and telegram_id target");
    check(JSON.stringify(sent[0].markup) === JSON.stringify({ inline_keyboard: [[{ text: "✅", callback_data: "task:done:1" }, { text: "💤 ۱۰ دقیقه‌ی دیگر", callback_data: "task:snooze:1" }]] }), "R0.5: runtime keeps raw inline_keyboard third arg");
  }
  {
    const state = mkState([DUE]);
    const logs = await captureLogs(async () => {
      const r = await runReminderTick(envOf(state), {
        nowIso: NOWISO,
        scheduledTime: NOON,
        sendMessage: async () => ({ ok: false, error_code: 403, description: "blocked" }),
      });
      check(r.ok === true && r.sent === 0 && r.failed === 1, "R0.5: ok:false counts as failure, not sent");
    });
    check(state.releases.length === 1 && state.releases[0] === 1, "R0.5: failed delivery releases the claim");
    check(logs.some((l) => l.includes("telegram_send_failed: 403 blocked")), "R0.5: failure reason is logged");
    check(!logs.some((l) => l.includes("خرید نان")), "R0.5 canary: reminder title never appears in logs");
  }
  {
    const state = mkState([DUE]);
    state.claimThrows = true;
    const r = await runReminderTick(envOf(state), { nowIso: NOWISO, scheduledTime: NOON, sendMessage: async () => ({ ok: true }) });
    check(r.ok === false && r.sent === 0 && r.failed === 0 && r.purged === null, "R0.5: claim failure returns honest empty result");
  }
  {
    const state = mkState([DUE]);
    let threw = false;
    try {
      await runReminderTick(envOf(state), { nowIso: NOWISO, scheduledTime: NOON });
    } catch (err) {
      threw = /sendMessage is required/.test(err.message);
    }
    check(threw, "R0.5: missing sendMessage throws when reminders are due");
  }
  {
    const noonState = mkState([]);
    const noon = await runReminderTick(envOf(noonState), { nowIso: NOWISO, scheduledTime: NOON });
    check(noon.purged === null && noonState.purges.length === 0, "R0.5: noon tick never purges");
    const midState = mkState([]);
    const mid = await runReminderTick(envOf(midState), { nowIso: NOWISO, scheduledTime: Date.UTC(2026, 10, 1, 0, 0, 0) });
    check(mid.purged === 2 && midState.purges.length === 1, "R0.5: 00:00 UTC tick purges old closed tasks");
  }
  {
    const seen = [];
    const pending = [];
    const result = runScheduledTick({ cron: "0 */6 * * *", scheduledTime: 0 }, newEnv(), { waitUntil: (p) => pending.push(p) }, {
      syncProvider: async (env, provider) => { seen.push(provider); },
    });
    await Promise.all(pending);
    check(JSON.stringify(result) === JSON.stringify({ kind: "catalog_sync", provider: "openrouter" }), "R0.5: catalog cron returns catalog_sync kind");
    check(seen.length === 1 && seen[0] === "openrouter", "R0.5: catalog cron calls injected syncProvider");
    check(pending.length === 1, "R0.5: catalog cron registers work via ctx.waitUntil");
  }
  {
    const pending = [];
    const logs = await captureLogs(async () => {
      const result = runScheduledTick({ cron: "10 */6 * * *", scheduledTime: 0 }, newEnv(), { waitUntil: (p) => pending.push(p) }, {
        syncProvider: async () => { throw new Error("nope"); },
      });
      await Promise.all(pending);
      check(result.kind === "catalog_sync" && result.provider === "nvidia", "R0.5: failing catalog cron still returns its kind");
    });
    check(logs.some((l) => l.includes("syncProvider(nvidia) failed:")), "R0.5: catalog failure logs exact provider message");
  }
  {
    const state = mkState([DUE]);
    const sent = [];
    const pending = [];
    const result = runScheduledTick({ cron: "* * * * *", scheduledTime: NOON }, envOf(state), { waitUntil: (p) => pending.push(p) }, {
      sendMessage: async (chatId, text, markup) => { sent.push({ chatId, text, markup }); },
    });
    await Promise.all(pending);
    check(JSON.stringify(result) === JSON.stringify({ kind: "reminder_tick" }), "R0.5: non-catalog cron returns reminder_tick kind");
    check(sent.length === 1 && sent[0].chatId === "1", "R0.5: reminder branch runs the tick with injected send");
    check(pending.length === 1, "R0.5: reminder cron registers work via ctx.waitUntil");
  }
  {
    const state = mkState([DUE]);
    const pending = [];
    const logs = await captureLogs(async () => {
      runScheduledTick({ cron: "* * * * *", scheduledTime: NOON }, envOf(state), { waitUntil: (p) => pending.push(p) }, {});
      await Promise.all(pending);
    });
    check(logs.some((l) => l.includes("reminder tick failed:")), "R0.5: reminder failure logs exact message");
  }
  {
    const pending = [];
    const r = await workerDefault.scheduled({ cron: "* * * * *", scheduledTime: NOON }, newEnv(), { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    check(r === undefined, "R0.5: Worker scheduled() returns undefined");
    check(pending.length === 1, "R0.5: Worker scheduled() registers work via waitUntil");
  }
}
