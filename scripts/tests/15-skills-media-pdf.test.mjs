// R0.7f: skills media + pdf extraction smoke + canary.
import { check } from "./harness.mjs";
import * as media from "../../src/skills/media/index.js";
import * as pdf from "../../src/skills/pdf/index.js";
import * as mediaShim from "../../src/media.js";
import * as pdfShim from "../../src/pdf.js";
import * as voiceShim from "../../src/voice.js";

export async function run() {
  check(typeof media.parseImageGenCommand === "function", "R0.7f: parseImageGenCommand exported");
  const p = media.parseImageGenCommand("یه عکس از کوه دماوند در شب بساز");
  check(p.isImageGen === true && p.prompt === "کوه دماوند در شب", "R0.7f: image gen parse");
  check(typeof media.generateFreeImage === "function", "R0.7f: generateFreeImage exported");
  check(typeof media.analyzeImage === "function", "R0.7f: analyzeImage exported");
  check(typeof media.editImage === "function", "R0.7f: editImage exported");
  check(typeof media.bytesToBase64 === "function", "R0.7f: bytesToBase64 exported");
  check(typeof pdf.extractTextFromPdfBytes === "function", "R0.7f: extractTextFromPdfBytes exported");
  check(typeof pdf.fixVisualRtlPersian === "function", "R0.7f: fixVisualRtlPersian exported");
  check(pdf.fixVisualRtlPersian("راضحتسا تهج ناریا تارباخم") === "مخابرات ایران جهت استحضار", "R0.7f: visual RTL");
  check(typeof pdf.analyzePdfDocument === "function", "R0.7f: analyzePdfDocument exported");
  check(typeof pdf.buildImageToPdfBytes === "function", "R0.7f: buildImageToPdfBytes exported");
  check(typeof voiceShim.handleVoice === "function", "R0.7f: voice shim handleVoice");
  check(typeof media.VOICE_FAILED_TEXT === "string", "R0.7f: voice constants exported");
  // shims re-export
  check(mediaShim.parseImageGenCommand === media.parseImageGenCommand, "R0.7f: media shim re-exports");
  check(pdfShim.fixVisualRtlPersian === pdf.fixVisualRtlPersian, "R0.7f: pdf shim re-exports");
  // canary: no secret in logs
  const prev = console.log;
  let logged = "";
  console.log = (x) => { logged += String(x); };
  try { await media.bytesToBase64(new Uint8Array([1,2,3])); } finally { console.log = prev; }
  check(!/secret|password/i.test(logged), "R0.7f: canary no secret in logs");
}
