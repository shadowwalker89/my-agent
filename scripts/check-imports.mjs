// Offline import check: every module under src/ must load in Node without
// throwing, and layered modules may only import downward.
// Catches syntax/runtime errors that `node --check` misses (e.g.
// invalid regex literals that are only evaluated at runtime) plus
// AGENTS.md §4 import-direction violations.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Minimal stub for a Cloudflare-Workers-only global that a module might touch
// at import time. Keep this tiny and documented; do not add real behaviour.
if (typeof globalThis.caches === "undefined") {
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
}

const RANKS = { channels: 1, ingress: 2, pipeline: 3, domain: 4, skills: 4, platform: 5, admin: 2 };
const root = path.resolve("src");
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(js|mjs)$/.test(e.name) ? [p] : [];
  });
}
function rel(file) {
  return path.relative(root, file).split(path.sep).join("/");
}
function layerRank(relPath) {
  return RANKS[relPath.split("/")[0]] ?? null;
}
function specifiers(text) {
  const out = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*["']([^"']+)["']/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) out.push(m[1]);
  }
  return out;
}

const files = walk(root).sort();
let failed = 0;
for (const file of files) {
  const relPath = rel(file);
  try {
    await import(pathToFileURL(file).href);
    console.log(`✓ ${path.relative(process.cwd(), file).split(path.sep).join("/")}`);
  } catch (err) {
    failed += 1;
    console.log(`✗ ${path.relative(process.cwd(), file).split(path.sep).join("/")}: ${err && err.message}`);
  }
  const sourceRank = layerRank(relPath);
  if (sourceRank === null) continue;
  for (const spec of specifiers(fs.readFileSync(file, "utf8"))) {
    if (!spec.startsWith(".")) continue;
    const targetRank = layerRank(rel(path.resolve(path.dirname(file), spec)));
    if (targetRank !== null && targetRank < sourceRank) {
      failed += 1;
      console.error(`✗ ${relPath}: upward import "${spec}" violates layer direction (rank ${sourceRank} → ${targetRank})`);
    }
  }
}

if (failed) {
  console.error(`\n${failed} module(s) failed import or layer direction check.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} modules imported successfully; layer direction OK.`);
