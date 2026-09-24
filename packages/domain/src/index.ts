/**
 * `@quiz/domain` — the pure business rules (invariant 8).
 *
 * No database, no HTTP, no `Date.now()`: every function is total, deterministic
 * and unit-tested, and the current instant is always injected by the caller.
 */
export * from "./cloze.js";
export * from "./compareOutput.js";
export * from "./deadline.js";
export * from "./format.js";
export * from "./grade.js";
export * from "./itemList.js";
export * from "./lockedTemplate.js";
export * from "./mcqScore.js";
export * from "./pollTally.js";
export * from "./poolRole.js";
export * from "./pseudonym.js";
export * from "./roster.js";
export * from "./round.js";
export * from "./short.js";
export * from "./stats.js";

/**
 * The seeded shuffle lives in `@quiz/core/rng` (the question types need it
 * without depending on the domain) and is re-exported here so that a rule and
 * its randomness come from one import (PLAN-MVP §7.5).
 */
export { hashSeed, pick, rng, seededShuffle, shuffle, streamSeed } from "@quiz/core/rng";
