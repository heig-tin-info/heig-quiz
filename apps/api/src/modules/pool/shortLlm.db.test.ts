/**
 * The REAL `short` type through the pool routes: an `llm` matcher (phase 2)
 * survives a draft, and publication refuses it (ADR-037). Its rubric would
 * otherwise read as an "expected answer" on the teacher's surfaces, the
 * correction projection included.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { testServer, type TestServer } from "../../test/http.js";

let server: TestServer;
let owner: Awaited<ReturnType<TestServer["signIn"]>>;
let poolId: string;

const config = (matchers: unknown[]) => ({
  configVersion: 2,
  prompt: "Who wrote the three laws of motion?",
  kind: "text",
  matchers,
});

async function draftQuestion(name: string, cfg: unknown) {
  const created = await server.app.inject({
    method: "POST",
    url: `/app/api/pools/${poolId}/questions`,
    headers: owner.headers,
    payload: { type: "short", internalName: name },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().meta.id as string;
  const saved = await server.app.inject({
    method: "PUT",
    url: `/app/api/questions/${id}/draft`,
    headers: owner.headers,
    payload: { config: cfg, explanation: "" },
  });
  expect(saved.statusCode).toBe(200);
  return { id, saved: saved.json() as { valid: boolean; issues: unknown[] } };
}

const publish = (id: string) =>
  server.app.inject({
    method: "POST",
    url: `/app/api/questions/${id}/publish`,
    headers: owner.headers,
    payload: {},
  });

beforeAll(async () => {
  server = await testServer();
  owner = await server.signIn("teacher");
  const created = await server.app.inject({
    method: "POST",
    url: "/app/api/pools",
    headers: owner.headers,
    payload: { name: "Short answers" },
  });
  poolId = created.json().id;
});

afterAll(async () => {
  await server.close();
});

describe("short: an llm matcher is refused at publication", () => {
  it("keeps the draft, reports the matcher and refuses to publish it", async () => {
    const { id, saved } = await draftQuestion(
      "with an llm matcher",
      config([
        { kind: "exact", value: "Newton" },
        { kind: "llm", rubric: "Names Isaac Newton" },
      ]),
    );
    expect(saved.valid).toBe(false);
    expect(saved.issues).toEqual([
      {
        path: ["matchers", "1"],
        code: "custom",
        message: "short.llm_not_available",
      },
    ]);

    const refused = await publish(id);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe("config_invalid");
    expect(refused.json().details[0].message).toBe("short.llm_not_available");
  });

  it("publishes the same question without it", async () => {
    const { id, saved } = await draftQuestion(
      "without an llm matcher",
      config([{ kind: "exact", value: "Newton" }]),
    );
    expect(saved.valid).toBe(true);
    expect((await publish(id)).statusCode).toBe(201);
  });
});
