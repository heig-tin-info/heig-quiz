import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBase64, encodeBase64 } from "./base64.js";

const bytes = (buffer) => [...new Uint8Array(buffer)];

test("round-trips every byte value", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  const text = encodeBase64(all.buffer);
  assert.equal(text, Buffer.from(all).toString("base64"));
  assert.deepEqual(bytes(decodeBase64(text)), [...all]);
});

test("encodes a view on part of a buffer", () => {
  const view = new Uint8Array([0, 1, 2, 3]).subarray(1, 3);
  assert.equal(encodeBase64(view), "AQI=");
});

test("encodes a large buffer", () => {
  const big = new Uint8Array(100_000).map((_, i) => i * 7);
  assert.equal(encodeBase64(big.buffer), Buffer.from(big).toString("base64"));
});

test("accepts the URL-safe alphabet and missing padding", () => {
  const raw = Uint8Array.from([0xfb, 0xff, 0xbf, 0x01]);
  assert.deepEqual(bytes(decodeBase64("+/+/AQ==")), [...raw]);
  assert.deepEqual(bytes(decodeBase64("-_-_AQ")), [...raw]);
});

test("refuses what is not base64", () => {
  for (const bad of ["", "a", "abc$", "ab=c", "abc===", null, undefined, 42, {}]) {
    assert.equal(decodeBase64(bad), null, String(bad));
  }
});
