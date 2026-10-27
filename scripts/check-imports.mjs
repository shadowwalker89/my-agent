// Offline import check: every module under src/ must load in Node without
// throwing. Catches syntax/runtime errors that `node --check` misses (e.g.
// invalid regex literals that are only evaluated at runtime).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Minimal stub for a Cloudflare-Workers-only global that a module might touch
// at import time. Keep this tiny and documented; do not add real behaviour.
if (typeof globalThis.caches === "undefined") {
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
}

const root = path.resolve("src");
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(js|mjs)$/.test(e.name) ? [p] : [];
  });
}

const files = walk(root).sort();
let failed = 0;
for (const file of files) {
  const rel = path.relative(process.cwd(), file);
  try {
    await import(pathToFileURL(file).href);
    console.log(`✓ ${rel}`);
  } catch (err) {
    failed += 1;
    console.log(`✗ ${rel}: ${err && err.message}`);
  }
}

if (failed) {
  console.error(`\n${failed} module(s) failed to import.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} modules imported successfully.`);
