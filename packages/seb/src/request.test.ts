import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { absoluteRequestUrl, expectedHash, hashesEqual } from "./request.js";

// A Config Key as a session stores it: 64 hex characters (here sha256("quiz")).
const KEY = "9d98ce221dd52eccf27cad6a01bcd49b14d3d718a9eeeb3be94f0e231a5787ae";

describe("the absolute URL SEB hashed", () => {
  it("is the public origin followed by the target", () => {
    expect(absoluteRequestUrl("https://quiz.example.org", "/app/api/me")).toBe("https://quiz.example.org/app/api/me");
  });

  it("takes the origin of the public URL only", () => {
    expect(absoluteRequestUrl("https://quiz.example.org/some/base", "/app/api/me")).toBe(
      "https://quiz.example.org/app/api/me",
    );
  });

  it("keeps a percent-encoding and a dot segment as sent, never re-encoded", () => {
    const raw = "/app/api/events?watch=attempt%3A0b9f7a8e-3c1d-4e2f-9a6b-5d4c3b2a1f0e";
    expect(absoluteRequestUrl("https://quiz.example.org/", raw)).toBe(`https://quiz.example.org${raw}`);
    expect(absoluteRequestUrl("https://quiz.example.org", "/a/../b")).toBe("https://quiz.example.org/a/../b");
  });

  it("drops a fragment", () => {
    expect(absoluteRequestUrl("https://quiz.example.org", "/exam?x=1#top")).toBe("https://quiz.example.org/exam?x=1");
  });
});

describe("the hashes", () => {
  it("expectedHash is sha256(url + key), no separator", () => {
    const url = "https://quiz.example.org/app/api/me";
    expect(expectedHash(url, KEY)).toBe(createHash("sha256").update(`${url}${KEY}`).digest("hex"));
    expect(expectedHash(url, KEY)).toBe("316ece7bd8c29ba7127fa44535df31d591427baf0d82c494f90231c05941f1df");
  });

  it("hashesEqual ignores case and surrounding whitespace, nothing else", () => {
    const hash = expectedHash("https://quiz.example.org/", KEY);
    expect(hashesEqual(hash, hash.toUpperCase())).toBe(true);
    expect(hashesEqual(hash, ` ${hash} `)).toBe(true);
    expect(hashesEqual(hash, hash.slice(0, -1))).toBe(false);
    expect(hashesEqual(hash, "")).toBe(false);
  });
});
