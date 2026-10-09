# ADR-014 — Live polls

## Status

Accepted (2026-09-21), consolidated from the amendments through 2026-10-01.
[ADR-053](ADR-053-retrait-des-codes-d-entree.md) removes non-poll access codes;
[ADR-056](ADR-056-questions-parametrees.md) excludes parameterized questions.
[ADR-071](ADR-071-sondage-brainstorm.md) adds the `brainstorm` type, a moderation switch and its AI assistance.
This consolidation changes no decision. The [historical record](history/ADR-014-sondages-en-direct.md)
preserves incidents, alternatives, migration details and original section numbering.
Amended 2026-10-04: the launcher's defaults are safe for a projected screen
([Launcher](#launcher)); they supersede "opens on Recent polls when it has rows"
and "remembers the last choice" of the 2026-09-27 addenda.

## Context

A teacher needs to ask one question immediately, including to people without
accounts, without creating an exam, roster obligation or released grade. Reusing
an evaluation preserves one answer, versioning, deadline and student-content path.

## Decision

### Evaluation and audience

A poll is an evaluation of mode `poll`, with exactly one frozen question version,
created and started together through the poll routes. Generic evaluation creation
still refuses `mode: "poll"` (`501`) and student entry refuses a poll: participants
come in through the public `/app/api/p/:code` routes (read, join, answer) only. The session code is six characters from
`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, unique among running polls and those ended
less than two hours ago. The grace window permits continued reading after End.
The QR targets `${WEB_URL}/p/<code>`; `WEB_URL` defaults to `PUBLIC_URL`.

`PollAudience` has two shapes: anonymous, without a classroom; or a classroom.
Anonymous status is derived from `classroom_id`, never an independent stored flag.
A classroom-less poll must have `created_by`; its manager is the owner under the
access predicate. Classroom polls are managed by course staff. Administrative
access follows [ADR-054](ADR-054-super-powers-admin.md).
Generic classroom evaluation routes cannot reach a classroom-less poll.

A classroom poll admits signed-in claimed roster seats, staff and authorized admins.
A signed-in outsider receives `403 not_on_roster` without content: the public code
already reveals the poll's existence. A browser without a session must sign in
(`401 login_required`).
An anonymous poll admits anyone with its code: a signed-in browser votes as its
account, otherwise as a guest. There is no second identity for the same browser.
The database requires exactly one of `attempts.user_id` and `guest_id`, and a
unique index `attempts_evaluation_guest_uq (evaluation_id, guest_id)`: one attempt
per poll and browser (an account's side is the partial `attempts_evaluation_user_open_uq`,
one unfinished attempt per evaluation and account). Grading names a guest
"Guest n"; the dashboard grid iterates the roster, so it shows no guest and emits
no `dashboard.attempt` for one; no guest reaches the grade table or the CSV.

Guest identity is a random 32-byte `quiz_guest` cookie, HttpOnly, SameSite=Lax,
Secure outside development, path `/app/api/p`, 12 hours. Only
`sha256(token:evaluationId)` is stored. Public writes require the matching CSRF
header when a `quiz_csrf` cookie exists. Login return paths are same-origin paths
validated by `safeReturnTo`, carried in the signed OIDC stash, never trusted URLs.

### Questions and retrieval

Polls use published, live `mcq` or `short` questions; any other type is
`422 poll_type`, and an inline config the type's schema refuses is
`422 config_invalid`. Parameterized questions are
refused so the projection and phones see the same values. Choices never shuffle.
A pool question may come from any pool the teacher can access, independently of
links to the answering classroom's course. The pool search can narrow to the
course's linked pools but that is a filter, not an authorization gate.

An inline question creates an ordinary published version with no pool, no draft,
and optional key. The keyless schema relaxes only the key; normal publication
still requires it. Inline editing omits grading settings and asset upload.
Unsaved questions are absent from pool lists/editors and cannot enter exams or
exercises. The caller's Recent polls can retrieve and relaunch their own unsaved
questions; it reuses their identity/version rather than copying. Saved questions
are listed only while pool access remains. Recent polls also includes never-run
published questions from the caller's personal pool.

Keep attaches an unsaved question to the caller's lazily created personal `Polls`
pool and creates its draft; it does not copy or change the frozen version.
A guarded update makes concurrent keeps idempotent. Pool visibility controls
whether a colleague learns the destination, even when they can manage the poll.
A kept keyless question remains poll-only (`question_keyless` on evaluation entry);
its next ordinary publication requires a key. Reads never create the personal pool.

### Launcher

The launcher is often opened on a projected screen, so it opens on what reveals
nothing: the "Ask a new question" tab, blank, first of the three tabs (then
"Recent polls", then "From pools"), and the audience "anyone with the code".
A classroom audience is an explicit choice for each poll; the launcher does not
remember one, so a poll is never filed under, nor restricted to, a class by a
leftover from the previous one. Decided by the product owner (2026-10-04).

### Display, answers and ending

`votes` and `revealed` are independent, reversible switches, initially off.
Votes expose the distribution on both projection and phones; reveal exposes the
key. Neither closes voting. While running, a phone retains its editable answer
and Send/Update action, with the key below it if revealed and no personal verdict.
After End, the final answer/key view may show that verdict or absence of an answer.
Late answers after reveal count normally, including in outcome statistics; the
resulting optimistic success rate is an accepted distortion.

A keyless poll has no reveal control; `revealed: true` is `422 poll_keyless`.
Legacy keyless rows are normalized centrally: `votes` becomes `votes || revealed`
(an old reveal shows the votes, never hides them), and reveal becomes false. `feedbackPolicy.showKey` and `showExplanation` move with reveal so
an authenticated feedback endpoint cannot leak the key early. Every question
payload still passes through `toStudent`; revealing uses the solution path.

End closes the evaluation, expires attempts, enqueues grading and emits the
ordinary frames; it never releases results or creates roster grades. Keyless
items are skipped by grading rather than marked wrong. Compare-and-set ensures
only the winning close emits and audits. A one-minute ticker uses that same path
when neither the poll row nor an answer has changed for 12 hours. Joins do not
extend this idle period; teacher edits and answer updates do. Idle closure is
audited as `poll.end` with the system actor and `reason: idle`.

### Tally, history and visibility

`pollTally` is a pure rule: MCQ canonical choice order with zeroes; short answers
normalized for Unicode/whitespace/case, first spelling retained, frequency order,
capped by `POLL_SHORT_CAP`. Full tally frames are staff-only on the evaluation
topic, coalesced at 500 ms. Phones refetch every three seconds and receive tally
only with votes shown, solution only with key revealed. There is no tally cache:
visible votes cost one tally computation per phone per refresh.

Recent outcomes read existing validated full-mark gradings of finished keyed runs,
never independently regrade answers. Ungraded keyed runs with answers are skipped.
Use up to the last five finished runs of the newest run's keyed/keyless kind;
keyless outcomes report mean answers. Keyed rates use each run's current non-staff
roster, bounded below by its answer count, or answers alone without a roster.
Abstention is included only when every run in the window has a roster; never mix
room percentages with respondent percentages. Empty denominators are ignored;
rounding distributes whole percentages to total 100. Roster drift is accepted.

A running classroom poll appears on students' home as an Answer link to `/p/:code`,
without a question title; it disappears at End. It is not an exam card or results
card. Anonymous polls appear in the owner's poll history, not a classroom list.
Ownership/classroom topics carry appropriate refresh hints. Poll creation, display,
keep and end are audited; guest votes have no invented named actor.

## Consequences and alternatives

Nullable question pools, evaluation classrooms and attempt users are constrained
by the database and handled explicitly by readers; a null classroom means no
roster, never all null seats. Reusing evaluations avoids a second content/grading
pipeline. Fictional guest accounts, personal classrooms and tokens in URLs were
rejected. Nothing about a poll justifies releasing grades to absent roster members.

## Implementation references

- `apps/api/src/modules/poll/service.ts`: audience, codes, display normalization,
  tally, idle closure, recent outcomes and pool search.
- `apps/api/src/modules/poll/routes.ts`: managed/public loaders and CSRF. Teacher
  routes `/app/api/polls` (`GET` list, `POST` create-and-start, `questions`,
  `pool-questions`, `inline`) and `/app/api/evaluations/:id/poll` (`GET`, `reveal`,
  `end`, `again`, `keep`); public routes
  `GET /app/api/p/:code`, `POST …/join`, `POST …/answer`.
- `packages/contracts/src/poll.ts`, `packages/domain/src/pollTally.ts` and
  `packages/domain/src/pollOutcome.ts`: contracts and pure rules.
- `apps/api/src/modules/guards.ts`, pool/evaluation services and the poll database
  tests: ownership, retention and content boundaries.

## Historical section references

Original numbered decisions and addenda are historical. These compatibility
anchors lead to their full text; apply the consolidated decision above.

Where an old number cited in code or another record now lives:

| Old reference | Current section |
| --- | --- |
| §1 a poll is an evaluation; §2 session code; §4 participants; §5 guest cookie; §6 public routes; §10 login return; §11 `WEB_URL`; audience addendum (2026-09-27) | [Evaluation and audience](#evaluation-and-audience) |
| §3 personal pool; inline, Recent polls (§1–2) and From pools addenda | [Questions and retrieval](#questions-and-retrieval) |
| §7 reveal; §8 End does not release; votes-hidden, 12-hour expiry and independent switches addenda | [Display, answers and ending](#display-answers-and-ending) |
| §9 tally; Recent polls §3 (outcomes) | [Tally, history and visibility](#tally-history-and-visibility) |

<a id="adr-014-live-polls-an-evaluation-of-one-question-a-code-and-participants-without-a-roster"></a>
- [ADR-014 — Live polls: an evaluation of one question, a code, and participants without a roster](history/ADR-014-sondages-en-direct.md#adr-014-live-polls-an-evaluation-of-one-question-a-code-and-participants-without-a-roster)
<a id="reading-map"></a>
- [Reading map](history/ADR-014-sondages-en-direct.md#reading-map)
<a id="consequences"></a>
- [Consequences](history/ADR-014-sondages-en-direct.md#consequences)
<a id="rejected-alternatives"></a>
- [Rejected alternatives](history/ADR-014-sondages-en-direct.md#rejected-alternatives)
<a id="addendum-2026-09-23-a-question-written-in-the-launcher-is-not-saved"></a>
- [Addendum (2026-09-23): a question written in the launcher is not saved](history/ADR-014-sondages-en-direct.md#addendum-2026-09-23-a-question-written-in-the-launcher-is-not-saved)
<a id="addendum-2026-09-27-the-votes-are-hidden-until-the-teacher-shows-them-157"></a>
- [Addendum (2026-09-27): the votes are hidden until the teacher shows them (#157)](history/ADR-014-sondages-en-direct.md#addendum-2026-09-27-the-votes-are-hidden-until-the-teacher-shows-them-157)
<a id="addendum-2026-09-27-recent-polls-lists-every-question-the-teacher-ran"></a>
- [Addendum (2026-09-27): "Recent polls" lists every question the teacher ran](history/ADR-014-sondages-en-direct.md#addendum-2026-09-27-recent-polls-lists-every-question-the-teacher-ran)
<a id="addendum-2026-09-27-the-audience-of-a-poll-anonymous-in-no-classroom-or-a-classrooms-by-name"></a>
- [Addendum (2026-09-27): the audience of a poll — anonymous in no classroom, or a classroom's by name](history/ADR-014-sondages-en-direct.md#addendum-2026-09-27-the-audience-of-a-poll-anonymous-in-no-classroom-or-a-classrooms-by-name)
<a id="addendum-2026-09-27-from-pools-a-poll-borrows-from-any-pool-the-teacher-reaches"></a>
- [Addendum (2026-09-27): "From pools" — a poll borrows from any pool the teacher reaches](history/ADR-014-sondages-en-direct.md#addendum-2026-09-27-from-pools-a-poll-borrows-from-any-pool-the-teacher-reaches)
<a id="addendum-2026-09-28-a-poll-left-without-answers-for-12-hours-ends-on-its-own-190"></a>
- [Addendum (2026-09-28): a poll left without answers for 12 hours ends on its own (#190)](history/ADR-014-sondages-en-direct.md#addendum-2026-09-28-a-poll-left-without-answers-for-12-hours-ends-on-its-own-190)
<a id="addendum-2026-09-29-only-end-closes-the-vote-votes-and-reveal-are-independent-switches"></a>
- [Addendum (2026-09-29): only End closes the vote; votes and reveal are independent switches](history/ADR-014-sondages-en-direct.md#addendum-2026-09-29-only-end-closes-the-vote-votes-and-reveal-are-independent-switches)
