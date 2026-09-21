/**
 * The Drizzle schema, split by module and re-exported here (CLAUDE.md,
 * Conventions): `db/<module>.ts` owns its tables, `db/schema.ts` is the one
 * import every query and `drizzle-kit generate` read.
 *
 * See docs/spec/05-architecture.md §5.3 and PLAN-MVP §3. UTC everywhere
 * (timestamptz), uuid primary keys generated application-side, UNIQUE
 * constraints as the idempotency mechanism.
 */
export * from "./auth.js";
export * from "./org.js";
export * from "./pool.js";
export * from "./evaluation.js";
export * from "./live.js";
export * from "./grading.js";
export * from "./notifications.js";
