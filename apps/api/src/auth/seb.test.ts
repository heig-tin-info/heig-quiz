import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { configKey, configKeyMatches, configKeyHeaderFor, redactLaunchUrl, sebConfig, sebJson, toPlistXml } from "./seb.js";

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
    expect(configKeyMatches(url, configKeyHeaderFor(url))).toBe(true);
    expect(configKeyMatches(url, configKeyHeaderFor(`${url}x`))).toBe(false);
    expect(configKeyMatches(url, undefined)).toBe(false);
  });

  it("never writes the secret to the request log", () => {
    expect(redactLaunchUrl("/app/auth/seb/s3cret")).not.toContain("s3cret");
    expect(redactLaunchUrl("/app/api/me")).toBe("/app/api/me");
  });
});
