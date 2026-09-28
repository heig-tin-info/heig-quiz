/**
 * The Teams SSO token of the tab (ADR-030), against a locally generated key
 * served at Entra's real JWKS URL: every check of `ssoAuth.ts`, one at a time.
 */
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { ENTRA_TENANT, fakeEntra, type FakeEntra } from "../../test/entra.js";
import { createSsoTokenVerifier, SsoAuthError, TEAMS_CLIENT_APP_IDS } from "./ssoAuth.js";

const APP_ID = "31583357-0d89-48ab-8eeb-e9bc49f9e243";
const OTHER_TENANT = "96412a41-a2a2-422e-8438-f29c95c02686";

function verifierOver(entra: FakeEntra, tenants: readonly string[] = [ENTRA_TENANT]) {
  const fetchImpl = (async (input: string | URL) =>
    entra.answer(String(input)) ?? new Response("unexpected", { status: 599 })) as typeof fetch;
  return createSsoTokenVerifier({ appId: APP_ID, tenants, fetchImpl });
}

async function refusal(promise: Promise<unknown>): Promise<SsoAuthError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SsoAuthError);
  return err as SsoAuthError;
}

describe("the Teams SSO token", () => {
  it("is accepted from a Teams client, for our API, of an allowed tenant, in time", async () => {
    const entra = await fakeEntra({ appId: APP_ID });
    const verifier = verifierOver(entra);
    expect(await verifier.verify(`Bearer ${await entra.sign()}`)).toEqual({
      tenantId: ENTRA_TENANT,
      aadObjectId: "0f1e2d3c-0000-4000-8000-00000000a1d1",
      teamsName: "Léa Rochat",
      teamsUsername: "lea.rochat@heig-vd.ch",
    });
    // Teams on the web, and more than one scope.
    await verifier.verify(`Bearer ${await entra.sign({ azp: TEAMS_CLIENT_APP_IDS[1], scp: "openid access_as_user" })}`);
    // The keys are cached: three tokens, one fetch.
    await verifier.verify(`Bearer ${await entra.sign()}`);
    expect(entra.jwksFetches()).toBe(1);
  });

  it("admits any tenant when the list is empty, and lower-cases the tenant", async () => {
    const entra = await fakeEntra({ appId: APP_ID });
    const upper = OTHER_TENANT.toUpperCase();
    const token = await entra.sign({ tid: upper });
    expect((await verifierOver(entra, []).verify(`Bearer ${token}`)).tenantId).toBe(OTHER_TENANT);
  });

  it("falls back on the username, then the object id, for a name", async () => {
    const entra = await fakeEntra({ appId: APP_ID });
    const verifier = verifierOver(entra);
    expect((await verifier.verify(`Bearer ${await entra.sign({ name: undefined })}`)).teamsName).toBe(
      "lea.rochat@heig-vd.ch",
    );
    const bare = await verifier.verify(`Bearer ${await entra.sign({ name: undefined, preferred_username: undefined })}`);
    expect(bare).toMatchObject({ teamsName: "0f1e2d3c-0000-4000-8000-00000000a1d1", teamsUsername: "" });
  });

  it("is refused with a 401 for every broken claim", async () => {
    const entra = await fakeEntra({ appId: APP_ID });
    const verifier = verifierOver(entra, []);
    const past = Math.floor(Date.now() / 1000) - 10 * 60;
    const cases: [string, string][] = [
      ["another audience", await entra.sign({ aud: "api://quiz.chevallier.io/other" })],
      ["a v1 issuer", await entra.sign({ iss: `https://sts.windows.net/${ENTRA_TENANT}/` })],
      ["the issuer of another tenant", await entra.sign({ iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` })],
      ["the common issuer", await entra.sign({ iss: "https://login.microsoftonline.com/common/v2.0" })],
      ["no scope", await entra.sign({ scp: undefined })],
      ["another scope", await entra.sign({ scp: "User.Read" })],
      ["an application token", await entra.sign({ scp: undefined, roles: ["x"], idtyp: "app" })],
      ["an app token with a scope", await entra.sign({ idtyp: "app" })],
      ["not a Teams client", await entra.sign({ azp: "00000000-0000-4000-8000-000000000bad" })],
      ["no azp", await entra.sign({ azp: undefined })],
      ["no oid", await entra.sign({ oid: undefined })],
      ["no tid", await entra.sign({ tid: undefined })],
      ["a tid that is no tenant id", await entra.sign({ tid: "common" })],
      ["expired", await entra.sign({}, { expiresIn: past, issuedAt: past - 3600 })],
      ["not yet valid", await entra.sign({ nbf: Math.floor(Date.now() / 1000) + 30 * 60 })],
      ["a key Entra does not publish", await entra.sign({}, { key: "rogue" })],
      ["an unknown key id", await entra.sign({}, { kid: "unknown" })],
    ];
    for (const [what, token] of cases) {
      expect((await refusal(verifier.verify(`Bearer ${token}`))).status, what).toBe(401);
    }
  });

  it("is refused with a 403 for a tenant not allowed", async () => {
    const entra = await fakeEntra({ appId: APP_ID });
    const token = await entra.sign({ tid: OTHER_TENANT });
    const err = await refusal(verifierOver(entra).verify(`Bearer ${token}`));
    expect(err.status).toBe(403);
    expect(err.message).toBe("tenant not allowed");
  });

  it("tolerates five minutes of clock skew", async () => {
    const entra = await fakeEntra({ appId: APP_ID });
    const recent = Math.floor(Date.now() / 1000) - 2 * 60;
    const token = await entra.sign({}, { expiresIn: recent, issuedAt: recent - 600 });
    await expect(verifierOver(entra).verify(`Bearer ${token}`)).resolves.toMatchObject({ tenantId: ENTRA_TENANT });
  });

  it("refuses an unsigned token and a symmetric one", async () => {
    const entra = await fakeEntra({ appId: APP_ID });
    const verifier = verifierOver(entra);
    const valid = await entra.sign();
    const [, body] = valid.split(".");
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${body}.`;
    await refusal(verifier.verify(`Bearer ${none}`));
    await refusal(verifier.verify(`Bearer ${none}x`));
    const claims = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as Record<string, unknown>;
    const hs = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", kid: "key-1" })
      .sign(new TextEncoder().encode("a shared secret of thirty-two bytes!"));
    await refusal(verifier.verify(`Bearer ${hs}`));
  });

  it("refuses a missing, bare or malformed bearer", async () => {
    const entra = await fakeEntra({ appId: APP_ID });
    const verifier = verifierOver(entra);
    await refusal(verifier.verify(undefined));
    await refusal(verifier.verify(await entra.sign()));
    await refusal(verifier.verify("Bearer not.a.jwt"));
    await refusal(verifier.verify("Basic abc"));
  });
});
