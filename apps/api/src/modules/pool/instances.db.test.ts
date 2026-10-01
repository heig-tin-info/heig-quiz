/**
 * `POST /questions/:id/draft/instances` (ADR-056 §8): the editor's preview
 * of five instances of a parameterized draft, drawn on the server as
 * publication draws the ones it gates. Loaded like every draft route
 * (invariant 6): the pool's people reach it, anyone else gets the 404 of a
 * missing question, and a student never reaches a teacher route. Each
 * instance's student view carries nothing of the template (invariant 4).
 * The pool list's `randomizable` follows publication (the pill).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DraftInstances, ParametersDraft, QuestionPage } from "@quiz/contracts";
import { draw, formatValue } from "@quiz/domain/parameters";

import { testServer, type TestServer } from "../../test/http.js";
import { EXPLANATION, markersIn, PARAMETERIZED, VARIABLES } from "../../test/parameterized.js";
import { parametersOf } from "./instance.js";

let server: TestServer;
let owner: Awaited<ReturnType<TestServer["signIn"]>>;
let stranger: Awaited<ReturnType<TestServer["signIn"]>>;
let poolId: string;

beforeAll(async () => {
  server = await testServer();
  owner = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
  const pool = await server.app.inject({
    method: "POST",
    url: "/app/api/pools",
    headers: owner.headers,
    payload: { name: "Parameterized" },
  });
  poolId = pool.json().id;
});

afterAll(async () => {
  await server.close();
});

/** A question of `type` whose draft holds `config`, `variables` and the fall's explanation. */
async function draft(type: string, config: unknown, variables: ParametersDraft | null): Promise<string> {
  const created = await server.app.inject({
    method: "POST",
    url: `/app/api/pools/${poolId}/questions`,
    headers: owner.headers,
    payload: { type, internalName: `q-${crypto.randomUUID().slice(0, 8)}` },
  });
  const id = created.json().meta.id as string;
  const saved = await server.app.inject({
    method: "PUT",
    url: `/app/api/questions/${id}/draft`,
    headers: owner.headers,
    payload: { config, explanation: EXPLANATION, variables },
  });
  expect(saved.statusCode).toBe(200);
  return id;
}

const instances = (id: string, headers: Record<string, string>) =>
  server.app.inject({ method: "POST", url: `/app/api/questions/${id}/draft/instances`, headers });

describe("the five instances of a draft", () => {
  it("draws seeds 0 to 4 as publication does, with formatted values and a clean student view", async () => {
    for (const type of ["mcq", "short", "cloze"] as const) {
      const id = await draft(type, PARAMETERIZED[type], VARIABLES);
      const res = await instances(id, owner.headers);
      expect(res.statusCode).toBe(200);
      const body = res.json<DraftInstances>();
      expect(body.issues).toEqual([]);
      expect(body.instances.map((i) => i.seed)).toEqual([0, 1, 2, 3, 4]);
      const params = parametersOf({ variables: VARIABLES })!;
      for (const instance of body.instances) {
        const { values } = draw(params, instance.seed);
        expect(instance.values.map((v) => v.name)).toEqual(["h", "g", "t"]);
        if (type !== "mcq") {
          // mcq redraws a run whose choices read alike; the others take the first.
          expect(instance.values[2]!.value).toBe(formatValue(values["t"]!, ".2"));
        }
        expect(markersIn(JSON.stringify(instance.student))).toEqual([]);
        expect(instance.explanation).toBe(`The fall lasts ${instance.values[2]!.value} s.`);
        expect(JSON.stringify(instance.solution)).not.toContain("[[");
      }
    }
  });

  it("answers with the draft's issues when it would not publish", async () => {
    const id = await draft("mcq", PARAMETERIZED.mcq, { rows: [{ name: "h", expr: "2pi", format: "" }] });
    const body = (await instances(id, owner.headers)).json<DraftInstances>();
    expect(body.instances).toEqual([]);
    expect(body.issues.map((i) => i.message)).toContain("parameters.forbidden_node");
  });

  it("refuses a short tolerance below half the step of its key's format (ADR-056 §6)", async () => {
    const config = {
      configVersion: 3,
      prompt: "Fall from [[h]] m at g = [[g]]: how long?",
      kind: "number",
      matchers: [{ kind: "number", value: "[[t]]", tolerance: 0.001 }],
    };
    const id = await draft("short", config, VARIABLES);
    const body = (await instances(id, owner.headers)).json<DraftInstances>();
    expect(body.issues).toEqual([
      { path: ["matchers", "0", "tolerance"], code: "custom", message: "short.tolerance_below_format" },
    ]);
    const published = await server.app.inject({
      method: "POST",
      url: `/app/api/questions/${id}/publish`,
      headers: owner.headers,
      payload: {},
    });
    expect(published.statusCode).toBe(422);
  });

  it("is empty for a static draft", async () => {
    const id = await draft("short", { configVersion: 3, prompt: "2+2?", matchers: [{ kind: "exact", value: "4" }] }, null);
    expect((await instances(id, owner.headers)).json()).toEqual({ instances: [], issues: [] });
  });

  it("is a 404 for a teacher outside the pool, and never a student's (invariant 6)", async () => {
    const id = await draft("mcq", PARAMETERIZED.mcq, VARIABLES);
    expect((await instances(id, stranger.headers)).statusCode).toBe(404);
    expect((await instances(crypto.randomUUID(), owner.headers)).statusCode).toBe(404);
    const student = await server.signIn("student");
    expect((await instances(id, student.headers)).statusCode).toBe(403);
  });
});

describe("the pool list", () => {
  it("says a question is parameterized once a version with variables is published", async () => {
    const id = await draft("cloze", PARAMETERIZED.cloze, VARIABLES);
    const row = async () => {
      const page = await server.app.inject({
        method: "GET",
        url: `/app/api/pools/${poolId}/questions?limit=200`,
        headers: owner.headers,
      });
      return page.json<QuestionPage>().items.find((q) => q.id === id)!;
    };
    expect((await row()).randomizable).toBe(false);
    const published = await server.app.inject({
      method: "POST",
      url: `/app/api/questions/${id}/publish`,
      headers: owner.headers,
      payload: {},
    });
    expect(published.statusCode).toBe(201);
    expect((await row()).randomizable).toBe(true);
  });
});
