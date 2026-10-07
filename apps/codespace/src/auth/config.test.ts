/**
 * The startup refusals and renames of M6-03: `PLATFORM_URL` with its
 * `CLASSROOM_URL` alias, the GitHub relay off by default, and no GitHub App
 * credential accepted at all (root invariant 15: never heig-classroom's App).
 */
import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

const production = {
  NODE_ENV: "production",
  EXAM_COOKIE_SECRET: "another-production-secret",
  SEB_VERIFIER: "real",
  SEB_PUBLIC_ORIGIN: "https://codespace.heig-vd.ch",
  TRUSTED_PROXY_IPS: "127.0.0.1",
};

describe("PLATFORM_URL", () => {
  it("is read under its new name", () => {
    expect(loadConfig({ PLATFORM_URL: "https://quiz.example" }).PLATFORM_URL).toBe(
      "https://quiz.example",
    );
  });

  it("falls back on the old CLASSROOM_URL", () => {
    expect(loadConfig({ CLASSROOM_URL: "https://classroom.example" }).PLATFORM_URL).toBe(
      "https://classroom.example",
    );
  });

  it("the new name wins when both are set", () => {
    const config = loadConfig({
      PLATFORM_URL: "https://quiz.example",
      CLASSROOM_URL: "https://classroom.example",
    });
    expect(config.PLATFORM_URL).toBe("https://quiz.example");
  });
});

describe("GitHub relay", () => {
  const SECRET = "x".repeat(40);

  it("is off by default: nothing is relayed", () => {
    expect(loadConfig({}).FORGE_KIND).toBe("none");
  });

  it("defaults to Quiz's forge once the platform is configured (ADR-078 §3)", () => {
    expect(loadConfig({ PLATFORM_URL: "https://quiz.example", CODESPACE_LAUNCH_SECRET: SECRET }).FORGE_KIND).toBe("quiz");
    expect(loadConfig({ CLASSROOM_URL: "https://quiz.example", CODESPACE_LAUNCH_SECRET: SECRET }).FORGE_KIND).toBe("quiz");
    // Either one missing: off. The URL's built-in default does not count.
    expect(loadConfig({ CODESPACE_LAUNCH_SECRET: SECRET }).FORGE_KIND).toBe("none");
    expect(loadConfig({ PLATFORM_URL: "https://quiz.example" }).FORGE_KIND).toBe("none");
    // `none` stays settable explicitly.
    expect(loadConfig({ PLATFORM_URL: "https://quiz.example", CODESPACE_LAUNCH_SECRET: SECRET, FORGE_KIND: "none" }).FORGE_KIND).toBe("none");
  });

  it("refuses the quiz forge without the secret that signs its requests", () => {
    expect(() => loadConfig({ FORGE_KIND: "quiz" })).toThrow(/CODESPACE_LAUNCH_SECRET/);
  });

  it("refuses forgejo, the unconfigured github forge, and quiz over plain http in production", () => {
    const platform = { ...production, CODESPACE_LAUNCH_SECRET: SECRET, PLATFORM_URL: "https://quiz.example" };
    expect(loadConfig(platform).FORGE_KIND).toBe("quiz");
    expect(() => loadConfig({ ...platform, FORGE_KIND: "forgejo" })).toThrow(/forgejo/);
    expect(() => loadConfig({ ...platform, FORGE_KIND: "github" })).toThrow(/github/);
    expect(() => loadConfig({ ...platform, PLATFORM_URL: "http://quiz.example" })).toThrow(/https/);
    expect(loadConfig({ ...platform, FORGE_KIND: "none" }).FORGE_KIND).toBe("none");
    // In development, both stay available.
    expect(loadConfig({ FORGE_KIND: "forgejo" }).FORGE_KIND).toBe("forgejo");
    expect(loadConfig({ FORGE_KIND: "github" }).FORGE_KIND).toBe("github");
  });

  it.each(["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY_PATH"])(
    "refuses to start with %s set, in development as in production",
    (key) => {
      expect(() => loadConfig({ [key]: "123" })).toThrow(new RegExp(key));
      expect(() => loadConfig({ ...production, [key]: "123" })).toThrow(new RegExp(key));
    },
  );
});

describe("production refusals", () => {
  it("accepts a complete production configuration", () => {
    expect(() => loadConfig(production)).not.toThrow();
  });

  it("refuses the simulated SEB verifier", () => {
    expect(() => loadConfig({ ...production, SEB_VERIFIER: "simulated" })).toThrow(/simulated/);
  });

  it("refuses to run without TRUSTED_PROXY_IPS", () => {
    expect(() => loadConfig({ ...production, TRUSTED_PROXY_IPS: "" })).toThrow(
      /TRUSTED_PROXY_IPS/,
    );
  });

  it("refuses an empty SEB_PUBLIC_ORIGIN", () => {
    expect(() => loadConfig({ ...production, SEB_PUBLIC_ORIGIN: "" })).toThrow(
      /SEB_PUBLIC_ORIGIN/,
    );
  });

  it("refuses the development launch secret", () => {
    expect(() =>
      loadConfig({
        ...production,
        CODESPACE_LAUNCH_SECRET: "dev-launch-secret-change-me-0123456789",
      }),
    ).toThrow(/CODESPACE_LAUNCH_SECRET/);
  });

  it("refuses a development exam cookie secret", () => {
    expect(() =>
      loadConfig({ ...production, EXAM_COOKIE_SECRET: "dev-exam-cookie-secret-change-me" }),
    ).toThrow(/EXAM_COOKIE_SECRET/);
  });
});
