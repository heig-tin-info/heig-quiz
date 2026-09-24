/**
 * The coach marks over the REAL application: shown by default, turned off
 * by a preference, and the set of those read merged rather than replaced.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Me } from "@quiz/contracts";

import { testServer, type TestServer } from "../test/http.js";

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
});
afterAll(() => server.close());

const me = async () =>
  (await server.app.inject({ method: "GET", url: "/app/api/me", headers: teacher.headers })).json() as Me;

const seen = (payload: object) =>
  server.app.inject({ method: "POST", url: "/app/api/me/coach", headers: teacher.headers, payload });

describe("coach marks", () => {
  it("start on, with nothing read", async () => {
    expect((await me()).coach).toEqual({ enabled: null, seen: [] });
  });

  it("merge what each report adds, without duplicates", async () => {
    expect((await seen({ seen: ["pool.new-question", "home.courses"] })).statusCode).toBe(200);
    const res = await seen({ seen: ["home.courses", "shell.palette"] });
    expect(res.json()).toEqual({ seen: ["home.courses", "pool.new-question", "shell.palette"] });
    expect((await me()).coach.seen).toEqual(["home.courses", "pool.new-question", "shell.palette"]);
  });

  it("forget everything on reset", async () => {
    expect((await seen({ reset: true })).json()).toEqual({ seen: [] });
    expect((await me()).coach.seen).toEqual([]);
  });

  it("are turned off by a preference", async () => {
    const res = await server.app.inject({
      method: "PATCH",
      url: "/app/api/me",
      headers: teacher.headers,
      payload: { coachEnabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect((await me()).coach.enabled).toBe(false);
  });

  it("refuse an id that is not one, and an empty report", async () => {
    expect((await seen({ seen: ["../etc"] })).statusCode).toBe(400);
    expect((await seen({ seen: [] })).statusCode).toBe(400);
    expect((await seen({ seen: ["a"], reset: true })).statusCode).toBe(400);
  });
});
