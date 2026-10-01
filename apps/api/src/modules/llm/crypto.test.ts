import { describe, expect, it } from "vitest";

import { decryptKey, encryptKey } from "./crypto.js";

const SECRET = "a-master-key-of-at-least-32-characters!";
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";

describe("the provider key at rest", () => {
  it("round-trips, and never stores the key in clear", () => {
    const blob = encryptKey(SECRET, "anthropic", KEY);
    expect(blob.toString("utf8")).not.toContain("sk-ant");
    expect(decryptKey(SECRET, "anthropic", blob)).toBe(KEY);
  });

  it("uses a fresh nonce per write", () => {
    expect(encryptKey(SECRET, "anthropic", KEY).equals(encryptKey(SECRET, "anthropic", KEY))).toBe(false);
  });

  it("refuses another master key, another provider and a tampered blob", () => {
    const blob = encryptKey(SECRET, "anthropic", KEY);
    expect(() => decryptKey(`${SECRET}x`, "anthropic", blob)).toThrow();
    expect(() => decryptKey(SECRET, "openai", blob)).toThrow();
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => decryptKey(SECRET, "anthropic", tampered)).toThrow();
    expect(() => decryptKey(SECRET, "anthropic", Buffer.alloc(8))).toThrow();
  });
});
