// ask: callbacks — the hour-ambiguous reminder buttons, extracted from
// src/everyday.js (R0.8a). Rank 3; no channel imports.
import { parseReminder, normalizeText, resolveHourAmbiguousFollowup, mergeHourAmbiguousFollowup } from "../daily.js";
import { resolveFolderTag } from "../domain/tasks/projects.js";
import { insertTask } from "../db.js";
import { getPendingAsk, clearPendingAsk, slotKind, askText, setPendingAsk, sendHourAmbiguousAsk } from "./route.js";
import { EXPIRED_TEXT, NOT_SAVED_TEXT } from "./context.js";

// Phase 1-e Pillar 3: ask: callbacks — the hour-ambiguous buttons.
// ask:dp:صبح / ask:dp:عصر resolve the pending reminder via
// resolveHourAmbiguousFollowup on the stored pendingBody (never a new
// parse of the tap text); ask:cancel clears + confirms. A missing,
// foreign, or non-hour-ambiguous slot sends EXPIRED_TEXT and clears the
// buttons, never a silent tap. Project preservation: when pendingBody
// carries a folder phrase, the fill re-runs on the tag-stripped
// original so the stored title is clean AND the project attaches.
export async function resolveAskCallback(env, o) {
  const dp = /^ask:dp:(.+)$/.exec(o.data);
  const cancel = o.data === "ask:cancel";
  if (!dp && !cancel) return false;
  const slot = await getPendingAsk(env, o.fromId);
  if (!slot || slotKind(slot) !== "hour-ambiguous" || typeof slot.pendingBody !== "string" || !slot.pendingBody) {
    if (o.editMarkup) await o.editMarkup();
    await o.send(EXPIRED_TEXT);
    return true;
  }
  const now = o.nowMs ?? Date.now();
  await clearPendingAsk(env, o.fromId);
  // Phase 2-d: a final confirmation edits the original ask message in
  // place (text replaced, buttons removed) instead of sending a second
  // message — this is what eliminates the 9:16 PM double-message
  // clutter. Falls back to the old markup-clear + send when no
  // editText is available (offline mocks) or the edit fails.
  const editFinalOrSend = async (text) => {
    if (typeof o.editText === "function") {
      try {
        const res = await o.editText(text);
        if (res && res.ok !== false) return;
      } catch {}
    }
    if (o.editMarkup) await o.editMarkup();
    await o.send(text);
  };
  if (cancel) {
    await editFinalOrSend("❌ یادآوری لغو شد.");
    return true;
  }
  const daypart = dp[1];
  const filled = resolveHourAmbiguousFollowup(daypart, slot.pendingBody, now);
  if (!filled) {
    const merged = mergeHourAmbiguousFollowup(daypart, slot.pendingBody);
    if (merged) {
      const r = parseReminder(normalizeText(merged), now, merged);
      if (r.ask) {
        if (o.editMarkup) await o.editMarkup();
        if (r.ask === "past") { await o.send(askText("past")); return true; }
        if (r.ask === "hour-ambiguous") { await sendHourAmbiguousAsk(o); await setPendingAsk(env, o.fromId, askText("hour-ambiguous"), undefined, "hour-ambiguous", slot.pendingBody); return true; }
        await o.send(askText(r.ask)); return true;
      }
    }
    if (o.editMarkup) await o.editMarkup();
    await o.send(NOT_SAVED_TEXT);
    return true;
  }
  let body = filled.text, pid = null, pname = null;
  const tag = await resolveFolderTag(env, o.fromId, slot.pendingBody);
  if (tag) {
    const filledClean = resolveHourAmbiguousFollowup(daypart, tag.body, now);
    if (filledClean) { body = filledClean.text; pid = tag.project.id; pname = tag.project.name; }
  }
  const r = await insertTask(env, { userId: o.fromId, title: body, remindAt: filled.due, dueAt: null, projectId: pid, source: "text" });
  if (r.ok) {
    await editFinalOrSend(`⏰ یادآوری به‌عنوان تسک ذخیره شد.${pname ? ` [📁 ${pname}]` : ""}`);
  } else {
    if (o.editMarkup) await o.editMarkup();
    await o.send(NOT_SAVED_TEXT);
  }
  return true;
}
