/**
 * The launcher's "From pools" (issue #162): the pool screen's search, run
 * across every pool the teacher reaches, over the published, live `mcq` and
 * `short` questions — and, with a classroom, over the pools linked to its
 * course. A poll is not graded, so a question of ANY reachable pool may be
 * polled, in a classroom whose course does not use that pool; a question of
 * a pool the teacher cannot reach is the 404 of one that does not exist.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { questions } from "../../db/schema.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import * as poolService from "../pool/service.js";

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
let colleague: { id: string; headers: Record<string, string> };
let seed: Awaited<ReturnType<typeof seedLive>>;

/** Linked to the classroom's course (the seed's pool). */
let linkedId: string;
/** In a pool of the teacher that no course uses. */
let unlinkedId: string;
/** In the colleague's private pool: out of the teacher's reach. */
let foreignId: string;
let unlinkedPoolId: string;

const MCQ = {
  configVersion: 2,
  prompt: "Quelle est la capitale du canton de Vaud ?",
  choices: [
    { text: "Lausanne", correct: true },
    { text: "Yverdon", correct: false },
  ],
  mode: "single",
};
const SHORT = { configVersion: 2, prompt: "Un mot pour pointeur ?", matchers: [{ kind: "exact", value: "adresse" }] };

async function question(
  poolId: string,
  ownerId: string,
  input: { type: "mcq" | "short"; name: string; config: unknown; concepts?: string[]; publish?: boolean },
): Promise<string> {
  const db = server.app.db;
  const { id } = await poolService.createQuestion(db, {
    poolId,
    type: input.type,
    internalName: input.name,
    createdBy: ownerId,
  });
  const [row] = await db.select().from(questions).where(eq(questions.id, id));
  await poolService.putDraft(db, row!, { config: input.config });
  if (input.concepts) {
    await poolService.patchQuestion(
      db,
      row!,
      { concepts: input.concepts, createMissing: true },
      { userId: ownerId, lang: "fr", actor: { actorUserId: ownerId, actorType: "user" } },
    );
  }
  if (input.publish !== false) await poolService.publishQuestion(db, row!, { userId: ownerId });
  return id;
}

const get = (url: string, headers: Record<string, string>) =>
  server.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string>, payload: Payload) =>
  server.app.inject({ method: "POST", url, headers, payload });

const ids = (body: { items: { id: string }[] }) => body.items.map((i) => i.id).sort();
const labels = (concepts: { label: string }[]) => concepts.map((c) => c.label);

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  colleague = await server.signIn("teacher");
  seed = await seedLive(server.app.db, { teacherId: teacher.id, questions: 0 });
  const db = server.app.db;

  linkedId = await question(seed.poolId, teacher.id, {
    type: "mcq",
    name: "Capitale VD",
    config: MCQ,
    concepts: ["capitales"],
  });
  // Neither a draft nor a deleted question can run a poll.
  await question(seed.poolId, teacher.id, { type: "mcq", name: "Brouillon", config: MCQ, publish: false });
  const deleted = await question(seed.poolId, teacher.id, { type: "short", name: "Effacée", config: SHORT });
  const [gone] = await db.select().from(questions).where(eq(questions.id, deleted));
  await poolService.softDeleteQuestion(db, gone!);

  const unlinked = await poolService.createPool(db, {
    name: "Réserve",
    ownerId: teacher.id,
  });
  unlinkedPoolId = unlinked.id;
  unlinkedId = await question(unlinked.id, teacher.id, {
    type: "short",
    name: "Mot libre",
    config: SHORT,
    concepts: ["vocab"],
  });

  const foreign = await poolService.createPool(db, {
    name: "Privé",
    ownerId: colleague.id,
  });
  foreignId = await question(foreign.id, colleague.id, { type: "mcq", name: "Secret", config: MCQ, concepts: ["secret"] });
});
afterAll(async () => {
  await server.close();
});

describe("GET /app/api/polls/pool-questions", () => {
  it("searches every pool the teacher reaches, published and live questions only", async () => {
    const res = await get("/app/api/polls/pool-questions", teacher.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(ids(body)).toEqual([linkedId, unlinkedId].sort());
    expect(body.total).toBe(2);
    expect(body.nextCursor).toBeNull();
    // The scope's concepts feed the filter sheet; a pool out of reach lends none.
    expect(labels(body.concepts)).toEqual(["capitales", "vocab"]);
    const row = body.items.find((i: { id: string }) => i.id === unlinkedId);
    expect(row).toMatchObject({
      type: "short",
      internalName: "Mot libre",
      prompt: SHORT.prompt,
      pool: { id: unlinkedPoolId, name: "Réserve" },
      concepts: [expect.objectContaining({ label: "vocab", qualifier: "", status: "proposed" })],
      latestNumber: 1,
    });
    // The statement is the student's view: the key never travels here.
    expect(JSON.stringify(body)).not.toContain("adresse");
  });

  it("narrows to the pools linked to the classroom's course", async () => {
    const res = await get(`/app/api/polls/pool-questions?classroomId=${seed.classroomId}`, teacher.headers);
    expect(res.statusCode).toBe(200);
    expect(ids(res.json())).toEqual([linkedId]);
    expect(labels(res.json().concepts)).toEqual(["capitales"]);
  });

  it("speaks the pool screen's filters: text, concept, type, difficulty", async () => {
    const by = async (qs: string) => ids((await get(`/app/api/polls/pool-questions?${qs}`, teacher.headers)).json());
    const scope = (await get("/app/api/polls/pool-questions", teacher.headers)).json();
    const capitales = scope.concepts.find((c: { label: string }) => c.label === "capitales").id;
    expect(await by("q=libre")).toEqual([unlinkedId]);
    expect(await by("q=Lausanne")).toEqual([linkedId]);
    expect(await by(`concept=${capitales}`)).toEqual([linkedId]);
    expect(await by("type=short")).toEqual([unlinkedId]);
    // A type a poll cannot run matches nothing; it never widens the search.
    expect(await by("type=code")).toEqual([]);
    expect(await by("type=code,mcq")).toEqual([linkedId]);
    expect(await by("difficulty=5")).toEqual([]);
    expect(await by("versionMin=2")).toEqual([]);
  });

  it("pages with the pool screen's cursor", async () => {
    const first = (await get("/app/api/polls/pool-questions?limit=1", teacher.headers)).json();
    expect(first.items).toHaveLength(1);
    expect(first.total).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    const second = (
      await get(`/app/api/polls/pool-questions?limit=1&cursor=${first.nextCursor}`, teacher.headers)
    ).json();
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([first.items[0].id, second.items[0].id].sort()).toEqual([linkedId, unlinkedId].sort());
  });

  it("answers a colleague with their own pools only", async () => {
    const res = await get("/app/api/polls/pool-questions", colleague.headers);
    expect(ids(res.json())).toEqual([foreignId]);
    expect(labels(res.json().concepts)).toEqual(["secret"]);
  });

  it("404s a classroom the caller is not on the staff of, 400s a malformed one", async () => {
    const foreign = await get(`/app/api/polls/pool-questions?classroomId=${seed.classroomId}`, colleague.headers);
    expect(foreign.statusCode).toBe(404);
    const malformed = await get("/app/api/polls/pool-questions?classroomId=nope", teacher.headers);
    expect(malformed.statusCode).toBe(400);
  });
});

describe("POST /app/api/polls with a pool question", () => {
  it("polls a question of a pool the classroom's course does not use", async () => {
    const res = await post("/app/api/polls", teacher.headers, {
      questionId: unlinkedId,
      audience: { kind: "classroom", classroomId: seed.classroomId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().evaluation.classroomId).toBe(seed.classroomId);
    expect(res.json().question.id).toBe(unlinkedId);
  });

  it("404s a question of a pool the teacher cannot reach", async () => {
    const res = await post("/app/api/polls", teacher.headers, {
      questionId: foreignId,
      audience: { kind: "classroom", classroomId: seed.classroomId },
    });
    expect(res.statusCode).toBe(404);
    const anonymous = await post("/app/api/polls", teacher.headers, {
      questionId: foreignId,
      audience: { kind: "anonymous" },
    });
    expect(anonymous.statusCode).toBe(404);
  });
});
