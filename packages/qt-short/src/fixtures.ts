/** Test fixtures for the `short` suites (excluded from the build). */
import type { GradeContext, RunnerService } from "@quiz/core/server";
import { ShortConfigSchema, type ShortConfig } from "./schema.js";

export const noRunner: RunnerService = {
  run() {
    throw new Error("the short type must never call the runner");
  },
  health() {
    return Promise.resolve({ ok: false, languages: [], queued: 0, avgMs: null });
  },
};

export function gradeContext(itemPoints: number): GradeContext {
  return {
    seed: 7,
    itemId: "item-1",
    attemptId: "attempt-1",
    itemPoints,
    now: new Date("2026-09-20T10:00:00Z"),
    runner: noRunner,
  };
}

export function config(over: Partial<ShortConfig> = {}): ShortConfig {
  return ShortConfigSchema.parse({
    configVersion: 2,
    prompt: "Which directive includes the standard I/O header?",
    matchers: [{ kind: "exact", value: "#include <stdio.h>" }],
    ...over,
  });
}

/** One matcher of every kind, every secret a `short` config can hold. */
export const SECRET_CONFIG: ShortConfig = ShortConfigSchema.parse({
  configVersion: 2,
  prompt: "How many bytes does an `int` take on a 32-bit target?",
  kind: "number",
  placeholder: "bytes",
  constraints: { min: 1, max: 100, integer: true },
  prefilters: { trim: true, lowercase: false },
  matchers: [
    { kind: "exact", value: "0x1004" },
    { kind: "regex", pattern: "^N[0-9]+$", flags: "i" },
    { kind: "number", value: 4, tolerance: 0.5, toleranceMode: "abs", unit: "bytes" },
    { kind: "date", value: "1970-01-01", toleranceDays: 2 },
    { kind: "time", value: "14:05", toleranceMinutes: 5 },
    { kind: "llm", rubric: "Newton and his three laws", reference: "Isaac Newton", points: 0.5 },
  ],
});

/** Values that must never appear in the serialised student view. */
export const SECRET_VALUES = [
  "0x1004",
  "^N[0-9]+$",
  "1970-01-01",
  "14:05",
  "Newton",
  "Isaac Newton",
];
