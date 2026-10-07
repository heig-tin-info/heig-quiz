import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { configKeyHeaderFor, launchConfigKey, sebConfig, toPlistXml } from "./seb.js";

/**
 * The `.seb` Quiz serves and its Config Key, pinned byte for byte (M6-02).
 * Written from the code BEFORE it moved onto `@quiz/seb`, and never
 * regenerated: a SEB already holding a file computes this key, so a change
 * here is a change every open sitting would see.
 */
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("the launch file, byte for byte", () => {
  const url = "https://quiz.example.org/app/auth/seb/s3cret-ticket_0";

  it("renders the pinned plist", () => {
    const expected = readFileSync(new URL("./fixtures/launch.seb", import.meta.url), "utf8");
    // The fixture itself is pinned, so it cannot be regenerated quietly.
    expect(sha256(expected)).toBe("2a4c6f820bf00ed9e092e9467f1fac59727ee982be29b0309dcfd1b8272a464d");
    expect(toPlistXml(sebConfig(url))).toBe(expected);
  });

  it("keeps the pinned Config Key and launch header", () => {
    expect(launchConfigKey(url)).toBe("5555877b36966f7aa007608b7e66256dbc04192febb129cee462c8cbd10da563");
    expect(configKeyHeaderFor(url)).toBe("d5db46f611fc1c6770f03634e1dfa2957b510ee32176ab861d46618a64e3d33c");
  });
});
