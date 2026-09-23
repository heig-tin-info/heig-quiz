/**
 * `codeimage` grading: the pending half builds ONE run from the stored
 * template, and the pure half scores the fraction of matching cells —
 * whatever way the run ended, unless nothing compiled.
 */
import { describe, expect, it } from "vitest";

import type { GradeContext } from "@quiz/core/server";
import { RunnerUnavailable } from "@quiz/core/server";

import { FINALIZE_CTX, outcome } from "../test/fixtures.js";
import { finalizeRunnerCodeImage, gradeCodeImage, interactiveImageRequest } from "./grade.js";
import { CodeImageDetails } from "./schema.js";
import { codeimageServer } from "./server.js";
import { CHECKER_STDOUT, IMG_SECRET_COMPILE_ARGS, imageConfig } from "./test/fixtures.js";

const ctx: GradeContext = {
  ...FINALIZE_CTX,
  runner: {
    run: async () => {
      throw new RunnerUnavailable("not_configured");
    },
    health: async () => ({ ok: false, languages: [], queued: 0, avgMs: null }),
  },
};

const answer = { regions: ["    puts(\"drawing\");\n"] };

describe("gradeCodeImage", () => {
  it("scores an empty answer zero without running anything", () => {
    const result = gradeCodeImage(imageConfig(), { regions: ["  "] }, ctx);
    expect(result).toMatchObject({ kind: "graded", points: 0, state: "validated" });
    const none = gradeCodeImage(imageConfig(), null, ctx);
    expect(none).toMatchObject({ kind: "graded", points: 0 });
  });

  it("hands back ONE run of the source rebuilt from the stored template", () => {
    const result = gradeCodeImage(imageConfig(), answer, ctx);
    expect(result.kind).toBe("pending");
    if (result.kind !== "pending" || result.via !== "runner") return;
    const { request } = result;
    expect(request.cases).toEqual([{ name: "image", args: [], stdin: "" }]);
    expect(request.action).toBe("run");
    expect(request.priority).toBe("grading");
    expect(request.compileArgs).toBe(IMG_SECRET_COMPILE_ARGS);
    expect(request.limits.outputKb).toBe(128);
    const main = request.files[0]!;
    expect(main.content).toContain("int main(void) {");
    expect(main.content).toContain('puts("drawing");');
    expect(request.files.map((f) => f.name)).toContain("seed.csv");
  });

  it("runs even a config whose stored action is 'check': a picture must be drawn", () => {
    const result = gradeCodeImage(imageConfig({ action: "check" }), answer, ctx);
    if (result.kind !== "pending" || result.via !== "runner") throw new Error("pending expected");
    expect(result.request.action).toBe("run");
  });

  it("proposes zero, for a human, when the regions no longer fit the template", () => {
    const result = gradeCodeImage(imageConfig(), { regions: ["a", "b", "c"] }, ctx);
    expect(result).toMatchObject({ kind: "graded", points: 0, state: "proposed" });
  });
});

describe("finalizeRunnerCodeImage", () => {
  const finalize = (stdout: string, run: Record<string, unknown> = {}, compile = {}) =>
    finalizeRunnerCodeImage(imageConfig(), answer, FINALIZE_CTX, outcome([{ stdout, ...run }], compile));

  it("gives full marks for the exact picture", () => {
    const graded = finalize(CHECKER_STDOUT);
    expect(graded.points).toBe(10);
    expect(graded.details).toMatchObject({ matching: 12, pixelCount: 12, warnings: [] });
    expect(graded.details.image).toBe("101001011010");
    expect(CodeImageDetails.safeParse(graded.details).success).toBe(true);
  });

  it("scores points × matching / total, rounded to two decimals", () => {
    // 11 of 12 cells right: 10 × 11/12 = 9.1666… → 9.17.
    const graded = finalize("1 0 1 0\n0 1 0 1\n1 0 1 1\n");
    expect(graded.details.matching).toBe(11);
    expect(graded.points).toBe(9.17);
  });

  it("grades what stdout holds even when the run timed out, crashed or ran out of memory", () => {
    const half = "1 0 1 0\n0 1 0 1\n";
    for (const run of [{ timedOut: true }, { exitCode: null }, { oom: true }, { exitCode: 3 }]) {
      const graded = finalize(half, run);
      expect(graded.details.matching, JSON.stringify(run)).toBe(8);
      expect(graded.points).toBe(6.67);
      expect(graded.details.warnings).toEqual([{ code: "missing", count: 4 }]);
    }
  });

  it("scores zero, and draws nothing, when the program does not compile", () => {
    const graded = finalize("", {}, { ok: false, stderr: "error: expected ';'" });
    expect(graded.points).toBe(0);
    expect(graded.details).toMatchObject({ image: null, run: null, matching: 0 });
    expect(graded.details.compile).toMatchObject({ ok: false, stderr: "error: expected ';'" });
  });

  it("counts invalid pixels wrong and reports every warning", () => {
    const graded = finalize("1 0 1 0\n0 x 0 1\n1 0 1 0 9 9\n");
    expect(graded.details.matching).toBe(11);
    expect(graded.details.image).toBe("10100x011010");
    expect(graded.details.warnings).toEqual([
      { code: "invalid", count: 1 },
      { code: "extra", count: 2 },
    ]);
  });

  it("reads a missing result as an empty output", () => {
    const graded = finalizeRunnerCodeImage(imageConfig(), answer, FINALIZE_CTX, outcome([]));
    expect(graded.points).toBe(0);
    expect(graded.details.warnings).toEqual([{ code: "missing", count: 12 }]);
  });

  it("returns the picture of a draft that has no target yet, at zero", () => {
    const draft = { ...imageConfig(), target: "" };
    const graded = finalizeRunnerCodeImage(draft, answer, FINALIZE_CTX, outcome([{ stdout: CHECKER_STDOUT }]));
    expect(graded.points).toBe(0);
    expect(graded.details.image).toBe("101001011010");
  });
});

describe("the student's Run (interactiveRequest)", () => {
  it("is the grading request at interactive priority", () => {
    const request = codeimageServer.interactiveRequest!(imageConfig(), answer, FINALIZE_CTX);
    expect(request).not.toBeNull();
    expect(request!.priority).toBe("interactive");
    expect(request!.cases).toEqual([{ name: "image", args: [], stdin: "" }]);
    expect(request!.files[0]!.content).toContain('puts("drawing");');
  });

  it("is null for regions that do not fit the stored template", () => {
    expect(interactiveImageRequest(imageConfig(), { regions: ["a", "b"] })).toBeNull();
  });
});

describe("aggregate", () => {
  it("buckets the class by pixel accuracy", () => {
    const row = (matching: number) => ({
      runner: "ok",
      compile: null,
      run: null,
      image: null,
      matching,
      pixelCount: 100,
      warnings: [],
      sourceSha256: null,
    });
    const result = codeimageServer.aggregate!({
      answers: [],
      details: [row(100), row(95), row(100), row(10), row(0), { junk: true }],
    });
    expect(result.distribution).toEqual([
      ["100 %", 2],
      ["90–99 %", 1],
      ["1–49 %", 1],
      ["0 %", 1],
    ]);
  });
});
