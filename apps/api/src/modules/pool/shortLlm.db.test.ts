/**
 * The REAL `short` type through the pool routes: an `llm` matcher (phase 2)
 * survives a draft, and publication refuses it (ADR-037).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { testServer, type TestServer } from "../../test/http.js";

let server: TestServer;
let owner: Awaited<ReturnType<TestServer["signIn"]>>;

beforeAll(async () => {
  server = await testServer();
  owner = await server.signIn("teacher");
});

afterAll(async () => {
  await server.close();
});

describe("short: an llm matcher is refused at publication", () => {
  it("saves the draft and refuses to publish it with short.llm_not_available", async () => {
    const inject = (method: "POST" | "PUT", url: string, payload: unknown) =>
      server.app.inject({ method, url, headers: owner.headers, payload: payload as object });
    const pool = await inject("POST", "/app/api/pools", { name: "Short answers" });
    const created = await inject("POST", `/app/api/pools/${pool.json().id}/questions`, {
      type: "short",
      internalName: "with an llm matcher",
    });
    const id = created.json().meta.id as string;
    const saved = await inject("PUT", `/app/api/questions/${id}/draft`, {
      config: {
        configVersion: 2,
        prompt: "Who wrote the three laws of motion?",
        kind: "text",
        matchers: [{ kind: "llm", rubric: "Names Isaac Newton" }],
      },
      explanation: "",
    });
    expect(saved.statusCode).toBe(200);

    const refused = await inject("POST", `/app/api/questions/${id}/publish`, {});
    expect(refused.statusCode).toBe(422);
    expect(refused.json().details[0].message).toBe("short.llm_not_available");
  });
});
