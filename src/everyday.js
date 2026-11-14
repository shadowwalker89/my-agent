import { tgApi, sendProgressMessage, sendDocument, sendPhoto, getFileDownloadData } from "./channels/telegram.js";
import { formatTelegramHtml } from "./pipeline/respond.js";
import { runDailyBranch as runDailyBranchCore } from "./pipeline/daily-branch.js";
import { runSummary as runSummaryCore } from "./pipeline/summary.js";
import { handleIncomingFile as handleIncomingFileCore, handleVaultFile as handleVaultFileCore } from "./pipeline/vault-files.js";
import { resolveVaultCallback as resolveVaultCallbackCore } from "./pipeline/vault-callbacks.js";
import { handleDailyText as handleDailyTextCore, resolveDailyCallback as resolveDailyCallbackCore } from "./pipeline/dispatch.js";
import { handleSetupCommand } from "./admin/setup.js";
import { runReminderTick as runSchedulerReminderTick, makeTelegramSendMessage } from "./platform/scheduler/index.js";
import { resolveNoteCallback as resolveNoteCallbackCore } from "./domain/notes/service.js";
import { resolveTaskCallback as resolveTaskCallbackCore } from "./domain/tasks/service.js";
import { runModelBranch as runModelBranchCore } from "./pipeline/model-branch.js";
import { runNluBranch as runNluBranchCore } from "./pipeline/nlu-branch.js";
import { dbOf, NOT_SAVED_TEXT } from "./pipeline/context.js";
import { saveMessage } from "./db.js";

export { isRecallQuestionReminder } from "./domain/reminders/parse.js";
export { SEED_PROJECTS, resolveProjects } from "./domain/tasks/projects.js";
export { renderTaskList, TASK_LIST_FAILED_TEXT } from "./domain/tasks/service.js";
export { renderNoteList, stripLeadingNotePunct, deriveNoteTitle } from "./domain/notes/render.js";
export { startConfirm, confirmExpenseDraft, rangeForPeriod, queryExpenseSums } from "./domain/expenses/service.js";
export { mapQuestion, askText, hourAmbiguousKeyboard } from "./pipeline/route.js";
export { CHAT_CONTEXT_CHAR_LIMIT, buildChatContext, ensureUserRow, quickConvertKeyboard, chatFailureNotice, formatFailureDetail, resolveQuickConvertCallback, resolveChatRetryCallback } from "./pipeline/context.js";
export { runInterpPolicy } from "./pipeline/policy.js";
export { handleInterpreterText } from "./pipeline/interp-runner.js";
export { resolveInterpCallback } from "./pipeline/interp-callbacks.js";
export { resolveAskCallback } from "./pipeline/ask-callback.js";
export { REF_RE, isUnambiguousQuestion } from "./pipeline/nlu-skip.js";
export { DAILY_CHAT_PROMPT } from "./pipeline/dispatch.js";
export { SUMMARY_SYSTEM } from "./pipeline/summary.js";

async function runDailyBranch(env, o, c, ctx) {
  return runDailyBranchCore(env, o, c, ctx, { tgApi, sendProgressMessage });
}

export async function runModelBranch(env, o, rule, ctx) {
  return runModelBranchCore(env, o, rule, ctx, { runDailyBranch });
}
export async function runNluBranch(env, o, ctx) {
  return runNluBranchCore(env, o, ctx, { runDailyBranch, fallbackSendPhoto: sendPhoto });
}

async function runSummary(env, o, kind, projectId, userId, retryData = null) {
  return runSummaryCore(env, o, kind, projectId, userId, retryData, { sendProgressMessage });
}
export async function resolveNoteCallback(env, o) {
  return resolveNoteCallbackCore(env, o, { runSummary });
}
export async function resolveTaskCallback(env, o) {
  return resolveTaskCallbackCore(env, o, { runSummary });
}
export async function runReminderTick(env, opts = {}) {
  return runSchedulerReminderTick(env, {
    ...opts,
    sendMessage: opts.sendMessage ?? makeTelegramSendMessage(tgApi, env),
  });
}
export async function handleIncomingFile(env, o) {
  return handleIncomingFileCore(env, o, { tgApi, getFileDownloadData, sendDocument, sendPhoto });
}
export async function handleVaultFile(env, o) {
  return handleVaultFileCore(env, o, { tgApi, getFileDownloadData, sendDocument, sendPhoto });
}
export async function resolveVaultCallback(env, o) {
  return resolveVaultCallbackCore(env, o, { tgApi, getFileDownloadData, handleDailyText, sendDocument, sendPhoto });
}

export async function handleDailyText(env, o) {
  return handleDailyTextCore(env, o, { tgApi, sendProgressMessage, sendPhoto, sendDocument, getFileDownloadData, handleSetupCommand });
}
export async function resolveDailyCallback(env, o) {
  return resolveDailyCallbackCore(env, o, { tgApi, sendProgressMessage, sendPhoto, sendDocument, getFileDownloadData, handleSetupCommand });
}

export function dailySenders(env, chatId, messageId) {
  return {
    send: (msgText, opts) => {
      const formatted = formatTelegramHtml(String(msgText ?? ""));
      return tgApi(env, "sendMessage", { chat_id: chatId, text: formatted, ...(formatted !== String(msgText ?? "") ? { parse_mode: "HTML" } : {}), ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}) });
    },
    editMarkup: () => tgApi(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    editText: (text) => Number.isInteger(messageId) && messageId > 0
      ? tgApi(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } })
      : Promise.resolve(null),
  };
}

export async function handleDailyFile(env, o) {
  if (!dbOf(env)) return false;
  const r = await saveMessage(env, { userId: o.userId, role: "user", content: o.caption || o.fileName || "file", kind: "daily", tgFileId: o.tgFileId, fileName: o.fileName || null, fileMime: o.fileMime || null });
  if (!r.ok) { await o.send(NOT_SAVED_TEXT); return true; }
  await o.send("📎 فایل ذخیره شد (فقط ذخیره؛ خلاصه‌سازی با قدم فایل‌ها می‌آید).");
  return true;
}
