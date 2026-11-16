import { listVaultItems, getVaultItem, saveVaultItem, listVaultFiles, setVaultSyncStatus, redactMessageContent } from "../db.js";
import { encryptVaultValue, decryptVaultValue, syncVaultItemToGoogle } from "../vault.js";
import { formatJalali } from "../daily.js";
import { tehranParts } from "../domain/notes/render.js";
import { formatTelegramHtml } from "./respond.js";
import { markDaily, NOT_SAVED_TEXT, recentMessages } from "./context.js";

export const VAULT_PRIVATE_ONLY_TEXT = "🔒 عملیات گاوصندوق فقط در چت خصوصی مجاز است.";
export const VAULT_REDACTED_TEXT = "[🔒 محتوای حساس گاوصندوق]";

export async function runVaultAndFileBranch(env, o, c, ctx, deps = {}) {
  const { userId } = o;
  const tg = deps.tgApi || o.tgApi;
  if (["vault_save", "vault_get", "vault_list", "vault_file_get"].includes(c.intent) && o.chatType !== "private") {
    if (c.intent === "vault_save") {
      const rowId = o.messageRowId ?? o.msgId ?? o.entryMessageId ?? null;
      if (rowId) await redactMessageContent(env, userId, rowId, VAULT_REDACTED_TEXT);
    }
    await o.send(VAULT_PRIVATE_ONLY_TEXT);
    return "handled";
  }
  if (c.intent === "vault_save") {
    const rowId = o.messageRowId ?? o.msgId ?? o.entryMessageId ?? null;
    if (!c.title || !String(c.title).trim() || !c.value || !String(c.value).trim() || String(c.value).trim().length < 4) { await o.send("برای ثبت در گاوصندوق، عنوان و مقدار را مشخص کن؛ هنوز چیزی ذخیره نشده است."); return "handled"; }
    await markDaily(env, o);
    if (rowId) await redactMessageContent(env, userId, rowId, VAULT_REDACTED_TEXT);
    let valueEnc;
    try { valueEnc = await encryptVaultValue(env, c.value ?? ""); } catch { await o.send(NOT_SAVED_TEXT); return "handled"; }
    const saved = await saveVaultItem(env, { userId, label: c.title ?? "مورد گاوصندوق", kind: "text", valueEnc, category: c.category ?? null, extra: c.extra ?? null, syncStatus: "local" });
    let badge = "";
    if (saved.ok) {
      const row = await getVaultItem(env, userId, saved.id);
      if (row) {
        const sync = await syncVaultItemToGoogle(env, { id: row.id, userId, label: row.label, value: c.value ?? "", kind: "text", createdAt: row.created_at });
        await setVaultSyncStatus(env, userId, saved.id, sync.ok ? "synced" : "pending_google", sync.googleId ?? null);
        badge = sync.ok ? "\n✅ گوگل‌شیت: ذخیره شد" : "\n⏳ در انتظار همگام‌سازی گوگل";
      }
    }
    await o.send(`🔒 **در گاوصندوق امن ذخیره شد**\n📌 عنوان: **${c.title ?? ""}**\n💳 مقدار (ضربه برای کپی): \`${c.value ?? ""}\`${badge}`);
    return "handled";
  }
  if (c.intent === "vault_get") {
    if (o.chatType && o.chatType !== "private") { await o.send(VAULT_PRIVATE_ONLY_TEXT); return "handled"; }
    await markDaily(env, o);
    const items = (await listVaultItems(env, userId)).items;
    const keys = (c.keywords ?? []).filter(Boolean);
    const matches = [];
    for (const it of items || []) {
      const hay = `${it.label ?? ""} ${it.category ?? ""} ${it.extra ?? ""}`;
      if (keys.some((k) => hay.includes(k))) matches.push(it);
    }
    if (matches.length === 0) { await o.send("هیچ موردی در گاوصندوق پیدا نشد."); return "handled"; }
    const lines = [];
    for (const it of matches) {
      const row = await getVaultItem(env, userId, it.id);
      let value = "";
      try { if (row) value = await decryptVaultValue(env, row.value_enc); } catch { value = "[رمزنگاری‌شده]"; }
      lines.push(`📌 **${it.label ?? ""}**\n\`${value}\``);
    }
    await o.send(lines.join("\n\n"));
    return "handled";
  }
  if (c.intent === "vault_list") {
    await markDaily(env, o);
    if (c.fileList) {
      const files = (await listVaultFiles(env, userId)).files || [];
      if (!files.length) { await o.send("هیچ مدرکی در آرشیو پیدا نشد."); return "handled"; }
      const lines = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const tp = tehranParts(f.created_at);
        const when = tp ? `${formatJalali(tp.date) || tp.date} ${tp.hhmm}` : "";
        lines.push(`${i + 1}. 📁 **${f.title ?? ""}**${when ? ` — ${when}` : ""}`);
      }
      const keyboard = files.map((f, i) => [{ text: `📥 #${i + 1}`, callback_data: `vault:file:${f.id}` }]);
      await o.send(lines.join("\n"), { replyMarkup: { inline_keyboard: keyboard } });
      return "handled";
    }
    const items = (await listVaultItems(env, userId)).items;
    if (!(items || []).length) { await o.send("گاوصندوق خالی است."); return "handled"; }
    const lines = [];
    let n = 0;
    for (const it of items || []) {
      const row = await getVaultItem(env, userId, it.id);
      let value = "";
      try { if (row) value = await decryptVaultValue(env, row.value_enc); } catch { value = ""; }
      if (!value) continue;
      n++;
      lines.push(`${n}. 📌 **${it.label ?? ""}** — \`${value}\``);
    }
    let text = n ? lines.join("\n") : "هیچ مقدار ذخیره‌شده‌ای پیدا نشد.";
    text += `\n\nبرای گرفتن فایل اکسل، روی «📊 خروجی اکسل (CSV)» بزنید.`;
    await o.send(text, { replyMarkup: { inline_keyboard: [[{ text: "📊 خروجی اکسل (CSV)", callback_data: "vault:csv" }], [{ text: "☁️ همگام‌سازی گوگل", callback_data: "vault:sync" }]] } });
    return "handled";
  }
  if (c.intent === "vault_file_get") {
    await markDaily(env, o);
    const keys = (c.keywords ?? []).filter(Boolean);
    const files = (await listVaultFiles(env, userId)).files || [];
    const hits = keys.length ? files.filter((f) => keys.some((k) => String(f.title ?? "").includes(k))) : files;
    hits.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
    const f = hits[0];
    if (!f) { await o.send("مدرکی با این عنوان پیدا نشد."); return "handled"; }
    const tp = tehranParts(f.created_at);
    const when = tp ? `${formatJalali(tp.date) || tp.date} ${tp.hhmm}` : "";
    const caption = `🔒📁 **${f.title ?? ""}**${when ? `\n🗓 ${when}` : ""}${f.doc_url ? `\n${f.doc_url}` : ""}`;
    const formatted = formatTelegramHtml(caption);
    const payload = { chat_id: o.chatId, caption: formatted, ...(formatted !== caption ? { parse_mode: "HTML" } : {}) };
    if (f.file_type === "photo") await tg(env, "sendPhoto", { ...payload, photo: f.tg_file_id });
    else await tg(env, "sendDocument", { ...payload, document: f.tg_file_id });
    return "handled";
  }
  if (c.intent === "file-reference") {
    const recent = await recentMessages(env, userId, 10);
    const file = recent.find((r) => r.tg_file_id);
    if (file) {
      const fileLabel = file.file_name || (typeof file.file_mime === "string" && file.file_mime.startsWith("image/") ? "عکس" : "فایل");
      await o.send(`📎 فایل پیدا شد: ${fileLabel} — خلاصه‌سازی با قدم فایل‌ها می‌آید، فعلاً فقط ذخیره شده است.`);
      await markDaily(env, o);
      return "handled";
    }
    const prev = recent[0];
    if (prev && prev.role === "user" && prev.kind === "chat" && !prev.tg_file_id) return "chat";
    await o.send("کدام فایل؟ در ۱۰ پیام اخیر فایلی پیدا نشد.");
    return "handled";
  }
  return null;
}
