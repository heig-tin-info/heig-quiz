/**
 * The engine side of an admission (`admission.ts`) without an engine: the
 * admission container's `podman run` flag for flag — a session's hardening
 * and user, `--network none`, `--pull=never`, nothing from the host —, the
 * trusted file read, the parsers, and each command's argv through a fake
 * spawner. The portal never removes an image (ADR-146 §8).
 */
import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { type SpawnPodman } from "./helper.js";
import { hardeningArgs } from "./index.js";
import {
  ADMISSION_TMPFS,
  admissionArgs,
  createImageEngine,
  parseFreeBytes,
  parseImageInspect,
  parseStoreImages,
  readFileArgs,
  type ImageEngineOptions,
} from "./admission.js";
import { READER_LIMITS, READER_TMPFS } from "./reader.js";

const OPTIONS: ImageEngineOptions = {
  podmanUrl: "unix:///run/podman/podman.sock",
  instance: "prod",
  seccompProfile: "/etc/quiz-codespace/prod/seccomp.json",
  apparmorProfile: "codespace",
  cgroupParent: "codespace.slice",
  limits: { pidsLimit: 256, memory: "1536m", cpus: "1" },
};
const REF = `ghcr.io/heig/lab-go@sha256:${"c".repeat(64)}`;

describe("admissionArgs — the admission container, flag for flag", () => {
  it("is a session's hardening, limits and user, no network, no pull, no mount", () => {
    expect(admissionArgs(OPTIONS, "cs-prod-admission-x", REF)).toEqual([
      "run",
      "-d",
      "--pull=never",
      "--name",
      "cs-prod-admission-x",
      "--label",
      "heig-codespace.role=admission",
      "--label",
      "heig-codespace.instance=prod",
      ...hardeningArgs(OPTIONS, ADMISSION_TMPFS, OPTIONS.limits),
      "--network",
      "none",
      "--user",
      "1000:1000",
      REF,
    ]);
    const args = admissionArgs(OPTIONS, "n", REF);
    for (const flag of ["--userns=auto", "--cap-drop=ALL", "--read-only", "no-new-privileges", "--cgroup-parent=codespace.slice"]) {
      expect(args).toContain(flag);
    }
    expect(args).not.toContain("-v");
    expect(args).not.toContain("-e");
    expect(args).not.toContain("--rm");
    expect(args.some((a) => a.startsWith("--runtime") || a.startsWith("--privileged"))).toBe(false);
    expect(ADMISSION_TMPFS).toContain("/work:rw,nosuid,nodev,size=64m,mode=1777");
  });

  it("reads a trusted file in a throwaway confined helper", () => {
    const args = readFileArgs(OPTIONS, "cs-prod-admission-y", REF, "/usr/local/lib/quiz-base/check");
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "--pull=never"]);
    expect(args).toEqual(expect.arrayContaining(hardeningArgs(OPTIONS, [READER_TMPFS], READER_LIMITS)));
    expect(args.slice(-8)).toEqual(["--network", "none", "--user", "1000:1000", "--entrypoint", "/bin/cat", REF, "/usr/local/lib/quiz-base/check"]);
  });
});

describe("the parsers", () => {
  it("reads podman image inspect", () => {
    const out = JSON.stringify([
      { Id: "ab".repeat(32), Size: 123, RootFS: { Layers: ["sha256:1"] }, Config: { User: "student", Entrypoint: ["/e"], Cmd: null, Labels: { a: "b" } } },
    ]);
    expect(parseImageInspect(out)).toEqual({
      id: `sha256:${"ab".repeat(32)}`,
      sizeBytes: 123,
      diffIds: ["sha256:1"],
      user: "student",
      entrypoint: ["/e"],
      cmd: null,
      labels: { a: "b" },
    });
    expect(parseImageInspect(JSON.stringify({ Id: "sha256:x" }))).toMatchObject({ id: "sha256:x", diffIds: [], user: "" });
    expect(parseImageInspect("[]")).toBeNull();
    expect(parseImageInspect("not json")).toBeNull();
  });

  it("reads the store: every name, the size, the layers", () => {
    const out = JSON.stringify([
      { Id: "1", Size: 5, RepoTags: ["localhost/codespace/c-dev:4.137.0"], RepoDigests: ["ghcr.io/a/b@sha256:2"], RootFS: { Layers: ["sha256:l"] } },
      { Id: "2", RepoTags: null },
      { nothing: true },
    ]);
    expect(parseStoreImages(out)).toEqual([
      { id: "sha256:1", names: ["localhost/codespace/c-dev:4.137.0", "ghcr.io/a/b@sha256:2"], sizeBytes: 5, diffIds: ["sha256:l"] },
      { id: "sha256:2", names: [], sizeBytes: 0, diffIds: [] },
    ]);
  });

  it("reads the store's free bytes, or null", () => {
    expect(parseFreeBytes(JSON.stringify({ store: { graphRootAllocated: 100, graphRootUsed: 30 } }))).toBe(70);
    expect(parseFreeBytes(JSON.stringify({ store: {} }))).toBeNull();
    expect(parseFreeBytes("x")).toBeNull();
  });
});

/** A spawner answering each podman command by the longest matching prefix; records every argv and stdin. */
function fakePodman(answers: Record<string, { code?: number; out?: string; err?: string; hang?: boolean }>) {
  const calls: Array<{ args: string[]; stdin: string }> = [];
  const run: SpawnPodman = (args) => {
    const line = args.join(" ");
    const key = Object.keys(answers).filter((k) => line.startsWith(k)).sort((a, b) => b.length - a.length)[0] ?? "";
    const answer = answers[key] ?? { code: 0 };
    const script = answer.hang ? "sleep 5" : `cat >/dev/null; printf '%s' "$OUT"; printf '%s' "$ERR" >&2; exit ${answer.code ?? 0}`;
    const child = spawn("sh", ["-c", script], {
      stdio: "pipe",
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", OUT: answer.out ?? "", ERR: answer.err ?? "" },
    });
    const entry = { args, stdin: "" };
    calls.push(entry);
    const write = child.stdin.end.bind(child.stdin);
    child.stdin.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (typeof chunk === "string") entry.stdin = chunk;
      return (write as (...a: unknown[]) => unknown)(chunk, ...rest);
    }) as typeof child.stdin.end;
    return child;
  };
  return { run, calls };
}

describe("createImageEngine", () => {
  it("inspects, tests, pulls, reads the free disk and lists the store through podman; never rmi", async () => {
    const podman = fakePodman({
      "image inspect --format json ghcr": { out: JSON.stringify([{ Id: "sha256:1", Size: 5 }]) },
      "image exists": { code: 1 },
      pull: { code: 125, err: "Error: denied\n" },
      info: { out: JSON.stringify({ store: { graphRootAllocated: 10, graphRootUsed: 4 } }) },
      images: { out: "sha256:1\nsha256:2\nsha256:1\n" },
      "image inspect --format json sha256": { out: JSON.stringify([{ Id: "sha256:1", Size: 5 }, { Id: "sha256:2", Size: 6 }]) },
    });
    const engine = createImageEngine(OPTIONS, podman.run);
    expect((await engine.inspect(REF))?.sizeBytes).toBe(5);
    expect(await engine.exists(REF)).toBe(false);
    await expect(engine.pull(REF, 5000)).rejects.toMatchObject({ stderr: "Error: denied\n" });
    expect(await engine.freeBytes()).toBe(6);
    expect((await engine.listImages()).map((i) => i.sizeBytes)).toEqual([5, 6]);
    const argvs = podman.calls.map((c) => c.args);
    expect(argvs).toEqual([
      ["image", "inspect", "--format", "json", REF],
      ["image", "exists", REF],
      ["pull", "-q", REF],
      ["info", "--format", "json"],
      ["images", "--all", "--quiet", "--no-trunc"],
      ["image", "inspect", "--format", "json", "sha256:1", "sha256:2"],
    ]);
    expect(argvs.some((a) => a[0] === "rmi" || (a[0] === "image" && a[1] === "rm"))).toBe(false);
    // An empty store, and a store podman cannot list.
    expect(await createImageEngine(OPTIONS, fakePodman({ images: { out: "" } }).run).listImages()).toEqual([]);
    await expect(createImageEngine(OPTIONS, fakePodman({ images: { code: 125 } }).run).listImages()).rejects.toThrow(/podman images/);
    await expect(createImageEngine(OPTIONS, fakePodman({ images: { out: "x\n" }, "image inspect": { code: 125 } }).run).listImages()).rejects.toThrow(/inspect/);
  });

  it("starts, probes, checks over stdin, reads the logs, removes and sweeps its containers", async () => {
    const podman = fakePodman({
      "exec cs-prod-admission": { out: "{}" },
      "exec -i": { code: 1, out: "ok a\nFAIL b\n" },
      logs: { out: "out\n", err: "err\n" },
      ps: { out: "cs-prod-admission-1\nother\n" },
      "run --rm": { out: "#!/bin/sh\n" },
    });
    const engine = createImageEngine(OPTIONS, podman.run);
    const name = await engine.startAdmission(REF);
    expect(name).toMatch(/^cs-prod-admission-[0-9a-f-]{36}$/);
    expect(await engine.waitHealthy(name, 2000)).toBe(true);
    expect(await engine.runCheck(name, "echo check", 5000)).toEqual({ code: 1, stdout: "ok a\nFAIL b\n", stderr: "" });
    expect(await engine.logs(name, 20)).toBe("out\nerr\n");
    expect(await engine.readFile(REF, "/usr/local/lib/quiz-base/check", 5000)).toBe("#!/bin/sh\n");
    await engine.removeContainer(name);
    expect(await engine.sweep()).toBe(1);
    const argvs = podman.calls.map((c) => c.args);
    expect(argvs[1]).toEqual(["exec", name, "curl", "-fsS", "-m", "2", "http://127.0.0.1:8080/healthz"]);
    expect(argvs[2]).toEqual(["exec", "-i", "--user", "1000:1000", name, "/bin/sh", "-s"]);
    expect(podman.calls[2]?.stdin).toBe("echo check");
    expect(argvs).toContainEqual(["rm", "-f", "-t", "0", name]);
    expect(argvs).toContainEqual(["rm", "-f", "-t", "0", "cs-prod-admission-1"]);
    expect(argvs).not.toContainEqual(["rm", "-f", "-t", "0", "other"]);
  });

  it("a helper that fails or hangs is removed; a container that does not start throws", async () => {
    const podman = fakePodman({ "run -d": { code: 125, err: "Error: image not known\n" }, exec: { code: 7 } });
    const engine = createImageEngine(OPTIONS, podman.run);
    await expect(engine.startAdmission(REF)).rejects.toMatchObject({ stderr: "Error: image not known\n" });
    expect(podman.calls[1]?.args.slice(0, 4)).toEqual(["rm", "-f", "-t", "0"]);
    expect(await engine.waitHealthy("x", 10)).toBe(false);

    const hung = fakePodman({ "run --rm": { hang: true } });
    await expect(createImageEngine(OPTIONS, hung.run).readFile(REF, "/x", 300)).rejects.toThrow(/reading/);
    const name = hung.calls[0]?.args[hung.calls[0].args.indexOf("--name") + 1];
    expect(hung.calls.map((c) => c.args)).toContainEqual(["rm", "-f", "-t", "0", name]);

    const failed = fakePodman({ "run --rm": { code: 1 } });
    await expect(createImageEngine(OPTIONS, failed.run).readFile(REF, "/x", 5000)).rejects.toThrow(/reading/);
    expect(failed.calls.at(-1)?.args.slice(0, 4)).toEqual(["rm", "-f", "-t", "0"]);
  });
});
