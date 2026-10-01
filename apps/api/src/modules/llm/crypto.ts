/**
 * The provider key at rest (ADR-058 §3, N-SEC-08): AES-256-GCM under a key
 * derived from `LLM_KEY_SECRET` by HKDF-SHA-256, a fresh 12-byte nonce per
 * write, the provider id as additional authenticated data. The stored blob is
 * `nonce ‖ tag ‖ ciphertext`; the key itself is never stored.
 *
 * A blob that does not decrypt — the master key changed or was lost, or the
 * row was tampered with — throws: the gateway reports `key_unreadable` and an
 * administrator enters the key again. Nothing else is lost.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const NONCE = 12;
const TAG = 16;
const INFO = "quiz/llm-provider-key/v1";

function derive(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), INFO, 32));
}

export function encryptKey(secret: string, provider: string, key: string): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv("aes-256-gcm", derive(secret), nonce);
  cipher.setAAD(Buffer.from(provider));
  const body = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]);
}

export function decryptKey(secret: string, provider: string, blob: Buffer): string {
  if (blob.length <= NONCE + TAG) throw new Error("llm key blob too short");
  const decipher = createDecipheriv("aes-256-gcm", derive(secret), blob.subarray(0, NONCE));
  decipher.setAAD(Buffer.from(provider));
  decipher.setAuthTag(blob.subarray(NONCE, NONCE + TAG));
  return Buffer.concat([decipher.update(blob.subarray(NONCE + TAG)), decipher.final()]).toString("utf8");
}
