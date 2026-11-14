import { check } from "./harness.mjs";
import { classifyDaily, parseReminder, normalizeDaypartToken, parseDaypartReply, hasDaypartReply, mergeHourAmbiguousFollowup, resolveHourAmbiguousFollowup } from "../../src/daily.js";
import { isRecallQuestionReminder as domainRecall } from "../../src/domain/reminders/parse.js";
import { isRecallQuestionReminder as everydayRecall } from "../../src/everyday.js";

const NOW = Date.UTC(2026, 9, 31, 8, 0, 0);

export async function run() {
  {
    const text = "۲ دقیقه دیگه یادم بنداز به مادر زنگ بزن";
    const r = parseReminder(text, NOW, text);
    check(r.due === "2026-10-31T11:32:00+03:30", "R0.7a: relative reminder resolves two minutes ahead");
    check(r.text === "به مادر زنگ بزن", "R0.7a: relative reminder keeps only the action body");
  }
  {
    const text = "فردا ساعت ۹ صبح یادم بنداز دارو بخور";
    const r = parseReminder(text, NOW, text);
    check(r.due === "2026-11-01T09:00:00+03:30", "R0.7a: explicit reminder resolves tomorrow morning");
    check(r.text === "دارو بخور", "R0.7a: explicit reminder keeps only the action body");
  }
  {
    const text = "ساعت ۳ یادم بنداز ورزش کنم";
    const ask = parseReminder(text, NOW, text);
    check(ask.ask === "hour-ambiguous", "R0.7a: an ambiguous hour still asks instead of guessing");
    check(normalizeDaypartToken("عصر") === "عصر", "R0.7a: daypart token normalizes");
    check(parseDaypartReply("عصر")?.bare === "عصر", "R0.7a: a bare daypart reply is recognized");
    check(hasDaypartReply("عصر") === true, "R0.7a: hasDaypartReply accepts a bare daypart");
    const merged = mergeHourAmbiguousFollowup("عصر", text);
    check(merged === "ساعت 3 عصر یادم بنداز ورزش کنم", "R0.7a: the daypart is spliced onto the ambiguous hour");
    const r = resolveHourAmbiguousFollowup("عصر", text, NOW);
    check(r?.due === "2026-10-31T15:00:00+03:30", "R0.7a: the follow-up resolves the afternoon hour");
    check(r?.text === "ورزش کنم", "R0.7a: the follow-up keeps only the action body");
  }
  {
    const text = "تفاوت صبح و عصر چیه؟";
    check(hasDaypartReply(text) === false, "R0.7a: a daypart question is not a daypart reply");
    check(classifyDaily(text).intent === "chat", "R0.7a: a daypart question stays chat");
  }
  {
    check(domainRecall("یادم بنداز فردا ساعت ۹ چی بود؟") === true, "R0.7a: recall questions are recognized in the domain parser");
    check(domainRecall("یادم بنداز فردا ساعت ۹ دارو بخور") === false, "R0.7a: create reminders are not recall questions");
    check(everydayRecall === domainRecall, "R0.7a: everyday re-exports the same recall helper");
  }
  {
    const prevFetch = globalThis.fetch;
    const prevConsole = {};
    const calls = [];
    globalThis.fetch = (...args) => { calls.push("fetch"); return Promise.reject(new Error("network")); };
    for (const k of ["log", "warn", "error", "info", "debug"]) { prevConsole[k] = console[k]; console[k] = (...args) => { calls.push(k); }; }
    try {
      const text = "ساعت ۳ یادم بنداز ورزش کنم";
      parseReminder(text, NOW, text);
      resolveHourAmbiguousFollowup("عصر", text, NOW);
      classifyDaily("۲ دقیقه دیگه یادم بنداز به مادر زنگ بزن");
      domainRecall("یادم بنداز فردا ساعت ۹ چی بود؟");
      check(calls.length === 0, "R0.7a: reminder parsing makes no network call and writes no log");
    } finally {
      globalThis.fetch = prevFetch;
      for (const k of Object.keys(prevConsole)) console[k] = prevConsole[k];
    }
  }
}
