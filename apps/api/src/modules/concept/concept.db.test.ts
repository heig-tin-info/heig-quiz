/**
 * The vocabulary of concepts over the real application (ADR-081, addendum
 * 2026-10-08): proposing (one key per language among the concepts that are
 * not merged, held by the database's index), resolving a typed label
 * (addendum §2) and the rights to edit (addendum §5), with their audit rows.
 * Every test starts from an empty vocabulary and creates what it needs.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ConceptResolveResponse, Concept as ConceptSchema, type Concept } from "@quiz/contracts";

import { auditLog, concepts } from "../../db/schema.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";

type Who = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let teacher: Who;
let colleague: Who;
let admin: Who;
let student: Who;

const call = (who: Who, method: "GET" | "POST" | "PATCH", url: string, payload?: Payload) =>
  server.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload }) });

const post = (who: Who, body: Payload) => call(who, "POST", "/app/api/concepts", body);

async function create(who: Who, body: Payload): Promise<Concept> {
  const res = await post(who, body);
  expect(res.statusCode, res.body).toBe(201);
  return ConceptSchema.parse(res.json());
}

const patch = (who: Who, id: string, body: Payload) => call(who, "PATCH", `/app/api/concepts/${id}`, body);

async function resolve(...inputs: string[]) {
  const res = await call(teacher, "POST", "/app/api/concepts/resolve", { inputs });
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
    expect(res.json()).toMatchObject({ error: "concept_exists", concept: { id: first.id } });
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
    expect((await call(student, "POST", "/app/api/concepts/resolve", { inputs: ["pile"] })).statusCode).toBe(403);
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

  it("resolves one exact match through either language's label", async () => {
    const stack = await create(teacher, { lang: "fr", label: "pile" });
    expect((await patch(teacher, stack.id, { en: { label: "stack" } })).statusCode).toBe(200);
    const [fr, en] = await resolve("Piles", "stacks");
    expect(fr).toMatchObject({ kind: "resolved", concept: { id: stack.id } });
    expect(en).toMatchObject({ kind: "resolved", concept: { id: stack.id } });
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
    expect((await call(teacher, "POST", "/app/api/concepts/resolve", { inputs: [] })).statusCode).toBe(400);
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
    expect(res.json()).toMatchObject({ error: "concept_exists", concept: { id: holder.id } });
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
