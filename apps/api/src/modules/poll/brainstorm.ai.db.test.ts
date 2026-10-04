/**
 * A brainstorm's AI assistance over the real application (ADR-072), with the
 * gateway's call replaced by a scripted model: what it is sent, what its
 * verdicts do to the wall, that it fails closed, and that the teacher keeps
 * the last word.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { CompleteRequest, Completion } from "../llm/service.js";
import { LlmError } from "../llm/service.js";
import { eq } from "drizzle-orm";

import { pollAiRuns, users } from "../../db/schema.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";
import { AI_RUN_CALL_CAP } from "./ai.js";
import { GUEST_COOKIE } from "./service.js";

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
const prompts: string[] = [];
let failing: LlmError | null = null;

/**
 * The scripted model: offensive when it says "idiot", the correction capitalised
 * ("respir…" reads "Respiration"), and the same as an earlier idea of the same
 * correction.
 */
async function model<T>(req: CompleteRequest<T>): Promise<Completion<T>> {
  prompts.push(req.prompt);
  if (failing) throw failing;
  const section = (name: string) =>
    JSON.parse(/^.*?: (\[.*\])$/m.exec(req.prompt.split("\n\n").find((p) => p.startsWith(name))!)![1]!) as {
      id: string;
      text: string;
    }[];
  const correct = (text: string) =>
    /respir/i.test(text) ? "Respiration" : text.charAt(0).toUpperCase() + text.slice(1);
  const seen = new Map(section("Ideas on the wall").map((e) => [e.text, e.id]));
  // A flaky model: it leaves out every idea that says "oubli".
  const ideas = section("NEW ideas").filter((idea) => !/oubli/i.test(idea.text)).map((idea) => {
    const correction = correct(idea.text);
    const sameAs = seen.get(correction) ?? null;
    if (!seen.has(correction)) seen.set(correction, idea.id);
    return { id: idea.id, offensive: /idiot/i.test(idea.text), correction, sameAs };
  });
  return { value: { ideas } as T, model: "claude-haiku-4-5", durationMs: 1 };
}

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  vi.spyOn(server.app.llmGateway, "complete").mockImplementation(model);
});
afterAll(async () => {
  await server.close();
});

const get = (url: string, headers: Record<string, string> = {}) => server.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string> = {}, payload?: Payload) =>
  server.app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload }) });

let evaluationId: string;
let code: string;

async function guestSays(ideas: string[]): Promise<void> {
  const joined = await post(`/app/api/p/${code}/join`);
  const cookie = /quiz_guest=([^;]+)/.exec(String(joined.headers["set-cookie"]))![1]!;
  const answered = await post(`/app/api/p/${code}/answer`, { cookie: `${GUEST_COOKIE}=${cookie}` }, { payload: { ideas } });
  expect(answered.statusCode).toBe(200);
}

const wall = async () => (await get(`/app/api/evaluations/${evaluationId}/poll`, teacher.headers)).json().tally;
const board = async () => (await get(`/app/api/evaluations/${evaluationId}/poll/ideas`, teacher.headers)).json();
const display = (body: unknown) => post(`/app/api/evaluations/${evaluationId}/poll/reveal`, teacher.headers, body as Payload);

describe("a brainstorm's AI assistance", () => {
  it("starts off, and cannot be turned on without a model", async () => {
    const created = await post("/app/api/polls/inline", teacher.headers, {
      audience: { kind: "anonymous" },
      type: "brainstorm",
      config: { configVersion: 1, prompt: "Qu'est-ce qui caractérise un être vivant ?", maxIdeas: 3 },
    });
    evaluationId = created.json().evaluation.id;
    code = created.json().evaluation.code;
    expect(created.json().settings).toMatchObject({ moderation: true, ai: false });
    expect((await board()).ai).toEqual({ available: false, on: false, error: null });

    const refused = await display({ ai: true });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe("llm_unavailable");
  });

  it("judges each new idea: approved and corrected, hidden when offensive, joined to its twin", async () => {
    vi.spyOn(server.app.llmGateway, "ready").mockResolvedValue(true);
    expect((await display({ ai: true, votes: true })).json().settings.ai).toBe(true);
    expect((await get(`/app/api/p/${code}`)).json().settings.ai).toBe(true);

    await guestSays(["il respir", "idiot de prof"]);
    await guestSays(["la respiration", "grandit"]);

    expect(await wall()).toMatchObject({
      pending: 0,
      ideas: expect.arrayContaining([
        { key: "il respir", label: "Respiration", count: 2 },
        { key: "grandit", label: "Grandit", count: 1 },
      ]),
    });
    const phone = JSON.stringify((await get(`/app/api/p/${code}`)).json());
    expect(phone).not.toMatch(/idiot/i);

    const ideas = (await board()).clusters.flatMap((c: { variants: unknown[] }) => c.variants);
    expect(ideas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "idiot de prof", status: "hidden", ai: true }),
        // What was typed stays, beside the correction.
        expect.objectContaining({ text: "il respir", correction: "Respiration", status: "approved", ai: true }),
      ]),
    );
  });

  it("sends the model the texts under throwaway ids, nothing that names the poll or a participant", () => {
    const sent = prompts.join("\n");
    expect(sent).toContain('"id":"n1"');
    expect(sent).not.toContain(evaluationId);
    expect(sent).not.toMatch(/"key"/);
  });

  it("never overrides the teacher: a teacher's mark stays, and an undone hide is the teacher's", async () => {
    await post(`/app/api/evaluations/${evaluationId}/poll/ideas`, teacher.headers, {
      action: "approve",
      keys: ["idiot de prof"],
    });
    await guestSays(["idiot de prof"]);
    const variant = (await board()).clusters
      .flatMap((c: { variants: { key: string }[] }) => c.variants)
      .find((v: { key: string }) => v.key === "idiot de prof");
    expect(variant).toMatchObject({ status: "approved", ai: false });
  });

  it("fails closed: a failed call leaves the new ideas waiting for the teacher, and says why", async () => {
    failing = new LlmError("budget_exhausted");
    server.clock.advance(60_000);
    await guestSays(["photosynthèse"]);
    const tally = await wall();
    expect(tally.pending).toBe(1);
    expect(JSON.stringify(tally.ideas)).not.toContain("photosynth");
    expect((await board()).ai).toMatchObject({ on: true, error: "budget_exhausted" });

    // The next answer past the cooldown tries again; a success clears the failure.
    failing = null;
    server.clock.advance(60_000);
    await guestSays(["cellules"]);
    const after = await board();
    expect(after.ai.error).toBeNull();
    expect(after.pending).toBe(0);
  });

  it("masks the name of a person the poll knows before it leaves", async () => {
    server.clock.advance(60_000);
    const student = await server.signIn("student");
    await server.app.db.update(users).set({ givenName: "Zorglub", familyName: "Marchand" }).where(eq(users.id, student.id));
    await post(`/app/api/p/${code}/join`, student.headers);
    const before = prompts.length;
    await post(`/app/api/p/${code}/answer`, student.headers, { payload: { ideas: ["Zorglub Marchand respire"] } });
    const sent = prompts.slice(before).join("\n");
    expect(sent).toContain("respire");
    expect(sent).not.toMatch(/Zorglub|Marchand/);
  });

  it("sends an idea the model left out once per pass, then leaves it waiting", async () => {
    server.clock.advance(60_000);
    const before = prompts.length;
    await guestSays(["idée oubliée"]);
    expect(prompts.length - before).toBe(1);
    expect((await board()).pending).toBe(1);
  });

  it("makes no call while another pass holds the lease, nor past the run's limit", async () => {
    server.clock.advance(60_000);
    const runs = (patch: Partial<typeof pollAiRuns.$inferInsert>) =>
      server.app.db.update(pollAiRuns).set(patch).where(eq(pollAiRuns.evaluationId, evaluationId));
    await runs({ leaseAt: server.clock.now(), updatedAt: server.clock.now() });
    let before = prompts.length;
    await guestSays(["mitose"]);
    expect(prompts.length).toBe(before);

    await runs({ leaseAt: null, calls: AI_RUN_CALL_CAP });
    server.clock.advance(60_000);
    before = prompts.length;
    await guestSays(["méiose"]);
    expect(prompts.length).toBe(before);
    expect((await board()).ai.error).toBe("run_cap");
  });

  it("stops when the teacher turns it off, and starts a fresh run when turned on again", async () => {
    expect((await display({ ai: false })).json().settings.ai).toBe(false);
    const before = prompts.length;
    server.clock.advance(60_000);
    await guestSays(["métabolisme"]);
    expect(prompts.length).toBe(before);
    expect((await get(`/app/api/p/${code}`)).json().settings.ai).toBe(false);

    // On again: a fresh run, never retroactive — what was typed without the
    // notice stays with the teacher, and only what comes next leaves.
    await display({ ai: true });
    expect(prompts.length).toBe(before);
    expect((await board()).ai.error).toBeNull();
    const waiting = (await board()).clusters
      .flatMap((c: { variants: { key: string }[] }) => c.variants)
      .find((v: { key: string }) => v.key === "metabolisme");
    expect(waiting).toMatchObject({ status: "pending", ai: false });

    server.clock.advance(60_000);
    await guestSays(["homéostasie"]);
    expect(prompts.length).toBe(before + 1);
    expect(prompts.at(-1)).not.toContain("métabolisme");
  });
});
