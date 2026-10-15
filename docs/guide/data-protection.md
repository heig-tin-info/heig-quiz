# Data protection

This page describes what the platform does with the personal data of its users, students and teachers. It is written for a reader responsible for data protection at the school as much as for a teacher. It is based on the code and the deployment documentation as they stand: every statement points to a file of the [repository](https://github.com/heig-tin-info/heig-quiz), and what could not be established from them is marked **To be confirmed**.

## Framework and approach

The platform is used by teachers of the HEIG-VD, a public institution of the canton of Vaud and a member of the HES-SO. The reference text is the Vaud law on the protection of personal data (Loi vaudoise sur la protection des données personnelles, LPrD, BLV 172.65). The European GDPR is not the reference. Whether a revision of the LPrD is under way, and what it would change for this page: **To be confirmed**.

This page does not say whether the processing meets that law; judging it is not the role of a piece of software's documentation. It describes, in good faith, what is in place, what is not, and what remains to be checked. The section [Known limits](#known-limits) lists what is missing; the gaps are tracked in issue [#274](https://github.com/heig-tin-info/heig-quiz/issues/274). The rules the platform is meant to follow are the N-DATA requirements of the specification (`docs/spec/03-exigences-non-fonctionnelles.md`).

Who is formally responsible for the processing (the HEIG-VD, a department, the teacher), and whether it has been declared to an authority or to the school's data protection officer: **To be confirmed**.

## Words used on this page

Pool
:   A teacher's collection of questions, used by the evaluations of the courses it is linked to.

Staff seat
:   A teacher's place on a course's staff, as owner or assistant; it is what gives access to the course's classrooms and students.

Drill
:   Spaced practice: a student reviews, at growing intervals, questions already met in an evaluation.

Super Powers
:   A one-hour switch by which the application administrator reaches every course and classroom of the platform.

Kiosk station
:   One of the school's Chromebooks locked on the platform, on which a student sits an exam after pairing it with their phone.

## In short

- Sign-in goes through Switch edu-ID; the platform has no password of its own.
- A teacher reaches the students of a course only through a seat on that course's staff; a student sees only their own work.
- Data is kept until a teacher deletes it (N-DATA-03). A few kinds of data have a shorter, automatic retention (the integrity journal, the drill, the help assistant, the hours of activity, GitHub's notifications, a project's evidence files). Nothing is deleted when a student finishes their studies, and there is no account deletion.
- Content, including some student answers and student code with the names masked, is sent to an AI model (Anthropic) through one gateway that logs every call.
- The servers are rented from Hetzner: the application machine in Nuremberg (Germany), the code machine and the off-site encrypted copy of the backups in Helsinki (Finland). Nothing is hosted in Switzerland.
- Reads of personal data are mostly not traced: only the opening of one student's paper by the staff and an administrator's reading of help-assistant conversations are.

## Personal data

The platform receives data from three sources: Switch edu-ID at sign-in, the class list imported by the teacher, and what people do on the platform. The tables live in the PostgreSQL schema under `apps/api/src/db/`; the column "Kept until" says what deletes the data, and "a teacher deletes" means the deletion of the evaluation, classroom, course or project it belongs to (see [Retention](#retention-and-deletion)).

### Identity and account

| Data | Where | Source | Kept until |
| --- | --- | --- | --- |
| edu-ID identifiers (`sub`, `swissEduPersonUniqueID`), first name, last name, e-mail address, picture address, last sign-in, preferences | `users` (`db/auth.ts`) | edu-ID, at every sign-in (`auth/oidc.ts`, `auth/login.ts`) | Never deleted: there is no account deletion |
| Every e-mail address seen for the account (institutional, private, linked) | `user_emails` (`db/auth.ts`) | edu-ID | Never deleted, even once an affiliation ends |
| Everything edu-ID sent at the last sign-in, affiliations included, unfiltered | `user_idp_claims` (`db/auth.ts`) | edu-ID | Replaced at each sign-in, never deleted |
| Role grants (an address granted the teacher role) | `teacher_grants` (`db/auth.ts`) | administrator | Until revoked |
| Uploaded profile picture | `avatars` (`db/auth.ts`) | the user | Until the user removes it |
| Sessions (a hash of the cookie only, kind, expiry) | `sessions` (`db/auth.ts`) | server | Deleted every ten minutes once expired |
| API tokens and AI-assistant authorisations (hashes only) | `api_tokens`, `oauth_*` (`db/auth.ts`) | the user | Until revoked; expired OAuth rows are deleted every hour |
| Notifications, preferences, the link to a Microsoft Teams account (tenant, object id, Teams name) | `notifications`, `notification_preferences`, `teams_links` (`db/notifications.ts`) | server, Teams | Never deleted automatically; the user may remove the Teams link |
| Hours of activity: one row per person and hour in which their own session reached the server | `presence_hours` (`db/presence.ts`, ADR-107) | server | Eight days |
| Last activity: the time of the last request of their own session | `presence_last_seen` (`db/presence.ts`) | server | Lives with the account |
| Linked GitHub account: GitHub id and login, date of the link | `github_accounts` (`db/github.ts`) | the user, through GitHub | Until the user removes the link |

`user_idp_claims` is kept unfiltered on purpose: the code gives the diagnosis of sign-in problems as the reason (`apps/api/src/auth/claims.ts`). It is displayed nowhere and no route exposes it. Which claims edu-ID actually releases for HEIG-VD accounts, the picture included: **To be confirmed**.

### Classrooms and evaluations

| Data | Where | Source | Kept until |
| --- | --- | --- | --- |
| Class list seat: last name, first name, e-mail address, extra time, the teacher's free-form note (never shown to the student) | `enrollments` (`db/org.ts`) | roster import by the teacher (`packages/domain/src/roster.ts`) | The student is removed from the list, or a teacher deletes |
| Attempts: start, deadline, hand-in, extra time, last sign of life, the question on screen and since when (ADR-039) | `attempts` (`db/live.ts`) | server | A teacher deletes |
| Answers, questions marked for review | `answers` (`db/live.ts`) | the student | A teacher deletes |
| Attempt journal: reconnections, pauses, extensions, code runs; and, while the evaluation's **Log leaving the page and pasting** is on, leaving the page and pasting from outside it (the length, never the content) | `attempt_events` (`db/live.ts`, ADR-088) | the student's browser (`apps/web/src/attempt/signals.ts`) and the server | Leaving the page and pastes: the release of the grades, or six months after the close; the rest: a teacher deletes |
| Gradings: points, the teacher's comment, the history of changes, an AI proposal and its justification | `gradings` (`db/grading.ts`) | automatic grading, AI proposal, teacher | A teacher deletes |
| Released grades, a snapshot per student | `evaluations.released_grades` (`db/evaluation.ts`) | release of the results | A teacher deletes |
| Gradebook marks (absent, a mark entered by hand) | `gradebook_marks` (`db/gradebook.ts`) | teacher | The student leaves the list, or a teacher deletes |
| Drill: per question practised, the scheduler's state; per review, the rating, right or wrong, active time, the answer given, the device class (touch or mouse) | `drill_cards`, `drill_reviews` (`db/drill.ts`, ADR-041) | the student | Five years, or sooner if a teacher deletes |
| Poll participants without an account (a hash of a cookie, a chosen pseudonym) and their answers | `guest_participants` (`db/live.ts`) | the browser | Never deleted while the poll exists |
| Kiosk pairing: which student sat which exam on which school Chromebook, who approved it | `kiosk_pairings` (`db/kiosk.ts`, ADR-051) | the student's phone, the supervisor | Never deleted automatically |

### Projects, GitHub and the journal

| Data | Where | Source | Kept until |
| --- | --- | --- | --- |
| Which student accepted which repository, the GitHub accounts invited to it, groups | `project_repos`, `project_repo_access`, `student_groups`, `project_groups` (`db/project.ts`, `db/group.ts`) | the student, the teacher | A teacher deletes the project or classroom; the repositories themselves stay on GitHub |
| Receipt time, head and commit count of each push | `push_receipts` (`db/github.ts`) | GitHub | A teacher deletes |
| CI runs, scores, the teacher's score and comment; for a project graded by criteria, the evidence of each graded commit (test results, outputs, files) and the proposed and validated points per criterion with their rationales | `project_grade_runs`, `project_evidence`, `project_criterion_grades` (`db/project.ts`, ADR-106) | GitHub, AI proposal, teacher | Evidence files, commits and build and test output: six months after the release (`modules/project/evidence.ts`); the test cases and their statuses, and the rest: a teacher deletes |
| GitHub's notifications to the platform (webhooks) | `webhook_deliveries` (`db/github.ts`) | GitHub | Content erased once processed and 30 days after receipt |
| Online workspace: launches per student and project | `codespace_launches` (`db/codespace.ts`, ADR-078) | server | A teacher deletes the project |
| Classroom journal: pages, files, revisions with their author | `journal_*` (`db/journal.ts`) | teacher, or a copy of a GitHub repository | The journal or classroom is deleted |

### AI, logs and traces

| Data | Where | Source | Kept until |
| --- | --- | --- | --- |
| Each call to the AI model: purpose, model, token counts, estimated cost, the person it was made for; never the content | `llm_calls` (`db/llm.ts`, ADR-058) | server | Never deleted automatically |
| The help assistant's conversations: a teacher's questions and the answers | `assist_conversations`, `assist_exchanges` (`db/assist.ts`, ADR-080) | teacher, AI model | 30 days, or sooner if the teacher deletes them |
| Audit log: actor, action, subject, a JSON payload | `audit_log` (`db/auth.ts`, `apps/api/src/audit.ts`) | server | Never deleted, and protected against change |
| heig-classroom's audit log, imported as it was | `legacy_classroom_audit_log` (`db/importClassroom.ts`) | the heig-classroom migration | Kept indefinitely; read by no route |
| Technical log of each request: method, address with secrets masked, host, IP address | the containers' output (`apps/api/src/redact.ts`) | request | See [Technical logs](#technical-logs) |

The IP address is not stored in the database, with one exception: a refused Safe Exam Browser access writes it to the audit log (`apps/api/src/auth/seb.ts`). The platform records neither the browser in use (only the drill's device class), nor keystrokes, nor the content of a paste, nor any audience measurement beyond the hours of activity, which the administrator reads only as counts.

The time on each question never leaves the server: no screen shows it, to the student or to the teacher; only the pool statistics use it, as an aggregate (see [Statistics](#statistics)).

### How a student enters a classroom

The class list is the only way into a classroom: there is no join code (ADR-053). A seat is attached to an account only when the student opens Quiz themselves, at sign-in or at their next request, with an address edu-ID sent that matches the address on the list (`apps/api/src/auth/claims.ts`, `apps/api/src/modules/org/roster.ts`). Importing a list attaches no one.

## Purposes

The data is used to:

- identify the person and give them access to their classrooms;
- run evaluations: the clock, extra time, saving the answers, the attempt journal the teacher follows;
- grade, automatically, with an AI proposal the teacher validates, or by the teacher, and release the results;
- run projects in GitHub repositories and the online workspace;
- schedule the drill, the spaced practice of questions already met, and show its activity to the teacher;
- send notifications, when they are enabled;
- produce statistics, per evaluation for the teacher and per question in a pool;
- keep a trace of changes (the audit log) and diagnose failures (the technical log, the hours of activity).

The code contains no advertising and no commercial use. The platform loads no analytics script, and no font, library or image from a third party: everything is served by the server itself, except the one fetch of the Teams tab described under [Security measures](#security-measures) (`apps/api/src/csp.ts`).

## Who reaches what

### Students

A student sees their classrooms, the evaluations opened there, their own answers and, once released, their results and the feedback the teacher chose to give. They see neither the list of their classmates nor their answers: every access is filtered on their own account (`apps/api/src/modules/guards.ts`). Question content reaches them only through one filter that removes the answer key and the teacher's notes (`toStudent`, `docs/spec/05-architecture.md` §5.7).

### Teachers

A teacher reaches the data of a course only through a seat on that course's staff. The check is made when the data is loaded; without a seat, the answer is the same as if the course did not exist (`staffAccess` in `apps/api/src/modules/guards.ts`).

Within a staff, every member reaches every classroom of the course, past years included. Each holds a role (ADR-068): only an **owner** adds or removes a colleague, changes a role, or publishes or withdraws results; an **assistant** works in the classrooms.

When a classroom has the drill, its staff see each student's drill activity: the questions practised, the sessions, the recall rate and its progress (`apps/api/src/modules/drill/teacher.ts`). Students are told so in their drill tab and on the **Data and privacy** page. A student may leave the drill of a classroom; what was recorded before stays visible, and the teacher sees that the student left (ADR-041 §8).

A teacher who can read a question pool, a pool shared with them or a public one included, sees the aggregated statistics of its questions over every exam that used them, other teachers' classes included (see [Statistics](#statistics)).

Profile pictures are served only to someone who already sees that person: a colleague on a course staff, the staff of a course where the person sits a classroom, anyone who can read a pool the person owns (a public pool included), the person themselves and the administrator (`seesUser` in `apps/api/src/modules/guards.ts`). A student never receives another student's picture.

A teacher who connects an external AI assistant to the platform (see [AI assistants](assistants.md)) gives it access to courses, pools and evaluations, the names and addresses of a course's staff included; none of its tools reaches a classroom's list of students. The in-app help assistant differs on one point: it can also read the final results of the teacher's own classrooms, students' names included (see [Anthropic, the AI model](#anthropic-the-ai-model)).

### The application administrator

One account, named in the server configuration, holds the administrator role (`SUPER_ADMIN_EMAIL`, `apps/api/src/roles.ts`). By default it reaches no more than a teacher: the courses whose staff it is on. It reaches every course and classroom only while it has switched on **Super Powers** in its own browser session: one hour, not extendable, never for an API token or a connected assistant, and the switching on, off and the end are written to the audit log (ADR-054). Without them, it sees the list of all accounts, with their pictures and each account's last activity, and, in the **Activity** tab, the number of people active per hour over the last seven days, as counts only (ADR-107).

To help a student with a problem they report, the administrator, with Super Powers on, may open a view of that student's account (ADR-034): a one-time link, valid five minutes, opens at most one hour as the student. In production that view is read only: it cannot answer or submit anything (`apps/api/src/auth/plugin.ts`). Its start and end are written to the audit log under the administrator's name. The student is not notified; the student help and the **Data and privacy** page say, in general terms, that this can happen (`apps/web/src/help/student-home.md`, `apps/web/src/privacy/privacy.md`).

### The system administrators

Whoever administers the machines reaches the database, the backups and the logs, hence all the data, through system tools (SSH, `psql`) that the platform does not trace. The deployment runbook describes the policy: one personal account per person, sign-in by key only, no root sign-in on the application machine and, on the code machine, root only for the deployment's forced commands, and `sudo` writing who did what to a log kept for a limited period (`docs/development/deployment.md`, *Human access*; [Technical logs](#technical-logs)). Which persons hold these accounts on the production machines, today: **To be confirmed**.

### What is traced

The audit log (`apps/api/src/audit.ts`) records the actions that change something: sign-ins, class list imports and edits, gradings, releases, Super Powers, a view opened as a student, grants. A database trigger refuses any change or deletion of its rows (migration `0096_audit_log_immutable`, ADR-003 §5). It traces two kinds of read only:

- a member of a course's staff, or the administrator with Super Powers, opening one student's paper, from the live dashboard (the whole paper or one of its answers, the grid's hover preview included) or from a row of the grade table (`attempt.read`). It is one entry per opening, not per request: the same person's reads of the same paper are recorded at most once every 15 minutes, a window kept in the server's memory, so a restart may record one more;
- an administrator reading a teacher's help-assistant conversations (`assist.read`);
- a person downloading their own data (`privacy.export`, counts only, ADR-112).

The reads of a whole class are not traced, by decision (product owner, 2026-10-15, issue #875): one question's answers across the class, the grading table, the grade table, the per-question view and the CSV export. Nor are the grading history of one answer and the class lists. Who looked at those is recorded nowhere.

## Third parties

| Service | Role | What it receives | Where |
| --- | --- | --- | --- |
| Switch edu-ID | Identity provider | The sign-in; it is the one that sends the identity | Switzerland (Switch) |
| Hetzner Online (cloud servers) | Hosting | Everything: the application machine holds the database, the backups and the logs (see [Hosting](#hosting-and-location)) | Germany (application machine, Nuremberg) and Finland (code machine, Helsinki) |
| Hetzner Storage Box, Helsinki | Off-site copy of the backups | Encrypted archives only, which it cannot read | Helsinki, Finland |
| Anthropic (Claude) | AI model, once an administrator has stored a key | Question content; some student answers and student code, masked of names; a teacher's assistant questions and what it reads (below) | A United States company; where the requests are processed: **To be confirmed** |
| GitHub | Projects and journals, for a classroom connected to an organisation | The repositories the platform creates for students and the invitations of their linked GitHub accounts; a journal kept in a repository is only read | A United States company (Microsoft); where the data is held: **To be confirmed** |
| Scaleway Transactional Email (Paris region by default) | E-mail notifications, when enabled | The recipient's address, the title of the evaluation or name of the pool; never a grade (`apps/api/src/modules/notifications/`) | France (Paris) by default |
| Microsoft Teams | Notifications, for a linked account | A notification with the title concerned; limited to the authorised organisations | The tenant's Microsoft 365 region: **To be confirmed** |
| Google (Chrome Verified Access) | Proves a kiosk station is one of the school's Chromebooks (ADR-051) | The station's response to a challenge; no student data (`apps/api/src/modules/kiosk/attestation.ts`) | A United States company; where it is processed: **To be confirmed** |
| The host of the edu-ID picture | Source of a portrait not uploaded | A request from the server, which then serves the picture itself: a browser never contacts that host (`apps/api/src/modules/avatar.ts`) | Wherever edu-ID's picture address points |

Anthropic, GitHub and Google are United States companies: sending data to them is a transfer outside Switzerland and Europe, and no agreement specific to the platform covers it: only each provider's standard terms apply. Where each of them processes the data: **To be confirmed**.

E-mails and Teams messages carry titles, names of classrooms and pools, counts, and sometimes a colleague's name ("{name} shared the pool … with you"); never a grade or a question's content (`apps/api/src/modules/notifications/templates.ts`). Whether e-mail and Teams are enabled in production: **To be confirmed**.

### Anthropic, the AI model

Every call goes through one gateway on the platform's one key, stored encrypted (`apps/api/src/modules/llm/gateway.ts`, ADR-058). Each call is logged with its purpose, model, token counts and cost, never its content (`llm_calls`). What leaves, by purpose:

| Purpose | Triggered by | What is sent | Masking |
| --- | --- | --- | --- |
| Generating a question's answer, describing a pool, suggesting concepts, sorting concepts, a public pool's domain label (ADR-059, ADR-081, ADR-095) | A teacher or the administrator; the domain label also when a pool is published and in the nightly pass (`modules/pool/domain.ts`) | Question content, concept labels, pool names; never a student's data | Not needed |
| Nightly review of published questions (ADR-060) | A pool owner who turned it on | Question content | Not needed |
| Proposing a grade for essays and diagrams (ADR-063) | Automatically, after an evaluation closes | Statement, rubric, model answer, the student's answer | Names and e-mail addresses of the classroom's students and of whoever sat are replaced by `[student]` (`packages/domain/src/maskNames.ts`); no identifier, evaluation or classroom is sent |
| Moderating a brainstorm's ideas (ADR-072) | A teacher who turned the AI assistance on | The question and the ideas, under throwaway ids | Names of the roster and of the joined accounts masked; an anonymous guest's idea leaves as typed, which the page says beforehand |
| Grading a project by criteria (ADR-106 §4) | A grading pass of the project: at a milestone, at the repository's freeze, or a regrade | The files the criteria name, test results, build outputs of the student's repository | The classroom roster's and the repository members' names, e-mail addresses and GitHub logins masked; a criterion that judges an identity is never sent (`apps/api/src/modules/project/reviewPass.ts`) |
| The teacher's help assistant (ADR-080) | A teacher's question | The documentation, the kind and ids of the screen, the question as typed, and what its read tools return, **the names and final results of the teacher's own classrooms included** | None; the panel says so before anything is asked |

The proposals of an AI grading are shown to the teacher, who validates the grade; for an essay or a diagram the student reads only the comment the teacher writes or accepts; for a project graded by criteria the student reads the rationales, marked provisional until the release. No model is called while an evaluation runs, except for a brainstorm. The help assistant is never offered to a student, nor during a sitting in Safe Exam Browser or on a kiosk station. Its questions and answers are stored 30 days (above); an answer may quote a student's name or grade, which then stays in that teacher's conversation until the 30 days pass, even if the student left the class list.

Separately, a project's **final review** may run in the student repository's own CI, on the organisation's key (`ANTHROPIC_API_KEY`), and then sends the student's code to Anthropic from GitHub, outside the platform (N-DATA-05, F-PROJ-11). That key is the organisation's own: Quiz neither holds nor checks it. A project graded by criteria dispatches no review to its repository: its review goes through the platform (above).

Whether Anthropic keeps what it receives (a no-retention agreement), and whether a European or local model is required: **To be confirmed** (open question 43 of `docs/spec/06-questions-ouvertes.md`, deferred to a data-protection review by the product owner).

### GitHub

The platform talks to GitHub through its own GitHub App only. The App's keys stay out of the repository and the database, the access tokens GitHub issues are kept in memory, never stored nor logged, and the token of an account link reads the account once and is discarded (N-SEC-16 to N-SEC-18, ADR-035). Linking a GitHub account is never a way to sign in. Deleting a project or a classroom deletes the platform's rows, never a repository on GitHub, which stays the organisation's to keep or delete (F-PROJ-16).

## Hosting and location

The platform runs on two virtual machines rented from Hetzner (`docs/development/deployment.md`, ADR-009, ADR-016):

- the **application machine** carries the application, the PostgreSQL database, the daily database dumps and the technical logs. It also hosts two other services (heig-classroom and evaluation-tb) under separate accounts. The database is not exposed on the network;
- the **code machine** runs the code students submit for a question, in isolated containers: no network, no secret, nothing of the machine mounted, limits on memory, processes and time (`apps/runner/README.md`). It receives the program and its test data, with no student name or identifier (`packages/core/src/runner.ts`). The same machine runs the **online workspace** of projects (`apps/codespace`, ADR-047), which keeps a working directory per student and project, and a small database of its users (name, e-mail address) and sessions.

The specification asks for "a server in Europe" (N-DATA-01). The application machine is in Hetzner's Nuremberg datacenter (Germany), the code machine in Helsinki (Finland). Hosting in Switzerland is an option the product owner will decide on (open question 56 of `docs/spec/06-questions-ouvertes.md`).

A **staging** environment runs on the application machine under a separate system account. It receives a copy of the production data that is **pseudonymised on the production side before it leaves**: names, e-mail addresses, edu-ID identifiers, pictures, GitHub logins, the teacher's notes, the audit payloads and the notifications are replaced or emptied; grades, answers, content and the free text people wrote in them stay real (`scripts/staging-pseudonymize.sql`, ADR-028, update of 2026-10-11). Three things stay real as well: the accounts on the keep list (`STAGING_KEEP_EMAILS`, the product owner's and testers'), left untouched with their addresses, roster rows and GitHub account; the GitHub organisation logins and repository names, which name a person when the App was installed on a personal account; and the help assistant's conversations, which may quote students' names and grades. Only the addresses on its sign-in allowlist can sign in, and its reference configuration turns off e-mail and Teams notifications.

## Retention and deletion

**Data is kept until a teacher deletes it** (N-DATA-03), except for the kinds below, which are deleted automatically by the platform's scheduled tasks (`apps/api/src/modules/system/catalog.ts`). Nothing happens automatically when a student completes or leaves their studies, and there is no deletion or pseudonymisation of accounts: the specification does not require one (ADR-003 §5).

Automatic deletions:

| Data | Deleted | Where |
| --- | --- | --- |
| Expired sessions | Every ten minutes | `apps/api/src/auth/session.ts` |
| Expired AI-assistant authorisations | Every hour | `apps/api/src/auth/oauth/service.ts` |
| Leaving the page and pastes (integrity journal) | At the release of the grades; six months after the close if never released | `apps/api/src/modules/live/integrity.ts`, ADR-088 |
| Drill reviews and cards | Five years after the review, or after the card's last review | `apps/api/src/modules/drill/jobs.ts`, ADR-041 |
| Help-assistant conversations | 30 days after each exchange | `apps/api/src/modules/assist/jobs.ts`, ADR-080 |
| Hours of activity | After eight days | `apps/api/src/modules/presence/jobs.ts`, ADR-107 |
| Content of GitHub's notifications | 30 days after processing | `apps/api/src/modules/github/deliveries.ts` |
| Evidence files, commits and build and test output of a project graded by criteria (the test cases and statuses stay) | Six months after its release | `apps/api/src/modules/project/evidence.ts`, ADR-106 |

Deletions by a teacher:

| Action | Effect |
| --- | --- |
| Deleting an evaluation | Its attempts, answers, attempt journals, gradings, notifications, and the drill cards it gave rise to are deleted |
| Deleting a classroom or a course | The same for all its evaluations and projects, plus the class list and the classroom's drill data |
| Deleting a project | Its rows on the platform; nothing on GitHub |
| Removing a student from the class list | Their seat, gradebook marks, group memberships and repository-access rows go (their GitHub access is revoked first); their attempts, answers, grades and drill data stay |
| Archiving a classroom | Nothing is deleted: the classroom is only hidden |

What is never deleted automatically: the accounts, the e-mail addresses and edu-ID information kept, the notifications, the AI call log, the poll participants without an account, the kiosk pairings, the audit log (which keeps, among others, the name and address of a student removed from a class list), the imported heig-classroom audit log, and the online workspace's users (name, e-mail address) and working directories (no deletion of them is in the repository).

### Backups

A deleted piece of data stays in the backups until they rotate (`docs/development/deployment.md` §6, ADR-009):

| Copy | Where | Encryption | Kept |
| --- | --- | --- | --- |
| Daily database dump | On the application machine itself | None | 30 days |
| Hetzner's backup of the whole machine | Hetzner | **To be confirmed** | 7 days; that it is enabled: **To be confirmed** |
| Nightly off-site copy of every backup of the machine (borg, append-only) | Hetzner Storage Box, Helsinki | Encrypted before it leaves (`repokey-blake2`); the key is on the application machine and in the administrators' vault | 7 daily, 4 weekly and 3 monthly archives (about three months of archives), pruned by hand from the operator's workstation |
| Online workspace data | Pulled daily onto the application machine, then in the off-site copy | Not described | 14 archives on the application machine |

Through the monthly off-site archives, a deleted piece of data can therefore survive about four months after its deletion (each archive holds the last 30 days of dumps, and archives are kept about three months), up to five months when the copy is pruned once a month; the specification states about four months (N-DATA-03). That retention holds only when someone runs the pruning by hand (`scripts/offsite-backup/prune.sh`, "once a month is enough" in the runbook): the application machine cannot remove an archive, so without pruning the archives accumulate and nothing leaves the off-site copy. The staging copy keeps it until its next refresh.

### Technical logs

The machines keep their logs for a limited period, set in the platform's configuration and applied by the administrator. Each period is an upper bound, never a promise that a line is still there:

| Log | Kept |
| --- | --- |
| The application's technical log, with each request's IP address (application machine), and the database's | About 30 days: the limit is a size meant to hold a month of usual traffic, not a date, so a quiet month keeps lines longer and a busy one shorter; each update of the platform also starts the application's afresh |
| The online workspace's web server access log, with each request's IP address (code machine) | At most 30 days per closed file; the file being written is closed only once full, so on a quiet site its oldest lines can be older |
| Each machine's system journal: the code runner, the online workspace's own log with each request's IP address, the web server's error messages (which name the client's IP address) | At most about 30 days, or less if the journal reaches its size limit |
| Who used administrator rights (`sudo`) and the SSH sign-ins, on each machine | At most about 180 days: longer on purpose, it is the trace of the administrators' actions |

Hetzner's backup of a machine, where it is enabled, holds its disk, logs included, for 7 days: there, each period is up to 7 days longer. The platform's own web server sites write no access log; the web server configuration the machines share with other services is not the platform's, and the administrator checks that it keeps no access log longer.

## Statistics

No statistic is stored: every one is computed, when displayed, from the nominative data.

**Per evaluation.** Mean, grade distribution, success rate of each question, distribution of the answers (`apps/api/src/modules/results/service.ts`), for the course's staff only, assistants included, who read the nominative data anyway: the grade table, each copy, the nominative CSV export and the live grid (ADR-068 §2). No student route returns a class aggregate of an evaluation: a student reads their own feedback, their own grades with no average, and their own cells of the gradebook, with their own mean once the teacher publishes it. No minimum group size is therefore applied (product owner, 2026-10-15, issue [#874](https://github.com/heig-tin-info/heig-quiz/issues/874)), as already settled for the drill's aggregates within a classroom (settled question 28 (l)). One exception is a deliberate switch: a poll's tally reaches every phone once the teacher turns on **Show votes** (ADR-014, addendum of 2026-09-29). While an exercise runs, the teacher may publish its correction (ADR-050): the class view then shows the same aggregates, with no names, and may be projected; for a short-answer question it lists the answers as typed.

**In a small class, a projected aggregate names its students.** The aggregates reach the room only when a teacher projects them: the class debrief (F-RES-03, ADR-033), the live dashboard with names hidden, whose per-question totals and answer columns stay readable under pseudonyms (F-DASH-02, F-DASH-04, F-DASH-07), and an exercise's published correction, which counts the papers handed in so far, so two loads one paper apart show that paper's answers. With two or three students, a distribution or a success rate tells the room who answered what; a short answer shown as typed can identify its author in a class of any size. In a very small class, prefer not to project the debrief or the dashboard, and read a short-answer question's answers before projecting them.

**Per question, in a pool** (ADR-038, ADR-039, ADR-042, ADR-043). Success rate, time spent, discrimination, and the share of each option of a multiple-choice question, over every exam that used the question, all years and classrooms, never an exercise nor a staff member's test (`apps/api/src/modules/stats/`). They are aggregated (N-DATA-06): below ten answers the server sends nothing (`QUESTION_STATS_MIN_N`, `packages/domain/src/stats.ts`); no minimum, maximum or standard deviation is shown; option shares are whole percentages. Anyone who can read the pool sees them. One residual risk is accepted (ADR-038): comparing a question's figures before and after one more answer reveals that answer's points, not whose it is.

The drill's view for the teacher is per student, by the product owner's choice (ADR-041 §8). During an evaluation the teacher's dashboard may show a pseudonym (an adjective and an animal) instead of the name, for instance when projected (`packages/domain/src/pseudonym.ts`); it is a display choice, the data stays nominative.

## Security measures

Sign-in and sessions:

- no password of the platform's own: sign-in goes through Switch edu-ID (OIDC with PKCE, `apps/api/src/auth/oidc.ts`);
- the session is a random value of which the server keeps only a hash; the cookie is out of reach of the page's JavaScript, sent over HTTPS only in production, and expires at most 12 hours after the last activity with the reference configuration (`apps/api/src/auth/session.ts`);
- requests that change something are protected against cross-site request forgery (`apps/api/src/auth/plugin.ts`);
- the development sign-in, which lets anyone pick a fictitious identity, stops the server from starting in production, as does a test database (`apps/api/src/config.ts`);
- API tokens and AI-assistant authorisations are stored as hashes only (ADR-022, ADR-023);
- the content security policy admits only the site's own scripts and images; the one exception is the Microsoft Teams tab, which may fetch Microsoft's list of Teams hosts from `res.cdn.office.net` (`apps/api/src/csp.ts`).

Network and storage:

- traffic between the browser and the server is encrypted (HTTPS with HSTS); so is the traffic to the code machine, which accepts only the application machine (`Caddyfile`, `apps/runner/deploy/Caddyfile`);
- the database is reached only by the application, over a network internal to the machine;
- secrets are in files reserved to the service account, never in the repository or the database; the AI key is stored encrypted (ADR-010, ADR-058);
- the off-site copy is encrypted before it leaves, and the application machine can add archives to it but not remove one (ADR-009);
- SSH by key only, no root sign-in except the code machine's forced deployment commands, `fail2ban` and a provider firewall (`docs/development/deployment.md`, *Human access*);
- students' code runs in containers with no network, no secret and no access to the machine's files (`apps/runner/README.md`).

The technical logs on the machines are kept for a limited period ([Technical logs](#technical-logs)). Not established from the repository: the encryption of the machines' disks and of Hetzner's backups (**To be confirmed**).

## Students' rights and whom to contact

The platform's **Data and privacy** page (`/privacy`, N-DATA-07) tells students, in French and in English, what this chapter describes, in their words: what is recorded, why, for how long, who sees it, the AI model and the other services, and whom to ask. It is public, the same signed in or not, and linked from the account menu, the signed-out landing page and the command palette's Help group. Its text lives in `apps/web/src/privacy/privacy.md` and `privacy.fr.md`; a change described in this chapter that a student would notice belongs there too.

What the platform lets a student do today:

| Need | In the application |
| --- | --- |
| See their profile | Yes: name, e-mail address, role, last sign-in (**Settings**) |
| See their results and gradings | Yes, once released, as far as the evaluation allows |
| See their attempt journal | No: only the teacher sees it; the student is told, by the evaluation's conditions and a message, that leaving the page and pasting are recorded (ADR-088) |
| See their drill activity as the teacher sees it | No: the student sees their own sessions |
| Stop the drill | Yes, per classroom: nothing more is counted; what was recorded stays visible to the teacher and is kept five years |
| Export their data | Partly: **Download my data** (**Settings**) gives, in one JSON file, everything the platform shows them, plus their verified e-mail addresses, hours of activity and last activity (ADR-112). Not what only the teacher sees (the attempt journal, a note on the class list, the edu-ID claims, the audit log) |
| Correct their name or address | Not in the platform: they come from edu-ID and are updated at every sign-in; a mistake in the class list is corrected by the teacher |
| Delete their data | Only their profile picture, their Teams link and their GitHub link |

For any request (access, copy, correction or deletion), the student turns first to the course's teacher, who can correct a class list or delete an evaluation. The student's own file (above) holds what they can see; extracting everything the platform holds about a student, or deleting their account, is possible through no feature of the application: only direct access to the database allows it, so a full access request goes through the teacher or the institution's data-protection officer.

The institutional contact for these requests, and the supervisory authority to name: **To be confirmed**.

## Known limits

These points are known; the open ones are tracked in issue [#274](https://github.com/heig-tin-info/heig-quiz/issues/274). None is scheduled unless the issue says otherwise.

Retention and deletion:

- no general retention period and nothing deleted when a student leaves: only the specific periods listed above apply;
- no deletion or pseudonymisation of accounts; the edu-ID information and every e-mail address seen are kept with no time limit;
- removing a student from a class list leaves their attempts, answers, grades, drill data and released-grade snapshot in the database;
- the audit log is never purged and contains names and addresses; its protection against change also prevents removing them;
- the AI call log, the notifications, the poll participants without an account, the kiosk pairings and the online workspace's working directories have no retention period;
- the off-site copy's four to five months hold only if it is pruned by hand; otherwise its archives keep everything.

Statistics:

- the per-evaluation statistics apply no minimum group size, by decision (product owner, 2026-10-15, #874): they are staff-only, and the residual risk is what a teacher projects in a small class (see [Statistics](#statistics));
- the pool statistics have a threshold of ten answers, but comparing them before and after one new answer reveals that answer's points.

Access and traceability:

- most reads are not traced, neither the teachers' nor the administrator's: only the opening of one student's paper (at most once per person and paper every 15 minutes) and the administrator's reading of help-assistant conversations are; the reads of a whole class (one question's answers across the class, the grading table, the grade table, the per-question view, the CSV export), the grading history of one answer and the class lists are not, by decision (product owner, 2026-10-15, issue #875);
- direct access to the machines and the database is not traced by the platform;
- the audit log's protection is a database trigger; the application connects as the database's owner role, which could drop it, and emptying the whole table (TRUNCATE) is not covered;
- the student is not notified when an administrator opens a view of their account;
- a personal API token carries all its owner's rights and may be created without expiry (an administrator's always expires).

Informing the student:

- the data export (N-DATA-04, ADR-112) holds what the student can see, not everything the platform holds about them: under a feedback policy that hides answers it holds no answer of theirs for that evaluation, and the attempt journal, the teacher's notes and the edu-ID claims stay out; the **Data and privacy** page sends every other request (a correction, a deletion, a full copy) to the course's teacher, and names no institutional contact;
- the **Data and privacy** page is written by hand from this chapter: nothing checks that the two agree, nor that its durations follow the constants in the code.

AI model:

- no no-retention agreement with Anthropic is recorded, and the help assistant sends students' names and final results unmasked (open question 43);
- masking replaces the names known to the platform; a name written differently, or a third person's name in an answer or a repository, leaves as written.

Hosting:

- nothing is hosted in Switzerland; the application machine is in Germany, the code machine and the off-site copy in Finland;
- the daily database dumps sit unencrypted on the machine they protect;
- the off-site copy's key is on the application machine: whoever takes that machine can also read the data deleted since, up to the archives' retention (ADR-009).

## Working hypotheses

Pending the answers listed in [To be confirmed](#to-be-confirmed), the following hypotheses were formed on 2026-10-13 from public sources. They are hypotheses, not legal advice; a question was sent to the HEIG-VD on the controller, the applicable law and the transfers.

**Applicable law and controller.**

- The HEIG-VD's own privacy policy relies on the LPrD, names the HEIG-VD as the controller of its processing and the Vaud data protection authority (APDI) as the supervisory authority; it names no data protection officer ([HEIG-VD, privacy policy](https://heig-vd.ch/politique-de-confidentialite)).
- The LPrD also applies to a private person entrusted with a public task, for that task (art. 3 para. 2 let. e LPrD).
- Hypothesis A (most likely): an evaluation that counts towards a grade is part of the HEIG-VD's public task, so its processing falls under the LPrD, supervised by the APDI. The platform's author operates it in practice, with no formal mandate from the school; that mandate is the gap.
- Hypothesis B: what lies outside official teaching (accounts, free practice, shared pools) falls on the author as a private person, under the federal data protection act (LPD) and the federal commissioner (FDPIC).

**How long a grade can be contested.** Under the Vaud law on universities (LHEV, art. 79 to 82) and the canton's 2026 summary ([État de Vaud, FAQ](https://www.vd.ch/fileadmin/user_upload/themes/formation/Voies_droit_par_les_HE_2026_FAQ.pdf)):

1. a complaint to the school's direction within 10 days of the decision; the direction decides within 20 days;
2. an appeal to the cantonal department (DEF) within 10 days;
3. an appeal to the HES-SO intercantonal appeals commission within 30 days.

An uncontested grade is therefore final within weeks; a pending case can last a year or two. Hypothesis: the data of an evaluation must outlive any pending case, not every evaluation for years.

**Length of studies.** A bachelor of the HES-SO Engineering and Architecture domain lasts at most 12 semesters, six years (regulation of the bachelor programmes of the domain, art. 2).

**Retention of exam copies elsewhere.**

| Institution | Rule |
| --- | --- |
| EPFL, internal directive on examinations (version of 2023) | Bachelor 4 years 6 months, master 3 years 6 months, first year 6 months |
| UNIL, Faculty of Geosciences and Environment, 2026 memo | No automatic archiving; after the 30-day appeal period the teacher may ask for archiving; a five-year period is mentioned |
| HEIG-VD, privacy policy | "For some data, the retention period is for example ten years", exams not specified |
| Vaud archiving act (LArch) | Each authority keeps a retention schedule signed with the cantonal archives |

Hypotheses: if the HEIG-VD falls under the LArch, its retention schedule sets the period for exam documents, and the school's records office, rather than a data protection officer, can say which. About five years after an evaluation is a defensible period (close to the EPFL's, it covers the appeals and most courses of study). Since the platform keeps everything until the teacher deletes it, nothing is lost too early; the opposite risk, keeping without limit, conflicts with the principle of proportionality.

**Transfers outside Switzerland.** Germany and Finland are in the European Union, which Switzerland recognises as offering adequate protection. For the United States, since 15 September 2024 the Swiss-U.S. Data Privacy Framework covers certified companies only: GitHub (Microsoft) and Google are certified; whether Anthropic is must be checked. A Vaud public body may have stricter rules on cloud services. These points come from general knowledge and are to be verified.

## To be confirmed

- Whether a revision of the LPrD is under way, and its effect on this page.
- Where Anthropic, GitHub and Google, United States companies, process the data (no agreement specific to the platform covers these transfers).
- Who is responsible for the processing, the contact for students' requests, and any declaration to the cantonal authority or the school's data protection officer.
- The retention period the institution requires for exam copies and grades, after the studies included.
- Whether Hetzner's machine backup is enabled; the encryption of the disks and of those backups.
- Who holds personal accounts with administrator rights on the production machines.
- Whether e-mail and Teams notifications are enabled in production.
- Which claims edu-ID releases for HEIG-VD accounts, the picture included.
- Anthropic's retention of what it receives, and whether a European or local model is required.
