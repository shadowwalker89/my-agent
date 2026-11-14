import { cleanPrompt } from "./helpers.js";

export function parseImageGenCommand(text) {
  const t = String(text ?? "").trim();
  if (!t) return { isImageGen: false, prompt: "" };
  if (/ذخیره\s*کن|گاوصندوق/u.test(t)) return { isImageGen: false, prompt: "" };
  const slash = t.match(/^\/(?:image|img)\s+(.+)$/i);
  if (slash) {
    const p = cleanPrompt(slash[1]);
    return p ? { isImageGen: true, prompt: p } : { isImageGen: false, prompt: "" };
  }
  // Creation verbs may end the sentence with punctuation. The image noun
  // may appear with or without "از", and tolerate common typos around it
  // ("به عکس", "ی عکس", "یک عکس", "عکسی").
  const verb = t.match(/(?:بساز|بکش|تولید[\s\u200C]+کن|درست[\s\u200C]+کن|طراحی[\s\u200C]+کن|بده)[.!؟?۔]*\s*$/u);
  if (!verb) return { isImageGen: false, prompt: "" };
  const before = t.slice(0, verb.index).trim();
  const noun = before.match(/(?:عکسی|عکس|تصویری|تصویر|نقاشی|پوستر|لوگو)/u);
  if (!noun) return { isImageGen: false, prompt: "" };
  let subject = before.slice(noun.index + noun[0].length).trim();
  subject = subject.replace(/^(?:از|را|رو)\s+/u, "").replace(/[\s،,؛;:：]+(?:را|رو)\s*$/u, "").trim();
  subject = subject.replace(/^(?:از|را|رو)\s+/u, "").trim();
  const p = cleanPrompt(subject);
  return p ? { isImageGen: true, prompt: p } : { isImageGen: false, prompt: "" };
}
