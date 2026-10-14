# ADR-111 — Login admission: an account is created only for a member of a listed institution or an invited person

## Status

Accepted (2026-10-14, every point settled by the product owner on issue
#722). The mechanism ships off: `LOGIN_DOMAINS` is empty in production
until the product owner chooses a value.

Scope: the creation of an account at the first OIDC sign-in.

Relations: adds F-AUTH-06 beside [F-AUTH-02](../spec/02-exigences-fonctionnelles.md#f-auth-authentication-and-accounts);
amends [ADR-028 §3](ADR-028-recette-sur-la-meme-vm.md#3-productions-data-not-anonymized-behind-a-login-allowlist)
(an empty allowlist no longer means "everyone"); reads
[ADR-061](ADR-061-adoption-des-comptes-importes.md) and the
[ADR-053 addendum of 2026-10-11](ADR-053-retrait-des-codes-d-entree.md#addendum-2026-10-11-a-line-is-attached-only-when-the-person-acts);
open question 59 of [06](../spec/06-questions-ouvertes.md).

## Context

Production creates an account for anyone Switch edu-ID authenticates
(ADR-028 §3), a library card's edu-ID account included. edu-ID scopes every
HES-SO person's affiliations on `hes-so.ch`, never per school; what tells
HEIG-VD apart is the institutional address edu-ID links to the account
(`swissEduIDLinkedAffiliationMail`), which Quiz already reads as a verified
address (`verifiedAddressesOf`, ADR-061). The figures are in issue #722.

## Decision

### 1. Admission judges account creation only

An account that already exists — a non-anonymized row holding the login's
subject — signs in as before, whatever the list says, and so does the
person a heig-classroom placeholder account waits for: a login that
matches one, or several — `signIn` then flags the match as ambiguous and
creates an account, as it does today (ADR-061). The match is read before
any write. Removing the accounts created before the rule stays issue #681.

### 2. Who is admitted

With `LOGIN_DOMAINS` set, a new person is admitted if and only if one of:

- **(a) a member** of a listed institution: edu-ID asserts an affiliation
  SCOPED on a listed domain, of any kind (`member`, `student`, `staff`,
  `affiliate`) — an unscoped affiliation names no institution and never
  counts; or a verified address of the claims is at a listed domain. The
  addresses are those of `verifiedAddressesOf`, the same trust as the roster
  matching and the adoption: the login address when edu-ID verified it, and
  the addresses the institutions assert, `swissEduIDLinkedAffiliationMail`
  included. The match is EXACT: `heig-vd.ch` does not admit
  `mail.heig-vd.ch`.
- **(b) an invited person**: a verified address of the claims matches a
  PENDING roster line (`lower(enrollments.email)`, `user_id` null) — a
  roster line alone admits an external student — or an admin's teacher
  grant (`teacher_grants`). Since the ADR-053 addendum of 2026-10-11 a line
  is claimed only once its person acts, so at the door the person's lines
  are pending and are matched by address, never read through a claimed
  seat. Any pending line counts, an archived classroom's included, as
  `claimEnrollments` claims it. A course staff seat is keyed on an account,
  so a teacher cannot invite a newcomer by adding them to the staff: they
  add a roster line, or ask the admin for a grant. Accepted.
- **(c) the super administrator** (`SUPER_ADMIN_EMAIL`, on a verified
  address), always (§4).

The rule is `admissionRefusal` (`packages/domain/src/admission.ts`), pure.
`loginRefusal` (`apps/api/src/auth/login.ts`) asks it of the claims first,
and only if they do not admit, again with the facts it loads from the
database (`hasPendingLine` of the org module, `hasTeacherGrant` of
`roles.ts`, the account and the placeholder match).
`STAFF_AFFILIATION_DOMAINS` keeps driving the role (F-AUTH-02): admission
decides whether an account is created, the role what it may do.

### 3. The list lives in `.env`

`LOGIN_DOMAINS`, comma-separated, written bare like
`STAFF_AFFILIATION_DOMAINS` (`heig-vd.ch,hes-so.ch`). Empty — the default —
admits everyone, as before; production keeps it empty until the product
owner sets a value (`heig-vd.ch` is likely, not decided). `config.ts`
refuses `eduid.ch`, which every edu-ID account is affiliated to, and any
entry that is not a bare domain name (`@heig-vd.ch`, a URL), which would
never match and refuse every newcomer without a word. The list is not
editable from the admin screen: nothing in the interface can widen or close
the door; a change is a deployment.

### 4. The order at the door

In the OIDC callback, before any write: a subject shaped like a placeholder
is refused as before (ADR-061 §1); then the super administrator passes;
anyone else must pass the staging allowlist (ADR-028 §3) AND admission. Staging does not set
`LOGIN_DOMAINS`: its allowlist already names every tester.

### 5. When userinfo fails

edu-ID releases the affiliations and the linked addresses on userinfo only.
Without it, the claims are the ID token's: a new person whom they do not
admit is refused (fail closed), and the page says to try again later — the
reason to admit may be in what is missing. A new person they already admit
(a verified address at a listed domain, a pending roster line, a grant, the
super administrator) is admitted: the rule only grows with more claims. An
existing account is admitted (§1).

### 6. The refusal

Before ANY write — no `users` row, no claims row, no address — the callback
answers `303` to `/sign-in/refused?reason=<reason>`
(`LOGIN_REFUSED_PATH`, `LOGIN_REFUSALS`, `@quiz/contracts`), a public page
drawn with no session: `restricted` for the staging allowlist and a forged
subject (it replaces the JSON `403 login_not_allowed`), `not_invited` for
admission, `retry` for §5. One page, one title, the reason's text in French
and English, generic: no list of institutions, nothing about the person's
addresses. One action: back to the home page; the text tells a person with
several edu-ID accounts to sign out of edu-ID and use the one their school
knows. The callback is reached only by the browser's navigation back from
the identity provider (its signed state cookie is set by `/app/auth/login`,
itself a navigation), so no client expects JSON there.

### 7. No audit row

A refusal names no member, so it writes no audit entry: the audit log is
about accounts. The callback logs a warning with the subject and the
reason, never an address.

### 8. Admission is not revocation

Setting `LOGIN_DOMAINS` later ends no session, API token or OAuth grant.
The Safe Exam Browser and kiosk launches (ADR-027, ADR-051), the online
workspace (ADR-078), impersonation (ADR-034) and the development login
(invariant 3) open sessions for existing accounts and are unaffected.

### 9. Deferred

For the day a value is chosen, not built now: a warning on the admin's
grant form when the address is outside `LOGIN_DOMAINS` (it would still be
saved: a grant invites), and a read-only query run on production before
setting the variable, listing the accounts the rule would have refused.

## Consequences

- Production changes nothing until the variable is set; then an edu-ID
  account with no tie to a listed institution and no invitation gets no
  account, and nothing about it is stored.
- An external student is invited by the roster, as before: the teacher adds
  the address the student will sign in with. A colleague from outside is
  invited by a grant, not by a staff seat.
- A transient edu-ID userinfo failure refuses a newcomer whom the ID token
  alone does not admit; they retry. Existing accounts never notice it.
- No query is added while `LOGIN_DOMAINS` is empty, nor when the claims
  alone admit; otherwise up to four indexed reads, the placeholder match
  for a new subject included.

## Alternatives considered

- **Judging every sign-in, existing accounts included.** It would lock out
  people already holding grades and work, on a list change; removing old
  accounts is a separate, deliberate step (#681).
- **The list in the admin screen.** One click could open the door to
  everyone or close it on a school; a deployment is the right weight.
- **Subdomain matching.** No HEIG-VD address uses one; exact matching
  cannot be widened by a look-alike.
- **Judging a userinfo failure on the stored claims snapshot.** A newcomer
  has none; an existing account needs none (§1).
- **A JSON `403` for the refusal.** The callback is a navigation: a person
  would read raw JSON.
