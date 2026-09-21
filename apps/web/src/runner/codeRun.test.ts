/**
 * The two decisions `codeRun` makes on its own: what the program IS, and
 * whether the free-input box has anywhere to run.
 */
import { describe, expect, it } from "vitest";

import type { CodeStudent } from "@quiz/qt-code/client";

import { assembleSource, canRunManually, codeRunRequest, runCode } from "./codeRun";

const student = (over: Partial<CodeStudent> = {}): CodeStudent =>
  ({
    prompt: "",
    language: "c",
    runtime: "runno",
    segments: [
      { kind: "locked", index: null, text: "#include <stdio.h>\n" },
      { kind: "editable", index: 0, text: "int f(void) { return 0; }\n" },
      { kind: "locked", index: null, text: "int main(void) { return f(); }\n" },
    ],
    limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
    runsPerMinute: 10,
    visibleCases: [
      {
        name: "one",
        args: ["3"],
        stdin: "x",
        expected: "0",
        compareStdout: true,
        expectedExitCode: 0,
        points: 1,
      },
    ],
    hiddenCount: 0,
    hiddenPoints: 0,
    filesPreview: [],
    allOrNothing: false,
    ...over,
  }) as CodeStudent;

describe("assembleSource", () => {
  it("puts the answer back between the teacher's locked blocks", () => {
    expect(assembleSource(student(), ["int f(void) { return 42; }\n"])).toBe(
      "#include <stdio.h>\nint f(void) { return 42; }\nint main(void) { return f(); }\n",
    );
  });

  it("falls back to the template for a region the answer does not carry", () => {
    expect(assembleSource(student(), [])).toContain("int f(void) { return 0; }");
  });
});

describe("codeRunRequest", () => {
  it("sends the visible cases, with their command lines", () => {
    const request = codeRunRequest(student(), { regions: [] });
    expect(request.cases).toEqual([{ name: "one", args: ["3"], stdin: "x" }]);
    // The key never travels with a trial run: `toStudent` dropped the
    // compiler flags and the extra files' contents, and so does this.
    expect(request.compileArgs).toBe("");
  });

  it("replaces them with the student's own input on a manual run", () => {
    const request = codeRunRequest(student(), { regions: [] }, { args: ["-v"], stdin: "7\n" });
    expect(request.cases).toEqual([{ name: "manual", args: ["-v"], stdin: "7\n" }]);
  });
});

describe("canRunManually", () => {
  it("is true only where a browser runner will take the input", () => {
    expect(canRunManually(student())).toBe(true);
    expect(canRunManually(student({ runtime: "backend" }))).toBe(false);
    expect(canRunManually(student({ language: "rust" }))).toBe(false);
  });
});

describe("runCode", () => {
  it("hands the free input to the backend, which is what the API takes", async () => {
    const seen: unknown[] = [];
    await runCode({
      student: student({ runtime: "backend" }),
      answer: { regions: [] },
      backend: async (_request, manual) => {
        seen.push(manual);
        return { compile: { ok: true, stdout: "", stderr: "", ms: 0 }, cases: [] };
      },
      options: { manual: { args: ["-v"], stdin: "7\n" } },
    });
    expect(seen).toEqual([{ args: ["-v"], stdin: "7\n" }]);
  });

  it("sends nothing extra on an ordinary run of the visible cases", async () => {
    const seen: unknown[] = [];
    await runCode({
      student: student({ runtime: "backend" }),
      answer: { regions: [] },
      backend: async (_request, manual) => {
        seen.push(manual);
        return { compile: { ok: true, stdout: "", stderr: "", ms: 0 }, cases: [] };
      },
    });
    expect(seen).toEqual([undefined]);
  });
});
