// CLI for the opencode-dev path guard.
// Usage: node scripts/guard-check.mjs <path-to-file-list>
// Exits 1 when any path is protected; prints only a count (never file contents).
import { readFileSync } from "node:fs";
import { isProtectedPath } from "../src/guard.js";

const file = process.argv[2];
const text = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
const files = text
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);
const blocked = files.filter(isProtectedPath);

if (blocked.length) {
  console.error(`protected paths found: ${blocked.length}`);
  process.exit(1);
}
