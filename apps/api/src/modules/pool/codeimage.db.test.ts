/**
 * The REAL `codeimage` type through the pool routes (ADR-021, decision D16).
 *
 * The target is what "Try the reference solution" captures, so `/try` and
 * `/preview` must accept a draft whose target is missing, or stale after a
 * resize — only publication refuses one. The runner is a stub that prints a
 * fixed picture; nothing here needs a container.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { RunnerOutcome, RunnerRequest } from "@quiz/core/server";

import { testServer, type TestServer } from "../../test/http.js";

let server: TestServer;
let owner: Awaited<ReturnType<TestServer["signIn"]>>;
let poolId: string;
let defaultRunner: unknown;
const requests: RunnerRequest[] = [];

/** A 4 × 3 checkerboard, as the reference solution prints it. */
const STDOUT = "1 0 1 0\n0 1 0 1\n1 0 1 0\n";
const CHECKER = "101001011010";

const OUTCOME: RunnerOutcome = {
  compile: { ok: true, stdout: "", stderr: "", ms: 1 },
  cases: [
    { exitCode: 0, stdout: STDOUT, stderr: "", ms: 2, timedOut: false, oom: false, truncated: false },
  ],
};

const TEMPLATE =
  "// @@lock\n#include <stdio.h>\nint main(void) {\n// @@endlock\n    puts(\"1\");\n// @@lock\n    return 0;\n}\n// @@endlock\n";

const BW43 = { width: 4, height: 3, palette: "bw" };

/** `target` null = none yet; otherwise the pixels, captured under `captured` (4 × 3 by default). */
function config(
  target: string | null,
  image = BW43,
  captured: { width: number; height: number; palette: string } = BW43,
) {
  return {
    configVersion: 1,
    prompt: "Draw a checkerboard.",
    language: "c",
    template: TEMPLATE,
    referenceSolution: "    puts(\"1 0 1 0\");\n",
    image,
    target: target === null ? null : { ...captured, pixels: target },
  };
}

async function draftQuestion(name: string, cfg: unknown): Promise<string> {
  const created = await server.app.inject({
    method: "POST",
    url: `/app/api/pools/${poolId}/questions`,
    headers: owner.headers,
    payload: { type: "codeimage", internalName: name },
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
  return id;
}

async function tryReference(id: string) {
  return server.app.inject({
    method: "POST",
    url: `/app/api/questions/${id}/try`,
    headers: owner.headers,
    payload: { source: "draft", answer: { regions: ["    puts(\"1 0 1 0\");\n"] } },
  });
}

beforeAll(async () => {
  server = await testServer();
  owner = await server.signIn("teacher");
  const created = await server.app.inject({
    method: "POST",
    url: "/app/api/pools",
    headers: owner.headers,
    payload: { name: "Images" },
  });
  poolId = created.json().id;
  defaultRunner = (server.app as unknown as { runner: unknown }).runner;
  (server.app as unknown as { runner: unknown }).runner = {
    run: async (request: RunnerRequest) => {
      requests.push(request);
      return OUTCOME;
    },
    health: async () => ({ ok: true, languages: ["c"], queued: 0, avgMs: 1 }),
  };
});

beforeEach(() => {
  requests.length = 0;
});

afterAll(async () => {
  (server.app as unknown as { runner: unknown }).runner = defaultRunner;
  await server.close();
});

describe("codeimage: the target is required to publish, never to try (D16)", () => {
  it("tries a draft with an EMPTY target and hands back the picture to capture", async () => {
    const id = await draftQuestion("no target yet", config(null));
    const res = await tryReference(id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("graded");
    expect(body.details.image).toBe(CHECKER);
    expect(body.details.matching).toBe(0);
    expect(body.points).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.cases).toEqual([{ name: "image", args: [], stdin: "" }]);
  });

  it("tries a draft whose target is STALE after a resize, reading it as no target", async () => {
    // A 4 × 3 target left behind when the image became 5 × 3.
    const id = await draftQuestion(
      "resized",
      config(CHECKER, { width: 5, height: 3, palette: "bw" }),
    );
    const res = await tryReference(id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("graded");
    expect(body.details.image).toHaveLength(15);
    expect(body.details.matching).toBe(0);
  });

  it("previews a draft without a target", async () => {
    const id = await draftQuestion("preview without target", config(null));
    const res = await server.app.inject({
      method: "POST",
      url: `/app/api/questions/${id}/preview`,
      headers: owner.headers,
      payload: { source: "draft" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().student.target).toBeNull();
    expect(JSON.stringify(res.json().student)).not.toContain("referenceSolution");
  });

  it("reports the missing target with the draft, and refuses to publish it", async () => {
    const id = await draftQuestion("unpublishable empty", config(null));
    const detail = await server.app.inject({
      method: "GET",
      url: `/app/api/questions/${id}`,
      headers: owner.headers,
    });
    expect(detail.json().draft.valid).toBe(false);
    const saved = await server.app.inject({
      method: "PUT",
      url: `/app/api/questions/${id}/draft`,
      headers: owner.headers,
      payload: { config: config(null), explanation: "" },
    });
    expect(saved.json().valid).toBe(false);
    expect(saved.json().issues).toEqual([
      { path: ["target"], code: "custom", message: "codeimage.target_missing" },
    ]);

    const refused = await server.app.inject({
      method: "POST",
      url: `/app/api/questions/${id}/publish`,
      headers: owner.headers,
      payload: {},
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe("config_invalid");
    expect(refused.json().details[0].message).toBe("codeimage.target_missing");
  });

  it("refuses to publish a stale target", async () => {
    const id = await draftQuestion(
      "unpublishable stale",
      config(CHECKER, { width: 5, height: 3, palette: "bw" }),
    );
    const refused = await server.app.inject({
      method: "POST",
      url: `/app/api/questions/${id}/publish`,
      headers: owner.headers,
      payload: {},
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().details[0].message).toBe("codeimage.target_size");
  });

  it("refuses a 4 × 3 target on a 3 × 4 image, and grades it as no target", async () => {
    // Twelve pixels either way: only the dimensions stored with the target
    // say it was captured for another shape.
    const id = await draftQuestion(
      "turned image",
      config(CHECKER, { width: 3, height: 4, palette: "bw" }),
    );
    const refused = await server.app.inject({
      method: "POST",
      url: `/app/api/questions/${id}/publish`,
      headers: owner.headers,
      payload: {},
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().details[0].message).toBe("codeimage.target_size");
    const res = await tryReference(id);
    expect(res.json()).toMatchObject({ status: "graded", points: 0, details: { matching: 0 } });
  });

  it("publishes once the captured target fits, and grades against it", async () => {
    const id = await draftQuestion("publishable image", config(CHECKER));
    const published = await server.app.inject({
      method: "POST",
      url: `/app/api/questions/${id}/publish`,
      headers: owner.headers,
      payload: {},
    });
    expect(published.statusCode).toBe(201);
    const res = await tryReference(id);
    expect(res.json()).toMatchObject({ status: "graded", points: 1, details: { matching: 12 } });
  });
});
