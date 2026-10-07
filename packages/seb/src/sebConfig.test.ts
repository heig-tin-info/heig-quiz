import { describe, expect, it } from "vitest";

import { configKey, configKeyFromPlistXml } from "./configKey.js";
import { parsePlist, toPlistXml, type SebValue } from "./plist.js";
import { buildSebConfig } from "./sebConfig.js";

const START = "https://quiz.example.org/app/auth/seb/s3cret";
const SALT = "QJAqvg89YMP6JagAshUm6QqpqpsrVS9ZWUYjdZhfEao=";

const entry = (root: SebValue, key: string): SebValue | undefined =>
  root.kind === "dict" ? root.value.find(([k]) => k === key)?.[1] : undefined;

function allowed(root: SebValue): string[] {
  const rules = entry(root, "URLFilterRules");
  if (rules?.kind !== "array") throw new Error("URLFilterRules must be an array");
  return rules.value.map((rule) => {
    const expression = entry(rule, "expression");
    return expression?.kind === "string" ? expression.value : "";
  });
}

describe("buildSebConfig", () => {
  it("starts on its URL, sends the Config Key and allows its host first", () => {
    const config = buildSebConfig({ startUrl: START, allowedHosts: [] });
    expect(entry(config, "startURL")).toEqual({ kind: "string", value: START });
    expect(entry(config, "sendBrowserExamKey")).toEqual({ kind: "bool", value: true });
    expect(allowed(config)).toEqual(["quiz.example.org"]);
  });

  it("adds the other hosts once, and they change the Config Key", () => {
    const base = buildSebConfig({ startUrl: START, allowedHosts: [] });
    const more = buildSebConfig({ startUrl: START, allowedHosts: ["code.example.org", "quiz.example.org"] });
    expect(allowed(more)).toEqual(["quiz.example.org", "code.example.org"]);
    expect(configKey(more)).not.toBe(configKey(base));
  });

  it("carries a salt only when given, never a Browser Exam Key", () => {
    expect(entry(buildSebConfig({ startUrl: START, allowedHosts: [] }), "examKeySalt")).toBeUndefined();
    const salted = buildSebConfig({ startUrl: START, allowedHosts: [], examKeySalt: SALT });
    expect(entry(salted, "examKeySalt")).toEqual({ kind: "data", value: SALT });
    expect(entry(salted, "browserExamKey")).toBeUndefined();
  });

  it("reads back to the same tree and the same Config Key", () => {
    const config = buildSebConfig({ startUrl: START, allowedHosts: ["code.example.org"], examKeySalt: SALT });
    const xml = toPlistXml(config);
    expect(parsePlist(xml)).toEqual(config);
    expect(configKeyFromPlistXml(xml)).toBe(configKey(config));
  });
});
