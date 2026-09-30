import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  configKey,
  configKeyHash,
  configKeyHashMatches,
  configKeyHeaderFor,
  launchConfigKey,
  requestUrl,
  sebConfig,
  sebJson,
  toPlistXml,
} from "./seb.js";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Every key of every dictionary in reverse order, so only the sort can put them back. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]));
}

describe("Config Key: the vectors of Moodle's quizaccess_seb (fixtures/PROVENANCE.md)", () => {
  it("the empty configuration is `[]`", () => {
    expect(configKey({})).toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
  });

  it("re-serialises the SEB macOS 2.1.4 configuration character for character", () => {
    const vector = readFileSync(new URL("./fixtures/seb-json-mac-001.txt", import.meta.url), "utf8");
    expect(sha256(vector)).toBe("4fa9af8ec8759eb7c680752ef4ee5eaf1a860628608fccae2715d519849f9292");
    // The vector keeps its backslashes raw, so it is not JSON until they are escaped.
    const tree = JSON.parse(vector.replace(/\\(?!["\\/bfnrtu])/g, "\\\\"));
    expect(sebJson(reversed(tree) as never)).toBe(vector);
  });
});

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

  it("hashes the absolute URL followed by the key", () => {
    const url = requestUrl("https://quiz.example.org", "/app/api/me");
    expect(url).toBe("https://quiz.example.org/app/api/me");
    expect(configKeyHash(url, key)).toBe("316ece7bd8c29ba7127fa44535df31d591427baf0d82c494f90231c05941f1df");
  });

  it("hashes a percent-encoded query as it was sent, never re-encoded", () => {
    const raw = "/app/api/events?watch=attempt%3A0b9f7a8e-3c1d-4e2f-9a6b-5d4c3b2a1f0e";
    const url = requestUrl("https://quiz.example.org/", raw);
    expect(url).toBe(`https://quiz.example.org${raw}`);
    const header = "1f5aca89edc18387bf8c0d6f2094b29f31a56dc467ea488dba093f934da0c1ca";
    expect(configKeyHash(url, key)).toBe(header);
    expect(configKeyHashMatches(url, key, header.toUpperCase())).toBe(true);
    // The decoded URL is another URL, and another hash.
    expect(configKeyHashMatches(url.replace("%3A", ":"), key, header)).toBe(false);
  });

  it("takes the origin of PUBLIC_URL only", () => {
    expect(requestUrl("https://quiz.example.org/some/base", "/app/api/me")).toBe(
      "https://quiz.example.org/app/api/me",
    );
  });
});
