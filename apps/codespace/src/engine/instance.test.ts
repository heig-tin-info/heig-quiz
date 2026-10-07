/**
 * Two portals on one Podman engine (M6-04: `prod` and `staging` on the
 * engine VM). Each reconciles against its own database and removes the
 * session containers it does not know, so what an engine lists, names and
 * labels must be its own instance's only. Asserted on the Podman arguments.
 */
import { describe, expect, it } from "vitest";

import { loadConfig } from "../auth/config.js";

import { INSTANCE_LABEL, SESSION_LABEL, createEngine, sessionListArgs } from "./index.js";

function engineFor(instance: string) {
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
  });
}

describe("engine — one instance among several on the same Podman", () => {
  it("labels and names every session container with its instance", () => {
    const staging = engineFor("staging");
    const name = staging.containerName("b");
    const args = staging.runArgs({ sessionId: "b", name, workDir: "/srv/x/volumes/s/a/work" });
    expect(name).toBe("cs-staging-b");
    expect(args).toContain(`${INSTANCE_LABEL}=staging`);
    expect(args).toContain(`${SESSION_LABEL}=b`);
    expect(args).toContain("cs-staging-b");
  });

  it("never names another instance's container", () => {
    expect(engineFor("prod").containerName("x")).not.toBe(engineFor("staging").containerName("x"));
  });

  it("lists its own instance's sessions only: both labels, ANDed by Podman", () => {
    const args = sessionListArgs("prod");
    expect(args.slice(0, 2)).toEqual(["ps", "--all"]);
    const filters = args.flatMap((a, i) => (args[i - 1] === "--filter" ? [a] : []));
    expect(filters).toEqual([`label=${SESSION_LABEL}`, `label=${INSTANCE_LABEL}=prod`]);
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
    expect(() => engineFor("a=b")).toThrow(/invalid engine instance/);
  });
});
