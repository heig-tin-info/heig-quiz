/**
 * The root timer's sandbox (`deploy/quiz-codespace-shadow@.service`, ADR-130
 * as corrected on 2026-11-16): the snapshot it takes is never published, and
 * what a race in it can reach stays small — one writable tree, the
 * instance's volumes, under an empty `/srv`; no device, network, home or
 * other process; none of the engine VM's secrets. Read from the unit file,
 * as `classroom/caddyfile.test.ts` reads the Caddyfile; `systemd-analyze
 * verify` and a run on staging are the deploy's checks.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const UNIT = readFileSync(new URL("../../deploy/quiz-codespace-shadow@.service", import.meta.url), "utf8");

/** Every value of `key` in the unit, in order. */
const values = (key: string) => [...UNIT.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1]!.trim());

describe("quiz-codespace-shadow@.service — the root timer's sandbox", () => {
  it("still runs the snapshot script on the instance's volumes", () => {
    expect(values("ExecStart")).toEqual(["/usr/local/lib/quiz-codespace/shadow-snapshot.sh"]);
    expect(values("Environment")).toEqual(["CODESPACE_VOLUMES=/srv/quiz-codespace/%i/volumes"]);
  });

  it("writes only the instance's volumes, under an otherwise empty /srv", () => {
    expect(values("ProtectSystem")).toEqual(["strict"]);
    expect(values("TemporaryFileSystem")).toEqual(["/srv:ro"]);
    expect(values("BindPaths")).toEqual(["/srv/quiz-codespace/%i/volumes"]);
    expect(values("ReadWritePaths")).toEqual(["/srv/quiz-codespace/%i/volumes"]);
  });

  it("hides the secrets of the engine VM and the other workloads", () => {
    const hidden = values("InaccessiblePaths").flatMap((v) => v.split(/\s+/)).map((p) => p.replace(/^-/, ""));
    for (const path of ["/etc/quiz-codespace", "/etc/quiz-runner", "/etc/codespace", "/etc/caddy", "/var/lib/caddy", "/etc/ssh", "/etc/shadow", "/etc/gshadow", "/var/lib/containers", "/run/podman"]) {
      expect(hidden, path).toContain(path);
    }
    expect(values("ProtectHome")).toEqual(["yes"]);
  });

  it("has no device, no network, no other process, no new privilege, and only the file-mode capabilities", () => {
    for (const [key, value] of [
      ["PrivateTmp", "yes"],
      ["PrivateDevices", "yes"],
      ["PrivateNetwork", "yes"],
      ["PrivatePIDs", "yes"],
      ["ProtectProc", "invisible"],
      ["ProcSubset", "pid"],
      ["NoNewPrivileges", "yes"],
      ["RestrictAddressFamilies", "AF_UNIX"],
      ["CapabilityBoundingSet", "CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH"],
    ] as const) {
      expect(values(key), key).toEqual([value]);
    }
  });
});
