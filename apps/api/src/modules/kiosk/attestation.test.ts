import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AttestationUnavailable,
  GoogleAttestor,
  MockAttestor,
  VERIFIED_ACCESS,
  VERIFIED_ACCESS_SCOPE,
} from "./attestation.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const KEY = JSON.stringify({
  type: "service_account",
  client_email: "kiosk@quiz.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  token_uri: TOKEN_URI,
});
const CUSTOMER = "C01abcdef";
const DOMAIN = "heig-vd.ch";

const GOOD = {
  devicePermanentId: "5CD1234XYZ",
  customerId: CUSTOMER,
  keyTrustLevel: "CHROME_OS_VERIFIED_MODE",
  attestedDeviceId: "5CD1234XYZ",
  deviceEnrollmentId: "enr-1",
};

interface Call {
  url: string;
  init: RequestInit;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A fake Google: the token endpoint grants `tok-<n>` for an hour, and
 * `verify` answers what the test says. Every call is recorded.
 */
function fakeGoogle(verify: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  let grants = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    if (call.url === TOKEN_URI) return json(200, { access_token: `tok-${++grants}`, expires_in: 3600, token_type: "Bearer" });
    if (call.url === `${VERIFIED_ACCESS}/challenge:generate`) return json(200, { challenge: "Q0hBTExFTkdF" });
    return verify(call);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, grants: () => grants };
}

function attestor(fetch: typeof globalThis.fetch, now = () => 1_790_000_000_000, timeoutMs = 5000) {
  return new GoogleAttestor({
    readKey: async () => KEY,
    customerId: CUSTOMER,
    enrollmentDomain: DOMAIN,
    fetch,
    now,
    timeoutMs,
  });
}

describe("GoogleAttestor", () => {
  it("grants a token with an RS256 assertion the service account's public key verifies", async () => {
    const google = fakeGoogle(() => json(200, GOOD));
    await attestor(google.fetch).challenge();

    const grant = google.calls[0]!;
    expect(grant.url).toBe(TOKEN_URI);
    expect(grant.init.method).toBe("POST");
    expect((grant.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const form = new URLSearchParams(grant.init.body as string);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = form.get("assertion")!.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(claims!, "base64url").toString());
    expect(payload).toEqual({
      iss: "kiosk@quiz.iam.gserviceaccount.com",
      scope: VERIFIED_ACCESS_SCOPE,
      aud: TOKEN_URI,
      iat: 1_790_000_000,
      exp: 1_790_003_600,
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  it("asks for a challenge with an empty body and the bearer token", async () => {
    const google = fakeGoogle(() => json(200, GOOD));
    expect(await attestor(google.fetch).challenge()).toBe("Q0hBTExFTkdF");
    const call = google.calls[1]!;
    expect(call.url).toBe(`${VERIFIED_ACCESS}/challenge:generate`);
    expect(call.init.body).toBe("{}");
    expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
  });

  it("accepts a verified-mode Chromebook of our customer, and sends the enrollment domain", async () => {
    const google = fakeGoogle(() => json(200, GOOD));
    expect(await attestor(google.fetch).verify("UkVTUE9OU0U=")).toEqual({
      ok: true,
      googleDeviceId: "5CD1234XYZ",
    });
    const call = google.calls.find((c) => c.url.endsWith("challenge:verify"))!;
    expect(JSON.parse(call.init.body as string)).toEqual({
      challengeResponse: "UkVTUE9OU0U=",
      expectedIdentity: DOMAIN,
    });
  });

  it.each([["C01abcdef"], ["01abcdef"]])("accepts the customer id %s, with or without its leading C", async (customerId) => {
    const google = fakeGoogle(() => json(200, { ...GOOD, customerId }));
    expect(await attestor(google.fetch).verify("x")).toMatchObject({ ok: true });
    // And the configured id may be written either way too.
    const bare = new GoogleAttestor({
      readKey: async () => KEY,
      customerId: "01abcdef",
      enrollmentDomain: DOMAIN,
      fetch: google.fetch,
      now: () => 1_790_000_000_000,
    });
    expect(await bare.verify("x")).toMatchObject({ ok: true });
  });

  it("logs the customer id Google returned when it is not ours", async () => {
    const google = fakeGoogle(() => json(200, { ...GOOD, customerId: "C0other" }));
    const warnings: unknown[] = [];
    const logged = new GoogleAttestor({
      readKey: async () => KEY,
      customerId: CUSTOMER,
      enrollmentDomain: DOMAIN,
      fetch: google.fetch,
      now: () => 1_790_000_000_000,
      log: { warn: ((obj: unknown) => warnings.push(obj)) as never },
    });
    expect(await logged.verify("x")).toEqual({ ok: false, reason: "refused" });
    expect(warnings).toContainEqual(expect.objectContaining({ customerMatches: false, customerId: "C0other" }));
  });

  it.each([
    ["another customer", { ...GOOD, customerId: "C0other" }],
    ["a lower-case c is not the prefix", { ...GOOD, customerId: "c01abcdef" }],
    ["developer mode", { ...GOOD, keyTrustLevel: "CHROME_OS_DEVELOPER_MODE" }],
    ["a browser key", { ...GOOD, keyTrustLevel: "CHROME_BROWSER_HW_KEY" }],
    ["no trust level", { ...GOOD, keyTrustLevel: undefined }],
    ["no device id (a USER key)", { ...GOOD, devicePermanentId: undefined }],
    ["an empty device id", { ...GOOD, devicePermanentId: "" }],
  ])("refuses %s", async (_, body) => {
    const google = fakeGoogle(() => json(200, body));
    expect(await attestor(google.fetch).verify("x")).toEqual({ ok: false, reason: "refused" });
  });

  it("refuses what Google refuses (400), and is unavailable on its own credentials, quota or outage", async () => {
    for (const [status, reason] of [
      [400, "refused"],
      [404, "refused"],
      [401, "unavailable"],
      [403, "unavailable"],
      [429, "unavailable"],
      [500, "unavailable"],
      [503, "unavailable"],
    ] as const) {
      const google = fakeGoogle(() => json(status, { error: { code: status } }));
      expect(await attestor(google.fetch).verify("x"), String(status)).toEqual({ ok: false, reason });
    }
  });

  it("is unavailable when the network fails or Google does not answer in time", async () => {
    const down = fakeGoogle(() => {
      throw new TypeError("fetch failed");
    });
    expect(await attestor(down.fetch).verify("x")).toEqual({ ok: false, reason: "unavailable" });

    const silent = fakeGoogle(
      (call) =>
        new Promise<Response>((_, reject) =>
          call.init.signal!.addEventListener("abort", () => reject(call.init.signal!.reason)),
        ),
    );
    expect(await attestor(silent.fetch, undefined, 20).verify("x")).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("is unavailable, and has no challenge, when no token can be had", async () => {
    const refusing = (async () => json(400, { error: "invalid_grant" })) as unknown as typeof fetch;
    expect(await attestor(refusing).verify("x")).toEqual({ ok: false, reason: "unavailable" });
    await expect(attestor(refusing).challenge()).rejects.toBeInstanceOf(AttestationUnavailable);

    const unreadable = new GoogleAttestor({
      readKey: async () => {
        throw new Error("ENOENT");
      },
      customerId: CUSTOMER,
      enrollmentDomain: DOMAIN,
      fetch: fakeGoogle(() => json(200, GOOD)).fetch,
    });
    expect(await unreadable.verify("x")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("keeps the token until a minute before it expires, and drops it on a 401", async () => {
    let now = 1_790_000_000_000;
    let status = 200;
    const google = fakeGoogle(() => json(status, GOOD));
    const va = attestor(google.fetch, () => now);
    await va.verify("x");
    await va.challenge();
    expect(google.grants()).toBe(1);

    now += (3600 - 61) * 1000;
    await va.verify("x");
    expect(google.grants()).toBe(1);
    now += 2000; // inside the last minute
    await va.verify("x");
    expect(google.grants()).toBe(2);

    status = 401;
    await va.verify("x");
    status = 200;
    await va.verify("x");
    expect(google.grants()).toBe(3);
  });
});

describe("MockAttestor", () => {
  const mock = new MockAttestor();

  it("issues a random base64 challenge", async () => {
    const a = await mock.challenge();
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(await mock.challenge()).not.toBe(a);
  });

  it("accepts mock:<id> exactly, and fails on demand", async () => {
    expect(await mock.verify("mock:station-7")).toEqual({ ok: true, googleDeviceId: "station-7" });
    expect(await mock.verify("mock:refuse")).toEqual({ ok: false, reason: "refused" });
    expect(await mock.verify("mock:unavailable")).toEqual({ ok: false, reason: "unavailable" });
    for (const bad of ["mock:", "mock:a b", `mock:${"x".repeat(65)}`, "station-7", " mock:x"]) {
      expect(await mock.verify(bad), bad).toEqual({ ok: false, reason: "refused" });
    }
  });
});
