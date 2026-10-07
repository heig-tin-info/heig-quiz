/**
 * Two portals on one Podman engine (M6-04: `prod` and `staging` on the
 * engine VM). Each reconciles against its own database and removes the
 * session containers it does not know, so the engine must never show, stop
 * or remove another instance's container. The fake Podman below IGNORES the
 * `--filter` arguments on purpose: the engine's own check is what is tested,
 * not Podman's filtering.
 */
import { describe, expect, it } from "vitest";

import { loadConfig } from "../auth/config.js";
import { openDb } from "../db/client.js";
import { containerNameFor, createSessionManager } from "../sessions/manager.js";

import { INSTANCE_LABEL, SESSION_LABEL, createEngine, type PodmanRunner } from "./index.js";

interface FakeContainer {
  id: string;
  name: string;
  labels: Record<string, string>;
}

function fakePodman(containers: FakeContainer[]) {
  const calls: string[][] = [];
  const runner: PodmanRunner = async (argv) => {
    // argv = --remote --url <socket> <command> ...
    const args = argv.slice(3);
    calls.push(args);
    const find = (key: string): FakeContainer | undefined =>
      containers.find((c) => c.name === key || c.id === key);
    switch (args[0]) {
      case "ps":
        return JSON.stringify(
          containers.map((c) => ({ Id: c.id, Names: [c.name], State: "running", Labels: c.labels })),
        );
      case "inspect": {
        const c = find(args[1] ?? "");
        if (!c) throw new Error("no such container");
        return JSON.stringify([
          {
            Id: c.id,
            Name: c.name,
            State: { Status: "running" },
            Config: { Labels: c.labels },
            NetworkSettings: { Networks: { codespace: { IPAddress: "10.77.0.9" } } },
          },
        ]);
      }
      case "rm":
      case "stop": {
        const c = find(args.at(-1) ?? "");
        if (c) containers.splice(containers.indexOf(c), 1);
        return "";
      }
      default:
        return "";
    }
  };
  return { runner, calls, containers };
}

function engineFor(instance: string, runner: PodmanRunner) {
  return createEngine({
    podmanUrl: "unix:///run/podman/podman.sock",
    instance,
    network: "codespace",
    gateway: "10.77.0.254",
    seccompProfile: "/etc/quiz-codespace/prod/seccomp.json",
    image: "codespace/c-dev:4.137.0",
    memory: "1536m",
    cpus: "1",
    pidsLimit: 256,
    podmanRunner: runner,
  });
}

/** One session of each instance, one from before M6-04, and the anchor. */
function mixedHost(): FakeContainer[] {
  return [
    {
      id: "p1",
      name: "cs-prod-a",
      labels: { [SESSION_LABEL]: "a", [INSTANCE_LABEL]: "prod" },
    },
    {
      id: "s1",
      name: "cs-staging-b",
      labels: { [SESSION_LABEL]: "b", [INSTANCE_LABEL]: "staging" },
    },
    { id: "l1", name: "cs-c", labels: { [SESSION_LABEL]: "c" } },
    { id: "x1", name: "codespace-anchor", labels: { "heig-codespace.role": "anchor" } },
  ];
}

describe("engine — one instance among several on the same Podman", () => {
  it("labels every session container with its instance", () => {
    const { runner } = fakePodman([]);
    const args = engineFor("staging", runner).runArgs({
      sessionId: "b",
      name: containerNameFor("b", "staging"),
      workDir: "/srv/quiz-codespace/staging/volumes/s/a/work",
    });
    expect(args).toContain(`${INSTANCE_LABEL}=staging`);
    expect(args).toContain(`${SESSION_LABEL}=b`);
    expect(args).toContain("cs-staging-b");
  });

  it("asks Podman for its own instance's sessions only", async () => {
    const { runner, calls } = fakePodman(mixedHost());
    await engineFor("prod", runner).listSessions();
    const ps = calls.find((c) => c[0] === "ps");
    expect(ps).toContain(`label=${SESSION_LABEL}`);
    expect(ps).toContain(`label=${INSTANCE_LABEL}=prod`);
  });

  it("lists only its own sessions, even when Podman hands back everything", async () => {
    const { runner } = fakePodman(mixedHost());
    expect((await engineFor("prod", runner).listSessions()).map((c) => c.sessionId)).toEqual(["a"]);
    expect((await engineFor("staging", runner).listSessions()).map((c) => c.sessionId)).toEqual([
      "b",
    ]);
  });

  it("never stops nor removes another instance's container, a legacy one or the anchor", async () => {
    const { runner, calls, containers } = fakePodman(mixedHost());
    const prod = engineFor("prod", runner);
    for (const name of ["cs-staging-b", "cs-c", "codespace-anchor"]) {
      await prod.stop(name);
      await prod.rm(name);
    }
    expect(calls.filter((c) => c[0] === "rm" || c[0] === "stop")).toEqual([]);
    expect(containers.map((c) => c.name)).toEqual([
      "cs-prod-a",
      "cs-staging-b",
      "cs-c",
      "codespace-anchor",
    ]);

    await prod.rm("cs-prod-a");
    expect(containers.map((c) => c.name)).not.toContain("cs-prod-a");
  });

  it("a reconciliation with an empty database removes its own orphans and nothing else", async () => {
    const { runner, containers } = fakePodman(mixedHost());
    const handle = openDb(":memory:");
    try {
      const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
      const manager = createSessionManager({
        db: handle.db,
        engine: engineFor("prod", runner),
        instance: "prod",
        volumesRoot: "/nonexistent",
        graceMs: 60_000,
        gcIntervalMs: 60_000,
        shadowIntervalMs: 60_000,
        healthTimeoutMs: 1_000,
        gitRemoteHost: "portal.internal",
        gitRemotePort: 9418,
        log,
      });
      expect(await manager.reconcile()).toEqual({ resumed: 0, stopped: 0, orphans: 1 });
      expect(containers.map((c) => c.name)).toEqual(["cs-staging-b", "cs-c", "codespace-anchor"]);
    } finally {
      handle.close();
    }
  });

  it("puts the instance in the container name", () => {
    expect(containerNameFor("x", "prod")).toBe("cs-prod-x");
    expect(containerNameFor("x")).toBe("cs-default-x");
  });
});

describe("CODESPACE_INSTANCE", () => {
  it("defaults to `default`", () => {
    expect(loadConfig({}).CODESPACE_INSTANCE).toBe("default");
  });

  it("accepts a closed charset only", () => {
    expect(loadConfig({ CODESPACE_INSTANCE: "staging" }).CODESPACE_INSTANCE).toBe("staging");
    for (const bad of ["Prod", "pr od", "prod;rm", "a-b", "", "1prod", "x".repeat(17)]) {
      expect(() => loadConfig({ CODESPACE_INSTANCE: bad }), bad).toThrow(/CODESPACE_INSTANCE/);
    }
  });

  it("is refused by the engine too", () => {
    expect(() => engineFor("a=b", fakePodman([]).runner)).toThrow(/invalid engine instance/);
  });
});
