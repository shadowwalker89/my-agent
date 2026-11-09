// Phase 3.5: Bidirectional PDF engine — read/translate PDFs + generate PDFs. Zero external deps.
import { getConnectorSecret } from "./connectors.js";
export function bytesToBase64(b) { const a = b instanceof Uint8Array ? b : new Uint8Array(b || []); if (typeof Buffer !== "undefined") { try { return Buffer.from(a).toString("base64"); } catch {} } let s = ""; for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode.apply(null, a.subarray(i, i + 8192)); return typeof btoa === "function" ? btoa(s) : s; }
function bytesToB64(b) { return bytesToBase64(b); }
function enc(s) { return new TextEncoder().encode(s); }
async function resolveKey(env, uid, cid, fb) { try { const v = await getConnectorSecret(env, uid, cid); if (typeof v === "string" && v) return v; } catch {} const e = env?.[fb]; return typeof e === "string" && e ? e : null; }
async function safeJson(r) { try { if (typeof r?.json === "function") return await r.json(); } catch {} try { if (typeof r?.text === "function") { const t = await r.text(); return t ? JSON.parse(t) : null; } } catch {} return null; }
function htmlEsc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function pdfEsc(s) { return String(s ?? "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"); }
function chatText(out) { if (!out) return ""; if (typeof out === "string") return out.trim(); if (typeof out === "object") { const t = out.text || out.finalText || out.answer || out?.data?.choices?.[0]?.message?.content || out?.data?.message?.content || ""; if (typeof t === "string" && t.trim()) return t.trim(); if (t && typeof t === "object") { try { return String(t).trim(); } catch {} } } try { return String(out).trim(); } catch { return ""; } }
function latin1FromBytes(bytes) {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let raw = "";
  for (let i = 0; i < a.length; i += 8192) raw += String.fromCharCode.apply(null, a.subarray(i, i + 8192));
  return raw;
}
export const SCANNED_PDF_MESSAGE = "این PDF از تصاویر اسکن‌شده تشکیل شده و لایهٔ متن قابل استخراج ندارد؛ لطفاً نسخهٔ متنی یا OCR‌شده را بفرست.";
function hexToUnicode(hex) {
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
function normGlyphKey(hex) { return String(hex || "").replace(/\s+/g, "").toUpperCase(); }
function parseCMapInto(map, text) {
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
function decodePdfLiteral(raw) {
  return String(raw || "").replace(/\\(\r\n|\n|\r)/g, "").replace(/\\([0-7]{1,3}|.)/g, (all, g) => {
    if (/^[0-7]+$/.test(g)) return String.fromCharCode(parseInt(g, 8) & 0xff);
    switch (g) { case "n": return "\n"; case "r": return "\r"; case "t": return "\t"; case "b": return "\b"; case "f": return "\f"; default: return g; }
  });
}
function chooseGlyphWidth(hexLen, map) {
  if (!map || !map.size) return hexLen % 4 === 0 ? 4 : 2;
  let has4 = false; let has2 = false;
  for (const k of map.keys()) { if (k.length === 4) has4 = true; else if (k.length === 2) has2 = true; }
  if (hexLen % 4 === 0 && has4) return 4;
  if (hexLen % 2 === 0 && has2) return 2;
  return hexLen % 4 === 0 ? 4 : 2;
}
function decodeHexGlyphs(hex, map) {
  const clean = String(hex || "").replace(/\s+/g, "");
  if (!clean || clean.length % 2) return "";
  const width = chooseGlyphWidth(clean.length, map);
  let out = "";
  for (let i = 0; i < clean.length; i += width) {
    const chunk = clean.slice(i, i + width); if (chunk.length < width) break;
    const key = chunk.toUpperCase();
    if (map && map.has(key)) { out += map.get(key); continue; }
    if (width >= 4) {
      const u = parseInt(chunk.slice(0, 2), 16) * 256 + parseInt(chunk.slice(2, 4), 16);
      if (u >= 0x20 && u !== 0xfffd && u !== 0x0000) out += String.fromCharCode(u);
    } else {
      const c = parseInt(chunk, 16);
      if (c >= 0x20 && c !== 0x7f) out += String.fromCharCode(c);
    }
  }
  return out;
}
const PDF_JUNK_TOKEN = /^(?:obj|endobj|stream|endstream|FlateDecode|BitsPerComponent|xref|trailer|startxref|BT|ET|Tj|TJ|Tf|Td|TD|Tm|T\*|cm|rg|RG|q|Q)$/;
function extractContentText(content, glyphMap) {
  const src = String(content || "");
  const segments = [];
  for (const seg of src.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) segments.push(seg[1]);
  if (!segments.length) return "";
  const parts = [];
  const push = (t, kind) => {
    const s = String(t || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();
    if (s && !PDF_JUNK_TOKEN.test(s)) parts.push({ text: s, kind });
  };
  for (const seg of segments) {
    for (const m of seg.matchAll(/\(((?:[^()\\]|\\.)*)\)/g)) push(decodePdfLiteral(m[1]), "lit");
    for (const m of seg.matchAll(/<(?!<)([0-9A-Fa-f\s]+)>/g)) push(decodeHexGlyphs(m[1], glyphMap), "hex");
  }
  let out = "";
  let lastKind = "";
  for (const p of parts) {
    if (!out) out = p.text;
    else out += p.kind === "hex" && lastKind === "hex" ? p.text : " " + p.text;
    lastKind = p.kind;
  }
  return out.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}
function readableCount(s) { return (String(s || "").match(/[A-Za-z0-9\u0600-\u06FF]/g) || []).length; }
function uniqText(toks) {
  const seen = new Set();
  const uniq = toks.filter((t) => { const k = String(t).toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  return uniq.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 12000);
}
async function inflateBytes(bytes, format, timeoutMs = 3000) {
  if (typeof DecompressionStream !== "function" || typeof Response !== "function") return null;
  let timer = null;
  try {
    const body = new Response(bytes).body;
    if (!body) return null;
    const stream = body.pipeThrough(new DecompressionStream(format));
    const buf = await Promise.race([
      new Response(stream).arrayBuffer(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("inflate timeout")), timeoutMs); }),
    ]);
    return new Uint8Array(buf);
  } catch { return null; }
  finally { if (timer) clearTimeout(timer); }
}
export async function extractTextFromPdfBytes(pdfBytes) {
  const a = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes || []);
  if (!a.length) return "";
  // latin1 is 1:1 with byte indices, so it is only used to LOCATE offsets.
  // The bytes handed to the decompressor are always the raw subarray.
  const latin = latin1FromBytes(a);
  const re = /\bstream\r?\n/g;
  const decoded = [];
  let m; let count = 0;
  while ((m = re.exec(latin)) && count < 150) {
    count++;
    const start = m.index + m[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) continue;
    const objIdx = latin.lastIndexOf(" obj", m.index);
    const header = latin.slice(objIdx >= 0 ? objIdx : Math.max(0, m.index - 300), m.index);
    re.lastIndex = end + 9;
    if (end - start < 1 || end - start > 4000000) continue;
    // Never extract text from font, image or xref binary streams.
    if (/\/(?:Subtype\s*\/Image|FontFile|Subtype\s*\/Type1C|Subtype\s*\/CIDFontType|Type\s*\/XRef)/.test(header)) continue;
    let e = end;
    while (e > start && (a[e - 1] === 0x0a || a[e - 1] === 0x0d)) e--;
    const rawBytes = a.subarray(start, e);
    if (!rawBytes.length) continue;
    let out = null;
    const wantsFlate = /FlateDecode/.test(header);
    if (wantsFlate || rawBytes[0] === 0x78) {
      for (const fmt of ["deflate", "deflate-raw"]) {
        out = await inflateBytes(rawBytes, fmt, 3000);
        if (out && out.length) break;
      }
    }
    if (!out && !wantsFlate) out = rawBytes;
    if (out && out.length) decoded.push(latin1FromBytes(out));
  }
  const glyphMap = new Map();
  for (const text of decoded) if (/beginbf(?:char|range)/.test(text)) parseCMapInto(glyphMap, text);
  const toks = [];
  let sawTextOps = false;
  for (const text of decoded) {
    if (/beginbf(?:char|range)/.test(text)) continue;
    const t = extractContentText(text, glyphMap);
    if (t) { sawTextOps = true; toks.push(t); }
  }
  if (!sawTextOps && count === 0) {
    const t = extractContentText(latin, glyphMap);
    if (t) { sawTextOps = true; toks.push(t); }
  }
  const out = uniqText(toks);
  if (!out || (readableCount(out) < 15 && !sawTextOps)) return SCANNED_PDF_MESSAGE;
  return out;
}
function buildPdf(parts) {
  const out = [enc("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")]; const offs = [0]; let pos = out[0].length;
  parts.forEach((p, i) => { offs[i + 1] = pos; const b = typeof p === "string" ? enc(p) : p; out.push(b); pos += b.length; });
  let xref = "xref\n0 " + (parts.length + 1) + "\n0000000000 65535 f \n"; for (let i = 1; i <= parts.length; i++) xref += String(offs[i]).padStart(10, "0") + " 00000 n \n";
  xref += "trailer\n<< /Size " + (parts.length + 1) + " /Root 1 0 R >>\nstartxref\n" + pos + "\n%%EOF\n"; out.push(enc(xref)); const tot = out.reduce((n, b) => n + b.length, 0); const r = new Uint8Array(tot); let o = 0; for (const b of out) { r.set(b, o); o += b.length; } return r;
}
export function isPdfAnalysisRequest(caption, mimeType, fileName) {
  const isPdf = String(mimeType || "").toLowerCase() === "application/pdf" || String(fileName || "").toLowerCase().endsWith(".pdf"); if (!isPdf) return false;
  const s = String(caption ?? "").trim(); if (!s) return false;
  return /(خلاصه|ترجمه|تحلیل|بررسی|توضیح|ببین|ببینم|نگاه|بخون|بخوان|دربیار|در بیار|استخراج|متن|درباره|چیه|چیست|سوال|سؤال|جواب|پردازش)/.test(s) || /(summar|translat|analys|extract|explain|what.*about|read.*this)/i.test(s);
}
export function parsePdfCreateCommand(text) {
  const t = String(text ?? "").trim(); const no = { isPdfCreate: false, match: false, ok: false, text: "", title: "", bodyText: "" }; if (!t) return no;
  let txt = null; let m = t.match(/^این\s+متن\s+رو\s+PDF\s+کن\s*[:：]\s*(.+)$/is) || t.match(/^این\s+متن\s+رو\s+پی‌دی‌اف\s+کن\s*[:：]\s*(.+)$/s) || t.match(/^متن\s+رو\s+PDF\s+کن\s*[:：]\s*(.+)$/is) || t.match(/^تبدیل\s+به\s+PDF\s*[:：]\s*(.+)$/is) || t.match(/^پی‌دی‌اف\s+کن\s*[:：]\s*(.+)$/s) || t.match(/^\/(pdf|PDF)\s+(.+)$/s);
  if (m) txt = m[m.length - 1];
  if (!txt || !txt.trim()) return no; const body = txt.trim().slice(0, 20000); const lines = body.split(/\r?\n/); const title = lines.length > 1 ? (lines[0].trim().slice(0, 80) || "سند") : "سند";
  return { isPdfCreate: true, match: true, ok: true, text: body, title, bodyText: body };
}
function jpegSize(j) { for (let i = 0; i + 9 < j.length; i++) { if (j[i] === 0xff && j[i + 1] >= 0xc0 && j[i + 1] <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(j[i + 1])) { const h = (j[i + 5] << 8) | j[i + 6]; const w = (j[i + 7] << 8) | j[i + 8]; if (w > 0 && h > 0) return { w, h }; } } return { w: 800, h: 600 }; }
export function buildImageToPdfBytes(jpegBytes, { width = 595, height = 842 } = {}) {
  const j = jpegBytes instanceof Uint8Array ? jpegBytes : new Uint8Array(jpegBytes || []); const { w, h } = jpegSize(j); const W = Number(width) || 595; const H = Number(height) || 842;
  const stream = new Uint8Array(j.length + 64); const head = enc("<< /Type /XObject /Subtype /Image /Width " + w + " /Height " + h + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + j.length + " >>\nstream\n"); const tail = enc("\nendstream\n"); const img = new Uint8Array(head.length + j.length + tail.length); img.set(head, 0); img.set(j, head.length); img.set(tail, head.length + j.length);
  const c = "q " + W + " 0 0 " + H + " 0 0 cm /Im1 Do Q\n";
  return buildPdf(["1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n", "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + W + " " + H + "] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n", new Uint8Array([...enc("4 0 obj\n"), ...img, ...enc("endobj\n")]), "5 0 obj\n<< /Length " + enc(c).length + " >>\nstream\n" + c + "endstream\nendobj\n"]);
}
export function buildTextPdfOrHtmlReport(title, bodyText) {
  const ti = String(title ?? "سند").slice(0, 120) || "سند"; const body = String(bodyText ?? "").slice(0, 20000);
  const lines = [ti, ...body.split(/\r?\n/)].flatMap((l) => { const clean = String(l || "").replace(/\t/g, " ").slice(0, 110); const chunks = []; for (let i = 0; i < clean.length; i += 95) chunks.push(clean.slice(i, i + 95)); return chunks.length ? chunks : [""]; });
  const cLines = lines.slice(0, 40).map((l) => "(" + pdfEsc(l) + ") Tj T*").join("\n");
  const c = "BT /F1 12 Tf 48 780 Td 16 TL " + cLines + " ET\n";
  const pdfBytes = buildPdf(["1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n", "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n", "4 0 obj\n<< /Length " + enc(c).length + " >>\nstream\n" + c + "endstream\nendobj\n", "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"]);
  const paras = body.split(/\r?\n/).map((l) => "<p>" + htmlEsc(l || "&nbsp;") + "</p>").join("");
  const html = "<!DOCTYPE html><html dir=\"rtl\" lang=\"fa\"><head><meta charset=\"utf-8\"><title>" + htmlEsc(ti) + "</title><style>body{font-family:Vazirmatn, Tahoma, sans-serif;margin:2em;line-height:1.9;text-align:right;background:#fff;color:#111}h1{font-size:1.6em;text-align:center;border-bottom:1px solid #ccc;padding-bottom:.5em}@media print{body{margin:0}h1{page-break-after:avoid}p{page-break-inside:avoid}}</style></head><body><h1>" + htmlEsc(ti) + "</h1>" + paras + "</body></html>";
  return { pdfBytes, pdf: pdfBytes, html };
}
export async function analyzePdfDocument(env, opts = {}) {
  const pdfBytes = opts.pdfBytes instanceof Uint8Array ? opts.pdfBytes : new Uint8Array(opts.pdfBytes || []); const prompt = String(opts.prompt ?? "").trim() || "این پی‌دی‌اف را به فارسی خلاصه و معرفی کن.";
  const userId = opts.userId ?? null; const fn = opts.fetchFn || (typeof fetch === "function" ? fetch : null);
  if (!pdfBytes?.length) return { ok: false, error: "متن قابل استخراج نیست" };
  const key = await resolveKey(env, userId, "gemini", "GEMINI_API_KEY");
  if (key && typeof fn === "function") { const b64 = bytesToB64(pdfBytes); const full = prompt + "\nلطفاً این PDF را به فارسی خلاصه/ترجمه کن، سؤال کاربر را دقیق پاسخ بده و خلاصه فارسی روان تحویل بده.";
    for (const model of ["gemini-2.5-flash", "gemini-2.0-flash"]) { try { const res = await fn("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + key, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: full }, { inlineData: { mimeType: "application/pdf", data: b64 } }] }] }) }); if (res?.ok) { const js = await safeJson(res); const text = (js?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim(); if (text) return { ok: true, text }; } } catch {} }
  }
  const ext = await extractTextFromPdfBytes(pdfBytes); if (!ext) return { ok: false, error: "متن قابل استخراج نیست" };
  if (ext === SCANNED_PDF_MESSAGE) return { ok: true, text: SCANNED_PDF_MESSAGE };
  const chatFn = opts.chatFn || opts.chat || null; const router = opts.routerCallFn || null; const full2 = prompt + "\n\nمتن استخراج‌شده از PDF:\n" + ext.slice(0, 8000) + "\n\nپاسخ را به فارسی روان، خلاصه و دقیق بده.";
  if (typeof chatFn === "function") { try { const out = await chatFn(full2, { saveText: "", noHistory: true }); const t = chatText(out); if (t) return { ok: true, text: t }; } catch {} }
  if (typeof router === "function") { try { const out3 = await router({ model: "chat", messages: [{ role: "user", content: full2 }] }); const t3 = chatText(out3); if (t3) return { ok: true, text: t3 }; } catch {} }
  return { ok: true, text: ext.slice(0, 8000) };
}
