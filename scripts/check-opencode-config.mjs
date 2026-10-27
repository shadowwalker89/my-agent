// Offline check: opencode.json is valid, has provider "my-agent", and keeps
// the protected-path deny rules in place. Wired into `npm run check`.
import fs from "node:fs";

const raw = fs.readFileSync("opencode.json", "utf8");
let cfg;
try {
  cfg = JSON.parse(raw);
} catch (err) {
  console.error(`opencode.json is not valid JSON: ${err && err.message}`);
  process.exit(1);
}

if (!cfg || typeof cfg !== "object" || !cfg.provider || !cfg.provider["my-agent"]) {
  console.error('opencode.json must define provider "my-agent"');
  process.exit(1);
}

const perm = (cfg.permission && typeof cfg.permission === "object") ? cfg.permission : {};
const edit = (perm.edit && typeof perm.edit === "object") ? perm.edit : {};
const read = (perm.read && typeof perm.read === "object") ? perm.read : {};

const editDeny = Object.entries(edit).filter(([, v]) => v === "deny").map(([k]) => k);
const readDeny = Object.entries(read).filter(([, v]) => v === "deny").map(([k]) => k);

function covered(denyKeys, path) {
  return denyKeys.includes(path) || denyKeys.includes(`**/${path}`) || denyKeys.includes(`**/${path}`.replace(/\/\*\*$/, ""));
}

const requiredEditDenies = [
  ".github/**",
  "opencode.json",
  "wrangler.toml",
  "wrangler.jsonc",
  "wrangler.json",
  ".dev.vars",
  ".env",
  ".env.*",
  "package-lock.json",
];

const requiredReadDenies = [".dev.vars", ".env", ".env.*"];

for (const p of requiredEditDenies) {
  if (!covered(editDeny, p)) {
    console.error(`opencode.json permission.edit is missing deny for: ${p}`);
    process.exit(1);
  }
}
for (const p of requiredReadDenies) {
  if (!covered(readDeny, p)) {
    console.error(`opencode.json permission.read is missing deny for: ${p}`);
    process.exit(1);
  }
}

console.log("opencode.json config check: ok");
