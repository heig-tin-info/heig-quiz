/**
 * The two decisions `codeRun` makes on its own: what the program IS, and
 * whether the free-input box has anywhere to run.
 */
import { describe, expect, it } from "vitest";

import type { CodeConfig, CodeStudent } from "@quiz/qt-code/client";

import {
  assembleSource,
  canRunManually,
  codeRunRequest,
  referenceRunRequest,
  runCode,
} from "./codeRun";

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
      backend: async (manual) => {
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
      backend: async (manual) => {
        seen.push(manual);
        return { compile: { ok: true, stdout: "", stderr: "", ms: 0 }, cases: [] };
      },
    });
    expect(seen).toEqual([undefined]);
  });
});

/*
 * The teacher's try. The editor holds the whole config, so this request is
 * the one place a run of a `code` question is allowed to be complete: the
 * flags, the files and the hidden cases all travel, because the teacher wrote
 * them and the point of the button is to check them.
 */
describe("referenceRunRequest", () => {
  // Written out rather than parsed: `@quiz/qt-code/client` exports the SHAPE
  // of a config, not its schema — the browser has no business carrying zod for
  // a fixture.
  const config = (): CodeConfig => ({
    configVersion: 1,
    prompt: "p",
    language: "c",
    runtime: "backend",
    template: "// @@lock\nint f(void) {\n// @@endlock\n  return 0;\n// @@lock\n}\n// @@endlock\n",
    files: [{ name: "data.csv", content: "1,2\n" }],
    action: "run",
    compileArgs: "-Wall -DSECRET=42",
    limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
    runsPerMinute: 10,
    allOrNothing: false,
    referenceSolution: "  return 6;\n",
    tests: {
      mode: "io",
      compare: { trimTrailing: true, ignoreCase: false, numeric: null },
      cases: [
        {
          name: "visible",
          args: [],
          stdin: "1\n",
          expected: "1",
          compareStdout: true,
          expectedExitCode: 0,
          visible: true,
          points: 1,
          timeMs: null,
        },
        {
          name: "hidden",
          args: ["-x"],
          stdin: "2\n",
          expected: "2",
          compareStdout: true,
          expectedExitCode: 0,
          visible: false,
          points: 2,
          timeMs: null,
        },
      ],
    },
  });

  it("rebuilds the source from the template and the regions, never from a blob", () => {
    const request = referenceRunRequest(config(), ["  return 6;\n"]);
    expect(request.files[0]).toEqual({
      name: "main",
      content: "// @@lock\nint f(void) {\n// @@endlock\n  return 6;\n// @@lock\n}\n// @@endlock\n",
    });
  });

  it("carries the teacher's flags and the real content of the extra files", () => {
    const request = referenceRunRequest(config(), ["  return 6;\n"]);
    expect(request.compileArgs).toBe("-Wall -DSECRET=42");
    expect(request.files[1]).toEqual({ name: "data.csv", content: "1,2\n" });
  });

  it("runs every case in the config's order, hidden ones included", () => {
    // The editor counts the passes by walking `outcome.cases[i]` beside
    // `config.tests.cases[i]`, so a missing hidden case would shift the count.
    const request = referenceRunRequest(config(), ["  return 6;\n"]);
    expect(request.cases).toEqual([
      { name: "visible", args: [], stdin: "1\n" },
      { name: "hidden", args: ["-x"], stdin: "2\n" },
    ]);
  });
});
