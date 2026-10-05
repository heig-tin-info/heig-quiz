import { describe, expect, it } from "vitest";

import { signHs256, verifyHs256 } from "./hs256.js";

const secret = "a-test-secret-that-is-long-enough";
const base = { iss: "heig-classroom", aud: "heig-codespace", iat: 1000, exp: 1300, jti: "j1", sub: "u1" };
const at = (t: number) => ({ audience: "heig-codespace", issuer: "heig-classroom", now: () => t });
const b64 = (v: unknown) => btoa(JSON.stringify(v)).replace(/=+$/, "");

describe("HS256", () => {
  it("signs then verifies", async () => {
    const token = await signHs256(base, secret);
    expect(token.split(".")).toHaveLength(3);
    expect(await verifyHs256<typeof base>(token, secret, at(1100))).toEqual({ ok: true, claims: base });
  });

  it("rejects a signature from another secret", async () => {
    const token = await signHs256(base, "another-secret-of-the-same-length!");
    expect(await verifyHs256(token, secret, at(1100))).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a tampered payload and a tampered signature", async () => {
    const [h, p, s] = (await signHs256(base, secret)).split(".") as [string, string, string];
    expect(await verifyHs256(`${h}.${b64({ ...base, sub: "u2" })}.${s}`, secret, at(1100))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    const flipped = s.slice(0, -2) + (s.endsWith("AA") ? "BB" : "AA");
    expect(await verifyHs256(`${h}.${p}.${flipped}`, secret, at(1100))).toEqual({ ok: false, reason: "bad-signature" });
    expect(await verifyHs256(`${h}.${p}.`, secret, at(1100))).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses any alg but HS256, even with a valid HMAC (algorithm confusion)", async () => {
    const p = b64(base);
    const none = b64({ alg: "none" });
    expect(await verifyHs256(`${none}.${p}.`, secret, at(1100))).toEqual({ ok: false, reason: "bad-alg" });
    // A genuine HMAC over a header that claims another algorithm.
    for (const alg of ["HS512", "RS256", "hs256", undefined]) {
      const h = b64({ alg, typ: "JWT" });
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h}.${p}`)));
      const s = btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      expect(await verifyHs256(`${h}.${p}.${s}`, secret, at(1100))).toEqual({ ok: false, reason: "bad-alg" });
    }
  });

  it("rejects malformed tokens", async () => {
    for (const t of ["abc", "a.b", "a.b.c.d", "!!.!!.!!", `${b64("x")}.${b64(null)}.AAAA`]) {
      expect(await verifyHs256(t, secret, at(1100))).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("enforces exp and iat, with a 30 s leeway", async () => {
    const token = await signHs256(base, secret);
    expect(await verifyHs256(token, secret, at(1330))).toMatchObject({ ok: true });
    expect(await verifyHs256(token, secret, at(1331))).toEqual({ ok: false, reason: "expired" });
    expect(await verifyHs256(token, secret, at(970))).toMatchObject({ ok: true });
    expect(await verifyHs256(token, secret, at(969))).toEqual({ ok: false, reason: "not-yet-valid" });
    const noExp = await signHs256({ ...base, exp: undefined }, secret);
    expect(await verifyHs256(noExp, secret, at(1100))).toEqual({ ok: false, reason: "expired" });
  });

  it("pins aud and iss", async () => {
    const token = await signHs256(base, secret);
    expect(await verifyHs256(token, secret, { audience: "other", issuer: "heig-classroom", now: () => 1100 })).toEqual({ ok: false, reason: "bad-audience" });
    expect(await verifyHs256(token, secret, { audience: "heig-codespace", issuer: "x", now: () => 1100 })).toEqual({ ok: false, reason: "bad-issuer" });
    const quiz = await signHs256({ ...base, iss: "heig-quiz" }, secret);
    const both = { audience: "heig-codespace", issuer: ["heig-classroom", "heig-quiz"], now: () => 1100 };
    expect(await verifyHs256(token, secret, both)).toMatchObject({ ok: true });
    expect(await verifyHs256(quiz, secret, both)).toMatchObject({ ok: true });
    const noIss = await signHs256({ ...base, iss: undefined }, secret);
    expect(await verifyHs256(noIss, secret, both)).toEqual({ ok: false, reason: "bad-issuer" });
  });

  it("requires a jti when asked", async () => {
    const noJti = await signHs256({ ...base, jti: undefined }, secret);
    const empty = await signHs256({ ...base, jti: "" }, secret);
    expect(await verifyHs256(noJti, secret, at(1100))).toMatchObject({ ok: true });
    expect(await verifyHs256(noJti, secret, { ...at(1100), requireJti: true })).toEqual({ ok: false, reason: "missing-jti" });
    expect(await verifyHs256(empty, secret, { ...at(1100), requireJti: true })).toEqual({ ok: false, reason: "missing-jti" });
    expect(await verifyHs256(await signHs256(base, secret), secret, { ...at(1100), requireJti: true })).toMatchObject({ ok: true });
  });
});
