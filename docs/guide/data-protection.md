# Data protection

This page describes what the platform does with the personal data of its users, students and teachers. It is based on the code as it stands: every statement points to a file of the [repository](https://github.com/heig-tin-info/heig-quiz), and what could not be established from the code is marked **To be confirmed**.

## Framework and approach

The platform is used by teachers of the HEIG-VD, a public institution of the canton of Vaud and a member of the HES-SO. The reference text is the Vaud law on the protection of personal data (Loi vaudoise sur la protection des données personnelles, LPrD, BLV 172.65), currently under revision.

This page does not say whether the processing meets that law; judging it is not the role of a piece of software's documentation. It describes, in good faith, what is in place, what is not yet, and what remains to be checked. The section [Known limits](#known-limits-and-planned-improvements) lists them; they are tracked in issue [#274](https://github.com/heig-tin-info/heig-quiz/issues/274).

Who is formally responsible for the processing (the HEIG-VD, a department, the teacher), and whether the processing has been declared to an authority or to a data protection officer: **To be confirmed**.

## Data collected and where it comes from

The platform receives data from three sources: Switch edu-ID at sign-in, the class list imported by the teacher, and what the user does on the platform.

### At sign-in, from Switch edu-ID

At every sign-in, edu-ID sends the identity of the account and the platform copies it (`apps/api/src/auth/oidc.ts`, `apps/api/src/auth/login.ts`):

| Data | Used for |
| --- | --- |
| edu-ID identifier (`sub`, `swissEduPersonUniqueID`) | Recognising the account from one sign-in to the next |
| First name, last name, e-mail address | Showing the person, attaching them to their seat in a classroom |
| Further e-mail addresses (institutional, private, linked) | Attaching a seat created with another address of the same account |
| Affiliations (`staff@heig-vd.ch`, `student@…`) | Deciding between the teacher and student roles |
| The address of a picture, if edu-ID provides one | Showing a portrait |

Two tables deserve a mention. `user_emails` keeps every address ever seen for an account, even once the matching affiliation has ended. `user_idp_claims` keeps everything edu-ID sent at the last sign-in, unfiltered; the code gives the diagnosis of sign-in problems as the reason (`apps/api/src/auth/claims.ts`). This information is displayed nowhere and no route exposes it.

Which claims edu-ID actually releases for HEIG-VD accounts, the picture included: **To be confirmed**.

### From the class list

The teacher imports a spreadsheet with, for each student, last name, first name, e-mail address and, where it applies, an extra-time percentage (`packages/domain/src/roster.ts`). The teacher may add a free-form note about a student, which the student never sees (`apps/api/src/db/org.ts`).

### While the platform is used

| Data | Detail |
| --- | --- |
| Answers | Saved as they are typed, with the questions marked for review |
| Attempts | Start time, deadline, hand-in, extra time granted, last sign of life |
| Attempt journal | Tab changes, loss of window focus, reconnections, pauses and extensions (`apps/web/src/attempt/signals.ts`) |
| Gradings | Points, the teacher's comment, the history of changes |
| Released grades | A snapshot of the grades at the moment of release |
| Profile picture | If the user uploads one |
| Notifications | Platform messages, preferences, the link to a Microsoft Teams account |
| Anonymous polls | A hash of the browser's cookie, with no identity |

The attempt journal is kept for every evaluation, whether its **Log tab changes** setting is on or off (see [Known limits](#known-limits-and-planned-improvements)).

The IP address is not stored in the database, with one exception: a refused Safe Exam Browser access writes it to the audit log. It does appear in the technical log of every request (`apps/api/src/redact.ts`). The platform records neither the browser in use, nor keystrokes, nor any audience measurement.

## Purposes

The data is used to:

- identify the person and give them access to their classrooms;
- run evaluations: the clock, extra time, saving the answers;
- grade, automatically or by the teacher, and release the results;
- let the teacher follow an evaluation as it runs, the attempt journal included;
- send notifications, when they are enabled;
- produce per-evaluation statistics for the teacher (see [Statistics](#statistics-and-anonymisation));
- keep a trace of changes (the audit log) and diagnose failures (the technical log).

The code contains no advertising or commercial use, and no data is sent to an AI model for grading: that feature is not active (`apps/api/src/modules/grading/jobs.ts`).

## Who reaches what

### Students

A student sees their classrooms, the evaluations opened there, their own answers and, once released, their results and the feedback the teacher chose to give. They see neither the list of their classmates nor their answers: every access is filtered on their own account (`apps/api/src/modules/guards.ts`).

### Teachers

A teacher reaches the data of a course only if they are on that course's staff. The check is made when the data is loaded; without a staff seat, the answer is the same as if the course did not exist (`apps/api/src/modules/guards.ts`, the `staffAccess` predicate).

Within a staff, every member has the same rights, over every classroom of the course, past years included. Any staff member may add a colleague to it. A teacher who is not on a course's staff sees nothing of its students.

A teacher who connects an AI assistant to the platform (see [AI assistants](assistants.md)) gives it access to courses, pools and evaluations, including the names and addresses of a course's staff. No tool of the assistant reaches a classroom's list of students.

### The application administrator

One account, named in the server configuration, holds the administrator role (`apps/api/src/roles.ts`). It reaches every course and every classroom, sees the list of all accounts, and may open a one-hour read-only view of a student's account to help them (ADR-034). The start and the end of that view are written to the audit log; the student is not told.

### The system administrator

Whoever administers the machines has access to the database, the backups and the logs, and therefore to all the data. These accesses go through system tools (SSH, `psql`) and are not traced by the platform. Who holds these accesses: **To be confirmed**.

### What is traced

The audit log (`apps/api/src/audit.ts`) records the actions that change something: sign-ins, imports and edits of class lists, gradings, releases of results, opening a view as a student, grants made by the administrator. It does not trace reads: who looked at which paper or which class list is recorded nowhere.

## Hosting and location of the data

The platform runs at the hosting provider Hetzner, on two virtual machines (`docs/development/deployment.md`):

- the application machine carries the application server, the PostgreSQL database and the daily database backups; it also hosts two other services (heig-classroom and evaluation-tb), whose files the other accounts cannot read;
- a second machine runs the code submitted by students, in isolated containers (ADR-016). It receives the program to run and its test data, with no student name or identifier (`packages/core/src/runner.ts`).

The specification says "a server in Europe" (`docs/spec/03-exigences-non-fonctionnelles.md`, N-DATA-01). The country and the datacenter of each machine: **To be confirmed**. An older decision (ADR-009) mentions hosting in Switzerland; it predates the move to Hetzner and no longer describes the situation.

A staging environment runs on the same machine and receives a copy of the production data that is **not anonymised**, to test under real conditions (ADR-028). Its access is limited to a list of accounts, and its reference configuration turns off e-mail and Teams notifications (`.env.staging.example`).

External services called:

| Service | What it receives |
| --- | --- |
| Switch edu-ID | The sign-in (it is the one that sends the identity) |
| Scaleway Transactional Email (Paris region by default) | The recipient's address, the title of the evaluation or the name of the pool concerned; no grade, according to the code (`apps/api/src/modules/notifications/`) |
| Microsoft Teams | For a linked account, a notification with the title concerned; limited to the authorised organisations |
| The host of the edu-ID picture | A browser showing a portrait that was not uploaded loads it directly from the address edu-ID provided |

Whether e-mail and Teams are enabled in production: **To be confirmed**. The platform loads no analytics script, and no font or library from a third party: everything is served by the server itself.

## Retention and what happens to the data after the studies

**No retention period is defined or enforced today.** The data stays until a teacher deletes it (`docs/spec/03-exigences-non-fonctionnelles.md`, N-DATA-03). In particular, nothing happens automatically when a student completes or leaves their studies.

What is deleted, and when:

| Action | Effect |
| --- | --- |
| Deleting an evaluation | Its attempts, answers, attempt journals and gradings are deleted |
| Deleting a classroom or a course | The same for all its evaluations, plus the class list |
| Archiving a classroom | Nothing is deleted: the classroom is only hidden |
| Removing a student from the class list | Their seat goes; their attempts, answers and grades stay in the database |
| Expired sessions | Deleted automatically, every ten minutes |

What is never deleted automatically: the accounts (there is no account deletion), the e-mail addresses and edu-ID information kept, and the audit log, which in particular keeps the name and address of a student removed from a classroom.

After a deletion, the data remains in the backups until they rotate: 30 days for the daily database copies, 7 days for the Hetzner backups of the machine (`compose.prod.yml`, `docs/development/deployment.md`). The staging copy keeps it until its next refresh.

The retention period the institution wants after the studies: **To be confirmed**.

## Statistics and anonymisation

The statistics the platform shows are computed **per evaluation**, when they are displayed, from the nominative data: mean, grade distribution, success rate of each question, distribution of the answers (`apps/api/src/modules/results/service.ts`). Only the course's staff sees them. The CSV export of the results is nominative.

There is no separate or anonymised statistics store. As a consequence:

- deleting an evaluation deletes its statistics too;
- as long as they exist, the statistics stay linked to the people;
- no minimum group size is applied: in a small classroom, a grade distribution or a success rate may let someone recognise a student.

Per-question statistics over several years and aggregated pool statistics, which the specification plans (F-STAT-01, N-DATA-06), are not implemented. The "difficulty" of a question is a value chosen by its author, not a computation over results.

During an evaluation, the teacher's dashboard may show a pseudonym (an adjective and an animal) instead of the name, for instance when it is projected in class (`packages/domain/src/pseudonym.ts`). It is a display choice: the data in the database stays nominative.

## Security measures

Sign-in and sessions:

- no password of the platform's own: sign-in goes through Switch edu-ID (OIDC with PKCE);
- the session is a random value of which the server keeps only a hash; the cookie is out of reach of the page's JavaScript, sent over HTTPS only in production, and expires at most 12 hours after the last activity with the reference configuration (`apps/api/src/auth/session.ts`, `.env.prod.example`);
- requests that change something are protected against cross-site request forgery (`apps/api/src/auth/plugin.ts`);
- the development sign-in, which lets anyone pick a fictitious identity, stops the server from starting in production (`apps/api/src/config.ts`);
- API tokens and the authorisations given to AI assistants are stored as hashes only (ADR-022, ADR-023).

Network and storage:

- all traffic between the browser and the server is encrypted (HTTPS, with HSTS); so is the traffic to the code execution machine, which accepts only the application machine (`Caddyfile`, `apps/runner/deploy/Caddyfile`);
- the database is not exposed on the network: only the application reaches it, over a network internal to the machine;
- secrets (passwords, keys) are in files reserved to the service account, never in the repository or the database (ADR-010);
- students' code runs in containers with no network, no secret, no access to the machine's files, and limits on memory, processes and time (`apps/runner/README.md`).

What is not in place or not established: disk and backup encryption is not described in the repository (**To be confirmed**); the daily database copies sit on the machine itself and are not encrypted; no retention period for technical logs is configured in the repository (**To be confirmed** on the machine).

## Students' rights and whom to contact

What the platform lets a student do today:

| Need | In the application |
| --- | --- |
| See their profile | Yes: name, e-mail address, role, last sign-in (**Settings**) |
| See their results and gradings | Yes, once the teacher has released them, as far as the evaluation allows |
| See their attempt journal | No: only the teacher sees it |
| Export their data | No: there is no export for students |
| Correct their name or address | Not in the platform: they come from edu-ID and are updated at every sign-in; a mistake in the class list is corrected by the teacher |
| Delete their data | Only their profile picture and their Teams link |

For any request (access, copy, correction or deletion), the student turns first to the course's teacher, who can correct a class list or delete an evaluation. Extracting all the data of a student or deleting their account is possible through no feature of the application: only direct access to the database allows it.

The institutional contact for these requests, and the supervisory authority to name: **To be confirmed**.

## Known limits and planned improvements

The following points are known and tracked in issue [#274](https://github.com/heig-tin-info/heig-quiz/issues/274). None is fixed as of this page; none is scheduled unless the issue says otherwise.

Retention and deletion:

- no retention period, no purge after a student leaves;
- no deletion or anonymisation of accounts: the column meant to mark an account as anonymised exists, but no code sets it;
- removing a student from a classroom does not delete their attempts or grades;
- the edu-ID information is kept unfiltered and with no time limit;
- the audit log is never purged and contains names and addresses.

Statistics:

- every statistic is nominative; no anonymised version is produced or kept;
- no minimum group size: small classrooms are re-identifiable.

Access and traceability:

- reads are not traced, neither the teachers' nor the administrator's;
- direct access to the machine and the database is not traced by the platform;
- the audit log is described as unmodifiable by the application, but the production configuration does not enforce it;
- the student is not told that an administrator opened a view of their account;
- any signed-in user can fetch another user's uploaded picture if they know that user's internal identifier;
- a personal API token carries all its owner's rights and may never expire.

Informing the student:

- the application has no "Data and privacy" page yet (N-DATA-07), and no data export (N-DATA-04);
- the student is not told in the interface that tab changes and loss of focus are recorded, and does not see that journal;
- an evaluation's **Log tab changes** setting has no effect: the journal is always kept.

Hosting and security:

- the daily database copies sit on the machine they protect, unencrypted; the copy off the machine is not in place;
- staging holds a copy of the real data that is not anonymised;
- the site's content security policy (CSP) does not restrict where scripts come from;
- the location of the machines, disk encryption and the retention of technical logs remain to be confirmed.
