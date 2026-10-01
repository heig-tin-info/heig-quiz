import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

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

  it("refuses the mock kiosk attestation in production", () => {
    expect(() => loadConfig({ ...PROD, KIOSK_ATTESTATION: "mock" })).toThrow(/KIOSK_ATTESTATION/);
    // Off, or absent, it boots.
    expect(() => loadConfig({ ...PROD, KIOSK_ATTESTATION: "off" })).not.toThrow();
    expect(loadConfig({}).KIOSK_ATTESTATION).toBe("off");
    expect(loadConfig({ NODE_ENV: "development", KIOSK_ATTESTATION: "mock" }).KIOSK_ATTESTATION).toBe("mock");
  });

  it("reads SEB_CONFIG_KEY_ENFORCE as a switch, off by default (ADR-051 §3)", () => {
    expect(loadConfig({}).SEB_CONFIG_KEY_ENFORCE).toBe(false);
    expect(loadConfig({ SEB_CONFIG_KEY_ENFORCE: "0" }).SEB_CONFIG_KEY_ENFORCE).toBe(false);
    expect(loadConfig({ SEB_CONFIG_KEY_ENFORCE: "yes" }).SEB_CONFIG_KEY_ENFORCE).toBe(false);
    expect(loadConfig({ SEB_CONFIG_KEY_ENFORCE: "1" }).SEB_CONFIG_KEY_ENFORCE).toBe(true);
    expect(loadConfig({ ...PROD, SEB_CONFIG_KEY_ENFORCE: "true" }).SEB_CONFIG_KEY_ENFORCE).toBe(true);
  });

  it("refuses a google kiosk attestation that cannot run, in production", () => {
    const dir = mkdtempSync(join(tmpdir(), "quiz-kiosk-"));
    const keyFile = join(dir, "va.json");
    writeFileSync(keyFile, "{}");
    const google = {
      ...PROD,
      KIOSK_ATTESTATION: "google",
      KIOSK_VA_KEY_FILE: keyFile,
      KIOSK_GOOGLE_CUSTOMER_ID: "C01abcdef",
      KIOSK_ENROLLMENT_DOMAIN: "heig-vd.ch",
      KIOSK_EXTENSION_ID: "abcdefghijklmnopabcdefghijklmnop",
    };
    try {
      expect(loadConfig(google).KIOSK_VA_KEY_FILE).toBe(keyFile);
      for (const key of ["KIOSK_GOOGLE_CUSTOMER_ID", "KIOSK_ENROLLMENT_DOMAIN", "KIOSK_EXTENSION_ID"]) {
        expect(() => loadConfig({ ...google, [key]: "" }), key).toThrow(new RegExp(key));
        expect(() => loadConfig({ ...google, [key]: "  " }), key).toThrow(new RegExp(key));
      }
      expect(() => loadConfig({ ...google, KIOSK_VA_KEY_FILE: "" })).toThrow(/KIOSK_VA_KEY_FILE/);
      expect(() => loadConfig({ ...google, KIOSK_VA_KEY_FILE: join(dir, "missing.json") })).toThrow(
        /KIOSK_VA_KEY_FILE/,
      );
      // Every problem at once, in one boot error.
      expect(() =>
        loadConfig({ ...PROD, KIOSK_ATTESTATION: "google", KIOSK_ENROLLMENT_DOMAIN: "heig-vd.ch" }),
      ).toThrow(
        /KIOSK_VA_KEY_FILE is unreadable; KIOSK_GOOGLE_CUSTOMER_ID is missing; KIOSK_EXTENSION_ID is missing/,
      );
      // Outside production the checks do not apply: a developer may try the
      // `google` path with half a configuration and see it answer unavailable.
      expect(() => loadConfig({ NODE_ENV: "development", KIOSK_ATTESTATION: "google" })).not.toThrow();
      // Nor do they when the kiosk path is off.
      expect(() => loadConfig({ ...PROD, KIOSK_ATTESTATION: "off" })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses the stub LLM provider in production", () => {
    expect(() => loadConfig({ ...PROD, LLM_PROVIDER: "stub" })).toThrow(/LLM_PROVIDER/);
    // Off, or absent, it boots.
    expect(() => loadConfig({ ...PROD, LLM_PROVIDER: "none" })).not.toThrow();
    expect(loadConfig(PROD).LLM_PROVIDER).toBe("none");
  });

  it("lets the stub LLM provider through outside production", () => {
    expect(loadConfig({ NODE_ENV: "development", LLM_PROVIDER: "stub" }).LLM_PROVIDER).toBe("stub");
  });

  it("takes an LLM master key of 32 characters or more, and refuses a development one in production", () => {
    expect(() => loadConfig({ NODE_ENV: "development", LLM_KEY_SECRET: "too-short" })).toThrow(/LLM_KEY_SECRET/);
    expect(loadConfig({ NODE_ENV: "development" }).LLM_KEY_SECRET).toBe("");
    const dev = "dev-llm-master-key-change-me-0123456789";
    expect(loadConfig({ NODE_ENV: "development", LLM_KEY_SECRET: dev }).LLM_KEY_SECRET).toBe(dev);
    expect(() => loadConfig({ ...PROD, LLM_KEY_SECRET: dev })).toThrow(/LLM_KEY_SECRET/);
    expect(() => loadConfig({ ...PROD, LLM_KEY_SECRET: "a".repeat(64) })).not.toThrow();
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

  it("turns Teams on only with the application's id and secret", () => {
    const all = { TEAMS_CLIENT_ID: "c", TEAMS_CLIENT_SECRET: "s" };
    expect(teamsEnabled(loadConfig({}))).toBe(false);
    expect(teamsEnabled(loadConfig({ ...all, TEAMS_CLIENT_SECRET: " " }))).toBe(false);
    expect(teamsEnabled(loadConfig(all))).toBe(true);
  });

  it("parses the allowed Teams tenants once, lower-cased", () => {
    const heig = "a372f724-c0b2-4ea0-abfb-0eb8c6f84e40";
    const listed = loadConfig({ TEAMS_ALLOWED_TENANTS: ` ${heig.toUpperCase()} , ,other ` });
    expect(listed.TEAMS_ALLOWED_TENANTS).toEqual([heig, "other"]);
    expect(loadConfig({}).TEAMS_ALLOWED_TENANTS).toEqual([]);
  });

  it("refuses Teams open to every tenant in production (ADR-030)", () => {
    const teams = { ...PROD, TEAMS_CLIENT_ID: "c", TEAMS_CLIENT_SECRET: "s" };
    expect(() => loadConfig(teams)).toThrow(/TEAMS_ALLOWED_TENANTS/);
    expect(() => loadConfig({ ...teams, TEAMS_ALLOWED_TENANTS: " , " })).toThrow(/TEAMS_ALLOWED_TENANTS/);
    expect(() => loadConfig({ ...teams, TEAMS_ALLOWED_TENANTS: "a372f724-c0b2-4ea0-abfb-0eb8c6f84e40" })).not.toThrow();
    // Teams off, or outside production: nothing to refuse.
    expect(() => loadConfig(PROD)).not.toThrow();
    expect(() => loadConfig({ TEAMS_CLIENT_ID: "c", TEAMS_CLIENT_SECRET: "s" })).not.toThrow();
  });
});

describe("the GitHub App (N-SEC-16)", () => {
  const dir = mkdtempSync(join(tmpdir(), "quiz-config-"));
  const pem = join(dir, "app.private-key.pem");
  writeFileSync(pem, "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const APP = {
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY_PATH: pem,
    GITHUB_APP_SLUG: "heig-quiz",
    GITHUB_WEBHOOK_SECRET: "w".repeat(32),
    GITHUB_APP_CLIENT_ID: "Iv23li",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
  };

  it("is off with no GITHUB_* at all, in production too, and the rest boots", () => {
    const config = loadConfig(PROD);
    expect(config.GITHUB_APP_ID).toBe("");
    expect(config.GITHUB_APP_PRIVATE_KEY_PATH).toBe("");
    // Blank values count as absent.
    expect(() => loadConfig({ ...PROD, GITHUB_APP_ID: " ", GITHUB_WEBHOOK_SECRET: "" })).not.toThrow();
  });

  it("boots a complete App in production, the key path made absolute", () => {
    const config = loadConfig({ ...PROD, ...APP });
    expect(config.GITHUB_APP_PRIVATE_KEY_PATH).toBe(pem);
    const relative = loadConfig({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY_PATH: "secrets/k.pem" });
    expect(relative.GITHUB_APP_PRIVATE_KEY_PATH).toMatch(/^\/.*\/secrets\/k\.pem$/);
  });

  it("refuses an App id whose key file is unreadable", () => {
    expect(() => loadConfig({ ...PROD, ...APP, GITHUB_APP_PRIVATE_KEY_PATH: join(dir, "missing.pem") })).toThrow(
      /GITHUB_APP_PRIVATE_KEY_PATH/,
    );
    expect(() => loadConfig({ ...PROD, ...APP, GITHUB_APP_PRIVATE_KEY_PATH: "" })).toThrow(
      /GITHUB_APP_PRIVATE_KEY_PATH/,
    );
    // A directory is not a key file.
    expect(() => loadConfig({ ...PROD, ...APP, GITHUB_APP_PRIVATE_KEY_PATH: dir })).toThrow(
      /GITHUB_APP_PRIVATE_KEY_PATH/,
    );
  });

  it("refuses a webhook secret under 32 characters, or none", () => {
    expect(() => loadConfig({ ...PROD, ...APP, GITHUB_WEBHOOK_SECRET: "w".repeat(31) })).toThrow(
      /GITHUB_WEBHOOK_SECRET/,
    );
    expect(() => loadConfig({ ...PROD, ...APP, GITHUB_WEBHOOK_SECRET: "" })).toThrow(/GITHUB_WEBHOOK_SECRET/);
    // Surrounding blanks do not count towards the length.
    expect(() =>
      loadConfig({ ...PROD, ...APP, GITHUB_WEBHOOK_SECRET: ` ${"w".repeat(31)} ` }),
    ).toThrow(/GITHUB_WEBHOOK_SECRET/);
  });

  it("refuses a missing App slug", () => {
    expect(() => loadConfig({ ...PROD, ...APP, GITHUB_APP_SLUG: "" })).toThrow(/GITHUB_APP_SLUG/);
  });

  it("refuses a missing OAuth client id or secret (account linking)", () => {
    expect(() => loadConfig({ ...PROD, ...APP, GITHUB_APP_CLIENT_ID: "" })).toThrow(/GITHUB_APP_CLIENT_ID/);
    expect(() => loadConfig({ ...PROD, ...APP, GITHUB_APP_CLIENT_SECRET: " " })).toThrow(
      /GITHUB_APP_CLIENT_SECRET/,
    );
  });

  it("is off without an App id, whatever else is set: nothing to refuse", () => {
    const { GITHUB_APP_ID: _id, ...withoutId } = APP;
    expect(() => loadConfig({ ...PROD, ...withoutId, GITHUB_WEBHOOK_SECRET: "short" })).not.toThrow();
  });

  it("refuses nothing outside production", () => {
    expect(() =>
      loadConfig({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY_PATH: join(dir, "missing.pem"), GITHUB_WEBHOOK_SECRET: "short" }),
    ).not.toThrow();
  });
});
