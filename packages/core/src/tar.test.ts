import { describe, expect, it } from "vitest";

import { header, paxRecord, readTar, sanitizeArchive, TarError, writeTar } from "./tar.js";

/**
 * The archive rule of invariant 12, on raw headers: what a student's tar
 * may say, written byte for byte (a ustar prefix, a PAX `path`, a GNU long
 * name, a link, a device), and what the sanitizer makes of it. The path rule
 * itself is `projectPathProblem`'s, tested in runner.test.ts.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

interface Raw {
  name: string | Uint8Array;
  type?: string;
  data?: string;
  mode?: number;
  prefix?: string;
  paxPath?: string;
  longName?: string;
  badChecksum?: boolean;
}

/** `header` of tar.ts, then the fields it never writes, and its checksum again. */
function rawHeader(raw: Raw, size: number): Uint8Array {
  const name = typeof raw.name === "string" ? enc.encode(raw.name) : raw.name;
  const block = header(name, raw.type ?? "0", size, raw.mode ?? 0o644, 1_700_000_000);
  if (raw.prefix !== undefined) block.set(enc.encode(raw.prefix), 345);
  block.fill(0x20, 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0) + (raw.badChecksum ? 1 : 0);
  block.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return block;
}

function blocks(raw: Raw): Uint8Array[] {
  const data = enc.encode(raw.data ?? "");
  return [rawHeader(raw, data.length), data, new Uint8Array((512 - (data.length % 512)) % 512)];
}

function rawTar(entries: Raw[], { end = true } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    if (entry.paxPath !== undefined) {
      parts.push(...blocks({ name: "PaxHeader", type: "x", data: dec.decode(paxRecord("path", entry.paxPath)) }));
    }
    if (entry.longName !== undefined) {
      parts.push(...blocks({ name: "././@LongLink", type: "L", data: `${entry.longName}\0` }));
    }
    parts.push(...blocks(entry));
  }
  if (end) parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const paths = (tar: Uint8Array): string[] => readTar(tar).map((entry) => entry.path);

describe("readTar", () => {
  it("applies a ustar prefix, a PAX path and a GNU long name", () => {
    const long = `${"d".repeat(120)}/main.c`;
    expect(
      paths(
        rawTar([
          { name: "main.c", prefix: "src/lib" },
          { name: "ignored", paxPath: long },
          { name: "ignored-too", longName: `x/${long}` },
        ]),
      ),
    ).toEqual(["src/lib/main.c", long, `x/${long}`]);
  });

  it("never reads an old-GNU header's times as a prefix", () => {
    const tar = rawTar([{ name: "a.c", prefix: "/etc" }]);
    tar.set(enc.encode("ustar  \0"), 257); // old GNU magic, checksum fixed below
    tar.fill(0x20, 148, 156);
    const sum = tar.subarray(0, 512).reduce((total, byte) => total + byte, 0);
    tar.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    expect(paths(tar)).toEqual(["a.c"]);
  });

  it("skips a PAX global header (GitHub's comment=<sha>)", () => {
    expect(paths(rawTar([{ name: "g", type: "g", data: "18 comment=abcdef\n" }, { name: "a" }]))).toEqual(["a"]);
  });

  it("refuses a malformed archive: a bad checksum, an entry past the end", () => {
    expect(() => readTar(rawTar([{ name: "a", badChecksum: true }]))).toThrow(TarError);
    expect(() => readTar(rawTar([{ name: "a", data: "x".repeat(2000) }], { end: false }).subarray(0, 1024))).toThrow(TarError);
  });

  it("reads back what writeTar wrote, a long name included", () => {
    const long = `${"n".repeat(150)}.txt`;
    const tar = writeTar([
      { path: "dir", type: "directory", mode: 0o755, mtime: 1, data: new Uint8Array(0) },
      { path: `dir/${long}`, type: "file", mode: 0o644, mtime: 1, data: enc.encode("héllo") },
    ]);
    expect(readTar(tar).map((entry) => [entry.path, entry.typeflag, dec.decode(entry.data)])).toEqual([
      ["dir/", "5", ""],
      [`dir/${long}`, "0", "héllo"],
    ]);
  });
});

describe("sanitizeArchive", () => {
  it("repacks files and directories, ancestors first, modes reduced to executable or not", () => {
    const { tar, refused } = sanitizeArchive(
      rawTar([
        { name: "./", type: "5" },
        { name: "./run.sh", mode: 0o4777 },
        { name: "src/main.c", mode: 0o666 },
      ]),
    );
    expect(refused).toEqual([]);
    expect(readTar(tar).map((entry) => [entry.path, entry.mode])).toEqual([
      ["run.sh", 0o755],
      ["src/", 0o755],
      ["src/main.c", 0o644],
    ]);
  });

  it.each<[string, Raw, string]>([
    ["a symbolic link", { name: "link", type: "2" }, "link: symbolic_link"],
    ["a hard link", { name: "hard", type: "1" }, "hard: hard_link"],
    ["a character device", { name: "tty", type: "3" }, "tty: device"],
    ["a block device", { name: "sda", type: "4" }, "sda: device"],
    ["a fifo", { name: "pipe", type: "6" }, "pipe: fifo"],
    ["an unknown type", { name: "sparse", type: "S" }, "sparse: unsupported_type"],
    ["an absolute path in a ustar prefix", { name: "passwd", prefix: "/etc" }, "/etc/passwd: absolute"],
    ["a parent in a PAX path", { name: "fine", paxPath: "../../x" }, "../../x: dot_segment"],
    ["a parent in a GNU long name", { name: "fine", longName: "a/../../x" }, "a/../../x: dot_segment"],
    ["a name that is not UTF-8", { name: new Uint8Array([0x80]) }, "�: not_utf8"],
  ])("refuses the whole archive for %s", (_, entry, reason) => {
    const { tar, refused } = sanitizeArchive(rawTar([{ name: "kept.c" }, entry]));
    expect(refused).toEqual([reason]);
    expect(tar.length).toBe(0);
  });

  it("refuses file-directory conflicts and duplicates", () => {
    expect(
      sanitizeArchive(
        rawTar([
          { name: "a" },
          { name: "a/b" },
          { name: "a/", type: "5" },
          { name: "d/", type: "5" },
          { name: "d" },
          { name: "f" },
          { name: "f" },
          { name: "d/", type: "5" },
        ]),
      ).refused,
    ).toEqual(["a/b: conflict", "a: conflict", "d: conflict", "f: duplicate"]);
  });

  it("lists a hundred refusals, and counts the rest", () => {
    const refused = sanitizeArchive(rawTar(Array.from({ length: 105 }, (_, i) => ({ name: `l${i}`, type: "2" })))).refused;
    expect(refused).toHaveLength(101);
    expect(refused.at(-1)).toBe("… and 5 more");
  });
});
