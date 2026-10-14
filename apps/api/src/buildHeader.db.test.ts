import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BUILD_HEADER } from "@quiz/contracts";

import { testServer, type TestServer } from "./test/http.js";

// ADR-110: a signed-in tab learns the build the API runs; the signed-out
// side is in app.test.ts (audit L21).
describe("the build header", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await testServer({ COMMIT_SHA: "c0ffee" });
  });
  afterAll(() => server.close());

  it("names the commit on a signed-in caller's API answers, success or refusal", async () => {
    const { headers } = await server.signIn("student");
    for (const url of ["/app/api/me", "/app/api/nope"]) {
      const res = await server.app.inject({ method: "GET", url, headers });
      expect(res.headers[BUILD_HEADER], url).toBe("c0ffee");
    }
  });

  it("is absent without a commit", async () => {
    const bare = await testServer();
    try {
      const { headers } = await bare.signIn("student");
      const res = await bare.app.inject({ method: "GET", url: "/app/api/me", headers });
      expect(res.headers[BUILD_HEADER]).toBeUndefined();
    } finally {
      await bare.close();
    }
  });
});
