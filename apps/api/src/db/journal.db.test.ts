/**
 * The journal's tables (`db/journal.ts`, migration `0037_journal`) against
 * the real migrations: one row per classroom (D03), the copy keyed by
 * `(classroom_id, path)` and dropped with the row, `bytea` assets (D14), and
 * the constraints the module (M4-02) relies on; the two modes and the
 * revisions of ADR-057 (migration `0050_journal_modes`, M4-07).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "./client.js";
import {
  classroomJournals,
  classrooms,
  courses,
  journalAssets,
  journalPageRevisions,
  journalPages,
  users,
} from "./schema.js";
import { MIGRATIONS_DIR } from "../paths.js";
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
    mode: "github",
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
    htmlStaff: "<h1>x</h1>",
    htmlStudent: "<h1>x</h1>",
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

describe("the two modes (ADR-057)", () => {
  const quiz = (classroomId: string) => ({ classroomId, mode: "quiz" as const, createdBy: teacherId });
  const github = (classroomId: string) => ({
    classroomId,
    mode: "github" as const,
    githubRepoId: 42,
    fullName: "heig-prg/prg1-journal",
    ref: "main",
    createdBy: teacherId,
  });

  it("holds a repository in GitHub mode, and none in Quiz mode", async () => {
    const [q, g] = [await classroom(), await classroom()];
    await db.insert(classroomJournals).values(quiz(q));
    await db.insert(classroomJournals).values(github(g));
    const rows = await db.select().from(classroomJournals).where(eq(classroomJournals.classroomId, q));
    expect(rows[0]).toMatchObject({ mode: "quiz", githubRepoId: null, fullName: null, ref: null });
  });

  it("refuses an inconsistent row (classroom_journals_mode_ck)", async () => {
    const c = await classroom();
    const refused = [
      { ...quiz(c), fullName: "heig-prg/x" },
      { ...quiz(c), githubRepoId: 7 },
      { ...quiz(c), ref: "main" },
      { ...github(c), githubRepoId: null },
      { ...github(c), fullName: null },
      { ...github(c), ref: null },
    ];
    for (const row of refused) {
      await expect(db.insert(classroomJournals).values(row), JSON.stringify(row)).rejects.toThrow();
    }
    // Neither a mode outside the two, nor none at all: the column has no default.
    await expect(
      db.execute(sql`INSERT INTO classroom_journals (classroom_id, mode, created_by) VALUES (${c}, 'local', ${teacherId})`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`INSERT INTO classroom_journals (classroom_id, created_by) VALUES (${c}, ${teacherId})`),
    ).rejects.toThrow();
    expect(await db.select().from(classroomJournals).where(eq(classroomJournals.classroomId, c))).toEqual([]);
  });

  it("keeps a page's revisions, gone with the journal", async () => {
    const c = await classroom();
    await db.insert(classroomJournals).values(quiz(c));
    const revision = (markdown: string) => ({
      id: randomUUID(),
      classroomId: c,
      path: "010-intro.md",
      markdown,
      frontMatter: { title: "Intro" },
      authorId: teacherId,
    });
    await db.insert(journalPageRevisions).values([revision("# One\n"), revision("# Two\n")]);
    const kept = await db.select().from(journalPageRevisions).where(eq(journalPageRevisions.classroomId, c));
    expect(kept.map((r) => r.markdown).sort()).toEqual(["# One\n", "# Two\n"]);
    expect(kept[0]).toMatchObject({ frontMatter: { title: "Intro" }, authorId: teacherId });

    await db.delete(classroomJournals).where(eq(classroomJournals.classroomId, c));
    expect(await db.select().from(journalPageRevisions).where(eq(journalPageRevisions.classroomId, c))).toEqual([]);
  });

  it("migrates the journals already there to GitHub mode (0050_journal_modes)", async () => {
    const { entries } = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    const at = entries.findIndex((e) => e.tag === "0050_journal_modes");
    expect(at).toBeGreaterThan(0);
    const run = (tag: string) =>
      client.exec(readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
    const client = new PGlite();
    try {
      for (const { tag } of entries.slice(0, at)) await run(tag);
      const [u, co, cl] = [randomUUID(), randomUUID(), randomUUID()];
      await client.query("INSERT INTO users (id, oidc_sub, email) VALUES ($1, $2, 'm@heig-vd.ch')", [u, `sub-${u}`]);
      await client.query("INSERT INTO courses (id, name, code) VALUES ($1, 'Programmation C', 'PRG1')", [co]);
      await client.query("INSERT INTO classrooms (id, course_id, name, period) VALUES ($1, $2, 'C', '')", [cl, co]);
      await client.query(
        `INSERT INTO classroom_journals (classroom_id, github_repo_id, full_name, ref, created_by)
         VALUES ($1, 42, 'heig-prg/prg1-journal', 'main', $2)`,
        [cl, u],
      );

      await run("0050_journal_modes");
      const { rows } = await client.query<{ mode: string; full_name: string }>(
        "SELECT mode, full_name FROM classroom_journals WHERE classroom_id = $1",
        [cl],
      );
      expect(rows).toEqual([{ mode: "github", full_name: "heig-prg/prg1-journal" }]);
      const { rows: defaults } = await client.query<{ column_default: string | null }>(
        "SELECT column_default FROM information_schema.columns WHERE table_name = 'classroom_journals' AND column_name = 'mode'",
      );
      expect(defaults).toEqual([{ column_default: null }]);
    } finally {
      await client.close();
    }
  });
});
