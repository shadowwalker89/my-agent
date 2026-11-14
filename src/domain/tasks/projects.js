// Project resolution extracted from src/everyday.js (R0.7b).
// No channel/pipeline imports; D1 access goes through src/db.js.
import { listProjectsResult } from "../../db.js";
import { normalizeText } from "../reminders/time.js";
import { extractFolderTag, matchKnownProjectAt } from "./parse.js";

// Seed projects until migration 0003 lands (Phase 1-a swaps this constant
// for a D1 read). Never auto-create: unknown names get type buttons.
export const SEED_PROJECTS = [{ name: "عمومی", aliases: [] }, { name: "ایجنت", aliases: [] },
  { name: "گلبهار", aliases: ["گل"] }, { name: "قرارها و ملاقات‌ها", aliases: ["قرارها"] }];

export function parseAliasesText(raw) {
  try {
    const v = JSON.parse(typeof raw === "string" ? raw : "[]");
    return Array.isArray(v) ? v.filter((a) => typeof a === "string") : [];
  } catch { return []; }
}
// 1-d-4: shared name/alias resolution (used by renderNoteList and the
// summary branch, so the two never drift apart). Null when unresolved.
export function findProjectByName(projects, name) {
  const norm = normalizeText(name).trim();
  return (projects || []).filter((p) => p.id != null).find((p) => normalizeText(p.name).trim() === norm || parseAliasesText(p.aliases).some((a) => normalizeText(a).trim() === norm)) || null;
}
// Phase 1-b-0a (Fix A): resolve the user's projects from D1. Returns:
//   {ok: true, fallback: false, projects: [{id, name, aliases[], is_default}]}
//     on a D1 read with rows (aliases JSON parsed, malformed -> []);
//   {ok: true, fallback: true, projects: SEED_PROJECTS} on genuine
//     empty success (seed shape preserved, entries carry no D1 id);
//   {ok: false, projects: []} on a D1 failure — NO seed fallback.
export async function resolveProjects(env, userId) {
  const r = await listProjectsResult(env, userId);
  if (!r.ok) return { ok: false, projects: [] };
  if (r.projects.length === 0) return { ok: true, fallback: true, projects: SEED_PROJECTS };
  return {
    ok: true,
    fallback: false,
    projects: r.projects.map((p) => ({ id: p.id, name: p.name, aliases: parseAliasesText(p.aliases), is_default: p.is_default })),
  };
}

// 1-b-1 (decision 5): the rule note's default project — the D1 row with
// is_default = 1, else NULL. A project lookup never fails a note.
export async function defaultProjectId(env, userId) {
  const rp = await resolveProjects(env, userId);
  if (!rp.ok || rp.fallback) return null;
  return rp.projects.find((p) => p.is_default === 1)?.id ?? null;
}

// 1-d-2: resolve an explicit folder phrase against D1 active projects
// (real rows with ids only; a seed fallback has no id and is never
// attached). Returns { project, body } or null.
export async function resolveFolderTag(env, userId, fullText) {
  // Phase 2-b: load the real D1 projects FIRST and pass them into
  // extractFolderTag, so mid-sentence known names resolve with 0 model
  // calls. A seed fallback is never attached (pre-existing invariant).
  const rp = await listProjectsResult(env, userId);
  if (!rp.ok || rp.projects.length === 0) return null;
  const tag = extractFolderTag(fullText, rp.projects.map((p) => ({ name: p.name, aliases: parseAliasesText(p.aliases) })));
  if (!tag) return null;
  const cands = [];
  for (const p of rp.projects) {
    if (p.id == null) continue;
    cands.push({ name: normalizeText(p.name).trim(), project: p });
    for (const a of parseAliasesText(p.aliases)) cands.push({ name: normalizeText(a).trim(), project: p });
  }
  cands.sort((a, b) => b.name.length - a.name.length);
  // Phase 2-b known form: the name is already a known name/alias.
  if (tag.at === "known") {
    const hit = cands.find((c) => c.name && c.name === normalizeText(tag.name).trim());
    return hit ? { project: hit.project, body: tag.body } : null;
  }
  if (tag.at === "end") {
    const hit = cands.find((c) => c.name && c.name === normalizeText(tag.name).trim());
    if (hit) return { project: hit.project, body: tag.body };
    // Phase 2-b fallback (resolveProjectMatch upgrade): a raw candidate
    // that still has trailing words resolves to the known project it
    // starts with, and the trailing words rejoin the body.
    const prefix = matchKnownProjectAt(tag.name, cands.map((c) => c.name));
    if (prefix) {
      const pHit = cands.find((c) => c.name === prefix.name);
      if (pHit) return { project: pHit.project, body: prefix.rest ? `${tag.body} ${prefix.rest}` : tag.body };
    }
    return null;
  }
  // 1-d-6 middle form: the name is already colon-bounded.
  if (tag.at === "middle") {
    const hit = cands.find((c) => c.name && c.name === normalizeText(tag.name).trim());
    return hit ? { project: hit.project, body: tag.body } : null;
  }
  const rest = normalizeText(tag.rest).trim();
  const origRest = tag.rest.trim();
  for (const c of cands) {
    if (!c.name) continue;
    if (rest === c.name) return { project: c.project, body: "" };
    if (rest.startsWith(c.name)) {
      // Lengths agree (normalisation is one-to-one), so the original
      // remainder is sliced by the normalized name's length — ZWNJ survives.
      const after = origRest.slice(c.name.length);
      if (/^[\s:：]/.test(after)) return { project: c.project, body: after.replace(/^[\s:：]+/u, "").trim() };
    }
  }
  return null;
}
