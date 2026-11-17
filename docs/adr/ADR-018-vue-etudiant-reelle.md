# ADR-018 — The real student view and stateless preview

## Status

Accepted (2026-09-22), consolidated through 2026-10-01.
[ADR-020](ADR-020-presence-et-verdicts-en-direct.md) changes staff presence only;
[ADR-025](ADR-025-plusieurs-tentatives-exercice.md) extends own-attempt reset to retakes;
[ADR-056](ADR-056-questions-parametrees.md) governs parameter instances.
This consolidation changes no decision. The [historical record](history/ADR-018-vue-etudiant-reelle.md)
retains the original decision numbers and seven UI amendments.
Amended 2026-10-13: what a list's Participants count includes
([Participants in the lists](#participants-in-the-lists)).
Amended 2026-11-17 (product owner): a staff seat lives the whole student flow
for everything about the teacher themself and stays out of every class or pool
aggregate ([A staff seat lives the student flow](#a-staff-seat-lives-the-student-flow));
this changes where Join as student is offered and where staff attempts are
shown ([Real student view and return](#real-student-view-and-return),
[Staff attempts](#staff-attempts)), and amends
[ADR-041](ADR-041-entrainement-espace.md) (a staff seat's own cards),
[ADR-115](ADR-115-revision-ciblee-par-notion.md) §10 (a staff seat's own
revision) and F-ORG-15, F-RES-04, F-GBOOK-01, F-GBOOK-05, F-NOTIF-07,
F-DRILL-01 and 05 §5.7.

## Context

A real rehearsal must exercise the student's production path without contaminating
class results. A stateless preview answers a different question: whether the
configured evaluation is right, before starting it or freezing its structure.
These are separate modes, not separate implementations of the student player.

## Decision

### Real student view and return

The Teacher/Student switch belongs to the application frame, with account-menu
and command-palette access. It is available to teachers/admins, not students.
It is secondary chrome (no accent, one tier under the page's primary action), so
invariant 2 is untouched.
The mode and return path live in `sessionStorage`: reload preserves one tab's walk
without changing another tab's dashboard. Entering from an evaluation or its live
dashboard goes to that evaluation's `/take/:id`; an existing student route stays,
other pages go to the student home. Return restores the entry route.

The switch does not enroll anyone. A teacher obtains a staff seat explicitly with
Join as student. Without a seat, `/take/:id` answers 404
as it does to a stranger (invariant 6). A teacher who is not staff of the classroom holds no seat and gets the
same 404; this record does not change that. The former evaluation-page button and its
automatic enrollment confirmation are gone.
*Amended 2026-11-17 (product owner): Join as student is offered on the
teacher's classroom page, on the student classroom page, where it is the
page's one primary action while the caller holds no seat, and on the `/take/:id`
screen in one click, after which the entry is asked again
([A staff seat lives the student flow](#a-staff-seat-lives-the-student-flow),
point 1). The classroom to join comes from the teacher's own staff read of the
evaluation, never from the 404, whose body stays a stranger's. A teacher off the
course's staff gets the same 404 and no Join.*

The real attempt uses the student's lobby, player, content, grading and server
clock, including the normal deadline/410 rules and confined-exam requirements
([ADR-027](ADR-027-tickets-de-lancement-et-sessions-typees.md)). The attempt page
has no ordinary application frame, but a teacher in student view gets the return
banner and, inside the player, a "Back to teacher view" entry in the `Ctrl+K`
palette; returning leaves the attempt open. Students never see that banner.

### Staff attempts

Staff attempts are visible and badged in the dashboard, grading and result tables.
*Amended 2026-11-17 (product owner): shown by default in the live dashboard
and grading; hidden by default in the results table and the teacher's
gradebook, behind a "Staff attempts: show / hide" toggle that changes rows
only ([A staff seat lives the student flow](#a-staff-seat-lives-the-student-flow),
point 5).*
A staff seat without an attempt creates no row. One shared staff-attempt query
identifies them. They count in no completion/success statistic, histogram,
per-question distribution, released grade snapshot or CSV. The export omits the
row completely rather than asking downstream consumers to honor a flag.

Presence is the deliberate exception (ADR-020): a staff member actually sitting
the evaluation is a person in the room. Staff seats with attempts contribute to
the presence denominator; dashboard-only connections do not create presence.

`DELETE /evaluations/:id/attempt` resets only the caller's own staff-seat attempts
(all their attempts when retakes exist), with dependent answers, attempt log and
gradings cascading. Staff access, staff seat and ownership are loaded predicates;
neither a student's nor a colleague's attempt is reachable. The student deadline
write gate does not prohibit deleting one's own rehearsal. Audit:
`attempt.staff_reset`; dashboards receive a refresh hint rather than a synthetic
live row-deletion protocol. Entry remains idempotent; reset is explicit.

### Staff repositories

*Accepted 2026-10-06 (product owner), [ADR-077](ADR-077-depots-de-test-du-personnel.md).* A
staff seat may accept an individual project to test it. Its repository is
visible and badged on the staff page and counted nowhere: no count, no release,
no gradebook, no notification. A group project is not testable from a staff
seat (ADR-070 §2).

### Participants in the lists

*Amended 2026-10-13 (product owner).* The Participants column of a classroom's
Activities tab counts people, not attempts or repositories: for an evaluation,
the distinct students and poll guests who have an attempt (a retake counts
once); for a project, the owners of its provisioned student repositories, or a
group repository's non-staff members (a seat not claimed yet included, and a
member on their way out of the group, whose access is not revoked yet). It
never counts a staff seat's rehearsal nor a staff test repository. The
evaluation's `attemptCount`, which locks the item list (F-EVAL-26), still counts
every attempt, the staff's included.

### A staff seat lives the student flow

*Accepted 2026-11-17 (product owner).* A teacher in the student view who holds a
staff seat could start an attempt but not follow the student's flow to its end:
no grade on the Grades tab, no notification, no drill card. The rule is now one
sentence. **A staff seat is a student seat for everything about the person
themself** — the feedback page, `/grades`, the classroom's Grades tab, their own
notifications, their own drill cards and targeted revision — **and stays out of
every class or pool aggregate**: statistics, histograms, means, the
`released_grades` snapshot, the CSV and every export, the teacher gradebook's
mean, counts, participants, completion, question statistics
([ADR-038](ADR-038-statistiques-de-question.md)), class mastery
([ADR-098](ADR-098-maitrise-des-notions-par-l-etudiant.md)), F-STAT-06,
revision times ([ADR-039](ADR-039-temps-passe-par-question.md) §6b), "who
revised", and every notification to the staff about students. Presence stays
the one exception of [Staff attempts](#staff-attempts).

"Staff seat" always means `enrollments.staff` judged on the line's CURRENT flag
(a self-enroll can convert a student line), never course membership
(`staffAccess`). `released_grades` stays class-only: a self read computes the
staff seat's grade live (`gradeShown`), as `/grades` and the feedback page
already do.

1. **The student view knows its seat.** The student classroom page carries
   `seat: none | staff | student`, derived only from the seat
   `readableClassroom` loaded; a student and an impersonation session only
   ever read `student`. A staff seat is badged in the page's header, with
   one line saying its attempts count in no class result. With `none`, Join as
   student is the page's single primary action (F-ORG-15's accent moves to
   it; no activity button takes it). On the `/take/:id` no-seat screen Join
   is one click, then the entry is asked again; the classroom comes from a
   separate staff-loaded read of the evaluation, and the 404 body stays
   byte-identical to a stranger's (invariant 6). Join is absent from `seb`,
   `kiosk` and impersonation sessions. When the self-enroll would convert a
   student roster line carrying the teacher's address (and revoke its GitHub
   access, [ADR-077](ADR-077-depots-de-test-du-personnel.md)), the server
   refuses it as `409 student_line` until the teacher confirms
   (`?convert=1`). The student home's empty states speak to a teacher in the
   student view too. In French the action is « S'inscrire à la classe »;
   « Rejoindre » stays a group's word (docs/spec/01 §1.5).
2. **The classroom's Grades tab** of a staff seat is exactly a student's
   (chosen over "attempts only"): every column, the derived scale minimum or
   absence of a released evaluation never taken, the mean if published, the
   grades computed live. `/grades` follows the same rule. Project cells follow
   the student rule.
3. **Notifications to a staff seat**: the student kinds (`results_released`,
   `results_updated`, the deadline reminder of an attempt not handed in yet;
   the drill sends no reminder of its own) only for evaluations where that
   seat has an attempt; never
   `activity_available`; projects unchanged (ADR-077 §2 stands). Default
   channels unchanged. The teacher kinds (`student_joined`, the
   `grading_ready` counts, F-NOTIF-08, -09, -11) keep ignoring staff seats.
4. **Drill**: a staff seat's attempts create drill cards for the teacher
   themself, at the hand-in and at the release
   ([ADR-041](ADR-041-entrainement-espace.md) §1), and the student drill and
   revision reads open to their owner. Every class or pool aggregate excludes
   staff-seat cards by the current flag: the population rule of the shared
   mastery loader is split between the class read and the self read, never
   relaxed for the class, and the revision times of ADR-039 §6b exclude staff
   seats explicitly. No backfill: a past staff attempt makes cards only at a
   future hand-in or release.
5. **The teacher's side**: a "Staff attempts: show / hide" toggle changes ROWS
   only, never a figure; it is kept in the browser per screen, never on the
   server, and has no effect on any export. Hidden by default in the results
   table and the teacher gradebook; shown by default in grading and the live
   dashboard. In the gradebook a staff row appears only when shown, badged,
   out of the mean and read-only: a mark on a staff seat is refused with the
   404 of a missing line, as today.
6. **"You" in the anonymous grading panel**: the anonymous payload carries a
   server-computed boolean, true only on the caller's own attempt (no id, no
   name), absent or false on every other row. Anonymity stays server-side
   ([ADR-044](ADR-044-grille-de-correction.md)).
7. **Crossing back**: "Open my copy" on the teacher's evaluation page (its
   `self.attemptId`) and, on the feedback page in the student view, "See the
   class results", which leaves the student view for that evaluation's
   results. Both are secondary chrome (invariant 2).

Rejected: a staff seat that reads only its attempts on the Grades tab (no
derived minimum, no mean) — the walk this record exists for must show what a
student reads; a server-side setting for the toggle — a display preference is
the browser's; adding staff seats to the `released_grades` snapshot — the
snapshot is the class's.

### Stateless evaluation preview

The secondary Preview action opens a new full-screen tab in every evaluation state,
loaded through its staff predicate. No attempt, answer, attempt-log, grading or
audit row is written by preview start/run/simulate/grade. Answers and the countdown
live in memory in the browser. The student's `PlayerView` and reducer are reused,
without autosave or a live stream. A restart draws a new seed.

Start returns a seed, duration, student view and frozen version map. With a supplied
seed it rebuilds that walk. Question order, shuffles and parameter draws are
reconstructed from stored versions on the server; clients supply answers and seed,
never authoritative question content. All student content passes `toStudent`.
The preview countdown uses duration, or common-window length, and none for manual
timing; expiry hands in locally. It is intentionally not a test of the server clock.

Grade validates answers, applies the type's grading rule and evaluation defaults,
and runs all runner cases including hidden cases. It returns the correction outside
the student's feedback policy. Manual/proposed outcomes are not silently treated
as validated marks; an unavailable runner is an item status rather than failure
of the whole correction. The preview never offers the model, so an essay or a
diagram comes back as a proposal by hand — a choice, since 2026-10-23 (ADR-063
§10): one "Grade" here grades every item of the evaluation, and the question
editor's Try tab is where a teacher asks the model for one essay. Run/Simulate rebuild sources from stored
templates, expose only visible cases, and share the real interactive helpers.
Budgets are in memory per teacher: ten gradings/minute and the question's run
budget; compilation has the separate budget of ADR-024.

Preview does not exercise autosave races, the server clock/deadline gate,
server-side navigation enforcement, pause, real lobby/presence, the attempt log
or persisted grading. Use the real rehearsal for those properties.

### Editing during preview and previewing the lobby

Edit question opens its draft in another tab only when the caller may edit it.
Use the new version uses the ordinary item-update route only while the item list
is editable, rebuilds with the same seed, replaces that question and drops only
its answer. Other order/shuffles/answers remain. Frozen lists explain why no update
is offered. Other item/version changes require Restart to avoid grading content
the teacher did not answer. The countdown continues while editing elsewhere.

The preview uses a ModeBanner saying nothing is saved. Restart asks once answers
exist and is disabled during grading; after correction it is the page's primary
action. Edit and Show the points live with the player's question tools, not in an
alert above the question. Version-change notices appear only when applicable.

The launch-step waiting-room preview renders the pure `LobbyScreen`, never its
connected `Lobby` container: no stream, clock request or presence registration.
It uses already loaded evaluation rules, zero presence and the roster denominator,
never question content. An evaluation that skips the lobby has no such preview.

## Consequences and alternatives

A real staff rehearsal leaves ordinary data but never a student grade. A preview
is cheap and available before launch but cannot certify the exam path. Dedicated
simulation-attempt tables, implicit enrollment on a global toggle, cross-tab mode
storage and trusting question content from the browser were rejected. Current
inline title editing is independent of these modes: safe title changes remain
allowed on a structurally frozen evaluation.

## Implementation references

- `apps/web/src/studentView.ts`, `App.tsx`, `Shell.tsx`: mode, routing and banners.
- `apps/api/src/modules/evaluation/` and `modules/guards.ts`: staff attempts/reset;
  `studentSeat` in `guards.ts`, the seat the student classroom page names.
- `apps/api/src/modules/org/service.ts` (`selfEnroll`, `409 student_line`) and
  `apps/web/src/student/joinClassroom.ts`: Join as student and its confirmation.
- `apps/api/src/modules/preview/routes.ts` and `service.ts`: access, seeds, budgets,
  grading and runner failures; `packages/contracts/src/preview.ts`: payloads.
- `apps/web/src/preview/`: player adapter, edit/version detection and correction.
- `apps/web/src/student/Lobby.tsx`: pure screen versus connected lobby.

## Historical section references

Original numbered decisions and addenda are historical; apply the consolidated
decision above. Their full text is the [historical record](history/ADR-018-vue-etudiant-reelle.md). A citation
in code or another record ("ADR-018 §3", "ADR-018, sixth addendum") lives here
now:

<a id="adr-018-the-real-student-view-and-the-teachers-own-test-attempt"></a><a id="reading-map"></a><a id="consequences"></a><a id="what-this-adr-does-not-decide"></a><a id="rejected-alternatives"></a><a id="addendum-2026-09-22-the-switch-belongs-to-the-frame-and-to-the-window"></a><a id="context_1"></a><a id="decision_1"></a><a id="consequences_1"></a><a id="rejected-alternatives_1"></a><a id="addendum-2026-09-22-second-the-page-button-goes-the-frame-switch-stays"></a><a id="addendum-2026-09-24-third-the-way-back-from-the-attempt-itself"></a><a id="addendum-2026-09-25-fourth-a-stateless-preview-of-the-whole-evaluation"></a><a id="context_2"></a><a id="decision_2"></a><a id="what-it-does-not-exercise"></a><a id="rejected-alternatives_2"></a><a id="addendum-2026-09-27-fifth-the-waiting-room-previewed-from-the-launch-step"></a><a id="context_3"></a><a id="decision_3"></a><a id="rejected-alternatives_3"></a><a id="addendum-2026-09-29-sixth-fixing-a-question-without-losing-the-walk"></a><a id="context_4"></a><a id="decision_4"></a><a id="rejected-alternatives_4"></a><a id="addendum-2026-10-01-seventh-the-preview-is-a-mode-not-a-notice"></a><a id="context_5"></a><a id="decision_5"></a>

| Old reference | Current section | Full text |
| --- | --- | --- |
| §1 the walk; §2 where it was entered from; §7 the student path; first to third addenda | [Real student view and return](#real-student-view-and-return) | [first](history/ADR-018-vue-etudiant-reelle.md#addendum-2026-09-22-the-switch-belongs-to-the-frame-and-to-the-window), [second](history/ADR-018-vue-etudiant-reelle.md#addendum-2026-09-22-second-the-page-button-goes-the-frame-switch-stays), [third](history/ADR-018-vue-etudiant-reelle.md#addendum-2026-09-24-third-the-way-back-from-the-attempt-itself) |
| §3 shown and badged; §4 counts in nothing; §5 CSV drops the row; §6 own reset | [Staff attempts](#staff-attempts) | [§1–§7](history/ADR-018-vue-etudiant-reelle.md#decision) |
| Fourth addendum (stateless preview) | [Stateless evaluation preview](#stateless-evaluation-preview) | [fourth](history/ADR-018-vue-etudiant-reelle.md#addendum-2026-09-25-fourth-a-stateless-preview-of-the-whole-evaluation) |
| Fifth addendum (waiting room); sixth (fixing a question); seventh (preview is a mode) | [Editing during preview and previewing the lobby](#editing-during-preview-and-previewing-the-lobby) | [fifth](history/ADR-018-vue-etudiant-reelle.md#addendum-2026-09-27-fifth-the-waiting-room-previewed-from-the-launch-step), [sixth](history/ADR-018-vue-etudiant-reelle.md#addendum-2026-09-29-sixth-fixing-a-question-without-losing-the-walk), [seventh](history/ADR-018-vue-etudiant-reelle.md#addendum-2026-10-01-seventh-the-preview-is-a-mode-not-a-notice) |

Amended 2026-10-09: the list of compatibility anchors into the historical
record was reduced to this table (the references that code and records cite)
and bare compatibility anchors, so old links still land here; the full text
stays in [history/ADR-018](history/ADR-018-vue-etudiant-reelle.md).
