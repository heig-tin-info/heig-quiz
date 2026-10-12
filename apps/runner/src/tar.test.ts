import { describe, expect, it } from "vitest";

import { readTar, sanitizeArchive, TarError, writeTar } from "./tar.js";
import { rawTar, type RawEntry } from "./test/tarFixture.js";

/** What the clean archive holds: `path` and `file`/`directory`, in order. */
function cleanList(entries: RawEntry[]): string[] {
  return readTar(sanitizeArchive(rawTar(entries)).tar).map(
    (entry) => `${entry.typeflag === "5" ? "d" : "f"} ${entry.path.replace(/\/$/, "")}`,
  );
}

function refusals(entries: RawEntry[]): string[] {
  return sanitizeArchive(rawTar(entries)).refused;
}

describe("readTar", () => {
  it("applies the ustar prefix, a PAX path and a GNU long name", () => {
    const long = `${"d".repeat(120)}/main.c`;
    const entries = readTar(
      rawTar([
        { name: "main.c", prefix: "src/lib", data: "a" },
        { name: "ignored", paxPath: long, data: "b" },
        { name: "ignored-too", longName: `x/${long}`, data: "c" },
      ]),
    );
    expect(entries.map((entry) => [entry.path, entry.data.toString()])).toEqual([
      ["src/lib/main.c", "a"],
      [long, "b"],
      [`x/${long}`, "c"],
    ]);
  });

  it("skips a PAX global header (GitHub's comment=<sha>)", () => {
    const entries = readTar(
      rawTar([{ name: "pax_global_header", type: "g", data: "52 comment=0123456789abcdef0123456789abcdef01234567\n" }, { name: "a", data: "1" }]),
    );
    expect(entries.map((entry) => entry.path)).toEqual(["a"]);
  });

  it("refuses a malformed archive: a bad checksum, an entry past the end", () => {
    expect(() => readTar(rawTar([{ name: "a", data: "x", badChecksum: true }]))).toThrow(TarError);
    const cut = rawTar([{ name: "a", data: "x".repeat(2000) }], { end: false }).subarray(0, 1024);
    expect(() => readTar(cut)).toThrow(TarError);
  });

  it("reads back what writeTar wrote, a long name included", () => {
    const long = `${"n".repeat(150)}.txt`;
    const tar = writeTar([
      { path: "dir", type: "directory", mode: 0o755, mtime: 1, data: Buffer.alloc(0) },
      { path: `dir/${long}`, type: "file", mode: 0o644, mtime: 1, data: Buffer.from("héllo") },
    ]);
    expect(readTar(tar).map((entry) => [entry.path, entry.typeflag, entry.data.toString()])).toEqual([
      ["dir/", "5", ""],
      [`dir/${long}`, "0", "héllo"],
    ]);
  });
});

describe("sanitizeArchive", () => {
  it("keeps regular files and directories, and writes their ancestors first", () => {
    expect(
      cleanList([
        { name: "Makefile", data: "all:\n" },
        { name: "src/", type: "5" },
        { name: "src/main.c", data: "int main;" },
        { name: "tests/unit/test_a.py", data: "def test(): pass" },
      ]),
    ).toEqual(["f Makefile", "d src", "f src/main.c", "d tests", "d tests/unit", "f tests/unit/test_a.py"]);
  });

  it("drops one leading ./ and skips the root itself", () => {
    expect(cleanList([{ name: "./", type: "5" }, { name: "./a.c", data: "x" }])).toEqual(["f a.c"]);
  });

  it("keeps only 'executable or not' of a mode", () => {
    const entries = readTar(
      sanitizeArchive(rawTar([{ name: "run.sh", mode: 0o4777, data: "x" }, { name: "a", mode: 0o666, data: "y" }])).tar,
    );
    expect(entries.map((entry) => entry.mode)).toEqual([0o755, 0o644]);
  });

  it.each<[string, RawEntry, string]>([
    ["a parent segment", { name: "../evil", data: "x" }, "../evil: dot_segment"],
    ["a nested parent", { name: "a/../../evil", data: "x" }, "a/../../evil: dot_segment"],
    ["an absolute path", { name: "/etc/passwd", data: "x" }, "/etc/passwd: absolute"],
    ["a dot segment inside", { name: "a/./b", data: "x" }, "a/./b: dot_segment"],
    ["an empty segment", { name: "a//b", data: "x" }, "a//b: empty_segment"],
    ["a control character", { name: "a\nb", data: "x" }, "a?b: control_character"],
    ["a segment over 255 bytes", { name: "x", paxPath: "é".repeat(128), data: "x" }, `${"é".repeat(128)}: segment_too_long`],
    ["a symbolic link", { name: "link", type: "2", linkname: "/etc/shadow" }, "link: symbolic_link"],
    ["a hard link", { name: "hard", type: "1", linkname: "Makefile" }, "hard: hard_link"],
    ["a character device", { name: "tty", type: "3" }, "tty: device"],
    ["a block device", { name: "sda", type: "4" }, "sda: device"],
    ["a fifo", { name: "pipe", type: "6" }, "pipe: fifo"],
    ["an unknown type", { name: "sparse", type: "S" }, "sparse: unsupported_type"],
    ["an absolute path hidden in a ustar prefix", { name: "passwd", prefix: "/etc" }, "/etc/passwd: absolute"],
    ["a parent hidden in a PAX path", { name: "fine", paxPath: "../../x", data: "x" }, "../../x: dot_segment"],
    ["a parent hidden in a GNU long name", { name: "fine", longName: "a/../../x", data: "x" }, "a/../../x: dot_segment"],
  ])("refuses %s and leaves it out", (_, entry, reason) => {
    const sanitized = sanitizeArchive(rawTar([entry, { name: "kept.c", data: "ok" }]));
    expect(sanitized.refused).toEqual([reason]);
    expect(readTar(sanitized.tar).map((e) => e.path)).toEqual(["kept.c"]);
  });

  it("refuses a name that is not UTF-8", () => {
    const tar = rawTar([{ name: "x", data: "x" }]);
    // Overwrite the name with a lone continuation byte, then fix the checksum.
    tar[0] = 0x80;
    tar.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += tar[i]!;
    tar.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    expect(sanitizeArchive(tar).refused).toEqual(["�: not_utf8"]);
  });

  it("refuses file-directory conflicts and duplicates, the first entry winning", () => {
    expect(
      refusals([
        { name: "a", data: "file" },
        { name: "a/b", data: "under a file" },
        { name: "a/", type: "5" },
        { name: "d/", type: "5" },
        { name: "d", data: "a file over a directory" },
        { name: "f", data: "1" },
        { name: "f", data: "2" },
        { name: "d/", type: "5" },
      ]),
    ).toEqual(["a/b: conflict", "a: conflict", "d: conflict", "f: duplicate"]);
  });

  it("lists a hundred refusals, and counts the rest", () => {
    const many = Array.from({ length: 105 }, (_, i) => ({ name: `l${i}`, type: "2", linkname: "x" }));
    const refused = refusals(many);
    expect(refused).toHaveLength(101);
    expect(refused.at(-1)).toBe("… and 5 more");
  });
});
