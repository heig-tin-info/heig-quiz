/**
 * The archive the collection's confined reader streams out of a workspace
 * (`engine/reader.ts`, ADR-130 §3 as corrected on 2026-11-16), read as data
 * and nothing else: no path of it is ever resolved on the host.
 *
 * It is GNU tar's `--format=gnu` output of exactly the paths the reader
 * listed, and every entry is judged before anything of it is kept, with the
 * rules of the runner's `project` archive (root invariant 12):
 *
 *  - a regular file or a symbolic link is kept — the link as a link, its
 *    target as bytes, never followed; a directory or a FIFO (a listed file
 *    swapped for one while the reader ran) is skipped, so that path counts
 *    as not read; any other type — a hard link (the reader dereferences
 *    them), a device, an extended or sparse header — refuses the archive;
 *  - a name is UTF-8, relative, without an empty, `.`, `..` or `.git`
 *    segment, one of the listed paths, and appears once; a long name or
 *    link travels in GNU's `L`/`K` records, at most {@link LONG_NAME_MAX}
 *    bytes;
 *  - every header's checksum holds, sizes are octal (GNU's base-256 form
 *    means over 8 GiB), the regular files total at most the cap
 *    ({@link ArchiveTooLarge} past it, read no further), and the stream
 *    reaches tar's end marker: an entry announced smaller than it is lands
 *    the next header inside data, whose checksum fails; a truncated stream
 *    never reaches the marker. Both refuse the archive.
 *
 * Streaming: a header at a time, a file's bytes handed on as they come. The
 * host holds no more than a chunk, whatever the workspace weighs.
 */
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

const strict = new TextDecoder("utf-8", { fatal: true });

/** `path` as a work tree's relative path, or why not. Shared by the listing's check. */
export function workPathProblem(path: string): string | null {
  if (path === "") return "an empty name";
  if (path.includes("\0")) return "a NUL in a name";
  if (path.startsWith("/")) return "an absolute path";
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return "an empty, . or .. segment";
    if (segment === ".git") return "a .git segment";
  }
  return null;
}

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

/** A NUL-terminated field. */
function field(block: Buffer, start: number, length: number): Buffer {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return end === -1 ? slice : slice.subarray(0, end);
}

function octal(block: Buffer, start: number, length: number): number {
  if ((block[start]! & 0x80) !== 0) throw new ArchiveRefused("a base-256 number (over 8 GiB)");
  const text = field(block, start, length).toString("latin1").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new ArchiveRefused("a numeric field is not octal");
  return Number.parseInt(text, 8);
}

function checkHeader(header: Buffer): void {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  if (octal(header, 148, 8) !== sum) throw new ArchiveRefused("a header's checksum does not hold");
  if (!header.subarray(257, 265).equals(GNU_MAGIC)) throw new ArchiveRefused("a header is not GNU tar's");
}

function decodeName(bytes: Buffer): string {
  try {
    return strict.decode(bytes);
  } catch {
    throw new ArchiveRefused("a name is not UTF-8");
  }
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

    let path = decodeName(longName ?? field(header, 0, 100));
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
