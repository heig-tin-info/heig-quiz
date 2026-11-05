# ADR-117 — Account pseudonymization and the inactivity lifecycle

## Status

Accepted (2026-11-05, product owner, issue #681; proposed 2026-10-26 as
"Account pseudonymization on request"). Amended in place: the owner's dated
answers replace the questions of the proposal; §11 (the audit log's
retention) and §6's reach to any account are rulings made on the owner's
delegation the same day. Delivered by the pull requests that follow in issue
#681; until then the code is as *Context* describes.

Scope: when and how an account's identity leaves the platform while its work
stays: the inactivity lifecycle of a student account, a student's own request,
the administrator's act on any account, what is wiped and what is kept.

Relations: amends [ADR-003 §5](ADR-003-postgresql-drizzle.md#decision)
(pseudonymization becomes a requirement; the audit log gets a retention),
[ADR-013 §5](ADR-013-partage-des-pools.md#decision) (its succession applies to
a pseudonymized staff account) and [ADR-041 §8](ADR-041-entrainement-espace.md#8-data)
(drill data stays under the pseudonymous id); adds N-DATA-08 and amends
N-SEC-09, N-DATA-03 and N-DATA-07 ([03](../spec/03-exigences-non-fonctionnelles.md));
keeps [ADR-013](ADR-013-partage-des-pools.md)'s "an account is never deleted";
shares its SQL with `scripts/staging-pseudonymize.sql`
([ADR-028](ADR-028-recette-sur-la-meme-vm.md), update 2026-10-11); refers to
[ADR-030](ADR-030-canaux-de-notification.md) (the notification address,
amendment of 2026-10-28), [ADR-054](ADR-054-super-powers-admin.md),
[ADR-111](ADR-111-admission-a-la-connexion.md),
[ADR-112](ADR-112-export-des-donnees-personnelles.md) and open question 57
([06](../spec/06-questions-ouvertes.md)). The retention of attempts (question G)
is issue #1027.

## Context

Quiz keeps a classroom's data until the teacher deletes it (N-DATA-03), and an
account is never deleted (ADR-013): until this record, nothing happened when a
student finished or left their studies (`docs/guide/data-protection.md`,
*Retention and deletion*, *Known limits*). The `users.anonymized_at` column
exists, with eight runtime readers that honour it (`auth/login.ts`,
`auth/adoption.ts`, `auth/tokens.ts`, `roles.ts`, `modules/admin/service.ts`,
`modules/notifications/jobs.ts`, `modules/presence/service.ts`,
`modules/system/alerts.ts`), plus the heig-classroom import
(`import-classroom/`). Nothing in Quiz sets it except that import, which
copied it from heig-classroom, whose NFR-07 and H11 were never carried over as
Quiz requirements.

**What it is for.** Risk reduction. A breach must not expose fifteen years of
named history, and an administrator must not be able to read a named person's
results across other teachers' courses. The attempts, answers, gradings, grades
and statistics stay, for the teachers' view over several years; only the
**identity** leaves. A teacher decides which content is deleted (N-DATA-03);
the platform decides when an account is pseudonymized. It is **not deletion
and not anonymization**: until the audit log's retention and the backups' run
out, the operator can re-identify the account (§11, §12), and the work stays
under the same id. It is never offered as the answer to a deletion request.

**Legal frame (not legal advice).** The repository's own analysis names the
Vaud law on the protection of personal data (LPrD, BLV 172.65, hypothesis A of
the data-protection guide) rather than the federal FADP. Neither gives an
unconditional right to erasure of what a public institution processes for a
legal task such as teaching and grading. The real gap is a **retention
period** (proportionality). The question sent to the HEIG-VD on 2026-10-13 was
answered in writing in October 2026 by the HEIG-VD's records officer, the
contact for this processing on the school's side; the platform's administrator
answers that officer if a request arrives. The answers: exam copies are kept
two years from the close of the evaluation (directive 11.04.05 of the
HEIG-VD's records directive of 28 May 2024); their elimination needs a disposal
form (bordereau) agreed by the Archives cantonales vaudoises, and the same
principle holds online; the school has no validated list of tools. Three
questions — the validation of a tool, the HEIG-VD as controller and the
operator as processor, the transfers to the United States (Anthropic, GitHub)
— were escalated to the school's Direction and have no answer yet. The
retention of attempts and the elimination register the bordereau needs are
issue #1027, not this record.

**What a re-login does today.** `admissionFacts` treats an account whose
`oidc_sub` matches but which carries `anonymized_at` as unknown, so a returning
person goes through admission (ADR-111) like a stranger. If admitted, `signIn`
upserts on `oidc_sub` and writes the fresh edu-ID name, address and picture
**onto the anonymized row**: a re-identified zombie. §7 closes it.

## Decision

1. **Principle.** Pseudonymizing an account replaces its identity and keeps
   its work. It has three triggers, all through one routine and one wipe list
   (§8): the inactivity lifecycle of a student account (§3), the student's own
   request (§5), and the administrator's act on any account (§6). Content is
   never deleted by it, nor by any automatic rule of this record.

2. **Inactivity.** An account's last activity is the latest of
   `users.last_login_at`, `presence_last_seen.at`, and the `last_used_at` of its
   API tokens and of its OAuth tokens; its `created_at` when none exists. A
   session opened in its name by an administrator (`impersonation`, ADR-034)
   never counts as its activity.

3. **The student lifecycle.** A student account is *active*, then *dormant*,
   then pseudonymized:
   - after **two years** without activity (§2), the platform sends one e-mail
     (§4) and records it in `users.inactivity_notified_at`: the account is
     **dormant** (glossary §1.5; never "archived", which is a classroom's state);
   - **nine months** after the notice, a reminder, recorded in
     `users.inactivity_reminded_at`;
   - **twelve months after the notice**, the daily job (§10) pseudonymizes it.
   Dormant ⇔ `inactivity_notified_at IS NOT NULL`. Every sign-in, through edu-ID
   (`auth/login.ts`, `signIn`) or the development login (`auth/dev.ts`), resets
   both columns to null. The horizon counts from the notice, never from
   `last_login_at + 3 years`: imported accounts carry old dates, and a mailer
   that only logs (development, staging) must not lead to a wipe nobody was
   told about.

4. **The e-mail.** A new account-level notification kind, e-mail only, outside
   the preferences grid, that cannot be turned off; written in `users.locale`.
   It says that the person has not used Quiz for two years, that signing in
   within the year keeps the account, and that otherwise it will be anonymized;
   it points first to **Download my data** (N-DATA-04, ADR-112). It goes to the
   effective notification address (ADR-030, amendment of 2026-10-28) **and** to
   the edu-ID login address (`users.email`) when it differs. If no address
   works, the lifecycle runs all the same. Settings carries no sentence inviting
   a personal address.

5. **A student's own request.** A dormant account that signs in is active
   again, and a notice points the student to Settings, where an action
   pseudonymizes their own account at once: student accounts only, a typed
   confirmation (`apps/web/src/confirm.tsx`), the caller's own `portal`
   session only (never a `seb`, `kiosk` or `impersonation` session, an API
   token or an OAuth grant), never delegated. The same action is there for any
   student account, dormant or not.

6. **The administrator's act, and staff accounts.** The administrator may
   pseudonymize **any** account, student or staff, one at a time, with a typed
   confirmation, and only while Super Powers are on
   ([ADR-054](ADR-054-super-powers-admin.md)): a request the HEIG-VD's records
   officer relays lands on the administrator. The guards of §10 apply as to
   the job. The admin screen lists the accounts inactive for one year or more
   and those past the horizon of §3.
   An account that holds a course staff seat, a pool seat, a teacher grant or
   the admin role is a staff account: it is **never pseudonymized
   automatically**, nor by its own action (§5); only the administrator's act
   reaches it. Identity only: its pools pass by the succession of
   [ADR-013 §5](ADR-013-partage-des-pools.md#decision) (first member by
   seniority; a pool with no member keeps its owner id, now pseudonymous); its
   course seats are kept; its questions keep their rows under an anonymous
   author; its templates and classrooms stay.

7. **Re-login creates a fresh, empty account.** `oidc_sub` becomes
   `anon-<id>`, the convention heig-classroom used, which the import already
   treats as fresh (`import-classroom/identity.ts`). No identity provider issues
   it, so a later edu-ID login finds no account and, if admitted (ADR-111),
   creates a new one with nothing in it. No hash of the old subject is kept: a
   hash is itself a lasting identifier, and it would only serve to lock a
   returning person out. `signIn` and the session plugin (`auth/plugin.ts`)
   refuse an anonymized account (defence in depth), and `signIn` never writes
   an identity onto an anonymized row. No future adoption by
   `swiss_edu_id` (open question 57) can bring a pseudonymized account back:
   its `swiss_edu_id` is gone with the rest of the identity.

8. **One wipe list, shared with staging.** The per-account fragment is the
   database function `quiz_pseudonymize_account(...)`, created by migration
   `0129`; a later migration changes the list with `CREATE OR REPLACE`. The
   service runs it inside its transaction (§10), and
   `scripts/staging-pseudonymize.sql` calls it once per person, the whole-copy
   rest staying in the script. The staging export therefore requires
   production at migration `0129` or later. The function is parameterized: the subject prefix (`anon-` here, `staging:` on staging),
   the replacement names, and whether it sets `anonymized_at` — production
   does, staging does not, else every copied account would lose its role and
   leave the admin list. `apps/api/src/stagingScrub.db.test.ts`, which searches
   every row of every table, proves the fragment on one account beside an
   untouched one, and knows that the audit log keeps the identity (§11). The
   fragment covers what the script already does for a person (account fields,
   addresses, IdP claims, avatar, Teams link, roster lines, grants, GitHub
   identities), and also deletes what staging truncates wholesale
   (`scripts/staging-scrub.sql`) — the account's sessions, launch tickets, API
   tokens, OAuth grants, Teams link tokens, kiosk pairings in progress — and
   rows neither script names: `presence_hours`, `presence_last_seen`
   (ADR-107), `notification_preferences`, `user_course_prefs` and its
   notifications. A claimed roster line loses its **e-mail** too, else a
   re-imported roster line or a login under that address re-claims the seat.
   `project_repos.full_name` stays in staging's whole-copy part: the repository
   on GitHub is kept and unrenamed (F-PROJ-16, D19) and the platform reaches it
   by that name (`modules/codespace/service.ts`, `modules/project/webhooks.ts`).
   **This is an explicit exception to the convention that a module writes only
   its own tables**: one list, one test, instead of a second wipe list spread
   over a dozen services that would drift from the staging one.

   **Kept under the pseudonymous id**: attempts, answers, the attempt journal,
   gradings and their comments, released-grade snapshots, the gradebook,
   project runs and scores, push receipts, `codespace_launches` (project and
   dates), `llm_calls` (an account id, never content), and the drill data
   (§9).

9. **Drill data is kept** under the pseudonymous id: cards, reviews and the
   rounds of targeted revision. The five-year purge of
   [ADR-041 §8](ADR-041-entrainement-espace.md#8-data) still applies, and so
   does the deletion with a classroom, an evaluation or a question (settled
   question 28 (a)). The proposal of 2026-10-26 deleted it; the owner keeps it.

10. **Guards and the job.** Whatever the trigger, nothing is pseudonymized
    while the account has an open attempt — an attempt in progress in an
    exam whose state is not closed (the ticker closes it, invariant 5); an
    exercise or poll attempt never blocks, since an exercise stays open after
    its due date (#985) — or a seat in an unarchived
    classroom whose `period_end` (a `YYYY-MM` text, `db/org.ts`) is the current
    month or later, by the database's clock; an undated classroom never
    blocks, and the job logs that it met one. The daily job
    (`accounts.lifecycle`) sends the notices and reminders and pseudonymizes
    what is due, and runs only when `ACCOUNT_LIFECYCLE=1` (off on staging;
    production turns it on when the operator decides). Per run it
    pseudonymizes at most **20** accounts; above, it raises a `system_alert`
    to the administrator (ADR-055) and stops. Each account is handled in its
    own transaction, under `SELECT … FOR UPDATE` on its row, with the
    inactivity and the guards checked again inside it (a sign-in may race the
    job). Inside that locked transaction, after the guards are checked again
    and before the wipe, GitHub access is revoked, as a roster removal does
    (`org` service); a failure rolls everything back (`502 revoke_failed`,
    nothing written). An account whose revocation fails is skipped by the job
    and tried again the next day, and after three failures a
    `system_alert` names it. Each pseudonymization writes one audit row,
    `user.anonymized`, whose payload is the account id and
    `by: "lifecycle" | "self" | "admin"` (a new member of the union of
    `apps/api/src/audit.ts`).

11. **The audit log** is untouched at pseudonymization, under
    [ADR-003 §5](ADR-003-postgresql-drizzle.md#decision). The payloads of
    `roster.import`, `roster.claim`, `roster.remove`, invitations, grants and
    GitHub links carry names, addresses and logins: **the operator can
    re-identify a pseudonymized account from them** while they last. They last
    three years: ADR-003 §5's amendment of 2026-11-05 (ruled on the owner's
    delegation) gives `audit_log` and `legacy_classroom_audit_log` a retention
    of three years from each row's creation, by the database's clock, purged by
    a daily job; no row is ever updated. Accepted consequence: the provenance
    of a grade (`grading.*` rows) goes after three years while the grade stays.

12. **Residuals, stated.** The backups, about four months (N-DATA-03); the
    audit log, three years (§11); GitHub commits and repository names, and
    `project_repos.full_name` (§8); the scan of a paper copy, which may carry
    the student's handwritten name and stays with its attempt
    ([ADR-125](ADR-125-copies-papier-pdf-typst.md) §15); unclaimed roster
    lines, which are the teacher's class list and never the account's; the
    help assistant's stored conversations, which may quote the name until their
    30 days pass (ADR-080 §6, and §8 for the warning); the provider's side of past model calls; the
    online workspace's own database (`apps/codespace/src/db/schema.ts`: login,
    e-mail, display name, GitHub login, and the volume directory named after
    the login), which the operator handles by hand, by a run the deployment
    runbook (`docs/development/deployment.md`) gains with the job; the off-site borg archives of
    heig-classroom's dumps, until their retention prunes them (about three
    months from 2026-10-14). The owner's workstation copy of heig-classroom's
    final dump, `hgc-2026-10-14.dump`, was deleted on 2026-11-05 (product
    owner): that residual is closed. The heig-classroom import is never re-run;
    its source is gone since M9-01 (2026-10-15).

13. **N-DATA-08**, added to [03](../spec/03-exigences-non-fonctionnelles.md),
    which owns the requirement's wording:

    > An account's identity leaves the platform once the account is no
    > longer used; its work stays. A student account with no activity for
    > two years (the latest of its last sign-in, its last request, and the
    > last use of its API or OAuth tokens; its creation when none; a session
    > an administrator opened in its name never counts) receives one e-mail,
    > at its notification address and at its edu-ID login address when they
    > differ, and becomes **dormant**; a reminder follows nine months later,
    > and twelve months after the notice a daily job pseudonymizes it. Any
    > sign-in before then makes it active again. A student may pseudonymize
    > their own account earlier from Settings, with a typed confirmation,
    > from their own portal session. The administrator, with Super Powers on
    > (ADR-054), may pseudonymize any account, one at a time, with a typed
    > confirmation; a staff account is never pseudonymized otherwise, and
    > its pools pass to their next member (ADR-013 §5) while its questions,
    > templates and classrooms stay. Nothing is pseudonymized while the
    > account has an attempt in progress in an exam not yet closed (an
    > exercise or poll attempt never blocks) or a seat in an unarchived
    > classroom whose period has not ended. Pseudonymization replaces the
    > identity (names, addresses, edu-ID identifiers, picture, GitHub and
    > Teams links, the e-mail of the roster lines it claimed) and revokes
    > its sessions, tokens and GitHub access; attempts, answers, gradings,
    > grades and drill data stay under the same id. It is not deletion: the
    > audit log (three years, N-SEC-09), the backups (about four months,
    > N-DATA-03), GitHub commits and repository names, and the scans of
    > paper copies keep the identity, and the operator can re-identify the
    > account until they go. A later sign-in creates a new, empty account,
    > through admission (ADR-111). Audited as `user.anonymized` (ADR-117).

## Consequences

- ADR-013's "an account is never deleted" stays true: the row stays,
  pseudonymized. ADR-003 §5's "not a Quiz requirement" sentence is amended,
  and the audit log gains a retention (§11).
- The data-protection guide and the privacy pages (N-DATA-07) describe the
  lifecycle, worded as pseudonymization, never as deletion; the *Known limits*
  entry "no deletion or pseudonymisation of accounts" changes accordingly.
- The staging script keeps the whole-copy rest and calls the per-account
  function (§8); a table added to the function is then pseudonymized by both,
  under the one test.
- The routine writes other modules' tables directly (§8): accepted for this
  one fragment, not as a precedent.
- The staging export requires production at migration `0129` or later, since
  `scripts/staging-pseudonymize.sql` calls the function it creates (§8).
- In the millisecond window where a sign-in has passed its refusal check
  before the wipe commits, that sign-in creates a fresh, empty account without
  admission. Accepted: the window is tiny, and the new account holds nothing.
- A lifecycle e-mail that reaches nobody still leads, a year later, to the
  pseudonymization of a student account. Accepted: the account had two years
  of silence, and its work stays.
- An administrator can no longer read a former student's name beside their
  results once the lifecycle has run, Super Powers included.

## Alternatives considered

- **Deleting the account and its rows.** Breaks the grade records, the
  gradebook and every foreign key; contradicts ADR-013 and N-DATA-03.
- **Each module's service pseudonymizes its own rows.** Respects module
  ownership, but makes a second wipe list beside the staging one, tested
  separately, that drifts.
- **Rewriting the audit payloads, or keeping a hash of the subject.** See §11
  and §7. The retention of §11 bounds the re-identification without rewriting
  a row.
- **Pseudonymizing at `last_login_at` plus three years, without a notice.**
  Imported accounts carry old dates, and a mailer that only logs would wipe
  accounts nobody was told about; the notice is the clock (§3).
- **Pseudonymizing staff accounts automatically.** A teacher's account owns
  pools and content other teachers rely on; the administrator decides, one at
  a time (§6).
- **Deleting the drill data with the identity** (the proposal of 2026-10-26).
  The owner keeps it; ADR-041's five-year purge already bounds it (§9).
- **Self-service from the student's settings** — rejected by the proposal of
  2026-10-26 as irreversible on one click and needing someone to validate the
  request. **Reversed on 2026-11-05**: the owner wants the platform, not a
  person, to decide on accounts, and the lifecycle already pseudonymizes an
  unused student account without anyone's validation; a student asking for it
  sooner only brings forward what happens anyway. The typed confirmation, the
  portal-only session and the guards of §10 answer the one-click risk, and the
  work stays, so nothing a teacher needs is lost.
- **An operator command only** (the proposal's §1). A request would wait for
  the operator, and the lifecycle needs a job anyway.

## The owner's answers (2026-11-05)

The proposal of 2026-10-26 asked seven questions; the product owner answered
them on 2026-11-05 (issue #681).

- **A. A real request or an institutional ask?** None exists. The owner
  decided the lifecycle anyway, as risk reduction (*Context*).
- **B. Who validates a request?** No one beyond the person: a student
  pseudonymizes their own account (§5); the job handles unused student
  accounts (§3); the administrator, with Super Powers, handles any account,
  a staff account only so, and a request the records officer relays (§6,
  ruled on the owner's delegation the same day). The school's
  side is the HEIG-VD's records officer (*Context*).
- **C. Re-login creates a fresh, empty account, no hash kept?** Yes (§7).
- **D. The audit log untouched, and re-identification stated?** Yes, at
  pseudonymization time (§11); its retention of three years was ruled on the
  owner's delegation the same day.
- **E. An operator command or an admin screen?** Neither alone: a daily job,
  the student's own action in Settings, and an admin screen with a typed
  confirmation, under Super Powers, for any account (§3, §5, §6).
- **F. A deletion date for `hgc-2026-10-14.dump`?** Deleted on 2026-11-05
  (§12).
- **G. The retention period as a separate issue?** Yes: issue #1027.
