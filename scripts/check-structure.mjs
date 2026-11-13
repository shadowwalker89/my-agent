// Structure lint: enforce AGENTS.md §7.
// - No module under src/ over 300 lines unless it is a recorded legacy file.
// - A legacy file may only shrink; growing past its recorded line count fails.
//
// The baseline lives in scripts/legacy-sizes.json and is regenerated with:
//   node scripts/check-structure.mjs --write
// Run --write only when intentionally accepting the current state (e.g. the
// initial adoption or after a legacy file has shrunk).
import fs from "node:fs";
import path from "node:path";

const MAX_LINES = 300;
const SRC_DIR = path.resolve("src");
const LEGACY_FILE = path.resolve("scripts", "legacy-sizes.json");
const WRITE = process.argv.includes("--write");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(js|mjs)$/.test(entry.name) ? [full] : [];
  });
}

function rel(file) {
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

function countLines(file) {
  const text = fs.readFileSync(file, "utf8");
  if (text.length === 0) return 0;
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

function readLegacy() {
  if (!fs.existsSync(LEGACY_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LEGACY_FILE, "utf8"));
  } catch (err) {
    console.error(`Cannot parse ${rel(LEGACY_FILE)}: ${err.message}`);
    process.exit(2);
  }
}

function writeLegacy(entries) {
  const sorted = {};
  for (const key of Object.keys(entries).sort()) sorted[key] = entries[key];
  fs.writeFileSync(LEGACY_FILE, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
  console.log(`Wrote ${Object.keys(sorted).length} legacy entr(ies) to ${rel(LEGACY_FILE)}.`);
}

if (!fs.existsSync(SRC_DIR)) {
  console.error("src/ not found; run this script from the repository root.");
  process.exit(2);
}

const files = walk(SRC_DIR).sort();
const sizes = new Map(files.map((file) => [rel(file), countLines(file)]));
const legacy = readLegacy();

if (WRITE) {
  const next = {};
  for (const [file, lines] of sizes) {
    if (legacy[file] !== undefined || lines > MAX_LINES) next[file] = lines;
  }
  writeLegacy(next);
  process.exit(0);
}

if (!fs.existsSync(LEGACY_FILE)) {
  console.error(`Missing ${rel(LEGACY_FILE)}. Generate it with: node scripts/check-structure.mjs --write`);
  process.exit(2);
}

const violations = [];
for (const [file, lines] of sizes) {
  const recorded = legacy[file];
  if (recorded !== undefined) {
    if (lines > recorded) {
      violations.push({ file, lines, limit: recorded, reason: `legacy file grew (recorded ${recorded})` });
    }
  } else if (lines > MAX_LINES) {
    violations.push({ file, lines, limit: MAX_LINES, reason: "not in legacy allowlist and over 300 lines" });
  }
}

for (const file of Object.keys(legacy).sort()) {
  if (!sizes.has(file)) {
    console.warn(`warning: stale legacy entry for missing file ${file}`);
  }
}

if (violations.length > 0) {
  const fileWidth = Math.max(4, ...violations.map((v) => v.file.length));
  const lineWidth = Math.max(5, ...violations.map((v) => String(v.lines).length));
  console.error("\nStructure violations:\n");
  console.error(
    `${"FILE".padEnd(fileWidth)}  ${"LINES".padStart(lineWidth)}  ${"LIMIT".padStart(lineWidth)}  REASON`
  );
  console.error(
    `${"-".repeat(fileWidth)}  ${"-".repeat(lineWidth)}  ${"-".repeat(lineWidth)}  ${"-".repeat(20)}`
  );
  for (const v of violations) {
    console.error(
      `${v.file.padEnd(fileWidth)}  ${String(v.lines).padStart(lineWidth)}  ${String(v.limit).padStart(lineWidth)}  ${v.reason}`
    );
  }
  console.error(`\n${violations.length} violation(s). Legacy files may only shrink; new files must stay at or below ${MAX_LINES} lines.`);
  process.exit(1);
}

const legacyCount = Object.keys(legacy).filter((file) => sizes.has(file)).length;
console.log(`Structure OK: ${sizes.size} file(s) checked, ${legacyCount} legacy exception(s).`);
