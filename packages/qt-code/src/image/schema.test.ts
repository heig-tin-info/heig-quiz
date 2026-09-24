/** The `codeimage` config: drafts, publication, canonical form, migration. */
import { describe, expect, it } from "vitest";

import { CodeConfig } from "../schema.js";
import { codeConfig } from "../test/fixtures.js";
import { fromCanonicalImage, toCanonicalImage } from "./canonical.js";
import { CodeImageConfig, emptyCodeImageConfig, targetPixels } from "./schema.js";
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
    // A config stored before the cooldown existed keeps the 3 s it had.
    expect(config.cooldown).toBe("fixed");
  });

  it("keeps an explicit output budget, and defaults only the missing one", () => {
    expect(imageConfig({ limits: { timeMs: 1000 } }).limits).toEqual({
      timeMs: 1000,
      memoryMb: 128,
      outputKb: 128,
    });
  });

  it("accepts a draft without a target, or with a stale one: both must be tryable (D16)", () => {
    expect(issuesOf({ ...imageConfig(), target: null })).toEqual([]);
    expect(issuesOf({ ...imageConfig(), image: { width: 5, height: 3, palette: "bw" } })).toEqual([]);
  });

  it("leaves the target to publication: missing, wrong size, value out of the palette", () => {
    const pub = (target: unknown) =>
      codeimageServer
        .publicationIssues!({ ...imageConfig(), target } as never)
        .map((i) => i.message);
    const bw43 = { width: 4, height: 3, palette: "bw" };
    expect(pub(null)).toEqual(["codeimage.target_missing"]);
    expect(pub({ ...bw43, pixels: "1010" })).toEqual(["codeimage.target_size"]);
    expect(pub({ ...bw43, pixels: "10100101101x" })).toEqual(["codeimage.target_value"]);
    // Twelve pixels either way: only the stored dimensions tell them apart.
    expect(pub({ width: 3, height: 4, palette: "bw", pixels: "101001011010" })).toEqual([
      "codeimage.target_size",
    ]);
    expect(pub({ ...bw43, palette: "color16", pixels: "101001011010" })).toEqual([
      "codeimage.target_size",
    ]);
    expect(codeimageServer.publicationIssues!(imageConfig())).toEqual([]);
  });

  it("reads a target that no longer fits the image as no target at all", () => {
    expect(targetPixels(imageConfig())).not.toBeNull();
    expect(targetPixels({ ...imageConfig(), target: null })).toBeNull();
    expect(targetPixels({ ...imageConfig(), image: { width: 3, height: 4, palette: "bw" } })).toBeNull();
    expect(targetPixels({ ...imageConfig(), image: { width: 5, height: 3, palette: "bw" } })).toBeNull();
    expect(targetPixels({ ...imageConfig(), image: { width: 4, height: 3, palette: "gray256" } })).toBeNull();
  });

  it("bounds the sides to 3..128", () => {
    expect(issuesOf({ ...imageConfig(), image: { width: 2, height: 3, palette: "bw" } })).not.toEqual([]);
    expect(issuesOf({ ...imageConfig(), image: { width: 129, height: 3, palette: "bw" } })).not.toEqual(
      [],
    );
  });

  it("starts a draft empty, with the version it will be stored under", () => {
    const draft = emptyCodeImageConfig();
    expect(draft.target).toBeNull();
    expect(draft.runtime).toBe("runno");
    expect(draft.configVersion).toBe(codeimageServer.configVersion);
    expect(codeimageServer.publicationIssues!(draft)).not.toEqual([]);
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
        "cooldown",
        "template",
        "tests",
      ].sort(),
    );
  });
});

describe("canonical form", () => {
  it("round-trips exactly", () => {
    const config = imageConfig({ runtime: "runno", cooldown: "progressive", limits: { timeMs: 500, memoryMb: 64, outputKb: 200 } });
    expect(fromCanonicalImage(toCanonicalImage(config))).toStrictEqual(config);
  });

  it("leaves the defaults and the storage version out", () => {
    const out = toCanonicalImage(imageConfig());
    expect(out).not.toHaveProperty("configVersion");
    expect(out).not.toHaveProperty("limits");
    expect(out).not.toHaveProperty("runtime");
    expect(out).not.toHaveProperty("cooldown");
    expect(out).toMatchObject({
      image: { width: 4, height: 3, palette: "bw" },
      target: { width: 4, height: 3, palette: "bw", pixels: "101001011010" },
    });
  });
});
