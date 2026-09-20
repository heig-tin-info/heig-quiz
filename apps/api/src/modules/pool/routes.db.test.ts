import { readdir } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { assets, coursePools, courseStaff, courses, pools } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { fakeRunnerType, fakeShort } from "../../test/fakeType.js";

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

    // A student has no way in until WP5 wires the attempt that shows the
    // image; a colleague does, because the store is deduplicated instance-wide.
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
