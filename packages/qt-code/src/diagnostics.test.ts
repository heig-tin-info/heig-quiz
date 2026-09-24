import { describe, expect, it } from "vitest";

import { parseDiagnostics } from "./diagnostics.js";

describe("parseDiagnostics", () => {
  it("reads gcc errors and warnings about the main file", () => {
    const stderr = [
      "main.c: In function 'main':",
      "main.c:12:5: error: expected ';' before '}' token",
      "   12 |     return 0",
      "      |     ^~~~~~",
      "main.c:4:9: warning: unused variable 'x' [-Wunused-variable]",
    ].join("\n");
    expect(parseDiagnostics(stderr, "main.c")).toEqual([
      { line: 12, column: 5, severity: "error", message: "expected ';' before '}' token" },
      { line: 4, column: 9, severity: "warning", message: "unused variable 'x' [-Wunused-variable]" },
    ]);
  });

  it("matches the file by its base name and ignores the other files", () => {
    const stderr = [
      "/usr/include/stdio.h:3:1: error: something in a header",
      "/work/main.c:7:2: fatal error: foo.h: No such file or directory",
    ].join("\n");
    expect(parseDiagnostics(stderr, "main.c")).toEqual([
      { line: 7, column: 2, severity: "error", message: "foo.h: No such file or directory" },
    ]);
  });

  it("accepts a position without a column", () => {
    expect(parseDiagnostics("main.cpp:3: error: oops", "main.cpp")).toEqual([
      { line: 3, column: null, severity: "error", message: "oops" },
    ]);
  });

  it("reads rustc's header and arrow lines", () => {
    const stderr = [
      "error[E0425]: cannot find value `y` in this scope",
      " --> main.rs:3:13",
      "  |",
      "warning: unused variable: `x`",
      " --> main.rs:2:9",
    ].join("\n");
    expect(parseDiagnostics(stderr, "main.rs")).toEqual([
      { line: 3, column: 13, severity: "error", message: "cannot find value `y` in this scope" },
      { line: 2, column: 9, severity: "warning", message: "unused variable: `x`" },
    ]);
  });

  it("reads the innermost main-file frame of a Python traceback", () => {
    const stderr = [
      "Traceback (most recent call last):",
      '  File "/work/main.py", line 9, in <module>',
      "    main()",
      '  File "/work/main.py", line 4, in main',
      "    print(1 / 0)",
      "ZeroDivisionError: division by zero",
      "",
    ].join("\n");
    expect(parseDiagnostics(stderr, "main.py")).toEqual([
      { line: 4, column: null, severity: "error", message: "ZeroDivisionError: division by zero" },
    ]);
  });

  it("reads a Python syntax error", () => {
    const stderr = ['  File "main.py", line 2', "    def f(:", "          ^", "SyntaxError: invalid syntax"].join(
      "\n",
    );
    expect(parseDiagnostics(stderr, "main.py")).toEqual([
      { line: 2, column: null, severity: "error", message: "SyntaxError: invalid syntax" },
    ]);
  });

  it("returns nothing for an empty or unrelated stderr", () => {
    expect(parseDiagnostics("", "main.c")).toEqual([]);
    expect(parseDiagnostics("collect2: error: ld returned 1 exit status", "main.c")).toEqual([]);
  });
});
