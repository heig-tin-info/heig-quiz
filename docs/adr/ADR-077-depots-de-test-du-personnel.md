# ADR-077 — A staff seat accepts a project: the teacher's test repository

## Status

Accepted (2026-10-06, product owner; M3-14 pilot finding 8).

Scope: who may accept an individual project, and what a teacher's own
repository is on the staff page, the student view and the release.

Relations: amends F-PROJ-05 (a staff seat MAY accept an individual project),
[ADR-018](ADR-018-vue-etudiant-reelle.md) (a new "Staff repositories" section
mirroring "Staff attempts"), and
[ADR-070](ADR-070-repartitions-de-groupes.md) §2 (staff seats stay unplaced).
Depends on [ADR-053](ADR-053-retrait-des-codes-d-entree.md) for the seat.

## Context

In heig-classroom a teacher could hold a seat, accept a project and push as a
student. In Quiz a teacher in the student view reads "Read-only view: the
student's actions are not available" (F-PROJ-05: "a teacher's staff seat,
ADR-018, never accepts"). The product owner, piloting in production on a test
GitHub organization, needs to test a project end to end (link GitHub, Accept,
get a repository, push, see scores) before real students do.

The test seat already exists: `enrollments.staff = true`, created by "Join as
student" (`POST /classrooms/:id/self-enroll`, UNIQUE (classroom, user)) and
already excluded from the headcount, gradebook, groups, notifications, polls,
drill, statistics and exports. Repositories held by staff seats are already
kept out of the counts and the release, because the M8-01 import keeps the
staff flag of teachers' classroom repositories.

## Decision

1. **A claimed staff seat of the caller's own portal session may Accept an
   individual project.** Never an impersonation (ADR-034 stays read-only),
   a `seb` or `kiosk` session or a token. A teacher without a seat gets the
   404 of a missing project, and the page points to "Join as student". A
   **group project** answers the staff seat `409 no_group`, which the page
   words like a student's: staff seats are never placed in a group (ADR-070
   §2), and a staff seat reads only its own individual repository, whatever
   copy membership it kept from before it became one. It is never invited on
   a group's repository.
2. **Staff repositories** (new section of ADR-018, mirroring "Staff
   attempts"). The staff seat's repository is the holder's own: the student
   view shows it, with its runs and indicative score, to its holder only. On
   the staff page it is a row of its own, badged "Teacher", after the
   students'. It is **counted nowhere** (counts, acceptances, the release's
   readiness `scoresFinal` / `not_frozen` / `to_verify`), **never in the
   release snapshot**, never notified (`project_grade_final`, deadline
   reminders: notifications go to student seats), never in the gradebook or
   the CSV. The deadline, the freeze, the protection, the checkpoints, the
   final review and the source sync **apply to it exactly as to a
   student's**, so that the teacher tests the real thing.
3. **Revocations** (F-PROJ-17) are the student's: removing the staff seat, and
   the conversion of a student row into a staff seat by `selfEnroll`, revoke
   the recorded accesses first.
4. Resend of the invitation works as for a student.

## Consequences

- No migration. The contracts gain a nullable `seat` on the student's project
  and a `staff` flag on a staff page row.
- The client is read-only for an impersonation and for a teacher in the
  student view without a seat; a staff seat gets Link GitHub, Accept and Open
  repository.
- The teacher's GitHub account must not be a member of the organization for a
  faithful test: an owner's rights bypass the rulesets and the protected
  files, and a Quiz account holds a single GitHub link.
- An imported teacher repository (M8-01) becomes visible, badged, to its
  holder and on the staff page.

## Alternatives considered

- **B. A staff repository without a seat.** Contradicts ADR-018 ("the switch
  does not enroll anyone") and needs a schema change.
- **C. The teacher adds their own e-mail to the roster as a student.** They
  count in the headcount, the gradebook, the CSV, the notifications and
  `unassigned_students`.
- **D. No code: a second personal edu-ID account with the student role and a
  GitHub account that is not a member of the organization.** The most faithful
  test, available today.

## Product owner's decisions (2026-10-06)

- **Q1 accepted.** F-PROJ-05, ADR-018 and ADR-070 §2 are amended. The product
  owner chose to merge this rather than rely on option D alone.
- **Q3 documented only.** A test with an organization OWNER's GitHub account
  does not reproduce the rulesets and the protected files; there is no
  refusal in code. The guides say to use an account that is not a member.
- **Q4–Q6 accepted as v1 limits.** The test repository is visible and badged
  "Teacher" on the staff page; no group projects for staff seats; no reset.
- **Q7 kept as is.** Removing someone from the course staff does not remove
  their staff seat; a follow-up task, not part of this decision's code.
- **Q8 no code.** The M8-01 dry run counts the imported staff-seat
  repositories, and the decision is taken then.
