# ADR-117 — Account pseudonymization on request

## Status

Proposed (2026-10-26, issue #681, from the product owner's analysis of
2026-10-10). Nothing is implemented; the routine stays in the backlog until
the owner answers the questions at the end of this record.

Scope: what happens to one account, on request, so that its person's identity
leaves the platform's screens, notifications, exports and help assistant; who
triggers it; what it leaves behind.

Relations: would amend [ADR-003 §5](ADR-003-postgresql-drizzle.md#decision)
("account pseudonymization is not a Quiz requirement") and add an N-DATA row
to [03](../spec/03-exigences-non-fonctionnelles.md); keeps
[ADR-013](ADR-013-partage-des-pools.md)'s "an account is never deleted";
shares its SQL with `scripts/staging-pseudonymize.sql`
([ADR-028](ADR-028-recette-sur-la-meme-vm.md), update 2026-10-11); refers to
[ADR-054](ADR-054-super-powers-admin.md), [ADR-111](ADR-111-admission-a-la-connexion.md)
and [ADR-112](ADR-112-export-des-donnees-personnelles.md); open question 57
([06](../spec/06-questions-ouvertes.md)).

## Context

Quiz keeps a classroom's data until the teacher deletes it (N-DATA-03), and an
account is never deleted (ADR-013): nothing happens when a student finishes or
leaves their studies (`docs/guide/data-protection.md`, *Retention and
deletion*, *Known limits*). The `users.anonymized_at` column exists, with
eight runtime readers that honour it (`auth/login.ts`, `auth/adoption.ts`,
`auth/tokens.ts`, `roles.ts`, `modules/admin/service.ts`,
`modules/notifications/jobs.ts`, `modules/presence/service.ts`,
`modules/system/alerts.ts`), plus the heig-classroom import
(`import-classroom/`). Nothing in Quiz sets it except that import, which
copied it from heig-classroom, whose NFR-07 and H11 were never carried over
as Quiz requirements. On 2026-10-10 the product owner moved #681 to the
backlog. This record writes the requirement and the design down so that a
request, if one arrives, can be decided with everything in front of it.

**What it is for.** Risk reduction for an account whose person has left and
asks: their name leaves the rosters, grade tables, dashboards, notifications,
CSV exports, the data export (ADR-112) and what the help assistant reads
(ADR-080). It is **not deletion and not anonymisation**: the operator can
still re-identify the account through the audit log and GitHub repository
names, and the attempts, answers and grades stay under the same id. It is
never offered as the answer to a deletion request.

**Legal frame (not legal advice).** The repository's own analysis names the
Vaud law on the protection of personal data (LPrD, BLV 172.65, hypothesis A of
the data-protection guide) rather than the federal FADP. Neither gives an
unconditional right to erasure of what a public institution processes for a
legal task such as teaching and grading. The real gap is a **retention
period** (proportionality): data with no end date. This record leaves it to a
separate decision (question G). The controller is still to be confirmed (the
question was sent to HEIG-VD on 2026-10-13).

**What a re-login does today.** `admissionFacts` treats an account whose
`oidc_sub` matches but which carries `anonymized_at` as unknown, so a returning
person goes through admission (ADR-111) like a stranger. If admitted, `signIn`
upserts on `oidc_sub` and writes the fresh edu-ID name, address and picture
**onto the anonymized row**: a re-identified zombie whose tokens are refused,
whose notifications are off and which the admin lists hide. Any routine must
close this before it ships.

## Decision

1. **Trigger.** An operator command under `apps/api/scripts/`, run on the
   product owner's written decision. It first revokes the account's GitHub
   access through the `org` service, as a roster removal does, and stops,
   writing nothing, on `502 revoke_failed`. It then runs the per-account SQL
   fragment shared with `scripts/staging-pseudonymize.sql`, in one
   transaction, and writes one audit row, `user.anonymized`, whose payload is
   the account id only (a new member of the union of `apps/api/src/audit.ts`).
   **This is an explicit exception to the convention that a module writes
   only its own tables**: one list, one test, instead of a second wipe list
   spread over a dozen services that would drift from the staging one. No
   admin screen, no self-service, no retention job in v1; the alternative is
   an admin screen behind Super Powers (ADR-054) with a typed confirmation
   (`apps/web/src/confirm.tsx`), question E.

2. **Scope v1: student accounts only.** The command refuses an account that
   holds a course staff seat, a pool seat, a teacher grant or the admin role,
   and refuses while one of its attempts is open. It never renames nor
   deletes anything on GitHub: a repository stays the organization's
   (F-PROJ-16, D19).

3. **One wipe list, shared with staging.** `scripts/staging-pseudonymize.sql`
   is split into a per-account fragment and the whole-copy rest; the routine
   and staging both run the fragment, and
   `apps/api/src/stagingScrub.db.test.ts`, which searches every row of every
   table, proves it on one account beside an untouched one. The fragment
   covers what the script already does for a person (account fields,
   addresses, IdP claims, avatar, Teams link, roster lines, grants, GitHub
   identities, repository full names, group names, legacy audit payloads);
   the account's `oidc_sub` becomes `anon-<id>` (4). Beyond the script, the
   routine deletes what staging truncates wholesale
   (`scripts/staging-scrub.sql`) — the account's sessions, launch tickets, API
   tokens, OAuth grants, Teams link tokens, kiosk pairings in progress — and
   rows neither script names: `presence_hours`, `presence_last_seen`
   (ADR-107), `notification_preferences`, `user_course_prefs`, its
   notifications and its drill data (cards, reviews, rounds of targeted
   revision). A claimed roster line loses its **email** too, else a
   re-imported roster line or a login under that address re-claims the seat.

   **Kept under the pseudonymous id**: attempts, answers, the attempt
   journal, gradings and their comments, released-grade snapshots, the
   gradebook, project runs and scores, push receipts, `codespace_launches`
   (project and dates), `llm_calls` (an account id, never content).

4. **Re-login creates a fresh, empty account.** `oidc_sub` becomes
   `anon-<id>`, the convention heig-classroom used, which the import already
   treats as fresh (`import-classroom/identity.ts`); staging writes
   `staging:<id>` for the same reason. No identity provider issues it, so a
   later edu-ID login finds no account and, if admitted (ADR-111), creates a
   new one with nothing in it. No hash of the old subject is kept: a hash is
   itself a lasting identifier, it would only serve to lock a returning
   student out, and edu-ID subjects are pairwise per sector (open question
   57). As defence in depth, the session plugin (`auth/plugin.ts`) may also
   refuse an anonymized account's session. Question C.

5. **The audit log is untouched**, under [ADR-003 §5](ADR-003-postgresql-drizzle.md#decision).
   The payloads of `roster.import`, `roster.claim`, `roster.remove`,
   invitations, grants and GitHub links carry names, addresses and logins:
   **the operator can re-identify a pseudonymized account from them**, and
   the record and the N-DATA row say so. Question D.

6. **Residuals, stated.** The backups, about four months (N-DATA-03); the
   owner's workstation copy of heig-classroom's final dump,
   `hgc-2026-10-14.dump` (`docs/merge/10-cutover-runbook.md`), which needs a
   deletion date (question F); the off-site borg archives of heig-classroom's
   dumps, until their retention prunes them (about three months from
   2026-10-14); GitHub repository names and commits; the help assistant's
   stored conversations, which may quote the name until their 30 days pass
   (ADR-080 §6); the provider's side of past model calls; the online
   workspace's own database (`apps/codespace/src/db/schema.ts`: login,
   email, display name, GitHub login, and the volume directory named after
   the login), which the operator handles by hand in the same run. The
   heig-classroom import is never re-run once anyone is pseudonymized; its
   source is gone since M9-01 (2026-10-15), so this is no blocker.

7. **Draft N-DATA row**, to add to 03 on acceptance:

   > N-DATA-08 | On the product owner's written decision, an operator may
   > pseudonymize a student's account: its identity (names, addresses, edu-ID
   > identifiers, picture, GitHub link, the roster lines it claimed) is
   > replaced, its credentials are revoked, and its attempts, answers,
   > gradings and grades stay under the same id. It is not deletion: the
   > audit log, the backups for about four months and GitHub repository names
   > keep the identity, and the operator can re-identify the account. A later
   > login creates a new, empty account. Audited as `user.anonymized`, the id
   > only (ADR-117).

## Consequences

- ADR-013's "an account is never deleted" stays true: the row stays,
  pseudonymized. ADR-003 §5's "not a Quiz requirement" sentence is amended on
  acceptance.
- The data-protection guide and the privacy pages (N-DATA-07) gain one
  sentence, worded as pseudonymization, never as deletion; the *Known limits*
  entry "no deletion or pseudonymisation of accounts" changes accordingly.
- The staging script must be split into a per-account fragment and a
  whole-copy rest; a table added to the fragment is then pseudonymized by
  both, under the one test.
- The command writes other modules' tables directly (1): accepted for this
  one fragment, not as a precedent.

## Alternatives considered

- **Deleting the account and its rows.** Breaks the grade records, the
  gradebook and every foreign key; contradicts ADR-013 and N-DATA-03.
- **Each module's service pseudonymizes its own rows.** Respects module
  ownership, but makes a second wipe list beside the staging one, tested
  separately, that drifts.
- **Rewriting the audit payloads, or keeping a hash of the subject.** See 5
  and 4.
- **Self-service from the student's settings.** Irreversible on one click,
  and a request has to be validated by someone (question B).

## Questions for the owner

- **A.** Is there a real request, or an institutional ask? If not, this
  record stays Proposed and #681 stays in the backlog.
- **B.** Who validates a request: the product owner, the student's teacher, or
  the institution? The controller is still to be confirmed (question sent to
  HEIG-VD on 2026-10-13).
- **C.** Re-login creates a fresh, empty account, and no hash is kept (4)?
- **D.** The audit log stays untouched, and the record says the operator can
  re-identify (5)?
- **E.** An operator command (proposed) or an admin screen behind Super Powers
  with a typed confirmation (1)?
- **F.** A deletion date for the workstation copy `hgc-2026-10-14.dump` (6)?
- **G.** The retention period (proportionality) as a separate issue?
