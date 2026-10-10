import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { CONTAINER_ENV, createEngine, type CreateOptions } from "./engine.js";
import { FAKE_CAPABILITIES } from "./test/fakeEngine.js";

/** This process's containers, in the tests: fixed, because it is part of the argv. */
const INSTANCE = "11111111-1111-1111-1111-111111111111";

/**
 * A `podman` that appends its argv to a log, one argument per line, and
 * answers a `ps` with a canned body.
 *
 * It is a shell script and not a mock of `spawn`, so what it records is what
 * the operating system was really asked to execute.
 */
function recorder(psJson = ""): { bin: string; calls: () => string[][] } {
  const dir = mkdtempSync(join(tmpdir(), "quiz-runner-argv-"));
  const log = join(dir, "argv.log");
  const bin = join(dir, "podman");
  writeFileSync(
    bin,
    "#!/bin/sh\nlisting=0\n" +
      `for arg in "$@"; do printf '%s\\n' "$arg" >> ${log}\n` +
      '  [ "$arg" = ps ] && listing=1\ndone\n' +
      `printf '%s\\n' '@@END@@' >> ${log}\n` +
      `[ "$listing" = 1 ] && printf '%s' ${JSON.stringify(psJson)}\nexit 0\n`,
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
    cgroupParent: null,
    capabilities: FAKE_CAPABILITIES,
    instanceId: INSTANCE,
    ...overrides,
  });
}

describe("containerArgs", () => {
  it("is the hardening of run-hardened.sh, flag for flag", () => {
    expect(engine().containerArgs(CREATE)).toEqual([
      "run", "-d",
      "--name", "quiz-run-1",
      "--label", "quiz.runner=1",
      "--label", `quiz.runner.instance=${INSTANCE}`,
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
      "--ulimit", "core=0:0",
      "--pull=never",
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

  it("adds the slice after --cpus, and nothing else, when one is configured", () => {
    // M6-05: an ADDITION to the list above. Every hardening flag stays where
    // it is; only `--cgroup-parent=<slice>` is inserted.
    const plain = engine().containerArgs(CREATE);
    const sliced = engine({ cgroupParent: "quiz-runner.slice" }).containerArgs(CREATE);
    const at = plain.indexOf("--cpus") + 2;
    expect(sliced).toEqual([
      ...plain.slice(0, at),
      "--cgroup-parent=quiz-runner.slice",
      ...plain.slice(at),
    ]);
    expect(plain.some((arg) => arg.startsWith("--cgroup-parent"))).toBe(false);
  });

  it("never asks for a runtime: a --remote client cannot, and `podman run` has no such flag", () => {
    // gVisor is the Podman SERVICE's default runtime or nothing; passing
    // `--runtime` here made every `podman run` fail with "unknown flag"
    // (audit M6). `proveRuntime` checks what the service really runs.
    const gvisor = engine({ capabilities: { ...FAKE_CAPABILITIES, runtime: "runsc" } });
    expect(gvisor.containerArgs(CREATE)).toEqual(engine().containerArgs(CREATE));
    expect(gvisor.containerArgs(CREATE).some((arg) => arg.startsWith("--runtime"))).toBe(false);
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
 * are prepended by the spawner, for `exec`, `rm`, `images` and `ps` as well —
 * so no assertion on its list can see them. This is the only place that does:
 * delete the three lines that build them and every case below fails.
 */
describe("--remote --url, on every command the engine sends", () => {

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
    await subject.pruneOrphans();
  }

  it("prefixes every command it sends with the socket of the engine", async () => {
    const podman = recorder();
    await exercise(podman.bin, "/run/podman/podman.sock");

    const calls = podman.calls();
    expect(calls).toHaveLength(5);
    for (const argv of calls) {
      expect(argv.slice(0, 3)).toEqual([
        "--remote",
        "--url",
        "unix:///run/podman/podman.sock",
      ]);
    }
    // The subcommand comes right after them, never before: a `podman run`
    // that reached the CLI first would already have chosen its engine.
    expect(calls.map((argv) => argv[3])).toEqual(["run", "exec", "rm", "images", "ps"]);
  });

  it("passes no --remote at all on the explicit local escape hatch", async () => {
    const podman = recorder();
    await exercise(podman.bin, null);

    const calls = podman.calls();
    expect(calls).toHaveLength(5);
    for (const argv of calls) {
      expect(argv).not.toContain("--remote");
      expect(argv).not.toContain("--url");
    }
    expect(calls.map((argv) => argv[0])).toEqual(["run", "exec", "rm", "images", "ps"]);
  });
});

/**
 * Reaping, which has to be exact in BOTH directions: everything a dead
 * instance left behind, and nothing that belongs to a living one.
 */
describe("pruneOrphans", () => {
  const row = (id: string, instance: string | null): unknown => ({
    Id: id,
    Labels: {
      "quiz.runner": "1",
      ...(instance === null ? {} : { "quiz.runner.instance": instance }),
    },
  });

  it("removes another instance's containers and leaves its own alone", async () => {
    const podman = recorder(
      JSON.stringify([row("aaaa", "older-instance"), row("bbbb", INSTANCE), row("cccc", null)]),
    );
    const removed = await engine({ podmanBin: podman.bin, socket: null }).pruneOrphans();

    expect(removed).toBe(2);
    const calls = podman.calls();
    // The list comes first. A `rm -f --filter label=quiz.runner=1` would
    // force-kill a co-tenant's RUNNING container — a student's answer with it.
    expect(calls[0]).toEqual(["ps", "-a", "--filter", "label=quiz.runner=1", "--format", "json"]);
    // `bbbb` carries this instance's label and is not in the removal.
    expect(calls[1]).toEqual(["rm", "-f", "-t", "0", "aaaa", "cccc"]);
  });

  it("asks for nothing to be removed when every container is ours", async () => {
    const podman = recorder(JSON.stringify([row("bbbb", INSTANCE)]));
    const removed = await engine({ podmanBin: podman.bin, socket: null }).pruneOrphans();

    expect(removed).toBe(0);
    expect(podman.calls().map((argv) => argv[0])).toEqual(["ps"]);
  });

  it("removes nothing on an engine with no container at all", async () => {
    const podman = recorder("[]");
    expect(await engine({ podmanBin: podman.bin, socket: null }).pruneOrphans()).toBe(0);
    expect(podman.calls().map((argv) => argv[0])).toEqual(["ps"]);
  });

  it("gives every engine an instance of its own when none is configured", () => {
    const labelOf = (args: string[]): string | undefined =>
      args.find((arg) => arg.startsWith("quiz.runner.instance="));
    // An explicit `undefined` is what overrides the helper's default instance;
    // exactOptionalPropertyTypes rejects it, the engine must still cope.
    // @ts-expect-error -- see above
    const one = labelOf(engine({ instanceId: undefined }).containerArgs(CREATE));
    // @ts-expect-error -- see above
    const other = labelOf(engine({ instanceId: undefined }).containerArgs(CREATE));
    expect(one).toBeDefined();
    expect(one).not.toBe(other);
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

/**
 * Whether the container is gone is Podman's answer, never the program's
 * (security audit L12). The program writes to the same stderr Podman does and
 * picks its own exit code, so "no such container", 125 or 137 only make the
 * engine ASK — `podman container inspect` — and that answer alone blanks the
 * stderr, flags the case and makes `execute.ts` rebuild the container.
 *
 * The fake `podman` runs the "program" for an `exec` (so its stderr and exit
 * code are the test's to choose), answers `container inspect` from a state
 * file, and records every argv.
 */
describe("a container that is gone, as Podman says it", () => {
  function fakePodman(): {
    bin: string;
    state: (value: "running" | "stopped" | "missing") => void;
    calls: () => string[][];
  } {
    const dir = mkdtempSync(join(tmpdir(), "quiz-runner-gone-"));
    const log = join(dir, "argv.log");
    const stateFile = join(dir, "state");
    const bin = join(dir, "podman");
    writeFileSync(log, "");
    writeFileSync(
      bin,
      "#!/bin/sh\n" +
        `for arg in "$@"; do printf '%s\\n' "$arg" >> ${log}; done\n` +
        `printf '%s\\n' '@@END@@' >> ${log}\n` +
        '[ "$1" = --remote ] && shift 3\n' +
        'if [ "$1" = exec ]; then shift 5; exec "$@"; fi\n' +
        `case "$(cat ${stateFile})" in\n` +
        "  running) echo true ;;\n" +
        "  stopped) echo false ;;\n" +
        "  *) echo 'Error: no such container c' >&2; exit 125 ;;\n" +
        "esac\n",
    );
    chmodSync(bin, 0o755);
    return {
      bin,
      state: (value) => writeFileSync(stateFile, value),
      calls: () =>
        readFileSync(log, "utf8")
          .split("@@END@@\n")
          .filter((block) => block !== "")
          .map((block) => block.split("\n").filter((line) => line !== "")),
    };
  }

  const SOCKET = ["--remote", "--url", "unix:///run/podman/podman.sock"];
  const INSPECT = [...SOCKET, "container", "inspect", "--format", "{{.State.Running}}", "c"];

  async function program(podman: ReturnType<typeof fakePodman>, script: string) {
    return engine({ podmanBin: podman.bin }).exec("c", {
      argv: ["sh", "-c", script],
      stdin: "",
      timeoutMs: 5000,
      maxBytes: 1024,
    });
  }

  it("keeps a program's stderr, and its container, when it only SAYS the container is gone", async () => {
    const podman = fakePodman();
    podman.state("running");
    const result = await program(podman, "echo 'Error: no such container' >&2; exit 125");

    expect(result).toMatchObject({
      exitCode: 125,
      containerGone: false,
      stderr: "Error: no such container\n",
    });
    // The words raised the question; Podman, over the same socket, answered it.
    expect(podman.calls().slice(1)).toEqual([INSPECT]);
  });

  it("takes the words of a program that exits 1 for what they are", async () => {
    const podman = fakePodman();
    podman.state("running");
    const result = await program(
      podman,
      "echo 'can only create exec sessions on running containers' >&2; exit 1",
    );
    expect(result).toMatchObject({ exitCode: 1, containerGone: false });
    expect(result.stderr).toContain("can only create exec sessions");
  });

  it("asks about a SIGKILL, and believes the answer either way", async () => {
    const podman = fakePodman();
    podman.state("running");
    const alive = await program(podman, "echo partial >&2; exit 137");
    expect(alive).toMatchObject({ exitCode: 137, containerGone: false, stderr: "partial\n" });

    podman.state("stopped");
    const dead = await program(podman, "exit 137");
    expect(dead).toMatchObject({ exitCode: 137, containerGone: true });
    expect(podman.calls().filter((argv) => argv.includes("inspect"))).toEqual([INSPECT, INSPECT]);
  });

  it("calls a container gone when Podman no longer knows it, and drops Podman's complaint", async () => {
    const podman = fakePodman();
    podman.state("missing");
    const result = await program(podman, "echo 'Error: no such container c' >&2; exit 125");
    expect(result).toMatchObject({ exitCode: 125, containerGone: true, stderr: "" });
  });

  it("asks nothing about a program that succeeds, or fails in its own words", async () => {
    const podman = fakePodman();
    podman.state("missing");
    expect(await program(podman, "exit 0")).toMatchObject({ containerGone: false });
    const failed = await program(podman, "echo 'segfault' >&2; exit 139");
    expect(failed).toMatchObject({ exitCode: 139, containerGone: false, stderr: "segfault\n" });
    expect(podman.calls().filter((argv) => argv.includes("inspect"))).toEqual([]);
  });
});
