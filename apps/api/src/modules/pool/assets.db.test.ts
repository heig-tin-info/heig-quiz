/**
 * The image store underneath the asset routes (F-QST-06): what the BYTES
 * are (the header a browser sent is never asked), where a file lands, that
 * a stored path cannot climb out of `ASSETS_DIR`, and that the same bytes
 * are one row and one file even when two uploads race.
 *
 * The routes' own tests (`routes.db.test.ts`) upload PNGs; the other three
 * formats, their dimensions and the refusals are pinned here.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "../../db/client.js";
import { assets, pools, users } from "../../db/schema.js";
import { testDb } from "../../test/db.js";
import {
  isAllowedMime,
  pathForHash,
  readAsset,
  sha256Of,
  sniffImage,
  storeAsset,
  writeAsset,
} from "./assets.js";

/** A PNG header announcing `width` x `height` (IHDR at its fixed offset). */
function png(width: number, height: number, salt = 0): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[32] = salt;
  return bytes;
}

function gif(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(13);
  bytes.write("GIF89a", 0, "latin1");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

/** SOI, an APP0 segment to skip, then a SOF0 frame header. */
function jpeg(width: number, height: number, sof = 0xc0): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const frame = Buffer.alloc(11);
  frame[0] = 0xff;
  frame[1] = sof;
  frame.writeUInt16BE(8, 2);
  frame[4] = 8;
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), app0.subarray(1), frame]);
}

function webp(kind: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.write("RIFF", 0, "latin1");
  bytes.write("WEBP", 8, "latin1");
  bytes.write(kind, 12, "latin1");
  if (kind === "VP8 ") {
    bytes.writeUInt16LE(width, 26);
    bytes.writeUInt16LE(height, 28);
  } else if (kind === "VP8L") {
    bytes.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  } else {
    bytes.writeUIntLE(width - 1, 24, 3);
    bytes.writeUIntLE(height - 1, 27, 3);
  }
  return bytes;
}

describe("sniffImage: the bytes decide the type", () => {
  it("reads each accepted format and its dimensions", () => {
    expect(sniffImage(png(640, 480))).toEqual({ mime: "image/png", width: 640, height: 480 });
    expect(sniffImage(gif(32, 16))).toEqual({ mime: "image/gif", width: 32, height: 16 });
    expect(sniffImage(jpeg(1024, 768))).toEqual({ mime: "image/jpeg", width: 1024, height: 768 });
    // A progressive JPEG (SOF2) is a frame header too.
    expect(sniffImage(jpeg(300, 200, 0xc2))).toEqual({ mime: "image/jpeg", width: 300, height: 200 });
    expect(sniffImage(webp("VP8 ", 400, 300))).toEqual({ mime: "image/webp", width: 400, height: 300 });
    expect(sniffImage(webp("VP8L", 1000, 50))).toEqual({ mime: "image/webp", width: 1000, height: 50 });
    expect(sniffImage(webp("VP8X", 5000, 70_000))).toEqual({ mime: "image/webp", width: 5000, height: 70_000 });
  });

  it("keeps the type and leaves the size unknown when the header cannot be read", () => {
    // A JPEG cut before any frame header.
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]))).toEqual({
      mime: "image/jpeg",
      width: null,
      height: null,
    });
    // A DHT segment (0xc4) is in the SOF range but is not a frame header.
    const dhtOnly = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xc4, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    ]);
    expect(sniffImage(dhtOnly)).toEqual({ mime: "image/jpeg", width: null, height: null });
    // A WebP of a flavour we do not parse.
    const odd = webp("VP8X", 1, 1);
    odd.write("ALPH", 12, "latin1");
    expect(sniffImage(odd)).toEqual({ mime: "image/webp", width: null, height: null });
  });

  it("recognises nothing else: SVG, HTML, a truncated PNG, empty bytes", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(sniffImage(svg)).toBeNull();
    expect(sniffImage(Buffer.from("<!doctype html><html></html>"))).toBeNull();
    expect(sniffImage(png(1, 1).subarray(0, 20))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
    // RIFF but not WEBP (a WAV file).
    const wav = webp("VP8 ", 1, 1);
    wav.write("WAVE", 8, "latin1");
    expect(sniffImage(wav)).toBeNull();
  });

  it("accepts exactly the four image types as mime", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(isAllowedMime(mime)).toBe(true);
    }
    for (const mime of ["image/svg+xml", "text/html", "application/octet-stream", ""]) {
      expect(isAllowedMime(mime)).toBe(false);
    }
  });
});

describe("the files under ASSETS_DIR", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "quiz-assets-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("files a hash one directory deep, under its first two characters", () => {
    const sha = sha256Of(Buffer.from("x"));
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(pathForHash(sha)).toBe(join(sha.slice(0, 2), sha));
  });

  it("writes and reads back the same bytes", async () => {
    const bytes = png(2, 2);
    const path = pathForHash(sha256Of(bytes));
    await writeAsset(dir, path, bytes);
    expect((await readAsset(dir, path)).equals(bytes)).toBe(true);
  });

  it("refuses a stored path that escapes the directory, reading or writing", async () => {
    for (const escape of ["../outside", "../../etc/passwd", "/etc/passwd", `ab/../../x`]) {
      await expect(readAsset(dir, escape)).rejects.toThrow(/escapes/);
      await expect(writeAsset(dir, escape, Buffer.from("x"))).rejects.toThrow(/escapes/);
    }
  });
});

describe("storeAsset: content-addressed", () => {
  let db: Db;
  let dir: string;
  let ownerId: string;
  let poolId: string;

  beforeAll(async () => {
    db = await testDb();
    dir = await mkdtemp(join(tmpdir(), "quiz-assets-"));
    ownerId = randomUUID();
    await db.insert(users).values({ id: ownerId, oidcSub: `t-${ownerId}`, email: "o@heig.test", role: "teacher" });
    poolId = randomUUID();
    await db.insert(pools).values({ id: poolId, name: "Pool", ownerId });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const upload = (bytes: Buffer) => ({ bytes, facts: sniffImage(bytes)!, ownerId, poolId });

  it("stores new bytes once, with what was sniffed, and reuses them afterwards", async () => {
    const bytes = gif(7, 9);
    const first = await storeAsset(db, dir, upload(bytes));
    expect(first.fresh).toBe(true);
    expect(first.row).toMatchObject({
      mime: "image/gif",
      width: 7,
      height: 9,
      bytes: bytes.length,
      sha256: sha256Of(bytes),
      path: pathForHash(sha256Of(bytes)),
      ownerId,
      poolId,
    });

    const second = await storeAsset(db, dir, upload(bytes));
    expect(second.fresh).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(await db.select().from(assets).where(eq(assets.sha256, sha256Of(bytes)))).toHaveLength(1);
  });

  it("resolves two uploads of the same bytes at once to one row, one fresh", async () => {
    // PGlite has a single connection, which serialises the two calls' statements:
    // whether they interleave far enough to hit the insert conflict is not under
    // the test's control. The claim holds either way: one row, one fresh.
    const bytes = png(3, 3, 42);
    const results = await Promise.all([storeAsset(db, dir, upload(bytes)), storeAsset(db, dir, upload(bytes))]);
    expect(new Set(results.map((r) => r.row.id)).size).toBe(1);
    expect(results.filter((r) => r.fresh)).toHaveLength(1);
    const rows = await db.select().from(assets).where(eq(assets.sha256, sha256Of(bytes)));
    expect(rows).toHaveLength(1);
    const sha = sha256Of(bytes);
    expect(await readdir(join(dir, sha.slice(0, 2)))).toEqual([sha]);
  });
});
