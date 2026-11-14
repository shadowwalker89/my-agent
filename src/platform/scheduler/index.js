import { claimDueReminders, releaseReminderClaim, purgeOldClosedTasks } from "../../db.js";

export const CRON_PROVIDER = Object.freeze({
  "0 */6 * * *": "openrouter",
  "10 */6 * * *": "nvidia",
  "20 */6 * * *": "xkiro",
});

export function buildReminderMessage(reminder, nowMs = Date.now()) {
  const delayed = nowMs - Date.parse(reminder.remind_at) > 5 * 60 * 1000;
  const text = `${delayed ? "⏰ (تأخیری) یادآوری: " : "⏰ یادآوری: "}${reminder.title ?? ""}`;
  const reply_markup = {
    inline_keyboard: [[
      { text: "✅", callback_data: `task:done:${reminder.id}` },
      { text: "💤 ۱۰ دقیقه‌ی دیگر", callback_data: `task:snooze:${reminder.id}` },
    ]],
  };
  return { text, reply_markup };
}

export function isMidnightUtc(scheduledTime) {
  if (scheduledTime === null || scheduledTime === undefined) return false;
  const d = new Date(scheduledTime);
  return Number.isFinite(d.getTime()) && d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
}

export function makeTelegramSendMessage(tgApi, env) {
  return (chatId, text, markup) => {
    let replyMarkup = null;
    if (markup && typeof markup === "object") {
      replyMarkup = Object.prototype.hasOwnProperty.call(markup, "reply_markup") ? markup.reply_markup : markup;
    }
    return tgApi(env, "sendMessage", {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  };
}

export async function runReminderTick(env, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = opts.nowIso ?? new Date(nowMs).toISOString();
  const send = opts.sendMessage;
  const claim = await claimDueReminders(env, nowIso, 20);
  if (!claim.ok) return { ok: false, sent: 0, failed: 0, purged: null };
  if (claim.reminders.length > 0 && typeof send !== "function") {
    throw new Error("scheduler: sendMessage is required when reminders are due");
  }
  let sent = 0;
  let failed = 0;
  for (const r of claim.reminders) {
    const delayed = Date.parse(nowIso) - Date.parse(r.remind_at) > 5 * 60 * 1000;
    const text = `${delayed ? "⏰ یادآوری (با تاخیر):" : "⏰ یادآوری:"} ${r.title}`;
    const replyMarkup = { inline_keyboard: [[{ text: "✅", callback_data: `task:done:${r.id}` }, { text: "💤 ۱۰ دقیقه‌ی دیگر", callback_data: `task:snooze:${r.id}` }]] };
    try {
      const res = await send(r.telegram_id, text, replyMarkup);
      if (res && res.ok === false) throw new Error(`telegram_send_failed: ${res.error_code ?? ""} ${res.description ?? ""}`);
      sent++;
    } catch (err) {
      failed++;
      await releaseReminderClaim(env, r.id);
      console.error(`reminder send failed: task ${r.id}:`, err && err.message);
    }
  }
  let purged = null;
  if (isMidnightUtc(opts.scheduledTime ?? nowMs)) {
    const p = await purgeOldClosedTasks(env, new Date(Date.parse(nowIso) - 30 * 86400000).toISOString());
    purged = p.ok ? p.deleted : null;
  }
  return { ok: true, sent, failed, purged };
}

export function runScheduledTick(event, env, ctx, deps = {}) {
  const schedule = typeof ctx?.waitUntil === "function" ? (p) => ctx.waitUntil(p) : (p) => { void p; };
  const provider = CRON_PROVIDER[event?.cron];
  if (provider) {
    schedule((async () => {
      try {
        await deps.syncProvider(env, provider);
      } catch (err) {
        console.error(`syncProvider(${provider}) failed:`, err && err.message);
      }
    })());
    return { kind: "catalog_sync", provider };
  }
  schedule((async () => {
    try {
      await runReminderTick(env, { scheduledTime: event?.scheduledTime, sendMessage: deps.sendMessage });
    } catch (err) {
      console.error("reminder tick failed:", err && err.message);
    }
  })());
  return { kind: "reminder_tick" };
}
