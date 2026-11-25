/**
 * A real admission (ADR-146 §5), never in CI: the registry read
 * anonymously, a pull by digest on the rootful socket, the admission
 * container under the session's hardening and the released base's own
 * check. Run with `pnpm test:integration` and:
 *
 *   QUIZ_BASE=ghcr.io/heig-tin-info/quiz-base@sha256:…   a released base, public
 *   ADMISSION_IMAGE=ghcr.io/<owner>/<image>:<tag>        an image FROM it, public
 *
 * plus what the other integration suites need (the rootful socket, the
 * seccomp profile, `CODESPACE_APPARMOR_PROFILE` empty on a host without
 * AppArmor). Skipped when either variable is missing. The pulled image
 * stays in the store (the portal never removes one): remove it by hand.
 */
import { createOciClient } from "@quiz/core/oci";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../auth/config.js";
import { openDb } from "../db/client.js";
import { createImageEngine } from "../engine/admission.js";

import { createImageAdmissions } from "./admission.js";

const base = process.env["QUIZ_BASE"];
const candidate = process.env["ADMISSION_IMAGE"];

describe.skipIf(!base || !candidate)("a real admission", () => {
  it("admits an image derived from the released base, then un-admits it", async () => {
    const config = loadConfig({ ...process.env, CODESPACE_DEFAULT_IMAGE: base, DATABASE_PATH: ":memory:" });
    const handle = openDb(":memory:");
    const engine = createImageEngine({
      podmanUrl: config.PODMAN_URL,
      instance: "itest",
      seccompProfile: config.seccompProfile,
      apparmorProfile: config.CODESPACE_APPARMOR_PROFILE,
      cgroupParent: config.CODESPACE_CGROUP_PARENT,
      limits: { pidsLimit: config.CODESPACE_PIDS_LIMIT, memory: config.CODESPACE_MEMORY, cpus: config.CODESPACE_CPUS },
    });
    const log = { info: console.log, warn: console.warn, error: console.error };
    const admissions = createImageAdmissions({
      db: handle.db,
      registry: createOciClient(),
      engine,
      defaultImage: config.CODESPACE_DEFAULT_IMAGE,
      baseReleases: config.baseReleases,
      maxBytes: config.CODESPACE_IMAGE_MAX_BYTES,
      minFreeBytes: 0,
      healthTimeoutMs: 60_000,
      log,
    });
    try {
      await admissions.startup();
      const asked = await admissions.request(candidate ?? "");
      expect(asked.status).toBe(202);
      if (asked.status !== 202) return;
      await admissions.idle();
      const row = admissions.get(asked.admission.reference);
      expect(row, JSON.stringify(row)).toMatchObject({ state: "ready", reason: null });
      expect(await admissions.runnable(asked.admission.reference)).toBe(true);
      expect((await admissions.list()).some((i) => i.admissions.some((x) => x.reference === asked.admission.reference))).toBe(true);
      // Un-admitted only: the store keeps the image (ADR-146 §8).
      expect(await admissions.remove(asked.admission.reference)).toBe("removed");
      expect(await engine.exists(asked.admission.reference)).toBe(true);
      expect(await engine.sweep()).toBe(0);
    } finally {
      handle.close();
    }
  }, 30 * 60_000);
});
