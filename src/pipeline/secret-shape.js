// D5: shape-only secret detection for prompt-bound text. Pure, no imports.
// Never validates real values (no Luhn): a card/Sheba shape, or any Vault
// output marker, is enough to keep the text out of an LLM prompt.
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

export function looksSecret(text) {
  try {
    if (typeof text !== "string") return false;
    if (text.includes("🔒")) return true;
    const normalized = text
      .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
      .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
    const compact = normalized.replace(/[\s\u00A0\u200c\u200d\u200e\u200f._-]/g, "");
    return /(?:\d{13,})/.test(compact);
  } catch {
    return false;
  }
}
