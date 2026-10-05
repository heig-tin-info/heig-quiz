# 3. Non-functional requirements

## 3.1 Performance and load

| Id | Requirement |
|---|---|
| N-PERF-01 | 100 students connected simultaneously, 30 in the same evaluation, without perceptible degradation. |
| N-PERF-02 | An autosave is acknowledged in under 200 ms server-side at the 95th percentile. |
| N-PERF-03 | A teacher action, start, pause, add time, close, is visible to every student in under one second. |
| N-PERF-04 | The runner absorbs 30 executions requested in 10 seconds with a response time under 5 seconds for a trivial program. Configurable concurrency, 4 by default on a 4 vCPU VM. |
| N-PERF-05 | Initial load of an evaluation page under 2 seconds on an average 4G connection. The code player bundle is loaded on demand. |
| N-PERF-06 | The target VM: 4 vCPU, 8 GB, 80 GB SSD. The spec does not assume horizontal scaling. |
| N-PERF-07 | Projects (F-PROJ): a student's repository is created and its invitation sent within 60 seconds of Accept; a deadline starts applying within 60 seconds and is applied to 100 repositories within 5 minutes — with the `lock` strategy, the default; `commit` is best effort, at the pace GitHub's limits on writes allow (F-PROJ-09 as amended 2026-10-02) —; the webhook intake answers in under 100 ms (N-SEC-17). A page view, and a fortiori the 1-second live streams of an evaluation, never waits for GitHub (F-PROJ-13). GitHub's limit of 5 000 requests an hour per installation is shared by every classroom of the organization: background jobs wait out a rate limit, an interactive read fails fast and serves its stale copy. |

## 3.2 Resilience during an evaluation

| Id | Requirement |
|---|---|
| N-RES-01 | No acknowledged answer is lost. The acknowledgement is sent only after the write to the database. |
| N-RES-02 | The client keeps unacknowledged answers in memory and resends them with their revision on reconnection. A visible indicator signals the offline state. A persistent connection failure also blurs the mounted page with an automatic-reconnection dialog; an explicit graceful server restart uses update wording (ADR-065). Pending work stays in memory: no automatic page reload, and the server deadline keeps running. |
| N-RES-03 | The real-time connection re-establishes itself automatically with exponential backoff, and replays the current state of the evaluation on reconnection. |
| N-RES-04 | A restart of the application server during an evaluation invalidates neither the sessions nor the attempts. Deadlines are in the database, not in memory. |
| N-RES-05 | Database backup every hour during teaching hours and daily otherwise, kept for 30 days, off the VM. Restoration tested before going to production. |
| N-RES-06 | A documented fallback procedure: the teacher may export at any time the raw state of the answers of a running evaluation. |
| N-RES-07 | The journal survives a GitHub outage: reading a page or an asset is a read of the database, never a call to GitHub. An outage or a rate limit only delays the next synchronisation, which a later push, a Refresh or the delivery reconciliation catches up. Concurrent synchronisations of one classroom's journal converge: they are serialised per journal, and each one writes its copy in one transaction. |
| N-RES-08 | Projects survive a lost webhook: the reconciliations re-read the runs of repositories quiet for 30 minutes (`reconcile.grades`, every 15 minutes), the invitations, heads and CI states (`reconcile.repos`, daily) and the deliveries left unprocessed or failed (`reconcile.deliveries`, daily), through the same code path as the webhook (ADR-011). A deadline is a row of the database, applied by a claim of the ticker: a restart neither skips nor repeats it, and every GitHub write of a deadline, a dispatch or a sync is recorded before or as it is made, so a retry never doubles it. |

## 3.3 Security

| Id | Requirement |
|---|---|
| N-SEC-01 | Auth only through edu-ID OpenID Connect with PKCE. Session cookies `HttpOnly`, `Secure`, `SameSite=Lax`; the cookie of a session confined to one exam (`seb`, `kiosk`) and the kiosk station's own cookie are `SameSite=Strict` (ADR-051 §4). |
| N-SEC-02 | Mandatory TLS, automatic certificates. HSTS. Strict CSP headers, no inline script without a nonce. |
| N-SEC-03 | Every authorisation is checked server-side per resource: a student reaches only their own attempts, a teacher only their own classrooms and pools. |
| N-SEC-04 | The content served to a student during an evaluation excludes the answer key, the explanation, the hidden test cases and the pool metadata. The filtering is done by the question type in a dedicated, tested function. |
| N-SEC-05 | Rendered markdown is sanitised. Images are served from the same domain. This is the rule of question content (statements, explanations, answers), an allow-list; the journal keeps its own, stricter rule (N-SEC-14, D15). |
| N-SEC-06 | Runner sandbox: one container per execution, no network, read-only file system except a temporary working directory, limits on CPU, memory, pids, output size and wall-clock time, unprivileged user, gVisor runtime. No platform secret is mounted. |
| N-SEC-07 | Rate limiting of executions per student and per minute, and per evaluation. |
| N-SEC-08 | The institutional LLM API key is encrypted at rest with an application key kept out of the database (ADR-058). Never sent back to the client. |
| N-SEC-09 | Audit log of sensitive actions with author, timestamp, resource. |
| N-SEC-10 | Light anti-cheating, never blocking: logging of focus losses and IP address changes during an attempt, optional IP restriction (no access code since [ADR-053](../adr/ADR-053-retrait-des-codes-d-entree.md)). The student is informed that these events are recorded. One exception, on the kiosk stations only: a refused hardware attestation suspends the sitting, answers kept (ADR-051 §6). |
| N-SEC-11 | Dependencies updated automatically by PR, runner base image rebuilt every week. |
| N-SEC-12 | **The journal's student view is its one exit towards a student**, like `toStudent` for questions. It never carries a draft page, a page whose `visible_from` has not passed (judged on the database's clock), the markdown source, a blob sha, the warnings, a revision (ADR-057), nor a count of what is hidden; the navigation it returns lists only the pages it would serve. The student payload is served to a student with a claimed seat, to a teacher in the student view (their staff seat, ADR-018) and to an impersonation session (ADR-034), whatever that session's user could otherwise read; the staff payload only to the course's staff in the teacher's view. The server cannot see the client's student view: the reader asks for the student payload explicitly, and that request can only narrow what is served (05 §5.7). Tested by a draft and a future page whose titles, paths and contents, and by the content of a former revision, searched for in every student response. |
| N-SEC-13 | A journal asset is served to a student only when a page the student may read (N-SEC-12) references it; an asset referenced only by a draft or a not-yet-visible page is a 404 (fix J1 of `docs/merge/04-journal.md`). Assets are served under the classroom's own access check, with the blob sha as ETag, `Cache-Control: private, max-age=0, must-revalidate`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` and `X-Content-Type-Options: nosniff`. |
| N-SEC-14 | The journal **escapes raw HTML into visible text**: no tag written in a page reaches the browser as markup, so no sanitiser is needed (D15). KaTeX runs with `trust: false`. A link never gets a scheme other than `http`, `https`, `mailto`, an in-app path or an anchor (a `javascript:` link becomes text); an external link opens with `rel="noreferrer"`; an external image is never loaded. The journal renders on the server; the student's bundle carries no markdown library. |
| N-SEC-15 | Every journal path taken from a request or from a repository is checked as a path inside the journal's root: `..` segments, a leading `/`, backslashes, control characters and paths over 400 characters are refused. A write from the browser touches only files under the classroom's root folder, on the journal's branch. |
| N-SEC-16 | **GitHub secrets.** The App's private key, its webhook secret and its client secret stay outside the repository and the database (ADR-010). Installation tokens live in memory only (at most an hour) and are never stored nor logged; the log redaction knows `x-access-token:` and the `gh?_` token prefixes. The user token obtained when a GitHub account is linked serves once, to read the account, and is discarded. The configuration refuses to start in production with an App id whose key file is unreadable, a webhook secret shorter than 32 characters, no App slug, or no OAuth client id and secret (account linking, F-GH-05); without an App configured, the GitHub features are off and the rest starts as usual. |
| N-SEC-17 | The webhook route (`/webhooks/github`) is public and trusts nothing it has not verified: the HMAC signature over the raw body is checked in constant time (401 otherwise), a delivery id already seen is acknowledged and ignored, and the answer comes back in under 100 ms (the work is queued). The App's setup return verifies the installation with the App's own credentials before storing anything. |
| N-SEC-18 | **Staging never holds the production App.** Production and staging have separate GitHub Apps, the staging one installed on a test organization only. The refresh of staging from a production dump (ADR-028) clears every installation id, so that no job of staging can reach a production repository. |
| N-SEC-19 | **Kiosk attestation.** The Verified Access service account's key is a file outside the repository and the database (ADR-010); its access token lives in memory only. An attestation is accepted only for the configured Google customer id, in verified boot mode. `KIOSK_ATTESTATION=mock` and a `google` configuration with an unreadable key file or a missing customer id, enrollment domain or extension id refuse to start under `NODE_ENV=production`. A pairing's `device_code` and `user_code` are stored as SHA-256 only and never logged, the request log masks the pairing code, and wrong codes are limited per user (ADR-051 §5, §7–8). |
| N-SEC-20 | **A project reaches a student only through the project's student view**, like `toStudent` for questions and the journal's (N-SEC-12): the student's own repository (or their group's), its CI state and scores as F-PROJ-15 lists them; never the source repository nor its existence, the distribution repository, another student's repository or score, a run after the deadline, nor the staff's flags. A student reaches a project of a classroom where they hold a claimed seat, and a repository of their own or of their group; anything else is a 404. The hints of a repository's activity go to the student's own `user:` topic and to the course's staff, **never to the classroom's topic**, which every student of the classroom reads (heig-classroom #38). A group repository is a student's only through their group's membership in the project, never because they created it. **A group set reaches a student only through the group module's student view** (F-PROJ-22): an open set's groups and members' names, and its students in no group by name; else their own group; never an e-mail, a GitHub login, a roster line's id, a set of another classroom, nor a closed set no published project names. Its hints go to the `user:` topics of the classroom's claimed students, never to `classroom:` (M3-17). Tested by a second student's repository, score and hint, searched for in every response and event of the first; by a group repository's creator moved out of the group; and by a second classroom's set, a closed set and another group's members after closing. |
| N-SEC-21 | **A CI score is forgeable** — the student's code runs in the run that reports it — and is therefore **indicative** until the teacher releases it (F-PROJ-14): a run with more than one `GRADE` annotation has no score, a run on a commit the App pushed never counts, and the receipt time of a push is the server's own, written when the webhook arrives (ADR-012). The App acts on a student's repository with the `push` permission given to the student and never more; it never deletes a repository (F-PROJ-16). |

## 3.4 Personal data

| Id | Requirement |
|---|---|
| N-DATA-01 | Legal basis: processing required by the teacher's teaching duty. Data is stored on a server in Europe, a Hetzner VM. |
| N-DATA-02 | Data processed: edu-ID identity, classroom membership, answers, gradings, grades, attempt events, drill cards and drill reviews (rating, active time, device class), the kiosk station an attempt was sat on (ADR-051 §9). With GitHub (ADR-035): the linked GitHub account's id and login (the login shown to the staff of a connected classroom on its roster), and a copy of the journal repositories' pages and referenced files; commits written from the browser carry the teacher's name. With projects (F-PROJ): the repositories of the students and of the groups, the receipt time and head of every push to them, their CI runs and scores, the restore, deadline and sync commits of the App, the teacher's score and comment. A browser commit carries the teacher's name and a noreply address, never their email: `<github id>+<login>@users.noreply.github.com` when their GitHub account is linked, otherwise `quiz-<user id>@users.noreply.<the platform's host>` (M4-03). |
| N-DATA-03 | Retention: the data of a classroom or an evaluation is kept until its deletion by the teacher. Deletion is effective and irreversible, including in backups beyond 30 days. A student's drill data (cards and reviews) is kept **five years** (ADR-041 §8), unless the classroom, the evaluation or the question it derives from is deleted first, in which case it goes with it (docs/spec/06, question 28 (a)). A journal repository is not platform data: removing a journal or deleting its classroom deletes the platform's copy, never the repository (F-JRN-04). Neither is a project's repository: deleting a project or its classroom deletes the platform's rows, never a repository on GitHub, which stays the organization's to keep or delete (F-PROJ-16, D19). |
| N-DATA-04 | A student may view and export all their data from their profile, in JSON format. |
| N-DATA-05 | Sending to an LLM provider: anonymised content, without name, email, identifier, nor classroom metadata. The teacher is informed of the provider in use. The provider is configured in no-retention mode when the option exists. *The no-retention mode and the review of what is sent are deferred: open question 43 (ADR-058).* *Student answers (ADR-063): masked of the names and emails of the students who sat; the model that answered is shown beside each proposal.* *A brainstorm's ideas (ADR-072), live and only with its AI assistance on: under throwaway ids, masked of the roster's and the joined accounts' names; an anonymous guest's text leaves as typed, which the participants' page says.* The final review of a project (F-PROJ-11) is an exception, and says so: it runs in the student repository's CI, on the organization's own key (`ANTHROPIC_API_KEY`), and sends the student's code to that provider outside the platform; the classroom's GitHub checks show whether the secret is set (F-GH-03). |
| N-DATA-06 | Question statistics in the pool are aggregated and cannot be traced back to a student. |
| N-DATA-07 | A "Data and privacy" page describes these rules to students, in French and in English; it says that the teacher of a classroom with the drill sees each student's drill activity (ADR-041 §8, #274), and that the final review of a project sends the student's code to an LLM provider from the organization's CI (N-DATA-05), *and (ADR-063) that the answers to essay and diagram questions are sent after the close, without the student's name, to an LLM provider (Anthropic) for a grade the teacher reviews*, *and (ADR-072) that the ideas of a brainstorm with AI assistance are read live by that provider*. |

## 3.5 Accessibility and internationalisation

| Id | Requirement |
|---|---|
| N-A11Y-01 | WCAG 2.1 AA conformance targeted on the student flows and the teacher dashboard: contrast, full keyboard navigation, visible focus, labels, screen reader on forms. |
| N-A11Y-02 | The player is usable with the keyboard alone. Documented shortcuts: next question, previous question, validate and continue (in the navigations that have it). |
| N-A11Y-03 | Information is never carried by colour alone. The correct / wrong / partial states have an icon. |
| N-A11Y-04 | Font size and browser zoom up to 200 % without loss of function. |
| N-I18N-01 | Interface in French and in English, language chosen by the user, the browser's by default. Every string goes through the translation system. |
| N-I18N-02 | Dates, times and numbers formatted according to the locale. The displayed clock is in the user's local time. |
| N-I18N-03 | Question content is not translated. |

## 3.6 Compatibility

| Id | Requirement |
|---|---|
| N-COMPAT-01 | Last two major versions of Chrome, Firefox, Safari, Edge. Safari iOS and Chrome Android for the student flows. |
| N-COMPAT-02 | Minimum supported width: 360 px. Code and diagram types: optimised from 1024 px, usable below. |
| N-COMPAT-03 | Light and dark themes, system preference by default, choice remembered. |

## 3.7 Operations

| Id | Requirement |
|---|---|
| N-OPS-01 | Deployment by Docker Compose: reverse proxy, application, Postgres database, runner. One command to update. |
| N-OPS-02 | Structured JSON logs, configurable level. Basic metrics: requests, latency, active real-time connections, runner queue. (On `/metrics`: `quiz_http_requests_total` by route template and status class, `quiz_http_request_duration_seconds`, `quiz_sse_connections`; the server errors of the day on the System status page. ADR-055 §7, `docs/development/deployment.md` §7.) |
| N-OPS-03 | Internal health page: database, runner, disk space, last backup. Delivered as the admin's System status (F-ADMIN-07, [ADR-055](../adr/ADR-055-etat-du-systeme.md)); `/healthz` stays the narrow public probe. |
| N-OPS-04 | Schema migrations versioned and applied at startup. Always compatible with the previous version to allow a rollback. |
| N-OPS-05 | No deployment during a running evaluation: the update script refuses when an evaluation is `running` unless a force option is given. |

## 3.8 Quality and maintainability

| Id | Requirement |
|---|---|
| N-QUAL-01 | Strict TypeScript end to end, schemas shared between client and server. |
| N-QUAL-02 | Unit tests on every grader and on the filtering of the content served to students. Integration tests on the lifecycle of an evaluation. One end-to-end test per main flow. |
| N-QUAL-03 | Every question type is an isolated package with the same interface. Adding a type does not change the core. |
| N-QUAL-04 | Documentation: this `docs/` folder, an operations guide, a question type author's guide. |

## 3.9 UX principles

These principles frame the design system in `apps/web/DESIGN.md`.

1. **Restraint**: no borders around fields, hierarchy through space and typography, a single primary action per screen.
2. **Predictability on the student side**: the exam interface is conventional in its affordances. Input fields are identifiable at rest, buttons have a label. Visual innovation is focused on the teacher interface.
3. **Responsiveness**: every state change is visible without a reload. The synchronisation state is always shown during an evaluation.
4. **A minimum of decisions**: the evaluation settings have sensible defaults. The teacher launches a quiz in three screens: choose the questions, set the time, start.
5. **Content first**: the statement takes the space, the application chrome is reduced to a top bar with logo, sections, and on the right user, theme, help.
6. **Consistency**: one component per use, design tokens for colours, spacing, radii, and a single icon library.
