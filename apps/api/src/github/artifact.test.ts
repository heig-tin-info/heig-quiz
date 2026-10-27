/**
 * A graded run's artifact read under budgets (ADR-119 §6, choice g): the
 * zip's one entry `results.json`, refused otherwise — two entries, a path,
 * `..`, a link, an encrypted or unknown method, an inflation past the
 * budget (a zip bomb), something that is not a zip.
 */
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { RESULTS_FILE_MAX_BYTES } from "@quiz/domain";

import { unzipResults } from "./artifact.js";

const RESULTS = JSON.stringify({ criteria: { "code.format": { score: "1/1" } } });
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (out: Uint8Array | "refused") => (out === "refused" ? out : new TextDecoder().decode(out));

describe("unzipResults", () => {
  it("reads the one entry, deflated or stored", () => {
    expect(text(unzipResults(zipSync({ "results.json": bytes(RESULTS) })))).toBe(RESULTS);
    expect(text(unzipResults(zipSync({ "results.json": [bytes(RESULTS), { level: 0 }] })))).toBe(RESULTS);
    // A regular file's unix attributes are fine.
    expect(text(unzipResults(zipSync({ "results.json": [bytes(RESULTS), { os: 3, attrs: (0o100644 << 16) >>> 0 }] })))).toBe(RESULTS);
  });

  it("refuses two entries, another name, a directory, a path out of the root", () => {
    expect(unzipResults(zipSync({ "results.json": bytes(RESULTS), "other.txt": bytes("x") }))).toBe("refused");
    expect(unzipResults(zipSync({ "result.json": bytes(RESULTS) }))).toBe("refused");
    expect(unzipResults(zipSync({ out: { "results.json": bytes(RESULTS) } }))).toBe("refused");
    expect(unzipResults(zipSync({ "../results.json": bytes(RESULTS) }))).toBe("refused");
    expect(unzipResults(zipSync({ "/results.json": bytes(RESULTS) }))).toBe("refused");
  });

  it("refuses a symbolic link, whatever it is named", () => {
    const link = zipSync({ "results.json": [bytes("/etc/passwd"), { os: 3, attrs: (0o120777 << 16) >>> 0, level: 0 }] });
    expect(unzipResults(link)).toBe("refused");
  });

  it("stops an inflation past the budget, counted while inflating", () => {
    // A few hundred bytes that inflate past 256 KiB: a small bomb.
    const bomb = zipSync({ "results.json": [new Uint8Array(RESULTS_FILE_MAX_BYTES + 1).fill(32), { level: 9 }] });
    expect(bomb.length).toBeLessThan(4096);
    expect(unzipResults(bomb)).toBe("refused");
    const stored = zipSync({ "results.json": [new Uint8Array(RESULTS_FILE_MAX_BYTES + 1).fill(32), { level: 0 }] });
    expect(unzipResults(stored)).toBe("refused");
    // At the budget exactly: read.
    expect(unzipResults(zipSync({ "results.json": new Uint8Array(RESULTS_FILE_MAX_BYTES).fill(32) }))).not.toBe("refused");
  });

  it("refuses what is not a zip, or a truncated one", () => {
    expect(unzipResults(bytes(RESULTS))).toBe("refused");
    expect(unzipResults(new Uint8Array())).toBe("refused");
    const zip = zipSync({ "results.json": bytes(RESULTS) });
    expect(unzipResults(zip.subarray(0, zip.length - 30))).toBe("refused");
  });
});
