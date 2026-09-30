/**
 * The attestation of a kiosk station (ADR-051 §5, N-SEC-19): Chrome Verified
 * Access, which proves that a key held by one of the school's Chromebooks, in
 * verified boot mode, answered a challenge Google issued.
 *
 * `KIOSK_ATTESTATION` picks one {@link KioskAttestor} at boot, like
 * `RUNNER_MODE` picks the runner: `google`, the real one; `mock`, the
 * development fixture (refused in production by `config.ts`); `off`, none —
 * and then the kiosk routes are not registered at all.
 *
 * Nothing here ever logs a challenge, a response, a token or the key: a
 * failure is logged by its kind and HTTP status only.
 */
import { createSign, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../../config.js";

/** What Google (or the mock) says of a response. */
export type Verdict =
  | { ok: true; googleDeviceId: string }
  /**
   * `refused`: the device is not one we admit, or the response is no good.
   * `unavailable`: nobody could tell — Google unreachable, slow, failing, or
   * our own credentials refused. ADR-051 §6 suspends a sitting on the first
   * and never on the second.
   */
  | { ok: false; reason: "refused" | "unavailable" };

export interface KioskAttestor {
  /** A fresh challenge, base64, valid one minute. Throws {@link AttestationUnavailable}. */
  challenge(): Promise<string>;
  /** Google's verdict on the extension's response to a challenge. Never throws. */
  verify(response: string): Promise<Verdict>;
}

/** No challenge could be obtained: the route answers 503. */
export class AttestationUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttestationUnavailable";
  }
}

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

const MOCK_DEVICE = /^mock:([A-Za-z0-9-]{1,64})$/;

/**
 * The development fixture: any challenge, and a response that names its own
 * device. `mock:refuse` and `mock:unavailable` produce the two failures, so
 * the tests and a developer can walk every branch without a Chromebook.
 */
export class MockAttestor implements KioskAttestor {
  async challenge(): Promise<string> {
    return randomBytes(32).toString("base64");
  }

  async verify(response: string): Promise<Verdict> {
    if (response === "mock:refuse") return { ok: false, reason: "refused" };
    if (response === "mock:unavailable") return { ok: false, reason: "unavailable" };
    const match = MOCK_DEVICE.exec(response);
    return match ? { ok: true, googleDeviceId: match[1]! } : { ok: false, reason: "refused" };
  }
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

export const VERIFIED_ACCESS = "https://verifiedaccess.googleapis.com/v2";
export const VERIFIED_ACCESS_SCOPE = "https://www.googleapis.com/auth/verifiedaccess";
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** The one trust level we admit: a Chromebook in verified boot mode, never developer mode. */
const VERIFIED_MODE = "CHROME_OS_VERIFIED_MODE";
/** A token is renewed this long before Google says it expires. */
const TOKEN_MARGIN_MS = 60_000;
/** Lifetime of the assertion we sign; Google accepts at most one hour. */
const ASSERTION_SECONDS = 3600;

/** The fields of a service account's JSON key that the grant reads. */
interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

export interface GoogleAttestorOptions {
  /** Reads the service account's JSON key; called when a token is needed, never cached beyond the process. */
  readKey: () => Promise<string>;
  customerId: string;
  enrollmentDomain: string;
  fetch?: typeof fetch;
  /** Per request, the token grant included. */
  timeoutMs?: number;
  /** Milliseconds since the epoch; the token cache's clock. */
  now?: () => number;
  log?: Pick<FastifyBaseLogger, "warn">;
}

/** Why a call failed, told apart from a refusal. */
class Unavailable extends Error {}

const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/**
 * Chrome Verified Access, API v2. The service account authenticates with the
 * OAuth 2.0 JWT-bearer grant (RFC 7523), signed here with `node:crypto`; the
 * access token is kept in memory until a minute before it expires.
 */
export class GoogleAttestor implements KioskAttestor {
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly opts: GoogleAttestorOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.now = opts.now ?? Date.now;
  }

  async challenge(): Promise<string> {
    try {
      const res = await this.call("challenge:generate", {});
      if (!res.ok) throw new Unavailable(`challenge:generate answered ${res.status}`);
      const body = (await res.json()) as { challenge?: unknown };
      if (typeof body.challenge !== "string" || body.challenge === "") {
        throw new Unavailable("challenge:generate answered no challenge");
      }
      return body.challenge;
    } catch (err) {
      this.warn(err, "kiosk attestation: no challenge");
      throw new AttestationUnavailable("no challenge");
    }
  }

  async verify(response: string): Promise<Verdict> {
    let res: Response;
    try {
      res = await this.call("challenge:verify", {
        challengeResponse: response,
        expectedIdentity: this.opts.enrollmentDomain,
      });
    } catch (err) {
      this.warn(err, "kiosk attestation: verify failed");
      return { ok: false, reason: "unavailable" };
    }
    if (!res.ok) {
      // Our own credentials refused (401, 403) or a quota (429) say nothing of
      // the device: treating them as a refusal would suspend every station in
      // the room at once, the outage ADR-051 §6 refuses to punish. Any other
      // 4xx is Google refusing THIS response.
      if (res.status === 401) this.token = null;
      const ours = res.status === 401 || res.status === 403 || res.status === 429;
      const reason = res.status >= 500 || ours ? "unavailable" : "refused";
      this.opts.log?.warn({ status: res.status, reason }, "kiosk attestation: verify answered an error");
      return { ok: false, reason };
    }
    let body: { customerId?: unknown; keyTrustLevel?: unknown; devicePermanentId?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch (err) {
      this.warn(err, "kiosk attestation: unreadable verdict");
      return { ok: false, reason: "unavailable" };
    }
    if (
      body.customerId !== this.opts.customerId ||
      body.keyTrustLevel !== VERIFIED_MODE ||
      typeof body.devicePermanentId !== "string" ||
      body.devicePermanentId === ""
    ) {
      this.opts.log?.warn(
        { keyTrustLevel: body.keyTrustLevel, customerMatches: body.customerId === this.opts.customerId },
        "kiosk attestation: refused",
      );
      return { ok: false, reason: "refused" };
    }
    return { ok: true, googleDeviceId: body.devicePermanentId };
  }

  /** One authenticated POST to Verified Access. Throws on a network failure or a timeout. */
  private async call(method: string, body: object): Promise<Response> {
    const token = await this.accessToken();
    return this.fetch(`${VERIFIED_ACCESS}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt - TOKEN_MARGIN_MS) return this.token.value;
    const key = await this.serviceAccount();
    const iat = Math.floor(this.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(
      JSON.stringify({
        iss: key.client_email,
        scope: VERIFIED_ACCESS_SCOPE,
        aud: key.token_uri,
        iat,
        exp: iat + ASSERTION_SECONDS,
      }),
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const assertion = `${header}.${claims}.${signer.sign(key.private_key).toString("base64url")}`;
    const res = await this.fetch(key.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: JWT_BEARER, assertion }).toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Unavailable(`token grant answered ${res.status}`);
    const grant = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof grant.access_token !== "string" || typeof grant.expires_in !== "number") {
      throw new Unavailable("token grant answered no token");
    }
    this.token = { value: grant.access_token, expiresAt: this.now() + grant.expires_in * 1000 };
    return grant.access_token;
  }

  private async serviceAccount(): Promise<ServiceAccountKey> {
    let key: Partial<ServiceAccountKey>;
    try {
      key = JSON.parse(await this.opts.readKey()) as Partial<ServiceAccountKey>;
    } catch {
      // The message of a JSON error may quote the file: never pass it on.
      throw new Unavailable("service account key unreadable");
    }
    if (!key.client_email || !key.private_key || !key.token_uri) {
      throw new Unavailable("service account key incomplete");
    }
    return key as ServiceAccountKey;
  }

  /** The kind of a failure, never its payload. */
  private warn(err: unknown, msg: string) {
    const kind =
      err instanceof Unavailable
        ? err.message
        : err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
          ? "timeout"
          : "network";
    this.opts.log?.warn({ kind }, msg);
  }
}

/** The attestor `KIOSK_ATTESTATION` names; null when the kiosk path is off. */
export function createKioskAttestor(
  config: Pick<
    AppConfig,
    "KIOSK_ATTESTATION" | "KIOSK_VA_KEY_FILE" | "KIOSK_GOOGLE_CUSTOMER_ID" | "KIOSK_ENROLLMENT_DOMAIN"
  >,
  log?: Pick<FastifyBaseLogger, "warn">,
): KioskAttestor | null {
  switch (config.KIOSK_ATTESTATION) {
    case "off":
      return null;
    case "mock":
      return new MockAttestor();
    case "google":
      return new GoogleAttestor({
        readKey: () => readFile(config.KIOSK_VA_KEY_FILE, "utf8"),
        customerId: config.KIOSK_GOOGLE_CUSTOMER_ID,
        enrollmentDomain: config.KIOSK_ENROLLMENT_DOMAIN,
        ...(log ? { log } : {}),
      });
  }
}

declare module "fastify" {
  interface FastifyInstance {
    /** Null when `KIOSK_ATTESTATION=off`: no kiosk route exists. */
    kioskAttestor: KioskAttestor | null;
  }
}
