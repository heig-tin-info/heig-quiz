/**
 * The interface language on the account (`PATCH /app/api/me`, `MePatch`)
 * over the REAL application: every language of the registry is accepted,
 * German included (ADR-140), and a language the platform does not speak is
 * refused by the contract before it reaches `users.locale`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Me } from "@quiz/contracts";
import { LOCALES } from "@quiz/domain";

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
const patch = (locale: unknown) =>
  server.app.inject({ method: "PATCH", url: "/app/api/me", headers: teacher.headers, payload: { locale } });

describe("the account's interface language", () => {
  it("accepts every language of the registry, German included, and null for the browser's", async () => {
    expect(LOCALES).toContain("de");
    for (const locale of [...LOCALES, null]) {
      expect((await patch(locale)).statusCode, String(locale)).toBe(200);
      expect((await me()).locale).toBe(locale);
    }
  });

  it("refuses a language the platform does not speak, and keeps the one stored", async () => {
    expect((await patch("de")).statusCode).toBe(200);
    for (const locale of ["it", "de-CH", "DE"]) expect((await patch(locale)).statusCode, locale).toBe(400);
    expect((await me()).locale).toBe("de");
  });
});
