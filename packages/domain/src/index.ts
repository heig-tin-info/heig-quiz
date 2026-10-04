/**
 * `@quiz/domain` — the pure business rules (invariant 8).
 *
 * No database, no HTTP, no `Date.now()`: every function is total, deterministic
 * and unit-tested, and the current instant is always injected by the caller.
 */
export * from "./activity.js";
export * from "./batchable.js";
export * from "./calculator.js";
export * from "./categorizeScore.js";
export { extractScore, SCORE_ANNOTATION_TITLE, type AnnotationLike, type ScoreParse } from "./ciScore.js";
export * from "./cloze.js";
export * from "./compareOutput.js";
export * from "./cooldown.js";
export * from "./correction.js";
export * from "./courseRole.js";
export * from "./dayBucket.js";
export * from "./debrief.js";
export * from "./deadline.js";
export * from "./drillEligibility.js";
export * from "./drillProgress.js";
export * from "./drillRating.js";
export * from "./drillSession.js";
export * from "./evaluationConfig.js";
export * from "./finalScore.js";
export * from "./format.js";
export * from "./grade.js";
export * from "./groupRepo.js";
export * from "./health.js";
export * from "./healthAlert.js";
export * from "./identityMatch.js";
export * from "./ipAllowlist.js";
export * from "./itemList.js";
export * from "./kioskAttestation.js";
export * from "./kioskPairing.js";
export * from "./llm.js";
export * from "./maskNames.js";
export * from "./review.js";
export * from "./lockedTemplate.js";
export * from "./mcqScore.js";
// The mathjs-free vocabulary of parameterized questions (ADR-056).
export {
  FORMAT_PATTERN,
  FORMATS,
  formatStep,
  type FormatKind,
  GROUPED_BY_CHOICE,
  IDENTIFIER_SOURCE,
  isFormat,
  isVariableName,
  matchReference,
  referenceSpans,
  MAX_EXPRESSION_LENGTH,
  PARAMETERIZED_TYPES,
  parseFormat,
  writeFormat,
  type Format,
} from "./parameterNames.js";
// Which `[[name]]` a draft's texts hold, read without mathjs (ADR-056, addendum of 2026-10-01).
export { identifiersIn, namesMentioned, referencedNames } from "./parameters/references.js";
export * from "./period.js";
export * from "./pollOutcome.js";
export * from "./pollTally.js";
export * from "./poolRole.js";
export * from "./projectGrade.js";
export * from "./projectAccept.js";
export * from "./projectRuns.js";
export * from "./projectPatch.js";
export * from "./projectView.js";
export * from "./pseudonym.js";
export * from "./questionProgress.js";
export * from "./repoName.js";
export * from "./retake.js";
export * from "./reviewDispatch.js";
export * from "./roster.js";
export * from "./round.js";
export * from "./short.js";
export * from "./studentIgnore.js";
export * from "./stats.js";
export * from "./templatePull.js";
export * from "./zone.js";
// `./drillSchedule.js` is NOT re-exported: it pulls `ts-fsrs`, which the web
// bundle would then carry. The server imports `@quiz/domain/drillSchedule`.
// `./parameters.js` is NOT re-exported either, for the same reason: it pulls
// mathjs (ADR-056 §2). The server imports `@quiz/domain/parameters`; only its
// mathjs-free vocabulary, `./parameterNames.js`, is above.

/**
 * The seeded shuffle lives in `@quiz/core/rng` (the question types need it
 * without depending on the domain) and is re-exported here so that a rule and
 * its randomness come from one import (PLAN-MVP §7.5).
 */
export { hashSeed, pick, rng, shuffle, streamSeed } from "@quiz/core/rng";
