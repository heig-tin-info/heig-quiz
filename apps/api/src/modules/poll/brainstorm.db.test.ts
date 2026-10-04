/**
 * The brainstorm poll over the real application (issue #458, ADR-071): guests
 * type ideas, the room sees only what the teacher let through, and the
 * teacher merges, renames and hides on a board nobody else reads.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { and, eq } from "drizzle-orm";

import { coursePools, pools } from "../../db/schema.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { GUEST_COOKIE } from "./service.js";

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
let outsider: { id: string; headers: Record<string, string> };
let seed: Awaited<ReturnType<typeof seedLive>>;

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  outsider = await server.signIn("teacher");
  seed = await seedLive(server.app.db, { teacherId: teacher.id, questions: 0, studentIds: [] });
});
afterAll(async () => {
  await server.close();
});

const get = (url: string, headers: Record<string, string> = {}) => server.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string> = {}, payload?: Payload) =>
  server.app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload }) });

const CONFIG = { configVersion: 1, prompt: "Qu'est-ce qui caractérise un être vivant ?", maxIdeas: 3 };

let evaluationId: string;
let questionId: string;
let code: string;

/** A guest joins and sends `ideas`; returns its cookie. */
async function guestSays(ideas: string[]): Promise<string> {
  const joined = await post(`/app/api/p/${code}/join`);
  const cookie = /quiz_guest=([^;]+)/.exec(String(joined.headers["set-cookie"]))![1]!;
  const answered = await post(`/app/api/p/${code}/answer`, { cookie: `${GUEST_COOKIE}=${cookie}` }, { payload: { ideas } });
  expect(answered.statusCode).toBe(200);
  return cookie;
}

const board = async () => (await get(`/app/api/evaluations/${evaluationId}/poll/ideas`, teacher.headers)).json();
const act = (body: unknown) => post(`/app/api/evaluations/${evaluationId}/poll/ideas`, teacher.headers, body as Payload);
const wall = async () => (await get(`/app/api/evaluations/${evaluationId}/poll`, teacher.headers)).json().tally;

describe("a brainstorm poll", () => {
  it("starts anonymous with moderation on", async () => {
    const created = await post("/app/api/polls/inline", teacher.headers, {
      audience: { kind: "anonymous" },
      type: "brainstorm",
      config: CONFIG,
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    evaluationId = body.evaluation.id;
    questionId = body.question.id;
    code = body.evaluation.code;
    expect(body.settings).toMatchObject({ anonymous: true, moderation: true, revealed: false });
    expect(body.question.solution).toBeNull();
  });

  it("refuses more ideas than the question allows", async () => {
    const joined = await post(`/app/api/p/${code}/join`);
    const cookie = /quiz_guest=([^;]+)/.exec(String(joined.headers["set-cookie"]))![1]!;
    const refused = await post(
      `/app/api/p/${code}/answer`,
      { cookie: `${GUEST_COOKIE}=${cookie}` },
      { payload: { ideas: ["a", "b", "c", "d"] } },
    );
    expect(refused.statusCode).toBe(422);
  });

  it("projects nothing before the teacher approves, and counts what waits", async () => {
    await guestSays(["Il respire", "grandit"]);
    await guestSays(["la respiration", "Grandit !"]);
    await guestSays(["gros mot"]);
    const tally = await wall();
    const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);
    expect([...tally.ideas].sort(byKey)).toEqual([]);
    expect(tally.pending).toBe(4);
    expect(tally.answered).toBe(3);

    const view = await post(`/app/api/evaluations/${evaluationId}/poll/reveal`, teacher.headers, { votes: true });
    expect(view.statusCode).toBe(200);
    const phone = (await get(`/app/api/p/${code}`)).json();
    expect(phone.tally.ideas).toEqual([]);
    expect(phone.tally.pending).toBe(0);
  });

  it("merges, renames, approves and hides on the board", async () => {
    const before = await board();
    expect(before.clusters.map((c: { key: string }) => c.key).sort()).toEqual([
      "grandit",
      "gros mot",
      "il respire",
      "respiration",
    ]);

    expect((await act({ action: "merge", keys: ["respiration"], into: "il respire" })).statusCode).toBe(200);
    expect((await act({ action: "rename", key: "respiration", label: "Respiration" })).statusCode).toBe(200);
    expect((await act({ action: "approve", keys: ["il respire", "respiration", "grandit"] })).statusCode).toBe(200);
    const hidden = await act({ action: "hide", keys: ["gros mot"] });
    expect(hidden.json()).toMatchObject({ moderation: true, pending: 0, answered: 3 });

    const tally = await wall();
    const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);
    expect([...tally.ideas].sort(byKey)).toEqual([
      { key: "grandit", label: "grandit", count: 2 },
      { key: "il respire", label: "Respiration", count: 2 },
    ]);
    const phone = JSON.stringify((await get(`/app/api/p/${code}`)).json());
    expect(phone).not.toContain("gros mot");
  });

  it("projects every idea not hidden once moderation is off", async () => {
    await guestSays(["cellules"]);
    expect((await wall()).ideas.map((b: { label: string }) => b.label)).not.toContain("cellules");
    const off = await post(`/app/api/evaluations/${evaluationId}/poll/reveal`, teacher.headers, { moderation: false });
    expect(off.json().settings.moderation).toBe(false);
    const labels = (await wall()).ideas.map((b: { label: string }) => b.label);
    expect(labels).toContain("cellules");
    expect(labels).not.toContain("gros mot");
  });

  it("never names a hidden or unmoderated idea, even as the head of a merged cluster", async () => {
    await post(`/app/api/evaluations/${evaluationId}/poll/reveal`, teacher.headers, { moderation: true });
    await guestSays(["Zut alors"]);
    await guestSays(["photosynthèse"]);
    await act({ action: "approve", keys: ["photosynthese"] });
    // Merged INTO the unmoderated idea: the head is a text the room has not been shown.
    await act({ action: "merge", keys: ["photosynthese"], into: "zut alors" });
    const leaks = async () => {
      const phone = JSON.stringify((await get(`/app/api/p/${code}`)).json());
      const tally = JSON.stringify(await wall());
      return [phone, tally].filter((out) => /zut/i.test(out));
    };
    expect(JSON.stringify(await wall())).toContain("photosynth");
    expect(await leaks()).toEqual([]);

    // Hidden head, and nobody moderating: still never named.
    await act({ action: "hide", keys: ["zut alors"] });
    await post(`/app/api/evaluations/${evaluationId}/poll/reveal`, teacher.headers, { moderation: false });
    expect(await leaks()).toEqual([]);
  });

  it("keeps the board to the poll's staff", async () => {
    expect((await get(`/app/api/evaluations/${evaluationId}/poll/ideas`, outsider.headers)).statusCode).toBe(404);
    const refused = await post(`/app/api/evaluations/${evaluationId}/poll/ideas`, outsider.headers, {
      action: "hide",
      keys: ["grandit"],
    });
    expect(refused.statusCode).toBe(404);
  });

  it("refuses moderation and the board on another type", async () => {
    const short = await post("/app/api/polls/inline", teacher.headers, {
      audience: { kind: "anonymous" },
      type: "short",
      config: { configVersion: 3, prompt: "Un mot ?", matchers: [] },
    });
    const id = short.json().evaluation.id as string;
    expect(short.json().settings.moderation).toBe(false);
    const refused = await post(`/app/api/evaluations/${id}/poll/reveal`, teacher.headers, { moderation: true });
    expect(refused.json().error).toBe("poll_type");
    expect((await get(`/app/api/evaluations/${id}/poll/ideas`, teacher.headers)).json().error).toBe("poll_type");
  });

  it("is a poll's alone: an evaluation refuses it as keyless", async () => {
    expect((await post(`/app/api/evaluations/${evaluationId}/poll/keep`, teacher.headers)).statusCode).toBe(200);
    const [personal] = await server.app.db
      .select()
      .from(pools)
      .where(and(eq(pools.ownerId, teacher.id), eq(pools.isPersonal, true)));
    await server.app.db.insert(coursePools).values({ courseId: seed.courseId, poolId: personal!.id });
    const evaluation = await post(`/app/api/classrooms/${seed.classroomId}/evaluations`, teacher.headers, {
      title: "Exam",
    });
    const refused = await post(`/app/api/evaluations/${evaluation.json().id as string}/items`, teacher.headers, {
      questionIds: [questionId],
    });
    expect(refused.json().error).toBe("question_keyless");
  });
});
