import { runDb } from "./context.js";
import { getVaultFile, listVaultFiles, listVaultItems, getVaultItem, setFileSyncStatus, setVaultSyncStatus } from "../db.js";
import { decryptVaultValue, syncVaultFileToGoogle, syncVaultItemToGoogle } from "../vault.js";
import { formatJalali } from "../daily.js";
import { tehranParts } from "../domain/notes/render.js";
import { formatTelegramHtml } from "./respond.js";
import { isConnectorSecretError } from "../connectors.js";
import { csvRow, fileBytesFromTelegram, analyzeVaultImageDetailed, vaultAnalyzeFailureText } from "./vault-files.js";

export async function resolveVaultCallback(env, o, deps = {}) {
  if (o.chatType !== "private") return true;
  try {
  const tg = deps.tgApi || o.tgApi;
  const sendDocument = deps.sendDocument || o.sendDocument;
  const analyze = /^vault:analyze:(\d+)$/.exec(o.data);
  if (analyze) {
    const id = Number(analyze[1]);
    const f = await getVaultFile(env, o.fromId, id);
    if (!f) { await o.send("مدرکی پیدا نشد."); return true; }
    const result = await analyzeVaultImageDetailed(env, f, null, o.fromId, deps);
    await o.send(result.ok ? result.text : vaultAnalyzeFailureText(result.reason));
    return true;
  }
  const askname = /^vault:askname:(\d+)$/.exec(o.data);
  if (askname) {
    const id = Number(askname[1]);
    const f = await getVaultFile(env, o.fromId, id);
    if (!f) { await o.send("مدرکی پیدا نشد."); return true; }
    const cap = typeof f.caption === "string" ? f.caption.trim() : "";
    if (cap) {
      await runDb(env, "UPDATE vault_files SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?", [cap, new Date().toISOString(), id, o.fromId]);
      const row = await getVaultFile(env, o.fromId, id);
      const bytes = await fileBytesFromTelegram(env, f.tg_file_id, deps);
      const sync = await syncVaultFileToGoogle(env, { id, userId: o.fromId, label: cap, fileName: f.file_name, mimeType: f.mime_type, data: bytes ?? new Uint8Array(0), createdAt: f.created_at });
      await setFileSyncStatus(env, o.fromId, id, sync.ok ? "synced" : "pending_google", sync.googleId ?? null, null);
      await o.send(`🔒📁 مدرک «<b>${cap}</b>» در گاوصندوق امن ذخیره شد.`);
      return true;
    }
    await runDb(env, "UPDATE vault_files SET title = '__pending__', updated_at = ? WHERE id = ? AND user_id = ?", [new Date().toISOString(), id, o.fromId]);
    await o.send("🔒 با چه عنوانی در گاوصندوق امن ذخیره شود؟ (مثلاً بنویسید یا ویس بدهید: «بیمه نامه ۲۰۶» یا «آخرین آزمایش»)");
    return true;
  }
  const cancel = /^vault:cancel:(\d+)$/.exec(o.data);
  if (cancel) {
    const id = Number(cancel[1]);
    await runDb(env, "DELETE FROM vault_files WHERE id = ? AND user_id = ?", [id, o.fromId]);
    if (typeof o.editText === "function") { try { const r = await o.editText("❌ لغو شد."); if (r && r.ok !== false) return true; } catch {} }
    await o.send("❌ لغو شد.");
    return true;
  }
  const csv = /^vault:csv$/.exec(o.data);
  if (csv) {
    const items = (await listVaultItems(env, o.fromId)).items || [];
    const lines = ["ID,Category,Title,Value,Extra,UpdatedAt"];
    for (const it of items) {
      const row = await getVaultItem(env, o.fromId, it.id);
      let value = "";
      try { if (row) value = await decryptVaultValue(env, row.value_enc); } catch {}
      lines.push(csvRow(it.id, it.category ?? "", it.label ?? "", value, it.extra ?? "", it.updated_at ?? ""));
    }
    const body = "\uFEFF" + lines.join("\r\n") + "\r\n";
    if (typeof sendDocument === "function") await sendDocument(env, o.chatId, "personal-vault.csv", body, { contentType: "text/csv" });
    return true;
  }
  const sync = /^vault:sync$/.exec(o.data);
  if (sync) {
    let done = 0, failed = 0;
    const items = (await listVaultItems(env, o.fromId)).items || [];
    for (const it of items) {
      if (it.sync_status === "synced") continue;
      let value = "";
      try { value = await decryptVaultValue(env, it.value_enc); } catch {}
      const r = await syncVaultItemToGoogle(env, { id: it.id, userId: o.fromId, label: it.label, value, kind: "text", createdAt: it.created_at });
      await setVaultSyncStatus(env, o.fromId, it.id, r.ok ? "synced" : "pending_google", r.googleId ?? null);
      r.ok ? done++ : failed++;
    }
    const files = (await listVaultFiles(env, o.fromId)).files || [];
    for (const f of files) {
      if (f.sync_status === "synced") continue;
      const bytes = await fileBytesFromTelegram(env, f.tg_file_id, deps);
      const r = await syncVaultFileToGoogle(env, { id: f.id, userId: o.fromId, label: f.title, fileName: f.fileName, mimeType: f.mimeType, data: bytes ?? new Uint8Array(0), createdAt: f.created_at });
      await setFileSyncStatus(env, o.fromId, f.id, r.ok ? "synced" : "pending_google", r.googleId ?? null, null);
      r.ok ? done++ : failed++;
    }
    await o.send(`✅ همگام‌سازی گوگل تمام شد: ${done} موفق، ${failed} ناموفق.`);
    return true;
  }
  const file = /^vault:file:(\d+)$/.exec(o.data);
  if (file) {
    const fid = Number(file[1]);
    if (!Number.isSafeInteger(fid) || fid <= 0) return true;
    const f = await getVaultFile(env, o.fromId, fid);
    if (!f) { await o.send("مدرکی پیدا نشد."); return true; }
    const tp = tehranParts(f.created_at);
    const when = tp ? `${formatJalali(tp.date) || tp.date} ${tp.hhmm}` : "";
    const caption = `🔒📁 **${f.title ?? ""}**${when ? `\n🗓 ${when}` : ""}${f.doc_url ? `\n${f.doc_url}` : ""}`;
    const formatted = formatTelegramHtml(caption);
    const payload = { chat_id: o.chatId, caption: formatted, ...(formatted !== caption ? { parse_mode: "HTML" } : {}) };
    if (f.file_type === "photo") await tg(env, "sendPhoto", { ...payload, photo: f.tg_file_id });
    else await tg(env, "sendDocument", { ...payload, document: f.tg_file_id });
    return true;
  }
  return false;
  } catch (e) {
    if (isConnectorSecretError(e)) {
      if (typeof o.send === "function") await o.send("❌ کلید کانکتور قابل خواندن نیست؛ لطفاً دوباره تنظیم کنید.");
      return true;
    }
    throw e;
  }
}
