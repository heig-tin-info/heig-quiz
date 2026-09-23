/**
 * THE single content exit toward a student (invariant 4, docs/05 §5.7).
 *
 * Nothing else in the API may build a payload a student receives. The route
 * that serves an attempt, the one that restores it, the teacher preview and
 * the dashboard inspector all come through {@link studentView}, so there is
 * exactly one place to audit and exactly one place the leak test has to
 * cover (`studentView.leak.test.ts`).
 *
 * Three things happen here, in this order:
 *   1. the stored config is read through the ONE pipeline of `pool/config.ts`
 *      (`loadConfig`), so it is migrated and parsed before anyone looks at it;
 *   2. `type.toStudent` produces the type-specific view, with the per-attempt
 *      shuffle derived from `hashSeed(seed, itemId, purpose)` (decision D19)
 *      — never stored, so a reload reproduces it exactly;
 *   3. the result is stripped of the keys the core knows are teacher-only.
 *      Step 3 is defence in depth: a type that respects its contract loses
 *      nothing to it, and a type that slips gains no reach.
 */
import { COMMON_FORBIDDEN_STUDENT_KEYS, type StudentView } from "@quiz/core/server";

import { loadConfig, typeOf } from "../pool/config.js";

/**
 * Keys a student payload may never carry, whatever produced it.
 *
 * The floor comes from `@quiz/core/server` and is shared with the five
 * per-type leak tests, so a key thought of in one place is enforced in all of
 * them (audit 2026-09-22, finding P-06). What follows is what this exit adds
 * on top: the names the STORAGE layer uses (`answerKey`, `configVersion`) and
 * the ones only some types have (`hiddenCases`, `matcher`, `regex`,
 * `solution`, `tolerance`, `isCorrect`).
 *
 * `expected` is deliberately ABSENT from both halves: `code` publishes the
 * expected output of its VISIBLE cases on purpose (docs/04 §4.7, deviation
 * W3-4). What must never travel is the hidden half, and that is covered by
 * the secret-value search of the leak test, which is the check that matters.
 *
 * `compare` is absent too, since audit R-06: `code` publishes its comparison
 * options so the player judges a visible case by the grade's own rule. They
 * say HOW an output is compared, never WHAT the answer is.
 */
export const FORBIDDEN_STUDENT_KEYS: readonly string[] = [
  ...COMMON_FORBIDDEN_STUDENT_KEYS,
  "answerKey",
  "configVersion",
  "hiddenCases",
  "isCorrect",
  "matcher",
  "regex",
  "solution",
  "tolerance",
];

const forbidden = new Set(FORBIDDEN_STUDENT_KEYS);

/**
 * Removes the teacher-only keys anywhere in the structure, returning a new
 * value. Arrays and plain objects are walked; everything else is returned
 * as-is, so a payload of scalars costs nothing.
 */
export function stripMetadata(value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => stripMetadata(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.has(key)) continue;
    out[key] = stripMetadata(child, depth + 1);
  }
  return out;
}

interface StudentViewInput {
  /** Registered question-type id, from `questions.type`. */
  type: string;
  /** The two columns of `question_versions` — never a hand-built object. */
  version: { config: unknown; configVersion: number };
  /** `attempts.seed`; 0 for the teacher preview, which is therefore stable. */
  seed: number;
  /** `evaluation_items.id`: the shuffle stream is per item, not per question. */
  itemId: string;
  /** `settings.shuffleChoices` AND the question's own `shuffleable` flag. */
  shuffle: boolean;
}

/**
 * The same exit, for a caller that already holds a PARSED config: the
 * teacher's question preview (`POST /questions/:id/preview`), which renders a
 * draft that has no evaluation and no attempt behind it. It goes through this
 * function rather than calling `toStudent` itself, so there stays exactly one
 * place where a student payload is built (invariant 4).
 */
export function studentViewOf(type: string, config: unknown, view: StudentView): unknown {
  return stripMetadata(typeOf(type).toStudent(config, view));
}

/** The student-facing payload of one item. The ONLY producer of one. */
export function studentView(input: StudentViewInput): unknown {
  return studentViewOf(input.type, loadConfig(input.type, input.version), {
    seed: input.seed,
    itemId: input.itemId,
    shuffle: input.shuffle,
  });
}

/**
 * The key, for the teacher's inspector and for the feedback policy. It is NOT
 * a student payload: never serve it on a student route without checking
 * `feedbackPolicy.showKey` first.
 */
export function solutionView(input: Omit<StudentViewInput, "shuffle"> & { shuffle?: boolean }): unknown {
  const type = typeOf(input.type);
  const config = loadConfig(input.type, input.version);
  return type.toSolution(config, {
    seed: input.seed,
    itemId: input.itemId,
    shuffle: input.shuffle ?? false,
  });
}

/** `type.shuffleable(config)`: whether shuffling means anything for this one. */
export function isShuffleable(type: string, version: { config: unknown; configVersion: number }): boolean {
  const t = typeOf(type);
  try {
    return t.shuffleable(loadConfig(type, version));
  } catch {
    return false;
  }
}
