import { z } from "zod";
import { describe, expect, it } from "vitest";

import { ConfigMigrationError } from "./errors.js";
import { canonicalParse, fromCanonicalOf, reparseMigrate } from "./migrate.js";

const Config = z.object({
  configVersion: z.literal(2),
  prompt: z.string().min(1),
  points: z.number().default(1),
});

describe("reparseMigrate", () => {
  const migrate = reparseMigrate("code", Config, 2);

  it("refuses a config written by a newer version", () => {
    expect(() => migrate({ prompt: "p" }, 3)).toThrow(ConfigMigrationError);
  });

  it("returns a config of the current version as it stands, even an invalid draft", () => {
    const draft = { configVersion: 2, prompt: "" };
    expect(migrate(draft, 2)).toBe(draft);
  });

  it("stamps and validates an older config", () => {
    expect(migrate({ configVersion: 1, prompt: "p" }, 1)).toEqual({
      configVersion: 2,
      prompt: "p",
      points: 1,
    });
  });

  it("joins the issues of an older config that does not parse", () => {
    let error: unknown;
    try {
      migrate({ prompt: "", points: "x" }, 1);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigMigrationError);
    const { reason, fromVersion, toVersion, typeId } = error as ConfigMigrationError;
    expect({ typeId, fromVersion, toVersion }).toEqual({ typeId: "code", fromVersion: 1, toVersion: 2 });
    expect(reason).toMatch(/^prompt: .+; points: .+$/);
  });
});

describe("canonicalParse", () => {
  const parse = canonicalParse(Config, 2);

  it("stamps the version the canonical file never writes", () => {
    expect(parse({ prompt: "p" })).toEqual({ configVersion: 2, prompt: "p", points: 1 });
  });

  it("throws on a bad file", () => {
    expect(() => parse({ prompt: "" })).toThrow();
    expect(() => parse(null)).toThrow();
  });
});

describe("fromCanonicalOf", () => {
  const Plain = z.object({ text: z.string() });

  it("is configSchema.parse when the type has no fromCanonical", () => {
    const read = fromCanonicalOf({ configSchema: Plain });
    expect(read({ text: "a" })).toEqual({ text: "a" });
    expect(() => read({})).toThrow();
  });

  it("is the type's own fromCanonical when it has one", () => {
    const read = fromCanonicalOf({ configSchema: Plain, fromCanonical: () => ({ text: "own" }) });
    expect(read({})).toEqual({ text: "own" });
  });
});
