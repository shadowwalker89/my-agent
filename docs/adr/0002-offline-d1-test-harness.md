# ADR 0002 — Offline D1 test harness with node:sqlite

- Status: Accepted
- Date: 2026-11-13
- Deciders: owner
- Related: `docs/contract-v3.md` §8 R0.2, §7.1; `AGENTS.md` §6, §7

## Context

R0.2 needs a safety net that runs on every offline check without network access,
without new dependencies, and without touching `src/`. The previous D1 tests in
`scripts/test-dev.mjs` already use Node's built-in `node:sqlite` as an in-memory
D1-compatible adapter, but R0.2 also needs to prove that the real migration SQL
creates the T0 schema and that core tables round-trip.

The contract names `@cloudflare/vitest-pool-workers` as the target for real
workerd/D1 tests. That package brings a large dependency tree, a workerd binary,
and sandbox/CI setup that is disproportionate for R0.2. Its value is testing
Worker runtime bindings, which is a different concern from migration and parser
correctness.

Options considered:

1. Add `@cloudflare/vitest-pool-workers` now. Rejected for R0.2: dependency cost,
   sandbox friction, and no immediate coverage gain for deterministic parsers or
   plain SQL migrations.
2. Mock D1 with JavaScript objects. Rejected: does not execute migration SQL and
   would miss schema/column errors.
3. Use Node's built-in `node:sqlite` with the real migration files. Chosen.

## Decision

For R0.2, test D1 schema and T0 round-trips offline with zero dependencies by
running `migrations/0001_init.sql`–`0003_tasks_projects.sql` against an in-memory
`node:sqlite` database in `scripts/test-golden.mjs`. Keep
`@cloudflare/vitest-pool-workers` optional and deferred; adopt it when the tests
need actual workerd bindings, not for plain SQL coverage.

## Consequences

- `npm run test:offline` now includes `node scripts/test-golden.mjs`, which runs
  the golden Persian cases, deterministic parsers, and the migration smoke test.
- The offline suite requires Node 22+ (`node:sqlite`); older Node fails with a
  clear message instead of silently skipping the migration check.
- Migration SQL is exercised exactly as written, so column additions and table
  shapes are verified without a D1 emulator.
- Worker bindings, CPU limits, cron behaviour, and workerd-specific runtime
  semantics remain untested offline. Those stay on the R0.2 follow-up list for
  `@cloudflare/vitest-pool-workers` or a workerd runner.
- No new dependency is added and no file under `src/` changes.

## Status

Accepted for R0.2. Revisit when workerd/D1 binding tests become required.
