/** The `codeimage` config: drafts, publication, canonical form, migration. */
import { describe, expect, it } from "vitest";

import { CodeConfig } from "../schema.js";
import { codeConfig } from "../test/fixtures.js";
import { fromCanonicalImage, toCanonicalImage } from "./canonical.js";
import { CodeImageConfig, emptyCodeImageConfig } from "./schema.js";
import { codeimageServer } from "./server.js";
import { imageConfig } from "./test/fixtures.js";

const issuesOf = (raw: unknown): string[] => {
  const parsed = CodeImageConfig.safeParse(raw);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}:${i.message}`);
};

describe("CodeImageConfig", () => {
  it("accepts a complete config, with 128 KiB of output by default", () => {
    const config = imageConfig();
    expect(config.limits).toEqual({ timeMs: 2000, memoryMb: 128, outputKb: 128 });
    expect(config.runtime).toBe("backend");
  });

  it("keeps an explicit output budget, and defaults only the missing one", () => {
    expect(imageConfig({ limits: { timeMs: 1000 } }).limits).toEqual({
      timeMs: 1000,
      memoryMb: 128,
      outputKb: 128,
    });
  });

  it("refuses a draft without a target, by name", () => {
    expect(issuesOf({ ...imageConfig(), target: "" })).toContain("target:codeimage.target_missing");
  });

  it("refuses a target of the wrong size or with a value out of the palette", () => {
    expect(issuesOf({ ...imageConfig(), target: "1010" })).toContain("target:codeimage.target_size");
    expect(issuesOf({ ...imageConfig(), target: "10100101101x" })).toContain(
      "target:codeimage.target_value",
    );
  });

  it("bounds the sides to 3..128", () => {
    expect(issuesOf({ ...imageConfig(), image: { width: 2, height: 3, palette: "bw" } })).not.toEqual([]);
    expect(issuesOf({ ...imageConfig(), image: { width: 129, height: 3, palette: "bw" } })).not.toEqual(
      [],
    );
  });

  it("starts a draft empty, with the version it will be stored under", () => {
    const draft = emptyCodeImageConfig();
    expect(draft.target).toBe("");
    expect(draft.configVersion).toBe(codeimageServer.configVersion);
    expect(CodeImageConfig.safeParse(draft).success).toBe(false);
    expect(codeimageServer.migrate(draft, 1)).toBe(draft);
  });

  it("refuses a config written by a newer platform", () => {
    expect(() => codeimageServer.migrate(imageConfig(), 2)).toThrow();
  });
});

describe("the shared program fields", () => {
  it("leave a code config's parsed shape exactly as it was", () => {
    // `programFields` was extracted from `CodeConfig`; the full fixture, which
    // sets every field, must still parse to itself.
    const config = codeConfig();
    expect(CodeConfig.parse(config)).toStrictEqual(config);
    expect(Object.keys(config).sort()).toEqual(
      [
        "action",
        "allOrNothing",
        "compileArgs",
        "configVersion",
        "files",
        "language",
        "limits",
        "prompt",
        "referenceSolution",
        "runsPerMinute",
        "runtime",
        "template",
        "tests",
      ].sort(),
    );
  });
});

describe("canonical form", () => {
  it("round-trips exactly", () => {
    const config = imageConfig({ runtime: "runno", limits: { timeMs: 500, memoryMb: 64, outputKb: 200 } });
    expect(fromCanonicalImage(toCanonicalImage(config))).toStrictEqual(config);
  });

  it("leaves the defaults and the storage version out", () => {
    const out = toCanonicalImage(imageConfig());
    expect(out).not.toHaveProperty("configVersion");
    expect(out).not.toHaveProperty("limits");
    expect(out).not.toHaveProperty("runtime");
    expect(out).toMatchObject({ image: { width: 4, height: 3, palette: "bw" }, target: "101001011010" });
  });
});
