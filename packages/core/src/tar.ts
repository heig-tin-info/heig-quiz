/**
 * The tar of a project run (ADR-106 §3), read, judged and written again.
 *
 * `@quiz/core/tar`, a subpath of its own: the runner sanitizes every archive
 * it receives with it, and the API composes the archive it sends with it. It
 * is never part of `./server` nor `./client`, so no browser bundle carries it.
 * Plain `Uint8Array`, no Node API.
 *
 * A project's archive is never handed as-is to the `tar` of the container: it
 * is parsed here, every entry judged, and — when every entry passes — written
 * again with fresh headers, fresh modes and no owner into a clean archive.
 * What reaches the sandbox is a format this file produces, not one a student
 * wrote: a symlink, a hard link, a device, a `..`, an absolute path or a name
 * a header could smuggle (ustar prefix, PAX `path`, GNU long name) never gets
 * there; one of them refuses the whole archive (CLAUDE.md invariant 12).
 */
import { projectPathProblem } from "./runner.js";

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
  data: Uint8Array;
}

const strict = new TextDecoder("utf-8", { fatal: true });
const lossy = new TextDecoder("utf-8");
const encoder = new TextEncoder();

/** `bytes` as text when they are valid UTF-8, else null (a binary file, a foreign encoding). */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return strict.decode(bytes);
  } catch {
    return null;
  }
}

function latin1(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A NUL-terminated field's bytes. */
function field(block: Uint8Array, start: number, length: number): Uint8Array {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return end === -1 ? slice : slice.subarray(0, end);
}

/** An octal field. GNU's base-256 form (sizes over 8 GB) is refused: no archive here is that large. */
function octal(block: Uint8Array, start: number, length: number): number {
  const text = latin1(field(block, start, length)).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError("a numeric field is not octal");
  return Number.parseInt(text, 8);
}

function checksumOk(block: Uint8Array): boolean {
  const stored = octal(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  return sum === stored;
}

function decodeName(bytes: Uint8Array): { path: string; utf8: boolean } {
  try {
    return { path: strict.decode(bytes), utf8: true };
  } catch {
    return { path: lossy.decode(bytes), utf8: false };
  }
}

/** The records of a PAX header: `<length> <key>=<value>\n`, the length counting the whole record. */
function paxRecords(data: Uint8Array): Map<string, Uint8Array> {
  const records = new Map<string, Uint8Array>();
  let at = 0;
  while (at < data.length && data[at] !== 0) {
    const space = data.indexOf(0x20, at);
    if (space === -1) throw new TarError("a PAX record has no length");
    const length = Number(latin1(data.subarray(at, space)));
    if (!Number.isInteger(length) || length <= space - at || at + length > data.length) {
      throw new TarError("a PAX record has a bad length");
    }
    const record = data.subarray(space + 1, at + length);
    const equals = record.indexOf(0x3d);
    if (equals === -1 || record[record.length - 1] !== 0x0a) {
      throw new TarError("a PAX record is malformed");
    }
    records.set(strict.decode(record.subarray(0, equals)), record.subarray(equals + 1, record.length - 1));
    at += length;
  }
  return records;
}

/**
 * Every entry of an archive, in order, its extended headers applied. Throws
 * {@link TarError} on a malformed archive: a bad checksum, a size past the
 * end, a broken PAX record. The end is a zero block, or the buffer's end.
 */
export function readTar(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let at = 0;
  let longName: Uint8Array | null = null;
  let pax: Map<string, Uint8Array> | null = null;

  while (at + BLOCK <= archive.length) {
    const header = archive.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!checksumOk(header)) throw new TarError(`bad header checksum at offset ${at}`);

    const typeflag = String.fromCharCode(header[156]!);
    let size = octal(header, 124, 12);
    const paxSize = pax?.get("size");
    if (paxSize !== undefined && typeflag !== "x" && typeflag !== "g") {
      size = Number(latin1(paxSize));
      if (!Number.isSafeInteger(size) || size < 0) throw new TarError("a PAX size is not a number");
    }
    const start = at + BLOCK;
    const end = start + size;
    if (end > archive.length) throw new TarError("an entry runs past the end of the archive");
    const data = archive.subarray(start, end);
    at = start + Math.ceil(size / BLOCK) * BLOCK;

    // Extended headers describe the NEXT entry and are not entries themselves.
    if (typeflag === "x") {
      pax = paxRecords(data);
      continue;
    }
    if (typeflag === "g") {
      paxRecords(data); // global records (GitHub's `comment=<sha>`): read, unused
      continue;
    }
    if (typeflag === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    if (typeflag === "K") continue; // a long link target: links are refused anyway

    let name = field(header, 0, 100);
    // POSIX ustar is `ustar\0`; old GNU's `ustar  ` keeps atime/ctime where
    // ustar has its prefix, which must never be read as one.
    if (latin1(header.subarray(257, 263)) === "ustar\0") {
      const prefix = field(header, 345, 155);
      if (prefix.length > 0) name = concat([prefix, encoder.encode("/"), name]);
    }
    if (longName !== null) name = longName;
    name = pax?.get("path") ?? name;

    entries.push({
      ...decodeName(name),
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
  data: Uint8Array;
}

function octalField(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function writeAscii(block: Uint8Array, text: string, at: number): void {
  for (let i = 0; i < text.length; i += 1) block[at + i] = text.charCodeAt(i);
}

/** One ustar header block; `name` is cut at 100 bytes (a longer one travels in a PAX record). */
export function header(name: Uint8Array, typeflag: string, size: number, mode: number, mtime: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  block.set(name.subarray(0, 100), 0);
  writeAscii(block, octalField(mode, 8), 100);
  writeAscii(block, octalField(1000, 8), 108);
  writeAscii(block, octalField(1000, 8), 116);
  writeAscii(block, octalField(size, 12), 124);
  writeAscii(block, octalField(mtime, 12), 136);
  writeAscii(block, typeflag, 156);
  writeAscii(block, "ustar\u000000", 257);
  block.fill(0x20, 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  writeAscii(block, `${octalField(sum, 7)} `, 148);
  return block;
}

/** A PAX record, its length prefix counting itself. */
export function paxRecord(key: string, value: string): Uint8Array {
  const body = encoder.encode(` ${key}=${value}\n`);
  let length = body.length + 1;
  while (body.length + String(length).length !== length) length = body.length + String(length).length;
  return concat([encoder.encode(String(length)), body]);
}

function padded(data: Uint8Array): Uint8Array[] {
  const rest = data.length % BLOCK;
  return rest === 0 ? [data] : [data, new Uint8Array(BLOCK - rest)];
}

/** A clean ustar archive of these entries, in order; a name over 100 bytes travels in a PAX `path`. */
export function writeTar(entries: readonly CleanEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const stored = entry.type === "directory" ? `${entry.path}/` : entry.path;
    const name = encoder.encode(stored);
    if (name.length > 100) {
      const record = paxRecord("path", stored);
      parts.push(header(encoder.encode("PaxHeader"), "x", record.length, 0o644, entry.mtime), ...padded(record));
    }
    const size = entry.type === "file" ? entry.data.length : 0;
    parts.push(header(name, entry.type === "file" ? "0" : "5", size, entry.mode, entry.mtime));
    if (size > 0) parts.push(...padded(entry.data));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  return concat(parts);
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
  /** The clean archive; meaningful only when `refused` is empty. */
  tar: Uint8Array;
  /** `<path>: <reason>`, in archive order; one entry refuses the whole archive. */
  refused: string[];
}

/** A path as it may be shown: control characters become `?`, cut at 300 characters. */
function shown(path: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = path.replace(/[\u0000-\u001f\u007f]/g, "?");
  return safe.length > 300 ? `${safe.slice(0, 300)}…` : safe;
}

/**
 * The archive judged entry by entry: a regular file or a directory at a path
 * `projectPathProblem` accepts (one leading `./` dropped, the root `.`
 * skipped), in UTF-8. Every other entry is named in `refused`. Throws
 * {@link TarError} when the archive itself is malformed.
 */
export function sanitizeArchive(archive: Uint8Array): SanitizedArchive {
  const clean: CleanEntry[] = [];
  // Conflicts are refused too: GNU tar would resolve a file under a file, a
  // file over a directory or the same file twice by replacing one with the
  // other, so the tree unpacked would depend on the order of a student's
  // entries rather than on what this function accepted.
  const kinds = new Map<string, CleanEntry["type"]>();
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
    const type: CleanEntry["type"] | null =
      entry.typeflag === "5" ? "directory" : FILE_TYPES.has(entry.typeflag) ? (path.endsWith("/") ? "directory" : "file") : null;
    const problem =
      typeReason ??
      (type === null ? "unsupported_type" : !entry.utf8 ? "not_utf8" : projectPathProblem(path));
    if (problem !== null || type === null) {
      refuse(path, problem ?? "unsupported_type");
      continue;
    }
    path = path.replace(/\/$/, "");

    const segments = path.split("/");
    const ancestors = segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join("/"));
    const existing = kinds.get(path);
    if (existing === "directory" && type === "directory") continue;
    if (ancestors.some((ancestor) => kinds.get(ancestor) === "file") || existing !== undefined) {
      refuse(path, existing === type ? "duplicate" : "conflict");
      continue;
    }

    const mtime = Math.min(Math.max(0, entry.mtime), now);
    for (const ancestor of ancestors) {
      if (kinds.has(ancestor)) continue;
      kinds.set(ancestor, "directory");
      clean.push({ path: ancestor, type: "directory", mode: 0o755, mtime, data: new Uint8Array(0) });
    }
    kinds.set(path, type);
    clean.push({
      path,
      type,
      mode: type === "directory" || (entry.mode & 0o111) !== 0 ? 0o755 : 0o644,
      mtime,
      data: type === "file" ? entry.data : new Uint8Array(0),
    });
  }

  if (refusedCount > refused.length) refused.push(`… and ${refusedCount - refused.length} more`);
  return { tar: refused.length === 0 ? writeTar(clean) : new Uint8Array(0), refused };
}
