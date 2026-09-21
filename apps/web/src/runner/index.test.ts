/**
 * The fallback rule, and only the fallback rule.
 *
 * Which runner serves a run is one decision made in one place
 * (`runWithFallback`), because the player and the teacher's try panel must not
 * answer it differently. The fake below is the whole browser runner as far as
 * this file is concerned: what matters is WHEN it is called, not what it does.
 */
import { describe, expect, it, vi } from "vitest";

import type { RunnerOutcome, RunnerRequest } from "@quiz/core/server";

import { browserCanRun, runWithFallback } from "./index";
import { BrowserRunnerUnavailable, type BrowserRunner } from "./types";

const request = (language: string): RunnerRequest =>
  ({
    language,
    files: [{ name: "main", content: "" }],
    compileArgs: "",
    action: "run",
    limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
    cases: [],
    priority: "interactive",
  }) as RunnerRequest;

const outcome = (stdout: string): RunnerOutcome => ({
  compile: { ok: true, stdout: "", stderr: "", ms: 1 },
  cases: [
    { exitCode: 0, stdout, stderr: "", ms: 1, timedOut: false, oom: false, truncated: false },
  ],
});

function fakeRunner(
  run: BrowserRunner["run"] = async () => outcome("browser"),
  languages = ["c", "python"],
): BrowserRunner {
  return { id: "fake", supports: (l) => languages.includes(l), run: vi.fn(run) };
}

describe("browserCanRun", () => {
  it("knows the two languages the browser runner ships", () => {
    expect(browserCanRun("c")).toBe(true);
    expect(browserCanRun("python")).toBe(true);
    expect(browserCanRun("rust")).toBe(false);
  });
});

describe("runWithFallback", () => {
  it("runs in the browser when the question asks for it", async () => {
    const backend = vi.fn(async () => outcome("backend"));
    const browser = fakeRunner();
    const result = await runWithFallback(request("c"), { runtime: "runno", backend, browser });
    expect(result).not.toBe("unavailable");
    expect((result as RunnerOutcome).cases[0]?.stdout).toBe("browser");
    expect(backend).not.toHaveBeenCalled();
  });

  it("falls back to the backend when the browser runtime will not load", async () => {
    const backend = vi.fn(async () => outcome("backend"));
    const browser = fakeRunner(async () => {
      throw new BrowserRunnerUnavailable("HTTP 404");
    });
    const result = await runWithFallback(request("c"), { runtime: "runno", backend, browser });
    expect((result as RunnerOutcome).cases[0]?.stdout).toBe("backend");
    expect(backend).toHaveBeenCalledOnce();
  });

  it("lets a real failure of the browser runner through", async () => {
    const browser = fakeRunner(async () => {
      throw new TypeError("a bug, not a missing runtime");
    });
    await expect(
      runWithFallback(request("c"), {
        runtime: "runno",
        backend: async () => outcome("backend"),
        browser,
      }),
    ).rejects.toThrow(TypeError);
  });

  it("uses the backend for a language the browser cannot run", async () => {
    const backend = vi.fn(async () => outcome("backend"));
    const browser = fakeRunner();
    const result = await runWithFallback(request("rust"), { runtime: "runno", backend, browser });
    expect((result as RunnerOutcome).cases[0]?.stdout).toBe("backend");
  });

  it("asks the backend first when the question says so", async () => {
    const backend = vi.fn(async () => outcome("backend"));
    const browser = fakeRunner();
    const result = await runWithFallback(request("c"), { runtime: "backend", backend, browser });
    expect((result as RunnerOutcome).cases[0]?.stdout).toBe("backend");
    expect(browser.run).not.toHaveBeenCalled();
  });

  it("takes over in the browser on a 503 from the backend (decision D14)", async () => {
    const backend = vi.fn(async () => "unavailable" as const);
    const browser = fakeRunner();
    const result = await runWithFallback(request("c"), { runtime: "backend", backend, browser });
    expect((result as RunnerOutcome).cases[0]?.stdout).toBe("browser");
  });

  it("says unavailable when neither runner can", async () => {
    const result = await runWithFallback(request("rust"), {
      runtime: "backend",
      backend: async () => "unavailable" as const,
      browser: null,
    });
    expect(result).toBe("unavailable");
  });

  it("stays unavailable when the backend is off and the browser will not load", async () => {
    const browser = fakeRunner(async () => {
      throw new BrowserRunnerUnavailable("no worker");
    });
    const result = await runWithFallback(request("c"), {
      runtime: "backend",
      backend: async () => "unavailable" as const,
      browser,
    });
    expect(result).toBe("unavailable");
  });
});
