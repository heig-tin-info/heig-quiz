/**
 * A template deleted between the route's loader and its write (`TemplateGone`)
 * is answered exactly like the loader's own 404 — the bare
 * `{ error: "not_found" }`, no `message` — so the two cannot be told apart
 * (invariant 6). The race is forced by making `editTemplate` throw.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EvaluationTemplate } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { testServer, type TestServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { seedLive } from "../../test/live.js";

vi.mock("./templates.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./templates.js")>();
  return {
    ...original,
    editTemplate: async () => {
      throw new original.TemplateGone();
    },
  };
});

let server: TestServer;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
});
afterAll(async () => {
  await server.close();
  restore();
});

describe("a template gone under a write, over HTTP", () => {
  it("answers the bare 404 of a missing template", async () => {
    const teacher = await server.signIn("teacher");
    const seed = await seedLive(server.app.db, { teacherId: teacher.id });
    const saved = await server.app.inject({
      method: "POST",
      url: `/app/api/evaluations/${seed.evaluationId}/template`,
      headers: teacher.headers,
      payload: { title: "Exam template" },
    });
    expect(saved.statusCode).toBe(201);
    const id = EvaluationTemplate.parse(saved.json()).id;

    const gone = await server.app.inject({
      method: "PATCH",
      url: `/app/api/templates/${id}`,
      headers: teacher.headers,
      payload: { title: "Too late" },
    });
    const missing = await server.app.inject({
      method: "PATCH",
      url: "/app/api/templates/00000000-0000-4000-8000-00000000beef",
      headers: teacher.headers,
      payload: { title: "Too late" },
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toEqual({ error: "not_found" });
    expect(gone.body).toBe(missing.body);
  });
});
