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
  it("is off by default: nothing is relayed", () => {
    expect(loadConfig({}).FORGE_KIND).toBe("none");
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

  it("refuses a development exam cookie secret", () => {
    expect(() =>
      loadConfig({ ...production, EXAM_COOKIE_SECRET: "dev-exam-cookie-secret-change-me" }),
    ).toThrow(/EXAM_COOKIE_SECRET/);
  });
});
