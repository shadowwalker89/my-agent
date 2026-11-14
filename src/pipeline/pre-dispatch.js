import { parseImageGenCommand, generateFreeImage, editImage, analyzeImage, isImageEditCaption, isVisionQuestionCaption } from "../media.js";
import { buildTextPdfOrHtmlReport, parsePdfCreateCommand } from "../pdf.js";
import { fileBytesFromTelegram, namePendingVaultFile } from "./vault-files.js";
import { exportUserBackupSnapshot } from "../db.js";

export async function runPreDispatch(env, o, deps = {}) {
  const { userId, text } = o;
  const now = o.nowMs ?? Date.now();
  const sendPhoto = deps.sendPhoto;
  const sendDocument = deps.sendDocument;
  const getFileDownloadData = deps.getFileDownloadData;
  const tgApi = deps.tgApi;
  if (getFileDownloadData == null || tgApi == null) return null;
  const setupCommand = deps.handleSetupCommand;
  {
    const raw = String(text ?? "").trim();
    const isBackup = raw === "/backup" || raw === "بکاپ اطلاعات" || raw === "پشتیبان‌گیری";
    if (typeof setupCommand === "function") {
      const handled = await setupCommand(env, o);
      if (handled === "handled") return "handled";
    }
    if (isBackup) {
      const snap = await exportUserBackupSnapshot(env, userId, { nowMs: now });
      const json = JSON.stringify(snap, null, 2);
      const c = snap.counts ?? {};
      try {
        if (typeof o.sendDocument === "function") { await o.sendDocument(json, { filename: `backup-${userId}.json`, contentType: "application/json" }); }
        else if (typeof sendDocument === "function" && (env?.TELEGRAM_BOT_TOKEN || env?.TG_TOKEN) && o.chatId) {
          await sendDocument({ ...env, TG_TOKEN: env.TG_TOKEN || env.TELEGRAM_BOT_TOKEN }, o.chatId, `backup-${userId}.json`, json, { contentType: "application/json" });
        }
      } catch {}
      if (typeof o.send === "function") await o.send(`📦 بکاپ اطلاعات آماده شد:\nیادداشت‌ها: ${c.notes ?? 0}\nتسک‌ها: ${c.tasks ?? 0}\nهزینه‌ها: ${c.expenses ?? 0}\nپروژه‌ها: ${c.projects ?? 0}\nتنظیمات: ${c.settings ?? 0}\nحقایق حافظه: ${c.user_facts ?? 0}\nگاوصندوق رمزنگاری‌شده: ${c.vault_items ?? 0}`);
      return "handled";
    }
  }
  const replyPhoto = o.replyToPhoto && (o.replyToPhoto.fileId || o.replyToPhoto.file_id) ? o.replyToPhoto : null;
  const replyUserText = String(text ?? "").trim();
  if (replyPhoto && !replyUserText.startsWith("/")) {
    const rpFileId = replyPhoto.fileId || replyPhoto.file_id;
    const rpCaption = String(replyPhoto.caption ?? "");
    const userText = replyUserText;
    const targetChatId = o.chatId ?? o.userId ?? userId;
    const isGeneratedCaption = /🎨 تصویر (?:ساخته|ویرایش) شد/.test(rpCaption);
    const isPureQuestion = /[?؟]|(?:^|[^\u0600-\u06FF])(?:چیه|کیه|کجاست|چنده|چقدر)(?![\u0600-\u06FF])/u.test(userText);
    const askedQuestion = isPureQuestion || isVisionQuestionCaption(userText);
    const generatedFollowUp = isGeneratedCaption && !isPureQuestion;
    const askedEdit = generatedFollowUp || (!isGeneratedCaption && !askedQuestion && isImageEditCaption(userText));
    const sendEditedPhoto = async (bytes, mimeType, caption) => {
      let ok = false;
      if (typeof o.sendPhoto === "function") {
        try { const r = await o.sendPhoto(bytes, { caption, mimeType, filename: "edited.png" }); ok = !(r && r.ok === false); } catch {}
      }
      if (!ok && (env?.TELEGRAM_BOT_TOKEN || env?.TG_TOKEN) && targetChatId && typeof sendPhoto === "function") {
        try { const r = await sendPhoto({ ...env, TG_TOKEN: env.TG_TOKEN || env.TELEGRAM_BOT_TOKEN }, targetChatId, "edited.png", bytes, { caption, contentType: mimeType }); ok = !(r && r.ok === false); } catch {}
      }
      if (!ok && typeof o.send === "function") await o.send("❌ ارسال تصویر به تلگرام ناموفق بود؛ دوباره تلاش کن.");
      return ok;
    };
    if (askedEdit) {
      if (typeof o.send === "function") await o.send("🎨 در حال ویرایش تصویر، لطفاً چند ثانیه صبر کنید...");
      let basePrompt = rpCaption.replace(/^🎨 تصویر (?:ساخته|ویرایش) شد(?:\s*\([^)]*\))?\s*:\s*/u, "").trim();
      let result = null;
      if (generatedFollowUp) {
        const scene = basePrompt || "the scene in the generated image";
        const combined = `${scene} — تغییرات: ${userText}`;
        const generated = await generateFreeImage(env, combined, { userId: o.userId ?? userId, fetchFn: o.fetchFn, routerCallFn: o.routerCallFn });
        if (generated && generated.ok) result = generated;
      } else {
        const imageBytes = await fileBytesFromTelegram(env, rpFileId, deps);
        if (!basePrompt && imageBytes && imageBytes.length) {
          const desc = await analyzeImage(env, { imageBytes, mimeType: "image/jpeg", prompt: "این تصویر را کوتاه و دقیق به فارسی توصیف کن.", userId, fetchFn: o.fetchFn, routerCallFn: o.routerCallFn });
          if (desc && desc.ok && desc.text) basePrompt = desc.text;
        }
        if (!basePrompt) basePrompt = "the scene in the attached image";
        const negatives = [];
        if (/(ادم|آدم|افراد|مردم|person|people)/i.test(userText)) negatives.push("no people, empty street");
        if (/(الودگی|آلای|دود|مه‌آلود|مه آلود|pollution|smog)/i.test(userText)) negatives.push("clear blue sky without pollution");
        const negativeText = negatives.length ? ` Negative constraints: ${negatives.join(", ")}.` : "";
        const instruction = `Apply this edit to the scene: ${basePrompt}. User edit request: ${userText}.${negativeText}`;
        if (imageBytes && imageBytes.length) {
          const edited = await editImage(env, { imageBytes, mimeType: "image/jpeg", instruction, userId, fetchFn: o.fetchFn });
          if (edited && edited.ok) result = edited;
        }
        if (!result) {
          const generated = await generateFreeImage(env, instruction, { userId: o.userId ?? userId, fetchFn: o.fetchFn, routerCallFn: o.routerCallFn });
          if (generated && generated.ok) result = generated;
        }
      }
      if (result && result.ok) {
        const captionScene = basePrompt || "the scene in the attached image";
        let editCaption = `🎨 تصویر ویرایش شد (${result.provider}): ${captionScene} (${userText})`;
        if (result.provider === "pollinations" && result.diagErrors?.length) editCaption += `\n⚠️ دیباگ موتور اصلی: ${result.diagErrors.slice(0, 3).join(" | ")}`;
        await sendEditedPhoto(result.bytes, result.mimeType, editCaption);
      } else if (typeof o.send === "function") {
        await o.send("ویرایش تصویر ممکن نشد؛ دوباره تلاش کن.");
      }
      return "handled";
    }
    const imageBytes = await fileBytesFromTelegram(env, rpFileId, deps);
    if (!imageBytes || !imageBytes.length) {
      if (typeof o.send === "function") await o.send("تحلیل تصویر ممکن نشد.");
      return "handled";
    }
    const result = await analyzeImage(env, { imageBytes, mimeType: "image/jpeg", prompt: userText, userId: o.userId ?? userId, fetchFn: o.fetchFn, routerCallFn: o.routerCallFn });
    if (typeof o.send === "function") {
      await o.send(result && result.ok && result.text ? result.text : "❌ خطا در تحلیل تصویر: " + (result?.error || result?.text || "vision_unavailable"));
    }
    return "handled";
  }
  const parsedImage = parseImageGenCommand(text);
  if (parsedImage.isImageGen) {
    const targetChatId = o.chatId ?? o.userId ?? userId;
    try {
      if (typeof o.send === "function") await o.send("🎨 در حال ساخت تصویر، لطفاً چند ثانیه صبر کنید...");
      const res = await generateFreeImage(env, parsedImage.prompt, { userId, fetchFn: o.fetchFn, routerCallFn: o.routerCallFn });
      if (res && res.ok) {
        let caption = `🎨 تصویر ساخته شد (${res.provider || "auto"}): ${parsedImage.prompt}`;
        if (res.provider === "pollinations" && res.diagErrors?.length) caption += `\n⚠️ دیباگ موتور اصلی: ${res.diagErrors.slice(0, 3).join(" | ")}`;
        let photoSent = false;
        if (typeof o.sendPhoto === "function") {
          try {
            const tgRes = await o.sendPhoto(res.bytes, { caption, mimeType: res.mimeType, filename: "generated.png" });
            photoSent = !(tgRes && tgRes.ok === false);
          } catch {}
        }
        if (!photoSent && (env?.TELEGRAM_BOT_TOKEN || env?.TG_TOKEN) && targetChatId && typeof sendPhoto === "function") {
          try {
            const tgRes = await sendPhoto({ ...env, TG_TOKEN: env.TG_TOKEN || env.TELEGRAM_BOT_TOKEN }, targetChatId, "generated.png", res.bytes, { caption, contentType: res.mimeType });
            photoSent = !(tgRes && tgRes.ok === false);
          } catch {}
        }
        if (!photoSent && typeof o.send === "function") await o.send("❌ ارسال تصویر به تلگرام ناموفق بود؛ دوباره تلاش کن.");
      } else {
        if (typeof o.send === "function") await o.send(`❌ تولید تصویر در حال حاضر ناموفق بود (${res?.error || "خطای سرویس"})؛ دوباره تلاش کن.`);
      }
    } catch {
      if (typeof o.send === "function") await o.send("❌ تولید تصویر در حال حاضر ناموفق بود؛ دوباره تلاش کن.");
    }
    return "handled";
  }
  const parsedPdf = parsePdfCreateCommand(text);
  if (parsedPdf && parsedPdf.isPdfCreate && parsedPdf.text) {
    const reportPdf = buildTextPdfOrHtmlReport(parsedPdf.title || "سند", parsedPdf.bodyText || parsedPdf.text);
    let pdfSent = false;
    if (typeof o.sendDocument === "function") { await o.sendDocument(reportPdf.pdfBytes, { filename: "report.pdf", contentType: "application/pdf" }); pdfSent = true; }
    else if (typeof sendDocument === "function" && (env?.TELEGRAM_BOT_TOKEN || env?.TG_TOKEN) && o.chatId) { await sendDocument({ ...env, TG_TOKEN: env.TG_TOKEN || env.TELEGRAM_BOT_TOKEN }, o.chatId, "report.pdf", reportPdf.pdfBytes, { contentType: "application/pdf" }); pdfSent = true; }
    if (typeof o.send === "function") await o.send("📄 PDF آماده شد.");
    return "handled";
  }
  if (text && !/^\s*\//.test(text)) {
    const named = await namePendingVaultFile(env, o, { tgApi, getFileDownloadData: getFileDownloadData, sendDocument, sendPhoto });
    if (named) { return "handled"; }
  }
  return null;
}
