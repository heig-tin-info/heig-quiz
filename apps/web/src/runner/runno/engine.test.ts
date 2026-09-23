/**
 * The two tables the browser runner is wired with, and the lists they must
 * agree with.
 *
 * `RUNNO_LANGUAGES` (`@quiz/qt-code`) is what a teacher may choose
 * `runtime: "runno"` for and what `browserCanRun` answers on; `RUNTIME_ASSETS`
 * is what `fetch-runtimes.mjs` downloads and what the worker loads. A language
 * offered in the editor with no entry here is a player that says "Runs in your
 * browser" and then falls back to the backend on every run.
 */
import { RUNNO_LANGUAGES } from "@quiz/qt-code/client";
import { mainFileName } from "@quiz/domain";
import { describe, expect, it } from "vitest";

import { ENTRY_FILE, RUNTIME_ASSETS } from "./engine";

describe("the browser runner's tables", () => {
  it("ships runtime assets for exactly the languages it claims to run", () => {
    expect(Object.keys(RUNTIME_ASSETS).sort()).toEqual([...RUNNO_LANGUAGES].sort());
  });

  it("names the entry file the way the backend runner does", () => {
    // Both runners answer the same `RunnerRequest`; they cannot disagree on
    // what the single source file is called (`mainFileName`, `@quiz/domain`).
    for (const language of RUNNO_LANGUAGES) {
      expect(ENTRY_FILE[language]).toBe(mainFileName(language));
    }
  });
});
