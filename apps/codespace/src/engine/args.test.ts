/**
 * The slice of the session containers (M6-05): `CODESPACE_CGROUP_PARENT`
 * adds `--cgroup-parent=<slice>` to the Podman arguments, and nothing else.
 * Pure (no Podman), so in the unit suite, unlike `index.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { loadConfig } from "../auth/config.js";

import { createEngine } from "./index.js";

function runArgs(cgroupParent?: string): string[] {
  return createEngine({
    podmanUrl: "unix:///run/podman/podman.sock",
    instance: "prod",
    network: "codespace",
    gateway: "10.77.0.254",
    seccompProfile: "/repo/infra/seccomp/codespace.json",
    apparmorProfile: "codespace",
    image: "codespace/c-dev:4.137.0",
    memory: "1536m",
    cpus: "1",
    pidsLimit: 256,
    ...(cgroupParent === undefined ? {} : { cgroupParent }),
  }).runArgs({ sessionId: "s1", name: "cs-s1", workDir: "/vol/student/tp/work" });
}

describe("engine.runArgs — the slice (M6-05)", () => {
  it("adds --cgroup-parent after --cpus, and nothing else, when a slice is configured", () => {
    const plain = runArgs();
    const at = plain.indexOf("--cpus") + 2;
    expect(runArgs("codespace.slice")).toEqual([
      ...plain.slice(0, at),
      "--cgroup-parent=codespace.slice",
      ...plain.slice(at),
    ]);
    expect(plain.some((a) => a.startsWith("--cgroup-parent"))).toBe(false);
    expect(runArgs("")).toEqual(plain);
  });

  it("takes a slice unit name or nothing", () => {
    expect(loadConfig({}).CODESPACE_CGROUP_PARENT).toBe("");
    expect(loadConfig({ CODESPACE_CGROUP_PARENT: "codespace.slice" }).CODESPACE_CGROUP_PARENT).toBe(
      "codespace.slice",
    );
    for (const bad of ["/sys/fs/cgroup/x", "codespace", "-x.slice", "a b.slice", "a/b.slice"]) {
      expect(() => loadConfig({ CODESPACE_CGROUP_PARENT: bad }), bad).toThrow(
        /CODESPACE_CGROUP_PARENT/,
      );
    }
  });
});
