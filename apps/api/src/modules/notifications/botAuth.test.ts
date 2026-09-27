/**
 * The authentication of Bot Connector's calls (ADR-030), against a locally
 * generated key served through the real metadata and JWKS URLs.
 */
import { describe, expect, it } from "vitest";

import { fakeBotFramework, type FakeBotFramework } from "../../test/botFramework.js";
import { BotAuthError, createBotTokenVerifier } from "./botAuth.js";

const APP_ID = "00000000-0000-4000-8000-00000000b07";
const SERVICE_URL = "https://smba.trafficmanager.net/emea/";

function verifierOver(bf: FakeBotFramework) {
  const fetchImpl = (async (input: string | URL) =>
    bf.answer(String(input)) ?? new Response("unexpected", { status: 599 })) as typeof fetch;
  return createBotTokenVerifier({ appId: APP_ID, fetchImpl });
}

async function refusal(promise: Promise<unknown>): Promise<BotAuthError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BotAuthError);
  return err as BotAuthError;
}

describe("the Bot Connector token", () => {
  it("is accepted when signed by a published key, for us, by Bot Framework, in time", async () => {
    const bf = await fakeBotFramework({ appId: APP_ID, serviceUrl: SERVICE_URL, endorsements: ["msteams", "skype"] });
    const verifier = verifierOver(bf);
    expect(await verifier.verify(`Bearer ${await bf.sign()}`)).toEqual({ serviceUrl: SERVICE_URL });
    // The keys are cached: a second token costs no fetch.
    await verifier.verify(`Bearer ${await bf.sign()}`);
    expect(bf.jwksFetches()).toBe(1);
  });

  it("is also accepted when the key carries no endorsements at all", async () => {
    const bf = await fakeBotFramework({ appId: APP_ID, serviceUrl: SERVICE_URL });
    expect(await verifierOver(bf).verify(`Bearer ${await bf.sign()}`)).toEqual({ serviceUrl: SERVICE_URL });
  });

  it("is refused for another audience, another issuer, or once expired", async () => {
    const bf = await fakeBotFramework({ appId: APP_ID, serviceUrl: SERVICE_URL });
    const verifier = verifierOver(bf);
    const past = Math.floor(Date.now() / 1000) - 10 * 60;
    const cases = [
      await bf.sign({ aud: "another-bot" }),
      await bf.sign({ iss: "https://sts.windows.net/96412a41-a2a2-422e-8438-f29c95c02686/" }),
      await bf.sign({ iss: "https://login.microsoftonline.com/96412a41-a2a2-422e-8438-f29c95c02686/v2.0" }),
      await bf.sign({}, { expiresIn: past, issuedAt: past - 3600 }),
    ];
    for (const token of cases) {
      expect((await refusal(verifier.verify(`Bearer ${token}`))).status).toBe(401);
    }
  });

  it("tolerates Microsoft's clock skew of a few minutes", async () => {
    const bf = await fakeBotFramework({ appId: APP_ID, serviceUrl: SERVICE_URL });
    const recent = Math.floor(Date.now() / 1000) - 2 * 60;
    await expect(
      verifierOver(bf).verify(`Bearer ${await bf.sign({}, { expiresIn: recent, issuedAt: recent - 600 })}`),
    ).resolves.toEqual({ serviceUrl: SERVICE_URL });
  });

  it("is refused when signed by a key Microsoft does not publish", async () => {
    const bf = await fakeBotFramework({ appId: APP_ID, serviceUrl: SERVICE_URL });
    const verifier = verifierOver(bf);
    expect((await refusal(verifier.verify(`Bearer ${await bf.sign({}, { key: "rogue" })}`))).status).toBe(401);
    expect((await refusal(verifier.verify(`Bearer ${await bf.sign({}, { kid: "unknown" })}`))).status).toBe(401);
  });

  it("is refused with a 403 when the key is not endorsed for Teams", async () => {
    const bf = await fakeBotFramework({ appId: APP_ID, serviceUrl: SERVICE_URL, endorsements: ["skype", "webchat"] });
    expect((await refusal(verifierOver(bf).verify(`Bearer ${await bf.sign()}`))).status).toBe(403);
  });

  it("is refused without a serviceUrl claim, without a bearer, or malformed", async () => {
    const bf = await fakeBotFramework({ appId: APP_ID, serviceUrl: SERVICE_URL });
    const verifier = verifierOver(bf);
    await refusal(verifier.verify(`Bearer ${await bf.sign({ serviceurl: undefined })}`));
    await refusal(verifier.verify(undefined));
    await refusal(verifier.verify(await bf.sign()));
    await refusal(verifier.verify("Bearer not.a.jwt"));
  });

  it("reads the `serviceUrl` spelling too", async () => {
    const bf = await fakeBotFramework({ appId: APP_ID, serviceUrl: SERVICE_URL });
    const token = await bf.sign({ serviceurl: undefined, serviceUrl: "https://smba.trafficmanager.net/amer/" });
    expect(await verifierOver(bf).verify(`Bearer ${token}`)).toEqual({
      serviceUrl: "https://smba.trafficmanager.net/amer/",
    });
  });
});
