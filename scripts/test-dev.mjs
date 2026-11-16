// Offline pipeline test orchestrator (R0.3 split).
// Run: node scripts/test-dev.mjs
process.env.REQUIRE_SQLITE = "1";

import { readdir } from "node:fs/promises";

const { failures, getChecks } = await import("./tests/harness.mjs");

const expectedSuites = [
  { id: "01-dev-admin", path: "./tests/01-dev-admin.test.mjs" },
  { id: "02-d1-memory-daily", path: "./tests/02-d1-memory-daily.test.mjs" },
  { id: "03-interpreter-router", path: "./tests/03-interpreter-router.test.mjs" },
  { id: "04-tasks-projects-reminders", path: "./tests/04-tasks-projects-reminders.test.mjs" },
  { id: "05-hotfix-vault", path: "./tests/05-hotfix-vault.test.mjs" },
  { id: "06-memory-graph-media", path: "./tests/06-memory-graph-media.test.mjs" },
  { id: "07-channel-telegram", path: "./tests/07-channel-telegram.test.mjs" },
  { id: "08-platform-scheduler", path: "./tests/08-platform-scheduler.test.mjs" },
  { id: "09-pipeline", path: "./tests/09-pipeline.test.mjs" },
  { id: "10-domain-reminders", path: "./tests/10-domain-reminders.test.mjs" },
  { id: "11-domain-tasks", path: "./tests/11-domain-tasks.test.mjs" },
  { id: "12-domain-notes", path: "./tests/12-domain-notes.test.mjs" },
  { id: "13-domain-expenses", path: "./tests/13-domain-expenses.test.mjs" },
  { id: "14-platform-vault", path: "./tests/14-platform-vault.test.mjs" },
  { id: "15-skills-media-pdf", path: "./tests/15-skills-media-pdf.test.mjs" },
  { id: "16-pipeline-branches", path: "./tests/16-pipeline-branches.test.mjs" },
];

const plannedIds = expectedSuites.map((suite) => suite.id);
const plannedPaths = expectedSuites.map((suite) => suite.path);
const duplicateIds = plannedIds.filter((id, index) => plannedIds.indexOf(id) !== index);
const duplicatePaths = plannedPaths.filter((path, index) => plannedPaths.indexOf(path) !== index);
if (expectedSuites.length !== 16 || duplicateIds.length || duplicatePaths.length) {
  console.error("Invalid suite plan: expected 16 unique suite ids and paths.");
  if (duplicateIds.length) console.error("  duplicated ids: " + [...new Set(duplicateIds)].join(", "));
  if (duplicatePaths.length) console.error("  duplicated paths: " + [...new Set(duplicatePaths)].join(", "));
  process.exit(1);
}

const availableSuitePaths = (await readdir(new URL("./tests/", import.meta.url)))
  .filter((path) => /^\d{2}-.+\.test\.mjs$/.test(path))
  .map((path) => "./tests/" + path)
  .sort();
const plannedSuitePaths = [...plannedPaths].sort();
const omittedPaths = availableSuitePaths.filter((path) => !plannedSuitePaths.includes(path));
const unavailablePaths = plannedSuitePaths.filter((path) => !availableSuitePaths.includes(path));
if (omittedPaths.length || unavailablePaths.length) {
  console.error("Suite manifest does not match available numbered test suites.");
  if (omittedPaths.length) console.error("  omitted from plan: " + omittedPaths.join(", "));
  if (unavailablePaths.length) console.error("  unavailable: " + unavailablePaths.join(", "));
  process.exit(1);
}

for (const suite of expectedSuites) {
  const checksBefore = getChecks();
  const mod = await import(suite.path);
  await mod.run();
  const checkDelta = getChecks() - checksBefore;
  console.log(`suite=${suite.id} checks=${checkDelta}`);
  if (checkDelta === 0) {
    console.error(`Suite ${suite.id} completed without producing any checks.`);
    process.exit(1);
  }
}

const runtimeChecks = getChecks();
console.log("checks=" + runtimeChecks);
let failed = false;
if (failures.length) {
  console.error("\nFailures found:");
  for (const f of failures) console.error("  - " + f);
  failed = true;
}
if (failed) process.exit(1);
