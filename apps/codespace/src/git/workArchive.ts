/**
 * Reads the archive the confined reader (`engine/reader.ts`) streams out of
 * a workspace, as data only — the portal's invariant 15; nothing of it is
 * resolved on the host. GNU tar of exactly the listed paths, judged entry by
 * entry with the runner's `project` rules (root invariant 12), the header
 * helpers and the path rule shared with `@quiz/core/tar`:
 *
 *  - a regular file or a symbolic link is kept (a link as its target's
 *    bytes, never followed); a directory or a FIFO (a listed path swapped
 *    while the reader ran) is skipped and counts as not read; any other type
 *    (hard link, device, extended or sparse header) refuses the archive;
 *  - a name is UTF-8, a `projectPathProblem`-clean relative path without a
 *    `.git` segment, one of the listed paths, once; GNU `L`/`K` long names
 *    at most {@link LONG_NAME_MAX} bytes;
 *  - checksums hold, sizes are octal, the files total at most the cap
 *    ({@link ArchiveTooLarge}), and the stream reaches tar's end marker, so
 *    a size that lies or a cut stream refuses the archive.
 *
 * Streaming: a header at a time, a file's bytes handed on as they come.
 */
import { checksumOk, decodeName, field, octal, TarError } from "@quiz/core/tar";
import { projectPathProblem, type ProjectPathProblem } from "@quiz/core/runner";

const BLOCK = 512;
/** Linux's `PATH_MAX`: a longer name is no name a work tree holds. */
export const LONG_NAME_MAX = 4096;
const GNU_MAGIC = Buffer.from("ustar  \0", "latin1");

/** The archive is malformed or names something it must not: nothing of it is kept. */
export class ArchiveRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveRefused";
  }
}

/** The workspace's files exceed the cap: the collection is `too_large`. */
export class ArchiveTooLarge extends Error {
  /** What the reader is known not to have read when the cap was reached (`workTree.ts` sets it). */
  constructor(readonly unreadable = 0) {
    super("the workspace's files exceed the collection's cap");
    this.name = "ArchiveTooLarge";
  }
}

/** Where the kept entries go: a file's bytes are handed on as they come and must all be read. */
export interface ArchiveSink {
  file(path: string, executable: boolean, size: number, data: AsyncIterable<Buffer>): Promise<void>;
  symlink(path: string, target: Buffer): Promise<void>;
}

/** `path` as a work tree's relative path, or why not: `projectPathProblem`, and never `.git`. */
export function workPathProblem(path: string): WorkPathProblem | null {
  return projectPathProblem(path) ?? (path.split("/").includes(".git") ? "git_segment" : null);
}

export type WorkPathProblem = ProjectPathProblem | "git_segment";

/** A stream read by exact counts; running out before a count is a truncated archive. */
class Bytes {
  private buf: Buffer = Buffer.alloc(0);
  private readonly it: AsyncIterator<Buffer>;
  constructor(stream: AsyncIterable<Buffer>) {
    this.it = stream[Symbol.asyncIterator]();
  }

  private async more(): Promise<void> {
    const next = await this.it.next();
    if (next.done) throw new ArchiveRefused("the archive ends before its end marker");
    this.buf = this.buf.length === 0 ? next.value : Buffer.concat([this.buf, next.value]);
  }

  async take(n: number): Promise<Buffer> {
    while (this.buf.length < n) await this.more();
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** `read.left` bytes as they come, counted down; what the consumer leaves is skipped by {@link skip}. */
  async *chunks(read: { left: number }): AsyncIterable<Buffer> {
    while (read.left > 0) {
      if (this.buf.length === 0) await this.more();
      const k = Math.min(read.left, this.buf.length);
      const out = this.buf.subarray(0, k);
      this.buf = this.buf.subarray(k);
      read.left -= k;
      yield out;
    }
  }

  /** The rest of the stream, which must be zeros (tar pads its last record): read to its end. */
  async zerosToEnd(): Promise<void> {
    for (;;) {
      if (!isZero(this.buf)) throw new ArchiveRefused("data after the end marker");
      const next = await this.it.next();
      if (next.done) return;
      this.buf = next.value;
    }
  }

  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0) await this.more();
      const k = Math.min(left, this.buf.length);
      this.buf = this.buf.subarray(k);
      left -= k;
    }
  }
}

const isZero = (block: Buffer) => block.every((b) => b === 0);

function checkHeader(header: Buffer): void {
  if (!checksumOk(header)) throw new ArchiveRefused("a header's checksum does not hold");
  if (!header.subarray(257, 265).equals(GNU_MAGIC)) throw new ArchiveRefused("a header is not GNU tar's");
}

/** The name's bytes as text; a name that is not UTF-8 refuses the archive. */
function nameOf(bytes: Uint8Array): string {
  const { path, utf8 } = decodeName(bytes);
  if (!utf8) throw new ArchiveRefused("a name is not UTF-8");
  return path;
}

/**
 * Reads the archive into `sink`. `expected` is the listing the reader was
 * given; `maxBytes` caps the regular files' total. Returns the paths kept
 * (files and links); a listed path missing from it was not read.
 */
export async function readWorkArchive(
  stream: AsyncIterable<Buffer>,
  expected: ReadonlySet<string>,
  maxBytes: number,
  sink: ArchiveSink,
): Promise<Set<string>> {
  try {
    return await readEntries(stream, expected, maxBytes, sink);
  } catch (err) {
    // The shared helpers' refusal (a field that is not octal) is this archive's.
    throw err instanceof TarError ? new ArchiveRefused(err.message) : err;
  }
}

async function readEntries(stream: AsyncIterable<Buffer>, expected: ReadonlySet<string>, maxBytes: number, sink: ArchiveSink): Promise<Set<string>> {
  const bytes = new Bytes(stream);
  const kept = new Set<string>();
  const seen = new Set<string>();
  let total = 0;
  let longName: Buffer | null = null;
  let longLink: Buffer | null = null;

  for (;;) {
    const header = await bytes.take(BLOCK);
    if (isZero(header)) {
      // GNU tar ends with two zero blocks, then zeros to the end of its record.
      if (!isZero(await bytes.take(BLOCK))) throw new ArchiveRefused("data after an end block");
      if (longName !== null || longLink !== null) throw new ArchiveRefused("a long name with no entry");
      await bytes.zerosToEnd();
      return kept;
    }
    checkHeader(header);
    const type = String.fromCharCode(header[156]!);
    const size = octal(header, 124, 12);
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;

    if (type === "L" || type === "K") {
      if (size > LONG_NAME_MAX) throw new ArchiveRefused("a long name over PATH_MAX");
      const value = field(await bytes.take(size + padding), 0, size);
      if (type === "L") longName = Buffer.from(value);
      else longLink = Buffer.from(value);
      continue;
    }
    if (!["0", "\0", "2", "5", "6"].includes(type)) throw new ArchiveRefused(`an entry of type ${JSON.stringify(type)}`);
    if (longLink !== null && type !== "2") throw new ArchiveRefused("a long link name on an entry that is no link");
    if (type !== "0" && type !== "\0" && size !== 0) throw new ArchiveRefused("a link, directory or FIFO with data");

    let path = nameOf(longName ?? field(header, 0, 100));
    longName = null;
    // GNU names a directory `dir/`.
    if (type === "5" && path.endsWith("/")) path = path.slice(0, -1);
    const problem = workPathProblem(path);
    if (problem !== null) throw new ArchiveRefused(problem);
    if (!expected.has(path)) throw new ArchiveRefused("a path that was not listed");
    if (seen.has(path)) throw new ArchiveRefused("a path archived twice");
    seen.add(path);

    if (type === "2") {
      const target = longLink ?? Buffer.from(field(header, 157, 100));
      longLink = null;
      if (target.length === 0) throw new ArchiveRefused("a link with no target");
      await sink.symlink(path, target);
      kept.add(path);
    } else if (type === "0" || type === "\0") {
      total += size;
      if (total > maxBytes) throw new ArchiveTooLarge();
      const read = { left: size };
      await sink.file(path, (octal(header, 100, 8) & 0o100) !== 0, size, bytes.chunks(read));
      // A sink that stopped early leaves the rest: the archive's framing stays tar's.
      await bytes.skip(read.left + padding);
      kept.add(path);
    }
    // A directory or a FIFO: nothing of it is a file's content.
  }
}
