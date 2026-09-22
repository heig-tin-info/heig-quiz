import { describe, expect, it } from "vitest";

import { caseArgv } from "./execute.js";
import { mainSource, planFor, sanitizeFileName, splitCompileArgs } from "./languages.js";

describe("sanitizeFileName", () => {
  it("keeps a plain name", () => {
    expect(sanitizeFileName("main.c", 0)).toBe("main.c");
  });

  it("drops every path component", () => {
    expect(sanitizeFileName("../../etc/passwd", 0)).toBe("passwd");
    expect(sanitizeFileName("/etc/shadow", 0)).toBe("shadow");
    expect(sanitizeFileName("..\\..\\windows\\system32", 0)).toBe("system32");
    expect(sanitizeFileName("sub/dir/main.c", 0)).toBe("main.c");
  });

  it("drops a leading dash, which a compiler would read as an option", () => {
    expect(sanitizeFileName("-o", 0)).toBe("o");
    expect(sanitizeFileName("-o/etc/passwd", 0)).toBe("passwd");
  });

  it("replaces everything outside [A-Za-z0-9._-]", () => {
    expect(sanitizeFileName("a b;rm -rf $HOME.c", 0)).toBe("a_b_rm_-rf__HOME.c");
    expect(sanitizeFileName("émoji✨.py", 0)).toBe("_moji_.py");
  });

  it("never returns an empty name", () => {
    expect(sanitizeFileName("...", 3)).toBe("file3");
    expect(sanitizeFileName("", 1)).toBe("file1");
  });

  it("caps the length", () => {
    expect(sanitizeFileName("a".repeat(200), 0)).toHaveLength(64);
  });
});

describe("splitCompileArgs", () => {
  it("splits on whitespace and nothing else", () => {
    expect(splitCompileArgs("  -O2   -Wall\t-std=c11 ")).toEqual(["-O2", "-Wall", "-std=c11"]);
  });

  it("is empty for an empty string", () => {
    expect(splitCompileArgs("")).toEqual([]);
  });

  it("caps the number of tokens", () => {
    expect(splitCompileArgs("-x ".repeat(100))).toHaveLength(40);
  });
});

describe("planFor", () => {
  it("builds every C source and links the maths library last", () => {
    const plan = planFor("c", ["main.c", "helper.c", "notes.txt"], ["-O2"]);
    expect(plan?.compile).toEqual([
      "gcc", "-std=c17", "-O1", "-Wall", "-o", "program", "main.c", "helper.c", "-O2", "-lm",
    ]);
    expect(plan?.run).toEqual(["./program"]);
  });

  it("checks the syntax of an interpreted language instead of building it", () => {
    expect(planFor("python", ["main.py"], [])).toEqual({
      compile: ["python3", "-m", "py_compile", "main.py"],
      run: ["python3", "main.py"],
    });
    expect(planFor("js", ["main.js"], [])).toEqual({
      compile: ["node", "--check", "main.js"],
      run: ["node", "main.js"],
    });
  });

  it("refuses a request with no source of that language", () => {
    expect(planFor("c", ["readme.txt"], [])).toBeNull();
    expect(mainSource("cpp", ["main.cc"])).toBe("main.cc");
  });

  /**
   * `spice` builds nothing and names no file: the netlist of a stimulus is
   * the case's `args` (ADR-019). A plan that named `s0.cir` would make every
   * case of a request simulate the first stimulus.
   */
  it("runs a netlist from the case's arguments, and builds nothing", () => {
    expect(planFor("spice", ["s0.cir", "s1.cir"], [])).toEqual({
      compile: null,
      run: ["ngspice", "-b"],
    });
    expect(mainSource("spice", ["notes.txt", "s0.cir"])).toBe("s0.cir");
    expect(planFor("spice", ["main.c"], [])).toBeNull();
  });

  it("gives spice the same argv shape every other language gets", () => {
    const plan = planFor("spice", ["s0.cir"], [])!;
    expect(caseArgv(plan.run, 5, ["s0.cir"])).toEqual([
      "timeout", "-s", "KILL", "5", "ngspice", "-b", "s0.cir",
    ]);
  });
});
