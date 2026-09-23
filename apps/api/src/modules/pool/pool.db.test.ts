import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import {
  auditLog,
  courses,
  notifications,
  poolMembers,
  poolTags,
  pools,
  questionTags,
  questionVersions,
  questions,
  users,
} from "../../db/schema.js";
import { loadConfig as loadAppConfig } from "../../config.js";
import { syncRoleOfUser } from "../../roles.js";
import { testDb } from "../../test/db.js";
import { fakeShort, fakeV1Config } from "../../test/fakeType.js";
import { notify } from "../notifications/service.js";
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
  ({ limit: 50, sort: "updated", dir: "desc", ...extra }) as Parameters<
    typeof service.listQuestions
  >[2];

/** The caller of `listPools`: the seeded owner, an ordinary teacher. */
const viewer = () => ({ id: ownerId, role: "teacher" });

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

    const listed = await service.listPools(db, eq(pools.id, counted), viewer());
    expect(listed).toHaveLength(1);
    expect(listed[0]!.questionCount).toBe(3);

    const [row] = await db.select().from(pools).where(eq(pools.id, counted));
    expect((await service.poolDetail(db, row!, "owner")).questionCount).toBe(3);

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

    const listed = await service.listPools(db, eq(pools.id, counted), viewer());
    expect(listed[0]!.questionCount).toBe(1);
    expect(kept).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Sharing, succession and the sorted listing (F-POOL-05, F-POOL-03)
// ---------------------------------------------------------------------------

/** A teacher account, for the sharing tests. */
async function seedTeacher(email: string): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    oidcSub: `s-${id}`,
    email,
    givenName: "Prof",
    familyName: email.split("@")[0]!,
    role: "teacher",
  });
  return id;
}

describe("members (F-POOL-05)", () => {
  it("lists the owner first, then the members in the order they were added", async () => {
    const poolWithSeats = await seedPool();
    const [pool] = await db.select().from(pools).where(eq(pools.id, poolWithSeats));
    const first = await seedTeacher(`first-${randomUUID().slice(0, 6)}@heig.test`);
    const second = await seedTeacher(`second-${randomUUID().slice(0, 6)}@heig.test`);
    await service.addMember(db, pool!, first, "reader");
    await service.addMember(db, pool!, second, "contributor");
    // The order is `created_at`; two inserts in the same millisecond would
    // leave it to the tie-break, so the first seat is aged by hand.
    await db
      .update(poolMembers)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(and(eq(poolMembers.poolId, pool!.id), eq(poolMembers.userId, first)));

    const listed = await service.listMembers(db, (await db.select().from(pools).where(eq(pools.id, pool!.id)))[0]!);
    expect(listed.members.map((m) => m.userId)).toEqual([ownerId, first, second]);
    expect(listed.members[0]!.isOwner).toBe(true);
    expect(listed.members[0]!.role).toBe("owner");
    expect(listed.members.slice(1).every((m) => !m.isOwner)).toBe(true);
  });

  it("turns a private pool into a shared one on the first invitation", async () => {
    const id = randomUUID();
    await db.insert(pools).values({ id, name: `Private ${id.slice(0, 8)}`, ownerId, visibility: "private" });
    const [pool] = await db.select().from(pools).where(eq(pools.id, id));
    const colleague = await seedTeacher(`flip-${randomUUID().slice(0, 6)}@heig.test`);
    const added = await service.addMember(db, pool!, colleague, "reader");
    expect(added.visibility).toBe("shared");
    const [after] = await db.select().from(pools).where(eq(pools.id, id));
    expect(after!.visibility).toBe("shared");
  });

  it("finds a teacher by e-mail and never a student", async () => {
    const teacher = await seedTeacher(`findable-${randomUUID().slice(0, 6)}@heig.test`);
    const [row] = await db.select().from(users).where(eq(users.id, teacher));
    expect((await service.findTeacherByEmail(db, row!.email.toUpperCase()))?.id).toBe(teacher);

    const studentId = randomUUID();
    await db
      .insert(users)
      .values({ id: studentId, oidcSub: `s-${studentId}`, email: "pupil@heig.test", role: "student" });
    expect(await service.findTeacherByEmail(db, "pupil@heig.test")).toBeNull();
    expect(await service.findTeacherByEmail(db, "nobody@heig.test")).toBeNull();
  });
});

describe("deleting a pool", () => {
  it("takes the bells that point at it with it", async () => {
    const doomed = await seedPool();
    const kept = await seedPool();
    const colleague = await seedTeacher(`bell-${randomUUID().slice(0, 6)}@heig.test`);
    // What the invitation route writes once the seat is granted.
    for (const poolId of [doomed, kept]) {
      await notify(db, colleague, {
        kind: "pool_shared",
        poolId,
        poolName: "Pool",
        role: "reader",
        byName: "Prof Démo",
      });
    }

    const before = await db.select().from(notifications).where(eq(notifications.userId, colleague));
    expect(before).toHaveLength(2);

    await service.deletePool(db, doomed);

    // The payload is a union and carries no foreign key: without the explicit
    // delete the bell would keep offering a row that opens on a 404.
    const after = await db.select().from(notifications).where(eq(notifications.userId, colleague));
    expect(after.map((r) => (r.payload as { poolId: string }).poolId)).toEqual([kept]);
    expect(await db.select().from(pools).where(eq(pools.id, doomed))).toHaveLength(0);
    expect(await db.select().from(pools).where(eq(pools.id, kept))).toHaveLength(1);
  });
});

describe("succession when the owner loses the teacher role (F-POOL-05)", () => {
  it("hands the pool to the FIRST member, notifies them and clears their seat", async () => {
    const leaving = await seedTeacher(`leaving-${randomUUID().slice(0, 6)}@heig.test`);
    const heir = await seedTeacher(`heir-${randomUUID().slice(0, 6)}@heig.test`);
    const later = await seedTeacher(`later-${randomUUID().slice(0, 6)}@heig.test`);
    const id = randomUUID();
    await db.insert(pools).values({ id, name: `Succession ${id.slice(0, 8)}`, ownerId: leaving });
    const [pool] = await db.select().from(pools).where(eq(pools.id, id));
    await service.addMember(db, pool!, heir, "reader");
    await db
      .update(poolMembers)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(and(eq(poolMembers.poolId, id), eq(poolMembers.userId, heir)));
    await service.addMember(db, pool!, later, "contributor");

    const done = await service.transferOnLoss(db, leaving);
    expect(done).toEqual([{ poolId: id, toUserId: heir }]);

    const [after] = await db.select().from(pools).where(eq(pools.id, id));
    expect(after!.ownerId).toBe(heir);
    // The new owner owns the pool by `owner_id`; the weaker member row is gone.
    const seats = await db.select().from(poolMembers).where(eq(poolMembers.poolId, id));
    expect(seats.map((s) => s.userId)).toEqual([later]);

    const inbox = await db.select().from(notifications).where(eq(notifications.userId, heir));
    expect(inbox).toHaveLength(1);
    expect((inbox[0]!.payload as { kind: string; poolId: string }).kind).toBe("pool_ownership");
    expect((inbox[0]!.payload as { kind: string; poolId: string }).poolId).toBe(id);

    const trail = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "pool.transfer"), eq(auditLog.subjectId, id)));
    expect(trail).toHaveLength(1);

    // Idempotent: the pool no longer belongs to the account that left.
    expect(await service.transferOnLoss(db, leaving)).toEqual([]);
  });

  it("leaves a pool with no member alone rather than orphaning it", async () => {
    const lonely = await seedTeacher(`lonely-${randomUUID().slice(0, 6)}@heig.test`);
    const id = randomUUID();
    await db.insert(pools).values({ id, name: `Lonely ${id.slice(0, 8)}`, ownerId: lonely });
    expect(await service.transferOnLoss(db, lonely)).toEqual([]);
    const [after] = await db.select().from(pools).where(eq(pools.id, id));
    expect(after!.ownerId).toBe(lonely);
  });

  it("fires from the ONE seam that stores a recomputed role", async () => {
    const config = loadAppConfig({
      NODE_ENV: "test",
      DATABASE_URL: "pglite://./.data/never-opened",
      LOG_LEVEL: "fatal",
    });
    const demoted = await seedTeacher(`demoted-${randomUUID().slice(0, 6)}@heig.test`);
    const heir = await seedTeacher(`heir2-${randomUUID().slice(0, 6)}@heig.test`);
    const id = randomUUID();
    await db.insert(pools).values({ id, name: `Seam ${id.slice(0, 8)}`, ownerId: demoted });
    const [pool] = await db.select().from(pools).where(eq(pools.id, id));
    await service.addMember(db, pool!, heir, "contributor");

    // No grant, no course seat, no `staff` affiliation: the rule computes
    // `student`, the account is no longer a teacher, and the pool moves on.
    await syncRoleOfUser(db, config, demoted);
    const [account] = await db.select().from(users).where(eq(users.id, demoted));
    expect(account!.role).toBe("student");
    const [after] = await db.select().from(pools).where(eq(pools.id, id));
    expect(after!.ownerId).toBe(heir);
  });
});

describe("question listing: sort, cursor and version bounds (F-POOL-03)", () => {
  let sorted: string;

  beforeAll(async () => {
    sorted = await seedPool();
    for (const name of ["Charlie", "alpha", "Bravo", "delta"]) {
      await seedQuestion(name, sorted);
    }
    // `alpha` is published twice, `Bravo` once, the rest never.
    for (const name of ["alpha", "alpha", "Bravo"]) {
      const [row] = await db
        .select()
        .from(questions)
        .where(and(eq(questions.poolId, sorted), eq(questions.internalName, name)));
      await service.putDraft(db, row!, { config: { statement: name, answer: "a" } });
      await service.publishQuestion(db, row!, { userId: ownerId });
    }
  });

  it("sorts by internal name, case-insensitively, in both directions", async () => {
    const asc = await service.listQuestions(db, sorted, search({ sort: "name", dir: "asc" }));
    expect(asc.items.map((q) => q.internalName)).toEqual(["alpha", "Bravo", "Charlie", "delta"]);
    const desc = await service.listQuestions(db, sorted, search({ sort: "name", dir: "desc" }));
    expect(desc.items.map((q) => q.internalName)).toEqual(["delta", "Charlie", "Bravo", "alpha"]);
  });

  it("walks the pages in that order, without repeating or skipping a row", async () => {
    const seen: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await service.listQuestions(
        db,
        sorted,
        search({ sort: "name", dir: "asc", limit: 2, ...(cursor ? { cursor } : {}) }),
      );
      seen.push(...page.items.map((q) => q.internalName));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["alpha", "Bravo", "Charlie", "delta"]);
  });

  it("refuses a cursor that belongs to another order", async () => {
    const page = await service.listQuestions(db, sorted, search({ sort: "name", dir: "asc", limit: 1 }));
    expect(page.nextCursor).toBeTruthy();
    await expect(
      service.listQuestions(db, sorted, search({ sort: "difficulty", dir: "asc", cursor: page.nextCursor! })),
    ).rejects.toBeInstanceOf(service.InvalidCursor);
    await expect(
      service.listQuestions(db, sorted, search({ sort: "name", dir: "desc", cursor: page.nextCursor! })),
    ).rejects.toBeInstanceOf(service.InvalidCursor);
    await expect(
      service.listQuestions(db, sorted, search({ sort: "name", dir: "asc", cursor: "not-a-cursor" })),
    ).rejects.toBeInstanceOf(service.InvalidCursor);
  });

  it("sorts by version with the unpublished questions last, whatever the direction", async () => {
    const desc = await service.listQuestions(db, sorted, search({ sort: "version", dir: "desc" }));
    expect(desc.items.map((q) => q.latestNumber)).toEqual([2, 1, null, null]);
    const asc = await service.listQuestions(db, sorted, search({ sort: "version", dir: "asc" }));
    expect(asc.items.map((q) => q.latestNumber)).toEqual([1, 2, null, null]);
  });

  it("bounds the published version number, and a draft-only question matches neither", async () => {
    const atLeastTwo = await service.listQuestions(db, sorted, search({ versionMin: 2 }));
    expect(atLeastTwo.items.map((q) => q.internalName)).toEqual(["alpha"]);
    const atMostOne = await service.listQuestions(db, sorted, search({ versionMax: 1 }));
    expect(atMostOne.items.map((q) => q.internalName)).toEqual(["Bravo"]);
    const between = await service.listQuestions(db, sorted, search({ versionMin: 1, versionMax: 2 }));
    expect(between.items.map((q) => q.internalName).sort()).toEqual(["Bravo", "alpha"]);
  });
});
