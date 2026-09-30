# Kiosk stations: the Chromebook setup

This page is for whoever administers the school's Chromebooks in the Google
Admin console and the platform's server. It sets up the attested kiosk
stations of [ADR-051](adr/ADR-051-postes-kiosque-attestes.md): Chromebooks
locked on `https://quiz.chevallier.io/kiosk`, where a student sits an exam
without Safe Exam Browser, unlocked by scanning a code with their phone.

!!! warning "Google moves its menus"
    The Admin console paths below come from Google's help pages as of
    September 2026. Where a path or a label could not be confirmed in
    Google's documentation, it is marked **(unverified)**. Trust the label
    you see on the screen over this page, and correct this page when they
    differ.

## What a station is, and what the attestation proves

A kiosk station is a Chromebook of the school's Google Workspace, in the
organizational unit of the exam stations, that auto-launches the platform's
`/kiosk` page as a web kiosk app. A companion extension, force-installed on
that kiosk app, lets the page prove to the server where it runs (Chrome
Verified Access):

- **Proven** by each attestation: a Chromebook managed by the school's
  Workspace (the customer id), in verified boot mode (never developer mode),
  holds the device key that answered a challenge Google issued, and Google
  names the device (`devicePermanentId`).
- **Not proven** by the attestation: that the Chromebook is in kiosk mode.
  That rests on the device policy of the stations' organizational unit
  (below) and on an administrator naming the station in the platform. The
  customer id admits every Chromebook of the Workspace, staff machines
  included; only a station an administrator has named can be paired.

A station attests before each new code it shows, so it is never silent
when a student starts sitting; it re-attests every 10 minutes while an exam
is sat on it, and once more when the hand-in finds its last check more than
two minutes old (ADR-051 §6). A re-attestation keeps the station's cookie
(`quiz_kiosk`) and only extends it: an answer saved while it is in flight
still belongs to the station.

## 1. Google Cloud: the service account

The server calls the Verified Access API as a service account.

1. In the [Google Cloud console](https://console.cloud.google.com), pick or
   create a project owned by the school.
2. **APIs & Services › Enabled APIs & services › Enable APIs and services**:
   enable **Chrome Verified Access API**.
3. **IAM & Admin › Service accounts › Create service account**: a name such
   as `quiz-verified-access`. It needs no IAM role on the project; its
   access is granted in the Admin console (step 2 below). Note its e-mail
   address (`…@<project>.iam.gserviceaccount.com`).
4. On that account, **Keys › Add key › Create new key › JSON**. The browser
   downloads the key once. It is a secret (ADR-010): never in git, never in
   a ticket, never on a shared drive.
5. Put the file on the application VM beside the edu-ID key, in `./secrets`,
   which compose mounts read-only at `/app/secrets`:

   ```bash
   # on the VM, in /srv/quiz, as srv
   install -m 600 ~/verified-access-key.json secrets/verified-access-key.json
   docker run --rm -v "$PWD":/w alpine sh -c 'chown 1000:1000 /w/secrets/verified-access-key.json'
   ```

   Then `KIOSK_VA_KEY_FILE=secrets/verified-access-key.json` in `.env.prod`
   (the path is relative to `/app` in the container). Put an age-encrypted
   copy in the vault with the other secrets (ADR-010 §2).

Rotation is Google's two-key procedure: create a second key, deploy it,
check that a station attests, then delete the old key in the console.

The server authenticates with the OAuth 2.0 JWT-bearer grant and the scope
`https://www.googleapis.com/auth/verifiedaccess`; the access token lives in
memory only and is never logged.

Reference: [Verified Access developer guide](https://developers.google.com/chrome/verified-access/developer-guide).

## 2. Google Admin console

All of this is done on **one organizational unit** that holds the exam
stations and nothing else, for example `Devices/Exam stations`. Move the
Chromebooks there (**Devices › Chrome › Devices**, select, **Move**). Staff
Chromebooks stay out of it.

### The device policy

**Devices › Chrome › Settings › Device**, on the stations' OU:

| Setting | Value | Why |
| --- | --- | --- |
| Verified Access: **Require verified mode boot for verified access** | on | the server also refuses anything but `CHROME_OS_VERIFIED_MODE` |
| Verified Access: **Services with full access** | the service account's e-mail (step 1.3) | without it, every attestation fails |
| Developer mode / **Verified mode** (unverified label) | block developer mode, require verified boot | a station in developer mode never attests |
| **Guest mode** | disable guest mode | nobody browses outside the kiosk |
| **Sign-in restriction** (unverified label) | allow no user to sign in | a station is nobody's machine |
| Forced re-enrollment | on | a wiped station comes back into the OU |

The Verified Access labels are those of Google's
[device policy help](https://support.google.com/chrome/a/answer/1375678)
("Services with full access lists email addresses of the service accounts
that gain full access to the Google Verified Access API"). **Services with
limited access** is not enough.

### The kiosk app

**Devices › Chrome › Apps & extensions › Kiosks**, on the stations' OU
([Google's help](https://support.google.com/chrome/a/answer/9781496)):

1. **Add** a web app by URL: `https://quiz.chevallier.io/kiosk`.
2. Under **Installation policy**, set it as the **Auto-launch app**. The
   Chromebook then boots straight into the page, with no browser frame.
3. Leave **Additional URL origins for this kiosk app** empty: the station
   needs no other origin. It never signs in with edu-ID, and Google is
   called by the server, not by the page.

### The companion extension

The extension is `extensions/kiosk-attestation/` in this repository (its
`README.md` covers publishing it in the Chrome Web Store, privately to the
domain, and keeping its id stable). On the kiosk app selected above:

1. **Extensions › Add extension**, by its Web Store id, force-installed.
2. On the extension's settings, under **Certificate management**, turn on
   **Allow enterprise challenge**. Without it `challengeKey` fails and the
   station shows "Station not recognised".

The extension id goes into `KIOSK_EXTENSION_ID`. The page calls the
extension by that id, and the extension only answers the production and
staging origins.

References: [kiosk mode detection](https://developers.google.com/chrome/verified-access/kiosk-mode-detection)
(where the "Allow enterprise challenge" setting is documented, for a PWA
kiosk app), [`enterprise.platformKeys`](https://developer.chrome.com/docs/extensions/reference/api/enterprise/platformKeys)
("only for extensions installed by a policy", "works only on ChromeOS").

### URL blocking

On the kiosk app's settings (or the OU's kiosk policy, **(unverified)**
where Google puts it this year): block everything, allow the quiz origin.

| Policy | Value |
| --- | --- |
| URL blocklist (`URLBlocklist`) | `*` |
| URL allowlist (`URLAllowlist`) | `https://quiz.chevallier.io` |

URL blocking governs what the page loads and navigates to. The page talking
to the extension (`chrome.runtime.sendMessage`) is not a URL load and is not
affected, nor is the force-installed extension itself. The kiosk has no
address bar, so the internal `chrome://` pages are not reachable from it
either way.

### The customer id and the enrollment domain

- **`KIOSK_GOOGLE_CUSTOMER_ID`**: **Account › Account settings › Profile ›
  Customer ID** in the Admin console. Verified Access must return the same
  value for every station; a station of another Workspace is refused.
  The comparison ignores one leading `C` on either side, so `C0123abc` and
  `0123abc` are the same id, whichever form Google answers with.
- **`KIOSK_ENROLLMENT_DOMAIN`**: the domain the Chromebooks are enrolled
  in (for example `heig-vd.ch`), shown on each device's page in **Devices ›
  Chrome › Devices**. Google checks the station's response against it
  (`expectedIdentity`).

## 3. The platform's configuration

In `.env.prod` (the full table is in
[Deployment §10](development/deployment.md#10-configuration-reference)).
`apps/api/src/config.ts` validates them at startup and refuses to start on
the combinations marked below.

| Variable | Value | Refused in production |
| --- | --- | --- |
| `KIOSK_ATTESTATION` | `off` (default), `google`, or `mock` | `mock`: always. `off`: the kiosk routes answer 404 and exams are not offered the setting |
| `KIOSK_VA_KEY_FILE` | `secrets/verified-access-key.json` | with `google`, an unreadable file |
| `KIOSK_GOOGLE_CUSTOMER_ID` | the Workspace's customer id | with `google`, missing |
| `KIOSK_ENROLLMENT_DOMAIN` | the stations' enrollment domain | with `google`, missing |
| `KIOSK_EXTENSION_ID` | the companion extension's id | with `google`, missing |
| `SEB_CONFIG_KEY_ENFORCE` | `0` (default) until proof B, then `1` | never; see the checklist |

With `google`, every missing piece is named in one error message, so one
edit of the file fixes them all. `mock` is for development only: it accepts
`mock:<device id>` as an attestation, so the kiosk path can be tried in a
browser without a Chromebook.

`SEB_CONFIG_KEY_ENFORCE` is not a kiosk setting, but it ships with the same
ADR: `0` only audits a Safe Exam Browser request whose Config Key header
does not match (`auth.seb_config_key_mismatch`); `1` refuses it.

### Staging

Staging (`quiz.dev.chevallier.io`) has its own `.env.staging`, `off` by
default. To try stations there, give it its own service account key (never
production's, ADR-010), the same customer id, enrollment domain and
extension id, and put the test Chromebooks in **another OU** whose kiosk
app launches `https://quiz.dev.chevallier.io/kiosk` and whose URL allowlist
names that origin. The extension admits both origins, so one published
extension serves both.

## 4. Commissioning a station

1. Move the Chromebook into the stations' OU and reboot it. It launches
   `/kiosk`, attests, and shows **Station not recognised — Call the
   supervisor.**: it is known but not named yet.
2. In the platform, **Administration › People › Kiosk stations** now lists it as
   **Unnamed**, identified by its serial number (Verified Access's device
   id, the serial on the Chromebook's label). "Waiting for a name: 1".
3. **Name** it after the sticker on the machine, for example
   `Poste de secours n° 7`. It becomes **Active**, and within 30 seconds the
   station shows a code and a QR code, and its name at the top.

The table also shows the **Last check** (with **Attested**, **Google
unreachable** or **Refused**) and the **Last attested** time.

- **Retire** takes a station out of service (lost, broken, lent out): it
  can no longer be paired and shows "Station not recognised". Its history
  stays.
- **Reactivate** puts a retired station back, with its name.
- **Rename** changes the label; students check that label on their phone
  against the screen in front of them, so keep it identical to the sticker.

Every change is audited (`kiosk.device_labeled`, `kiosk.device_retired`,
`kiosk.device_reactivated`).

## 5. On the day of the exam

1. **The teacher** turns on **Kiosk stations** under **Advanced options** of
   the exam (step 2 of the editor). The switch is offered only on exams,
   and only while `KIOSK_ATTESTATION` is not `off`. With **Safe Exam
   Browser** also on, either is accepted; the portal alone never opens the
   exam. The setting freezes once the exam runs.
2. **The student** sits at a station, which shows its name, a code
   (`XXXX-XXXX`) and a QR code. They scan it with their phone, signed in to
   the portal (or sign in on the way), check the station's name, pick the
   exam and press **Start on this station**. The station opens the exam
   within a few seconds. A code lasts 5 minutes and works once; the station
   renews it by itself.
3. **After the hand-in** (or the close, or the deadline), the station
   returns to its start screen by itself, ready for the next student.

### A student without a phone

The student reads the code on the station to the supervisor. On the exam's
dashboard, while it is open and accepts kiosk stations, each student's row
has an **Assign a station** button (a monitor with a check). It opens
**Assign a station to** the student, with one field, **Code shown on the
station**; **Assign** approves that code for that student, and the dialog
confirms with the station's name ("Poste de secours n° 7 is opening the
exam for …"). It is the same pairing, approved by the teacher instead of
the student's phone (`kiosk.assigned` in the audit). The student then sits
as themselves, and can answer; the teacher is recorded as the approver,
never as an impersonator. Wrong codes count against the supervisor's own
limit of 10 in 10 minutes, not the student's.

### Suspended, and "Google unreachable"

Each row of the dashboard shows how the student sits beside their name:
nothing for the portal, a **SEB** badge, or the station's name behind a
monitor icon. On a station, a second pill says when its attestation is not
fine.

| The supervisor sees | Meaning | Answers | What to do |
| --- | --- | --- | --- |
| a red **suspended** pill, and once the message "…'s station is suspended: it could not prove its integrity." | Google refused the station's attestation, the extension failed, or the station stopped attesting for 12 minutes | the saved answers are kept; new ones are refused until the next accepted attestation, which lifts the suspension by itself | look at the station. If it does not recover within a minute, move the student to another station (a new pairing replaces the old session) |
| an amber **not attested** pill | the server cannot reach Google | the exam continues; nothing is suspended for a Google outage | nothing during the exam. The hand-in still requires a check less than two minutes old, accepted or unreachable, so it goes through |

A suspended station covers the exam with **This station is suspended** —
"This station could not prove its integrity; your answers are saved. Call
the supervisor. The exam comes back here by itself once the station is
checked again." It re-attests every 30 seconds while suspended, and the
exam comes back as soon as one attestation is accepted.

## 6. Troubleshooting

| Symptom | Likely cause | Check |
| --- | --- | --- |
| The station shows **Station not recognised** | it is **Unnamed** or **Retired** in Administration › People › Kiosk stations; or its attestation is refused | the station's row, and the audit (`kiosk.attest_failed`, reason `refused`). A station missing from the list never attested: see the next rows |
| A new Chromebook never appears in the list | the extension is not detected (not force-installed on the kiosk app, wrong `KIOSK_EXTENSION_ID`, **Allow enterprise challenge** off), or the device is in developer mode, or the customer id or enrollment domain differs | the page reports the extension's failure to the server, which records a refusal. Check the kiosk app's extension, its certificate setting, the device's boot mode, and the two identifiers in `.env.prod` |
| Every station is refused, and the API logs `kiosk attestation: refused` with `customerMatches: false` | `KIOSK_GOOGLE_CUSTOMER_ID` is not the Workspace Google answers for | the same log line carries the `customerId` Google returned: copy it into `.env.prod`. A leading `C` does not matter, it is ignored on both sides. With `customerMatches: true`, look at `keyTrustLevel` instead: anything but `CHROME_OS_VERIFIED_MODE` is a station in developer mode |
| **The station cannot start** — "The station keeps trying by itself." | the server cannot get a challenge from Google (network, quota, the service account not in **Services with full access**, a revoked key) or the platform is unreachable | the API's log (`attestation` failures are logged by kind and HTTP status, never with a token); the station retries every 30 seconds |
| **Google unreachable** in the Last check column | the last attempt could not reach Google | as above; a station at rest shows **The station cannot start** until Google answers again |
| The phone says **This code does not work** | the code expired (5 minutes), was already used, or was mistyped | type the code the station shows now. After 10 wrong codes in 10 minutes the phone says **Too many wrong codes** and must wait |
| The phone says **No exam to start on a station** | the exam is not open yet, does not accept kiosk stations, or the student has no seat in the classroom | the exam's state and its **Kiosk stations** switch |
| Several stations of a room fail together with 429 | a room behind one NAT address: attestation and code requests are limited to 240 calls per client address per minute (one attestation is two calls: about 120 stations attesting in the same minute) | stagger the boot of a very large room; the stations' polls while waiting for a phone are not counted |

## 7. Verify on hardware

ADR-051 §10, step 0. These have not been observed on a real station yet.
Until the first two are recorded, keep `KIOSK_ATTESTATION=off` in
production; until the last is recorded, keep `SEB_CONFIG_KEY_ENFORCE=0`.

- [ ] In a **web** kiosk app (Google documents the enterprise challenge for
      a PWA kiosk app), the extension's `challengeKey` with the `MACHINE`
      scope succeeds, with **Allow enterprise challenge** on.
- [ ] The `/kiosk` page reaches the extension (`chrome.runtime.sendMessage`
      through `externally_connectable`; the `ping` answers), with the URL
      blocklist in force.
- [ ] The first station attests with the Admin console's customer id as
      typed in `KIOSK_GOOGLE_CUSTOMER_ID` (with or without its leading `C`;
      on a mismatch the API logs the id Google returned), and the
      `devicePermanentId` shown in Administration › People › Kiosk stations is the
      serial on the machine's label.
- [ ] The Admin console paths and labels on this page are the ones on the
      screen; the ones marked **(unverified)** are corrected here.
- [ ] **Proof B**: a real Safe Exam Browser sends the
      `X-SafeExamBrowser-ConfigKeyHash` header on `fetch` and `EventSource`
      requests (`docs/merge/06-codespace-seb-infra.md` §6.3), with no
      `auth.seb_config_key_mismatch` in the audit during a rehearsal. Only
      then set `SEB_CONFIG_KEY_ENFORCE=1`.
