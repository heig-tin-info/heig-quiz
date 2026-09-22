import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { CONTAINER_ENV, createEngine, type CreateOptions } from "./engine.js";
import { FAKE_CAPABILITIES } from "./test/fakeEngine.js";

const CREATE: CreateOptions = {
  name: "quiz-run-1",
  image: "quiz-runner-c:latest",
  memoryMb: 128,
  pidsLimit: 64,
  cpus: 1,
  workdirMb: 32,
  ttlSeconds: 40,
};

function engine(overrides: Partial<Parameters<typeof createEngine>[0]> = {}) {
  return createEngine({
    podmanBin: "podman",
    socket: "/run/podman/podman.sock",
    seccompProfile: "/etc/quiz/seccomp.json",
    usernsAuto: true,
    runtime: null,
    capabilities: FAKE_CAPABILITIES,
    ...overrides,
  });
}

describe("containerArgs", () => {
  it("is the hardening of run-hardened.sh, flag for flag", () => {
    expect(engine().containerArgs(CREATE)).toEqual([
      "run", "-d",
      "--name", "quiz-run-1",
      "--label", "quiz.runner=1",
      "--userns=auto",
      "--cap-drop=ALL",
      "--security-opt", "no-new-privileges",
      "--security-opt", "seccomp=/etc/quiz/seccomp.json",
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m",
      "--tmpfs", "/work:rw,exec,nosuid,nodev,size=32m,mode=1777",
      "--pids-limit", "64",
      "--memory", "128m",
      "--memory-swap", "128m",
      "--cpus", "1",
      "--network", "none",
      "-e", "HOME=/work",
      "-e", "LANG=C.UTF-8",
      "quiz-runner-c:latest",
      "sleep", "40",
    ]);
  });

  it("drops --userns=auto, and nothing else, on an engine without it", () => {
    const withAuto = engine().containerArgs(CREATE);
    const without = engine({ usernsAuto: false }).containerArgs(CREATE);
    expect(without).toEqual(withAuto.filter((arg) => arg !== "--userns=auto"));
  });

  it("adds gVisor when the host has it", () => {
    expect(engine({ runtime: "runsc" }).containerArgs(CREATE)).toContain("runsc");
  });

  it("never mounts anything from the host", () => {
    const args = engine().containerArgs(CREATE);
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--volume");
    expect(args).not.toContain("--mount");
  });

  it("passes a CLOSED list of environment variables, with no secret in it", () => {
    // Invariant 10. Adding a key here is adding it to the container of every
    // student on the platform: it is done in CONTAINER_ENV, with this test.
    expect(Object.keys(CONTAINER_ENV)).toEqual(["HOME", "LANG"]);
    const args = engine().containerArgs(CREATE);
    const passed = args.filter((arg, i) => args[i - 1] === "-e");
    expect(passed).toEqual(["HOME=/work", "LANG=C.UTF-8"]);
    expect(args).not.toContain("--env-file");
  });

});

/**
 * Invariant 13, against a `podman` that records what it was called with.
 *
 * `containerArgs()` deliberately does NOT carry the connection flags — they
 * are prepended by the spawner, for `exec`, `rm` and `images` as well — so no
 * assertion on its list can see them. This is the only place that does: delete
 * the three lines that build them and four expectations break at once.
 */
describe("--remote --url, on every command the engine sends", () => {
  /** A `podman` that appends its argv to a log, one argument per line. */
  function recorder(): { bin: string; calls: () => string[][] } {
    const dir = mkdtempSync(join(tmpdir(), "quiz-runner-argv-"));
    const log = join(dir, "argv.log");
    const bin = join(dir, "podman");
    writeFileSync(
      bin,
      `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg" >> ${log}; done\n` +
        `printf '%s\\n' '@@END@@' >> ${log}\nexit 0\n`,
    );
    chmodSync(bin, 0o755);
    return {
      bin,
      calls: () =>
        readFileSync(log, "utf8")
          .split("@@END@@\n")
          .filter((block) => block !== "")
          .map((block) => block.split("\n").filter((line) => line !== "")),
    };
  }

  /** Every method that reaches Podman, once each, in this order. */
  async function exercise(bin: string, socket: string | null): Promise<void> {
    const subject = engine({ podmanBin: bin, socket });
    await subject.create(CREATE);
    await subject.exec(CREATE.name, {
      argv: ["true"],
      stdin: "",
      timeoutMs: 5000,
      maxBytes: 1024,
    });
    await subject.remove(CREATE.name);
    await subject.listImages();
  }

  it("prefixes create, exec, rm and images with the socket of the engine", async () => {
    const podman = recorder();
    await exercise(podman.bin, "/run/podman/podman.sock");

    const calls = podman.calls();
    expect(calls).toHaveLength(4);
    for (const argv of calls) {
      expect(argv.slice(0, 3)).toEqual([
        "--remote",
        "--url",
        "unix:///run/podman/podman.sock",
      ]);
    }
    // The subcommand comes right after them, never before: a `podman run`
    // that reached the CLI first would already have chosen its engine.
    expect(calls.map((argv) => argv[3])).toEqual(["run", "exec", "rm", "images"]);
  });

  it("passes no --remote at all on the explicit local escape hatch", async () => {
    const podman = recorder();
    await exercise(podman.bin, null);

    const calls = podman.calls();
    expect(calls).toHaveLength(4);
    for (const argv of calls) {
      expect(argv).not.toContain("--remote");
      expect(argv).not.toContain("--url");
    }
    expect(calls.map((argv) => argv[0])).toEqual(["run", "exec", "rm", "images"]);
  });
});

/**
 * The parts of engine.ts that are plain process handling — capping the output,
 * the service's own clock, recognising a container that is gone — tested
 * against a `podman` that is a shell script. No container, no engine: this
 * runs in the default suite, on CI, on a laptop.
 */
describe("exec, against a fake podman", () => {
  let bin = "";

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "quiz-runner-"));
    bin = join(dir, "podman");
    // Arguments: exec -i -w /work <name> <argv...>  (no --remote: socket null)
    writeFileSync(bin, "#!/bin/sh\nshift 5\nexec \"$@\"\n");
    chmodSync(bin, 0o755);
  });

  const local = () => engine({ podmanBin: bin, socket: null });

  it("passes stdin through and brings stdout back", async () => {
    const result = await local().exec("c", {
      argv: ["cat"],
      stdin: "hello\n",
      timeoutMs: 5000,
      maxBytes: 1024,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "hello\n", truncated: false });
  });

  it("caps each stream at maxBytes and says so", async () => {
    const result = await local().exec("c", {
      argv: ["sh", "-c", "head -c 100000 /dev/zero | tr '\\0' 'x'"],
      stdin: "",
      timeoutMs: 10_000,
      maxBytes: 1024,
    });
    expect(result.stdout).toHaveLength(1024);
    expect(result.truncated).toBe(true);
  });

  it("caps stderr too", async () => {
    const result = await local().exec("c", {
      argv: ["sh", "-c", "head -c 5000 /dev/zero | tr '\\0' 'e' >&2"],
      stdin: "",
      timeoutMs: 10_000,
      maxBytes: 512,
    });
    expect(result.stderr).toHaveLength(512);
    expect(result.truncated).toBe(true);
  });

  it("gives up on its own clock, whatever the sandbox is doing", async () => {
    const started = Date.now();
    const result = await local().exec("c", {
      argv: ["sleep", "30"],
      stdin: "",
      timeoutMs: 300,
      maxBytes: 1024,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("survives a program that never reads its stdin", async () => {
    const result = await local().exec("c", {
      argv: ["true"],
      stdin: "x".repeat(200_000),
      timeoutMs: 5000,
      maxBytes: 1024,
    });
    expect(result.exitCode).toBe(0);
  });

  it("recognises a container that is not there any more", async () => {
    const result = await local().exec("c", {
      argv: ["sh", "-c", "echo 'Error: no such container' >&2; exit 125"],
      stdin: "",
      timeoutMs: 5000,
      maxBytes: 1024,
    });
    expect(result.containerGone).toBe(true);
    // Podman's complaint is not the program's output.
    expect(result.stderr).toBe("");
  });

  it("reports a missing binary instead of throwing", async () => {
    const result = await engine({ podmanBin: "/nonexistent/podman", socket: null }).exec("c", {
      argv: ["true"],
      stdin: "",
      timeoutMs: 5000,
      maxBytes: 1024,
    });
    expect(result.exitCode).toBeNull();
  });
});
