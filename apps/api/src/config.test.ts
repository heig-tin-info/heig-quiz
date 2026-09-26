import { describe, expect, it } from "vitest";

import { loadConfig, loginAllowed, mailEnabled, pgliteDir, teamsEnabled } from "./config.js";

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

  it("ignores the unused client secret when private_key_jwt is configured", () => {
    // edu-ID: the secret is never sent, so its dev default is no secret in use.
    const { OIDC_CLIENT_SECRET: _unused, ...withoutSecret } = PROD;
    expect(() =>
      loadConfig({ ...withoutSecret, OIDC_PRIVATE_KEY_PATH: "secrets/eduid-private-key.pem" }),
    ).not.toThrow();
    // The cookie secret is in use either way.
    expect(() =>
      loadConfig({
        ...withoutSecret,
        OIDC_PRIVATE_KEY_PATH: "secrets/eduid-private-key.pem",
        COOKIE_SECRET: "dev-cookie-secret-change-me",
      }),
    ).toThrow(/COOKIE_SECRET/);
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

describe("loginAllowed", () => {
  it("admits everyone when the allowlist is empty", () => {
    expect(loginAllowed(loadConfig({}), ["anyone@example.org"])).toBe(true);
  });

  it("admits a listed address, a listed domain and the super administrator", () => {
    const config = loadConfig({
      LOGIN_ALLOWLIST: " Dev@Example.org, @heig-vd.ch ,",
      SUPER_ADMIN_EMAIL: "boss@example.org",
    });
    expect(loginAllowed(config, ["dev@example.org"])).toBe(true);
    expect(loginAllowed(config, ["someone@heig-vd.ch"])).toBe(true);
    expect(loginAllowed(config, ["boss@example.org"])).toBe(true);
    // Any address of the login counts, not only the first.
    expect(loginAllowed(config, ["private@gmail.com", "dev@example.org"])).toBe(true);
  });

  it("refuses everyone else, a look-alike domain included", () => {
    const config = loadConfig({ LOGIN_ALLOWLIST: "@heig-vd.ch" });
    expect(loginAllowed(config, ["student@gmail.com"])).toBe(false);
    expect(loginAllowed(config, ["x@evil-heig-vd.ch"])).toBe(false);
    expect(loginAllowed(config, [])).toBe(false);
  });
});

describe("notification channels (ADR-030)", () => {
  it("mails for real only with both Scaleway credentials", () => {
    expect(mailEnabled(loadConfig({}))).toBe(false);
    expect(mailEnabled(loadConfig({ SCW_SECRET_KEY: "k" }))).toBe(false);
    expect(mailEnabled(loadConfig({ SCW_SECRET_KEY: " k ", SCW_DEFAULT_PROJECT_ID: "p" }))).toBe(true);
    expect(loadConfig({}).MAIL_FROM_NAME).toBe("HEIG Quiz");
  });

  it("turns Teams on only with its three variables", () => {
    const all = { TEAMS_CLIENT_ID: "c", TEAMS_CLIENT_SECRET: "s", TEAMS_APP_ID: "a" };
    expect(teamsEnabled(loadConfig({}))).toBe(false);
    expect(teamsEnabled(loadConfig({ ...all, TEAMS_APP_ID: " " }))).toBe(false);
    expect(teamsEnabled(loadConfig(all))).toBe(true);
    expect(loadConfig({ TEAMS_SERVICE_URL: "https://smba.test/teams/" }).TEAMS_SERVICE_URL).toBe(
      "https://smba.test/teams",
    );
  });
});
