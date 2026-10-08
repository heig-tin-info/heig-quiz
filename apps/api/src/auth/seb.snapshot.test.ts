import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { configKeyHeaderFor, launchConfigKey, sebConfig, toPlistXml } from "./seb.js";

/**
 * The `.seb` Quiz serves and its Config Key, pinned byte for byte (M6-02).
 * Written from the code BEFORE it moved onto `@quiz/seb`, and changed once
 * on purpose since: the quit link (`quitURL`, `quitURLConfirm`, 2026-10-08,
 * ADR-027). A SEB already holding a file computes this key, so a change here
 * changes every Config Key: an open session keeps the key it was launched
 * with (ADR-051 §3), and a file downloaded before the change is refused at
 * its start route — the student downloads it again.
 */
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("the launch file, byte for byte", () => {
  const url = "https://quiz.example.org/app/auth/seb/s3cret-ticket_0";

  it("renders the pinned plist", () => {
    const expected = readFileSync(new URL("./fixtures/launch.seb", import.meta.url), "utf8");
    // The fixture itself is pinned, so it cannot be regenerated quietly.
    expect(sha256(expected)).toBe("e894e40b575f008af40e8e81b2e4d9efc12157ebfa1b31a9d38a99a9704d5f2b");
    expect(toPlistXml(sebConfig(url))).toBe(expected);
  });

  it("keeps the pinned Config Key and launch header", () => {
    expect(launchConfigKey(url)).toBe("d2ff3a166f29a7b90b88c0d9491d942623e9e7fe129d5a4042bb05affee3e826");
    expect(configKeyHeaderFor(url)).toBe("526bc6b164ad261e69ef081793943de0a98d017e843ee34646b7bcdad15c23bf");
  });
});
