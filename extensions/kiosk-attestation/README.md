# kiosk-attestation — the kiosk stations' companion extension

A Manifest V3 Chrome extension, force-installed on the school's ChromeOS
kiosk stations. It lets the exam page prove that it runs on one of those
stations: the page hands it a Verified Access challenge, the extension signs
it with the device's **machine key** through
[`chrome.enterprise.platformKeys.challengeKey`](https://developer.chrome.com/docs/extensions/reference/api/enterprise/platformKeys),
and the page sends the response to the API, which has Google verify it
(ADR-051 §5, `docs/adr/ADR-051-postes-kiosque-attestes.md`).

Why an extension: a web page cannot reach the platform keys; only an
extension installed by policy on a managed ChromeOS device can. The
extension holds no secret, sends nothing anywhere on its own, has no host
permission and no content script: it answers the page, and only the page.

Plain JavaScript, no build step. It is not a pnpm workspace package.

## Files

| File | What it is |
| --- | --- |
| `manifest.json` | MV3 manifest: `enterprise.platformKeys`, a module service worker, `externally_connectable` for production and staging |
| `service-worker.js` | the `onMessageExternal` listener |
| `base64.js` | base64 <-> `ArrayBuffer` |
| `*.test.mjs` | unit tests, plain Node, no dependency |

```bash
node --test extensions/kiosk-attestation/*.test.mjs
```

(Node 22 does not take a directory as a `--test` argument; the glob does.
Node warns that the `.js` files have no declared module type: harmless, and
the extension deliberately has no `package.json`.)

## The message protocol

The page calls `chrome.runtime.sendMessage(KIOSK_EXTENSION_ID, message, callback)`.
Only `https://quiz.chevallier.io` (production) and
`https://quiz.dev.chevallier.io` (staging) can: `externally_connectable`
lists them, and the service worker checks `sender.origin` again. Any other
sender gets `bad_request`.

Accepting staging on a production station is harmless: the extension signs
a challenge, and only the server that issued it can use the answer. Staging
verifies against its own Google service account (never production's,
ADR-010), registers its own stations and opens sessions only on staging; a
signed staging challenge proves nothing to production, which never issued it.

| Message | Reply |
| --- | --- |
| `{type: "ping"}` | `{ok: true, version: "1.0.0"}` — lets the page detect the extension |
| `{type: "attest", challenge: "<base64>"}` | `{ok: true, response: "<base64>"}` |
| anything else | `{ok: false, error: "bad_request"}` |

The challenge is the `challenge` field of Google's `challenge:generate`,
as the API returns it (standard base64; the URL-safe alphabet is accepted).
The response is the signed challenge, standard base64, to pass unchanged as
`challengeResponse` to `challenge:verify`.

Failures are `{ok: false, error: <code>}`, with a stable code:

| Code | Meaning |
| --- | --- |
| `bad_request` | wrong origin, unknown message, missing or non-base64 challenge |
| `api_unavailable` | `chrome.enterprise.platformKeys.challengeKey` does not exist here (not ChromeOS, not managed, not policy-installed) |
| `challenge_failed` | `challengeKey` failed; the `detail` field carries `chrome.runtime.lastError`'s message (or the exception's) |

The page shows none of it to the student. It reports the failure to
`/app/api/kiosk/attest/verify` in place of a response, and the server logs
the code only (ADR-051 §6: an extension failure counts as refused).

If the extension is not installed at all, `sendMessage` itself fails
(`chrome.runtime.lastError`, or `chrome.runtime` is undefined on the page):
that is the page's case to handle, not the extension's.

## Loading it unpacked, for a test

`chrome://extensions` → **Developer mode** → **Load unpacked** → this folder.
The id Chrome shows is derived from the folder's path unless the manifest
carries a `key` (below).

An unpacked extension can check the protocol (`ping`, `bad_request`, the
origin check) but not the attestation: `challengeKey` exists only for an
extension force-installed by policy on a managed ChromeOS device
(`api_unavailable` elsewhere). A ChromeOS device in developer mode (the
OS's, not the extensions page's switch) would not pass either: the server
requires `keyTrustLevel = CHROME_OS_VERIFIED_MODE`. Without a station, use
`KIOSK_ATTESTATION=mock` on the API.

## A stable extension id

The API calls the extension by id: `KIOSK_EXTENSION_ID` in its
configuration, required when `KIOSK_ATTESTATION=google`. The id must
therefore never change.

- **Through the Chrome Web Store** (the recommended route): the Store
  assigns the id at the first upload and keeps it for every later version.
  Copy it from the developer dashboard into `KIOSK_EXTENSION_ID`.
- **Packed by hand** (`chrome://extensions` → **Pack extension**, or
  `chrome --pack-extension=<folder>`): the id derives from the `.pem`
  private key generated at the first pack. Keep that key out of the
  repository (ADR-010) and reuse it for every version. To give an unpacked
  copy the same id, put the base64 public key in the manifest's `key`
  field. A self-hosted `.crx` also needs an update URL the Admin console
  can reach; the Store avoids all of this.

To upload to the Store, zip the folder's content without the tests and
the README:

```bash
cd extensions/kiosk-attestation
zip kiosk-attestation-1.0.0.zip manifest.json service-worker.js base64.js
```

Bump `version` in `manifest.json` for every upload.

## Publishing in the Chrome Web Store

Publish with the visibility **Private** ("private to the domain", visible
only to the users of the school's Google Workspace) when the Workspace's
Store settings allow it: it is the recommended one. Otherwise publish as
**Unlisted**: anyone with the link can install it, but it does nothing
outside the two origins and without the enterprise policy, so there is
nothing to protect. Never **Public**.

The Store's **Privacy practices** tab needs a privacy policy URL that
leads directly to a policy, not to a README: link
[`PRIVACY.md`](PRIVACY.md) on `main`
(`https://github.com/heig-tin-info/heig-quiz/blob/main/extensions/kiosk-attestation/PRIVACY.md`).

## Deploying it on the kiosk stations

In the Google Admin console, on the organizational unit of the exam
stations:

1. **Devices › Chrome › Apps & extensions › Kiosks**, select the kiosk web
   app (the quiz's station page), and **add the extension** to it by its
   id, force-installed.
2. On the extension's settings, under **Certificate management**, enable
   **Allow enterprise challenge**. Without it `challengeKey` fails
   (`challenge_failed`).

The device policy of the OU (kiosk mode, verified boot, no developer mode)
is `docs/kiosk.md`'s subject, not this extension's.

What `challengeKey` needs, per Google's documentation
([platformKeys](https://developer.chrome.com/docs/extensions/reference/api/enterprise/platformKeys),
[kiosk mode detection](https://developers.google.com/chrome/verified-access/kiosk-mode-detection)):
a managed ChromeOS device and an extension installed by policy. The
`MACHINE` scope uses the device's key (the Enterprise Machine Key) and
yields the device id to the server; the `USER` scope, which Google's
kiosk-mode check uses, is not used here (ADR-051 §5).

> **Verify on hardware** (ADR-051 §10, step 0). Not yet observed on a real
> station:
> - that the kiosk web app's page reaches the extension through
>   `externally_connectable` (`ping` answers);
> - that `challengeKey` with `scope: "MACHINE"` succeeds for an extension
>   added to a **web** kiosk app, with "Allow enterprise challenge" on;
> - the exact Admin console path and label above, which Google renames from
>   time to time;
> - the `lastError` messages of the failure cases, which only reach the
>   `detail` field and are never matched on.
>
> Until step 0 is recorded, the API's `KIOSK_ATTESTATION=google` switch
> stays off in production.
