/**
 * The journal's tables (`db/journal.ts`, migration `0037_journal`) against
 * the real migrations: one row per classroom (D03), the copy keyed by
 * `(classroom_id, path)` and dropped with the row, `bytea` assets (D14), and
 * the constraints the module (M4-02) relies on.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "./client.js";
import { classroomJournals, classrooms, courses, journalAssets, journalPages, users } from "./schema.js";
import { testDb } from "../test/db.js";

let db: Db;
let teacherId: string;
let courseId: string;

beforeAll(async () => {
  db = await testDb();
  teacherId = randomUUID();
  await db.insert(users).values({ id: teacherId, oidcSub: `sub-${teacherId}`, email: "t@heig-vd.ch" });
  courseId = randomUUID();
  await db.insert(courses).values({ id: courseId, name: "Programmation C", code: "PRG1" });
});

async function classroom(): Promise<string> {
  const id = randomUUID();
  await db.insert(classrooms).values({ id, courseId, name: `C-${id.slice(0, 4)}`, period: "" });
  return id;
}

async function journal(classroomId: string, githubRepoId = 42) {
  await db.insert(classroomJournals).values({
    classroomId,
    githubRepoId,
    fullName: "heig-prg/prg1-journal",
    ref: "main",
    createdBy: teacherId,
  });
}

function page(classroomId: string, path: string) {
  return {
    id: randomUUID(),
    classroomId,
    path,
    parentPath: "",
    sortKey: `1:${path}`,
    title: path,
    blobSha: "a".repeat(40),
    markdown: "# x\n",
    html: "<h1>x</h1>",
  };
}

function asset(classroomId: string, path: string, data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])) {
  return {
    id: randomUUID(),
    classroomId,
    path,
    blobSha: "b".repeat(40),
    contentType: "image/png",
    size: data.length,
    data,
  };
}

describe("classroom_journals", () => {
  it("holds one journal per classroom, pending until its first synchronisation", async () => {
    const c = await classroom();
    await journal(c);
    const [row] = await db.select().from(classroomJournals).where(eq(classroomJournals.classroomId, c));
    expect(row).toMatchObject({ rootPath: "", syncStatus: "pending", lastCommitSha: null });
    await expect(journal(c)).rejects.toThrow();
  });

  it("lets two classrooms use the same repository, and finds both by its id", async () => {
    const [a, b] = [await classroom(), await classroom()];
    await journal(a, 777);
    await journal(b, 777);
    const rows = await db
      .select({ classroomId: classroomJournals.classroomId })
      .from(classroomJournals)
      .where(eq(classroomJournals.githubRepoId, 777));
    expect(rows.map((r) => r.classroomId).sort()).toEqual([a, b].sort());
  });

  it("refuses a sync status outside pending, ok, error", async () => {
    const c = await classroom();
    await journal(c);
    await expect(
      db
        .update(classroomJournals)
        .set({ syncStatus: "broken" as "ok" })
        .where(eq(classroomJournals.classroomId, c)),
    ).rejects.toThrow();
  });
});

describe("the copy", () => {
  it("needs the classroom's journal row", async () => {
    const c = await classroom();
    await expect(db.insert(journalPages).values(page(c, "README.md"))).rejects.toThrow();
  });

  it("keys pages and assets by (classroom, path)", async () => {
    const [a, b] = [await classroom(), await classroom()];
    await journal(a);
    await journal(b);
    await db.insert(journalPages).values([page(a, "README.md"), page(b, "README.md")]);
    await expect(db.insert(journalPages).values(page(a, "README.md"))).rejects.toThrow();
    await db.insert(journalAssets).values([asset(a, "p.png"), asset(b, "p.png")]);
    await expect(db.insert(journalAssets).values(asset(a, "p.png"))).rejects.toThrow();
  });

  it("stores warnings as codes, the referenced assets and the bytes as they were", async () => {
    const c = await classroom();
    await journal(c);
    await db.insert(journalPages).values({
      ...page(c, "010-intro.md"),
      warnings: [{ code: "target_missing", href: "x.md", path: "x.md" }, { code: "raw_html" }],
      toc: [{ id: "x", depth: 1, text: "x" }],
      assetPaths: ["images/p.png"],
    });
    const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x5c, 0x78]);
    await db.insert(journalAssets).values(asset(c, "images/p.png", bytes));
    const [p] = await db
      .select()
      .from(journalPages)
      .where(and(eq(journalPages.classroomId, c), eq(journalPages.path, "010-intro.md")));
    expect(p).toMatchObject({
      draft: false,
      visibleFrom: null,
      frontMatter: {},
      warnings: [{ code: "target_missing", href: "x.md", path: "x.md" }, { code: "raw_html" }],
      assetPaths: ["images/p.png"],
    });
    const [a] = await db.select().from(journalAssets).where(eq(journalAssets.classroomId, c));
    expect(Buffer.from(a!.data).equals(bytes)).toBe(true);
  });

  it("refuses an asset over the size limit", async () => {
    const c = await classroom();
    await journal(c);
    await expect(
      db.insert(journalAssets).values({ ...asset(c, "big.bin"), size: 5_000_001 }),
    ).rejects.toThrow();
  });

  it("goes with the journal row, and the row with the classroom", async () => {
    const c = await classroom();
    await journal(c);
    await db.insert(journalPages).values(page(c, "README.md"));
    await db.insert(journalAssets).values(asset(c, "p.png"));
    await db.delete(classroomJournals).where(eq(classroomJournals.classroomId, c));
    expect(await db.select().from(journalPages).where(eq(journalPages.classroomId, c))).toEqual([]);
    expect(await db.select().from(journalAssets).where(eq(journalAssets.classroomId, c))).toEqual([]);

    await journal(c);
    await db.insert(journalPages).values(page(c, "README.md"));
    await db.delete(classrooms).where(eq(classrooms.id, c));
    expect(await db.select().from(classroomJournals).where(eq(classroomJournals.classroomId, c))).toEqual([]);
    expect(await db.select().from(journalPages).where(eq(journalPages.classroomId, c))).toEqual([]);
  });
});
