// Offline pipeline test orchestrator (R0.3 split).
// Run: node scripts/test-dev.mjs
import { failures, getChecks } from "./tests/harness.mjs";

const suites = [
  "./tests/01-dev-admin.test.mjs",
  "./tests/02-d1-memory-daily.test.mjs",
  "./tests/03-interpreter-router.test.mjs",
  "./tests/04-tasks-projects-reminders.test.mjs",
  "./tests/05-hotfix-vault.test.mjs",
  "./tests/06-memory-graph-media.test.mjs",
];

for (const suite of suites) {
  const mod = await import(suite);
  await mod.run();
}

console.log("checks=" + getChecks());
if (failures.length) {
  console.error("\nFailures found:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
