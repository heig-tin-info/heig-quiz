/**
 * The collection's confined reader (`reader.ts`) without an engine: its
 * `podman run` asserted flag for flag, its listing parsed as data, and its
 * lifecycle — removed on every exit path, the timeout included, never a
 * session — through `localPodman`. Its confinement is proved on a real
 * engine by `reader.integration.test.ts`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { tempDir } from "../git/fixtures.js";
import { INSTANCE_LABEL, SESSION_LABEL, createEngine, hardeningArgs, sessionListArgs } from "./index.js";
import {
  READER_ARCHIVE,
  READER_INIT,
  READER_LIST,
  ReaderError,
  ReaderTimeout,
  createWorkspaceReader,
  parseListing,
  readerArgs,
} from "./reader.js";
import { localPodman, type LocalPodmanOptions } from "./readerFixtures.js";

const OPTIONS = {
  podmanUrl: "unix:///run/podman/podman.sock",
  instance: "prod",
  seccompProfile: "/etc/quiz-codespace/prod/seccomp.json",
  apparmorProfile: "codespace",
  image: "codespace/c-dev:4.137.0",
  cgroupParent: "codespace.slice",
};
const NAME = "cs-prod-reader-00000000-0000-4000-8000-000000000000";
const WORK = "/srv/quiz-codespace/prod/volumes/alice/lab3/work";

describe("readerArgs — the reader's podman run, flag for flag", () => {
  const args = readerArgs(OPTIONS, NAME, WORK, 45);

  it("is exactly this list", () => {
    expect(args).toEqual([
      "run",
      "-d",
      "--rm",
      "--name",
      NAME,
      "--label",
      "heig-codespace.role=reader",
      "--label",
      "heig-codespace.instance=prod",
      "--userns=auto",
      "--cap-drop=ALL",
      "--security-opt",
      "no-new-privileges",
      "--security-opt",
      "seccomp=/etc/quiz-codespace/prod/seccomp.json",
      "--security-opt",
      "apparmor=codespace",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=8m",
      "--pids-limit",
      "32",
      "--memory",
      "256m",
      "--cpus",
      "1",
      "--cgroup-parent=codespace.slice",
      "--network",
      "none",
      "--user",
      "1000:1000",
      "-v",
      `${WORK}:/work:ro,nosuid,nodev,noexec`,
      "--entrypoint",
      "/usr/bin/sleep",
      "codespace/c-dev:4.137.0",
      "45",
    ]);
  });

  it("carries the sessions' hardening as it is, only the tmpfs and the limits differ", () => {
    const session = createEngine({ ...OPTIONS, network: "codespace", gateway: "10.77.0.254", memory: "1536m", cpus: "1", pidsLimit: 256 }).runArgs({
      sessionId: "s1",
      name: "cs-prod-s1",
      workDir: WORK,
    });
    const shared = hardeningArgs(OPTIONS, [], { pidsLimit: 0, memory: "", cpus: "" }).filter((a) => !["--pids-limit", "--memory", "--cpus", "0", ""].includes(a));
    for (const flag of shared) {
      expect(session).toContain(flag);
      expect(args).toContain(flag);
    }
  });

  it("is no session: no session label, so neither the listing, the reconciliation nor the quota sees it", () => {
    expect(args.some((a) => a.startsWith(`${SESSION_LABEL}=`))).toBe(false);
    expect(sessionListArgs("prod")).toContain(`label=${SESSION_LABEL}`);
    expect(args).toContain(`${INSTANCE_LABEL}=prod`);
  });

  it("has no network, no variable of ours and nothing that could carry one, and mounts the volume read-only, never :U", () => {
    expect(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2)).toEqual(["--network", "none"]);
    for (const argv of [args, [...READER_INIT], [...READER_LIST], [...READER_ARCHIVE]]) {
      expect(argv.some((a) => /^(-e|--env|--env-file|--env-host|--env-merge|--secret|--add-host|--dns)(=|$)/.test(a))).toBe(false);
      expect(argv.join(" ")).not.toMatch(/CODESPACE_|GIT_AUTHOR|GIT_COMMITTER|TOKEN|SECRET/);
    }
    const volumes = args.filter((_, i) => args[i - 1] === "-v");
    expect(volumes).toEqual([`${WORK}:/work:ro,nosuid,nodev,noexec`]);
    expect(volumes[0]).not.toMatch(/:U\b|,U\b/);
  });

  it("drops the AppArmor flag and the slice when they are not configured, like a session", () => {
    const bare = readerArgs({ ...OPTIONS, apparmorProfile: "", cgroupParent: "" }, NAME, WORK, 45);
    expect(bare.some((a) => a.startsWith("apparmor="))).toBe(false);
    expect(bare.some((a) => a.startsWith("--cgroup-parent"))).toBe(false);
  });

  it("runs fixed argv arrays: git on a throwaway repository, never the student's .git, and tar of the listing only", () => {
    expect(READER_LIST).toContain("--git-dir=/tmp/list.git");
    expect(READER_LIST.join(" ")).not.toMatch(/\/work\/\.git/);
    expect(READER_ARCHIVE).toEqual(expect.arrayContaining(["--no-recursion", "--hard-dereference", "--files-from=-", "--null", "--verbatim-files-from", "--no-unquote", "--format=gnu"]));
    expect(READER_ARCHIVE).not.toContain("--dereference");
    expect(READER_ARCHIVE).not.toContain("-h");
  });
});

describe("parseListing", () => {
  const z = (...names: (string | Buffer)[]) => Buffer.concat(names.map((n) => Buffer.concat([typeof n === "string" ? Buffer.from(n) : n, Buffer.from([0])])));

  it("keeps the paths, leaves out a nested repository, counts a name that is not UTF-8, and reads the closed directories", () => {
    const listing = parseListing(
      z("main.c", "vendor/", "src/a b.c", Buffer.from([0x61, 0xff])),
      "warning: could not open directory 'private/': Permission denied\nwarning: could not open directory '.': Permission denied\nnoise\n",
    );
    expect(listing).toEqual({ paths: ["main.c", "src/a b.c"], closed: ["private", ""], undecodable: 1 });
  });

  it("refuses a listing no git prints", () => {
    for (const bad of ["/etc/passwd", "a/../b", ".git/config", "a//b"]) expect(() => parseListing(z(bad), ""), bad).toThrow(ReaderError);
    expect(() => parseListing(Buffer.from("no-terminator"), "")).toThrow(ReaderError);
  });
});

async function workspace(): Promise<string> {
  const dir = await tempDir("reader-test-");
  await mkdir(join(dir, "work"));
  await writeFile(join(dir, "work", "main.c"), "int main;\n");
  return join(dir, "work");
}

/** The reader over `localPodman`, and what it was asked. */
function reader(opts: LocalPodmanOptions = {}) {
  const podman = localPodman(opts);
  return { podman, reader: createWorkspaceReader(OPTIONS, podman.spawn) };
}

const drain = async (_: unknown, archive: AsyncIterable<Buffer>) => {
  let n = 0;
  for await (const c of archive) n += c.length;
  return n;
};

describe("the reader's lifecycle", () => {
  it("lists, archives and is removed", async () => {
    const { podman, reader: r } = reader();
    const size = await r.read(await workspace(), 10_000, async (listing, archive) => {
      expect(listing.paths).toEqual(["main.c"]);
      return drain(listing, archive);
    });
    expect(size).toBeGreaterThan(1024);
    expect(podman.live()).toEqual([]);
    const name = podman.calls[0]![podman.calls[0]!.indexOf("--name") + 1]!;
    expect(name).toMatch(/^cs-prod-reader-[0-9a-f-]{36}$/);
    expect(podman.calls.at(-1)).toEqual(["rm", "-f", "-t", "0", name]);
  });

  it("is removed when it cannot start, when the consumer throws, and past its time, the timeout included", async () => {
    const work = await workspace();
    const failing = reader({ failRun: true });
    await expect(failing.reader.read(work, 10_000, drain)).rejects.toBeInstanceOf(ReaderError);
    expect(failing.podman.calls.at(-1)?.[0]).toBe("rm");

    const refusing = reader();
    await expect(
      refusing.reader.read(work, 10_000, async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(refusing.podman.live()).toEqual([]);

    const stuck = reader({ hangArchive: true });
    const started = Date.now();
    await expect(stuck.reader.read(work, 1_000, drain)).rejects.toBeInstanceOf(ReaderTimeout);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(stuck.podman.live()).toEqual([]);

    // A consumer that stops reading cannot hold the reader past its time either.
    const idle = reader({ hangArchive: true });
    await expect(idle.reader.read(work, 1_000, () => new Promise<never>(() => undefined))).rejects.toBeInstanceOf(ReaderTimeout);
    expect(idle.podman.live()).toEqual([]);
  });

  it("lives no longer than the time it is given", async () => {
    const { podman, reader: r } = reader();
    await r.read(await workspace(), 3_200, drain);
    expect(podman.calls[0]!.at(-1)).toBe("4");
  });

  it("sweeps only this instance's readers", async () => {
    const { podman, reader: r } = reader({ hangArchive: true });
    await expect(r.read(await workspace(), 500, drain)).rejects.toBeInstanceOf(ReaderTimeout);
    expect(await r.sweep()).toBe(0);
    const ps = podman.calls.find((c) => c[0] === "ps")!;
    expect(ps).toEqual(["ps", "--all", "--filter", "label=heig-codespace.role=reader", "--filter", "label=heig-codespace.instance=prod", "--format", "{{.Names}}"]);
  });
});
