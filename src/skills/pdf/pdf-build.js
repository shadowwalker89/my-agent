import { enc, pdfEsc, htmlEsc } from "./pdf-helpers.js";
import { buildPdf } from "./pdf-extract-text.js";

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
