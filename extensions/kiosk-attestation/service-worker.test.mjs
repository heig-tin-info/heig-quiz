import assert from "node:assert/strict";
import { test } from "node:test";
import { createListener } from "./service-worker.js";

const QUIZ = { origin: "https://quiz.chevallier.io" };
const STAGING = { origin: "https://quiz.dev.chevallier.io" };

function fakeChrome({ challengeKey, lastError } = {}) {
  const api = {
    runtime: { getManifest: () => ({ version: "1.0.0" }), lastError: undefined },
    enterprise: challengeKey === undefined ? undefined : { platformKeys: { challengeKey } },
  };
  if (challengeKey) {
    api.enterprise.platformKeys.challengeKey = (options, callback) => {
      api.runtime.lastError = lastError;
      challengeKey(options, callback);
      api.runtime.lastError = undefined;
    };
  }
  return api;
}

function send(chromeApi, message, sender) {
  return new Promise((resolve) => {
    const returned = createListener(chromeApi)(message, sender, resolve);
    assert.equal(returned, true);
  });
}

test("ping answers the version, on both origins", async () => {
  for (const sender of [QUIZ, STAGING]) {
    assert.deepEqual(await send(fakeChrome(), { type: "ping" }, sender), {
      ok: true,
      version: "1.0.0",
    });
  }
});

test("refuses any other origin, and a missing one", async () => {
  for (const sender of [{ origin: "https://evil.example" }, { url: "https://quiz.chevallier.io/" }, undefined]) {
    assert.deepEqual(await send(fakeChrome(), { type: "ping" }, sender), {
      ok: false,
      error: "bad_request",
    });
  }
});

test("refuses unknown messages and malformed challenges", async () => {
  const chromeApi = fakeChrome({ challengeKey: () => assert.fail("must not be called") });
  for (const message of [null, "ping", { type: "other" }, { type: "attest" }, { type: "attest", challenge: "@@" }, { type: "attest", challenge: "A".repeat(10_000) }]) {
    assert.deepEqual(await send(chromeApi, message, QUIZ), { ok: false, error: "bad_request" });
  }
});

test("attest calls challengeKey with the MACHINE key and returns base64", async () => {
  let seen;
  const chromeApi = fakeChrome({
    challengeKey: (options, callback) => {
      seen = options;
      callback(Uint8Array.from([9, 8, 7]).buffer);
    },
  });
  const reply = await send(chromeApi, { type: "attest", challenge: "AQID" }, QUIZ);
  assert.deepEqual(reply, { ok: true, response: "CQgH" });
  assert.equal(seen.scope, "MACHINE");
  assert.deepEqual([...new Uint8Array(seen.challenge)], [1, 2, 3]);
});

test("api_unavailable when the enterprise API is missing", async () => {
  assert.deepEqual(await send(fakeChrome(), { type: "attest", challenge: "AQID" }, QUIZ), {
    ok: false,
    error: "api_unavailable",
  });
});

test("challenge_failed carries lastError in detail", async () => {
  const chromeApi = fakeChrome({
    challengeKey: (_o, callback) => callback(undefined),
    lastError: { message: "Key not available" },
  });
  assert.deepEqual(await send(chromeApi, { type: "attest", challenge: "AQID" }, QUIZ), {
    ok: false,
    error: "challenge_failed",
    detail: "Key not available",
  });
});

test("challenge_failed when challengeKey throws", async () => {
  const chromeApi = fakeChrome({
    challengeKey: () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(await send(chromeApi, { type: "attest", challenge: "AQID" }, QUIZ), {
    ok: false,
    error: "challenge_failed",
    detail: "boom",
  });
});
