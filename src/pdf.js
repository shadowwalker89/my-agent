// Phase 3.5: Bidirectional PDF engine — read/translate PDFs + generate PDFs. Zero external deps.
import { getConnectorSecret } from "./connectors.js";
function bytesToB64(b) { const a = b instanceof Uint8Array ? b : new Uint8Array(b || []); if (typeof Buffer !== "undefined") { try { return Buffer.from(a).toString("base64"); } catch {} } let s = ""; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return typeof btoa === "function" ? btoa(s) : s; }
function enc(s) { return new TextEncoder().encode(s); }
async function resolveKey(env, uid, cid, fb) { try { const v = await getConnectorSecret(env, uid, cid); if (typeof v === "string" && v) return v; } catch {} const e = env?.[fb]; return typeof e === "string" && e ? e : null; }
async function safeJson(r) { try { if (typeof r?.json === "function") return await r.json(); } catch {} try { if (typeof r?.text === "function") { const t = await r.text(); return t ? JSON.parse(t) : null; } } catch {} return null; }
function htmlEsc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function pdfEsc(s) { return String(s ?? "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"); }
function chatText(out) { if (!out) return ""; if (typeof out === "string") return out.trim(); if (typeof out === "object") { const t = out.text || out.finalText || out.answer || out?.data?.choices?.[0]?.message?.content || out?.data?.message?.content || ""; if (typeof t === "string" && t.trim()) return t.trim(); if (t && typeof t === "object") { try { return String(t).trim(); } catch {} } } try { return String(out).trim(); } catch { return ""; } }
function latin1FromBytes(bytes) {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let raw = ""; for (let i = 0; i < a.length; i += 4096) raw += String.fromCharCode.apply(null, a.subarray(i, i + 4096));
  return raw;
}
function tokensFromRawText(raw) {
  const toks = [];
  for (const m of raw.matchAll(/\(((?:[^()\\]|\\.)*)\)/g)) { let t = m[1].replace(/\\n/g, " ").replace(/\\r/g, " ").replace(/\\t/g, " ").replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\").trim(); if (t.length >= 2 && /[A-Za-z0-9\u0600-\u06FF]/.test(t) && !/^(BT|ET|Tf|Td|stream|endstream)$/.test(t)) toks.push(t); }
  for (const m of raw.matchAll(/<([0-9A-Fa-f\s]{4,})>/g)) { let hx = m[1].replace(/\s+/g, ""); if (hx.length % 2) hx = hx.slice(0, -1); if (hx.length < 4) continue; const bb = new Uint8Array(hx.length / 2); for (let j = 0; j < bb.length; j++) bb[j] = parseInt(hx.slice(j * 2, j * 2 + 2), 16); let s = ""; if (/^FEFF/i.test(hx)) { for (let k = 2; k < bb.length; k += 2) s += String.fromCharCode((bb[k] << 8) | bb[k + 1]); } else { let u = ""; for (let k = 0; k + 1 < bb.length; k += 2) u += String.fromCharCode((bb[k] << 8) | bb[k + 1]); const plausible = u.length >= 2 && /[A-Za-z0-9\u0600-\u06FF]/.test(u) && (u.charCodeAt(0) > 255 || bb[0] === 0 || /[\u0600-\u06FF]/.test(u)); if (plausible) s = u; else { for (let k = 0; k < bb.length; k++) s += String.fromCharCode(bb[k]); if (!/[A-Za-z0-9\u0600-\u06FF]/.test(s)) s = ""; } } s = s.replace(/\0/g, "").trim(); if (s.length >= 2 && /[A-Za-z0-9\u0600-\u06FF]/.test(s)) toks.push(s); }
  return toks;
}
function uniqText(toks) {
  const seen = new Set(); const uniq = toks.filter((t) => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  return uniq.join("\n").replace(/\s+\n/g, "\n").trim().slice(0, 12000);
}
function extractPdfText(bytes) {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []); if (!a.length) return "";
  return uniqText(tokensFromRawText(latin1FromBytes(a)));
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
  const raw = latin1FromBytes(a);
  const toks = tokensFromRawText(raw);
  const re = /\bstream\r?\n/g;
  let m; let count = 0;
  while ((m = re.exec(raw)) && count < 80) {
    count++;
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    const data = raw.slice(start, end).replace(/\r?\n$/, "");
    re.lastIndex = end + 9;
    if (!data.length || data.length > 3000000) continue;
    const sb = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) sb[i] = data.charCodeAt(i) & 0xff;
    let out = null;
    for (const fmt of ["deflate", "deflate-raw"]) {
      out = await inflateBytes(sb, fmt, 3000);
      if (out && out.length) break;
    }
    if (out && out.length) toks.push(...tokensFromRawText(latin1FromBytes(out)));
  }
  return uniqText(toks) || extractPdfText(a);
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
  const chatFn = opts.chatFn || opts.chat || null; const router = opts.routerCallFn || null; const full2 = prompt + "\n\nمتن استخراج‌شده از PDF:\n" + ext.slice(0, 8000) + "\n\nپاسخ را به فارسی روان، خلاصه و دقیق بده.";
  if (typeof chatFn === "function") { try { const out = await chatFn(full2, { saveText: "", noHistory: true }); const t = chatText(out); if (t) return { ok: true, text: t }; } catch {} }
  if (typeof router === "function") { try { const out3 = await router({ model: "chat", messages: [{ role: "user", content: full2 }] }); const t3 = chatText(out3); if (t3) return { ok: true, text: t3 }; } catch {} }
  return { ok: true, text: ext.slice(0, 8000) };
}
