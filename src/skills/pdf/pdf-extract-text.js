import { latin1FromBytes, parseCMapInto, decodePdfLiteral, normalizePdfText, enc } from "./pdf-helpers.js";
import { fixVisualRtlPersian, extractContentText, uniqText, readableCount, inflateBytes } from "./pdf-rtl.js";

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
    const near = latin.slice(Math.max(0, m.index - 500), m.index);
    const objMatches = [...near.matchAll(/(\d+)\s+0\s+obj\b/g)];
    const objNum = objMatches.length ? Number(objMatches[objMatches.length - 1][1]) : null;
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
    if (out && out.length) decoded.push({ text: latin1FromBytes(out), objNum });
  }
  // Each font's /ToUnicode stream is its own namespace: <0001> means a
  // different glyph per font. Keep one table per CMap object instead of
  // letting the last (often Latin/symbol) font overwrite the Persian body.
  const cmapByObj = new Map();
  for (const d of decoded) {
    if (!/beginbf(?:char|range)/.test(d.text)) continue;
    const mp = parseCMapInto(new Map(), d.text);
    if (d.objNum != null) cmapByObj.set(d.objNum, mp);
  }
  const cmaps = [];
  const seenCmaps = new Set();
  for (const mp of cmapByObj.values()) { if (mp && mp.size && !seenCmaps.has(mp)) { seenCmaps.add(mp); cmaps.push(mp); } }
  // Link /F1 -> font object -> /ToUnicode object -> CMap table.
  const objects = new Map();
  for (const om of latin.matchAll(/(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g)) objects.set(Number(om[1]), om[2]);
  const fontObjToCmap = new Map();
  for (const [num, body] of objects) {
    if (!/\/Type\s*\/Font\b/.test(body)) continue;
    const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(body);
    if (!tu) continue;
    const mp = cmapByObj.get(Number(tu[1]));
    if (mp && mp.size) fontObjToCmap.set(num, mp);
  }
  const fontNameToCmap = new Map();
  for (const fm of latin.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) {
    if (/\/Type\s*\/Font\b/.test(fm[1])) continue;
    for (const rm of fm[1].matchAll(/\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+0\s+R/g)) {
      const mp = fontObjToCmap.get(Number(rm[2]));
      if (mp) fontNameToCmap.set(rm[1], mp);
    }
  }
  const fontResolver = (name) => fontNameToCmap.get(name) || null;
  const toks = [];
  let sawTextOps = false;
  for (const d of decoded) {
    if (/beginbf(?:char|range)/.test(d.text)) continue;
    const t = extractContentText(d.text, cmaps, fontResolver);
    if (t) { sawTextOps = true; toks.push(t); }
  }
  if (!sawTextOps && count === 0) {
    const t = extractContentText(latin, cmaps, fontResolver);
    if (t) { sawTextOps = true; toks.push(t); }
  }
  const out = fixVisualRtlPersian(uniqText(toks));
  if (!out || (readableCount(out) < 15 && !sawTextOps)) return SCANNED_PDF_MESSAGE;
  return out;
}
export function buildPdf(parts) {
  const out = [enc("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")]; const offs = [0]; let pos = out[0].length;
  parts.forEach((p, i) => { offs[i + 1] = pos; const b = typeof p === "string" ? enc(p) : p; out.push(b); pos += b.length; });
  let xref = "xref\n0 " + (parts.length + 1) + "\n0000000000 65535 f \n"; for (let i = 1; i <= parts.length; i++) xref += String(offs[i]).padStart(10, "0") + " 00000 n \n";
  xref += "trailer\n<< /Size " + (parts.length + 1) + " /Root 1 0 R >>\nstartxref\n" + pos + "\n%%EOF\n"; out.push(enc(xref)); const tot = out.reduce((n, b) => n + b.length, 0); const r = new Uint8Array(tot); let o = 0; for (const b of out) { r.set(b, o); o += b.length; } return r;
}
