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

The class list is the only way into a classroom: the join code a student could type has been removed (ADR-053). A student's seat is attached to their account at sign-in, when one of the addresses edu-ID sends matches the address on the list (`apps/api/src/auth/claims.ts`).

### While the platform is used

| Data | Detail |
| --- | --- |
| Answers | Saved as they are typed, with the questions marked for review |
| Attempts | Start time, deadline, hand-in, extra time granted, last sign of life |
| Attempt journal | Tab changes, loss of window focus, reconnections, pauses and extensions (`apps/web/src/attempt/signals.ts`) |
| Time on each question | When a question was first shown and how long it stayed on screen, measured by the server (ADR-039) |
| Drill | For each question a student practises: the scheduler's state, and every review with its rating, whether it was right, the active time, the answer given and the device class (touch screen or mouse) (ADR-041, `apps/api/src/db/drill.ts`) |
| Gradings | Points, the teacher's comment, the history of changes |
| Released grades | A snapshot of the grades at the moment of release |
| Profile picture | If the user uploads one |
| Notifications | Platform messages, preferences, the link to a Microsoft Teams account |
| Anonymous polls | A hash of the browser's cookie, with no identity |

The attempt journal records leaving the page and pasting from outside it only while the evaluation's **Log leaving the page and pasting** setting is on (on by default for an exam, off for an exercise); a paste is recorded as its length and whether the page had just lost the focus, never its content (ADR-088). That record is deleted at the release of the grades, or six months after the close of an evaluation never released.

The time on each question never leaves the server: no screen shows it, to the student or to the teacher; only the pool statistics use it, as an aggregate (see [Statistics](#statistics-and-anonymisation)).

The IP address is not stored in the database, with one exception: a refused Safe Exam Browser access writes it to the audit log. It does appear in the technical log of every request (`apps/api/src/redact.ts`). The platform records neither the browser in use (only the drill's device class above), nor keystrokes, nor any audience measurement.

## Purposes

The data is used to:

- identify the person and give them access to their classrooms;
- run evaluations: the clock, extra time, saving the answers;
- grade, automatically or by the teacher, and release the results;
- let the teacher follow an evaluation as it runs, the attempt journal included;
- send notifications, when they are enabled;
- schedule the drill, the spaced practice of questions already met in an evaluation, and show the teacher each student's drill activity;
- produce statistics: per evaluation for the teacher, and per question in a pool (see [Statistics](#statistics-and-anonymisation));
- keep a trace of changes (the audit log) and diagnose failures (the technical log).

The code contains no advertising or commercial use. Content is sent to an AI model (Anthropic's Claude, through the platform's one key, ADR-058) once an administrator has stored a key, for five purposes:

- **Generating the answer of a question** in the editor, on a teacher's click (ADR-059), and **reviewing published questions** at night, in the pools whose owner turned it on (ADR-060): the question's content, never a student's.
- **Proposing a grade for essays and diagrams**, automatically after an evaluation closes (ADR-063): the statement, the rubric, the model answer and the student's answer (a diagram in its text form). Before it leaves, the answer is masked: the first names, last names and e-mail addresses of the classroom's students and of whoever sat the evaluation are replaced by `[student]` (`packages/domain/src/maskNames.ts`); the request carries no identifier, no evaluation and no classroom. The proposal, its justification and its points per criterion are shown to the teacher only, who validates the grade; the student reads only the comment the teacher writes or accepts by hand. Circuits are never sent: their simulation grades them. No model is called while an evaluation runs, except for the brainstorm below.
- **Moderating and tidying a brainstorm's ideas**, live, only when its teacher turns the AI assistance on (ADR-072): the question and the ideas, under throwaway ids, never with an identifier. The names of the classroom's students and of the accounts that joined are masked; an anonymous guest's idea leaves as typed, which the poll page says before anyone types. The model hides offensive ideas, corrects the others and groups those that say the same; the stored answer is never changed, and the teacher can undo everything.
- **Answering a teacher's question about the platform and their own data**, in the help assistant of the teacher screens (ADR-080): the platform's documentation, the screen the teacher is on (its kind and the ids of the course, classroom, pool, question, evaluation or template it shows — never a student's, an attempt's or an account's), the question as the teacher typed it, and what its read tools return. Those tools read as the teacher, with exactly what the teacher's own seats reach (an administrator's Super Powers never pass to it): courses, pools, questions, evaluations, templates, and the **final results of the teacher's own classrooms, with the students' names**, never an evaluation's scores before their release. None of it is masked; the panel says, before anything is asked, that it reads this data and sends it to Anthropic. The assistant is never offered to a student, nor in a student's view, nor during a sitting in Safe Exam Browser or on a kiosk station.

Every call is logged with its model, its token counts and its estimated cost, never its content (`llm_calls`). The help assistant is the one exception: its questions and answers are stored (`assist_conversations`, `assist_exchanges`), read by the teacher who asked and by an administrator who switched Super Powers on, every such read being written to the audit log, and deleted after 30 days (see [Retention](#retention-and-what-happens-to-the-data-after-the-studies)). Only the question and the answer are stored, with the screen's kind but not its ids: never what a tool read nor which tool was called. An answer may quote a student's name or grade; it then stays in that teacher's conversation until the 30 days pass or the teacher deletes it — also after the student was removed from the class list or, should account erasure come, after the account is erased. Whether the provider keeps the data it receives (no-retention mode), and whether a European or local model is required: **To be confirmed** (open question 43, deferred to the next data-protection audit by the product owner on 2026-10-02).

## Who reaches what

### Students

A student sees their classrooms, the evaluations opened there, their own answers and, once released, their results and the feedback the teacher chose to give. They see neither the list of their classmates nor their answers: every access is filtered on their own account (`apps/api/src/modules/guards.ts`).

### Teachers

A teacher reaches the data of a course only if they are on that course's staff. The check is made when the data is loaded; without a staff seat, the answer is the same as if the course did not exist (`apps/api/src/modules/guards.ts`, the `staffAccess` predicate).

Within a staff, every member reaches every classroom of the course, past years included. Each holds a role (ADR-068): only an **owner** adds a colleague to the staff, removes one or changes their role, and only an owner publishes or withdraws results; an **assistant** works in the classrooms. Any member may leave the staff. A teacher who is not on a course's staff sees nothing of its students.

When a classroom has the drill, its staff see each student's drill activity: the questions practised, the sessions, the recall rate and its progress week by week (`apps/api/src/modules/drill/teacher.ts`). Students are told so in their drill tab. A student may leave the drill of a classroom: from then on nothing more is counted, what was recorded before stays visible, and the teacher sees that and when the student left (ADR-041 §8).

A teacher who can read a question pool, including a pool shared with them or a public one, sees the statistics of its questions, aggregated over every exam that used them, other teachers' classes included (see [Statistics](#statistics-and-anonymisation)).

Profile pictures uploaded by users are served only to someone who already sees that person: a colleague on a course staff, the staff of a course where the person sits a classroom, the person themselves and the administrator (`seesUser` in `apps/api/src/modules/guards.ts`). A student never receives another student's picture.

A teacher who connects an AI assistant to the platform (see [AI assistants](assistants.md)) gives it access to courses, pools and evaluations, including the names and addresses of a course's staff. No tool of that connected assistant reaches a classroom's list of students. The in-app help assistant (above) differs on one point: it can also read the final results of the teacher's own classrooms, students' names included; that tool is not offered to connected assistants.

### The application administrator

One account, named in the server configuration, holds the administrator role (`apps/api/src/roles.ts`). It reaches every course and every classroom, and sees the list of all accounts, with their pictures.

To help a student with a problem they report, the administrator may open a view of that student's account (ADR-034): a one-time link, valid five minutes, opens at most one hour as the student. In production that view is read only: it cannot answer or submit anything (`apps/api/src/auth/plugin.ts`). Its start and its end are written to the audit log under the administrator's name. The student is not notified; the student help says, in general terms, that an administrator can open such a view (`apps/web/src/help/student-home.md`).

### The system administrator

Whoever administers the machines has access to the database, the backups and the logs, and therefore to all the data. These accesses go through system tools (SSH, `psql`) and are not traced by the platform. Who holds these accesses: **To be confirmed**.

### What is traced

The audit log (`apps/api/src/audit.ts`) records the actions that change something: sign-ins, imports and edits of class lists, gradings, releases of results, opening a view as a student, grants made by the administrator. It does not trace reads: who looked at which paper or which class list is recorded nowhere. The one exception is an administrator reading a teacher's help-assistant conversations, which is written to the log.

## Hosting and location of the data

The platform runs at the hosting provider Hetzner, on two virtual machines (`docs/development/deployment.md`):

- the application machine carries the application server, the PostgreSQL database and the daily database backups; it also hosts two other services (heig-classroom and evaluation-tb), whose files the other accounts cannot read;
- a second machine runs the code submitted by students, in isolated containers (ADR-016). It receives the program to run and its test data, with no student name or identifier (`packages/core/src/runner.ts`).

The specification says "a server in Europe" (`docs/spec/03-exigences-non-fonctionnelles.md`, N-DATA-01). Both machines are in Hetzner datacenters in Europe. The deployment decision ([ADR-009](../adr/ADR-009-deploiement-vm-compose.md)) records this hosting; hosting in Switzerland remains an option the product owner will decide on (open question 56 of `docs/spec/06-questions-ouvertes.md`).

A staging environment runs on the same machine, under a separate system account, and receives a copy of the production data that is **not anonymised**, to test under real conditions (ADR-028). Only the addresses on its sign-in allowlist, the platform's administrators, can sign in, and its reference configuration turns off e-mail and Teams notifications (`.env.staging.example`, `docs/development/deployment.md` §8).

External services called:

| Service | What it receives |
| --- | --- |
| Switch edu-ID | The sign-in (it is the one that sends the identity) |
| Scaleway Transactional Email (Paris region by default) | The recipient's address, the title of the evaluation or the name of the pool concerned; no grade, according to the code (`apps/api/src/modules/notifications/`) |
| Microsoft Teams | For a linked account, a notification with the title concerned; limited to the authorised organisations |
| The host of the edu-ID picture | A browser showing a portrait that was not uploaded loads it directly from the address edu-ID provided, without sending the page's address |
| GitHub, for a classroom connected to an organisation | The students' project repositories the platform creates in that organisation, and the invitation of their linked GitHub accounts to them; a journal kept in a GitHub repository is only read from it |
| Anthropic (Claude), once a key is stored | Question content; after the close, essay and diagram answers masked of the students' names; a brainstorm's ideas, live, when its AI assistance is on; a teacher's questions to the help assistant and what its read tools return for them, the names and final results of the teacher's own classrooms included (see [Purposes](#purposes)) |

E-mails and Teams messages carry titles, names of classrooms and pools, and counts; they never carry a grade or a question's content: "your grade changed" says that it changed, not what it is (`apps/api/src/modules/notifications/templates.ts`). Whether e-mail and Teams are enabled in production: **To be confirmed**. The platform loads no analytics script, and no font or library from a third party: everything is served by the server itself.

### GitHub and the journal

The merge of heig-classroom into the platform (ADR-035) brought a classroom journal, projects in GitHub repositories and a link between a platform account and a GitHub account. What they hold:

- **A linked GitHub account**: the GitHub identifier and login, and when the link was made (`github_accounts`, `apps/api/src/db/github.ts`, N-DATA-02). Linking is never a way to sign in; removing the link deletes the row (`apps/api/src/auth/githubLink.ts`).
- **The journal** of a classroom (`apps/api/src/db/journal.ts`): its pages and the files they reference. Written in the platform, each save keeps a revision with its author; published from a GitHub repository, the pages are a copy of the repository's. Removing the journal or deleting the classroom deletes them; a GitHub repository itself is never deleted (F-JRN-04, N-DATA-03).
- **Projects** (`apps/api/src/db/project.ts`, `apps/api/src/db/group.ts`): which student accepted which repository, the GitHub accounts invited to it, the server's receipt time and commit count of each push (`push_receipts`, `apps/api/src/db/github.ts`), the CI runs and their scores, the teacher's score and comment, and the classroom's groups. Deleting a project deletes its rows on the platform and nothing on GitHub.
- **GitHub's notifications** to the platform (webhooks), kept as received; their content is erased 30 days after they were processed (`webhook_deliveries`, `apps/api/src/db/github.ts`).

The platform talks to GitHub through its own GitHub App only; its keys stay out of the repository and the database, the access tokens GitHub issues are kept in memory, never stored nor logged, and the token of an account link is used once to read the account, then discarded (N-SEC-16 to N-SEC-18).

## Retention and what happens to the data after the studies

**Three retention periods are enforced: five years for the drill, 30 days for the help assistant's conversations (below), and the correction for the exam integrity journal.** The integrity journal of an evaluation's attempts (leaving the page, pasting from outside it) is deleted when its grades are released, or six months after its close if they never are (`apps/api/src/modules/live/integrity.ts`, ADR-088 §8, N-DATA-03). A drill review is deleted five years after it was made, and a question's drill card five years after its last review; the server checks every six hours (`apps/api/src/modules/drill/jobs.ts`, ADR-041, N-DATA-03). Every other piece of data stays until a teacher deletes it (N-DATA-03). In particular, nothing happens automatically when a student completes or leaves their studies.

What is deleted, and when:

| Action | Effect |
| --- | --- |
| Deleting an evaluation | Its attempts, answers, attempt journals, gradings and notifications are deleted, and the drill cards it gave rise to, with their reviews |
| Deleting a classroom or a course | The same for all its evaluations, plus the class list and the classroom's drill data |
| Releasing the grades | The attempts' integrity journal (leaving the page, pasting from outside it) is deleted; an evaluation whose grades are never released loses it six months after its close, checked every day |
| "Remove these questions from the drill" on an evaluation | The drill cards it gave rise to and their reviews are deleted |
| Archiving a classroom | Nothing is deleted: the classroom is only hidden |
| Removing a student from the class list | Their seat goes; their attempts, answers, grades and drill data stay in the database |
| A student leaving the drill of a classroom | Nothing is deleted |
| Expired sessions | Deleted automatically, every ten minutes |
| Expired authorisations of AI assistants | Deleted automatically, every hour (`apps/api/src/auth/oauth/service.ts`) |
| An exchange of the help assistant (a teacher's question and its answer) | Deleted automatically 30 days after it was written, every day (`apps/api/src/modules/assist/jobs.ts`); the teacher may delete a conversation sooner. A student's name an answer quotes stays until then, even after the student leaves the class list |
| The help assistant's access token for one question | Deleted when the question ends; one left behind by a crash expires after 15 minutes and is deleted the same day |

What is never deleted automatically: the accounts (there is no account deletion), the e-mail addresses and edu-ID information kept, the notifications, and the audit log, which in particular keeps the name and address of a student removed from a classroom.

After a deletion, the data remains in the backups until they rotate: 30 days for the daily database copies, 7 days for the Hetzner backups of the machine (`compose.prod.yml`, `docs/development/deployment.md`). The staging copy keeps it until its next refresh.

The retention period the institution wants after the studies: **To be confirmed**.

## Statistics and anonymisation

No statistic is stored: every one is computed, when it is displayed, from the nominative data. There are two kinds.

**Per evaluation.** Mean, grade distribution, success rate of each question, distribution of the answers (`apps/api/src/modules/results/service.ts`). Only the course's staff sees them. The CSV export of the results is nominative. As a consequence:

- deleting an evaluation deletes its statistics too;
- as long as they exist, the statistics stay linked to the people;
- no minimum group size is applied: in a small classroom, a grade distribution or a success rate may let someone recognise a student.

While an exercise runs, the teacher may publish its correction (ADR-050): the class view of the correction then shows the same aggregates over the papers handed in so far, with no names, and it may be projected in class. For a short-answer question, the distribution lists the answers as typed. Each student sees only their own correction.

**Per question, in a pool** (ADR-038, ADR-039, ADR-042, ADR-043). For each question: its success rate, the time students spend on it, how well it separates stronger and weaker students, and, for a multiple-choice question, the share of each option. They count every exam that used the question, every year and every classroom, never an exercise, never a staff member's test (`apps/api/src/modules/stats/`). They are aggregated, to serve N-DATA-06:

- below ten answers, the server sends nothing (`QUESTION_STATS_MIN_N` in `packages/domain/src/stats.ts`);
- no minimum, maximum or standard deviation is shown, and option shares are whole percentages;
- anyone who can read the pool sees them, other teachers included.

One residual risk is accepted (ADR-038): someone who reads a question's figures just before and just after one more answer is counted can deduce that answer's points, without knowing whose it is.

The drill's view for the teacher is per student, by the product owner's choice (ADR-041 §8); no minimum group size applies there either.

During an evaluation, the teacher's dashboard may show a pseudonym (an adjective and an animal) instead of the name, for instance when it is projected in class (`packages/domain/src/pseudonym.ts`). It is a display choice: the data in the database stays nominative.

## Security measures

Sign-in and sessions:

- no password of the platform's own: sign-in goes through Switch edu-ID (OIDC with PKCE);
- the session is a random value of which the server keeps only a hash; the cookie is out of reach of the page's JavaScript, sent over HTTPS only in production, and expires at most 12 hours after the last activity with the reference configuration (`apps/api/src/auth/session.ts`, `.env.prod.example`);
- requests that change something are protected against cross-site request forgery (`apps/api/src/auth/plugin.ts`);
- the development sign-in, which lets anyone pick a fictitious identity, stops the server from starting in production (`apps/api/src/config.ts`);
- API tokens and the authorisations given to AI assistants are stored as hashes only (ADR-022, ADR-023);
- the site's content security policy admits only the site's own scripts (`apps/api/src/csp.ts`).

Network and storage:

- all traffic between the browser and the server is encrypted (HTTPS, with HSTS); so is the traffic to the code execution machine, which accepts only the application machine (`Caddyfile`, `apps/runner/deploy/Caddyfile`);
- the database is not exposed on the network: only the application reaches it, over a network internal to the machine;
- secrets (passwords, keys) are in files reserved to the service account, never in the repository or the database (ADR-010);
- students' code runs in containers with no network, no secret, no access to the machine's files, and limits on memory, processes and time (`apps/runner/README.md`).

What is not in place or not established: disk and backup encryption is not described in the repository (**To be confirmed**); the daily database copies sit on the machine itself and are not encrypted, and only the provider's backup of the whole machine is kept elsewhere; no retention period for technical logs is configured in the repository (**To be confirmed** on the machine).

## Students' rights and whom to contact

What the platform lets a student do today:

| Need | In the application |
| --- | --- |
| See their profile | Yes: name, e-mail address, role, last sign-in (**Settings**) |
| See their results and gradings | Yes, once the teacher has released them, as far as the evaluation allows |
| See their attempt journal | No: only the teacher sees it |
| See their drill activity as the teacher sees it | No: the student sees their own sessions, not the teacher's view |
| Stop the drill | Yes, per classroom: nothing more is counted; what was recorded stays visible to the teacher and is kept five years |
| Export their data | No: there is no export for students |
| Correct their name or address | Not in the platform: they come from edu-ID and are updated at every sign-in; a mistake in the class list is corrected by the teacher |
| Delete their data | Only their profile picture and their Teams link |

For any request (access, copy, correction or deletion), the student turns first to the course's teacher, who can correct a class list or delete an evaluation. Extracting all the data of a student or deleting their account is possible through no feature of the application: only direct access to the database allows it.

The institutional contact for these requests, and the supervisory authority to name: **To be confirmed**.

## Known limits and planned improvements

The following points are known and tracked in issue [#274](https://github.com/heig-tin-info/heig-quiz/issues/274). None is fixed as of this page; none is scheduled unless the issue says otherwise.

Retention and deletion:

- no retention period except the drill's five years, no purge after a student leaves;
- no deletion or anonymisation of accounts: the column meant to mark an account as anonymised exists, but no code sets it;
- removing a student from a classroom does not delete their attempts, grades or drill data;
- the edu-ID information is kept unfiltered and with no time limit;
- the audit log is never purged and contains names and addresses.

Statistics:

- the per-evaluation statistics apply no minimum group size: small classrooms are re-identifiable;
- the pool statistics have a threshold of ten answers, but comparing them before and after one new answer reveals that answer's points.

Access and traceability:

- reads are not traced, neither the teachers' nor the administrator's;
- direct access to the machine and the database is not traced by the platform;
- the audit log is described as unmodifiable by the application, but the production configuration does not enforce it;
- the student is not notified when an administrator opens a view of their account; only the student help mentions the possibility;
- a personal API token carries all its owner's rights and may never expire.

Informing the student:

- the application has no "Data and privacy" page yet (N-DATA-07), and no data export (N-DATA-04); the drill's notice lives in the drill tab only;
- the student is told by the evaluation's conditions, and by a toast, that leaving the page and pasting from outside it are recorded, but does not see that journal.

Hosting and security:

- the daily database copies sit on the machine they protect, unencrypted; their copy off the machine is not in place (the provider's backup of the whole machine, kept seven days, is);
- staging holds a copy of the real data that is not anonymised; only administrators reach it;
- disk encryption and the retention of technical logs remain to be confirmed.
