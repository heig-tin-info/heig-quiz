/**
 * Push errors worth retrying: GitHub provisions a freshly created repository
 * asynchronously, and an immediate push can hit a transient failure
 * ("the remote end hung up unexpectedly", "RPC failed; curl 55", HTTP 500).
 */
const TRANSIENT_PUSH =
  /error:? (500|502|503)|hung up unexpectedly|early EOF|RPC failed|Internal Server Error|Failed sending data/i;

/** The waits between attempts of a call GitHub may refuse while a fresh repository settles: a push, a signed commit (`signedCommit.ts`). */
export const RETRY_DELAYS_MS = [1000, 2000, 4000];

export async function pushWithRetry(fn: () => unknown): Promise<void> {
  const delays = RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fn();
      return;
    } catch (err) {
      // `gitRunner` rethrows a plain Error whose message carries git's
      // (redacted) stderr: the message is all there is to match.
      if (attempt >= delays.length || !TRANSIENT_PUSH.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}
