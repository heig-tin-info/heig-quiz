/**
 * Compact HS256 JWT, dependency-free and pure: Web Crypto only (a global in
 * Node >= 20 and in browsers), no I/O, no Node import. Carries the launch and
 * service tokens between the platform and the online workspace portal
 * (`packages/contracts/src/codespace.ts`, ADR-047).
 *
 * Ported from heig-classroom's `hs256.ts` (M6-01) so that a token it signs
 * verifies here, byte for byte. Deliberately minimal: one algorithm, no
 * header negotiation, `alg` checked strictly BEFORE the signature, the
 * signature compared by `crypto.subtle.verify` (constant time), then `exp`,
 * `iat`, `aud`, `iss` and, when asked, `jti`.
 *
 * Single use of a `jti` is the portal's business (it consumes the id), not
 * a property of this function.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function signHs256(claims: Record<string, unknown>, secret: string): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  const input = `${header}.${payload}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), enc.encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

export interface VerifyHs256Options {
  /** Expected `aud`; rejected when absent or different. */
  audience: string;
  /**
   * Expected `iss` (or any of several: the transition accepts two); rejected
   * when absent or different. Required: an unpinned issuer must not compile.
   */
  issuer: string | readonly string[];
  /** Reject a token without a non-empty string `jti` (the launch token). */
  requireJti?: boolean;
  /** Injectable clock (Unix seconds). */
  now?: () => number;
  /** Tolerance in seconds on `exp` and `iat` (default 30). */
  skewSeconds?: number;
}

export type Hs256Failure =
  | "malformed"
  | "bad-alg"
  | "bad-signature"
  | "expired"
  | "not-yet-valid"
  | "bad-audience"
  | "bad-issuer"
  | "missing-jti";

export type VerifyHs256Result<T> = { ok: true; claims: T } | { ok: false; reason: Hs256Failure };

export async function verifyHs256<T extends Record<string, unknown>>(
  token: string,
  secret: string,
  opts: VerifyHs256Options,
): Promise<VerifyHs256Result<T>> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: unknown };
  let claims: T;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    header = JSON.parse(dec.decode(unb64url(h))) as { alg?: unknown };
    claims = JSON.parse(dec.decode(unb64url(p))) as T;
    signature = unb64url(s);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof header !== "object" || header === null || typeof claims !== "object" || claims === null) {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "HS256") return { ok: false, reason: "bad-alg" };
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), signature, enc.encode(`${h}.${p}`));
  if (!valid) return { ok: false, reason: "bad-signature" };
  const now = opts.now?.() ?? Math.floor(Date.now() / 1000);
  const skew = opts.skewSeconds ?? 30;
  const exp = claims["exp"];
  const iat = claims["iat"];
  if (typeof exp !== "number" || exp + skew < now) return { ok: false, reason: "expired" };
  if (typeof iat === "number" && iat - skew > now) return { ok: false, reason: "not-yet-valid" };
  if (claims["aud"] !== opts.audience) return { ok: false, reason: "bad-audience" };
  const accepted = typeof opts.issuer === "string" ? [opts.issuer] : opts.issuer;
  const iss = claims["iss"];
  if (typeof iss !== "string" || !accepted.includes(iss)) return { ok: false, reason: "bad-issuer" };
  const jti = claims["jti"];
  if (opts.requireJti && (typeof jti !== "string" || jti === "")) return { ok: false, reason: "missing-jti" };
  return { ok: true, claims };
}
