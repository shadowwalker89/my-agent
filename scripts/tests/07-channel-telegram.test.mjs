// R0.4: channel extraction acceptance tests (Envelope / Reply / respond).
import { check, mockWorld, newEnv } from "./harness.mjs";
import {
  TELEGRAM_CAPABILITIES,
  toEnvelope,
  renderReply,
} from "../../src/channels/telegram.js";
import {
  escapeHtml,
  formatTelegramHtml,
  splitTelegramText,
  normalizeReply,
} from "../../src/pipeline/respond.js";

function message(extra = {}) {
  return {
    update_id: 77,
    message: {
      message_id: 10,
      date: 1700000000,
      from: { id: 4242, is_bot: false },
      chat: { id: 4242, type: "private" },
      text: "سلام",
      ...extra,
    },
  };
}

export async function run() {
  // ── 1) toEnvelope: Envelope contract, deterministic provenance ─────────────
  {
    const env = toEnvelope(message());
    check(env.channel === "telegram" && env.update_id === 77, "R0.4: Envelope channel + update_id");
    check(env.user_ref === "4242" && env.chat_id === 4242 && env.chat_type === "private", "R0.4: Envelope identity + chat");
    check(env.message_id === 10 && env.text === "سلام", "R0.4: Envelope message_id + text");
    check(env.provenance === "user", "R0.4: direct user message provenance === user");
    check(env.ts === 1700000000 * 1000, "R0.4: Envelope ts from Telegram seconds");
    check(env.attachments.length === 0 && env.callback === null && env.reply_to === null, "R0.4: plain Envelope has no attachments/callback/reply_to");
    check(toEnvelope(null).provenance === "user" && toEnvelope(null).text === "", "R0.4: toEnvelope(null) is safe");
  }
  {
    for (const key of ["forward_origin", "forward_from", "forward_from_chat", "forward_sender_name", "is_automatic_forward"]) {
      const env = toEnvelope(message({ [key]: { id: 9 } }));
      check(env.provenance === "forwarded", `R0.4: ${key} → provenance === forwarded`);
    }
    check(toEnvelope(message({ forward_origin: null })).provenance === "user", "R0.4: null forward marker stays user");
  }
  {
    const { text: _ignored, ...base } = message();
    const env = toEnvelope({
      ...base,
      message: {
        ...base.message,
        text: undefined,
        caption: "عکس",
        photo: [{ file_id: "p1", file_size: 100 }, { file_id: "p2", file_size: 200 }],
        document: { file_id: "d1", file_name: "report.pdf", mime_type: "application/pdf", file_size: 42 },
        voice: { file_id: "v1", mime_type: "audio/ogg", file_size: 7 },
        audio: { file_id: "a1", file_name: "song.mp3", mime_type: "audio/mpeg", file_size: 8 },
        video: { file_id: "vid1", mime_type: "video/mp4", file_size: 9 },
        reply_to_message: { message_id: 5 },
      },
    });
    check(env.text === "عکس", "R0.4: caption becomes Envelope text");
    check(env.reply_to === 5, "R0.4: reply_to_message.message_id mapped");
    check(env.attachments.length === 5, "R0.4: photo/document/voice/audio/video extracted");
    check(env.attachments[0].type === "photo" && env.attachments[0].file_id === "p2", "R0.4: largest photo chosen");
    check(env.attachments[1].file_name === "report.pdf" && env.attachments[1].mime_type === "application/pdf", "R0.4: document metadata preserved");
    check(env.attachments.every((a) => "type" in a && "file_id" in a && "file_name" in a && "mime_type" in a && "file_size" in a), "R0.4: attachment shape {type,file_id,file_name,mime_type,file_size}");
    check(env.attachments[2].file_name === null && env.attachments[2].file_size === 7, "R0.4: missing attachment fields are null");
  }
  {
    const env = toEnvelope({
      update_id: 88,
      callback_query: {
        id: "cb-1",
        from: { id: 4242 },
        data: "note:1",
        message: { message_id: 11, chat: { id: 4242, type: "private" } },
      },
    });
    check(env.text === "note:1" && env.user_ref === "4242" && env.chat_id === 4242, "R0.4: callback_query data + identity");
    check(env.provenance === "user" && env.message_id === null, "R0.4: callback_query provenance + message_id");
    check(JSON.stringify(env.callback) === JSON.stringify({ id: "cb-1", data: "note:1", message_id: 11 }), "R0.4: callback contract shape");
    check(typeof env.ts === "number" && env.ts > 0, "R0.4: callback without date uses Date.now()");
  }

  // ── 2) respond.js formatting utilities ────────────────────────────────────
  {
    check(escapeHtml("<b>&") === "&lt;b&gt;&amp;", "R0.4: escapeHtml escapes &, <, >");
    check(formatTelegramHtml("**سلام** `<x>`") === "<b>سلام</b> <code>&lt;x&gt;</code>", "R0.4: formatTelegramHtml Persian markdown → HTML");
    check(formatTelegramHtml("plain text") === "plain text", "R0.4: formatTelegramHtml leaves plain text unchanged");
    check(formatTelegramHtml("<b>موجود</b> و **جدید**") === "<b>موجود</b> و <b>جدید</b>", "R0.4: formatTelegramHtml preserves safe HTML tags");
    check(JSON.stringify(splitTelegramText("a".repeat(5000))) === JSON.stringify(["a".repeat(4096), "a".repeat(904)]), "R0.4: splitTelegramText 4096-char cap");
    check(JSON.stringify(splitTelegramText("سلام دنیا خوبی", 8)) === JSON.stringify(["سلام", "دنیا", "خوبی"]), "R0.4: splitTelegramText never cuts a Persian word");
    check(JSON.stringify(normalizeReply("متن")) === JSON.stringify({ text: "متن", buttons: [], files: [], edit_message_id: null }), "R0.4: normalizeReply accepts a string");
    check(JSON.stringify(normalizeReply({ text: 5, buttons: "x", files: null, edit_message_id: 3 })) === JSON.stringify({ text: "5", buttons: [], files: [], edit_message_id: 3 }), "R0.4: normalizeReply coerces invalid fields deterministically");
    check(normalizeReply(undefined).text === "" && normalizeReply(null).buttons.length === 0, "R0.4: normalizeReply(null/undefined) is empty Reply");
  }

  // ── 3) TELEGRAM_CAPABILITIES + renderReply (Reply contract) ────────────────
  {
    check(Object.isFrozen(TELEGRAM_CAPABILITIES) === true, "R0.4: TELEGRAM_CAPABILITIES is frozen");
    check(TELEGRAM_CAPABILITIES.buttons === true && TELEGRAM_CAPABILITIES.editMessage === true, "R0.4: Telegram supports buttons + editMessage");
    check(TELEGRAM_CAPABILITIES.maxFileBytes === 50 * 1024 * 1024 && TELEGRAM_CAPABILITIES.maxTextLength === 4096, "R0.4: Telegram file/text caps");
  }
  {
    const world = mockWorld();
    try {
      const reply = {
        text: "**سلام** دنیا",
        buttons: [[{ text: "تایید", callback_data: "ok" }, { text: "لینک", url: "https://example.com" }]],
        edit_message_id: 99,
        files: [
          { kind: "photo", filename: "p.jpg", data: new Uint8Array([1, 2]), caption: "عکس" },
          { kind: "document", filename: "f.pdf", data: new Uint8Array([3]), caption: "فایل" },
        ],
      };
      const results = await renderReply(newEnv(), 4242, reply);
      const tg = world.calls.telegram;
      const send = tg.find((c) => c.method === "sendMessage");
      check(send?.payload?.text === "<b>سلام</b> دنیا" && send?.payload?.parse_mode === "HTML", "R0.4: renderReply sends HTML-formatted Persian text");
      check(JSON.stringify(send?.payload?.reply_markup) === JSON.stringify({ inline_keyboard: [[{ text: "تایید", callback_data: "ok" }, { text: "لینک", url: "https://example.com" }]] }), "R0.4: renderReply maps buttons to reply_markup.inline_keyboard");
      const edit = tg.find((c) => c.method === "editMessageText");
      check(edit?.payload?.message_id === 99 && edit?.payload?.text === "<b>سلام</b> دنیا", "R0.4: renderReply edits edit_message_id");
      check(tg.some((c) => c.method === "sendPhoto") && tg.some((c) => c.method === "sendDocument"), "R0.4: renderReply sends photo + document files");
      check(Array.isArray(results) && results.length === 4, "R0.4: renderReply returns one result per API call");
    } finally {
      world.restore();
    }
  }
  {
    const world = mockWorld();
    try {
      const results = await renderReply(newEnv(), 4242, { text: "", buttons: [], files: [] });
      check(results.length === 0 && world.calls.telegram.length === 0, "R0.4: empty Reply causes no Telegram calls");
      const r = await renderReply(newEnv(), 4242, "متن ساده");
      check(r.length === 1 && world.calls.telegram[0].payload.text === "متن ساده", "R0.4: renderReply accepts a string Reply");
    } finally {
      world.restore();
    }
  }
  {
    const world = mockWorld();
    try {
      await renderReply(newEnv(), 4242, { text: "a".repeat(5000) });
      const sends = world.calls.telegram.filter((c) => c.method === "sendMessage");
      check(sends.length === 2 && sends[0].payload.text.length === 4096 && sends[1].payload.text.length === 904, "R0.4: renderReply chunks long text at maxTextLength");
    } finally {
      world.restore();
    }
  }
}
