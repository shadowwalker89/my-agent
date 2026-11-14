import { VISUAL_RTL_MARKER_RE, VISUAL_FINAL_FORM_RE, VISUAL_FORWARD_MARKER_RE, reverseVisualRtlLine, decodePdfLiteral, normalizePdfText } from "./pdf-helpers.js";

export function fixVisualRtlPersian(text) {
  const s = String(text ?? "");
  if (!s || !/[\u0600-\u06FF]/u.test(s)) return s;
  // Document-level detection: two or more visual-RTL markers anywhere (or
  // presentation-form glyphs from a pre-NFKC stream) mean the whole document
  // was laid out visually. Standalone name lines without a marker keyword
  // ("نایع‌راز دواد") must then be reversed too.
  const globalMarkerRe = new RegExp(VISUAL_RTL_MARKER_RE.source, "gu");
  const markerCount = (s.match(globalMarkerRe) || []).length;
  const isDocumentVisualRtl = markerCount >= 2 || VISUAL_FINAL_FORM_RE.test(s);
  return s
    .split("\n")
    .map((line) => {
      if (!/[\u0600-\u06FF]/u.test(line)) return line;
      if (VISUAL_FORWARD_MARKER_RE.test(line)) return line;
      if (!isDocumentVisualRtl && !VISUAL_RTL_MARKER_RE.test(line) && !VISUAL_FINAL_FORM_RE.test(line)) return line;
      return reverseVisualRtlLine(line);
    })
    .join("\n");
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
  return normalizePdfText(out);
}
const PDF_JUNK_TOKEN = /^(?:obj|endobj|stream|endstream|FlateDecode|BitsPerComponent|xref|trailer|startxref|BT|ET|Tj|TJ|Tf|Td|TD|Tm|T\*|cm|rg|RG|q|Q)$/;
function cleanText(s) {
  const t = normalizePdfText(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();
  if (!t || PDF_JUNK_TOKEN.test(t)) return "";
  return t;
}
export function readableCount(s) { return (String(s || "").match(/[A-Za-z0-9\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length; }
function bestDecode(cmaps, fn) {
  let best = ""; let bestScore = -1;
  for (const mp of cmaps) {
    const t = fn(mp);
    const sc = readableCount(t);
    if (sc > bestScore) { bestScore = sc; best = t; }
  }
  return best;
}
function appendText(line, text, addSpace) {
  const t = String(text || "");
  if (!t) return line;
  if (!line) return t;
  if (!addSpace) return line + t;
  if (/^\s/.test(t) || /\s$/.test(line)) return line + t;
  return line + " " + t;
}
// TJ arrays use negative numeric offsets as kerning: <-350 is a table column
// gap, <-80 is a word gap. Turning them into separators keeps Net/VAT/total
// columns from gluing together.
function decodeTJArray(inner, currentMap, cmaps) {
  const src = String(inner || "");
  const re = /\(((?:[^()\\]|\\.)*)\)|<([0-9A-Fa-f\s]+)>|(-?\d+(?:\.\d+)?)/g;
  let out = "";
  let sep = "";
  let m;
  while ((m = re.exec(src))) {
    let text = "";
    if (m[1] != null) text = cleanText(decodePdfLiteral(m[1]));
    else if (m[2] != null) text = currentMap ? decodeHexGlyphs(m[2], currentMap) : (cmaps && cmaps.length ? bestDecode(cmaps, (mp) => decodeHexGlyphs(m[2], mp)) : decodeHexGlyphs(m[2], null));
    else if (m[3] != null) {
      const n = Number(m[3]);
      if (Number.isFinite(n) && n < -80) sep = n < -350 ? "  |  " : " ";
      continue;
    }
    if (!text) continue;
    if (sep && out) out = out.replace(/[ \t]+$/, "") + sep;
    out += text;
    sep = "";
  }
  return out;
}
export function extractContentText(content, cmaps, fontResolver) {
  const src = String(content || "");
  const segments = [];
  for (const seg of src.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) segments.push(seg[1]);
  if (!segments.length) return "";
  const list = (Array.isArray(cmaps) ? cmaps : (cmaps ? [cmaps] : [])).filter(Boolean);
  const resolve = (name) => { try { return fontResolver ? fontResolver(name) : null; } catch { return null; } };
  const parts = [];
  for (const seg of segments) {
    let currentMap = null;
    let line = "";
    let lastKind = "";
    const re = /\/([A-Za-z0-9_.+-]+)\s+[-\d.]+\s+Tf|\[((?:[^\[\]\\]|\\.)*)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*Tj|(T\*|Td|TD)|<(?![<])([0-9A-Fa-f\s]+)>|\(((?:[^()\\]|\\.)*)\)/g;
    let m;
    while ((m = re.exec(seg))) {
      if (m[1] != null) { currentMap = resolve(m[1]); continue; }
      if (m[2] != null) { const t = decodeTJArray(m[2], currentMap, list); if (t) { line = appendText(line, t, true); lastKind = "tj"; } continue; }
      if (m[3] != null) { const t = cleanText(decodePdfLiteral(m[3])); if (t) { line = appendText(line, t, true); lastKind = "lit"; } continue; }
      if (m[4] != null) { if (line && !/\s$/.test(line)) line += " "; lastKind = ""; continue; }
      if (m[5] != null) { const t = currentMap ? decodeHexGlyphs(m[5], currentMap) : (list.length ? bestDecode(list, (mp) => decodeHexGlyphs(m[5], mp)) : decodeHexGlyphs(m[5], null)); if (t) { line = appendText(line, cleanText(t), lastKind !== "hex"); lastKind = "hex"; } continue; }
      if (m[6] != null) { const t = cleanText(decodePdfLiteral(m[6])); if (t) { line = appendText(line, t, true); lastKind = "lit"; } continue; }
    }
    if (line.trim()) parts.push(line.trim());
  }
  if (!parts.length) return "";
  return parts.join("\n").replace(/[ \t]+/g, " ").replace(/\s*\|\s*/g, "  |  ").replace(/\s*\n\s*/g, "\n").trim();
}
export function uniqText(toks) {
  const seen = new Set();
  const uniq = toks.filter((t) => { const k = String(t).toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  return normalizePdfText(uniq.join("\n")).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 12000);
}
export async function inflateBytes(bytes, format, timeoutMs = 3000) {
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
