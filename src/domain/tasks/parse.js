// Deterministic task/project parsing extracted from src/daily.js (R0.7b).
// Pure and side-effect free: no network, no D1, no logs.
import { normalizeText } from "../reminders/time.js";

// Phase 2-g: colloquial list routing for tasks and reminders (zero model
// calls). Grammar: [لیست|فهرست] SUBJECT [پروژه <name>] [رو|را] [show verb].
const LIST_SUBJECT_RE = /^(تسک|کار|یادآوری|ریمایندر)\s*(?:(های|ها)\s*(مو|من|یم|م)?|(هامو|هام))\s*/u;
const LIST_TAIL_RE = /^(?:(رو|را)\s+)?(نشان\s+بده|نشون\s+بده|نمایش\s+بده|بیار|بیاور|لیست\s+کنید|لیست\s+کن|لیست|چی\s+دارم|چه\s+دارم|چه\s+(?:\S+\s+){0,3}دارم)$/u;
// NOTE: no \b here — JavaScript \b is ASCII-only, so it never matches after
// a Persian word. The verb is followed by an explicit whitespace-or-end guard.
const LIST_PROJECT_RE = /(?:^|\s+)(?:(?:توی|تو|در|برای|بابت)\s+)?پروژه\s+(.+?)(?=\s+(?:رو|را|نشان\s+بده|نشون\s+بده|نمایش\s+بده|بیار|بیاور|لیست|چی|چه)(?:\s|$)|\s*$)/u;
export function parseListRequest(raw) {
  let s = String(raw ?? "").trim().replace(/[؟?!.،,]+$/u, "");
  s = s.replace(/^(?:لیست|فهرست)\s+/u, "");
  const subj = LIST_SUBJECT_RE.exec(s);
  if (!subj) return null;
  const intent = subj[1] === "تسک" || subj[1] === "کار" ? "task-list" : "reminder-list";
  const possessive = Boolean(subj[3] || subj[4]);
  let rest = s.slice(subj[0].length).trim();
  let projectName = null;
  const pm = LIST_PROJECT_RE.exec(rest);
  if (pm && pm[1].trim()) {
    projectName = pm[1].trim().replace(/[؟?!.،,]+$/u, "").trim();
    rest = `${rest.slice(0, pm.index)} ${rest.slice(pm.index + pm[0].length)}`.replace(/\s+/g, " ").trim();
  }
  if (rest === "") return possessive || projectName ? { intent, confidence: 1, projectName } : null;
  if (/^(رو|را)$/.test(rest)) return possessive || projectName ? { intent, confidence: 1, projectName } : null;
  if (LIST_TAIL_RE.test(rest)) return { intent, confidence: 1, projectName };
  return null;
}

// 1-d-2: explicit folder phrase at the START or END only.
// 1-d-6 middle form: a folder phrase between a leading keyword and the
// colon ("یادداشت توی پروژه گلبهار: ...") — body is phrase-stripped.
const FOLDER_START_RE = /^(?:توی|در|برای)\s+پروژه\s+([\s\S]+)$/u;
const FOLDER_END_RE = /^([\s\S]+?)\s+(?:توی|در|برای)\s+پروژه\s+(.+?)\s*[؟?!.،,]*$/u;
const MIDDLE_KEYWORDS = "یادداشت کن|یادداشت|تسک جدید|تسک|یادآوری کن|یادآوری"; // longest first
const MIDDLE_TAG_RE = new RegExp(`^\\s*(?:(?:لطفا|لطفاً|ببین)\\s+)?(${MIDDLE_KEYWORDS})\\s+(?:توی|در|برای)\\s+پروژه(?:\\s+ی)?\\s+(.+?)\\s*[:：]\\s*([\\s\\S]+)$`, "ud");
function middleTagBody(keyword, rest) { const base = keyword === "یادآوری" || keyword === "یادآوری کن" ? "یادآوری کن" : keyword.split(" ")[0]; return base === "یادآوری کن" ? `${base} ${rest}` : `${base}: ${rest}`; }
export function stripMiddleFolderTag(text) {
  const raw = normalizeText(text ?? "");
  const m = MIDDLE_TAG_RE.exec(raw);
  if (!m) return null;
  const keyword = m[1], name = m[2].trim(), rest = m[3].trim();
  if (!name || !rest) return null;
  return { keyword, name, body: middleTagBody(keyword, rest), nameSpan: m.indices[2], restSpan: m.indices[3] };
}

// Phase 2-b Pillar B: known-project boundary matching. Aliases may be
// arrays or JSON strings (D1 stores aliases as JSON text). Pure and
// side-effect free; the caller supplies the real D1 rows.
const FOLDER_INTRO_RE = /(?:توی|تو|در|برای|بابت)\s+(?:پروژه(?:\s+ی(?=[\s:：؟?!.،,]|$))?|پوشه(?:\s+ی(?=[\s:：؟?!.،,]|$))?)\s*/gu;
const PROJECT_BOUNDARY_RE = /[\s؟?!.،,:：]/u;
function projectCandidates(projects) {
  const out = [];
  const push = (n) => {
    const v = normalizeText(n ?? "").trim();
    if (v && !out.includes(v)) out.push(v);
  };
  for (const p of projects ?? []) {
    if (typeof p === "string") { push(p); continue; }
    if (!p) continue;
    push(p.name);
    let aliases = p.aliases;
    if (typeof aliases === "string") { try { aliases = JSON.parse(aliases); } catch { aliases = []; } }
    if (Array.isArray(aliases)) for (const a of aliases) push(a);
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}
// Returns { name, rest } when `afterText` starts with a known project
// name/alias at that exact position (boundary-delimited), else null.
export function matchKnownProjectAt(afterText, projects) {
  const after = normalizeText(afterText ?? "");
  for (const c of projectCandidates(projects)) {
    if (after === c) return { name: c, rest: "" };
    if (after.startsWith(c)) {
      const next = after[c.length];
      if (next === undefined || PROJECT_BOUNDARY_RE.test(next)) {
        let rest = after.slice(c.length).replace(/^[\s:：]+/u, "");
        // A remainder of pure punctuation ("گلبهار.") is no remainder.
        if (/^[\s؟?!.،,:：]+$/u.test(rest)) rest = "";
        return { name: c, rest };
      }
    }
  }
  return null;
}
// Phase 2-b upgrade of the old "resolveProjectMatch": a raw candidate
// that still has trailing words resolves to the known project it starts
// with (longest first, boundary-delimited), or null.
export function resolveProjectName(rawCandidate, projects) {
  const hit = matchKnownProjectAt(rawCandidate, projects);
  return hit ? hit.name : null;
}
export function extractFolderTag(text, projects = null) {
  const raw = normalizeText(text);
  const orig = String(text ?? "");
  const s = FOLDER_START_RE.exec(raw);
  // normalisation is one-to-one, so raw spans map onto orig spans of the
  // same length: the start rest is the tail of orig, the end body is the
  // head of orig — ZWNJ survives in the returned body/rest.
  if (s) { const rest = orig.slice(orig.length - s[1].length).trim(); if (rest) return { at: "start", rest }; }
  // Middle before end: the end regex would otherwise swallow a middle tag
  // whole, which never resolves exactly.
  const mid = stripMiddleFolderTag(text);
  if (mid) {
    const name = orig.slice(mid.nameSpan[0], mid.nameSpan[1]).trim();
    const rest = orig.slice(mid.restSpan[0], mid.restSpan[1]).trim();
    if (name && rest) return { at: "middle", body: middleTagBody(mid.keyword, rest), name };
  }
  // Phase 2-b: known-name scan for mid-sentence phrases. Runs before the
  // end form so a trailing-word name never falls through to an exact-match
  // failure.
  if (Array.isArray(projects) && projects.length) {
    FOLDER_INTRO_RE.lastIndex = 0;
    let m;
    while ((m = FOLDER_INTRO_RE.exec(raw)) !== null) {
      const afterIdx = m.index + m[0].length;
      const hit = matchKnownProjectAt(raw.slice(afterIdx), projects);
      if (!hit) continue;
      // raw indices map 1:1 onto orig (see the comment above).
      const restClean = orig.slice(afterIdx + hit.name.length).replace(/^[\s:：]+/u, "").trim();
      const before = orig.slice(0, m.index).trim();
      const clean = /^[\s؟?!.،,:：]+$/u.test(restClean) ? "" : restClean;
      const body = before ? (clean ? `${before} ${clean}` : before) : clean;
      if (body) return { at: "known", name: hit.name, body };
    }
  }
  const e = FOLDER_END_RE.exec(raw);
  if (e) { const body = orig.slice(0, e[1].length).trim(); const name = e[2].trim(); if (body && name) return { at: "end", body, name }; }
  return null;
}
