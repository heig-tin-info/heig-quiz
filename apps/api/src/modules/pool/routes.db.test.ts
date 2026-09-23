import { readdir } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { assets, coursePools, courseStaff, courses, pools, questions, users } from "../../db/schema.js";
import { subscribe } from "../../events.js";
import { testServer, type TestServer } from "../../test/http.js";
import { fakeRunnerType, fakeShort } from "../../test/fakeType.js";
import { seedLive } from "../../test/live.js";
import { addItems, applyState, byId } from "../evaluation/service.js";
import * as live from "../live/service.js";
import * as poolService from "./service.js";

/** A real 1×1 PNG: the upload path reads the bytes, not the header we claim. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function multipart(bytes: Buffer, filename: string, contentType: string) {
  const boundary = "----quiztestboundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  return {
    payload: Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

let server: TestServer;
let owner: Awaited<ReturnType<TestServer["signIn"]>>;
let stranger: Awaited<ReturnType<TestServer["signIn"]>>;
let poolId: string;
let restoreShort: () => void;
let restoreRunner: () => void;

async function createQuestion(name: string, type = "short") {
  const res = await server.app.inject({
    method: "POST",
    url: `/app/api/pools/${poolId}/questions`,
    headers: owner.headers,
    payload: { type, internalName: name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().meta.id as string;
}

beforeAll(async () => {
  restoreShort = registerForTests(fakeShort);
  restoreRunner = registerForTests(fakeRunnerType);
  server = await testServer();
  owner = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
  const created = await server.app.inject({
    method: "POST",
    url: "/app/api/pools",
    headers: owner.headers,
    payload: { name: "PRG1 pool" },
  });
  expect(created.statusCode).toBe(201);
  poolId = created.json().id;
});

afterAll(async () => {
  await server.close();
  restoreShort();
  restoreRunner();
});

describe("guards (invariant 6)", () => {
  it("answers 404, not 403, to a teacher who is not staff of the pool", async () => {
    for (const url of [`/app/api/pools/${poolId}`, `/app/api/pools/${poolId}/questions`]) {
      const res = await server.app.inject({ method: "GET", url, headers: stranger.headers });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
    }
  });

  it("does not let a stranger write into the pool either", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: `/app/api/pools/${poolId}/questions`,
      headers: stranger.headers,
      payload: { type: "short", internalName: "intruder" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("answers 404 on a question of a pool the teacher cannot reach, read or write", async () => {
    const id = await createQuestion("guarded question");
    const read = await server.app.inject({
      method: "GET",
      url: `/app/api/questions/${id}`,
      headers: stranger.headers,
    });
    expect(read.statusCode).toBe(404);
    expect(read.json()).toEqual({ error: "not_found" });
    const write = await server.app.inject({
      method: "PATCH",
      url: `/app/api/questions/${id}`,
      headers: stranger.headers,
      payload: { internalName: "hijacked" },
    });
    expect(write.statusCode).toBe(404);
    expect(write.json()).toEqual({ error: "not_found" });
    // The owner still reaches it, so the 404 above is the predicate, not a miss.
    const own = await server.app.inject({
      method: "GET",
      url: `/app/api/questions/${id}`,
      headers: owner.headers,
    });
    expect(own.statusCode).toBe(200);
  });

  it("refuses a student outright, whatever the pool", async () => {
    const student = await server.signIn("student");
    const res = await server.app.inject({
      method: "GET",
      url: "/app/api/pools",
      headers: student.headers,
    });
    expect(res.statusCode).toBe(403);
  });

  it("lets the staff of a course reach the pools linked to it", async () => {
    const courseId = crypto.randomUUID();
    await server.app.db.insert(courses).values({ id: courseId, name: "PRG1", code: `C${Date.now()}` });
    await server.app.db.insert(courseStaff).values({ courseId, userId: stranger.id });
    // Before the link: invisible.
    expect(
      (await server.app.inject({
        method: "GET",
        url: `/app/api/pools/${poolId}`,
        headers: stranger.headers,
      })).statusCode,
    ).toBe(404);

    const linked = await server.app.inject({
      method: "PUT",
      url: `/app/api/courses/${courseId}/pools`,
      headers: stranger.headers,
      payload: { poolIds: [poolId] },
    });
    // The stranger cannot link a pool they cannot reach: the link is empty.
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toEqual([]);

    // The owner links it, and now the whole staff reaches it.
    await server.app.db.insert(courseStaff).values({ courseId, userId: owner.id });
    const byOwner = await server.app.inject({
      method: "PUT",
      url: `/app/api/courses/${courseId}/pools`,
      headers: owner.headers,
      payload: { poolIds: [poolId] },
    });
    expect(byOwner.json()).toHaveLength(1);
    expect(
      (await server.app.inject({
        method: "GET",
        url: `/app/api/pools/${poolId}`,
        headers: stranger.headers,
      })).statusCode,
    ).toBe(200);
    await server.app.db.delete(coursePools).where(eq(coursePools.courseId, courseId));
    await server.app.db.delete(courseStaff).where(eq(courseStaff.courseId, courseId));
  });
});

describe("the draft and publication routes", () => {
  it("stores an invalid draft with its issues and refuses to publish it (D16)", async () => {
    const id = await createQuestion("half written");
    const saved = await server.app.inject({
      method: "PUT",
      url: `/app/api/questions/${id}/draft`,
      headers: owner.headers,
      payload: { config: { statement: "Where?", answer: "" }, explanation: "" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().valid).toBe(false);
    expect(saved.json().issues[0].path).toEqual(["answer"]);

    const refused = await server.app.inject({
      method: "POST",
      url: `/app/api/questions/${id}/publish`,
      headers: owner.headers,
      payload: {},
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe("config_invalid");

    // The stored draft is still the teacher's text, untouched.
    const detail = await server.app.inject({
      method: "GET",
      url: `/app/api/questions/${id}`,
      headers: owner.headers,
    });
    expect(detail.json().draft.config).toEqual({ statement: "Where?", answer: "" });
    expect(detail.json().draft.valid).toBe(false);
  });

  it("publishes, then serves the version and its history", async () => {
    const id = await createQuestion("publishable");
    await server.app.inject({
      method: "PUT",
      url: `/app/api/questions/${id}/draft`,
      headers: owner.headers,
      payload: { config: { statement: "2 + 2 ?", answer: "4" } },
    });
    const published = await server.app.inject({
      method: "POST",
      url: `/app/api/questions/${id}/publish`,
      headers: owner.headers,
      payload: { changeNote: "first" },
    });
    expect(published.statusCode).toBe(201);
    expect(published.json().number).toBe(1);

    const version = await server.app.inject({
      method: "GET",
      url: `/app/api/questions/${id}/versions/1`,
      headers: owner.headers,
    });
    expect(version.json().config).toEqual({ statement: "2 + 2 ?", answer: "4" });
    const list = await server.app.inject({
      method: "GET",
      url: `/app/api/questions/${id}/versions`,
      headers: owner.headers,
    });
    expect(list.json()).toHaveLength(1);
  });

  it("creates a draft for every registered MVP type from its emptyDraft()", async () => {
    for (const type of ["mcq", "short", "cloze", "code"]) {
      const res = await server.app.inject({
        method: "POST",
        url: `/app/api/pools/${poolId}/questions`,
        headers: owner.headers,
        payload: { type, internalName: `draft ${type}` },
      });
      expect(res.statusCode, type).toBe(201);
      expect(res.json().meta.type).toBe(type);
    }
  });
});

describe("POST /questions/:id/try (F-QST-09)", () => {
  it("grades the teacher's answer with the registered type and returns the solution", async () => {
    const id = await createQuestion("gradeable");
    await server.app.inject({
      method: "PUT",
      url: `/app/api/questions/${id}/draft`,
      headers: owner.headers,
      payload: { config: { statement: "Capital of France?", answer: "Paris" } },
    });
    const right = await server.app.inject({
      method: "POST",
      url: `/app/api/questions/${id}/try`,
      headers: owner.headers,
      payload: { source: "draft", answer: "Paris" },
    });
    expect(right.json()).toMatchObject({
      status: "graded",
      points: 1,
      maxPoints: 1,
      solution: { answer: "Paris" },
    });

    const wrong = await server.app.inject({
      method: "POST",
      url: `/app/api/questions/${id}/try`,
      headers: owner.headers,
      payload: { source: "draft", answer: "Lyon" },
    });
    expect(wrong.json()).toMatchObject({ status: "graded", points: 0 });
  });

  it("degrades to runner_unavailable when the grading needs a runner (D14)", async () => {
    const id = await createQuestion("needs a runner", "code");
    await server.app.inject({
      method: "PUT",
      url: `/app/api/questions/${id}/draft`,
      headers: owner.headers,
      payload: { config: { source: "int main(){}" } },
    });
    const res = await server.app.inject({
      method: "POST",
      url: `/app/api/questions/${id}/try`,
      headers: owner.headers,
      payload: { source: "draft", answer: "int main(){return 0;}" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("runner_unavailable");
  });

  it("previews the student view without the answer key", async () => {
    const id = await createQuestion("previewable");
    await server.app.inject({
      method: "PUT",
      url: `/app/api/questions/${id}/draft`,
      headers: owner.headers,
      payload: { config: { statement: "Visible", answer: "secret-key" } },
    });
    const res = await server.app.inject({
      method: "POST",
      url: `/app/api/questions/${id}/preview`,
      headers: owner.headers,
      payload: { source: "draft" },
    });
    expect(res.json().student).toEqual({ statement: "Visible" });
    expect(JSON.stringify(res.json())).not.toContain("secret-key");
  });

  it("emits no refresh hint for a preview or a try: a read behind a POST", async () => {
    const id = await createQuestion("silent-read");
    const hints: string[] = [];
    const stop = subscribe((m) => {
      if (m.kind === "hint") hints.push(m.type);
    });
    try {
      // The write that precedes them does hint, which is what would start the
      // round trip the two reads must not sustain.
      await server.app.inject({
        method: "PUT",
        url: `/app/api/questions/${id}/draft`,
        headers: owner.headers,
        payload: { config: { statement: "Visible", answer: "k" } },
      });
      expect(hints.length).toBeGreaterThan(0);
      hints.length = 0;
      for (const path of ["preview", "try"]) {
        const res = await server.app.inject({
          method: "POST",
          url: `/app/api/questions/${id}/${path}`,
          headers: owner.headers,
          payload: path === "preview" ? { source: "draft" } : { source: "draft", answer: "k" },
        });
        expect(res.statusCode, path).toBe(200);
      }
      expect(hints).toEqual([]);
    } finally {
      stop();
    }
  });
});

describe("assets", () => {
  it("stores the same bytes once, whoever uploads them again", async () => {
    const body = multipart(PNG, "pixel.png", "image/png");
    const first = await server.app.inject({
      method: "POST",
      url: `/app/api/pools/${poolId}/assets`,
      headers: { ...owner.headers, "content-type": body.contentType },
      payload: body.payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ mime: "image/png", width: 1, height: 1 });

    const again = await server.app.inject({
      method: "POST",
      url: `/app/api/pools/${poolId}/assets`,
      headers: { ...owner.headers, "content-type": body.contentType },
      payload: body.payload,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id);

    const rows = await server.app.db.select().from(assets);
    expect(rows).toHaveLength(1);
    // One file on disk, named after the hash.
    const shard = await readdir(`${server.assetsDir}/${rows[0]!.sha256.slice(0, 2)}`);
    expect(shard).toEqual([rows[0]!.sha256]);
  });

  it("refuses an SVG, and anything else the bytes do not vouch for", async () => {
    for (const [bytes, name, declared] of [
      [SVG, "payload.svg", "image/svg+xml"],
      // A lie about the content type changes nothing: the bytes decide.
      [SVG, "payload.png", "image/png"],
      [Buffer.from("not an image at all"), "text.png", "image/png"],
    ] as const) {
      const body = multipart(bytes, name, declared);
      const res = await server.app.inject({
        method: "POST",
        url: `/app/api/pools/${poolId}/assets`,
        headers: { ...owner.headers, "content-type": body.contentType },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(415);
      expect(res.json().error).toBe("unsupported_media_type");
    }
  });

  it("serves the bytes to a staff session, immutably, and 404 to a student", async () => {
    const [asset] = await server.app.db.select().from(assets);
    const served = await server.app.inject({
      method: "GET",
      url: `/app/api/assets/${asset!.id}`,
      headers: owner.headers,
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(served.rawPayload.equals(PNG)).toBe(true);

    // A student with no attempt showing the image has no way in; a colleague
    // does, because the store is deduplicated instance-wide.
    const student = await server.signIn("student");
    const denied = await server.app.inject({
      method: "GET",
      url: `/app/api/assets/${asset!.id}`,
      headers: student.headers,
    });
    expect(denied.statusCode).toBe(404);
    expect(
      (await server.app.inject({
        method: "GET",
        url: `/app/api/assets/${asset!.id}`,
        headers: stranger.headers,
      })).statusCode,
    ).toBe(200);
  });
});

/**
 * Finding H3: every image in a question prompt was a broken image during the
 * exam, because a student session could never read an asset. The rule is the
 * attempt, not the role: a student reaches an asset exactly when a question
 * they are taking (or reviewing after the release) shows it.
 */
describe("a student reads the assets of their own attempt (H3)", () => {
  it("serves the image during the attempt, and 404s to another classroom", async () => {
    const db = server.app.db;
    const [asset] = await db.select().from(assets);
    const student = await server.signIn("student");
    const elsewhere = await server.signIn("student");

    const seed = await seedLive(db, {
      teacherId: owner.id,
      studentIds: [student.id],
      questions: 0,
    });
    // A question whose statement embeds the uploaded image, published
    // through the real pipeline: the link row is written at publication.
    const questionId = await poolService.createQuestion(db, {
      poolId: seed.poolId,
      type: "short",
      internalName: "with-an-image",
      createdBy: owner.id,
    });
    const [question] = await db.select().from(questions).where(eq(questions.id, questionId));
    await poolService.putDraft(db, question!, {
      config: { statement: `Look at ![](asset:${asset!.id})`, answer: "yes" },
    });
    await poolService.publishQuestion(db, question!, { userId: owner.id });
    await addItems(db, (await byId(db, seed.evaluationId))!, [questionId], () => 1, {
      attemptCount: 0,
    });

    const served = (headers: Record<string, string>) =>
      server.app.inject({ method: "GET", url: `/app/api/assets/${asset!.id}`, headers });

    // Before the attempt exists, the student is nobody to this asset.
    expect((await served(student.headers)).statusCode).toBe(404);

    const evaluation = await applyState(
      db,
      (await byId(db, seed.evaluationId))!,
      "running",
      server.clock.now(),
    );
    const participant = (await live.participantOf(db, evaluation, student.id))!;
    const created = await live.ensureAttempt(db, evaluation, participant, server.clock.now());
    await live.beginAttempt(db, evaluation, created, participant, server.clock.now());

    const ok = await served(student.headers);
    expect(ok.statusCode).toBe(200);
    expect(ok.rawPayload.equals(PNG)).toBe(true);

    // A student of another classroom stays at 404, attempt or no attempt.
    expect((await served(elsewhere.headers)).statusCode).toBe(404);
  });
});

describe("pool lifecycle", () => {
  it("lists, renames and deletes a pool, and only its owner deletes it", async () => {
    const created = await server.app.inject({
      method: "POST",
      url: "/app/api/pools",
      headers: owner.headers,
      payload: { name: "Temporary" },
    });
    const id = created.json().id;
    const renamed = await server.app.inject({
      method: "PATCH",
      url: `/app/api/pools/${id}`,
      headers: owner.headers,
      payload: { name: "Renamed", visibility: "shared" },
    });
    expect(renamed.json()).toMatchObject({ name: "Renamed", visibility: "shared" });

    const listed = await server.app.inject({
      method: "GET",
      url: "/app/api/pools",
      headers: owner.headers,
    });
    expect(listed.json().map((p: { id: string }) => p.id)).toContain(id);

    const gone = await server.app.inject({
      method: "DELETE",
      url: `/app/api/pools/${id}`,
      headers: owner.headers,
    });
    expect(gone.statusCode).toBe(204);
    expect(await server.app.db.select().from(pools).where(eq(pools.id, id))).toEqual([]);
  });
});

describe("the tag vocabulary of a pool", () => {
  let tagPool: string;
  let outsider: Awaited<ReturnType<TestServer["signIn"]>>;

  beforeAll(async () => {
    outsider = await server.signIn("teacher");
    const created = await server.app.inject({
      method: "POST",
      url: "/app/api/pools",
      headers: owner.headers,
      payload: { name: "Tagged pool" },
    });
    tagPool = created.json().id;
    const question = await server.app.inject({
      method: "POST",
      url: `/app/api/pools/${tagPool}/questions`,
      headers: owner.headers,
      payload: { type: "short", internalName: "tagged" },
    });
    await server.app.inject({
      method: "PATCH",
      url: `/app/api/questions/${question.json().meta.id}`,
      headers: owner.headers,
      payload: { tags: ["Malloc", "pointers"] },
    });
  });

  it("lists every tag with its description and its usage count", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: `/app/api/pools/${tagPool}/tags`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { tag: "malloc", description: "", count: 1 },
      { tag: "pointers", description: "", count: 1 },
    ]);
  });

  it("writes the description of a tag, and the pool detail still lists plain names", async () => {
    const res = await server.app.inject({
      method: "PATCH",
      url: `/app/api/pools/${tagPool}/tags/malloc`,
      headers: owner.headers,
      payload: { description: "Allocates memory on the heap" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      tag: "malloc",
      description: "Allocates memory on the heap",
      count: 1,
    });

    const detail = await server.app.inject({
      method: "GET",
      url: `/app/api/pools/${tagPool}`,
      headers: owner.headers,
    });
    expect(detail.json().tags).toEqual(["malloc", "pointers"]);
  });

  it("refuses a description that is not a string", async () => {
    const res = await server.app.inject({
      method: "PATCH",
      url: `/app/api/pools/${tagPool}/tags/malloc`,
      headers: owner.headers,
      payload: { description: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation");
  });

  it("answers 404 to a stranger, on the listing as on the description", async () => {
    const listed = await server.app.inject({
      method: "GET",
      url: `/app/api/pools/${tagPool}/tags`,
      headers: outsider.headers,
    });
    expect(listed.statusCode).toBe(404);

    const described = await server.app.inject({
      method: "PATCH",
      url: `/app/api/pools/${tagPool}/tags/malloc`,
      headers: outsider.headers,
      payload: { description: "mine now" },
    });
    expect(described.statusCode).toBe(404);
    expect(described.json()).toEqual({ error: "not_found" });

    // And nothing was written behind the 404.
    const still = await server.app.inject({
      method: "GET",
      url: `/app/api/pools/${tagPool}/tags`,
      headers: owner.headers,
    });
    expect(still.json()[0].description).toBe("Allocates memory on the heap");
  });
});

// ---------------------------------------------------------------------------
// Sharing over HTTP (F-POOL-05, F-POOL-06)
// ---------------------------------------------------------------------------

type Actor = Awaited<ReturnType<TestServer["signIn"]>> & { email?: string };

/** `GET /pools/:id` — a read anyone the pool lets in may do. */
async function readPool(id: string, who: Actor) {
  return server.app.inject({ method: "GET", url: `/app/api/pools/${id}`, headers: who.headers });
}

/** A write reserved to a contributor: creating a question. */
async function writeQuestion(id: string, who: Actor, name: string) {
  return server.app.inject({
    method: "POST",
    url: `/app/api/pools/${id}/questions`,
    headers: who.headers,
    payload: { type: "short", internalName: name },
  });
}

/** A write reserved to an owner: renaming the pool. */
async function renamePool(id: string, who: Actor, name: string) {
  return server.app.inject({
    method: "PATCH",
    url: `/app/api/pools/${id}`,
    headers: who.headers,
    payload: { name },
  });
}

async function invite(id: string, who: Actor, email: string, role: string) {
  return server.app.inject({
    method: "POST",
    url: `/app/api/pools/${id}/members`,
    headers: who.headers,
    payload: { email, role },
  });
}

/** `GET /pools/:id/candidates?q=` — the teachers an owner may still invite. */
async function candidates(id: string, who: Actor, q: string) {
  return server.app.inject({
    method: "GET",
    url: `/app/api/pools/${id}/candidates?q=${encodeURIComponent(q)}`,
    headers: who.headers,
  });
}

describe("pool sharing", () => {
  let poolOwner: Actor;
  let reader: Actor;
  let contributor: Actor;
  let coOwner: Actor;
  let outsider: Actor;
  let staffer: Actor;
  let admin: Actor;
  let shared: string;
  const emails = new Map<string, string>();

  async function actor(role: "teacher" | "admin", label: string): Promise<Actor> {
    const email = `${label}-${crypto.randomUUID().slice(0, 8)}@heig.test`;
    const who = await server.signIn(role, email);
    emails.set(who.id, email);
    return who;
  }

  beforeAll(async () => {
    poolOwner = await actor("teacher", "pool-owner");
    reader = await actor("teacher", "reader");
    contributor = await actor("teacher", "contributor");
    coOwner = await actor("teacher", "co-owner");
    outsider = await actor("teacher", "outsider");
    staffer = await actor("teacher", "staffer");
    admin = await actor("admin", "admin");

    const created = await server.app.inject({
      method: "POST",
      url: "/app/api/pools",
      headers: poolOwner.headers,
      payload: { name: "Shared pool", icon: "cpu" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().icon).toBe("cpu");
    expect(created.json().visibility).toBe("private");
    shared = created.json().id;

    for (const [who, role] of [
      [reader, "reader"],
      [contributor, "contributor"],
      [coOwner, "owner"],
    ] as const) {
      const res = await invite(shared, poolOwner, emails.get(who.id)!, role);
      expect(res.statusCode).toBe(201);
    }
  });

  it("flips a private pool to shared on the first invitation", async () => {
    const detail = await readPool(shared, poolOwner);
    expect(detail.json().pool.visibility).toBe("shared");
    expect(detail.json().role).toBe("owner");
  });

  it("gives every party the role they hold, and nothing more", async () => {
    // reader: reads, does not write.
    expect((await readPool(shared, reader)).json().role).toBe("reader");
    const refused = await writeQuestion(shared, reader, "reader tries");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("forbidden");

    // contributor: writes questions, does not manage the pool.
    expect((await readPool(shared, contributor)).json().role).toBe("contributor");
    expect((await writeQuestion(shared, contributor, "contributor writes")).statusCode).toBe(201);
    expect((await renamePool(shared, contributor, "hijacked")).statusCode).toBe(403);

    // member-owner: manages it.
    expect((await readPool(shared, coOwner)).json().role).toBe("owner");
    expect((await renamePool(shared, coOwner, "Shared pool")).statusCode).toBe(200);

    // admin: owner everywhere.
    expect((await readPool(shared, admin)).json().role).toBe("owner");

    // stranger: the pool does not exist.
    expect((await readPool(shared, outsider)).statusCode).toBe(404);
    expect((await writeQuestion(shared, outsider, "intruder")).statusCode).toBe(404);
  });

  it("offers an owner the teachers not yet seated, by name or address", async () => {
    // The outsider holds no seat: offered, found by a piece of the address,
    // whatever the case it is typed in.
    const found = await candidates(shared, poolOwner, "OUTSIDER-");
    expect(found.statusCode).toBe(200);
    expect(found.json().map((c: { userId: string }) => c.userId)).toEqual([outsider.id]);
    expect(found.json()[0]).toMatchObject({ email: emails.get(outsider.id), givenName: "Test" });

    // Seated already, or the owner: not offered again.
    expect((await candidates(shared, poolOwner, "reader-")).json()).toEqual([]);
    expect((await candidates(shared, poolOwner, emails.get(poolOwner.id)!)).json()).toEqual([]);

    // A wildcard typed by hand is a character to find, not everyone.
    expect((await candidates(shared, poolOwner, "%")).json()).toEqual([]);

    // The directory is an owner's: a member-owner reads it, a reader does
    // not, and a stranger does not see the pool at all.
    expect((await candidates(shared, coOwner, "")).statusCode).toBe(200);
    expect((await candidates(shared, reader, "")).statusCode).toBe(403);
    expect((await candidates(shared, outsider, "")).statusCode).toBe(404);
  });

  it("invites the account picked, by id, and refuses a body naming both or neither", async () => {
    const post = (payload: unknown) =>
      server.app.inject({
        method: "POST",
        url: `/app/api/pools/${shared}/members`,
        headers: poolOwner.headers,
        payload,
      });
    expect((await post({ role: "reader" })).statusCode).toBe(400);
    expect(
      (await post({ userId: outsider.id, email: emails.get(outsider.id), role: "reader" }))
        .statusCode,
    ).toBe(400);
    // A student's account is nobody to invite.
    const student = await server.signIn("student");
    expect((await post({ userId: student.id, role: "reader" })).statusCode).toBe(404);

    const seated = await post({ userId: outsider.id, role: "contributor" });
    expect(seated.statusCode).toBe(201);
    expect(
      seated.json().members.find((m: { userId: string }) => m.userId === outsider.id)?.role,
    ).toBe("contributor");
    expect((await post({ userId: outsider.id, role: "reader" })).statusCode).toBe(409);
    // Seated now, so no longer offered.
    expect((await candidates(shared, poolOwner, "outsider-")).json()).toEqual([]);

    // The seat is taken back: the outsider stays a stranger for the tests below.
    const removed = await server.app.inject({
      method: "DELETE",
      url: `/app/api/pools/${shared}/members/${outsider.id}`,
      headers: poolOwner.headers,
    });
    expect(removed.statusCode).toBe(204);
    expect((await readPool(shared, outsider)).statusCode).toBe(404);
  });

  it("keeps the staff of a linked course a contributor, never an owner", async () => {
    const courseId = crypto.randomUUID();
    await server.app.db
      .insert(courses)
      .values({ id: courseId, name: "Sharing", code: `S${Date.now()}` });
    await server.app.db.insert(courseStaff).values({ courseId, userId: staffer.id });
    const linked = await server.app.inject({
      method: "PUT",
      url: `/app/api/courses/${courseId}/pools`,
      headers: staffer.headers,
      payload: { poolIds: [shared] },
    });
    // A pool is linked only by someone who can already reach it, so the owner
    // does it: the staffer cannot link a pool they do not see yet.
    expect(linked.json().length).toBe(0);
    await server.app.db.insert(coursePools).values({ courseId, poolId: shared });

    const detail = await readPool(shared, staffer);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().role).toBe("contributor");
    expect((await writeQuestion(shared, staffer, "staff writes")).statusCode).toBe(201);
    expect((await renamePool(shared, staffer, "staff renames")).statusCode).toBe(403);
  });

  it("lets every teacher READ a public pool and nobody write it", async () => {
    const created = await server.app.inject({
      method: "POST",
      url: "/app/api/pools",
      headers: poolOwner.headers,
      payload: { name: "Public pool", visibility: "public" },
    });
    const open = created.json().id;
    const seen = await readPool(open, outsider);
    expect(seen.statusCode).toBe(200);
    expect(seen.json().role).toBe("reader");
    expect((await writeQuestion(open, outsider, "not yours")).statusCode).toBe(403);
    expect((await renamePool(open, outsider, "not yours")).statusCode).toBe(403);

    // And it is listed, with the owner's name on it.
    const listed = await server.app.inject({
      method: "GET",
      url: "/app/api/pools",
      headers: outsider.headers,
    });
    const row = listed.json().find((p: { id: string }) => p.id === open);
    expect(row.role).toBe("reader");
    expect(row.ownerName).toBe("Test teacher");
    expect(row.memberCount).toBe(0);
  });

  it("lists every reachable pool with its role and its member count", async () => {
    const listed = await server.app.inject({
      method: "GET",
      url: "/app/api/pools",
      headers: contributor.headers,
    });
    expect(listed.statusCode).toBe(200);
    const row = listed.json().find((p: { id: string }) => p.id === shared);
    expect(row).toMatchObject({ role: "contributor", memberCount: 3, icon: "cpu" });
    expect(row.updatedAt).toBeTruthy();
  });

  it("refuses an invitation that names nobody, a student, or an existing seat", async () => {
    const unknown = await invite(shared, poolOwner, "ghost@heig.test", "reader");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe("teacher_not_found");

    const pupil = await server.signIn("student", `pupil-${crypto.randomUUID().slice(0, 8)}@heig.test`);
    const [row] = await server.app.db
      .select()
      .from(users)
      .where(eq(users.id, pupil.id));
    expect((await invite(shared, poolOwner, row!.email, "reader")).statusCode).toBe(404);

    const again = await invite(shared, poolOwner, emails.get(reader.id)!, "reader");
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_member");

    const itself = await invite(shared, poolOwner, emails.get(poolOwner.id)!, "reader");
    expect(itself.statusCode).toBe(409);
  });

  it("only lets an owner invite", async () => {
    const res = await invite(shared, contributor, emails.get(outsider.id)!, "reader");
    expect(res.statusCode).toBe(403);
    const hidden = await invite(shared, outsider, emails.get(outsider.id)!, "reader");
    expect(hidden.statusCode).toBe(404);
  });

  it("changes a role, refuses to touch the owner, and removes a seat", async () => {
    const promoted = await server.app.inject({
      method: "PATCH",
      url: `/app/api/pools/${shared}/members/${reader.id}`,
      headers: poolOwner.headers,
      payload: { role: "contributor" },
    });
    expect(promoted.statusCode).toBe(200);
    expect(
      promoted.json().members.find((m: { userId: string }) => m.userId === reader.id).role,
    ).toBe("contributor");
    expect((await writeQuestion(shared, reader, "promoted writes")).statusCode).toBe(201);

    const onOwner = await server.app.inject({
      method: "PATCH",
      url: `/app/api/pools/${shared}/members/${poolOwner.id}`,
      headers: poolOwner.headers,
      payload: { role: "reader" },
    });
    expect(onOwner.statusCode).toBe(409);
    expect(onOwner.json().error).toBe("is_owner");

    const removedOwner = await server.app.inject({
      method: "DELETE",
      url: `/app/api/pools/${shared}/members/${poolOwner.id}`,
      headers: coOwner.headers,
    });
    expect(removedOwner.statusCode).toBe(409);

    const removed = await server.app.inject({
      method: "DELETE",
      url: `/app/api/pools/${shared}/members/${reader.id}`,
      headers: poolOwner.headers,
    });
    expect(removed.statusCode).toBe(204);
    expect((await readPool(shared, reader)).statusCode).toBe(404);
  });

  it("lets a member leave on their own, and nobody else remove a colleague", async () => {
    const byContributor = await server.app.inject({
      method: "DELETE",
      url: `/app/api/pools/${shared}/members/${coOwner.id}`,
      headers: contributor.headers,
    });
    expect(byContributor.statusCode).toBe(403);

    const leaving = await server.app.inject({
      method: "DELETE",
      url: `/app/api/pools/${shared}/members/${contributor.id}`,
      headers: contributor.headers,
    });
    expect(leaving.statusCode).toBe(204);
    expect((await readPool(shared, contributor)).statusCode).toBe(404);
  });

  it("drops a notification in the invitee's inbox", async () => {
    const invited = await actor("teacher", "notified");
    expect((await invite(shared, poolOwner, emails.get(invited.id)!, "reader")).statusCode).toBe(201);

    const bell = await server.app.inject({
      method: "GET",
      url: "/app/api/notifications",
      headers: invited.headers,
    });
    expect(bell.statusCode).toBe(200);
    expect(bell.json().unread).toBe(1);
    expect(bell.json().items[0].payload).toMatchObject({
      kind: "pool_shared",
      poolId: shared,
      role: "reader",
    });

    const read = await server.app.inject({
      method: "POST",
      url: `/app/api/notifications/${bell.json().items[0].id}/read`,
      headers: invited.headers,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().unread).toBe(0);
  });
});

describe("question listing over HTTP", () => {
  let listed: string;
  let author: Actor;

  beforeAll(async () => {
    author = await server.signIn("teacher");
    const created = await server.app.inject({
      method: "POST",
      url: "/app/api/pools",
      headers: author.headers,
      payload: { name: "Sorted pool" },
    });
    listed = created.json().id;
    for (const name of ["Charlie", "alpha", "Bravo"]) {
      const res = await server.app.inject({
        method: "POST",
        url: `/app/api/pools/${listed}/questions`,
        headers: author.headers,
        payload: { type: "short", internalName: name },
      });
      expect(res.statusCode).toBe(201);
    }
  });

  it("sorts by name and pages with a cursor", async () => {
    const first = await server.app.inject({
      method: "GET",
      url: `/app/api/pools/${listed}/questions?sort=name&dir=asc&limit=2`,
      headers: author.headers,
    });
    expect(first.json().items.map((q: { internalName: string }) => q.internalName)).toEqual([
      "alpha",
      "Bravo",
    ]);
    const second = await server.app.inject({
      method: "GET",
      url: `/app/api/pools/${listed}/questions?sort=name&dir=asc&limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: author.headers,
    });
    expect(second.json().items.map((q: { internalName: string }) => q.internalName)).toEqual([
      "Charlie",
    ]);
    expect(second.json().nextCursor).toBeNull();
  });

  it("answers 400 to a cursor that belongs to another order", async () => {
    const first = await server.app.inject({
      method: "GET",
      url: `/app/api/pools/${listed}/questions?sort=name&dir=asc&limit=1`,
      headers: author.headers,
    });
    const mixed = await server.app.inject({
      method: "GET",
      url: `/app/api/pools/${listed}/questions?sort=updated&dir=desc&limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: author.headers,
    });
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json().error).toBe("invalid_cursor");
  });
});

/**
 * The order of the refusals, which `teacherRoute` and the role-carrying
 * loaders of `pool/routes.ts` must keep (audit B-02): session and role
 * (preHandler) → params (404) → the entity under `poolAccess` (404) → the
 * pool role (403) → sub-params and body (400).
 */
describe("the order of the refusals, over HTTP", () => {
  it("refuses session, params, access, role, then body", async () => {
    const reader = await server.signIn("teacher");
    const student = await server.signIn("student");
    const created = await server.app.inject({
      method: "POST",
      url: "/app/api/pools",
      headers: owner.headers,
      payload: { name: "Refusal order pool", visibility: "public" },
    });
    const open = created.json().id as string;
    const hidden = await server.app.inject({
      method: "POST",
      url: "/app/api/pools",
      headers: owner.headers,
      payload: { name: "Refusal order private pool" },
    });
    const closed = hidden.json().id as string;
    const patch = (url: string, headers: Record<string, string>, payload: unknown) =>
      server.app.inject({ method: "PATCH", url, headers, payload });
    const badBody = { name: 42 };

    expect((await patch(`/app/api/pools/x`, {}, badBody)).statusCode).toBe(401);
    expect((await patch(`/app/api/pools/x`, student.headers, badBody)).statusCode).toBe(403);
    const badParams = await patch(`/app/api/pools/x`, owner.headers, badBody);
    expect(badParams.statusCode).toBe(404);
    expect(badParams.json()).toEqual({ error: "not_found" });

    // Out of reach: the 404 of invariant 6 wins over the malformed body.
    const unreachable = await patch(`/app/api/pools/${closed}`, reader.headers, badBody);
    expect(unreachable.statusCode).toBe(404);
    expect(unreachable.json()).toEqual({ error: "not_found" });

    // Readable but not writable: the role's 403 wins over the malformed body.
    const readOnly = await patch(`/app/api/pools/${open}`, reader.headers, badBody);
    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json()).toEqual({
      error: "forbidden",
      message: "Only an owner of this pool may do that",
      role: "reader",
    });
    // …and before a sub-parameter too: a tag name too long for `TagParam`.
    const longTag = "t".repeat(65);
    const tagAsReader = await patch(`/app/api/pools/${open}/tags/${longTag}`, reader.headers, {
      description: "x",
    });
    expect(tagAsReader.statusCode).toBe(403);
    const tagAsOwner = await patch(`/app/api/pools/${open}/tags/${longTag}`, owner.headers, {
      description: "x",
    });
    expect(tagAsOwner.statusCode).toBe(400);
    expect(tagAsOwner.json().error).toBe("validation");

    const malformed = await patch(`/app/api/pools/${open}`, owner.headers, badBody);
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toBe("validation");
  });

  it("hands a multipart limit's 413 to Fastify's handler, as before the wrapper", async () => {
    const body = multipart(Buffer.alloc(5_000_001, 1), "big.png", "image/png");
    const res = await server.app.inject({
      method: "POST",
      url: `/app/api/pools/${poolId}/assets`,
      headers: { ...owner.headers, "content-type": body.contentType },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: "FST_REQ_FILE_TOO_LARGE", statusCode: 413 });
  });
});
