/** Test fixtures for the `categorize` suites (excluded from the build). */
import type { GradeContext, RunnerService } from "@quiz/core/server";
import { CategorizeConfigSchema, type CategorizeConfig } from "../schema.js";

const noRunner: RunnerService = {
  run() {
    throw new Error("the categorize type must never call the runner");
  },
  health() {
    return Promise.resolve({ ok: false, languages: [], queued: 0, avgMs: null });
  },
};

export function gradeContext(itemPoints: number, defaults?: GradeContext["defaults"]): GradeContext {
  return {
    seed: 7,
    itemId: "item-1",
    attemptId: "attempt-1",
    itemPoints,
    now: new Date("2026-09-29T10:00:00Z"),
    runner: noRunner,
    ...(defaults === undefined ? {} : { defaults }),
  };
}

/**
 * Three columns, six targets and two distractors: the "C types" of the
 * mockup. Card ids say nothing, as the editor's would not; the test reads
 * them through the names below.
 */
export const C = { int: "q7k2", float: "m3x9", ptr: "z0p4" } as const;
export const K = {
  int: "a81f",
  size: "b27c",
  double: "c55d",
  float: "d09e",
  voidp: "e44a",
  charp: "f13b",
  string: "g62c",
  bool: "h70d",
} as const;

export function config(over: Partial<CategorizeConfig> = {}): CategorizeConfig {
  return CategorizeConfigSchema.parse({
    configVersion: 1,
    prompt: "Sort each C type by what it represents.",
    columns: [
      { id: C.int, label: "Integer", cards: [K.int, K.size] },
      { id: C.float, label: "Floating point", cards: [K.double, K.float] },
      { id: C.ptr, label: "Pointer", cards: [K.voidp, K.charp] },
    ],
    cards: [
      { id: K.int, text: "`int`" },
      { id: K.size, text: "`size_t`" },
      { id: K.double, text: "`double`" },
      { id: K.float, text: "`float`" },
      { id: K.voidp, text: "`void *`" },
      { id: K.charp, text: "`char *`" },
      { id: K.string, text: "`string`" },
      { id: K.bool, text: "`boolean`" },
    ],
    shuffleCards: false,
    ...over,
  });
}

/** The right answer to {@link config}. */
export const RIGHT = {
  columns: { [C.int]: [K.int, K.size], [C.float]: [K.double, K.float], [C.ptr]: [K.voidp, K.charp] },
};

/** The full fixture of the leak test (`../testing.ts`), shared with the registry's contract test. */
export * from "../testing.js";
