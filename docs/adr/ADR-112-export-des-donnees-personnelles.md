# ADR-112 — A person's data export: their own student views gathered in one file, plus three account rows

## Status

Accepted (2026-10-15, the product owner's decisions on issue #869; the points
marked *default* were set by the orchestrator's spec challenge and adopted).
Delivery progress lives in `changes/`. Amended 2026-10-15 by
[ADR-115](ADR-115-revision-ciblee-par-notion.md) §12: each classroom carries
the student's rounds of targeted revision, and the file is version 2 (§3, §9).

Scope: what `GET /app/api/me/export` returns, to whom, and what it leaves out.

Relations: amends N-DATA-04 ([03](../spec/03-exigences-non-fonctionnelles.md));
fulfils [ADR-107 §7](ADR-107-activite-de-la-plateforme.md#decision); composes the
student exits of invariant 4 and 05 §5.7 without adding one; uses the session
rule of [ADR-034](ADR-034-agir-en-tant-qu-etudiant.md) and
[ADR-054](ADR-054-super-powers-admin.md) (`ownPortalSession`).

## Context

N-DATA-04 says that a student may view and export all their data from their
profile, in JSON. Viewing exists screen by screen; there is no export (issue
#869, split out of #274). Read literally, "all their data" would include rows
the platform keeps about the student but shows only to their teacher: the
integrity journal (ADR-088), the teacher's note on a roster line, the raw
edu-ID claims, the audit log. An export built from the tables would also be a
second exit for teacher-controlled content — answer keys, unreleased grades,
an answer the feedback policy hides — beside the ones invariant 4 guards
(`toStudent`, `studentFeedback`, the project, gradebook, mastery and journal
student views), each of which has its own leak test (05 §5.7).

A full access request under data-protection law stays possible through the
teacher and the institution's data-protection officer (`docs/guide/data-protection.md`);
this record is about the self-service file.

## Decision

1. **A composition, never a new exit.** The export holds nothing a teacher has
   not published to the student: every section is the answer of an existing
   student view, called through the `service.ts` of the module that owns it,
   for the caller's own user id. No section reads a table of another module
   directly, and no code path in the export applies a feedback policy, a
   release rule or a visibility rule of its own. CLAUDE.md's list of exits
   does not change.

2. **One named exception: three account rows no teacher controls.** Beside
   the views, the file holds the account's verified e-mail addresses
   (`user_emails`, verified only, the addresses alone: `knownEmails` of
   `apps/api/src/identity.ts`), its hours of activity (`presence_hours`, while
   they exist) and its last activity (`presence_last_seen`) — what ADR-107 §7
   promised. The two presence reads are a function of the `presence` module's
   service, which owns those tables.

3. **What the file holds** (*default*, the content table):

   | Section | Source (a student view) |
   | --- | --- |
   | Identity | The account fields of `GET /app/api/me` (`auth/plugin.ts`), extracted into one function both call; never the `session` object |
   | GitHub link | The `account` of `GET /app/api/me/github` (`auth/githubLink.ts`), extracted the same way; not `relevant`, which is a display rule |
   | Classrooms | Every classroom of a claimed seat, archived ones included (as `studentGrades` lists them), each as `studentClassroomHeader` (`modules/org/service.ts`) draws it |
   | Grades | `studentGrades` (`modules/live/grades.ts`): one row per evaluation, its status, dates and only the points and grade the feedback policy lets through |
   | Feedback | For each Grades row that opens a feedback page (`feedbackAttemptId`), `studentFeedback` (`modules/results/service.ts`) on that attempt |
   | Gradebook | `studentGradebook` (`modules/gradebook/table.ts`), per classroom |
   | Groups | `studentGroupSets` (`modules/group/service.ts`), per classroom, narrowed to the student's own group (point 6) |
   | Projects | `studentProjectCards`, then `studentProject` for each (`modules/project/studentView.ts`) |
   | Practice | `studentDrillClassrooms`, `studentCalibration` (`modules/drill/review.ts`) and, per classroom, `studentConceptMastery` (`modules/drill/studentMastery.ts`) in the reader's language (`declared: false` where the drill is off) and `studentRevisionRounds` (`modules/drill/revision.ts`, the student's own rounds of targeted revision, ADR-115; since version 2) |
   | Account rows | Point 2 |

4. **Attempts come from the feedback view only.** An attempt's content is
   read through `studentFeedback` and the Grades rows, never through the
   attempt view of the player (`GET /app/api/attempts/:id` and its
   `contentVisible`), which would bypass `sitRefusal` and the feedback
   policy. Accepted consequence (product owner): under a policy that hides
   answers, the file holds no answer of the student's own for that
   evaluation, only its title, dates and status — exactly what the Grades
   page shows. A retaken exercise contributes the attempt its Grades row
   opens, not every attempt.

5. **Scope is enumerated by the finders the loaders already use**
   (invariant 6), never by a new "seats of this user" query. The classrooms
   come from `studentClassrooms` (`modules/org/service.ts`), given an option
   that keeps archived ones (the same query with the archive filter lifted);
   each is then loaded through `findReadableClassroom` with the student
   payload forced (`studentView: true`), and the gradebook, groups and
   mastery are read on that scope. A project is loaded through
   `findStudentProjectView`, an attempt through the query of the `ownAttempt`
   loader, extracted as a finder. Super Powers widen nothing: every finder is
   keyed by the caller's own seats and the student payload is forced.

6. **Groups: the student's own group only.** `studentGroupSets` answers, for
   an open set, every group with its members and the students in none. Those
   names are classmates' data, not the student's: the export keeps each set,
   the student's own group with its name and members, and drops the other
   groups and the `unplaced` list. This narrows a view, it adds nothing to it.

7. **Who may ask.** The caller's own portal session only: the route's
   preHandler is `ownSessionGuard` (`modules/guards.ts`), which refuses an
   impersonation (ADR-034, in development too), a `seb` or `kiosk` session
   and a Bearer token (personal API token, OAuth). A teacher or an
   administrator gets the same file, made of their student-side rows only:
   their own seats (a teacher's staff seat in the student view, ADR-018,
   reads as its views read it) and the account rows; never a course they
   teach, a pool or a roster.

8. **Transport.** A synchronous `GET /app/api/me/export` answering
   `application/json` with `Content-Disposition: attachment` and
   `Cache-Control: no-store`; the file is built in the request and stored
   nowhere, no job, no link to fetch later. A failure in any section fails
   the whole request (500), never a partial file. Rate-limited per user with
   the in-memory `FixedWindowLimiter` (`apps/api/src/limiter.ts`) and the
   `429` of `rateLimited` (`modules/http.ts`), five per hour (*default*).

9. **Contract.** A versioned record (`version: 1`, `generatedAt` by the
   server's clock) in `packages/contracts`, each section typed by the
   existing student schema of its view (`StudentGrades`, `StudentFeedback`,
   `GradebookStudent`, `StudentGroupSets`, `StudentProject`,
   `DrillClassroom`, `DrillCalibrationLevel`, `StudentConceptMastery`,
   `GithubAccount`, …); the identity gains a zod schema of its own, of which
   the `Me` interface becomes the extension with `session`. The route sends
   the record parsed through that schema, so a field a service returns
   beyond its contract never travels. A change of shape bumps `version`.
   *Version 2 (ADR-115, 2026-10-15): each classroom gains `revisionRounds`
   (`StudentRevisionRound`); the audit's six counts are unchanged.*

10. **Audit.** One action, `privacy.export`, subject the user, actor the user,
    payload six counts only (`classrooms`, `gradeRows`, `feedback`,
    `projects`, `drillClassrooms`, `hours`): never a title, a grade or an
    address. It is the third read the audit log traces, after `attempt.read`
    (#875) and `assist.read`.

11. **Out of version 1** (*default*): the drill's review history, the
    notifications, the classroom journal, a poll's ideas beyond what
    `studentFeedback` shows, the uploaded picture's bytes (the identity
    carries its address). Staying out under any version: everything a
    teacher or an administrator sees about the student that the student
    does not — the integrity journal, the roster line's note, the edu-ID
    claims, the audit rows, the kiosk pairings, `llm_calls` — and the API
    tokens and sessions, which are credentials, not data to carry.

12. **Where.** A new module `apps/api/src/modules/privacy/` (`routes.ts`,
    `service.ts`), which calls other modules' `service.ts` (and the extracted
    `auth/` and `guards.ts` finders) only. In the web app, a secondary
    action "Download my data" on a Settings card, shown on a portal session
    that is not read-only. It fetches the file and saves it, so a refusal
    (the hourly limit, a server error) is a toast, never an error body saved
    as the file.

## Consequences

- The export cannot leak what the views do not: its tests compose the
  views' own tests, plus one leak test of the whole file through the 05 §5.7
  harness — the forbidden keys of `FORBIDDEN_STUDENT_KEYS`, the answer-key
  values searched for in the serialised file, an unreleased grade, a
  gradebook mark's comment, an exam under a policy that hides answers (the
  student's own answer absent), another student's data, and each excluded
  row of point 11, for a student, a teacher on a staff seat and an admin with
  Super Powers on; and the refusals of point 7.
- The file is "everything the student can see", not "everything the
  platform holds about them": N-DATA-04 is amended to say so, and the data
  protection guide says that a full access request still goes through the
  teacher or the data-protection officer.
- Every limit of a view is the export's: a project archived by its teacher,
  the drill of an archived classroom, an evaluation whose policy shows
  nothing are absent or bare in the file as on the screens.
- A section added to a student screen later is not exported until it is
  added here, under a new `version` when the shape changes.
- A long history costs one request of a handful of queries per classroom,
  project and feedback page; the rate limit bounds the abuse, and a restart
  forgets it (best effort).

## Alternatives considered

- **Dump the user's rows table by table.** Rejected: a second exit for
  answer keys, unreleased grades and the teacher's notes, beside every
  student view and outside their tests (invariant 4).
- **Build attempts from the attempt view (`GET /attempts/:id`).** Rejected by
  the product owner: `contentVisible` bypasses `sitRefusal` and the feedback
  policy.
- **An asynchronous export: a job, a stored file, a notification.** Rejected:
  a stored copy of personal data with a retention of its own, for a file a
  request builds in seconds.
- **A zip with one file per section, or CSV.** Rejected: N-DATA-04 asks for
  JSON, and one versioned record is one contract to test.
- **Open the export to impersonation, so an administrator can hand a student
  their file.** Rejected: the administrator would carry a person's whole
  file out of a session meant to read a reported problem (ADR-034).
- **Export the open group sets whole, as the Groups tab shows them.**
  Rejected (point 6): classmates' names are theirs, not the student's.
