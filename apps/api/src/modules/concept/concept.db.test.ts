/**
 * The vocabulary of concepts over the real application (ADR-081, addendum
 * 2026-10-08): proposing (one key per language among the concepts that are
 * not merged, held by the database's index), resolving a typed label
 * (addendum §2) and the rights to edit (addendum §5), with their audit rows.
 * Every test starts from an empty vocabulary and creates what it needs.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ConceptExists,
  ConceptResolveResponse,
  Concept as ConceptSchema,
  Concept,
  AliasCollision,
  ConceptList,
  ConceptNotFound,
  ConceptWriteRefusal,
  QuestionPage,
  PoolConceptMap,
  PoolDetail,
} from "@quiz/contracts";
import { qualifiedConceptKey } from "@quiz/domain";
import { registerForTests } from "@quiz/registry/server";

import {
  auditLog,
  concepts,
  conceptTagSortings,
  pools,
  conceptAliases,
  questionConcepts,
  questions,
  conceptRelations,
  courseConcepts,
  coursePools,
  courseStaff,
  courses,
} from "../../db/schema.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import { type AuditActor } from "../../audit.js";
import { seedConcept } from "../../test/concepts.js";
import * as service from "./service.js";
import { type Db, type Tx } from "../../db/client.js";
import { DomainError } from "../http.js";
import * as poolService from "../pool/service.js";
import { fakeShort } from "../../test/fakeType.js";
import { conceptsCoveredByCourse, coverage } from "./service.js";

type Who = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let teacher: Who;
let colleague: Who;
let admin: Who;
let student: Who;

const call = (
  who: Who,
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: Payload,
  headers: Record<string, string> = {},
) =>
  server.app.inject({
    method,
    url,
    headers: { ...who.headers, ...headers },
    ...(payload === undefined ? {} : { payload }),
  });

const post = (who: Who, body: Payload) => call(who, "POST", "/app/api/concepts", body);

async function create(who: Who, body: Payload): Promise<Concept> {
  const res = await post(who, body);
  expect(res.statusCode, res.body).toBe(201);
  return ConceptSchema.parse(res.json());
}

const patch = (who: Who, id: string, body: Payload) => call(who, "PATCH", `/app/api/concepts/${id}`, body);

/** `GET /concepts/resolve`, one `input` parameter per string. */
const resolveUrl = (inputs: string[]) =>
  `/app/api/concepts/resolve?${new URLSearchParams(inputs.map((i): [string, string] => ["input", i]))}`;

async function resolve(...inputs: string[]) {
  const res = await call(teacher, "GET", resolveUrl(inputs));
  expect(res.statusCode, res.body).toBe(200);
  return ConceptResolveResponse.parse(res.json()).results;
}

/** Sets a concept's status by hand: validating and merging have no route yet. */
async function setStatus(id: string, status: "validated" | "merged", mergedInto: string | null = null) {
  await server.app.db.update(concepts).set({ status, mergedInto }).where(eq(concepts.id, id));
}

const audits = (action: "concept.propose" | "concept.edit", subjectId: string) =>
  server.app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.subjectId, subjectId)));

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  colleague = await server.signIn("teacher");
  admin = await server.signIn("admin");
  student = await server.signIn("student");
});

beforeEach(async () => {
  await server.app.db.delete(concepts);
});

afterAll(async () => {
  await server?.close();
});

describe("proposing a concept", () => {
  it("creates a proposed concept in the creator's language, audited and listed", async () => {
    const created = await create(teacher, { lang: "fr", label: "  # pointeur ", description: "Une adresse typée." });
    expect(created).toMatchObject({
      status: "proposed",
      mergedInto: null,
      labels: { fr: "pointeur", en: null },
      qualifiers: { fr: "", en: "" },
      descriptions: { fr: "Une adresse typée.", en: "" },
      createdBy: teacher.id,
    });
    const [row] = await server.app.db.select().from(concepts).where(eq(concepts.id, created.id));
    expect(row).toMatchObject({ keyFr: "pointeur", keyEn: null });
    const rows = await audits("concept.propose", created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: teacher.id, subjectType: "concept" });

    const list = await call(colleague, "GET", "/app/api/concepts");
    expect(list.statusCode).toBe(200);
    expect(list.json().concepts.map((c: Concept) => c.id)).toEqual([created.id]);
  });

  it("refuses another spelling of the same key through the index, naming the holder", async () => {
    const first = await create(teacher, { lang: "fr", label: "pointeur" });
    const res = await post(colleague, { lang: "fr", label: "Pointeurs" });
    expect(res.statusCode).toBe(409);
    expect(ConceptExists.parse(res.json())).toMatchObject({ error: "concept_exists", concept: { id: first.id } });
    // The same key in the other language is another key.
    await create(colleague, { lang: "en", label: "pointeurs" });
  });

  it("lets only one of two simultaneous proposals of one key succeed", async () => {
    const results = await Promise.all([
      post(teacher, { lang: "fr", label: "récursivité" }),
      post(colleague, { lang: "fr", label: "Récursivités" }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await server.app.db.select().from(concepts)).toHaveLength(1);
  });

  it("lets homonyms coexist through their qualifiers", async () => {
    await create(teacher, { lang: "fr", label: "adresse", qualifier: "mémoire" });
    const postal = await create(teacher, { lang: "fr", label: "adresse", qualifier: "  postale   française " });
    expect(postal.qualifiers.fr).toBe("postale française");
    expect((await post(teacher, { lang: "fr", label: "Adresses", qualifier: "Mémoire" })).statusCode).toBe(409);
  });

  it("refuses a label without a letter or a digit", async () => {
    expect((await post(teacher, { lang: "fr", label: "#" })).statusCode).toBe(400);
  });

  it("is refused to a student by the guard", async () => {
    expect((await post(student, { lang: "fr", label: "pile" })).statusCode).toBe(403);
    expect((await call(student, "GET", "/app/api/concepts")).statusCode).toBe(403);
    expect((await call(student, "GET", resolveUrl(["pile"]))).statusCode).toBe(403);
  });
});

describe("resolving a typed label", () => {
  it("is ambiguous on homonyms, resolved on the qualified form", async () => {
    const memory = await create(teacher, { lang: "fr", label: "adresse", qualifier: "mémoire" });
    const postal = await create(teacher, { lang: "fr", label: "adresse", qualifier: "postale" });
    const [bare, qualified] = await resolve("adresse", "Adresse (mémoire)");
    expect(bare).toMatchObject({ input: "adresse", kind: "ambiguous" });
    if (bare?.kind !== "ambiguous") throw new Error("unreachable");
    expect(bare.candidates.map((c) => c.id).sort()).toEqual([memory.id, postal.id].sort());
    expect(qualified).toMatchObject({ kind: "resolved", concept: { id: memory.id } });
  });

  it("reports a label the admin dropped in the sorting, with its reason", async () => {
    const poolId = randomUUID();
    await server.app.db.insert(pools).values({ id: poolId, name: "Dropped tags", ownerId: teacher.id });
    await server.app.db
      .insert(conceptTagSortings)
      .values({ poolId, tag: "lecture-de-code", dropReason: "task_kind" });
    const [dropped, other, qualified] = await resolve("Lecture de code", "inconnu total", "Lecture de code (cours)");
    expect(dropped).toEqual({ input: "Lecture de code", kind: "dropped", reason: "task_kind" });
    expect(other).toMatchObject({ kind: "unknown" });
    expect(qualified).toMatchObject({ kind: "unknown" });
    // The admin, the vocabulary's curator, is not bound by the stop list.
    const byAdmin = await call(admin, "GET", resolveUrl(["Lecture de code"]));
    expect(ConceptResolveResponse.parse(byAdmin.json()).results[0]).toMatchObject({ kind: "unknown" });
    await server.app.db.delete(pools).where(eq(pools.id, poolId));
  });

  it("resolves one exact match through either language's label", async () => {
    const stack = await create(teacher, { lang: "fr", label: "pile" });
    expect((await patch(teacher, stack.id, { en: { label: "stack" } })).statusCode).toBe(200);
    const [fr, en] = await resolve("Piles", "stacks");
    expect(fr).toMatchObject({ kind: "resolved", concept: { id: stack.id } });
    expect(en).toMatchObject({ kind: "resolved", concept: { id: stack.id } });
    // A concept as a reader sees it (`ConceptRef`), in the language their browser asks for.
    const english = await call(teacher, "GET", resolveUrl(["piles"]), undefined, { "accept-language": "en" });
    expect(english.json().results[0].concept).toEqual({ id: stack.id, label: "stack", qualifier: "", status: "proposed" });
  });

  it("proposes a close match as a candidate only", async () => {
    const pointer = await create(teacher, { lang: "fr", label: "pointeur" });
    const [close, none] = await resolve("Pointuers", "récursivité");
    expect(close).toMatchObject({ kind: "unknown", candidates: [{ id: pointer.id }] });
    expect(none).toEqual({ input: "récursivité", kind: "unknown", candidates: [] });
  });

  it("follows a merged concept's id to the final one, and frees its key", async () => {
    const final = await create(teacher, { lang: "fr", label: "tableau" });
    const merged = await create(teacher, { lang: "fr", label: "array" });
    await setStatus(merged.id, "merged", final.id);
    const [byId, byLabel] = await resolve(merged.id, "array");
    expect(byId).toMatchObject({ kind: "resolved", concept: { id: final.id } });
    expect(byLabel).toMatchObject({ kind: "unknown", candidates: [] });
    const list = (await call(teacher, "GET", "/app/api/concepts")).json().concepts as Concept[];
    expect(list.map((c) => c.id)).toEqual([final.id]);
    await create(colleague, { lang: "fr", label: "Arrays" });
  });

  it("validates its input", async () => {
    expect((await call(teacher, "GET", "/app/api/concepts/resolve")).statusCode).toBe(400);
    // A label may hold a comma: one `input` is one string, never split.
    expect(await resolve("pile, file")).toHaveLength(1);
  });
});

describe("the database", () => {
  it("refuses a status and merged_into that disagree, or a concept merged into itself", async () => {
    const one = await create(teacher, { lang: "fr", label: "boucle" });
    const other = await create(teacher, { lang: "fr", label: "itération" });
    await expect(setStatus(one.id, "merged")).rejects.toThrow();
    await expect(setStatus(one.id, "merged", one.id)).rejects.toThrow();
    await expect(
      server.app.db.update(concepts).set({ mergedInto: other.id }).where(eq(concepts.id, one.id)),
    ).rejects.toThrow();
  });
});

describe("editing a concept", () => {
  it("lets the creator edit while it is proposed, recomputes the keys, audited", async () => {
    const { id } = await create(teacher, { lang: "fr", label: "pile" });
    const res = await patch(teacher, id, {
      fr: { qualifier: "LIFO" },
      en: { label: "stack", description: "Last in, first out." },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ labels: { fr: "pile", en: "stack" }, qualifiers: { fr: "LIFO", en: "" } });
    const [row] = await server.app.db.select().from(concepts).where(eq(concepts.id, id));
    expect(row).toMatchObject({ keyFr: "pile|lifo", keyEn: "stack" });
    expect(await audits("concept.edit", id)).toHaveLength(1);
  });

  it("refuses another teacher, lets the admin", async () => {
    const { id } = await create(teacher, { lang: "fr", label: "file" });
    const refused = await patch(colleague, id, { fr: { description: "x" } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("concept_forbidden");
    expect((await patch(admin, id, { fr: { description: "Une file." } })).statusCode).toBe(200);
  });

  it("refuses the creator once the concept is validated, lets the admin", async () => {
    const { id } = await create(teacher, { lang: "fr", label: "arbre" });
    await setStatus(id, "validated");
    expect((await patch(teacher, id, { fr: { description: "y" } })).statusCode).toBe(403);
    expect((await patch(admin, id, { fr: { description: "y" } })).statusCode).toBe(200);
  });

  it("refuses a key another concept holds", async () => {
    const holder = await create(teacher, { lang: "fr", label: "pointeur" });
    const { id } = await create(teacher, { lang: "fr", label: "référence" });
    const res = await patch(admin, id, { fr: { label: "Pointeurs" } });
    expect(res.statusCode).toBe(409);
    expect(ConceptExists.parse(res.json())).toMatchObject({ error: "concept_exists", concept: { id: holder.id } });
  });

  it("refuses a qualifier or a description on a language without a label", async () => {
    const { id } = await create(teacher, { lang: "fr", label: "graphe" });
    for (const en of [{ qualifier: "math" }, { description: "A graph." }]) {
      const res = await patch(teacher, id, { en });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: "concept_label_missing", lang: "en" });
    }
  });

  it("refuses a merged concept and answers 404 for an unknown one", async () => {
    const final = await create(teacher, { lang: "fr", label: "tri" });
    const merged = await create(teacher, { lang: "fr", label: "tri rapide" });
    await setStatus(merged.id, "merged", final.id);
    const res = await patch(admin, merged.id, { fr: { description: "z" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("concept_merged");
    const unknown = "00000000-0000-4000-8000-000000000000";
    expect((await patch(admin, unknown, { fr: { description: "z" } })).statusCode).toBe(404);
    expect((await patch(admin, "nope", { fr: { description: "z" } })).statusCode).toBe(404);
  });

  it("refuses an empty patch", async () => {
    const { id } = await create(teacher, { lang: "fr", label: "hachage" });
    expect((await patch(admin, id, {})).statusCode).toBe(400);
  });
});

/**
 * Curated concept aliases (ADR-081 §6, fifth addendum): added and removed by
 * the admin alone, resolved like a label, guarded against collisions, kept
 * and moved by a merge, gone with a deleted concept.
 */
describe("aliases", () => {
  type Who = Awaited<ReturnType<TestServer["signIn"]>>;

  let server: TestServer;
  let teacher: Who;
  let admin: Who;
  let student: Who;
  let poolId: string;
  const db = () => server.app.db;

  const concept = (fr: string | null, en: string | null, qualifier = "") =>
    seedConcept(db(), teacher.id, fr === null ? null : [fr, qualifier], en === null ? null : [en]);

  const add = (who: Who, id: string, alias: string, force?: boolean) =>
    server.app.inject({
      method: "POST",
      url: `/app/api/admin/concepts/${id}/aliases`,
      headers: who.headers,
      payload: force === undefined ? { alias } : { alias, force },
    });
  const remove = (who: Who, id: string, alias: string) =>
    server.app.inject({
      method: "DELETE",
      url: `/app/api/admin/concepts/${id}/aliases/${encodeURIComponent(alias)}`,
      headers: who.headers,
    });
  const merge = (id: string, into: string, keepAsAlias: boolean) =>
    server.app.inject({
      method: "POST",
      url: `/app/api/admin/concepts/${id}/merge`,
      headers: admin.headers,
      payload: { into, keepAsAlias },
    });
  const resolveInput = async (input: string) => {
    const res = await server.app.inject({
      method: "GET",
      url: `/app/api/concepts/resolve?input=${encodeURIComponent(input)}`,
      headers: teacher.headers,
    });
    return ConceptResolveResponse.parse(res.json()).results[0]!;
  };
  const stored = async (id: string) =>
    (await db().select().from(conceptAliases).where(eq(conceptAliases.conceptId, id))).map((a) => a.text).sort();

  beforeAll(async () => {
    server = await testServer();
    teacher = await server.signIn("teacher");
    admin = await server.signIn("admin");
    student = await server.signIn("student");
    poolId = randomUUID();
    await db().insert(pools).values({ id: poolId, name: "Alias pool", ownerId: teacher.id });
  });

  beforeEach(async () => {
    await db().delete(conceptTagSortings);
    await db().delete(concepts);
  });

  afterAll(async () => {
    await server.close();
  });

  describe("POST and DELETE /admin/concepts/:id/aliases", () => {
    it("adds an alias, lists it on both concept lists, removes it, and audits both", async () => {
      const ovf = await concept("Dépassement", "Overflow");
      const res = await add(admin, ovf, "  Débordement   d'entier ");
      expect(res.statusCode).toBe(200);
      expect(Concept.parse(res.json()).aliases).toEqual(["Débordement d'entier"]);

      const list = ConceptList.parse(
        (await server.app.inject({ method: "GET", url: "/app/api/concepts", headers: teacher.headers })).json(),
      );
      expect(list.concepts.find((c) => c.id === ovf)?.aliases).toEqual(["Débordement d'entier"]);
      const adminList = (await server.app.inject({ method: "GET", url: "/app/api/admin/concepts", headers: admin.headers })).json();
      expect(adminList.concepts.find((c: { id: string }) => c.id === ovf).aliases).toEqual(["Débordement d'entier"]);

      const gone = await remove(admin, ovf, "Débordements d'entier");
      expect(gone.statusCode).toBe(200);
      expect(Concept.parse(gone.json()).aliases).toEqual([]);
      expect((await remove(admin, ovf, "Débordements d'entier")).statusCode).toBe(404);

      const entries = await db().select().from(auditLog).where(eq(auditLog.subjectId, ovf));
      expect(entries.map((e) => e.action).sort()).toEqual(["concept.alias_add", "concept.alias_remove"]);
      expect(entries.find((e) => e.action === "concept.alias_add")?.payload).toEqual({
        alias: "Débordement d'entier",
        forced: false,
        collidesWith: [],
      });
      expect(entries.find((e) => e.action === "concept.alias_remove")?.payload).toEqual({ alias: "Débordement d'entier" });
    });

    it("is the admin's alone", async () => {
      const ovf = await concept("Dépassement", "Overflow");
      expect((await add(teacher, ovf, "X")).statusCode).toBe(403);
      expect((await add(student, ovf, "X")).statusCode).toBe(403);
      expect((await remove(teacher, ovf, "x")).statusCode).toBe(403);
      expect(await stored(ovf)).toEqual([]);
    });

    it("refuses an alias equal to the concept's own label (either language), or already held", async () => {
      const ovf = await concept("Dépassement", "Overflow");
      expect((await add(admin, ovf, "depassements")).statusCode).toBe(422);
      expect((await add(admin, ovf, "OVERFLOW")).json()).toMatchObject({ error: "alias_redundant" });
      expect((await add(admin, ovf, "Trop-plein")).statusCode).toBe(200);
      expect((await add(admin, ovf, "trop plein")).json()).toMatchObject({ error: "alias_exists" });
      expect((await add(admin, ovf, "   ")).statusCode).toBe(400);
      expect((await add(admin, ovf, "--")).statusCode).toBe(400);
      expect((await add(admin, randomUUID(), "x")).statusCode).toBe(404);
    });

    it("refuses a collision with another concept's label or alias until forced, and audits the force", async () => {
      const ptr = await concept("Pointeur", "Pointer");
      const ref = await concept("Référence", "Reference");
      const ovf = await concept("Dépassement", "Overflow");
      await add(admin, ref, "adresse indirecte");

      const byLabel = await add(admin, ovf, "pointers");
      expect(byLabel.statusCode).toBe(409);
      const body = AliasCollision.parse(byLabel.json());
      expect(body.collisions).toMatchObject([{ via: "label", concept: { id: ptr } }]);
      const byAlias = AliasCollision.parse((await add(admin, ovf, "Adresse-indirecte")).json());
      expect(byAlias.collisions).toMatchObject([{ via: "alias", concept: { id: ref } }]);
      expect(await stored(ovf)).toEqual([]);

      const forced = await add(admin, ovf, "pointers", true);
      expect(forced.statusCode).toBe(200);
      const [entry] = (await db().select().from(auditLog).where(and(eq(auditLog.subjectId, ovf), eq(auditLog.action, "concept.alias_add"))));
      expect(entry?.payload).toEqual({ alias: "pointers", forced: true, collidesWith: [ptr] });
      // The input is now ambiguous for everyone, between the label's concept and the alias's.
      expect(await resolveInput("pointers")).toMatchObject({ kind: "ambiguous" });
    });
  });

  describe("resolution through an alias", () => {
    it("resolves by key on GET /concepts/resolve and in a question write, never to a merged concept", async () => {
      const ovf = await concept("Dépassement", "Overflow");
      await add(admin, ovf, "Débordement d'entier");
      expect(await resolveInput("debordements d'entiers")).toMatchObject({ kind: "resolved", concept: { id: ovf } });

      const actor: AuditActor = { actorUserId: teacher.id, actorType: "user" };
      const write = await service.resolveForWrite(db(), ["debordement entier"], {
        create: false,
        lang: "fr",
        createdBy: teacher.id,
        actor,
        now: new Date(),
      });
      expect(write).toMatchObject({ ids: [ovf], created: [] });

      const ptr = await concept("Pointeur", "Pointer");
      expect((await merge(ovf, ptr, false)).statusCode).toBe(200);
      // Without the option, the alias goes with the loser's aliases to the winner, and the loser's labels vanish.
      expect(await resolveInput("debordement entier")).toMatchObject({ kind: "resolved", concept: { id: ptr } });
      expect(await resolveInput("Dépassement")).toMatchObject({ kind: "unknown" });
    });

    it("lets an alias win over the stop list, and does not consult the stop list when adding", async () => {
      const ptr = await concept("Pointeur", "Pointer");
      await db().insert(conceptTagSortings).values({ poolId, tag: "c01", dropReason: "noise" });
      expect(await resolveInput("c01")).toMatchObject({ kind: "dropped" });
      expect((await add(admin, ptr, "c01")).statusCode).toBe(200);
      expect(await resolveInput("c01")).toMatchObject({ kind: "resolved", concept: { id: ptr } });
    });
  });

  describe("merge and delete", () => {
    it("keeps the loser's labels as aliases when asked, and moves its aliases always", async () => {
      const loser = await concept("Pointage", "Pointing", "mémoire");
      const winner = await concept("Pointeur", "Pointer");
      await add(admin, loser, "Visée");
      await add(admin, loser, "pointer"); // collides with the winner's label: forced
      await add(admin, loser, "pointer", true);
      await add(admin, winner, "Visée", true); // shared with the loser: forced

      const res = await merge(loser, winner, true);
      expect(res.statusCode).toBe(200);
      // "Pointer" equals the winner's English label, "Visée" the winner's alias: both dropped; labels kept.
      expect(Concept.parse(res.json()).aliases).toEqual(["Pointage (mémoire)", "Pointing", "Visée"]);
      expect(await stored(loser)).toEqual([]);
      const [entry] = await db().select().from(auditLog).where(and(eq(auditLog.subjectId, loser), eq(auditLog.action, "concept.merge")));
      expect(entry?.payload).toMatchObject({
        aliasesMoved: [],
        aliasesAdded: ["Pointage (mémoire)", "Pointing"],
        aliasesDropped: ["Visée", "pointer"],
      });
      expect(await resolveInput("Pointage (mémoire)")).toMatchObject({ kind: "resolved", concept: { id: winner } });
    });

    it("moves the loser's own aliases without the option, and keeps no label", async () => {
      const loser = await concept("Pointage", "Pointing");
      const winner = await concept("Pointeur", "Pointer");
      await add(admin, loser, "Visée");
      const res = await merge(loser, winner, false);
      expect(Concept.parse(res.json()).aliases).toEqual(["Visée"]);
      const [entry] = await db().select().from(auditLog).where(and(eq(auditLog.subjectId, loser), eq(auditLog.action, "concept.merge")));
      expect(entry?.payload).toMatchObject({ aliasesMoved: ["Visée"], aliasesAdded: [], aliasesDropped: [] });
      expect(await resolveInput("Pointage")).toMatchObject({ kind: "unknown" });
    });

    it("adds no alias to a merged concept, and deleting a concept deletes its aliases", async () => {
      const loser = await concept("Pointage", null);
      const winner = await concept("Pointeur", "Pointer");
      await merge(loser, winner, false);
      expect((await add(admin, loser, "Visée")).json()).toMatchObject({ error: "concept_merged" });

      const unused = await concept("Inutile", "Unused");
      await add(admin, unused, "Superflu");
      const res = await server.app.inject({ method: "DELETE", url: `/app/api/admin/concepts/${unused}`, headers: admin.headers });
      expect(res.statusCode).toBe(204);
      expect(await stored(unused)).toEqual([]);
    });
  });

  describe("a label another concept answers to as an alias", () => {
    it("is refused on create and on rename with the holder named, so no word turns ambiguous", async () => {
      const ovf = await concept("Dépassement", "Overflow");
      const ptr = await concept("Pointeur", "Pointer");
      await add(admin, ovf, "Trop-plein");
      const created = await server.app.inject({
        method: "POST",
        url: "/app/api/concepts",
        headers: teacher.headers,
        payload: { lang: "fr", label: "trop plein" },
      });
      expect(created.statusCode).toBe(409);
      expect(created.json()).toMatchObject({ error: "concept_exists", concept: { id: ovf, aliases: ["Trop-plein"] } });
      const renamed = await server.app.inject({
        method: "PATCH",
        url: `/app/api/concepts/${ptr}`,
        headers: admin.headers,
        payload: { fr: { label: "Trop plein" } },
      });
      expect(renamed.statusCode).toBe(409);
      expect(renamed.json()).toMatchObject({ error: "concept_exists", concept: { id: ovf } });
      // A qualified label is a homonym, allowed as for labels: it cannot make "trop plein" ambiguous.
      const qualified = await server.app.inject({
        method: "POST",
        url: "/app/api/concepts",
        headers: teacher.headers,
        payload: { lang: "fr", label: "Trop plein", qualifier: "hydraulique" },
      });
      expect(qualified.statusCode).toBe(201);
      const qualifiedRename = await server.app.inject({
        method: "PATCH",
        url: `/app/api/concepts/${ptr}`,
        headers: admin.headers,
        payload: { fr: { label: "Trop plein", qualifier: "mécanique" } },
      });
      expect(qualifiedRename.statusCode).toBe(200);
      // Renaming a concept onto its own alias is no ambiguity.
      const own = await server.app.inject({
        method: "PATCH",
        url: `/app/api/concepts/${ovf}`,
        headers: admin.headers,
        payload: { fr: { label: "Trop-plein" } },
      });
      expect(own.statusCode).toBe(200);
    });
  });
});

/**
 * The links between questions and concepts, before the cut-over (ADR-081,
 * third addendum 2026-10-08): the resolution of a write naming concepts
 * (every branch, all or nothing, the stop list), the replacement of a
 * question's set, the labels in the reader's language, the cascade of a
 * question's deletion, the refusal to delete a linked concept, and the stop
 * list on `POST /concepts`. Nothing outside the `concept` module calls these
 * yet.
 */
describe("links between questions and concepts", () => {
  type Who = Awaited<ReturnType<TestServer["signIn"]>>;

  let server: TestServer;
  let teacher: Who;
  let admin: Who;
  let actor: AuditActor;
  let poolId: string;

  const now = new Date("2026-10-08T10:00:00Z");
  const db = () => server.app.db;

  /** A concept inserted as it is, both languages optional. */
  async function concept(
    fr: [string, string?] | null,
    en: [string, string?] | null = null,
    extra: { status?: "proposed" | "validated" | "merged"; mergedInto?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    const side = (s: [string, string?] | null) => ({
      label: s?.[0] ?? null,
      qualifier: s?.[1] ?? "",
    });
    const f = side(fr);
    const e = side(en);
    await db()
      .insert(concepts)
      .values({
        id,
        status: extra.status ?? "validated",
        mergedInto: extra.mergedInto ?? null,
        labelFr: f.label,
        qualifierFr: f.qualifier,
        keyFr: f.label === null ? null : qualifiedConceptKey(f.label, f.qualifier),
        labelEn: e.label,
        qualifierEn: e.qualifier,
        keyEn: e.label === null ? null : qualifiedConceptKey(e.label, e.qualifier),
      });
    return id;
  }

  /** The admin dropped `tag` in the sorting of the pool. */
  async function drop(tag: string, reason: "organisational" | "task_kind" | "noise") {
    await db().insert(conceptTagSortings).values({
      poolId,
      tag,
      dropReason: reason,
    });
  }

  const resolve = (inputs: string[], create = false, lang: "fr" | "en" = "fr", on: Db | Tx = db()) =>
    service.resolveForWrite(on, inputs, { create, lang, createdBy: teacher.id, actor, now });

  /** The 422 a refused write throws, checked against its contract. */
  async function refusal(inputs: string[], create = false, lang: "fr" | "en" = "fr") {
    const error = await resolve(inputs, create, lang).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DomainError);
    const e = error as DomainError;
    expect(e.status).toBe(422);
    return ConceptWriteRefusal.parse({ error: e.code, message: e.message, ...e.details });
  }

  /** A draft question of the pool: a link needs a question, not a published version. */
  const question = async (name: string) =>
    (await poolService.createQuestion(db(), { poolId, type: "short", internalName: name, createdBy: teacher.id })).id;

  let pointer: string;
  let memory: string;
  let postal: string;
  let merged: string;
  let recursion: string;

  beforeAll(async () => {
    server = await testServer();
    teacher = await server.signIn("teacher");
    admin = await server.signIn("admin");
    actor = { actorUserId: teacher.id, actorType: "user" };
    poolId = randomUUID();
    await db().insert(pools).values({ id: poolId, name: "Links", ownerId: teacher.id });
  });

  beforeEach(async () => {
    await db().delete(questionConcepts);
    await db().delete(conceptTagSortings);
    await db().delete(concepts);
    pointer = await concept(["pointeur"], ["pointer"]);
    memory = await concept(["adresse", "mémoire"], ["address", "memory"]);
    postal = await concept(["adresse", "postale"]);
    merged = await concept(["pointeur ancien"], null, { status: "merged", mergedInto: pointer });
    recursion = await concept(null, ["recursion"], { status: "proposed" });
    await drop("c01", "organisational");
    await drop("lecture-de-code", "task_kind");
  });

  afterAll(async () => {
    await server?.close();
  });

  /**
   * The resolution rules themselves are `planConceptWrite`'s, unit-tested in
   * `@quiz/domain`; here, what the service adds: the rows it loads (the stop
   * list from the sortings), the candidates it labels, what it writes.
   */
  describe("resolveForWrite", () => {
    it("creates a proposed concept in the asked language, credited and audited, once per key", async () => {
      const out = await resolve(["Boucle", "boucles", "pile (structure)", pointer, merged], true, "fr");
      expect(out.created).toHaveLength(2);
      const [loop, stack] = out.created;
      expect(out.ids).toEqual([loop!.id, loop!.id, stack!.id, pointer, pointer]);
      expect(loop).toMatchObject({ status: "proposed", labels: { fr: "Boucle", en: null }, createdBy: teacher.id });
      expect(stack).toMatchObject({ labels: { fr: "pile", en: null }, qualifiers: { fr: "structure", en: "" } });
      const audits = await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "concept.propose"), eq(auditLog.subjectId, loop!.id)));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorUserId: teacher.id, payload: { lang: "fr", label: "Boucle" } });
    });

    it("is all or nothing: every error listed, candidates labelled in the asked language, the stop list from the sortings", async () => {
      const before = (await db().select().from(concepts)).length;
      const body = await refusal(["nouveau", "adresse", "Lecture de code", pointer], true, "en");
      expect(body).toEqual({
        error: "concept_ambiguous",
        message: expect.any(String),
        errors: [
          {
            input: "adresse",
            error: "concept_ambiguous",
            candidates: expect.arrayContaining([
              { id: memory, label: "address", qualifier: "memory", status: "validated" },
              // No English label: the French one, with its qualifier.
              { id: postal, label: "adresse", qualifier: "postale", status: "validated" },
            ]),
          },
          { input: "Lecture de code", error: "concept_dropped", reason: "task_kind" },
        ],
      });
      expect(await db().select().from(concepts)).toHaveLength(before);
    });

    it("answers a key taken meanwhile with 409 concept_exists naming its holder", async () => {
      // A stored key the resolver does not see (stale, as a concurrent insert would be): the insert hits the index.
      const holder = randomUUID();
      await db().insert(concepts).values({ id: holder, status: "validated", labelFr: "zzz", keyFr: "tri" });
      await expect(resolve(["tri"], true)).rejects.toMatchObject({
        code: "concept_exists",
        status: 409,
        details: { concept: { id: holder } },
      });
      expect(await db().select().from(concepts).where(eq(concepts.labelFr, "tri"))).toEqual([]);
    });

    it("creates inside the caller's transaction: its rollback leaves nothing", async () => {
      let created = "";
      await expect(
        db().transaction(async (tx) => {
          created = (await resolve(["nouveau"], true, "fr", tx)).created[0]!.id;
          throw new Error("the caller's write failed");
        }),
      ).rejects.toThrow("the caller's write failed");
      expect(created).not.toBe("");
      expect(await db().select().from(concepts).where(eq(concepts.id, created))).toEqual([]);
      expect(await db().select().from(auditLog).where(eq(auditLog.subjectId, created))).toEqual([]);
    });
  });

  describe("setQuestionConcepts and conceptsOf", () => {
    it("replaces a question's set and reads it in the reader's language, with the fallback", async () => {
      const q = await question("q1");
      const other = await question("q2");
      await db().transaction((tx) => service.setQuestionConcepts(tx, q, [pointer, memory, pointer]));
      await db().transaction((tx) => service.setQuestionConcepts(tx, q, [memory, recursion]));
      const fr = await service.conceptsOf(db(), [q, other], "fr");
      expect(fr.get(q)).toEqual([
        { id: memory, label: "adresse", qualifier: "mémoire", status: "validated" },
        { id: recursion, label: "recursion", qualifier: "", status: "proposed" },
      ]);
      expect(fr.get(other)).toEqual([]);
      const en = await service.conceptsOf(db(), [q], "en");
      expect(en.get(q)!.map((r) => r.label)).toEqual(["address", "recursion"]);
      expect(await service.conceptsOf(db(), [], "fr")).toEqual(new Map());

      await service.setQuestionConcepts(db(), q, []);
      expect((await service.conceptsOf(db(), [q], "fr")).get(q)).toEqual([]);
    });

    it("refuses a merged or missing concept and keeps the set as it was", async () => {
      const q = await question("q3");
      await service.setQuestionConcepts(db(), q, [pointer]);
      const missing = randomUUID();
      const error = await db()
        .transaction((tx) => service.setQuestionConcepts(tx, q, [memory, merged, missing]))
        .then(
          () => null,
          (e: unknown) => e as DomainError,
        );
      expect(error?.status).toBe(422);
      expect(ConceptNotFound.parse({ error: error?.code, ...error?.details })).toMatchObject({ ids: [merged, missing] });
      expect((await service.conceptsOf(db(), [q], "fr")).get(q)!.map((r) => r.id)).toEqual([pointer]);
    });
  });

  describe("deleting what a link refers to", () => {
    it("cascades a question's deletion to its links", async () => {
      const q = await question("gone");
      await service.setQuestionConcepts(db(), q, [pointer]);
      await db().delete(questions).where(eq(questions.id, q));
      expect(await db().select().from(questionConcepts).where(eq(questionConcepts.questionId, q))).toEqual([]);
    });

    it("refuses to delete a concept a question uses: 409 concept_in_use", async () => {
      const q = await question("keeps");
      await service.setQuestionConcepts(db(), q, [recursion]);
      const res = await server.app.inject({
        method: "DELETE",
        url: `/app/api/admin/concepts/${recursion}`,
        headers: admin.headers,
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ error: "concept_in_use" });
      expect(await db().select().from(concepts).where(eq(concepts.id, recursion))).toHaveLength(1);
    });
  });

  describe("POST /concepts and the stop list", () => {
    it("refuses a dropped tag's key with 422 concept_dropped, creates anything else", async () => {
      const refused = await server.app.inject({
        method: "POST",
        url: "/app/api/concepts",
        headers: teacher.headers,
        payload: { lang: "fr", label: "#C01" },
      });
      expect(refused.statusCode, refused.body).toBe(422);
      expect(ConceptWriteRefusal.parse(refused.json())).toMatchObject({
        error: "concept_dropped",
        errors: [{ input: "#C01", error: "concept_dropped", reason: "organisational" }],
      });
      expect(await db().select().from(concepts).where(eq(concepts.labelFr, "C01"))).toEqual([]);

      const created = await server.app.inject({
        method: "POST",
        url: "/app/api/concepts",
        headers: teacher.headers,
        payload: { lang: "fr", label: "C02 bis" },
      });
      expect(created.statusCode, created.body).toBe(201);
    });

    it("lets a qualifier tell a concept apart from a dropped tag, and the admin curate onto it", async () => {
      const post = (who: Who, payload: Record<string, unknown>) =>
        server.app.inject({ method: "POST", url: "/app/api/concepts", headers: who.headers, payload });
      const qualified = await post(teacher, { lang: "fr", label: "C01", qualifier: "langage" });
      expect(qualified.statusCode, qualified.body).toBe(201);
      const byAdmin = await post(admin, { lang: "fr", label: "Lecture de code" });
      expect(byAdmin.statusCode, byAdmin.body).toBe(201);
    });
  });

  describe("PATCH /concepts and the stop list", () => {
    const patch = (who: Who, id: string, payload: Record<string, unknown>) =>
      server.app.inject({ method: "PATCH", url: `/app/api/concepts/${id}`, headers: who.headers, payload });

    it("refuses the creator a rename onto a dropped tag's key, not the admin", async () => {
      const created = await server.app.inject({
        method: "POST",
        url: "/app/api/concepts",
        headers: teacher.headers,
        payload: { lang: "fr", label: "chapitre" },
      });
      const id = created.json().id as string;
      const res = await patch(teacher, id, { en: { label: "Lecture de code" } });
      expect(res.statusCode, res.body).toBe(422);
      expect(ConceptWriteRefusal.parse(res.json())).toEqual({
        error: "concept_dropped",
        message: expect.any(String),
        errors: [{ input: "Lecture de code", error: "concept_dropped", reason: "task_kind" }],
      });
      expect((await db().select().from(concepts).where(eq(concepts.id, id)))[0]).toMatchObject({ labelEn: null });
      const ok = await patch(teacher, id, { fr: { description: "Un chapitre." }, en: { label: "chapter" } });
      expect(ok.statusCode, ok.body).toBe(200);
      const byAdmin = await patch(admin, id, { en: { label: "Lecture de code" } });
      expect(byAdmin.statusCode, byAdmin.body).toBe(200);
      // Already on the list, the side may not move to another dropped key for the creator.
      const moved = await patch(teacher, id, { en: { label: "C01" } });
      expect(moved.statusCode, moved.body).toBe(422);
      expect(moved.json()).toMatchObject({ error: "concept_dropped" });
    });

    it("lets a qualifier-only edit pass on a concept whose label is dropped elsewhere", async () => {
      // `boucle` mapped to a concept in one pool, dropped in another: the concept keeps being edited.
      const loop = await concept(["boucle"]);
      await drop("boucle", "noise");
      const ok = await patch(admin, loop, { fr: { qualifier: "itération" } });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ labels: { fr: "boucle" }, qualifiers: { fr: "itération" } });
    });
  });
});

/**
 * Coverage (ADR-081 §4, sixth addendum 7d): a concept selected anywhere covers
 * its narrower ones. `coverage` is the one place that widens; the pool's
 * concept filter, the poll launcher's search and a course's filter follow.
 * Only `broader` edges widen it: a `related` concept is not covered.
 */
describe("coverage", () => {
  let server: TestServer;
  let restore: () => void;
  let owner: Awaited<ReturnType<TestServer["signIn"]>>;
  const db = () => server.app.db;

  const names = ["root", "mid", "leaf", "other", "side", "lonely"] as const;
  type Name = (typeof names)[number];
  const c = {} as Record<Name, string>;
  const q = {} as Record<Name, string>;
  let poolId: string;
  let courseId: string;

  const broader = (concept: string, target: string) =>
    db().insert(conceptRelations).values({ conceptId: concept, targetId: target, kind: "broader" });

  const list = (query: string) =>
    server.app.inject({ method: "GET", url: `/app/api/pools/${poolId}/questions?${query}`, headers: owner.headers });
  const idsOf = (res: { json: () => unknown }) => QuestionPage.parse(res.json()).items.map((x) => x.id).sort();
  const questions = (...keys: Name[]) => keys.map((k) => q[k]).sort();

  beforeAll(async () => {
    restore = registerForTests(fakeShort);
    server = await testServer();
    owner = await server.signIn("teacher");
    for (const n of names) c[n] = await seedConcept(db(), owner.id, [n], [n]);
    // root <- mid <- leaf (a deep chain), root <- other; side has two parents (leaf and other).
    await broader(c.mid, c.root);
    await broader(c.leaf, c.mid);
    await broader(c.other, c.root);
    await broader(c.side, c.leaf);
    await broader(c.side, c.other);
    // lonely is only related to root: never covered by it.
    const [a, b] = c.root < c.lonely ? [c.root, c.lonely] : [c.lonely, c.root];
    await db().insert(conceptRelations).values({ conceptId: a, targetId: b, kind: "related" });

    poolId = (
      await server.app.inject({ method: "POST", url: "/app/api/pools", headers: owner.headers, payload: { name: "Cov" } })
    ).json().id;
    for (const n of names) {
      const res = await server.app.inject({
        method: "POST",
        url: `/app/api/pools/${poolId}/questions`,
        headers: owner.headers,
        payload: { type: "short", internalName: n, concepts: [c[n]] },
      });
      expect(res.statusCode, res.body).toBe(201);
      q[n] = res.json().meta.id;
      // The poll launcher only searches published questions.
      const published = await server.app.inject({ method: "POST", url: `/app/api/questions/${q[n]}/publish`, headers: owner.headers });
      expect(published.statusCode, published.body).toBe(201);
    }
    courseId = randomUUID();
    await db().insert(courses).values({ id: courseId, name: "Cov course", code: "COV" });
    await db().insert(courseStaff).values({ courseId, userId: owner.id, role: "owner" });
    await db().insert(coursePools).values({ courseId, poolId, mode: "edit" });
  });

  afterAll(async () => {
    await server.close();
    restore();
  });

  describe("coverage", () => {
    it("does not widen through related edges, and covers nothing for no input", async () => {
      expect((await coverage(db(), [c.lonely])).get(c.lonely)).toEqual([c.lonely]);
      expect((await coverage(db(), [c.root])).get(c.root)).not.toContain(c.lonely);
      expect(await coverage(db(), [])).toEqual(new Map());
    });
  });

  describe("the concept filters follow coverage", () => {
    it("the pool filter on a broader concept returns the questions of the narrower ones", async () => {
      expect(idsOf(await list(`concept=${c.root}`))).toEqual(questions("root", "mid", "leaf", "other", "side"));
      expect(idsOf(await list(`concept=${c.mid}`))).toEqual(questions("mid", "leaf", "side"));
      expect(idsOf(await list(`concept=${c.leaf},${c.lonely}`))).toEqual(questions("leaf", "side", "lonely"));
      // A leaf matches its own questions only.
      expect(idsOf(await list(`concept=${c.side}`))).toEqual(questions("side"));
    });

    it("the poll launcher's search across pools widens the same way", async () => {
      const res = await server.app.inject({
        method: "GET",
        url: `/app/api/polls/pool-questions?concept=${c.mid}`,
        headers: owner.headers,
      });
      expect(res.statusCode, res.body).toBe(200);
      const ids = (res.json().items as { id: string }[]).map((x) => x.id).sort();
      expect(ids).toEqual(questions("mid", "leaf", "side"));
    });

    it("a course listing a broader concept covers the narrower ones, in its filter too", async () => {
      await db().insert(courseConcepts).values({ courseId, conceptId: c.mid, addedBy: owner.id });
      expect([...(await conceptsCoveredByCourse(db(), [courseId]))].sort()).toEqual([c.mid, c.leaf, c.side].sort());
      expect(idsOf(await list(`course=${courseId}`))).toEqual(questions("mid", "leaf", "side"));
    });
  });
});

/**
 * The pool's concept map (ADR-116): `GET /pools/:id/concept-map` and the
 * covered counts of `PoolDetail.concepts`, one computation. A concept's
 * number is what its click opens: the pool's filter on it, widened to its
 * narrower concepts (ADR-081 §4). The counting rule itself is
 * `conceptMap.test.ts`'s (`@quiz/domain`); this file proves what the database
 * adds: live questions of this pool only, labels, a merge, and the pool's
 * loader in front of the route.
 */
describe("the pool concept map", () => {
  type Who = Awaited<ReturnType<TestServer["signIn"]>>;

  let server: TestServer;
  let restore: () => void;
  let owner: Who;
  const db = () => server.app.db;

  const names = ["top", "root", "leaf", "x"] as const;
  type Name = (typeof names)[number];
  const c = {} as Record<Name, string>;
  const nameOf = (id: string) => names.find((n) => c[n] === id)!;
  let poolId: string;

  const call = (who: Who | null, method: "GET" | "POST" | "DELETE", url: string, payload?: object, lang = "en") =>
    server.app.inject({
      method,
      url,
      headers: { ...(who?.headers ?? {}), "accept-language": lang },
      ...(payload ? { payload } : {}),
    });
  const conceptMapOf = (who: Who | null, id = poolId, lang = "en") => call(who, "GET", `/app/api/pools/${id}/concept-map`, undefined, lang);

  async function question(pool: string, name: string, concepts: Name[]): Promise<string> {
    const res = await call(owner, "POST", `/app/api/pools/${pool}/questions`, { type: "short", internalName: name, concepts: concepts.map((n) => c[n]) });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().meta.id;
  }

  /** Every node by concept name: `[covered, own]`. */
  async function counts(): Promise<Record<string, [number, number]>> {
    const res = await conceptMapOf(owner);
    expect(res.statusCode, res.body).toBe(200);
    return Object.fromEntries(PoolConceptMap.parse(res.json()).nodes.map((n) => [nameOf(n.concept.id), [n.covered, n.own]]));
  }

  beforeAll(async () => {
    restore = registerForTests(fakeShort);
    server = await testServer();
    owner = await server.signIn("teacher");
    for (const n of names) c[n] = await seedConcept(db(), owner.id, [`fr ${n}`], [`en ${n}`]);
    // top <- root <- leaf; x stands alone.
    await db().insert(conceptRelations).values([
      { conceptId: c.root, targetId: c.top, kind: "broader" },
      { conceptId: c.leaf, targetId: c.root, kind: "broader" },
    ]);

    poolId = (await call(owner, "POST", "/app/api/pools", { name: "Map" })).json().id;
    const elsewhere = (await call(owner, "POST", "/app/api/pools", { name: "Elsewhere" })).json().id;
    await question(poolId, "q1", ["leaf"]);
    await question(poolId, "q3", ["root", "x"]);
    const q7 = await question(poolId, "q7", ["leaf"]);
    expect((await call(owner, "DELETE", `/app/api/questions/${q7}`)).statusCode).toBeLessThan(300);
    await question(elsewhere, "q8", ["root"]);
    await question(poolId, "q9", []);
  });

  afterAll(async () => {
    await server.close();
    restore();
  });

  describe("GET /pools/:id/concept-map", () => {
    it("counts the pool's live questions only, and answers the broader edges among the reached concepts", async () => {
      // q7 (deleted) and q8 (another pool) are never counted; top is reached only from below.
      expect(await counts()).toEqual({ top: [2, 0], root: [2, 1], leaf: [1, 1], x: [1, 1] });
      const map = PoolConceptMap.parse((await conceptMapOf(owner)).json());
      expect(map.broader.map((e) => `${nameOf(e.concept)}<${nameOf(e.target)}`).sort()).toEqual(["leaf<root", "root<top"]);
    });

    it("labels the nodes in the reader's language, by label", async () => {
      const fr = PoolConceptMap.parse((await conceptMapOf(owner, poolId, "fr")).json());
      expect(fr.nodes.map((n) => n.concept.label)).toEqual(["fr leaf", "fr root", "fr top", "fr x"]);
    });

    it("gives each node the number its click opens: the pool's filter on that concept", async () => {
      const map = PoolConceptMap.parse((await conceptMapOf(owner)).json());
      for (const node of map.nodes) {
        const res = await call(owner, "GET", `/app/api/pools/${poolId}/questions?concept=${node.concept.id}`);
        expect(QuestionPage.parse(res.json()).total, node.concept.label).toBe(node.covered);
      }
    });

    it("lists in the pool's detail the linked concepts only, each with its covered count", async () => {
      const detail = PoolDetail.parse((await call(owner, "GET", `/app/api/pools/${poolId}`)).json());
      expect(Object.fromEntries(detail.concepts.map((p) => [nameOf(p.concept.id), p.count]))).toEqual({ root: 2, leaf: 1, x: 1 });
    });

    it("follows a merge: the merged concept is gone, the winner counts the union", async () => {
      const admin = await server.signIn("admin");
      const merged = await call(admin, "POST", `/app/api/admin/concepts/${c.x}/merge`, { into: c.leaf, keepAsAlias: false });
      expect(merged.statusCode, merged.body).toBe(200);
      // q3 is on leaf now: root owns nothing of its own.
      expect(await counts()).toEqual({ top: [2, 0], root: [2, 0], leaf: [2, 2] });
    });
  });

  describe("who reads the concept map: the pool's loader", () => {
    it("is read by a reader of the pool", async () => {
      const reader = await server.signIn("teacher");
      const added = await call(owner, "POST", `/app/api/pools/${poolId}/members`, { userId: reader.id, role: "reader" });
      expect(added.statusCode, added.body).toBeLessThan(300);
      expect((await conceptMapOf(reader)).statusCode).toBe(200);
    });

    it("is the 404 of a missing pool for an outsider, and a 403 for a student", async () => {
      const missing = await conceptMapOf(owner, randomUUID());
      expect(missing.statusCode).toBe(404);
      const outsider = await conceptMapOf(await server.signIn("teacher"));
      expect(outsider.statusCode).toBe(404);
      expect(outsider.json()).toEqual(missing.json());
      expect((await conceptMapOf(await server.signIn("student"))).statusCode).toBe(403);
    });
  });
});
