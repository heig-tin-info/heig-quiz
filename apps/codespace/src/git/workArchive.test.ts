/**
 * The reader's archive, judged as data (`workArchive.ts`): GNU tar's own
 * output passes, links are kept as links and never followed, and every
 * hostile stream — a header no tar of a listed path writes, a size that
 * lies, a stream cut short — refuses the whole archive. The hostile headers
 * are written by hand here, as a compromised reader could write them.
 */
import { execFile } from "node:child_process";
import { mkdir, symlink, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { tempDir } from "./fixtures.js";
import { ArchiveRefused, ArchiveTooLarge, readWorkArchive, type ArchiveSink } from "./workArchive.js";

const run = promisify(execFile);
const BLOCK = 512;

/** One GNU header block (`ustar  \0`), its checksum computed; `raw` overrides any byte range. */
function header(name: string | Buffer, type: string, size: number, opts: { mode?: number; link?: string; raw?: [number, Buffer][] } = {}): Buffer {
  const block = Buffer.alloc(BLOCK);
  (typeof name === "string" ? Buffer.from(name, "utf8") : name).copy(block, 0, 0, 100);
  block.write(`${(opts.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100, "latin1");
  block.write("0001750\0", 108, "latin1");
  block.write("0001750\0", 116, "latin1");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  block.write("14700000000\0", 136, "latin1");
  block.write(type, 156, "latin1");
  if (opts.link) block.write(opts.link, 157, "utf8");
  block.write("ustar  \0", 257, "latin1");
  for (const [at, bytes] of opts.raw ?? []) bytes.copy(block, at);
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of block) sum += b;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return block;
}

const pad = (data: Buffer) => Buffer.concat([data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]);
const END = Buffer.alloc(BLOCK * 2);
const file = (name: string, content: string, mode?: number) => [header(name, "0", Buffer.byteLength(content), { mode: mode ?? 0o644 }), pad(Buffer.from(content))];

/** A sink that keeps what it is given. */
function memory() {
  const files = new Map<string, { executable: boolean; content: string }>();
  const links = new Map<string, string>();
  const sink: ArchiveSink = {
    async file(path, executable, _size, data) {
      const parts: Buffer[] = [];
      for await (const c of data) parts.push(c);
      files.set(path, { executable, content: Buffer.concat(parts).toString("utf8") });
    },
    async symlink(path, target) {
      links.set(path, target.toString("utf8"));
    },
  };
  return { sink, files, links };
}

/** `bytes` as a stream of `chunk`-byte pieces. */
async function* stream(bytes: Buffer, chunk = 4096): AsyncIterable<Buffer> {
  for (let at = 0; at < bytes.length; at += chunk) yield bytes.subarray(at, at + chunk);
}

const read = (bytes: Buffer, expected: string[], max = 1 << 20, chunk?: number) =>
  readWorkArchive(stream(bytes, chunk), new Set(expected), max, memory().sink);

describe("readWorkArchive", () => {
  it("reads GNU tar's own archive of listed paths: files, the execute bit, a link as a link, a long name", async () => {
    const dir = await tempDir("archive-test-");
    const long = `${"d".repeat(60)}/${"e".repeat(60)}/${"f".repeat(60)}.c`;
    await mkdir(join(dir, long, ".."), { recursive: true });
    await writeFile(join(dir, long), "deep\n");
    await writeFile(join(dir, "main.c"), "int main;\n");
    await writeFile(join(dir, "run.sh"), "#!/bin/sh\n");
    await chmod(join(dir, "run.sh"), 0o755);
    await symlink("/etc/passwd", join(dir, "link"));
    await run("mkfifo", [join(dir, "pipe")]);
    const listed = ["main.c", "run.sh", "link", "pipe", long, "d".repeat(60)];
    const { stdout } = await run("tar", ["--create", "--file=-", `--directory=${dir}`, "--format=gnu", "--no-recursion", ...listed], { encoding: "buffer", maxBuffer: 1 << 24 });

    for (const chunk of [1, 7, 512, 65536]) {
      const m = memory();
      const kept = await readWorkArchive(stream(stdout, chunk), new Set(listed), 1 << 20, m.sink);
      expect([...kept].sort()).toEqual([long, "link", "main.c", "run.sh"].sort());
      expect(m.files.get("main.c")).toEqual({ executable: false, content: "int main;\n" });
      expect(m.files.get("run.sh")).toEqual({ executable: true, content: "#!/bin/sh\n" });
      expect(m.files.get(long)?.content).toBe("deep\n");
      expect(m.links.get("link")).toBe("/etc/passwd");
    }
  });

  it("stops at the cap on the files' total", async () => {
    const bytes = Buffer.concat([...file("a", "x".repeat(600)), ...file("b", "y".repeat(600)), END]);
    await expect(read(bytes, ["a", "b"], 1000)).rejects.toBeInstanceOf(ArchiveTooLarge);
    expect((await read(bytes, ["a", "b"], 1200)).size).toBe(2);
  });

  const hostile: Record<string, Buffer> = {
    "an absolute path": Buffer.concat([...file("/etc/passwd", "x"), END]),
    "a .. segment": Buffer.concat([...file("a/../../etc/passwd", "x"), END]),
    "a . segment": Buffer.concat([...file("./a", "x"), END]),
    "a .git segment": Buffer.concat([...file("sub/.git/config", "x"), END]),
    "a path that was not listed": Buffer.concat([...file("other.c", "x"), END]),
    "the same path twice": Buffer.concat([...file("a", "x"), ...file("a", "y"), END]),
    "a hard link": Buffer.concat([header("a", "1", 0, { link: "/etc/passwd" }), END]),
    "a character device": Buffer.concat([header("a", "3", 0), END]),
    "a block device": Buffer.concat([header("a", "4", 0), END]),
    "a PAX header": Buffer.concat([header("PaxHeader", "x", 20), pad(Buffer.from("20 path=/etc/passwd\n")), ...file("a", "x"), END]),
    "a link that carries data": Buffer.concat([header("a", "2", 5, { link: "b" }), pad(Buffer.from("hello")), END]),
    "a long link name on a file": Buffer.concat([header("././@LongLink", "K", 4), pad(Buffer.from("/etc")), ...file("a", "x"), END]),
    "a long name over PATH_MAX": Buffer.concat([header("././@LongLink", "L", 5000), pad(Buffer.alloc(5000, 0x61)), END]),
    "a name that is not UTF-8": Buffer.concat([header(Buffer.from([0x61, 0xff, 0x62]), "0", 0), END]),
    "a bad checksum": Buffer.concat([header("a", "0", 0, {}), END]).fill(0x7a, 300, 301),
    "a ustar header that is not GNU's": Buffer.concat([header("a", "0", 0, { raw: [[257, Buffer.from("ustar\u000000")]] }), END]),
    "a base-256 size": Buffer.concat([header("a", "0", 0, { raw: [[124, Buffer.from([0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])]] }), END]),
    // Announced 10 bytes, 600 follow: the next "header" is the file's own data.
    "an entry announced smaller than it is": Buffer.concat([header("a", "0", 10), pad(Buffer.alloc(600, 0x41)), END]),
    "a stream cut inside an entry": Buffer.concat([header("a", "0", 2000), Buffer.alloc(700, 0x41)]),
    "a stream cut before its end marker": Buffer.concat([...file("a", "x")]),
    "data after the end marker": Buffer.concat([...file("a", "x"), END, Buffer.from("trailing")]),
  };

  for (const [what, bytes] of Object.entries(hostile)) {
    it(`refuses ${what}`, async () => {
      const m = memory();
      await expect(readWorkArchive(stream(bytes, 333), new Set(["a", "b", "./a", "/etc/passwd", "a/../../etc/passwd", "sub/.git/config"]), 1 << 20, m.sink)).rejects.toBeInstanceOf(
        ArchiveRefused,
      );
    });
  }

  it("skips a directory and a FIFO a listed path became: those paths count as not read", async () => {
    const bytes = Buffer.concat([header("a/", "5", 0), header("b", "6", 0), ...file("c", "z"), END]);
    expect([...(await read(bytes, ["a", "b", "c"]))]).toEqual(["c"]);
  });
});
