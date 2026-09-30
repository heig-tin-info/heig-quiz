// Base64 <-> bytes, for the challenge and its response (ADR-051 §5).
// Google's Verified Access API returns protobuf `bytes`, i.e. standard
// base64; the URL-safe alphabet is accepted too, padding optional.

const PATTERN = /^[A-Za-z0-9+/_-]*={0,2}$/;

/** Decodes base64 to an ArrayBuffer, or returns null when it is not base64. */
export function decodeBase64(text) {
  if (typeof text !== "string" || text.length === 0 || !PATTERN.test(text)) return null;
  let s = text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (s.length % 4 === 1) return null;
  s += "=".repeat((4 - (s.length % 4)) % 4);
  let binary;
  try {
    binary = atob(s);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Encodes an ArrayBuffer (or a view on one) to standard, padded base64. */
export function encodeBase64(buffer) {
  const bytes = ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
