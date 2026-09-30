// The kiosk station's companion extension (ADR-051 §5): the exam page hands it
// a Verified Access challenge, it answers with the device's MACHINE key.
import { decodeBase64, encodeBase64 } from "./base64.js";

// Checked again here, beyond `externally_connectable` (defence in depth).
export const ALLOWED_ORIGINS = new Set([
  "https://quiz.chevallier.io",
  "https://quiz.dev.chevallier.io",
]);

// A Verified Access challenge is a few hundred bytes; refuse anything absurd.
const MAX_CHALLENGE_LENGTH = 8192;

/** Builds the onMessageExternal listener around a `chrome` object. */
export function createListener(chromeApi) {
  return (message, sender, sendResponse) => {
    handle(chromeApi, message, sender).then(sendResponse, (e) =>
      sendResponse({ ok: false, error: "challenge_failed", detail: String(e?.message ?? e) }),
    );
    return true; // sendResponse is called asynchronously
  };
}

async function handle(chromeApi, message, sender) {
  if (!sender || !ALLOWED_ORIGINS.has(sender.origin)) return { ok: false, error: "bad_request" };
  if (message?.type === "ping") {
    return { ok: true, version: chromeApi.runtime.getManifest().version };
  }
  if (message?.type !== "attest") return { ok: false, error: "bad_request" };

  const text = message.challenge;
  const challenge =
    typeof text === "string" && text.length <= MAX_CHALLENGE_LENGTH ? decodeBase64(text) : null;
  if (!challenge || challenge.byteLength === 0) return { ok: false, error: "bad_request" };

  const platformKeys = chromeApi.enterprise?.platformKeys;
  if (typeof platformKeys?.challengeKey !== "function") {
    return { ok: false, error: "api_unavailable" };
  }
  const response = await challengeMachineKey(chromeApi, platformKeys, challenge);
  return { ok: true, response: encodeBase64(response) };
}

// The callback form: supported since challengeKey exists (Chrome 110).
function challengeMachineKey(chromeApi, platformKeys, challenge) {
  return new Promise((resolve, reject) => {
    platformKeys.challengeKey({ scope: "MACHINE", challenge }, (response) => {
      const error = chromeApi.runtime.lastError;
      if (error) reject(new Error(error.message ?? "lastError"));
      else if (!response) reject(new Error("empty response"));
      else resolve(response);
    });
  });
}

if (globalThis.chrome?.runtime?.onMessageExternal) {
  chrome.runtime.onMessageExternal.addListener(createListener(chrome));
}
