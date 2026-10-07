import { describe, expect, it } from "vitest";

import { absoluteRequestUrl, expectedHash } from "@quiz/seb";

import { configKeyHashMatches, configKeyHeaderFor, launchConfigKey, sebConfig, toPlistXml } from "./seb.js";

// The Moodle vectors and the 201-key vector live with the Config Key, in
// `packages/seb` (M6-02); the bytes of Quiz's file in `seb.snapshot.test.ts`.

describe("the launch file", () => {
  const url = "https://quiz.example.org/app/auth/seb/s3cret";

  it("starts on its URL and allows nothing but its host", () => {
    const xml = toPlistXml(sebConfig(url));
    expect(xml).toContain(`<string>${url}</string>`);
    expect(xml).toContain("<string>quiz.example.org</string>");
    expect(xml).toMatch(/<key>sendBrowserExamKey<\/key>\n\s*<true\/>/);
  });

  it("accepts the Config Key header of its own launch only", () => {
    const key = launchConfigKey(url);
    expect(configKeyHashMatches(url, key, configKeyHeaderFor(url))).toBe(true);
    expect(configKeyHashMatches(url, key, configKeyHeaderFor(`${url}x`))).toBe(false);
    expect(configKeyHashMatches(url, key, undefined)).toBe(false);
  });
});

describe("the Config Key of every later request (ADR-051 §3)", () => {
  // A Config Key as a session stores it: 64 hex characters (here sha256("quiz")).
  const key = "9d98ce221dd52eccf27cad6a01bcd49b14d3d718a9eeeb3be94f0e231a5787ae";

  it("hashes a percent-encoded query as it was sent, never re-encoded", () => {
    const raw = "/app/api/events?watch=attempt%3A0b9f7a8e-3c1d-4e2f-9a6b-5d4c3b2a1f0e";
    const url = absoluteRequestUrl("https://quiz.example.org/", raw);
    expect(url).toBe(`https://quiz.example.org${raw}`);
    const header = "1f5aca89edc18387bf8c0d6f2094b29f31a56dc467ea488dba093f934da0c1ca";
    expect(expectedHash(url, key)).toBe(header);
    expect(configKeyHashMatches(url, key, header.toUpperCase())).toBe(true);
    // The decoded URL is another URL, and another hash.
    expect(configKeyHashMatches(url.replace("%3A", ":"), key, header)).toBe(false);
  });
});
