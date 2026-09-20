import { describe, expect, it } from "vitest";

import { loadConfig, pgliteDir } from "./config.js";

/*
 * The configuration is the last place a development convenience can be
 * turned on in production by accident, so each of them is refused here, by
 * the same mechanism as the historical dev-secret refusal: the process does
 * not start.
 */
const PROD = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://quiz:secret@db:5432/quiz",
  OIDC_CLIENT_SECRET: "a-real-secret",
  COOKIE_SECRET: "a-real-cookie-secret-of-the-right-length",
};

describe("loadConfig", () => {
  it("defaults to the embedded database, so a fresh checkout runs", () => {
    const config = loadConfig({});
    expect(config.DATABASE_URL).toBe("pglite://.data/pglite");
    expect(config.AUTH_DEV_LOGIN).toBe(false);
    expect(config.TICK_MS).toBe(1000);
  });

  it("refuses the development login in production", () => {
    expect(() => loadConfig({ ...PROD, AUTH_DEV_LOGIN: "1" })).toThrow(/AUTH_DEV_LOGIN/);
    // Off, or absent, it boots.
    expect(() => loadConfig({ ...PROD, AUTH_DEV_LOGIN: "0" })).not.toThrow();
  });

  it("refuses the embedded database in production", () => {
    expect(() => loadConfig({ ...PROD, DATABASE_URL: "pglite://.data/pglite" })).toThrow(
      /pglite/,
    );
  });

  it("still refuses the dev secrets in production", () => {
    expect(() =>
      loadConfig({ ...PROD, OIDC_CLIENT_SECRET: "dev-secret-not-for-production" }),
    ).toThrow(/OIDC_CLIENT_SECRET/);
    expect(() => loadConfig({ ...PROD, COOKIE_SECRET: "dev-cookie-secret-change-me" })).toThrow(
      /COOKIE_SECRET/,
    );
  });

  it("lets the development login through outside production", () => {
    expect(loadConfig({ NODE_ENV: "development", AUTH_DEV_LOGIN: "1" }).AUTH_DEV_LOGIN).toBe(true);
  });
});

describe("pgliteDir", () => {
  it("recognizes the embedded URL and resolves its directory", () => {
    expect(pgliteDir("pglite://.data/pglite")).toMatch(/\/\.data\/pglite$/);
    expect(pgliteDir("pglite:///var/lib/quiz")).toBe("/var/lib/quiz");
  });

  it("leaves a real PostgreSQL URL alone", () => {
    expect(pgliteDir("postgres://quiz:quiz@localhost:5432/quiz")).toBeNull();
  });
});
