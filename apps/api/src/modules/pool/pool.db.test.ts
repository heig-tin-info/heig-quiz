import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import {
  courses,
  poolTags,
  pools,
  questionTags,
  questionVersions,
  questions,
  users,
} from "../../db/schema.js";
import { testDb } from "../../test/db.js";
import { fakeShort, fakeV1Config } from "../../test/fakeType.js";
import { loadConfig, saveDraftConfig, tryLoadConfig } from "./config.js";
import * as service from "./service.js";

/**
 * The backfill of the `pool_tags` migration, read from the shipped SQL: the
 * test exercises the statement that really runs, not a copy of it.
 */
function backfillStatement(): string {
  const file = fileURLToPath(
    new URL("../../../drizzle/0004_goofy_george_stacy.sql", import.meta.url),
  );
  const statement = readFileSync(file, "utf8")
    .split("--> statement-breakpoint")
    .find((part) => part.includes("INSERT INTO \"pool_tags\""));
  if (!statement) throw new Error("the pool_tags migration no longer carries its backfill");
  return statement;
}

const search = (extra: Record<string, unknown> = {}) =>
  ({ limit: 50, ...extra }) as Parameters<typeof service.listQuestions>[2];

let db: Db;
let ownerId: string;
let poolId: string;
let restore: () => void;

async function seedPool(): Promise<string> {
  const id = randomUUID();
  await db.insert(pools).values({ id, name: `Pool ${id.slice(0, 8)}`, ownerId });
  return id;
}

/** A question with its draft, through the real creation path. */
async function seedQuestion(name: string, poolOverride = poolId): Promise<string> {
  return service.createQuestion(db, {
    poolId: poolOverride,
    type: "short",
    internalName: name,
    createdBy: ownerId,
  });
}

async function questionRow(id: string) {
  const [row] = await db.select().from(questions).where(eq(questions.id, id));
  return row!;
}

async function writeDraft(id: string, config: unknown) {
  const question = await questionRow(id);
  return service.putDraft(db, question, { config });
}

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  db = (await testDb()) as unknown as Db;
  ownerId = randomUUID();
  await db
    .insert(users)
    .values({ id: ownerId, oidcSub: `s-${ownerId}`, email: "owner@heig.test", role: "teacher" });
  poolId = await seedPool();
});

afterAll(() => restore());

describe("publication (F-QST-03)", () => {
  it("numbers the first publication 1 and the next 2, and reopens a draft each time", async () => {
    const id = await seedQuestion("numbering");
    await writeDraft(id, { statement: "Capital of Italy?", answer: "Rome" });

    const first = await service.publishQuestion(db, await questionRow(id), { userId: ownerId });
    expect(first.number).toBe(1);

    await writeDraft(id, { statement: "Capital of Italy?", answer: "Roma" });
    const second = await service.publishQuestion(db, await questionRow(id), {
      userId: ownerId,
      changeNote: "spelling",
    });
    expect(second.number).toBe(2);
    expect(second.changeNote).toBe("spelling");

    // One draft, always: the partial unique index is the invariant.
    const drafts = await db
      .select()
      .from(questionVersions)
      .where(and(eq(questionVersions.questionId, id), isNull(questionVersions.number)));
    expect(drafts).toHaveLength(1);
    const detail = await service.questionDetail(db, await questionRow(id));
    expect(detail.versions.map((v) => v.number)).toEqual([2, 1]);
    expect(detail.latestPublished?.number).toBe(2);
    // Publishing leaves the draft in step with the version it just cut.
    expect(detail.draft.config).toEqual({ statement: "Capital of Italy?", answer: "Roma" });
  });

  it("two simultaneous publications produce two distinct numbers and one draft", async () => {
    // NOTE: PGlite is single-connection, so the two transactions are
    // serialized rather than truly concurrent — what this asserts is the
    // outcome the indexes guarantee, not the interleaving.
    const id = await seedQuestion("concurrent");
    await writeDraft(id, { statement: "Race", answer: "one" });
    const question = await questionRow(id);
    const results = await Promise.allSettled([
      service.publishQuestion(db, question, { userId: ownerId }),
      service.publishQuestion(db, question, { userId: ownerId }),
    ]);
    const numbers = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => (r as PromiseFulfilledResult<{ number: number }>).value.number);
    expect(numbers.length).toBeGreaterThanOrEqual(1);
    expect(new Set(numbers).size).toBe(numbers.length);
    const drafts = await db
      .select()
      .from(questionVersions)
      .where(and(eq(questionVersions.questionId, id), isNull(questionVersions.number)));
    expect(drafts).toHaveLength(1);
  });

  it("refuses to publish an invalid draft and says why", async () => {
    const id = await seedQuestion("invalid at publish");
    const saved = await writeDraft(id, { statement: "No key", answer: "" });
    // D16: the invalid config was STORED, with its issues.
    expect(saved.valid).toBe(false);
    expect(saved.issues.map((i) => i.path.join("."))).toContain("answer");

    const [stored] = await db
      .select()
      .from(questionVersions)
      .where(and(eq(questionVersions.questionId, id), isNull(questionVersions.number)));
    expect(stored!.config).toEqual({ statement: "No key", answer: "" });

    await expect(
      service.publishQuestion(db, await questionRow(id), { userId: ownerId }),
    ).rejects.toBeInstanceOf(service.DraftInvalid);
    expect(await service.listVersions(db, id)).toEqual([]);
  });

  it("a second draft row cannot exist (the index, not the service, guarantees it)", async () => {
    const id = await seedQuestion("one draft only");
    await expect(
      db.insert(questionVersions).values({
        id: randomUUID(),
        questionId: id,
        number: null,
        config: { statement: "x", answer: "y" },
        configVersion: 2,
      }),
    ).rejects.toThrow();
  });
});

describe("the read/write pipeline (§1.6)", () => {
  it("raises a stored v1 config to the current version on read", async () => {
    const id = await seedQuestion("migrated");
    // Written as version 1 would have written it, straight into the table.
    await db
      .update(questionVersions)
      .set({ config: fakeV1Config("Old wording", "42"), configVersion: 1 })
      .where(and(eq(questionVersions.questionId, id), isNull(questionVersions.number)));

    const detail = await service.questionDetail(db, await questionRow(id));
    expect(detail.draft.valid).toBe(true);
    expect(detail.draft.config).toEqual({ statement: "Old wording", answer: "42" });

    // And publishing stamps the CURRENT version, so the row stops lagging.
    const version = await service.publishQuestion(db, await questionRow(id), { userId: ownerId });
    const published = await service.versionDetail(db, await questionRow(id), version.number);
    expect(published?.configVersion).toBe(2);
    expect(published?.config).toEqual({ statement: "Old wording", answer: "42" });
  });

  it("loadConfig throws on a config no migration can save, tryLoadConfig does not", () => {
    const row = { config: { statement: 7 }, configVersion: 2 };
    expect(() => loadConfig("short", row)).toThrow();
    const outcome = tryLoadConfig("short", row);
    expect(outcome.ok).toBe(false);
  });

  /*
   * An INVALID draft at an old version, which is where the two halves of a
   * row used to part company: the editor was handed the stored bytes, wrote
   * them back unchanged, and `saveDraftConfig` stamped the row with the
   * current version — an old shape under a number it did not have. Nothing
   * migrated it afterwards, `configVersion` failed on every parse, and a
   * failing literal ABORTS a zod object: the refinements never ran, so the
   * teacher was told nothing about the field they were working on.
   *
   * The real `mcq` type, because the fakes carry no `configVersion` inside
   * their configs and this is precisely about that field.
   */
  const v1Mcq = (over: Record<string, unknown> = {}) => ({
    configVersion: 1,
    prompt: "Which of these are prime?",
    choices: [
      { text: "2", correct: true },
      { text: "3", correct: true },
      { text: "5", correct: true },
    ],
    mode: "multiple",
    policy: "partial",
    penalty: 1,
    allowNegative: false,
    shuffleChoices: true,
    ...over,
  });

  it("hands an invalid draft back at the CURRENT shape, migrated", () => {
    const outcome = tryLoadConfig("mcq", { config: v1Mcq({ prompt: "" }), configVersion: 1 });
    expect(outcome.ok).toBe(false);
    expect(outcome.config).toMatchObject({ configVersion: 2, policy: "symmetric" });
    expect(outcome.config).not.toHaveProperty("penalty");
  });

  it("raises a draft that declares an older version before storing it", () => {
    const { row, issues } = saveDraftConfig("mcq", v1Mcq({ maxSelections: 2 }));
    // The stored blob agrees with the column beside it…
    expect(row.configVersion).toBe(2);
    expect(row.config).toMatchObject({ configVersion: 2 });
    // …and the issue reported is the teacher's, not a version mismatch that
    // would have hidden it.
    expect(issues.map((i) => i.message)).toEqual(["mcq.max_below_correct"]);
    expect(issues[0]?.path).toEqual(["maxSelections"]);
  });
});

describe("versions", () => {
  it("restores a published version into the draft", async () => {
    const id = await seedQuestion("restorable");
    await writeDraft(id, { statement: "First", answer: "a" });
    await service.publishQuestion(db, await questionRow(id), { userId: ownerId });
    await writeDraft(id, { statement: "Second", answer: "b" });

    expect(await service.restoreVersion(db, await questionRow(id), 1)).toBe(true);
    const detail = await service.questionDetail(db, await questionRow(id));
    expect(detail.draft.config).toEqual({ statement: "First", answer: "a" });
    expect(await service.restoreVersion(db, await questionRow(id), 99)).toBe(false);
  });

  it("deprecates a version without removing it", async () => {
    const id = await seedQuestion("deprecatable");
    await writeDraft(id, { statement: "Old", answer: "a" });
    await service.publishQuestion(db, await questionRow(id), { userId: ownerId });
    const version = await service.deprecateVersion(db, id, 1, "superseded by the new syllabus");
    expect(version?.deprecatedAt).not.toBeNull();
    expect(version?.deprecationNote).toBe("superseded by the new syllabus");
    const page = await service.listQuestions(db, poolId, search({ q: "Old" }));
    expect(page.items.find((q) => q.id === id)?.deprecated).toBe(true);
  });
});

describe("soft delete (F-QST-11)", () => {
  it("hides the question from the pool but keeps its versions", async () => {
    const id = await seedQuestion("deletable");
    await writeDraft(id, { statement: "Doomed", answer: "a" });
    await service.publishQuestion(db, await questionRow(id), { userId: ownerId });

    await service.softDeleteQuestion(db, await questionRow(id));
    const visible = await service.listQuestions(db, poolId, search());
    expect(visible.items.map((q) => q.id)).not.toContain(id);

    const withDeleted = await service.listQuestions(db, poolId, search({ includeDeleted: true }));
    expect(withDeleted.items.map((q) => q.id)).toContain(id);
    expect(await service.listVersions(db, id)).toHaveLength(1);

    await service.restoreQuestion(db, await questionRow(id));
    const again = await service.listQuestions(db, poolId, search());
    expect(again.items.map((q) => q.id)).toContain(id);
  });

  it("frees the name: the unique index only covers live questions", async () => {
    const id = await seedQuestion("reusable name");
    await service.softDeleteQuestion(db, await questionRow(id));
    await expect(seedQuestion("reusable name")).resolves.toBeTruthy();
  });

  it("isVersionInUse is the WP5 seam and answers false for now", async () => {
    const id = await seedQuestion("not in use");
    await writeDraft(id, { statement: "Free", answer: "a" });
    const version = await service.publishQuestion(db, await questionRow(id), { userId: ownerId });
    const row = await service.versionRow(db, id, version.number);
    expect(await service.isVersionInUse(db, row!.id)).toBe(false);
    await expect(
      service.hardDeleteQuestion(db, await questionRow(id)),
    ).resolves.toBeUndefined();
    expect(await db.select().from(questions).where(eq(questions.id, id))).toEqual([]);
  });
});

describe("search", () => {
  let searchPool: string;
  let alpha: string;
  let beta: string;

  beforeAll(async () => {
    searchPool = await seedPool();
    alpha = await seedQuestion("Pointers in C", searchPool);
    beta = await seedQuestion("Recursion basics", searchPool);
    await writeDraft(alpha, { statement: "What does malloc return?", answer: "a pointer" });
    await writeDraft(beta, { statement: "Define a base case", answer: "termination" });
    await service.patchQuestion(db, await questionRow(alpha), {
      tags: ["memory", "C"],
      difficulty: 4,
    });
    await service.patchQuestion(db, await questionRow(beta), { tags: ["theory"], difficulty: 2 });
  });

  it("finds a question by the text of its draft, through the generated tsvector", async () => {
    const page = await service.listQuestions(db, searchPool, search({ q: "malloc" }));
    expect(page.items.map((q) => q.id)).toEqual([alpha]);
  });

  it("finds a question by its internal name", async () => {
    const page = await service.listQuestions(db, searchPool, search({ q: "Recursion" }));
    expect(page.items.map((q) => q.id)).toEqual([beta]);
  });

  it("filters by tag, by type and by difficulty", async () => {
    expect(
      (await service.listQuestions(db, searchPool, search({ tag: ["memory"] }))).items.map((q) => q.id),
    ).toEqual([alpha]);
    expect(
      (await service.listQuestions(db, searchPool, search({ difficulty: [2] }))).items.map((q) => q.id),
    ).toEqual([beta]);
    expect(
      (await service.listQuestions(db, searchPool, search({ type: ["short"] }))).items,
    ).toHaveLength(2);
    expect(
      (await service.listQuestions(db, searchPool, search({ type: ["mcq"] }))).items,
    ).toHaveLength(0);
  });

  it("lists the tags of the pool, deduplicated and sorted", async () => {
    expect(await service.poolTagNames(db, searchPool)).toEqual(["c", "memory", "theory"]);
    expect(await service.poolTags(db, searchPool)).toEqual([
      { tag: "c", description: "", count: 1 },
      { tag: "memory", description: "", count: 1 },
      { tag: "theory", description: "", count: 1 },
    ]);
  });

  it("paginates with an opaque cursor", async () => {
    const first = await service.listQuestions(db, searchPool, search({ limit: 1 }));
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.listQuestions(
      db,
      searchPool,
      search({ limit: 1, cursor: first.nextCursor }),
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(second.nextCursor).toBeNull();
  });
});

describe("categories and copies", () => {
  it("builds the tree, reorders it and refuses a cycle", async () => {
    const treePool = await seedPool();
    const root = await service.createCategory(db, treePool, { name: "Chapter 1" });
    const child = await service.createCategory(db, treePool, {
      name: "Section 1.1",
      parentId: root.id,
    });
    const tree = await service.categoryTree(db, treePool);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children[0]!.id).toBe(child.id);

    expect(await service.wouldCycle(db, root.id, child.id)).toBe(true);
    expect(await service.wouldCycle(db, child.id, null)).toBe(false);

    await service.reorderCategories(db, treePool, [
      { id: child.id, parentId: null, position: 0 },
      { id: root.id, parentId: null, position: 1 },
    ]);
    const flat = await service.categoryTree(db, treePool);
    expect(flat.map((c) => c.name)).toEqual(["Section 1.1", "Chapter 1"]);
  });

  it("copies a question into another pool under a free name", async () => {
    const target = await seedPool();
    const id = await seedQuestion("copy me");
    await writeDraft(id, { statement: "Copied", answer: "yes" });
    await service.patchQuestion(db, await questionRow(id), { tags: ["shared"] });

    const copyId = await service.copyQuestion(db, await questionRow(id), {
      targetPoolId: target.valueOf(),
      userId: ownerId,
    });
    const copy = await questionRow(copyId);
    expect(copy.poolId).toBe(target);
    expect(copy.originQuestionId).toBe(id);
    const detail = await service.questionDetail(db, copy);
    expect(detail.draft.config).toEqual({ statement: "Copied", answer: "yes" });
    expect(detail.meta.tags).toEqual(["shared"]);
    // The history stays with the original.
    expect(detail.versions).toEqual([]);

    // Copying next to the original picks a free name rather than failing.
    const sibling = await service.copyQuestion(db, await questionRow(id), {
      targetPoolId: poolId,
      userId: ownerId,
    });
    expect((await questionRow(sibling)).internalName).toBe("copy me (copy)");
  });

  it("keeps the tag set of a question in step with the patch", async () => {
    const id = await seedQuestion("retagged");
    await service.patchQuestion(db, await questionRow(id), { tags: ["A", "b", "A"] });
    const rows = await db.select().from(questionTags).where(eq(questionTags.questionId, id));
    expect(rows.map((r) => r.tag).sort()).toEqual(["a", "b"]);
    await service.patchQuestion(db, await questionRow(id), { tags: [] });
    expect(await db.select().from(questionTags).where(eq(questionTags.questionId, id))).toEqual([]);
  });
});

describe("the tag vocabulary of a pool", () => {
  it("creates the row of a tag the pool has never seen, and keeps it when the tag is dropped", async () => {
    const vocabulary = await seedPool();
    const id = await seedQuestion("lazy tag", vocabulary);
    await service.patchQuestion(db, await questionRow(id), { tags: ["Fork", "pipe"] });

    const rows = await db.select().from(poolTags).where(eq(poolTags.poolId, vocabulary));
    expect(rows.map((r) => r.tag).sort()).toEqual(["fork", "pipe"]);
    expect(rows.every((r) => r.description === "")).toBe(true);

    // The documentation of a tag outlives its last use: the row stays, the
    // count falls to zero, and re-adding the tag finds its description again.
    await service.describeTag(db, vocabulary, "fork", "Creates a child process");
    await service.patchQuestion(db, await questionRow(id), { tags: ["pipe"] });
    expect(await service.poolTags(db, vocabulary)).toEqual([
      { tag: "fork", description: "Creates a child process", count: 0 },
      { tag: "pipe", description: "", count: 1 },
    ]);
  });

  it("counts the live questions of each tag, never the deleted ones", async () => {
    const counted = await seedPool();
    const one = await seedQuestion("counted one", counted);
    const two = await seedQuestion("counted two", counted);
    await service.patchQuestion(db, await questionRow(one), { tags: ["shared", "solo"] });
    await service.patchQuestion(db, await questionRow(two), { tags: ["shared"] });
    expect(await service.poolTags(db, counted)).toEqual([
      { tag: "shared", description: "", count: 2 },
      { tag: "solo", description: "", count: 1 },
    ]);

    await service.softDeleteQuestion(db, await questionRow(two));
    expect((await service.poolTags(db, counted)).find((t) => t.tag === "shared")?.count).toBe(1);
  });

  it("normalizes the tag it documents and overwrites an existing description", async () => {
    const documented = await seedPool();
    const id = await seedQuestion("documented", documented);
    await service.patchQuestion(db, await questionRow(id), { tags: ["malloc"] });

    expect(await service.describeTag(db, documented, "#MALLOC", "Allocates memory")).toEqual({
      tag: "malloc",
      description: "Allocates memory",
      count: 1,
    });
    await service.describeTag(db, documented, "malloc", "Allocates on the heap");
    expect(await service.poolTags(db, documented)).toEqual([
      { tag: "malloc", description: "Allocates on the heap", count: 1 },
    ]);
  });

  it("gives a row to a tag that only exists on a copied question", async () => {
    const source = await seedPool();
    const target = await seedPool();
    const id = await seedQuestion("copied tags", source);
    await service.patchQuestion(db, await questionRow(id), { tags: ["ipc"] });

    await service.copyQuestion(db, await questionRow(id), {
      targetPoolId: target,
      userId: ownerId,
    });
    expect(await service.poolTags(db, target)).toEqual([
      { tag: "ipc", description: "", count: 1 },
    ]);
  });

  it("backfills the pools written before the table existed, exactly as the migration does", async () => {
    const legacy = await seedPool();
    const id = await seedQuestion("legacy tags", legacy);
    await service.patchQuestion(db, await questionRow(id), { tags: ["legacy"] });
    // Back to the state of a database migrated from before `pool_tags`: the
    // questions wear their tags and no vocabulary row exists.
    await db.delete(poolTags).where(eq(poolTags.poolId, legacy));
    expect(await db.select().from(poolTags).where(eq(poolTags.poolId, legacy))).toEqual([]);

    await db.execute(sql.raw(backfillStatement()));

    const rows = await db.select().from(poolTags).where(eq(poolTags.poolId, legacy));
    expect(rows.map((r) => r.tag)).toEqual(["legacy"]);
    // `ON CONFLICT DO NOTHING`: replaying the migration keeps the descriptions.
    await service.describeTag(db, legacy, "legacy", "From the old world");
    await db.execute(sql.raw(backfillStatement()));
    expect((await service.poolTags(db, legacy))[0]!.description).toBe("From the old world");
  });
});

describe("question counts", () => {
  it("counts the live questions of a pool on every listing", async () => {
    const counted = await seedPool();
    for (const name of ["count 1", "count 2", "count 3"]) await seedQuestion(name, counted);

    const listed = await service.listPools(db, eq(pools.id, counted));
    expect(listed).toHaveLength(1);
    expect(listed[0]!.questionCount).toBe(3);

    const [row] = await db.select().from(pools).where(eq(pools.id, counted));
    expect((await service.poolDetail(db, row!)).questionCount).toBe(3);

    const courseId = randomUUID();
    await db.insert(courses).values({ id: courseId, name: "Counting", code: `C-${courseId.slice(0, 8)}` });
    await service.setCoursePools(db, courseId, [counted], undefined);
    const ofCourse = await service.poolsOfCourse(db, courseId);
    expect(ofCourse.map((p) => p.questionCount)).toEqual([3]);
  });

  it("leaves a soft-deleted question out of the count", async () => {
    const counted = await seedPool();
    const kept = await seedQuestion("kept", counted);
    const removed = await seedQuestion("removed", counted);
    await service.softDeleteQuestion(db, await questionRow(removed));

    const listed = await service.listPools(db, eq(pools.id, counted));
    expect(listed[0]!.questionCount).toBe(1);
    expect(kept).toBeTruthy();
  });
});
