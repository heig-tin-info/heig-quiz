/**
 * The HMAC check of a GitHub webhook delivery (N-SEC-17): `X-Hub-Signature-256`
 * is `sha256=<hex>` of the RAW body under the App's webhook secret, compared
 * in constant time. `/webhooks/github` (M2-04) trusts nothing before this
 * says true. Ported from classroom's `modules/webhooks.ts`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

export function verifySignature(secret: string, raw: Buffer, header: string | undefined): boolean {
  // An empty secret signs nothing: an App without one accepts no delivery.
  if (secret === "" || !header?.startsWith(PREFIX)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  const received = Buffer.from(header.slice(PREFIX.length), "hex");
  // `Buffer.from(…, "hex")` stops at the first non-hex character, so the
  // length is checked on the DECODED bytes: classroom compared the strings,
  // and a 64-character header with a stray character made timingSafeEqual
  // throw instead of answering false.
  if (received.length !== expected.length) return false;
  return timingSafeEqual(expected, received);
}
