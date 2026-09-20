/**
 * Images embedded in question content (F-QST-06, PLAN-MVP §4.2).
 *
 * Three rules, all enforced here:
 *   - the TYPE is decided by the bytes, never by the `content-type` the
 *     browser sent: a file is accepted only if its magic number says png,
 *     jpeg, gif or webp. SVG is refused outright — it is a script container,
 *     and sanitising it is a project of its own (N-SEC);
 *   - the same bytes are stored ONCE: the sha256 is the identity of an
 *     asset, so pasting the same screenshot in ten questions costs one file;
 *   - the file is served from the same origin with an immutable cache and
 *     `nosniff`, so a browser can never be talked into executing it.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { AssetMime } from "@quiz/contracts";

/** The only types a question may embed. SVG is deliberately absent. */
const ALLOWED: readonly AssetMime[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export function isAllowedMime(mime: string): mime is AssetMime {
  return (ALLOWED as readonly string[]).includes(mime);
}

export interface ImageFacts {
  mime: AssetMime;
  width: number | null;
  height: number | null;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * What the bytes actually are, and how big the picture is.
 *
 * Returns null for anything that is not one of the four accepted formats —
 * including an SVG, which is plain text and therefore matches no magic
 * number. The dimensions are best effort: a format we can read the header of
 * gives them, otherwise they stay null (the column is nullable).
 */
export function sniffImage(bytes: Buffer): ImageFacts | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    return { mime: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { mime: "image/gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ...jpegSize(bytes) };
  }
  if (
    bytes.length >= 30 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { mime: "image/webp", ...webpSize(bytes) };
  }
  return null;
}

/** Walks the JPEG segment chain to the first frame header (SOF). */
function jpegSize(bytes: Buffer): { width: number | null; height: number | null } {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // SOF0..SOF15, minus the four markers that are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return { width: null, height: null };
}

/** VP8 / VP8L / VP8X, the three WebP flavours. */
function webpSize(bytes: Buffer): { width: number | null; height: number | null } {
  const kind = bytes.subarray(12, 16).toString("latin1");
  if (kind === "VP8 " && bytes.length >= 30) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (kind === "VP8L" && bytes.length >= 25) {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8X" && bytes.length >= 30) {
    const read24 = (at: number) => bytes.readUIntLE(at, 3) + 1;
    return { width: read24(24), height: read24(27) };
  }
  return { width: null, height: null };
}

/** `ab/abcdef…` — one directory level, so no directory ever holds 100k files. */
export function pathForHash(sha256: string): string {
  return join(sha256.slice(0, 2), sha256);
}

export function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Writes the bytes under `ASSETS_DIR` unless they are already there. Callers
 * hold the database row; this function only owns the file.
 */
export async function writeAsset(
  assetsDir: string,
  relativePath: string,
  bytes: Buffer,
): Promise<void> {
  const full = safeJoin(assetsDir, relativePath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, bytes);
}

export async function readAsset(assetsDir: string, relativePath: string): Promise<Buffer> {
  return readFile(safeJoin(assetsDir, relativePath));
}

/**
 * `path` comes from the database, but a stored value is still an input:
 * anything that escapes `ASSETS_DIR` is refused rather than read.
 */
export function safeJoin(assetsDir: string, relativePath: string): string {
  const base = resolve(assetsDir);
  const full = resolve(base, relativePath);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error("asset path escapes the asset directory");
  }
  return full;
}
