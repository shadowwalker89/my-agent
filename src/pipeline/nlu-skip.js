// Phase 2-c unambiguous-question rule for the NLU skip (moved from
// src/everyday.js, R0.8a). A message is unambiguous when it starts with a
// question word (تفاوت / چرا / چطور / چگونه / چیست / چیه) or ends with
// ? / ؟, AND contains no note/task/reminder/expense/project/summary
// keyword. The keyword guard keeps questions like «یادداشت‌هام رو چطور
// ببینم؟» on the NLU path, where they may route to a list instead of chat.

const NLU_SKIP_QUESTION_PREFIXES = ["تفاوت ", "چرا ", "چطور ", "چگونه ", "چیست", "چیه"];
const NLU_SKIP_KEYWORDS = ["یادداشت", "تسک", "یادآوری", "یادم بنداز", "زنگ", "هزینه", "خرج", "پروژه", "پوشه", "خلاصه", "جدول"];
export const REF_RE = /(?:^|[\s،,.:؛!؟])(همونو|همون|اونو|اینو)(?=[\s،,.:؛!؟]|$)/u;
export function isUnambiguousQuestion(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  const startsQ = NLU_SKIP_QUESTION_PREFIXES.some((p) => t.startsWith(p));
  const endsQ = t.endsWith("?") || t.endsWith("؟");
  if (!startsQ && !endsQ) return false;
  return !NLU_SKIP_KEYWORDS.some((k) => t.includes(k));
}
