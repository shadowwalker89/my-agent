// Admin setup hub extracted from src/everyday.js (R0.7e).
import { CONNECTORS, getConnectorStatuses, setConnectorSecret } from "../platform/vault/connectors-core.js";
import { sweepConnectorSecrets, renderSetupStatusText } from "../platform/vault/sweep.js";
import { saveMessage, redactMessageContent } from "../db.js";

const CONNECTOR_PRIVATE_ONLY_TEXT = "❌ این دستور فقط برای مالک در چت خصوصی مجاز است.";

export async function handleSetupCommand(env, o) {
  const { userId, text } = o;
  const raw = String(text ?? "").trim();
  const isSetupList = raw === "/setup" || raw === "تنظیمات کانکتورها" || raw === "وضعیت کانکتورها";
  const setupSet = raw.match(/^\/(?:setup)\s+([A-Za-z0-9_]+)\s+(.+)$/) || raw.match(/^تنظیم کانکتور\s+([A-Za-z0-9_]+)\s+(.+)$/);
  const isConnectorSweep = raw === "/setup sweep" || raw === "رمزنگاری مجدد کانکتورها";
  if (!isSetupList && !setupSet && !isConnectorSweep) return false;
  if (isConnectorSweep) {
    if (o.chatType !== "private") { if (typeof o.send === "function") await o.send("❌ این دستور فقط برای مالک در چت خصوصی مجاز است."); return "handled"; }
    const r = await sweepConnectorSecrets(env, { limit: 100, callerId: userId });
    if (typeof o.send === "function") {
      if (r.ok) await o.send(`✅ مهاجرت کلیدها: بررسی ${r.scanned}، رمزنگاری ${r.encrypted}، از پیش رمزنگاری ${r.alreadyEncrypted}، ناموفق ${r.decryptFailed + r.failed}، نامعتبر ${r.invalid}، باقی‌مانده ${r.remaining}${r.complete ? " (کامل)" : ""}.`);
      else await o.send(`❌ مهاجرت کلیدها انجام نشد: ${r.error || (r.changed ? "تغییر همزمان" : "خطا")} (باقی‌مانده ${r.remaining}).`);
    }
    return "handled";
  }
  if (isSetupList) {
    const statuses = await getConnectorStatuses(env, {}, userId);
    if (typeof o.send === "function") await o.send(renderSetupStatusText(statuses));
    return "handled";
  }
  if (setupSet) {
    if (o.chatType !== "private") {
      const existing = o.messageRowId ?? o.msgId ?? o.entryMessageId ?? null;
      if (existing) { try { await redactMessageContent(env, userId, existing, CONNECTOR_PRIVATE_ONLY_TEXT); } catch {} }
      if (typeof o.send === "function") await o.send(CONNECTOR_PRIVATE_ONLY_TEXT);
      return "handled";
    }
    const cid = setupSet[1].trim().toLowerCase();
    const value = setupSet[2].trim().split(/\s+/)[0];
    if (!CONNECTORS.some((c) => c.id === cid) || !value) {
      if (typeof o.send === "function") await o.send(`⚙️ کانکتور نامعتبر است. کانکتورهای مجاز: ${CONNECTORS.map((c) => c.id).join("، ")}`);
      return "handled";
    }
    const r = await setConnectorSecret(env, userId, cid, value);
    try {
      const saved = await saveMessage(env, { userId, role: "user", content: "[🔒 کلید کانکتور]", kind: "daily" });
      if (saved.ok && saved.id) { o.entryMessageId = saved.id; await redactMessageContent(env, userId, saved.id, "[🔒 کلید کانکتور]"); }
      const existing = o.messageRowId ?? o.msgId ?? null;
      if (existing && Number(existing) !== Number(saved.id)) await redactMessageContent(env, userId, existing, "[🔒 کلید کانکتور]");
    } catch {}
    if (r && r.ok === false) { if (typeof o.send === "function") await o.send("❌ ذخیره کلید کانکتور ناموفق بود."); return "handled"; }
    if (typeof o.send === "function") await o.send(`✅ کانکتور **${cid}** با موفقیت تنظیم و فعال شد.`);
    return "handled";
  }
  return false;
}
