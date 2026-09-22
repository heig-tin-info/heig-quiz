import { execFileSync } from "node:child_process";

import type { RunnerOutcome, RunnerRequest } from "@quiz/core/server";
import { beforeAll, describe, expect, it } from "vitest";

import { detectSocket, loadConfig, type RunnerConfig } from "./config.js";
import { createEngine, type Engine } from "./engine.js";
import { executeRequest } from "./execute.js";
import { availableLanguages } from "./images.js";
import { probeEngine } from "./probe.js";

/**
 * The `spice` language against a real container (ADR-019).
 *
 * Same skip logic as `podman.int.test.ts`: a machine without a reachable
 * Podman, or without the `quiz-runner-spice` image, reports skips and not
 * failures (decision D14). `images/build.sh spice` builds the image.
 *
 * What it proves is what a fake engine cannot: that ngspice really writes the
 * `wrdata /dev/stdout` table on the exec's STDOUT (the whole grading path of
 * `qt-circuit` reads it from there), that a broken netlist is a non-zero exit
 * with a message rather than a silent empty table, and that a case with no
 * netlist in its `args` terminates instead of burning its whole budget. The
 * hardening itself stays asserted by `engine.test.ts` and `podman.int.test.ts`:
 * this image adds no environment variable, no mount and no network.
 */

const SOCKET = detectSocket();

function engineIsReachable(): { ok: boolean; hasSpice: boolean; config: RunnerConfig } {
  const config = loadConfig({
    LOG_LEVEL: "fatal",
    ...(SOCKET === null ? {} : { PODMAN_SOCKET: SOCKET }),
  });
  try {
    const base =
      config.PODMAN_SOCKET === null ? [] : ["--remote", "--url", `unix://${config.PODMAN_SOCKET}`];
    const images = execFileSync(
      config.PODMAN_BIN,
      [...base, "images", "--format", "{{.Repository}}:{{.Tag}}"],
      { encoding: "utf8", timeout: 20_000 },
    );
    return {
      ok: true,
      hasSpice: availableLanguages(images.split("\n"), config).includes("spice"),
      config,
    };
  } catch {
    return { ok: false, hasSpice: false, config };
  }
}

const probe = engineIsReachable();

if (!probe.ok) {
  console.warn("[runner] Podman is not reachable: the spice suite is skipped.");
} else if (!probe.hasSpice) {
  console.warn("[runner] no quiz-runner-spice image: run images/build.sh spice first.");
}

const config = probe.config;
let engine: Engine;

beforeAll(async () => {
  if (!probe.ok) return;
  const probed = await probeEngine(config);
  engine = createEngine({
    podmanBin: config.PODMAN_BIN,
    socket: config.PODMAN_SOCKET,
    seccompProfile: config.RUNNER_SECCOMP,
    usernsAuto: probed.capabilities.usernsAuto,
    runtime: probed.capabilities.runtime,
    capabilities: probed.capabilities,
  });
});

/**
 * The verified RC low-pass of `packages/qt-circuit/src/test/rc-lowpass.cir`.
 *
 * It is duplicated here rather than read from that package: `@quiz/runner`
 * does not depend on a question type, and a runner test that broke because a
 * type moved a fixture would be testing the wrong thing.
 */
const RC_LOWPASS = [
  "* RC low-pass",
  "Vin in 0 SIN(0 1 1000)",
  "R1 in out 1.59k",
  "C1 out 0 100n",
  ".tran 10u 5m 0",
  ".control",
  "set wr_vecnames",
  "set wr_singlescale",
  "run",
  "linearize v(in) v(out)",
  "wrdata /dev/stdout v(in) v(out)",
  ".endc",
  ".end",
  "",
].join("\n");

/** `R1 in out` has no value: ngspice refuses the line and runs nothing. */
const BROKEN = ["* broken", "R1 in out", ".tran 1u 1m", ".end", ""].join("\n");

function request(
  files: { name: string; content: string }[],
  cases: { name: string; args: string[]; stdin: string }[],
  overrides: Partial<RunnerRequest> = {},
): RunnerRequest {
  return {
    language: "spice",
    files,
    compileArgs: "",
    action: "run",
    limits: { timeMs: 10_000, memoryMb: 128, outputKb: 256 },
    cases,
    priority: "interactive",
    ...overrides,
  };
}

const run = (req: RunnerRequest): Promise<RunnerOutcome> => executeRequest(req, { engine, config });

/**
 * The `wrdata` table out of everything else ngspice prints: a data row is a
 * line whose every cell is a number, which the operating-point banner and the
 * `v(in) v(out)` header are not.
 */
function dataRows(stdout: string): string[][] {
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (cells) => cells.length >= 2 && cells.every((cell) => Number.isFinite(Number(cell))),
    );
}

describe.skipIf(!probe.ok || !probe.hasSpice)("spice in a real container", () => {
  it("simulates a netlist and writes its table on stdout", async () => {
    const outcome = await run(
      request([{ name: "s0.cir", content: RC_LOWPASS }], [{ name: "s0", args: ["s0.cir"], stdin: "" }]),
    );

    // Nothing is built, so `compile` is the "nothing to do" answer.
    expect(outcome.compile).toEqual({ ok: true, stdout: "", stderr: "", ms: 0 });
    const only = outcome.cases[0]!;
    expect(only).toMatchObject({ exitCode: 0, timedOut: false, oom: false, truncated: false });

    // `set wr_vecnames` puts the header first, then one row per linearized
    // point: this is exactly the table `qt-circuit` parses. The banner
    // ngspice prints before it (the operating point) is not made of numbers
    // only, which is what tells the two apart.
    const rows = dataRows(only.stdout);
    expect(only.stdout).toContain("v(out)");
    expect(rows.length).toBeGreaterThanOrEqual(100);
    expect(rows[0]).toHaveLength(3);
    // A 1 kHz sine through a 1 kHz RC: the output is attenuated, not silent.
    const peak = Math.max(...rows.map((cells) => Math.abs(Number(cells[1] ?? "0"))));
    expect(peak).toBeGreaterThan(0.5);
    expect(peak).toBeLessThan(1.01);
  });

  it("runs one ngspice per stimulus in the SAME container", async () => {
    const outcome = await run(
      request(
        [
          { name: "s0.cir", content: RC_LOWPASS },
          { name: "s1.cir", content: RC_LOWPASS.replace("SIN(0 1 1000)", "SIN(0 1 10000)") },
        ],
        [
          { name: "s0", args: ["s0.cir"], stdin: "" },
          { name: "s1", args: ["s1.cir"], stdin: "" },
        ],
      ),
    );
    expect(outcome.cases.map((c) => c.exitCode)).toEqual([0, 0]);
    // Ten times the frequency through the same RC: ten times less output.
    const peakOf = (stdout: string): number =>
      Math.max(...dataRows(stdout).map((cells) => Math.abs(Number(cells[1]))));
    expect(peakOf(outcome.cases[1]!.stdout)).toBeLessThan(peakOf(outcome.cases[0]!.stdout));
  });

  it("reports a broken netlist as a failed case, with a reason", async () => {
    const outcome = await run(
      request([{ name: "s0.cir", content: BROKEN }], [{ name: "s0", args: ["s0.cir"], stdin: "" }]),
    );
    // A netlist has no build step, so a parse error is a CASE failure: there
    // is no `compile.ok === false` to carry it (`languages.ts`).
    expect(outcome.compile.ok).toBe(true);
    const only = outcome.cases[0]!;
    expect(only.exitCode).not.toBe(0);
    expect(only.timedOut).toBe(false);
    expect(`${only.stdout}${only.stderr}`).toContain("not a valid resistor instance line");
  });

  it("terminates promptly when a case names no netlist", async () => {
    // `ngspice -b` with no file reads its stdin, which `engine.exec` closes at
    // once: it exits non-zero in milliseconds instead of holding the slot for
    // the whole budget. The type always passes `args`; this is the guard.
    const outcome = await run(
      request([{ name: "s0.cir", content: RC_LOWPASS }], [{ name: "empty", args: [], stdin: "" }], {
        limits: { timeMs: 10_000, memoryMb: 128, outputKb: 64 },
      }),
    );
    expect(outcome.cases[0]!.timedOut).toBe(false);
    expect(outcome.cases[0]!.ms).toBeLessThan(5000);
  });

  it("has no network and cannot write outside its tmpfs", async () => {
    // ngspice's `.control` blocks can `shell` and `write`: both run INSIDE the
    // hardened container, so the answer is the sandbox's, not the parser's
    // (invariants 11 and 12, apps/runner/README.md).
    const probeNetlist = [
      "* escape attempt",
      "V1 a 0 1",
      "R1 a 0 1k",
      ".op",
      ".control",
      "op",
      "shell ping -c1 1.1.1.1",
      "shell touch /etc/quiz-pwned",
      "print v(a)",
      ".endc",
      ".end",
      "",
    ].join("\n");
    const outcome = await run(
      request([{ name: "s0.cir", content: probeNetlist }], [{ name: "s0", args: ["s0.cir"], stdin: "" }]),
    );
    const output = `${outcome.cases[0]!.stdout}${outcome.cases[0]!.stderr}`;
    expect(output).not.toContain("bytes from");
    expect(output).not.toMatch(/1 (packets )?received/);
    // Whatever `shell` managed to spawn, the root filesystem is read-only.
    expect(output).not.toContain("quiz-pwned created");
  });
});
