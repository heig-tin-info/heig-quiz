import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { configKeyHeaderFor, launchConfigKey, sebConfig, toPlistXml } from "./seb.js";

/**
 * The `.seb` Quiz serves and its Config Key, pinned byte for byte (M6-02).
 * Written from the code BEFORE it moved onto `@quiz/seb`, and changed on
 * purpose since: the quit link (`quitURL`, `quitURLConfirm`, 2026-10-08,
 * ADR-027), then the unlock password of an evaluation (`hashedQuitPassword`,
 * 2026-11-06, ADR-027): the file without one is a project's now, the file
 * with one an evaluation's. A SEB already holding a file computes this key,
 * so a change here changes every Config Key: an open session keeps the key
 * it was launched with (ADR-051 §3), and a file downloaded before the change
 * is refused at its start route — the student downloads it again.
 */
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("the launch file, byte for byte", () => {
  const url = "https://quiz.example.org/app/auth/seb/s3cret-ticket_0";

  it("renders the pinned plist without an unlock password (a project's)", () => {
    const expected = readFileSync(new URL("./fixtures/launch.seb", import.meta.url), "utf8");
    // The fixture itself is pinned, so it cannot be regenerated quietly.
    expect(sha256(expected)).toBe("e894e40b575f008af40e8e81b2e4d9efc12157ebfa1b31a9d38a99a9704d5f2b");
    expect(toPlistXml(sebConfig(url))).toBe(expected);
  });

  it("keeps the pinned Config Key and launch header without an unlock password", () => {
    expect(launchConfigKey(url)).toBe("d2ff3a166f29a7b90b88c0d9491d942623e9e7fe129d5a4042bb05affee3e826");
    expect(configKeyHeaderFor(url)).toBe("526bc6b164ad261e69ef081793943de0a98d017e843ee34646b7bcdad15c23bf");
  });

  it("renders the pinned plist with an evaluation's unlock password", () => {
    const expected = readFileSync(new URL("./fixtures/launch-unlock.seb", import.meta.url), "utf8");
    expect(sha256(expected)).toBe("779072d1bd7906b8c90c3b9f9468d257ff73733b4a1ed7e871edbb7959ffa27b");
    expect(toPlistXml(sebConfig(url, [], "cde234"))).toBe(expected);
  });

  it("keeps the pinned Config Key and launch header with an unlock password", () => {
    expect(launchConfigKey(url, [], "cde234")).toBe("9eaa3d56f7293a915ec7c5614a8c7b8f1e3f8ff7ce37d8fc5dc6ac960a967db8");
    expect(configKeyHeaderFor(url, [], "cde234")).toBe("2dcd7b798ca3aff4dcce0596ec1b49eb211cdf7dbcc2cb965b9a2b183778ba6d");
  });
});
