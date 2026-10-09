/**
 * `@quiz/core/testing` — the shared half of the leak test of invariant 4
 * (docs/spec/05 §5.7, N-SEC-04). TEST-ONLY.
 *
 * Nothing in `apps/*` imports this entry point, so no production bundle holds
 * it: it exists for the `qt-*` suites and for the cross-type contract test of
 * `@quiz/registry`. It depends on no test framework — a leak comes back as a
 * list of findings, and the caller asserts the list is empty, which prints
 * every leak at once instead of the first one.
 */
import { COMMON_FORBIDDEN_STUDENT_KEYS, type GradeContext } from "./contract.js";
import type { RunnerService } from "./runner.js";

/**
 * What a question type hands the contract test: a FULLY populated
 * configuration, every field that can carry a secret set to a recognisable
 * value, and what must never come out of `toStudent` for it.
 */
export interface StudentLeakFixture<Config = unknown> {
  /** A valid config (it parses with the type's `configSchema`) with every secret set. */
  config: Config;
  /**
   * The keys only this type must never publish, on top of
   * {@link COMMON_FORBIDDEN_STUDENT_KEYS} (which {@link findStudentLeaks}
   * always adds).
   */
  forbiddenKeys: readonly string[];
  /** Literal values of `config` that must appear nowhere in the student view. */
  secrets: readonly string[];
}

/**
 * Every leak of a student view: a forbidden key (the common floor plus
 * `forbiddenKeys`) or a secret value found in its JSON serialization. Empty
 * when the view is clean. A {@link StudentLeakFixture} is a valid second
 * argument as it stands.
 *
 * Both checks read the SERIALIZED payload, which is what reaches the wire: a
 * key is searched for as `"key"`, a secret as a substring. The second check is
 * the one that catches a leak that renamed its field.
 */
export function findStudentLeaks(
  student: unknown,
  {
    forbiddenKeys = [],
    secrets = [],
  }: { forbiddenKeys?: readonly string[]; secrets?: readonly string[] },
): string[] {
  const out = JSON.stringify(student) ?? "";
  const leaks: string[] = [];
  for (const key of new Set([...COMMON_FORBIDDEN_STUDENT_KEYS, ...forbiddenKeys])) {
    if (out.includes(`"${key}"`)) leaks.push(`forbidden key "${key}"`);
  }
  for (const secret of secrets) {
    // An empty secret is found everywhere: it is a broken fixture, not a leak.
    if (secret === "") throw new Error("an empty string is not a secret value");
    if (out.includes(secret)) leaks.push(`secret value ${JSON.stringify(secret)}`);
  }
  return leaks;
}

/** A runner a type that never runs code must never call: calling it is a bug, so it throws. */
const noRunner: RunnerService = {
  run() {
    throw new Error("this question type must never call the runner");
  },
  health() {
    return Promise.resolve({ ok: false, languages: [], queued: 0, avgMs: null });
  },
};

/**
 * The grading context of a `qt-*` unit test: fixed ids, seed and instant, a
 * runner that throws, and the evaluation's per-type `defaults` when given.
 */
export function testGradeContext(itemPoints: number, defaults?: GradeContext["defaults"]): GradeContext {
  return {
    seed: 7,
    itemId: "item-1",
    attemptId: "attempt-1",
    itemPoints,
    now: new Date("2026-09-20T10:00:00Z"),
    runner: noRunner,
    ...(defaults === undefined ? {} : { defaults }),
  };
}
