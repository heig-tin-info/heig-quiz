# Privacy policy — HEIG Quiz kiosk attestation

*Chrome extension `bmmpdeokkofdpapeiajjgabecddmafhf`. Last updated: 8 October 2026.*

This policy covers the Chrome extension **HEIG Quiz — kiosk attestation**. It
is published by the maintainers of HEIG Quiz, the exam platform of the HEIG-VD
at `https://quiz.chevallier.io`.

## What the extension does

The extension is force-installed by the school's Google Admin policy on the
ChromeOS kiosk stations used for exams. It has no user interface. When the
HEIG Quiz exam page asks for it, the extension signs a Chrome Verified Access
challenge with the device's machine key
(`chrome.enterprise.platformKeys.challengeKey`) and returns the signature to
that page. It answers only the pages of `https://quiz.chevallier.io` and
`https://quiz.dev.chevallier.io`.

## Data the extension handles

- **It collects no personal data.** It reads no page content, browsing
  history, cookies, keystrokes, location, or anything a user types.
- **It sends nothing on its own.** It makes no network request. It returns
  the signed challenge to the exam page, which sends it to the HEIG Quiz
  server.
- **It stores nothing.** It keeps no local storage, sync storage or log.

The signed challenge identifies the **device**, not a person: Google's
Verified Access API tells the HEIG Quiz server the device's permanent id and
the Google Workspace and domain it is enrolled in.

## What the HEIG Quiz server does with it

The server forwards the signed challenge to Google's Verified Access API to
check that the device is one of the school's managed Chromebooks, in verified
boot mode. It keeps a record of each station: the device id, the name an
administrator gives it, its status, and the time of its last check. This
record serves only to admit exam stations and is visible only to the
platform's administrators. It is kept while the station is in service and
retired by an administrator when the station leaves it.

No data from the extension is sold, shared with third parties other than
Google's Verified Access API, used for advertising, or used for any purpose
other than verifying exam stations.

## Contact

Questions about this policy: open an issue at
<https://github.com/heig-tin-info/heig-quiz/issues>.

## Changes

A change to this policy is published at this address, with a new date above.
