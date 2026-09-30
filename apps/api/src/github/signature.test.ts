import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifySignature } from "./signature.js";

const SECRET = "a-webhook-secret-of-32-characters!";
const body = Buffer.from('{"action":"opened","zen":"Keep it logically awesome."}');
const sign = (raw: Buffer, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

describe("verifySignature (N-SEC-17)", () => {
  it("accepts the signature of the raw body under the secret", () => {
    expect(verifySignature(SECRET, body, sign(body))).toBe(true);
  });

  it("refuses another body, another secret, or no header", () => {
    expect(verifySignature(SECRET, Buffer.from(`${body} `), sign(body))).toBe(false);
    expect(verifySignature(SECRET, body, sign(body, "another-secret"))).toBe(false);
    expect(verifySignature(SECRET, body, undefined)).toBe(false);
    expect(verifySignature(SECRET, body, "")).toBe(false);
  });

  it("refuses the SHA-1 header and a bare digest", () => {
    const sha1 = `sha1=${createHmac("sha1", SECRET).update(body).digest("hex")}`;
    expect(verifySignature(SECRET, body, sha1)).toBe(false);
    expect(verifySignature(SECRET, body, sign(body).slice("sha256=".length))).toBe(false);
  });

  it("answers false, never throws, on a malformed digest of the right length", () => {
    const good = sign(body);
    const tampered = `${good.slice(0, -1)}z`; // 64 characters, 31 bytes once decoded
    expect(() => verifySignature(SECRET, body, tampered)).not.toThrow();
    expect(verifySignature(SECRET, body, tampered)).toBe(false);
    expect(verifySignature(SECRET, body, `${good}00`)).toBe(false);
    expect(verifySignature(SECRET, body, "sha256=")).toBe(false);
  });

  it("accepts nothing when no secret is configured", () => {
    expect(verifySignature("", body, sign(body, ""))).toBe(false);
  });
});
