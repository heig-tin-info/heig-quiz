# ADR-053 — Removing the entry codes: the classroom join code and the evaluation access code

## Status

Accepted (2026-09-30, decided with the product owner). Delivered in two pull
requests: the classroom join code (F-ORG-06) goes with this ADR, migration
`0041_drop_join_code`; the access code of an exam or an exercise (F-EVAL-12)
goes in a second one, with the CHECK of decision 3. Amends ADR-014, ADR-025,
ADR-030, ADR-031 and ADR-032 (the last section lists what changes in each).

## Context

The platform had two codes a student typed to get in, besides the session
code of a poll:

- **The classroom join code** (F-ORG-06). A teacher switched it on; a
  student who typed it on their home took a seat on the roster, created on
  the spot when no line matched (`POST /app/api/join/:code`, audited
  `roster.join`, the switch `classroom.join_code`).
- **The access code of an evaluation** (F-EVAL-12). A teacher set one on an
  exam or an exercise; the student typed it on entering (`AttemptStartBody`),
  a wrong one audited `evaluation.access_code_failed`. It lives in
  `evaluations.access_code`, the column that also holds a poll's session
  code (ADR-014).

Three facts make both codes dead weight:

- **The roster is the teacher's and the matching is automatic.** Switch
  edu-ID always releases the institutional address, and the sign-in path
  records every address it reveals and claims each roster line whose e-mail
  matches any of them (`apps/api/src/auth/claims.ts`, GH-11). A student the
  teacher imported, by CSV or by hand, is in the classroom the first time
  they sign in; there is nothing to type.
- **Nobody used the join code.** Production had no classroom with a join
  code minted, none enabled, and no `classroom.join_code` nor `roster.join`
  row in the audit log (checked on 2026-09-30). The one attempt to give it
  more room — a single "Enter a code" field for classroom and poll codes,
  PR #350 — was closed unmerged.
- **An access code proves no presence.** A code written on the board is
  forwarded to an accomplice outside the room in seconds. It does not tell
  a student in the room from one at home, which is the only thing it was
  ever asked to do; it only adds a step where a student in the room can
  mistype.

## Decision

### 1. The classroom join code is removed

A student enters a roster only through the teacher: the CSV import
(F-ORG-04) or a line added by hand, then the claim at sign-in on any address
edu-ID reveals (F-ORG-05). A student who arrives late in the semester, or whose address
does not match, goes through the teacher, who adds or corrects the line.

Removed: the join card of the student home and its coach tip, the route
`POST /app/api/join/:code`, `joinCodeEnabled` on the classroom patch,
`joinCode` / `joinCodeEnabled` in the course detail, the service functions
that minted, toggled and redeemed the code, and the columns
`classrooms.join_code` and `classrooms.join_code_enabled` with their unique
index (migration `0041_drop_join_code`).

Kept: the teacher's *Join as student* (`POST /classrooms/:id/self-enroll`,
`roster.self_enroll`, ADR-018), which is a staff member taking a seat in
their own classroom and has nothing to do with a code. `student_joined`
(F-NOTIF-08) stays, raised now by the claim at sign-in alone.

Why not keep it switched off by default: an unused path is still a route to
defend, a switch to explain and a column to migrate. It can come back as a
new decision if a real need appears (YAGNI).

### 2. The access code of an exam or an exercise is removed

The access code half of F-EVAL-12 is removed; its other half, the IP
allowlist, stays and is still checked on every entry, retakes included.
Nothing replaces the code as a "start signal": the release of graded
evaluations by the teacher will play that role, in a separate change.

The controls that remain against a sitter working from elsewhere are the
ones that do not travel with a message: the IP allowlist, Safe Exam Browser
(ADR-027) and the kiosk stations (ADR-051), plus, later, a non-blocking
alert on students who did not seem to sit from the room (issue #384). The
waiting room is not a presence control and this ADR adds no rule to it.

Removed with the second pull request: the code field of the evaluation
settings and of the student's entry, `accessCode` from the evaluation patch
and from `AttemptStartBody`, the check and its audit action, and
`accessCode` from the MCP tool `update_evaluation`.

### 3. The poll session code stays, and owns the column

The session code of a poll (ADR-014) is unchanged. It lives in
`evaluations.access_code`, which therefore stays. From now on only a poll
may carry one, and the database says so with a one-way CHECK:

```sql
access_code IS NULL OR mode = 'poll'
```

A data migration sets `access_code` to null on every non-poll evaluation
before the CHECK is added (production: none). `EvaluationDetail.accessCode`
stays nullable in the contract and means something for a poll only.
Renaming the column to `session_code` would be more honest, and is out of
scope: it touches every poll query for no change in behaviour.

### Retired audit actions

`classroom.join_code`, `roster.join` and `evaluation.access_code_failed`
leave the audit union (`apps/api/src/audit.ts`). Their old rows, if any,
stay in `audit_log` as history: `action` is plain text, with no enum nor
CHECK, so nothing needs rewriting.

## Consequences

- **Destructive migration.** `0041_drop_join_code` drops two columns: an
  image older than it selects them and cannot run against the new schema. A
  rollback past it needs the pre-migration dump
  (`docs/development/deployment.md`, Rollback). Deploy it outside an exam
  slot.
- **Nulling non-poll codes is irreversible**, and harmless: no code is
  asked any more, and production held none.
- **A student outside the roster depends on the teacher.** There is no
  self-service path into a classroom; the teacher adds the line, and the
  claim runs at the student's next sign-in (F-ORG-05), or at once when the
  account already exists, by the claim the roster import or edit runs.
- PR #350 stays closed; its "Enter a code" field has only one kind of code
  left to take, the poll's, which has its own page (`/p/:code`).
- MCP clients that sent `accessCode` to `update_evaluation` get it refused
  by the schema (second pull request).

## Alternatives considered

1. **Keep the join code, off by default.** Nobody switched it on; it would
   keep a route, a column and a screen for a case the teacher already
   covers by adding a line.
2. **Keep the access code as an optional extra.** It stops no one who has a
   friend in the room, and a teacher who sets it believes it does: a control
   that looks like one without being one is worse than none.
3. **Rename `access_code` to `session_code` now.** Clearer, but a migration
   and a sweep of the poll module for a name; left for a change that has
   another reason to touch the column.

## What this amends

- **ADR-014 (live polls).** The session code is now the only value
  `evaluations.access_code` may hold (CHECK of decision 3); nothing else
  changes for polls.
- **ADR-025 (retakes).** "The access code is not asked again" no longer
  applies: there is no access code. The network allowlist is still checked
  on every entry.
- **ADR-030 (notification channels).** `student_joined` is raised only by
  the claim at the student's own sign-in; the join-code path it also named
  is gone.
- **ADR-031 (evaluation templates).** `access_code` stays in
  `evaluations_template_ck` and out of `TemplatePatch` (a template never
  held one); what an instance keeps of its own on a pull no longer includes
  an access code, and *Duplicate* copies none.
- **ADR-032 (per-user course preferences).** Archiving a classroom no longer
  "closes its join code": there is none. The point of the ADR (a personal
  hide is not an archive) is unchanged.
