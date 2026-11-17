/**
 * A stand-in for `podman --remote` in the unit suite: it runs the reader's
 * own commands (`READER_INIT`, `READER_LIST`, `READER_ARCHIVE`) on the host,
 * `/work` and `/tmp` mapped to directories, and records every call. It
 * confines NOTHING: it serves the collection's behaviour tests and the
 * reader's lifecycle tests. The confinement itself is proved against a real
 * engine (`reader.integration.test.ts`).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SpawnPodman } from "./reader.js";

export interface LocalPodman {
  spawn: SpawnPodman;
  /** Every argv given to `podman`, in order. */
  calls: string[][];
  /** The readers started and not removed. */
  live(): string[];
}

export interface LocalPodmanOptions {
  /** `podman run` fails. */
  failRun?: boolean;
  /** The archive's exec never ends (a stuck engine). */
  hangArchive?: boolean;
  /** The archive's exec prints this file instead of running tar (a hostile stream). */
  archiveFile?: string;
}

const sh = (script: string) => spawn("sh", ["-c", script], { stdio: "pipe" });

export function localPodman(opts: LocalPodmanOptions = {}): LocalPodman {
  const calls: string[][] = [];
  const state = new Map<string, { work: string; tmp: string }>();

  const run: SpawnPodman = (args) => {
    calls.push(args);
    const [command] = args;
    if (command === "run") {
      if (opts.failRun) return sh("echo 'Error: no such image' >&2; exit 125");
      const name = args[args.indexOf("--name") + 1]!;
      const volume = args[args.indexOf("-v") + 1]!;
      state.set(name, { work: volume.slice(0, volume.indexOf(":/work")), tmp: mkdtempSync(join(tmpdir(), "reader-tmp-")) });
      return sh("echo 0123456789ab");
    }
    if (command === "exec") {
      const at = args[1] === "-i" ? 2 : 1;
      const box = state.get(args[at]!);
      if (!box) return sh("echo 'Error: no such container' >&2; exit 125");
      const argv = args.slice(at + 1).map((a) => a.replace("/tmp/", `${box.tmp}/`).replace(/(^|=)\/work$/, `$1${box.work}`));
      if (argv[0]!.endsWith("/tar")) {
        if (opts.hangArchive) return spawn("sleep", ["30"], { stdio: "pipe" });
        if (opts.archiveFile) return spawn("cat", [opts.archiveFile], { stdio: "pipe" });
      }
      return spawn(argv[0]!, argv.slice(1), { stdio: "pipe", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/nonexistent" } });
    }
    if (command === "rm") {
      const name = args[args.length - 1]!;
      const box = state.get(name);
      if (box) rmSync(box.tmp, { recursive: true, force: true });
      state.delete(name);
      return sh("true");
    }
    if (command === "ps") return spawn("printf", ["%s\\n", ...state.keys()], { stdio: "pipe" });
    return sh(`echo 'unexpected podman ${command}' >&2; exit 125`);
  };

  return { spawn: run, calls, live: () => [...state.keys()] };
}
