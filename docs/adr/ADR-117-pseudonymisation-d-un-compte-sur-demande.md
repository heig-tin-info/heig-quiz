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
derives its wipe list from `scripts/staging-pseudonymize.sql`
([ADR-028](ADR-028-recette-sur-la-meme-vm.md), update 2026-10-11); refers to
[ADR-054](ADR-054-super-powers-admin.md), [ADR-061](ADR-061-adoption-des-comptes-importes.md),
[ADR-111](ADR-111-admission-a-la-connexion.md) and
[ADR-112](ADR-112-export-des-donnees-personnelles.md); open question 57
([06](../spec/06-questions-ouvertes.md)).

## Context

Quiz keeps a classroom's data until the teacher deletes it (N-DATA-03), and an
account is never deleted (ADR-013): nothing happens when a student finishes or
leaves their studies (`docs/guide/data-protection.md`, *Retention and
deletion*, *Known limits*). The `users.anonymized_at` column exists, and eight
readers already honour it (`auth/login.ts` `admissionFacts`, `auth/adoption.ts`,
`auth/tokens.ts`, `roles.ts`, `modules/admin/service.ts`,
`modules/notifications/jobs.ts`, `modules/presence/service.ts`,
`modules/system/alerts.ts`), but nothing sets it: it came with heig-classroom's
data (its NFR-07 and H11), which were never carried over as Quiz requirements.
On 2026-10-10 the product owner moved issue #681 to the backlog: no
requirement for now. This record writes the requirement and the design down so
that, if a request or an institutional ask arrives, the decision can be taken
with everything in front of it.

**What it is for.** Risk reduction for an account whose person has left and
asks: their name leaves the rosters, grade tables, dashboards, notifications,
CSV exports, the data export (ADR-112) and what the help assistant reads
(ADR-080). It is **not deletion and not anonymisation**: the operator can still
re-identify the account through the audit log's payloads and through GitHub
repository names, and the attempts, answers and grades stay under the same id.
It is never offered as the answer to a deletion request.

**Legal frame (not legal advice).** The repository's own analysis names the
Vaud law on the protection of personal data (LPrD, BLV 172.65, hypothesis A of
the data-protection guide) rather than the federal FADP. Neither gives an
unconditional right to erasure of what a public institution processes under a
legal task such as teaching and grading. The real gap is a **retention period**
(proportionality): data with no end date. This record does not settle it; it
leaves it to a separate decision (question G). Who the controller is (HEIG-VD,
a department, the teacher) is still to be confirmed: the question was sent to
HEIG-VD on 2026-10-13.

**What a re-login does today.** `admissionFacts` treats an account whose
`oidc_sub` matches but which carries `anonymized_at` as unknown, so a returning
person goes through admission (ADR-111) like a stranger. If admitted, `signIn`
upserts on `oidc_sub` and writes the fresh edu-ID name, address and picture
**onto the anonymized row**: a re-identified zombie, whose tokens are refused
(`tokens.ts`), whose notifications are off, which the admin lists hide, and
whose session plugin (`auth/plugin.ts`) does not read `anonymized_at` at all.
Any routine must close this before it ships.

## Decision

Proposed, each point open to the owner's answer below.

1. **Trigger.** An operator command under `apps/api/scripts/`, run on the
   product owner's written decision, going through the modules' ordinary
   `service.ts` functions (as the seed does), never raw statements on another
   module's tables. It writes one audit row, `user.anonymized`, whose payload
   is the account id only (a new member of the closed union of
   `apps/api/src/audit.ts`). No admin screen, no self-service, no retention
   job in v1. The alternative is an admin screen behind Super Powers (ADR-054)
   with a typed confirmation (`apps/web/src/confirm.tsx`); question E.

2. **Scope v1: student accounts only.** The command refuses an account that
   holds a course staff seat, a pool seat, a teacher grant or the admin role;
   it refuses while one of its attempts is open, or while a `seb` or `kiosk`
   session of it is live. It revokes the account's GitHub access as a roster
   removal does (the `org` service, `502 revoke_failed`), and stops, writing
   nothing, on `revoke_failed`. It never renames nor deletes anything on
   GitHub: a repository stays the organization's (F-PROJ-16, D19), and its
   name, which may carry the student's login, is a residual (6).

3. **One wipe list, shared with staging.** The list is not written a second
   time by hand: it is derived from `scripts/staging-pseudonymize.sql`, which
   already pseudonymizes every person of a copy and is proven by
   `apps/api/src/stagingScrub.db.test.ts` (every row of every table searched
   for a name, address or external id). The routine applies the same
   replacements restricted to one account, and the same test, run on one
   account beside an untouched one, proves both. Compared with the issue's
   list of 2026-10-10, the staging script also covers:
   - `project_repos.full_name` (a student repository names its student);
   - the names of `student_groups`, `project_groups` and `group_sets` (a group
     may be named after its members) — only the groups the account belongs
     to;
   - `teacher_grants` under one of the account's addresses;
   - the payloads of `legacy_classroom_audit_log` that name the account (that
     table carries no immutability trigger);
   - `webhook_deliveries` payloads and errors, and `scheduled_tasks.last_message`
     — in production both are short-lived or generic, so the routine checks
     them rather than empties them all.

   And the issue's list holds what staging handles elsewhere
   (`scripts/staging-scrub.sql` empties every credential): the account's
   sessions, launch tickets, API tokens, OAuth grants, Teams link tokens and
   kiosk pairings in progress are deleted. A review of the schema adds rows
   neither list names: `presence_hours` and `presence_last_seen`
   (ADR-107), `notification_preferences`, `user_course_prefs`, and the
   account's drill data (cards, reviews, rounds of targeted revision), which
   the owner's list deletes.

   **Kept under the pseudonymous id**: attempts, answers, the attempt journal,
   gradings and their comments, released-grade snapshots, the gradebook,
   project runs and scores, push receipts, `llm_calls` rows (which name an
   account id, never content). **Rewritten**: the account's own fields
   (`email` `anon-<id>@example.invalid`, given and family names neutral,
   `swiss_edu_id` and `picture_url` null), `user_emails` reduced to that
   address, `user_idp_claims` emptied, avatars and Teams links deleted, the
   `enrollments` lines the account claimed (name, **email**, note): a line
   that kept its real address would be re-claimed by a re-imported roster or
   a fresh login under that address.

   **Outside the database**, the routine cannot reach and the record says so:
   the online workspace's own database (`apps/codespace/src/db/schema.ts`:
   `users.login`, `email`, `display_name`, `github_login`, and the volume
   directory named after the login), to be handled by the operator in the same
   run; the help assistant's stored conversations, which may quote the name
   until their 30 days pass (ADR-080 §6); the model provider's side of past
   calls.

4. **Re-login creates a fresh, empty account.** The command rewrites
   `oidc_sub` to `anon-<id>`, as the staging script writes `staging:<id>` and
   as the import already recognises (`import-classroom/identity.ts` treats
   `anon-` as fresh). No identity provider issues that subject, so a later
   edu-ID login finds no account and, if admitted (ADR-111), creates a new one
   with nothing in it. No hash of the old subject is kept: a hash is itself a
   lasting identifier of the person, it would serve only to lock a returning
   student out, and edu-ID subjects are pairwise per sector (open question 57),
   so it would not even recognise the same person through another client.
   Question C.

5. **The audit log is untouched.** The trigger of migration
   `0096_audit_log_immutable` refuses every `UPDATE` and `DELETE`
   (ADR-003 §5), and this record does not lift it. The payloads of
   `roster.import`, `roster.claim`, `roster.remove`, invitations, grants and
   GitHub links carry
   names, addresses and logins: **the operator can re-identify a pseudonymized
   account from them**, and the record and the N-DATA row say so plainly.
   Rewriting them would need an amendment of ADR-003 §5 and is rejected
   (question D).

6. **Residuals, stated.** Outside the routine's reach:
   - the backups, about four months (N-DATA-03);
   - the owner's workstation copy of heig-classroom's final dump,
     `hgc-2026-10-14.dump` (`docs/merge/10-cutover-runbook.md`, step 2 of
     the decommission), which needs a deletion date (question F);
   - the off-site borg archives of heig-classroom's dumps, until their
     retention prunes them (about three months from 2026-10-14);
   - GitHub repository names, and the commits of the repositories;
   - the online workspace's database, unless the operator handles it (3).

   The heig-classroom import (`apps/api/src/import-classroom.ts`) must never
   be re-run once anyone is pseudonymized: it would re-create the identity.
   It is no longer a blocker: the cutover (M8-07, 2026-10-11) and the
   decommission (M9-01, 2026-10-15) are done, and the source database is
   gone (`docs/merge/PROGRESS.md`).

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
  acceptance, with a reciprocal link here.
- The data-protection guide and the privacy pages (N-DATA-07) gain one
  sentence on acceptance, worded as pseudonymization, never as deletion; the
  *Known limits* entry "no deletion or pseudonymisation of accounts" changes
  accordingly.
- Before the routine ships, the session plugin must refuse a session of an
  anonymized account, and `signIn` must never upsert onto one (4 closes it by
  construction; a test asserts it).
- One shared definition with staging means a table added to the staging
  script is pseudonymized by both, and the existing test covers both; the
  cost is that the staging script must be split into a per-account part and a
  whole-copy part.
- It does not answer the retention question, and must not be presented as
  doing so.

## Alternatives considered

- **Deleting the account and its rows.** Breaks the grade records the school
  must keep, the gradebook and every foreign key; contradicts ADR-013 and
  N-DATA-03. Rejected.
- **Rewriting the audit payloads.** Would need the immutability trigger
  lifted on production's record, the only thing that keeps the log
  trustworthy (ADR-003 §5). Rejected.
- **Keeping a hash of the subject to refuse a re-login.** See 4: a lasting
  identifier, and pairwise subjects defeat it. Rejected.
- **A second, hand-written wipe list.** Would drift from the staging script,
  which is already tested against every table. Rejected.
- **A retention job pseudonymizing accounts after N years.** A retention
  period is a separate decision (question G); not in v1.
- **Self-service from the student's settings.** Irreversible on one click,
  and a request has to be validated by someone (question B). Rejected for v1.

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
