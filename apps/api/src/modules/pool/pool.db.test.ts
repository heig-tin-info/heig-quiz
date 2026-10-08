import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import {
  auditLog,
  coursePools,
  courseStaff,
  courses,
  notifications,
  conceptTagSortings,
  poolMembers,
  pools,
  questionConcepts,
  questionVersions,
  questions,
  teacherGrants,
  userEmails,
  users,
} from "../../db/schema.js";
import { loadConfig as loadAppConfig } from "../../config.js";
import { subscribe, type BusMessage } from "../../events.js";
import { syncRoleOfUser, syncUserRole } from "../../roles.js";
import { poolAccess } from "../guards.js";
import { testDb } from "../../test/db.js";
import { fakeShort, fakeV1Config } from "../../test/fakeType.js";
import * as conceptService from "../concept/service.js";
import { notify } from "../notifications/service.js";
import * as service from "./service.js";

const search = (extra: Record<string, unknown> = {}) =>
  ({ limit: 50, sort: "updated", dir: "desc", ...extra }) as Parameters<
    typeof service.listQuestions
  >[3];

/** Who changes a question in these tests: the seeded owner, reading English. */
const writer = () => ({ userId: ownerId, lang: "en" as const, actor: { actorUserId: ownerId, actorType: "user" as const } });

/** A validated concept, through the registry's own services: proposed in English, completed in French, validated. */
async function seedConcept(en: string, fr = en, qualifier = ""): Promise<string> {
  const ctx = { caller: { id: ownerId, role: "teacher" }, actor: writer().actor, now: new Date() };
  const created = await conceptService.createConcept(db, ctx, { lang: "en", label: en, qualifier });
  await conceptService.patchConcept(db, ctx, created.id, { fr: { label: fr, qualifier } });
  await conceptService.validateConcept(db, ctx, created.id);
  return created.id;
}

/** The caller of `listPools`: the seeded owner, an ordinary teacher. */
const viewer = () => ({ id: ownerId, role: "teacher", reach: "seats" as const });

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
  const { id } = await service.createQuestion(db, {
    poolId: poolOverride,
    type: "short",
    internalName: name,
    createdBy: ownerId,
  });
  return id;
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
  db = await testDb();
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
    const detail = await service.questionDetail(db, await questionRow(id), "en");
    expect(detail.versions.map((v) => v.number)).toEqual([2, 1]);
    expect(detail.latestPublished?.number).toBe(2);
    // Publishing leaves the draft in step with the version it just cut.
    expect(detail.draft.config).toEqual({ statement: "Capital of Italy?", answer: "Roma" });
  });

  /*
   * #72, #74: the editor wrote the draft the publication had just reopened
   * straight back, the write moved the draft's stamp past `published_at`, and
   * both the editor and the pool list said "unpublished changes" about a
   * question with nothing unpublished. Writing back what is stored is not a
   * change; writing something else still is.
   */
  it("an autosave of the unchanged draft right after publishing leaves it published", async () => {
    const id = await seedQuestion("republished");
    await writeDraft(id, { statement: "Capital of Spain?", answer: "Madrid" });
    await service.publishQuestion(db, await questionRow(id), { userId: ownerId });
    await writeDraft(id, { statement: "Capital of Spain?", answer: "Madrid!" });
    const version = await service.publishQuestion(db, await questionRow(id), { userId: ownerId });

    const stateInList = async () => {
      const page = await service.listQuestions(db, poolId, ownerId, search({ q: "republished" }), "en");
      const row = page.items.find((r) => r.id === id)!;
      return { latestNumber: row.latestNumber, hasDraftChanges: row.hasDraftChanges };
    };
    expect(await stateInList()).toEqual({ latestNumber: 2, hasDraftChanges: false });

    // What the editor sends back once the refetched draft lands on screen.
    const detail = await service.questionDetail(db, await questionRow(id), "en");
    const echo = await service.putDraft(db, await questionRow(id), {
      config: detail.draft.config,
      explanation: detail.draft.explanation,
    });
    expect(echo.updatedAt).toBe(version.publishedAt);
    expect(await stateInList()).toEqual({ latestNumber: 2, hasDraftChanges: false });

    // A real edit afterwards is still a change.
    await writeDraft(id, { statement: "Capital of Spain?", answer: "Madrid" });
    expect(await stateInList()).toEqual({ latestNumber: 2, hasDraftChanges: true });
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

    const detail = await service.questionDetail(db, await questionRow(id), "en");
    expect(detail.draft.valid).toBe(true);
    expect(detail.draft.config).toEqual({ statement: "Old wording", answer: "42" });

    // And publishing stamps the CURRENT version, so the row stops lagging.
    const version = await service.publishQuestion(db, await questionRow(id), { userId: ownerId });
    const published = await service.versionDetail(db, await questionRow(id), version.number);
    expect(published?.configVersion).toBe(2);
    expect(published?.config).toEqual({ statement: "Old wording", answer: "42" });
  });
});

describe("versions", () => {
  it("restores a published version into the draft", async () => {
    const id = await seedQuestion("restorable");
    await writeDraft(id, { statement: "First", answer: "a" });
    await service.publishQuestion(db, await questionRow(id), { userId: ownerId });
    await writeDraft(id, { statement: "Second", answer: "b" });

    expect(await service.restoreVersion(db, await questionRow(id), 1)).toBe(true);
    const detail = await service.questionDetail(db, await questionRow(id), "en");
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
    const page = await service.listQuestions(db, poolId, ownerId, search({ q: "Old" }), "en");
    expect(page.items.find((q) => q.id === id)?.deprecated).toBe(true);
  });
});

describe("soft delete (F-QST-11)", () => {
  it("hides the question from the pool but keeps its versions", async () => {
    const id = await seedQuestion("deletable");
    await writeDraft(id, { statement: "Doomed", answer: "a" });
    await service.publishQuestion(db, await questionRow(id), { userId: ownerId });

    await service.softDeleteQuestion(db, await questionRow(id));
    const visible = await service.listQuestions(db, poolId, ownerId, search(), "en");
    expect(visible.items.map((q) => q.id)).not.toContain(id);

    const withDeleted = await service.listQuestions(
      db,
      poolId,
      ownerId,
      search({ includeDeleted: true }), "en"
    );
    expect(withDeleted.items.map((q) => q.id)).toContain(id);
    expect(await service.listVersions(db, id)).toHaveLength(1);
  });

  it("frees the name: the unique index only covers live questions", async () => {
    const id = await seedQuestion("reusable name");
    await service.softDeleteQuestion(db, await questionRow(id));
    await expect(seedQuestion("reusable name")).resolves.toBeTruthy();
  });

  it("hard-deletes a published question no evaluation froze", async () => {
    const id = await seedQuestion("not in use");
    await writeDraft(id, { statement: "Free", answer: "a" });
    await service.publishQuestion(db, await questionRow(id), { userId: ownerId });
    await expect(service.hardDeleteQuestion(db, await questionRow(id))).resolves.toBeUndefined();
    expect(await db.select().from(questions).where(eq(questions.id, id))).toEqual([]);
  });
});

describe("search", () => {
  let searchPool: string;
  let alpha: string;
  let beta: string;
  let memory: string;
  let theory: string;

  beforeAll(async () => {
    searchPool = await seedPool();
    alpha = await seedQuestion("Pointers in C", searchPool);
    beta = await seedQuestion("Recursion basics", searchPool);
    await writeDraft(alpha, { statement: "What does malloc return?", answer: "a pointer" });
    await writeDraft(beta, { statement: "Define a base case", answer: "termination" });
    memory = await seedConcept("search memory", "mémoire de recherche");
    theory = await seedConcept("search theory", "théorie de recherche");
    await seedConcept("search language C", "langage C de recherche");
    await service.patchQuestion(
      db,
      await questionRow(alpha),
      { concepts: [memory, "search language C"], difficulty: 4 },
      writer(),
    );
    await service.patchQuestion(db, await questionRow(beta), { concepts: [theory], difficulty: 2 }, writer());
  });

  it("finds a question by the text of its draft, through the generated tsvector", async () => {
    const page = await service.listQuestions(db, searchPool, ownerId, search({ q: "malloc" }), "en");
    expect(page.items.map((q) => q.id)).toEqual([alpha]);
  });

  it("finds a question by its internal name", async () => {
    const page = await service.listQuestions(db, searchPool, ownerId, search({ q: "Recursion" }), "en");
    expect(page.items.map((q) => q.id)).toEqual([beta]);
  });

  it("filters by concept ids (any of them), by type and by difficulty", async () => {
    expect(
      (await service.listQuestions(db, searchPool, ownerId, search({ concept: [memory] }), "en")).items.map(
        (q) => q.id,
      ),
    ).toEqual([alpha]);
    expect(
      (await service.listQuestions(db, searchPool, ownerId, search({ concept: [memory, theory] }), "en")).items
        .map((q) => q.id)
        .sort(),
    ).toEqual([alpha, beta].sort());
    expect(
      (await service.listQuestions(db, searchPool, ownerId, search({ difficulty: [2] }), "en")).items.map(
        (q) => q.id,
      ),
    ).toEqual([beta]);
    expect(
      (await service.listQuestions(db, searchPool, ownerId, search({ type: ["short"] }), "en")).items,
    ).toHaveLength(2);
    expect(
      (await service.listQuestions(db, searchPool, ownerId, search({ type: ["mcq"] }), "en")).items,
    ).toHaveLength(0);
  });

  it("lists the concepts of each row and of the pool, labelled in the reader's language", async () => {
    const page = await service.listQuestions(db, searchPool, ownerId, search({ q: "malloc" }), "fr");
    expect(page.items[0]!.concepts.map((c) => c.label)).toEqual(["langage C de recherche", "mémoire de recherche"]);
    expect(await conceptService.poolConcepts(db, searchPool, "en")).toEqual([
      { concept: expect.objectContaining({ label: "search language C" }), count: 1 },
      { concept: expect.objectContaining({ id: memory, label: "search memory", status: "validated" }), count: 1 },
      { concept: expect.objectContaining({ id: theory, label: "search theory" }), count: 1 },
    ]);
    const [row] = await db.select().from(pools).where(eq(pools.id, searchPool));
    expect((await service.poolDetail(db, row!, "owner", "en")).concepts.map((c) => [c.concept.label, c.count])).toEqual([
      ["search language C", 1],
      ["search memory", 1],
      ["search theory", 1],
    ]);
  });

  it("paginates with an opaque cursor", async () => {
    const first = await service.listQuestions(db, searchPool, ownerId, search({ limit: 1 }), "en");
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.listQuestions(
      db,
      searchPool,
      ownerId,
      search({ limit: 1, cursor: first.nextCursor }), "en"
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(second.nextCursor).toBeNull();
  });

  it("counts every question the search matches, on every page", async () => {
    const first = await service.listQuestions(db, searchPool, ownerId, search({ limit: 1 }), "en");
    expect(first.total).toBe(2);
    const second = await service.listQuestions(
      db,
      searchPool,
      ownerId,
      search({ limit: 1, cursor: first.nextCursor }), "en"
    );
    expect(second.total).toBe(2);
    const tagged = await service.listQuestions(
      db,
      searchPool,
      ownerId,
      search({ concept: [memory] }), "en"
    );
    expect(tagged.total).toBe(1);
    const none = await service.listQuestions(
      db,
      searchPool,
      ownerId,
      search({ q: "nothing-matches" }), "en"
    );
    expect(none.total).toBe(0);
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
    const shared = await seedConcept("copied concept");
    await service.patchQuestion(db, await questionRow(id), { concepts: [shared] }, writer());

    const { id: copyId } = await service.copyQuestion(db, await questionRow(id), {
      targetPoolId: target.valueOf(),
      userId: ownerId,
    });
    const copy = await questionRow(copyId);
    expect(copy.poolId).toBe(target);
    expect(copy.originQuestionId).toBe(id);
    const detail = await service.questionDetail(db, copy, "en");
    expect(detail.draft.config).toEqual({ statement: "Copied", answer: "yes" });
    // The copy names the same concepts: the vocabulary is the instance's.
    expect(detail.meta.concepts.map((c) => c.id)).toEqual([shared]);
    // The history stays with the original.
    expect(detail.versions).toEqual([]);

    // Copying next to the original picks a free name rather than failing.
    const { id: sibling } = await service.copyQuestion(db, await questionRow(id), {
      targetPoolId: poolId,
      userId: ownerId,
    });
    expect((await questionRow(sibling)).internalName).toBe("copy me (copy)");
  });

  it("keeps the concept set of a question in step with the patch", async () => {
    const id = await seedQuestion("reclassified");
    const a = await seedConcept("set concept A");
    const b = await seedConcept("set concept B");
    await service.patchQuestion(db, await questionRow(id), { concepts: [a, "set concept b", a] }, writer());
    const rows = await db.select().from(questionConcepts).where(eq(questionConcepts.questionId, id));
    expect(rows.map((r) => r.conceptId).sort()).toEqual([a, b].sort());
    await service.patchQuestion(db, await questionRow(id), { concepts: [] }, writer());
    expect(await db.select().from(questionConcepts).where(eq(questionConcepts.questionId, id))).toEqual([]);
  });
});

describe("the concepts of a question (ADR-081 third addendum)", () => {
  const conceptsOf = async (id: string) =>
    (await db.select().from(questionConcepts).where(eq(questionConcepts.questionId, id))).map((r) => r.conceptId);
  const refused = async (id: string, concepts: string[], createMissing?: boolean) => {
    try {
      await service.patchQuestion(db, await questionRow(id), { concepts, createMissing }, writer());
    } catch (error) {
      return error as { code: string; status: number; details?: { errors?: { input: string; error: string }[] } };
    }
    throw new Error("the patch was not refused");
  };

  it("resolves a label in either language, an id, or a qualified label", async () => {
    const id = await seedQuestion("resolved labels");
    const loop = await seedConcept("loop resolved", "boucle résolue");
    const pointer = await seedConcept("pointer resolved", "pointeur résolu");
    const address = await seedConcept("address resolved", "adresse résolue", "memory");
    await service.patchQuestion(
      db,
      await questionRow(id),
      { concepts: ["Boucle résolue", pointer, "address resolved (memory)"] },
      writer(),
    );
    expect((await conceptsOf(id)).sort()).toEqual([loop, pointer, address].sort());
  });

  it("refuses an unknown label, all or nothing, and creates it as proposed only when asked", async () => {
    const id = await seedQuestion("created on demand");
    const kept = await seedConcept("kept before");
    await service.patchQuestion(db, await questionRow(id), { concepts: [kept] }, writer());

    const error = await refused(id, [kept, "brand new concept"]);
    expect(error).toMatchObject({ code: "concept_unknown", status: 422 });
    expect(error.details?.errors).toEqual([{ input: "brand new concept", error: "concept_unknown", candidates: [] }]);
    expect(await conceptsOf(id)).toEqual([kept]);

    await service.patchQuestion(
      db,
      await questionRow(id),
      { concepts: [kept, "brand new concept"], createMissing: true },
      writer(),
    );
    const linked = await conceptsOf(id);
    expect(linked).toHaveLength(2);
    const fresh = (await conceptService.listConcepts(db)).find((c) => c.labels.en === "brand new concept")!;
    expect(fresh).toMatchObject({ status: "proposed", createdBy: ownerId, labels: { fr: null } });
    expect(linked).toContain(fresh.id);
  });

  it("refuses an ambiguous label with its candidates", async () => {
    const id = await seedQuestion("ambiguous label");
    await seedConcept("stack homonym", "pile homonyme", "memory");
    await seedConcept("stack homonym", "pile homonyme", "battery");
    const error = await refused(id, ["stack homonym"], true);
    expect(error).toMatchObject({ code: "concept_ambiguous", status: 422 });
    expect(error.details?.errors?.[0]).toMatchObject({ input: "stack homonym", error: "concept_ambiguous" });
    expect(await conceptsOf(id)).toEqual([]);
  });

  it("refuses a label the admin dropped in the sorting, even with creation asked", async () => {
    const id = await seedQuestion("dropped label", poolId);
    await db.insert(conceptTagSortings).values({
      poolId,
      tag: "week-03",
      decision: "drop",
      dropReason: "organisational",
      decidedAt: new Date(),
    });
    const error = await refused(id, ["Week 03"], true);
    expect(error).toMatchObject({ code: "concept_dropped", status: 422 });
    expect(error.details?.errors).toEqual([{ input: "Week 03", error: "concept_dropped", reason: "organisational" }]);
  });

  it("keeps the concepts of a moved question: the vocabulary is the instance's", async () => {
    const target = await seedPool();
    const id = await seedQuestion("moved with its concepts");
    const kept = await seedConcept("moved concept");
    await service.patchQuestion(db, await questionRow(id), { concepts: [kept] }, writer());
    await service.moveQuestions(db, { questions: [await questionRow(id)], targetPoolId: target, categoryId: null });
    expect(await conceptsOf(id)).toEqual([kept]);
    expect((await conceptService.poolConcepts(db, target, "en")).map((c) => c.concept.id)).toEqual([kept]);
  });

  it("counts the live questions of each concept of a pool, never the deleted ones", async () => {
    const counted = await seedPool();
    const one = await seedQuestion("counted one", counted);
    const two = await seedQuestion("counted two", counted);
    const shared = await seedConcept("counted shared");
    const solo = await seedConcept("counted solo");
    await service.patchQuestion(db, await questionRow(one), { concepts: [shared, solo] }, writer());
    await service.patchQuestion(db, await questionRow(two), { concepts: [shared] }, writer());
    const count = async () =>
      new Map((await conceptService.poolConcepts(db, counted, "en")).map((c) => [c.concept.id, c.count]));
    expect(await count()).toEqual(new Map([[shared, 2], [solo, 1]]));

    await service.softDeleteQuestion(db, await questionRow(two));
    expect((await count()).get(shared)).toBe(1);
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
    expect((await service.poolDetail(db, row!, "owner", "en")).questionCount).toBe(3);

    const courseId = randomUUID();
    await db
      .insert(courses)
      .values({ id: courseId, name: "Counting", code: `C-${courseId.slice(0, 8)}` });
    await service.setCoursePools(db, courseId, [counted], undefined, viewer());
    const ofCourse = await service.poolsOfCourse(db, courseId);
    expect(ofCourse.map((p) => p.questionCount)).toEqual([3]);
  });

  /** #259: an unlink takes `pool:` away from the staff, whose streams close. */
  it("closes the course staff's streams when a pool is unlinked, not when one is linked", async () => {
    const linked = await seedPool();
    const courseId = randomUUID();
    await db
      .insert(courses)
      .values({ id: courseId, name: "Unlinking", code: `U-${courseId.slice(0, 8)}` });
    const colleague = randomUUID();
    await db.insert(users).values({
      id: colleague,
      oidcSub: `s-${colleague}`,
      email: `unlink-${colleague.slice(0, 8)}@heig.test`,
      givenName: "Prof",
      familyName: "Unlink",
      role: "teacher",
    });
    await db.insert(courseStaff).values([
      { courseId, userId: ownerId },
      { courseId, userId: colleague },
    ]);
    const closed: string[] = [];
    const unsubscribe = subscribe((m: BusMessage) => {
      if (m.kind === "close") closed.push(...m.topics);
    });
    try {
      await service.setCoursePools(db, courseId, [linked], undefined, viewer());
      expect(closed).toEqual([]);
      await service.setCoursePools(db, courseId, [linked], undefined, viewer());
      expect(closed).toEqual([]);
      await service.setCoursePools(db, courseId, [], undefined, viewer());
      expect(closed.sort()).toEqual([`user:${ownerId}`, `user:${colleague}`].sort());
    } finally {
      unsubscribe();
    }
  });

  it("writes nothing when the links already stand", async () => {
    const linked = await seedPool();
    const courseId = randomUUID();
    await db
      .insert(courses)
      .values({ id: courseId, name: "Unchanged", code: `N-${courseId.slice(0, 8)}` });
    await service.setCoursePools(db, courseId, [linked], undefined, viewer());
    const before = await db.select().from(coursePools).where(eq(coursePools.courseId, courseId));

    const again = await service.setCoursePools(db, courseId, [linked], undefined, viewer());

    expect(again.map((p) => p.id)).toEqual([linked]);
    // The same row, not a deleted and re-inserted one.
    expect(await db.select().from(coursePools).where(eq(coursePools.courseId, courseId))).toEqual(before);
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

    const listed = await service.listMembers(
      db,
      (await db.select().from(pools).where(eq(pools.id, pool!.id)))[0]!,
    );
    expect(listed.members.map((m) => m.userId)).toEqual([ownerId, first, second]);
    expect(listed.members[0]!.isOwner).toBe(true);
    expect(listed.members[0]!.role).toBe("owner");
    expect(listed.members.slice(1).every((m) => !m.isOwner)).toBe(true);
  });

  it("turns a private pool into a shared one on the first invitation", async () => {
    const id = randomUUID();
    await db
      .insert(pools)
      .values({ id, name: `Private ${id.slice(0, 8)}`, ownerId, visibility: "private" });
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
      .values({
        id: studentId,
        oidcSub: `s-${studentId}`,
        email: "pupil@heig.test",
        role: "student",
      });
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

  it("passes over a member demoted to student, and keeps the owner when no staff member remains (#287)", async () => {
    const leaving = await seedTeacher(`leaving3-${randomUUID().slice(0, 6)}@heig.test`);
    const demoted = await seedTeacher(`demoted3-${randomUUID().slice(0, 6)}@heig.test`);
    const heir = await seedTeacher(`heir3-${randomUUID().slice(0, 6)}@heig.test`);
    const id = randomUUID();
    await db.insert(pools).values({ id, name: `Demoted ${id.slice(0, 8)}`, ownerId: leaving });
    const [pool] = await db.select().from(pools).where(eq(pools.id, id));
    await service.addMember(db, pool!, demoted, "owner");
    await db
      .update(poolMembers)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(and(eq(poolMembers.poolId, id), eq(poolMembers.userId, demoted)));
    await service.addMember(db, pool!, heir, "reader");
    await db.update(users).set({ role: "student" }).where(eq(users.id, demoted));

    expect(await service.transferOnLoss(db, leaving)).toEqual([{ poolId: id, toUserId: heir }]);
    const inbox = await db.select().from(notifications).where(eq(notifications.userId, demoted));
    expect(inbox).toEqual([]);

    // The heir leaves in turn: only the demoted member is left, so nobody inherits.
    await db.update(users).set({ role: "student" }).where(eq(users.id, heir));
    expect(await service.transferOnLoss(db, heir)).toEqual([]);
    const [after] = await db.select().from(pools).where(eq(pools.id, id));
    expect(after!.ownerId).toBe(heir);
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

describe("a member demoted to student loses their seat (ADR-013, rule 5)", () => {
  const config = loadAppConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://./.data/never-opened",
    LOG_LEVEL: "fatal",
  });
  const reaches = async (poolId: string, userId: string) =>
    (await db.select({ id: pools.id }).from(pools).where(and(eq(pools.id, poolId), poolAccess(userId))))
      .length === 1;
  const seatsOf = async (userId: string) =>
    db.select().from(poolMembers).where(eq(poolMembers.userId, userId));

  it("vacates every seat on demotion, hands the owned pools on, and gives nothing back on promotion", async () => {
    const demoted = await seedTeacher(`vacate-${randomUUID().slice(0, 6)}@heig.test`);
    const colleague = await seedTeacher(`colleague-${randomUUID().slice(0, 6)}@heig.test`);
    const email = `vacate-back-${randomUUID().slice(0, 6)}@heig.test`;
    await db.insert(userEmails).values({ userId: demoted, email, source: "login", verified: true });
    const owned = randomUUID();
    const seated = randomUUID();
    await db.insert(pools).values([
      { id: owned, name: `Owned ${owned.slice(0, 8)}`, ownerId: demoted },
      { id: seated, name: `Seated ${seated.slice(0, 8)}`, ownerId: colleague },
    ]);
    const [ownedPool] = await db.select().from(pools).where(eq(pools.id, owned));
    const [seatedPool] = await db.select().from(pools).where(eq(pools.id, seated));
    await service.addMember(db, ownedPool!, colleague, "contributor");
    await service.addMember(db, seatedPool!, demoted, "owner");

    // No grant, no course seat, no `staff` affiliation: `student`.
    await syncRoleOfUser(db, config, demoted);
    const [account] = await db.select().from(users).where(eq(users.id, demoted));
    expect(account!.role).toBe("student");
    expect(await seatsOf(demoted)).toEqual([]);
    // The succession still runs: the owned pool went to the colleague.
    const [after] = await db.select().from(pools).where(eq(pools.id, owned));
    expect(after!.ownerId).toBe(colleague);

    // Promoted back by a grant: the role returns, the seat does not.
    await db.insert(teacherGrants).values({ id: randomUUID(), email, createdBy: colleague });
    await syncUserRole(db, config, email);
    const [again] = await db.select().from(users).where(eq(users.id, demoted));
    expect(again!.role).toBe("teacher");
    expect(await seatsOf(demoted)).toEqual([]);
    expect(await reaches(seated, demoted)).toBe(false);
  });

  it("keeps the seat on a login, but a student account reaches no pool through it", async () => {
    const member = await seedTeacher(`login-${randomUUID().slice(0, 6)}@heig.test`);
    const owner = await seedTeacher(`login-owner-${randomUUID().slice(0, 6)}@heig.test`);
    const id = randomUUID();
    await db.insert(pools).values({ id, name: `Login ${id.slice(0, 8)}`, ownerId: owner });
    const [pool] = await db.select().from(pools).where(eq(pools.id, id));
    await service.addMember(db, pool!, member, "reader");

    await syncRoleOfUser(db, config, member, { succession: false });
    expect(await seatsOf(member)).toHaveLength(1);
    expect(await reaches(id, member)).toBe(false);
    // Nor through a public pool, whatever guard runs before.
    await db.update(pools).set({ visibility: "public" }).where(eq(pools.id, id));
    expect(await reaches(id, member)).toBe(false);
    expect(await reaches(id, owner)).toBe(true);
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
    const asc = await service.listQuestions(
      db,
      sorted,
      ownerId,
      search({ sort: "name", dir: "asc" }), "en"
    );
    expect(asc.items.map((q) => q.internalName)).toEqual(["alpha", "Bravo", "Charlie", "delta"]);
    const desc = await service.listQuestions(
      db,
      sorted,
      ownerId,
      search({ sort: "name", dir: "desc" }), "en"
    );
    expect(desc.items.map((q) => q.internalName)).toEqual(["delta", "Charlie", "Bravo", "alpha"]);
  });

  it("walks the pages in that order, without repeating or skipping a row", async () => {
    const seen: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await service.listQuestions(
        db,
        sorted,
        ownerId,
        search({ sort: "name", dir: "asc", limit: 2, ...(cursor ? { cursor } : {}) }), "en"
      );
      seen.push(...page.items.map((q) => q.internalName));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["alpha", "Bravo", "Charlie", "delta"]);
  });

  it("refuses a cursor that belongs to another order", async () => {
    const page = await service.listQuestions(
      db,
      sorted,
      ownerId,
      search({ sort: "name", dir: "asc", limit: 1 }), "en"
    );
    expect(page.nextCursor).toBeTruthy();
    await expect(
      service.listQuestions(
        db,
        sorted,
        ownerId,
        search({ sort: "difficulty", dir: "asc", cursor: page.nextCursor! }), "en"
      ),
    ).rejects.toBeInstanceOf(service.InvalidCursor);
    await expect(
      service.listQuestions(
        db,
        sorted,
        ownerId,
        search({ sort: "name", dir: "desc", cursor: page.nextCursor! }), "en"
      ),
    ).rejects.toBeInstanceOf(service.InvalidCursor);
    await expect(
      service.listQuestions(
        db,
        sorted,
        ownerId,
        search({ sort: "name", dir: "asc", cursor: "not-a-cursor" }), "en"
      ),
    ).rejects.toBeInstanceOf(service.InvalidCursor);
  });

  it("sorts by version with the unpublished questions last, whatever the direction", async () => {
    const desc = await service.listQuestions(
      db,
      sorted,
      ownerId,
      search({ sort: "version", dir: "desc" }), "en"
    );
    expect(desc.items.map((q) => q.latestNumber)).toEqual([2, 1, null, null]);
    const asc = await service.listQuestions(
      db,
      sorted,
      ownerId,
      search({ sort: "version", dir: "asc" }), "en"
    );
    expect(asc.items.map((q) => q.latestNumber)).toEqual([1, 2, null, null]);
  });

  it("bounds the published version number, and a draft-only question matches neither", async () => {
    const atLeastTwo = await service.listQuestions(db, sorted, ownerId, search({ versionMin: 2 }), "en");
    expect(atLeastTwo.items.map((q) => q.internalName)).toEqual(["alpha"]);
    const atMostOne = await service.listQuestions(db, sorted, ownerId, search({ versionMax: 1 }), "en");
    expect(atMostOne.items.map((q) => q.internalName)).toEqual(["Bravo"]);
    const between = await service.listQuestions(
      db,
      sorted,
      ownerId,
      search({ versionMin: 1, versionMax: 2 }), "en"
    );
    expect(between.items.map((q) => q.internalName).sort()).toEqual(["Bravo", "alpha"]);
  });
});
