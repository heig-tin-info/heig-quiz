import { projectPathProblem } from "@quiz/core/server";

/**
 * The tar of a project run, read and written in this process (ADR-106 §3).
 *
 * A project's archive is never handed as-is to the `tar` of the container:
 * it is parsed here, every entry is judged, and only the accepted ones are
 * written again — fresh headers, fresh modes, no owner — into a clean archive
 * that the container's GNU tar unpacks in `/work`. So what reaches the
 * sandbox is a format this file produces, not one a student wrote: a symlink,
 * a hard link, a device, a `..`, an absolute path or a name a header could
 * smuggle (ustar prefix, PAX `path`, GNU long name) never gets there.
 *
 * The same reader parses the `tar -c` of the output files on the way back.
 */

const BLOCK = 512;

/** The archive itself is malformed: no entry of it can be trusted. */
export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

export interface TarEntry {
  /** The path the headers resolve to (ustar prefix, PAX `path`, GNU `L` applied). */
  path: string;
  /** False when the name's bytes are not UTF-8; `path` then holds a lossy decoding. */
  utf8: boolean;
  /** The header's type flag, one character (`0`, `5`, `2`…; `\0` is an old regular file). */
  typeflag: string;
  mode: number;
  /** Seconds since the epoch, from the header. */
  mtime: number;
  /** The entry's bytes, a view into the archive. */
  data: Buffer;
}

const strict = new TextDecoder("utf-8", { fatal: true });
const lossy = new TextDecoder("utf-8");

/** A NUL-terminated field's bytes. */
function field(block: Buffer, start: number, length: number): Buffer {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return end === -1 ? slice : slice.subarray(0, end);
}

function octal(block: Buffer, start: number, length: number): number {
  // GNU's base-256 form for values an octal field cannot hold.
  if ((block[start]! & 0x80) !== 0) {
    let value = block[start]! & 0x7f;
    for (let i = start + 1; i < start + length; i += 1) value = value * 256 + block[i]!;
    return value;
  }
  const text = field(block, start, length).toString("latin1").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError("a numeric field is not octal");
  return Number.parseInt(text, 8);
}

function checksumOk(block: Buffer): boolean {
  const stored = octal(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  return sum === stored;
}

function decodeName(bytes: Buffer): { path: string; utf8: boolean } {
  try {
    return { path: strict.decode(bytes), utf8: true };
  } catch {
    return { path: lossy.decode(bytes), utf8: false };
  }
}

/** The records of a PAX header: `<length> <key>=<value>\n`, the length counting the whole record. */
function paxRecords(data: Buffer): Map<string, Buffer> {
  const records = new Map<string, Buffer>();
  let at = 0;
  while (at < data.length) {
    if (data[at] === 0) break;
    const space = data.indexOf(0x20, at);
    if (space === -1) throw new TarError("a PAX record has no length");
    const length = Number(data.subarray(at, space).toString("latin1"));
    if (!Number.isInteger(length) || length <= space - at || at + length > data.length) {
      throw new TarError("a PAX record has a bad length");
    }
    const record = data.subarray(space + 1, at + length);
    const equals = record.indexOf(0x3d);
    if (equals === -1 || record[record.length - 1] !== 0x0a) {
      throw new TarError("a PAX record is malformed");
    }
    records.set(
      record.subarray(0, equals).toString("utf8"),
      record.subarray(equals + 1, record.length - 1),
    );
    at += length;
  }
  return records;
}

/**
 * Every entry of an archive, in order, with its extended headers applied.
 * Throws {@link TarError} on a malformed archive: a bad checksum, a size past
 * the end, a broken PAX record. The end is two zero blocks, or the buffer's end.
 */
export function readTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let at = 0;
  let longName: Buffer | null = null;
  let pax: Map<string, Buffer> | null = null;

  while (at + BLOCK <= archive.length) {
    const header = archive.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!checksumOk(header)) throw new TarError(`bad header checksum at offset ${at}`);

    const typeflag = String.fromCharCode(header[156]!);
    let size = octal(header, 124, 12);
    const paxSize = pax?.get("size");
    if (paxSize !== undefined && typeflag !== "x" && typeflag !== "g") {
      size = Number(paxSize.toString("latin1"));
      if (!Number.isSafeInteger(size) || size < 0) throw new TarError("a PAX size is not a number");
    }
    const start = at + BLOCK;
    const end = start + size;
    if (end > archive.length) throw new TarError("an entry runs past the end of the archive");
    const data = archive.subarray(start, end);
    at = start + Math.ceil(size / BLOCK) * BLOCK;

    // Extended headers: they describe the NEXT entry and are not entries themselves.
    if (typeflag === "x") {
      pax = paxRecords(data);
      continue;
    }
    if (typeflag === "g") {
      // Global records (GitHub's `comment=<sha>`): nothing of them is used.
      paxRecords(data);
      continue;
    }
    if (typeflag === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    if (typeflag === "K") continue; // a long link target: links are refused anyway

    let nameBytes: Buffer = field(header, 0, 100);
    const ustar = header.subarray(257, 262).toString("latin1") === "ustar";
    const prefix = ustar ? field(header, 345, 155) : Buffer.alloc(0);
    if (prefix.length > 0) nameBytes = Buffer.concat([prefix, Buffer.from("/"), nameBytes]);
    if (longName !== null) nameBytes = longName;
    const paxPath = pax?.get("path");
    if (paxPath !== undefined) nameBytes = paxPath;

    entries.push({
      ...decodeName(nameBytes),
      typeflag,
      mode: octal(header, 100, 8),
      mtime: octal(header, 136, 12),
      data,
    });
    longName = null;
    pax = null;
  }
  return entries;
}

/** What a sanitized entry is; nothing else is ever written. */
export interface CleanEntry {
  path: string;
  type: "file" | "directory";
  /** 0o755 or 0o644: only "executable or not" survives. */
  mode: number;
  mtime: number;
  data: Buffer;
}

function octalField(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function header(name: Buffer, typeflag: string, size: number, mode: number, mtime: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  name.copy(block, 0, 0, Math.min(name.length, 100));
  block.write(octalField(mode, 8), 100, "latin1");
  block.write(octalField(1000, 8), 108, "latin1");
  block.write(octalField(1000, 8), 116, "latin1");
  block.write(octalField(size, 12), 124, "latin1");
  block.write(octalField(mtime, 12), 136, "latin1");
  block.write(typeflag, 156, "latin1");
  block.write("ustar\0" + "00", 257, "latin1");
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octalField(sum, 7) + " ", 148, "latin1");
  return block;
}

function padded(data: Buffer): Buffer[] {
  const rest = data.length % BLOCK;
  return rest === 0 ? [data] : [data, Buffer.alloc(BLOCK - rest)];
}

/** A PAX record, its length prefix counting itself. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyLength = Buffer.byteLength(body);
  let length = bodyLength + 1;
  while (bodyLength + String(length).length !== length) length = bodyLength + String(length).length;
  return Buffer.from(`${length}${body}`);
}

/**
 * A clean ustar archive of these entries, in order. A name over 100 bytes
 * travels in a PAX `path` record, which GNU tar reads.
 */
export function writeTar(entries: readonly CleanEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const stored = entry.type === "directory" ? `${entry.path}/` : entry.path;
    const name = Buffer.from(stored, "utf8");
    if (name.length > 100) {
      const record = paxRecord("path", stored);
      parts.push(header(Buffer.from("PaxHeader"), "x", record.length, 0o644, entry.mtime), ...padded(record));
    }
    const size = entry.type === "file" ? entry.data.length : 0;
    parts.push(header(name, entry.type === "file" ? "0" : "5", size, entry.mode, entry.mtime));
    if (size > 0) parts.push(...padded(entry.data));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** Why an entry's type is refused: only regular files and directories pass. */
const REFUSED_TYPES: Readonly<Record<string, string>> = {
  "1": "hard_link",
  "2": "symbolic_link",
  "3": "device",
  "4": "device",
  "6": "fifo",
};
const FILE_TYPES = new Set(["0", "\0", "7"]);

/** Past this, refusals are counted, not listed: the answer stays small. */
const REFUSALS_LISTED = 100;

export interface SanitizedArchive {
  tar: Buffer;
  /** Files and directories written to the clean archive. */
  accepted: number;
  /** `<path>: <reason>`, in archive order. */
  refused: string[];
}

/** A path as it may be shown: control characters become `?`, and it is cut at 300 characters. */
function shown(path: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = path.replace(/[\u0000-\u001f\u007f]/g, "?");
  return safe.length > 300 ? `${safe.slice(0, 300)}…` : safe;
}

/**
 * The archive, sanitized: every entry is a normalized relative path (one
 * leading `./` is dropped, the root `.` itself is skipped), a regular file or
 * a directory, and in no conflict with an earlier one (a file under a file,
 * a file and a directory of the same name, the same file twice — the first
 * wins). Everything else is refused, named in `refused`, and absent from
 * `tar`. Throws {@link TarError} when the archive itself is malformed.
 */
export function sanitizeArchive(archive: Buffer): SanitizedArchive {
  const clean: CleanEntry[] = [];
  const kinds = new Map<string, "file" | "directory">();
  const refused: string[] = [];
  let refusedCount = 0;
  const refuse = (path: string, reason: string): void => {
    refusedCount += 1;
    if (refused.length < REFUSALS_LISTED) refused.push(`${shown(path)}: ${reason}`);
  };
  const now = Math.floor(Date.now() / 1000);

  for (const entry of readTar(archive)) {
    let path = entry.path;
    while (path.startsWith("./")) path = path.slice(2);
    if (path === "" || path === ".") continue;

    const typeReason = REFUSED_TYPES[entry.typeflag];
    if (typeReason !== undefined) {
      refuse(path, typeReason);
      continue;
    }
    let type: CleanEntry["type"];
    if (entry.typeflag === "5") type = "directory";
    else if (FILE_TYPES.has(entry.typeflag)) type = path.endsWith("/") ? "directory" : "file";
    else {
      refuse(path, "unsupported_type");
      continue;
    }
    if (!entry.utf8) {
      refuse(path, "not_utf8");
      continue;
    }
    const problem = projectPathProblem(path);
    if (problem !== null) {
      refuse(path, problem);
      continue;
    }
    if (path.endsWith("/")) path = path.slice(0, -1);
    if (type === "directory" && entry.data.length > 0) {
      refuse(path, "unsupported_type");
      continue;
    }

    const segments = path.split("/");
    const ancestors = segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join("/"));
    if (ancestors.some((ancestor) => kinds.get(ancestor) === "file")) {
      refuse(path, "conflict");
      continue;
    }
    const existing = kinds.get(path);
    if (existing === "directory" && type === "directory") continue;
    if (existing !== undefined) {
      refuse(path, existing === type ? "duplicate" : "conflict");
      continue;
    }

    const mtime = Math.min(Math.max(0, entry.mtime), now);
    for (const ancestor of ancestors) {
      if (kinds.has(ancestor)) continue;
      kinds.set(ancestor, "directory");
      clean.push({ path: ancestor, type: "directory", mode: 0o755, mtime, data: Buffer.alloc(0) });
    }
    kinds.set(path, type);
    clean.push({
      path,
      type,
      mode: type === "directory" || (entry.mode & 0o111) !== 0 ? 0o755 : 0o644,
      mtime,
      data: type === "file" ? entry.data : Buffer.alloc(0),
    });
  }

  if (refusedCount > refused.length) refused.push(`… and ${refusedCount - refused.length} more`);
  return { tar: writeTar(clean), accepted: clean.length, refused };
}
