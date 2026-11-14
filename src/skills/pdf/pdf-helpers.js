import { getConnectorSecret, isConnectorSecretError } from "../../connectors.js";
export function bytesToBase64(b) { const a = b instanceof Uint8Array ? b : new Uint8Array(b || []); if (typeof Buffer !== "undefined") { try { return Buffer.from(a).toString("base64"); } catch {} } let s = ""; for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode.apply(null, a.subarray(i, i + 8192)); return typeof btoa === "function" ? btoa(s) : s; }
export function bytesToB64(b) { return bytesToBase64(b); }
export function enc(s) { return new TextEncoder().encode(s); }
export async function resolveKey(env, uid, cid, fb) { let v = null; try { v = await getConnectorSecret(env, uid, cid); } catch (err) { if (isConnectorSecretError(err)) throw err; } if (typeof v === "string" && v) return v; const e = env?.[fb]; return typeof e === "string" && e ? e : null; }
export async function safeJson(r) { try { if (typeof r?.json === "function") return await r.json(); } catch {} try { if (typeof r?.text === "function") { const t = await r.text(); return t ? JSON.parse(t) : null; } } catch {} return null; }
export function htmlEsc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
export function pdfEsc(s) { return String(s ?? "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"); }
export function chatText(out) { if (!out) return ""; if (typeof out === "string") return out.trim(); if (typeof out === "object") { const t = out.text || out.finalText || out.answer || out?.data?.choices?.[0]?.message?.content || out?.data?.message?.content || ""; if (typeof t === "string" && t.trim()) return t.trim(); if (t && typeof t === "object") { try { return String(t).trim(); } catch {} } } try { return String(out).trim(); } catch { return ""; } }
export function latin1FromBytes(bytes) {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let raw = "";
  for (let i = 0; i < a.length; i += 8192) raw += String.fromCharCode.apply(null, a.subarray(i, i + 8192));
  return raw;
}
export const SCANNED_PDF_MESSAGE = "این PDF از تصاویر اسکن‌شده تشکیل شده و لایهٔ متن قابل استخراج ندارد؛ لطفاً نسخهٔ متنی یا OCR‌شده را بفرست.";
export function hexToUnicode(hex) {
  let h = String(hex || "").replace(/\s+/g, "");
  if (!h) return "";
  if (h.length % 2) h = "0" + h;
  let out = "";
  if (h.length >= 4) {
    for (let i = 0; i + 3 < h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    if (h.length % 4 === 2) out += String.fromCharCode(parseInt(h.slice(-2), 16));
  } else {
    out = String.fromCharCode(parseInt(h, 16));
  }
  return out.replace(/\0/g, "");
}
export function normGlyphKey(hex) { return String(hex || "").replace(/\s+/g, "").toUpperCase(); }
export function parseCMapInto(map, text) {
  const src = String(text || "");
  for (const block of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const k = normGlyphKey(m[1]); const v = hexToUnicode(m[2]);
      if (k && v) map.set(k, v);
    }
  }
  for (const block of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g)) {
      const start = parseInt(m[1], 16); const end = parseInt(m[2], 16);
      const width = Math.max(2, normGlyphKey(m[1]).length);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 65535) continue;
      if (m[4] != null) {
        const vals = [...m[4].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => hexToUnicode(x[1]));
        for (let c = start; c <= end && c - start < vals.length; c++) map.set(c.toString(16).toUpperCase().padStart(width, "0"), vals[c - start]);
      } else {
        const base = m[3];
        const baseVal = parseInt(base.slice(-4), 16);
        for (let c = start; c <= end; c++) {
          const dst = (baseVal + (c - start)).toString(16).toUpperCase().padStart(base.length, "0");
          const v = hexToUnicode(dst); if (v) map.set(c.toString(16).toUpperCase().padStart(width, "0"), v);
        }
      }
    }
  }
  return map;
}
export function decodePdfLiteral(raw) {
  return String(raw || "").replace(/\\(\r\n|\n|\r)/g, "").replace(/\\([0-7]{1,3}|.)/g, (all, g) => {
    if (/^[0-7]+$/.test(g)) return String.fromCharCode(parseInt(g, 8) & 0xff);
    switch (g) { case "n": return "\n"; case "r": return "\r"; case "t": return "\t"; case "b": return "\b"; case "f": return "\f"; default: return g; }
  });
}
// Arabic Presentation Forms (FB50-FDFF / FE70-FEFF) carry the real Persian
// letters in many PDFs. NFKC maps them back to standard 0600-06FF characters,
// so never strip them before normalizing.
export function normalizePdfText(s) {
  const v = String(s ?? "");
  try { return v.normalize("NFKC"); } catch { return v; }
}
// Many Persian PDFs store every visual line in reversed character order
// ("راضحتسا تهج ناریا تارباخم" instead of "مخابرات ایران جهت استحضار").
// Reverse visual-RTL lines back to logical order while keeping numbers and
// Latin words left-to-right.
export const VISUAL_RTL_MARKER_RE = /(?<![\u0600-\u06FF])(?:خیرات|هرامش|تسویپ|درادن|هسانش|تارباخم|تامدخ|شورف|ناریا|خروم|هبنشود|هسلج|روضح|علاطا|تهج|نواعم|نایرتشم|راضحتسا|نفلت|راگنرود|رد|زا|هب|اب|یاه|نیا)(?![\u0600-\u06FF])/u;
export const VISUAL_FINAL_FORM_RE = /[\uFE8E\uFE90\uFE92\uFE94\uFE96\uFE98\uFEAE\uFEB0\uFB8B\uFB8F\uFB93\uFBFD]/u;
// A line that already reads in forward logical order must never be reversed,
// even when the rest of the document is visual-RTL (e.g. "شرکت خدمات ...").
export const VISUAL_FORWARD_MARKER_RE = /(?<![\u0600-\u06FF])(?:تاریخ|شماره|پیوست|مخابرات|خدمات|شرکت|جلسه|آقای|خانم)(?![\u0600-\u06FF])/u;
// A number or a Latin word is one atomic unit, so it stays readable while the
// surrounding Persian characters are flipped.
export const VISUAL_ATOM_RE = /[0-9\u06F0-\u06F9][0-9\u06F0-\u06F9.,/:\\_-]*|[A-Za-z0-9@._:/\\-]+|[\s\S]/gu;
export function reverseVisualRtlLine(line) {
  const s = String(line ?? "");
  const units = s.match(VISUAL_ATOM_RE) || [];
  let out = units.reverse().join("");
  const lead = /^([:،؛,.؟!?»«]+)([\s\S]*)$/u.exec(out);
  if (lead) out = lead[2] + lead[1];
  return out;
}
