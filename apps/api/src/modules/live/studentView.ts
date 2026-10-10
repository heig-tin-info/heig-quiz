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
import {
  ANSWER_COORDINATES,
  issuesOf,
  NOT_ZOD_ISSUE,
  type AnswerCoordinates,
  type ZodIssueLite,
} from "@quiz/contracts";
import { COMMON_FORBIDDEN_STUDENT_KEYS, type StudentView } from "@quiz/core/server";

import { loadConfig, typeOf, type StaticVersion } from "../pool/config.js";

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
 * Removes the `forbidden` keys anywhere in the structure, returning a new
 * value. Arrays and plain objects are walked, twelve levels deep; everything
 * else is returned as-is, so a payload of scalars costs nothing.
 *
 * `keep(object, key)` spares one forbidden key of one object — the single
 * exception the feedback strip needs (`results/service.ts`). The two callers
 * keep their own key LIST, which is the auditable surface; this is the walk.
 */
export function stripKeys(
  value: unknown,
  keys: ReadonlySet<string>,
  keep?: (object: Record<string, unknown>, key: string) => boolean,
  depth = 0,
): unknown {
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => stripKeys(v, keys, keep, depth + 1));
  const object = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(object)) {
    if (keys.has(key) && !keep?.(object, key)) continue;
    out[key] = stripKeys(child, keys, keep, depth + 1);
  }
  return out;
}

/** Removes the teacher-only keys ({@link FORBIDDEN_STUDENT_KEYS}) anywhere in the structure. */
export function stripMetadata(value: unknown): unknown {
  return stripKeys(value, forbidden);
}

interface StudentViewInput {
  /** Registered question-type id, from `questions.type`. */
  type: string;
  /**
   * A STATIC version: the `version` of an instance (`pool/instance.ts`,
   * ADR-056), which is the stored row itself for a static question. A
   * stored row is not a `StaticVersion`, so handing a template here does not
   * compile; `loadConfig` refuses one at run time as well. A formula or a
   * variable name cannot reach this exit.
   */
  version: StaticVersion;
  /** `attempts.seed`; 0 for the teacher preview, which is therefore stable. */
  seed: number;
  /** `evaluation_items.id`: the shuffle stream is per item, not per question. */
  itemId: string;
  /** Whether the choices are shuffled: on the student path, `attemptItemView` decides (ADR-097). */
  shuffle: boolean;
  /**
   * The evaluation's per-type settings (`gradeDefaults`), for a view built
   * for one: a type publishes from it only what a student must know before
   * answering — the negative marking of `mcq` and `categorize` (ADR-026,
   * ADR-036).
   */
  defaults?: Readonly<Record<string, unknown>>;
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

/**
 * The view of a teacher's preview of one question: seed 0 and no shuffle, so
 * the same view on every open (decision D19) — and the key of the same view.
 */
export const teacherPreviewView = (itemId: string): StudentView => ({ seed: 0, itemId, shuffle: false });

/** The student-facing payload of one item. The ONLY producer of one. */
export function studentView(input: StudentViewInput): unknown {
  return studentViewOf(input.type, loadConfig(input.type, input.version), {
    seed: input.seed,
    itemId: input.itemId,
    shuffle: input.shuffle,
    ...(input.defaults === undefined ? {} : { defaults: input.defaults }),
  });
}

/**
 * The key, WHOLE, for the teacher's surfaces (grading panel, dashboard
 * inspector, results by question). It is NOT a student payload: a student
 * route serves {@link studentSolutionView}, and only once
 * `feedbackPolicy.showKey` allows it.
 */
export function solutionView(input: Omit<StudentViewInput, "shuffle"> & { shuffle?: boolean }): unknown {
  return solutionViewOf(input.type, loadConfig(input.type, input.version), {
    seed: input.seed,
    itemId: input.itemId,
    shuffle: input.shuffle ?? false,
  });
}

/**
 * {@link solutionView} for a caller that already holds the PARSED config: the
 * grading panel, which parses each item once and shows it for every attempt.
 */
export function solutionViewOf(type: string, config: unknown, view: StudentView): unknown {
  return typeOf(type).toSolution(config, view);
}

/**
 * THE single exit of a key toward a student (ADR-037): the solution passed
 * through the type's `studentSolution` hook, which drops from the solution
 * what stays the teacher's even under a shown key — an essay's grading
 * criteria, a short answer's `llm` rubric. `null` when nothing is left.
 *
 * Every student-facing reader of a key comes through here: the feedback
 * page (and a teacher acting as a student, ADR-034), a poll's reveal, and the
 * teacher's previews "as a student" (ADR-018, and the "Show answers" of a
 * question's preview). It does NOT check the policy:
 * the caller serves it only when `showKey` holds.
 */
export function studentSolutionView(
  input: Omit<StudentViewInput, "shuffle"> & { shuffle?: boolean },
): unknown {
  return studentSolutionViewOf(input.type, loadConfig(input.type, input.version), {
    seed: input.seed,
    itemId: input.itemId,
    shuffle: input.shuffle ?? false,
  });
}

/** {@link studentSolutionView} for a caller that already holds the PARSED config. */
export function studentSolutionViewOf(type: string, config: unknown, view: StudentView): unknown {
  const t = typeOf(type);
  const solution = t.toSolution(config, view);
  return t.studentSolution ? t.studentSolution(solution, config) : solution;
}

/** An answer a student sent, read: canonical, or the reasons it is refused (`422 answer_invalid`). */
export type AnswerEntry = { answer: unknown } | { issues: ZodIssueLite[] };

const refused = (message: string): AnswerEntry => ({ issues: [{ path: [], code: NOT_ZOD_ISSUE, message }] });

/**
 * ADR-097: THE single entry of an answer a student sent, as
 * {@link studentViewOf} is the single exit of a question — so no caller can
 * read an answer without converting it. It parses `raw` with the type's
 * `answerSchema`, then brings it from the coordinates of the view the student
 * was served back to the canonical answer that is stored and graded. Refused:
 *   - a payload the schema does not accept;
 *   - on a view that shuffles a type that converts, a write without the
 *     `coordinates` marker (`AnswerCoordinates`): it comes from a client
 *     built before ADR-097, which named choices by canonical index;
 *   - a position `view` does not have — never dropped silently.
 * A `null` answer ("not answered") is the caller's to handle before.
 */
export function answerFromStudent(
  type: string,
  config: unknown,
  view: StudentView,
  raw: unknown,
  coordinates: AnswerCoordinates | undefined,
): AnswerEntry {
  const t = typeOf(type);
  const parsed = t.answerSchema.safeParse(raw);
  if (!parsed.success) return { issues: issuesOf(parsed.error) };
  if (!t.fromStudentAnswer) return { answer: parsed.data };
  if (view.shuffle && coordinates !== ANSWER_COORDINATES) return refused("answer.coordinates_missing");
  const canonical: unknown = t.fromStudentAnswer(config, view, parsed.data);
  return canonical === null ? refused("answer.position_not_in_view") : { answer: canonical };
}

/**
 * ADR-097: a STORED answer, canonical, in the coordinates of `view` — for
 * every reply that hands a student their own answer back. A payload the type's
 * `answerSchema` no longer reads is withheld (`null`) by a type that converts:
 * it cannot be put in view coordinates, so it must not travel as if it were.
 */
export function answerToStudent(type: string, config: unknown, view: StudentView, stored: unknown): unknown {
  if (stored === null || stored === undefined) return null;
  const t = typeOf(type);
  if (!t.toStudentAnswer) return stored;
  const parsed = t.answerSchema.safeParse(stored);
  return parsed.success ? t.toStudentAnswer(config, view, parsed.data) : null;
}
