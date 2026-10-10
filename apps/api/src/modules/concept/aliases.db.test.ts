/**
 * Curated concept aliases (ADR-081 §6, fifth addendum): added and removed by
 * the admin alone, resolved like a label, guarded against collisions, kept
 * and moved by a merge, gone with a deleted concept.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AliasCollision, Concept, ConceptList, ConceptResolveResponse } from "@quiz/contracts";
import { qualifiedConceptKey } from "@quiz/domain";

import type { AuditActor } from "../../audit.js";
import { auditLog, conceptAliases, conceptTagSortings, concepts, pools } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import * as service from "./service.js";

type Who = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let teacher: Who;
let admin: Who;
let student: Who;
let poolId: string;
const db = () => server.app.db;

async function concept(fr: string | null, en: string | null, qualifier = ""): Promise<string> {
  const id = randomUUID();
  await db()
    .insert(concepts)
    .values({
      id,
      status: "validated",
      createdBy: teacher.id,
      labelFr: fr,
      qualifierFr: fr === null ? "" : qualifier,
      keyFr: fr === null ? null : qualifiedConceptKey(fr, qualifier),
      labelEn: en,
      keyEn: en === null ? null : qualifiedConceptKey(en, ""),
    });
  return id;
}

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
