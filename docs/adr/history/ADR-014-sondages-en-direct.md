> Historical snapshot: superseded wording and delivery history are preserved here.
> For current decisions, read [the active ADR](../ADR-014-sondages-en-direct.md). Load this archive only for rationale or a historical section reference.

# ADR-014 — Live polls: an evaluation of one question, a code, and participants without a roster

## Status

Accepted (2026-09-21, phase 2). Settles F-LIVE-13, F-LIVE-14 and F-AUTH-05, and lifts
decision D7 of `docs/PLAN-MVP.md` along one path only (below). **Amended by [ADR-053](../ADR-053-retrait-des-codes-d-entree.md)
(2026-09-30):** the exam and exercise access code is removed, so the session code of
decision 1 is now the only use of `evaluations.access_code` (CHECK
`evaluations_access_code_poll_ck`). **Amended by [ADR-056](../ADR-056-questions-parametrees.md)
(2026-10-01):** a poll refuses a parameterized question; the beamer and the phones must
show the same values.

## Reading map

Read the Status above for cross-record amendments. Within this record, use
the sections below before applying the original Decision; earlier wording
is historical where these sections change it.

| Topic | Read |
| --- | --- |
| Audience and access; replaces original classroom/anonymous coupling | [Audience](#addendum-2026-09-27-the-audience-of-a-poll-anonymous-in-no-classroom-or-a-classrooms-by-name) |
| Question creation without a pool | [Inline questions](#addendum-2026-09-23-a-question-written-in-the-launcher-is-not-saved) |
| Retrieval of unsaved questions; qualifies the earlier absence from lists | [Recent polls](#addendum-2026-09-27-recent-polls-lists-every-question-the-teacher-ran) |
| Question sources beyond the personal pool | [Accessible pools](#addendum-2026-09-27-from-pools-a-poll-borrows-from-any-pool-the-teacher-reaches) |
| Expiration without answers | [12-hour expiry](#addendum-2026-09-28-a-poll-left-without-answers-for-12-hours-ends-on-its-own-190) |
| Votes and reveal; replaces the earlier three-step progression | [Independent switches](#addendum-2026-09-29-only-end-closes-the-vote-votes-and-reveal-are-independent-switches) |

## Context

A teacher in front of a class wants to ask ONE question, right now, and watch the answers
stack up on the beamer: a bar per choice for a multiple choice, the distinct texts for a
short answer. The room answers on its phones, by scanning a QR code. Nothing about this is
an exam: there is no roster, no schedule, no grade, and half the room may not have an
account on the platform at all (F-AUTH-05).

Four facts of the existing codebase shape the design:

- **decision D7** says `poll` is phase 2: the `mode` column and the `EvaluationMode` enum
  accept it, and every code path that meets it answers `501 not_implemented`. The column,
  the state machine, the attempts, the answers and the SSE topics therefore already exist
  and need no migration;
- **invariant 4**: question content only ever reaches a participant through
  `studentView`/`toStudent`. A public page is content reaching a participant;
- **invariant 6**: access is LOADED, never checked afterwards. A poll is a teacher surface
  plus a public surface, and the public one has no session to load an identity from;
- `attempts.user_id` was `NOT NULL` and every read assumed an account behind every attempt.
  `guest_participants` existed in the schema, documented as "phase 2, no route writes it".

## Decision

1. **A poll IS an evaluation of mode `poll`**, in a classroom the teacher picks, with
   exactly ONE item, created AND started in a single call (`POST /app/api/polls`). Its
   settings are the `exercise` preset plus `settings.poll = { anonymous, revealed }`, its
   `access_code` is the six-character session code shown on the beamer, and its state is
   `running` from the first instant: there is no draft to review and no lobby to fill.

   D7 is lifted along THIS path and no other. `createEvaluation` still refuses
   `mode: "poll"` (`501`), because a poll is never authored item by item; the poll module
   calls `createPollEvaluation`, which lives in `modules/evaluation/service.ts` because
   `evaluations` and `evaluation_items` are that module's tables and no other module writes
   them. `enterEvaluation` — the student route of an exam — keeps refusing a poll too: a
   participant of a poll comes in through `/app/api/p/:code`, never through the roster.

2. **The session code**, six characters of `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — no `I`, `O`,
   `0` or `1`, because it is read off a beamer and typed on a phone. It is unique among the
   polls a code still reaches: the running ones, and the ones that ended less than two hours
   ago. That grace window is what lets a phone keep showing the question and the revealed
   key while the teacher comments the result; afterwards the code is free again.

3. **The teacher's personal pool is the home of poll questions** (F-POOL-01), created
   LAZILY by `ensurePersonalPool` on the first poll question — name `Polls`, `private`,
   `is_personal` — and unique per owner through the partial index `pools_personal_uq`. It is
   an ordinary pool afterwards: it shows on the pools page, it can be renamed and shared.

   The launcher never learns its id: `POST /app/api/polls/questions` ensures the pool and
   creates the question in it through the ordinary pool service, and
   `GET /app/api/polls/questions` lists its published `mcq`/`short` questions, most recently
   USED first. "Used" is read from the poll evaluations that froze a version of the question
   (`evaluation_items` → `evaluations.mode = 'poll'`); no column was added for it.

4. **A participant is not a roster seat.** `attempts.user_id` becomes nullable,
   `attempts.guest_id → guest_participants` is added, and the schema — not a service —
   carries the rule: `CHECK ((user_id is null) <> (guest_id is null))` plus a second unique
   index `(evaluation_id, guest_id)` beside the existing `(evaluation_id, user_id)`. The
   idempotency of `ensureAttempt` is therefore the same for both: one attempt per
   (poll, browser) and per (evaluation, account).

   `Participant` becomes `{ userId, guestId, timeBonusPercent }` and everything downstream —
   `ensureAttempt`, `beginAttempt`, `saveAnswer`, `attemptView` — is reused unchanged. The
   three places that assumed an account say so now: the grading panel joins `users` with a
   LEFT JOIN and names a guest "Guest n", the dashboard grid iterates the ROSTER and so
   simply does not show guests, and `dashboard.attempt` is not emitted for a guest because
   there is no roster row to light up.

5. **Guest identity is a cookie and a hash.** `quiz_guest`, `HttpOnly`, `SameSite=Lax`,
   `Secure` outside development, path `/app/api/p`, 12 h, value a random 32-byte token. The
   database stores `sha256(token:evaluationId)`, never the token. Binding the hash to the
   evaluation is what lets ONE cookie serve a browser across several polls while
   `token_hash` stays globally unique, and what stops a hash read out of one poll's table
   from being replayed as another poll's participant.

   The cookie is minted on `POST /p/:code/join`, only when the poll is anonymous and there
   is no session. A signed-in browser joins as its account and gets an ordinary user attempt
   — `participantOf` is bypassed for a poll, which is exactly F-AUTH-05 — and never a guest
   row as well: one browser, one identity per poll.

6. **The public surface is `/app/api/p/:code`**, unauthenticated, three routes: read, join,
   answer. It is safe because of what it can REACH, not because of who is behind it: a
   caller must hold a code that only exists while a poll is live, the only thing they can
   write is an answer to that poll's single question, and the guest cookie carries no
   identity and is worth one vote in one poll. The double-submit CSRF check of
   `requireSession` cannot apply (there is no session), so the rule is: when a `quiz_csrf`
   cookie IS present — a teacher or a student trying the poll in their own browser — the
   `x-csrf-token` header must match it, so a cross-site form cannot spend THEIR vote; a
   browser with no such cookie has nothing to steal and is let through.

7. **The reveal is one fact written in two places.** `settings.poll.revealed` is what the
   projection and the phones read; `feedbackPolicy.showKey`/`showExplanation` move with it,
   because a signed-in participant also holds `GET /attempts/:id/feedback`, and leaving that
   behind would publish the key before the teacher revealed anything. A poll is therefore
   created with `immediate` feedback and the key held back.

8. **"End" stops at `closed`, and does not release.** The glossary sends a poll from
   `running` to the end in one move, and the end here is `closeEvaluation` — the attempts
   are expired, the state becomes `closed`, the deterministic grading pass is enqueued —
   with the release deliberately NOT taken. `releaseResults` computes the grade table from
   the classroom's ROSTER, freezes it in `released_grades` and makes a card appear on every
   enrolled student's results page: a 1.0 for a poll most of them never saw, plus a
   `results` hint telling them to go and look at it. That is the absurd outcome the spec
   warns about, and a poll has nothing to release: its result is the tally on the beamer.
   `state: "ended"` on the public view is what a phone reads, and it is `closed` underneath.

9. **The tally is a pure rule.** `pollTally` in `@quiz/domain` takes the type, the number of
   canonical choices and the stored payloads: `mcq` gives one entry per canonical choice, in
   canonical order, zeroes included; `short` folds the spellings (NFC, whitespace collapse,
   trim, case) and displays the FIRST one seen, most frequent first, capped at
   `POLL_SHORT_CAP`. A poll never shuffles its choices — the beamer and the phones must show
   the same screen, and a bar is labelled by canonical index.

   It travels as the `poll.tally` event of `docs/spec/05` §5.4: the whole tally, never a
   delta, on `evaluation:<id>`, **staff only** (the room must not read the distribution
   before the teacher shows it), coalesced 500 ms per evaluation by the bus.

10. **The login return path.** `GET /app/auth/login?next=/p/ABC123` and
    `POST /app/auth/dev` with a `next` field both come back to the poll. One validator,
    `safeReturnTo` in `auth/returnTo.ts`: a same-origin absolute PATH, nothing else — no
    `//host`, no scheme, no backslash. For OIDC the path travels in the SIGNED stash cookie
    beside the PKCE verifier, never in the `state` the IdP echoes back.

11. **`WEB_URL`.** The QR code encodes `${WEB_URL}/p/<code>`, which must point at the SPA. It
    defaults to `PUBLIC_URL`, which is right in production, where the monolith serves the
    built SPA; in development the SPA is Vite on :5173 and `WEB_URL=http://<ip>:5173` is
    what makes a real phone able to scan the code.

## Consequences

- A poll appears in its classroom's evaluation list, like any other evaluation. That is the
  price of reusing the whole machine, and it is also how a teacher finds the poll they ran
  last Tuesday.
- `attempts.user_id` is nullable everywhere. The check constraint means a bug can no longer
  produce an attempt owned by nobody or by two, and the 301 tests that existed before this
  ADR pass unchanged.
- Nothing about a guest reaches the grade table: `computeResults` walks the roster, and a
  guest has no seat in it. A poll's CSV is the classroom's, with no answers in it.
- The audit log gains `poll.create`, `poll.reveal` and `poll.end`; a guest is an actor the
  log never names, because there is no identity to name.
- `docs/spec/06-questions-ouvertes.md` rows 15 and 16 are settled here.

## Rejected alternatives

1. **A `polls` table of its own.** It would duplicate items, attempts, answers, the autosave
   gate, the deadline rule, the grading pass and the SSE topics — and it would need a second
   `studentView`, which is the one thing invariant 4 says must exist once.
2. **A guest as a `users` row.** It would put a fictional account in the identity table,
   which every role rule, every roster claim and every notification reads. A guest is not a
   person the platform knows; it is a browser holding a cookie for twelve hours.
3. **A guest token in the URL** (`/p/ABC123?g=…`). It survives a copy-paste into a chat, and
   two students then share one vote. A cookie scoped to `/app/api/p` does not travel.
4. **`sha256(token)` alone.** One cookie could then only ever identify one poll, so a second
   poll in the same lecture would overwrite the browser's identity in the first one.
5. **Releasing the poll at the end** (the letter of the glossary's `running → released`).
   See decision 8: it writes a grade for people who were never there.
6. **A `poll.tally` addressed to everyone.** The room would read the distribution as it
   forms, which changes the answers — and it would publish the majority answer before the
   reveal.

## Addendum (2026-09-23): a question written in the launcher is not saved

Decision 3 made the personal `Polls` pool the only home of a poll question: "Ask a new
question" created a question there and sent the teacher to the full editor, to publish it
and come back. In the middle of a lecture that is four screens for one question. The
launcher's second tab now holds the type's own editor and starts the poll on what is
written, without saving anything a teacher would find again:

1. **`POST /app/api/polls/inline`** (`PollInlineCreate`: `classroomId`, `anonymous`,
   `type`, `config`). The classroom is loaded through the staff predicate, like
   `POST /polls`; a type other than `mcq`/`short` is the same `422 poll_type`; the
   config goes through the type's own `configSchema` through the registry (`saveConfig`,
   the publication gate) and a refusal is `422 config_invalid` with the zod issues, which
   the launcher places under the fields. The launch is audited as `poll.create` with
   `inline: true`.
2. **The content is an ordinary frozen version of a question that belongs to no pool.**
   `questions.pool_id` becomes nullable (migration `0010_poll_unsaved_questions`); the
   `pool` service's `createUnsavedQuestion` writes the question with `pool_id` null and ONE
   published version (number 1, no draft), and the poll's item freezes it exactly as it
   freezes a saved question's. Everything downstream — `studentView`/`toStudent`
   (invariant 4), the key on reveal, the tally, the grading pass, "Run again" — is the
   same code on the same tables. Its name, and the poll's title, is the start of its
   statement: what the room reads anyway.
3. **Nothing reaches it but its polls.** Every pool listing filters on `pool_id`, and
   `findAccessibleQuestion` joins `pools`, so it is in no list, no search, no count and no
   editor; `addItems` refuses it for any other evaluation. A teacher who wants to keep a
   question says so after the poll — see 6.
4. **No marks, so no marking settings.** `EditorProps.ungraded` asks an editor to leave out
   what only decides a mark: the scoring card of `mcq` (policy, cap, shuffle opt-out), the
   points and the prefilters of `short`. The KEY stays, as something the teacher MAY
   write — see 5. An unsaved question has no pool to hold an image, so the launcher lends
   no upload.
5. **The key is optional: an opinion poll** (decided 2026-09-23, after the first version of
   this addendum required a key). "Which lab rhythm suits you?" has no right answer, and
   forcing the teacher to tick one puts a false "Correct answer" on the wall.
   - *Validation.* The server contract (`@quiz/core`, `QuestionTypeServer`) gains two
     optional members: `keylessConfigSchema`, the type's `configSchema` with the key made
     optional and NOTHING else relaxed (an `mcq` still needs two choices, a `single` one at
     most one key; a `short` matcher that is there is still checked), and `hasKey(config)`.
     `mcq` and `short` implement both. `saveConfig(type, config, { keyOptional: true })` is
     the one write that uses it, and only `createUnsavedQuestion` calls it. Publication and
     the draft issues (`tryLoadConfig`) stay on the strict schema, so a pool question, and
     therefore every evaluation, still demands a key — tested. The read path
     (`loadConfig`) parses with the keyless schema when a type has one: a read accepts what
     any write gate accepted, and a stored config always passed one.
   - *Grading.* The grading pass skips an item whose config `hasKey` denies: no zero per
     answer, which would mark the whole room wrong. A keyed poll is graded as before.
   - *Reveal.* `toSolution` gives an empty key (`{ correct: [] }`, `{ expected: [] }`). The
     wall marks nothing (no tick, no faded row) and its switch reads "Results shown"
     instead of "Answer revealed". `PollPublicView` carries the `tally` once revealed
     (null before), and a phone whose key is empty shows the distribution with its own
     answer named — no "correct", no "wrong", no score. The question itself still leaves
     only through `toStudent` (invariant 4). *Amended by the addendum of 2026-09-29: a
     keyless poll has no reveal; its votes switch is what hands the phones the
     distribution.*
   - *Launcher.* The blank question starts WITHOUT a key (no choice ticked, no accepted
     answer), one muted line says marking one is optional, and the `short` editor lets its
     last accepted answer go when `ungraded`.

   Rejected: relaxing `configSchema` itself and checking the key at publication only. The
   type's schema is what the editor's issues, the canonical import and every test read;
   moving the key out of it would weaken all of them to serve one launcher.
6. **"Keep this question"** (decided 2026-09-23). Since the launcher stopped writing into
   the `Polls` pool, nothing created that pool any more, and "Pick a question" drew from a
   pool a new teacher could not get. The poll screen now offers to keep the question:
   - *Route.* `POST /app/api/evaluations/:id/poll/keep`, no body, beside `reveal`, `end` and
     `again`: the poll is loaded through the staff predicate (404 otherwise, 401/403 before
     that), so whoever manages the poll may keep its question, and it lands in THEIR
     personal pool. `pool.keepUnsavedQuestion` calls `ensurePersonalPool` (the pool is still
     born on first use, now by the first keep) and ATTACHES the question: `pool_id` set, no
     copy — the question and its published version already exist and the poll keeps
     pointing at them. It gains what every pool question has: a name free in the pool (its
     statement, then `… (2)`, since `questions_pool_name_uq` is per pool) and a draft, the
     published config stamped with the publication's time so the list shows no pending
     change. The UPDATE is guarded by `pool_id is null`, so two simultaneous keeps attach it
     once. Keeping a question already in a pool changes nothing and answers the current
     view (idempotent). Audited as `poll.keep`; the pool's topic and the caller's own topic
     get a hint (a pool created a moment ago has no subscriber yet).
   - *View.* `PollTeacherView.question` gains `saved` and `pool` (`{ id, name }`, only when
     the caller reaches that pool through the pool predicate: a colleague on the same staff
     learns the question is kept, not where a private pool is). The projection offers the
     action in its menu while the room answers — the wall is the room's — and as a secondary
     button beside "Run again" once the poll has ended; afterwards the button reads "Kept in
     Polls" and opens the question.
   - *Empty tab.* `GET /polls/questions` still answers `[]` without a personal pool (a read
     never creates one); the launcher's empty state says questions kept after a poll land
     there and points to "Ask a new question". The pool is never created in advance: a
     teacher who never polls never sees an empty `Polls` pool.
   - *No key, no evaluation.* A kept question may have no key (5). It runs a poll again from
     the pick list, but `addItems` refuses it with `422 question_keyless` — the route passes
     the type's `hasKey`, as it passes `defaultPoints` — and the evaluation's question picker
     shows it disabled, "polls only" (`QuestionRow.keyless`, the latest published version has
     no key).
   - *Editor rule.* Opening a keyless kept question asks for nothing: its draft is the
     keyless config, stored as drafts always are (D16), and the "incomplete" alert appears
     only once the teacher edits, like any invalid draft. One muted line
     (`QuestionDetail.keyless`) says it runs polls, not evaluations, and that publishing a
     new version asks for a key. Publication stays on the strict schema: the only keyless
     version a pool can hold is the one the poll wrote. Rejected: a keyless publication
     path for the `Polls` pool — it would make a second kind of pool question that every
     evaluation path would have to screen, for a question that already runs as it is.

Rejected: a nullable `evaluation_items.question_version_id` beside an inline `config`
column. Every reader of an item — `joinedItems`, grading, results, the dashboard, the
autosave gate — joins `question_versions` and `questions`; a second shape of item would
have to be taught to each of them, and a second path to `toStudent` is the one thing
invariant 4 forbids.

## Addendum (2026-09-27): the votes are hidden until the teacher shows them (#157)

The projection drew the distribution as the votes arrived. The room reads the wall, and
the last to vote followed the longest bar: the herd effect decision 7 keeps off the phones
came back through the beamer.

- *Three steps, one progression.* What the wall shows is `hidden` → `votes` → `answer`
  (`PollDisplay`, derived by `pollDisplayOf` from `settings.poll`). A reveal implies the
  votes. An opinion poll has two steps, `hidden` → `answer`: its reveal is what hands the
  phones the results, so a wall-only step would say nothing more. *Superseded by the
  addendum of 2026-09-29: two independent switches.*
- *Server state.* `settings.poll.votes` (default `false`) sits beside `revealed` and moves
  through the same route, `POST …/poll/reveal { revealed, votes? }`; `votes` omitted leaves
  it where it was. A reload, or a second screen on the same poll, shows the same step.
- *Wall only.* `votes` never reaches a phone: `PollPublicView.tally` stays null until the
  reveal, and the `poll.tally` frames stay staff-only. Hidden, an mcq keeps its choices on
  the wall without bar or figure; a short-answer poll lists no answer. *Amended by the
  addendum of 2026-09-29: `votes` reaches the phones too; the frames stay staff-only.*
- *No menu.* The projection's `…` menu is gone: the way back is an arrow before the context
  line, "Keep this question" a bookmark icon, "End poll" a named ghost button, still
  confirmed. The arrow keys and Page Up / Page Down (a presenter clicker) walk the steps.

## Addendum (2026-09-27): "Recent polls" lists every question the teacher ran

Issue #161. Addendum 2026-09-23, item 3, said an unsaved question "is in no list, no
search, no count and no editor", and item 6 made "Keep this question" the only way back to
it. In practice a teacher's first wish in the launcher is to re-run a question they asked
last week — most of which they wrote inline and never kept — and those were unreachable
once the poll ended. Decided by the product owner: the list INCLUDES them.

1. **The tab is "Recent polls"** (« Derniers polls »). `GET /app/api/polls/questions`
   answers the questions of the polls the caller LAUNCHED (`evaluations.mode = 'poll'`,
   `created_by` = caller), one row per question, most recent run first — kept or not —
   then the published questions of their personal pool that never ran, most recently
   edited first. `PollQuestionPick` gains `saved` (the question sits in a pool) and
   `outcome`. "Used" and "use count" now count the caller's own runs. A pool question is
   listed only while `poolAccess` still lets the caller reach it, so every row can be
   relaunched. The launcher opens on this tab when it has rows, on "Ask a new question"
   otherwise.
2. **Item 3 is amended, not dropped.** An unsaved question is still in no POOL list, no
   search of the pool screens, no count and no editor, and `addItems` still refuses it.
   It is reachable from exactly one more place, the caller's "Recent polls", on exactly
   one ground: they ran a poll on it. `POST /app/api/polls` relaunches it through
   `findOwnUnsavedPollQuestion` (`guards.ts`) — `pool_id` null AND a poll created by the
   caller froze a version of it, or the caller is an admin — tried after the pool
   predicate; a colleague on the same staff gets the ordinary 404 (they reach the poll,
   and "Run again" on it, through the staff predicate as before). The relaunch reuses the
   same question row and its one version; nothing is copied. "Keep this question" is
   unchanged: it is how a question gets into a pool, not how it stays reachable.
3. **The outcome is a pure rule**, `pollOutcome` in `@quiz/domain`, fed per FINISHED run
   (a running poll is still moving) with `{ keyed, answered, correct, roster }`:
   - `keyed` is the type's `hasKey` on the FROZEN version; `correct` counts the answers
     whose validated grading has full marks (`points >= max_points > 0`) — the grading
     pass is what decides right and wrong, nothing is re-graded for a list; a keyed run
     with answers and no grading yet is not a result and is skipped;
   - `roster` is the classroom's current non-staff enrolments for a poll that asks who
     answers, and NULL for an anonymous one. It is keyed on "has a roster", not on the
     classroom (`rosterOfRun`): an anonymous poll knows nobody who was meant to answer,
     and a classroom-less poll (#160) has no roster at all;
   - the kind follows the newest run (keyless → "n answers" per run, on average; keyed →
     donut), runs of the other kind are dropped, and the window is the last five runs
     left (`POLL_OUTCOME_WINDOW`);
   - abstention is shown only when EVERY run of the window had a roster; one anonymous run
     folds the donut to correct / incorrect over the answers — an average of "share of the
     room" and "share of those who answered" means neither;
   - the average is the mean of the per-run rates, each over `max(roster, answered)` (a
     signed-in teacher trying their own poll has no seat) or over `answered`; a run with
     no denominator is left out. Whole percentages are distributed by largest remainder,
     so a tooltip always sums to 100.
4. **Drawing it** is `apps/web/DESIGN.md`, "Poll outcome donut": `success` / `warning` /
   grey, fixed clockwise order, 2 px gaps, the correct share in the hole, every share in
   words on hover and focus.

Rejected: listing only kept questions and nudging the teacher to keep more — the point of
the inline path is that a lecture has no time for filing; a `last_polled_at` column on
`questions` — the polls already hold that fact; recomputing correctness from the answer
payloads with the type's `grade` — a second grading path whose verdict could disagree with
the grading panel's; the roster frozen at poll time — no table holds it, and a roster that
changed since is a rare, visible drift on a five-run average.

## Addendum (2026-09-27): the audience of a poll — anonymous in no classroom, or a classroom's by name

Decision 1 put every poll "in a classroom the teacher picks", and the launcher asked two
questions: a classroom, and whether the poll was anonymous. Of their four answers only two
meant anything. "A classroom, anonymously" filed the poll under a class that anybody holding
the code could answer; "a classroom, not anonymously" let ANY signed-in account in, roster or
not, so the class it was filed under restricted nothing. The product owner settled it
(issue #160): the audience is one choice, and "a classroom, anonymously" is dropped.

1. **Two audiences, one contract.** `PollAudience` in `@quiz/contracts` is
   `{ kind: "anonymous" } | { kind: "classroom", classroomId }`, and it replaces
   `classroomId + anonymous` in `PollCreate` and `PollInlineCreate`. A body in the old shape is
   a `400`, not a silent default. The launcher shows ONE control, "Who answers": "Anyone with
   the code (anonymous)" and one entry per classroom the teacher is on the staff of; it
   remembers the last choice as it remembered the classroom, and falls back to "anyone" when
   nothing is remembered or the classroom is gone — "anyone" needs no classroom, so a teacher
   with none can poll. The MCP `create_poll` tool takes an optional `classroomId` instead of a
   flag.
2. **An anonymous poll belongs to no classroom.** `evaluations.classroom_id` becomes nullable
   (migration `0018_poll_audience`), and the schema, not a service, says for what:
   `CHECK evaluations_home_ck (classroom_id is not null or (mode = 'poll' and created_by is not
   null))`. An exam or an exercise without a classroom cannot be written, and neither can a
   classroom-less poll that nobody owns. **The owner is `created_by`**, which every evaluation
   already carries — see the rejected alternative below. A partial index
   `evaluations_owned_poll_idx (created_by, created_at) where classroom_id is null` serves the
   owner's list.
3. **`settings.poll.anonymous` is derived, never stored.** A poll is anonymous exactly when it
   has no classroom. `EvaluationSettings.poll` keeps `revealed` only (an older row's
   `anonymous` key is dropped by the parse); `pollSettingsOf` computes
   `{ anonymous: classroom_id is null, revealed }`, and the views keep carrying
   `settings.anonymous` so the phone and the projection read it where they always did. A
   running poll created before this addendum as "classroom + anonymous" becomes a classroom's
   poll: its guests' answers stay counted, and its page asks every browser without a session to
   sign in. Polls run for minutes; no migration rewrites them.
4. **Access (invariant 6).** One predicate is added beside `staffAccess`:
   `ownedPollAccess(userId)` — `classroom_id is null and created_by = userId` — and one finder,
   `findManagedEvaluation`: the evaluation through a staff seat on its course, or, when it has
   no classroom, through ownership; an admin reaches both (`accessWhere`). The poll routes load
   through it, so a colleague — even one on every staff the owner is on — gets the 404 of a
   poll that does not exist. `findReachableEvaluation` starts with it too, which is what lets
   the owner's projection open `?watch=evaluation:<id>` and receive `poll.tally`.
   `loadEvaluation` keeps its classroom join on purpose: the generic evaluation routes
   (settings, items, dashboard, grading, results, CSV) have nothing to offer a classroom-less
   poll and answer it 404, its owner included.
5. **A classroom's poll admits its roster and its staff, signed in.** The public loader
   (`publicScope`) loads the signed-in viewer of a classroom's poll through
   `findReachableEvaluation` — a CLAIMED seat on the roster, a staff seat, or an admin — before
   anything is read, joined or answered. Anybody else signed in gets
   `403 { error: "not_on_roster" }`, and the phone says the poll is for another class. It is a
   403 and not the usual 404 because the code is on the wall of the room: the poll's existence
   is no secret, the refusal carries nothing of its content, and its reason is the one thing
   the reader can act on (another account). A browser with no session is still sent to the
   login (`me.loginRequired`, `401 login_required` on join), with the path back to the poll.
   `participantOf` stays bypassed: a staff member trying the poll holds no roster seat, and
   the check that matters has already been made by the loader.
6. **Where a classroom-less poll shows.** In no classroom's evaluation list (they list by
   `classroom_id`); in the owner's `GET /app/api/polls`, whose `PollSummary.classroomId` is now
   nullable — the "Recent polls" tab of #161. `PollTeacherView.evaluation.classroomId`,
   `classroomName` and `courseName` are nullable; the projection's context line then reads
   "Anyone with the code", and its "Back" goes to the launcher. The refresh hints that went to
   `classroom:<id>` go to the owner's `teacher:<id>` topic instead (`homeTopic` in the bus),
   and the grading progress of its end goes to the owner (`staffOf`).
7. **Audit.** No new action. `poll.create` records `audience` and `classroomId` (null) in its
   payload, and every event of a classroom-less poll has the owner as its actor, so the poll
   stays attributable without a classroom to hang it on.
8. **The roster is a condition, never a join on null.** The helpers that read the roster of an
   evaluation (`participantOf`, the dashboard, the results, the staff-attempt queries) go
   through `seatsOf(evaluation)`, which is `false` for a classroom-less poll: it has no roster,
   and `classroom_id = NULL` must never be read as "every seat whose classroom is null".
   Paths that reached an evaluation THROUGH its classroom use `classroomIdOf`, which throws on
   the one shape they can never meet.
9. **A running classroom poll is on its roster's home** (issue #163). Before it, the student
   home listed a poll like any evaluation: a card under "Open now" whose Start button posted to
   `/evaluations/:id/attempt`, which answers a poll `501`, and once ended a card under "Past"
   whose View opened feedback that is never released (§8). A poll is now never an
   `EvaluationCard`: `StudentHome.polls` lists the RUNNING polls of the classrooms the student
   holds a claimed seat in, as `StudentPollCard` — `id`, `code`, classroom and course — and the
   card's one button, "Answer", opens `/p/:code`. It carries no title: a poll's title is its
   question's internal name or its statement, which only `toStudent` may hand out
   (invariant 4); the card says "Live poll". An ended poll leaves the home. A classroom-less
   poll is on no home: the list is drawn from roster seats. The card comes and goes without a
   reload: the start and the end already hint `evaluations` on `classroom:<id>`, which every
   student of the classroom is subscribed to, and the hint refetches the home.

Rejected alternatives:

1. **A separate `owner_id` column.** It would always equal `created_by` on a classroom-less
   poll — nobody else can reach it, so nobody else can "run again" on it — and two columns that
   must agree are the double source of truth item 3 just removed. `created_by` gets the one
   thing it lacked, a constraint that it is present where it matters.
2. **A per-teacher "personal classroom"** to hold anonymous polls. It would put a fictional
   class in every course listing, roster count and SSE topic, and a class that nobody is
   enrolled in is exactly what an anonymous poll is not.
3. **Keeping the flag and forbidding the combination in the service.** The two stored facts
   could still disagree in a row written by any other path; the audience as a column that is
   there or not cannot.
4. **A 404 for an account off the roster.** Invariant 6 hides an entity a caller could not
   know about. This caller read the code off the wall; a 404 would tell them to check a code
   that is right.

## Addendum (2026-09-27): "From pools" — a poll borrows from any pool the teacher reaches

Issue #162. Until now a pool question reached the launcher only once it had run a poll
("Recent polls") or sat in the personal pool. The product owner settled the third way in: a
poll may run a published question of ANY pool the teacher can access, not only the pools linked
to the course of the classroom that answers. A poll is not graded and releases nothing (8), so
the rule that ties an evaluation's questions to its course (`addItems`) has nothing to protect
here.

1. **Access is the pool predicate, as it already was.** `POST /app/api/polls` loads the question
   through `findAccessibleQuestion` (`poolAccess`) and never checked the course; this addendum
   makes that the stated rule and a tested one (`pollPools.db.test.ts`): a question of a pool
   the classroom's course does not use is polled, one of a pool the caller cannot reach is the
   404 of a question that does not exist.
2. **One search, not two.** `GET /app/api/polls/pool-questions` (`PollPoolSearch` →
   `PollPoolPage` in `@quiz/contracts`) takes the parameters of `GET /pools/:id/questions`
   (`QuestionSearch` without the category and the deleted switch) and runs the same SQL filters
   (`filterWhere`, split out of `searchWhere` in the pool service) and the same keyset cursor
   (`pageWhere`), across every pool the caller reaches — published, live `mcq`/`short` only; a
   `type` outside those matches nothing. The launcher tab is the pool screen's own bar
   (`QuestionSearchBar`, the grammar of `searchSyntax.ts`), narrowed to the two poll types.
3. **The classroom narrows, it does not gate.** With `classroomId` the search keeps the pools
   linked to that classroom's course; the classroom is loaded through the staff predicate first
   (404 otherwise). The launcher offers it as a segmented control, "Classroom pools" (default) |
   "All pools", shown only when the audience is a classroom: an anonymous poll belongs to no
   course, so there is nothing to narrow to.
4. **What a row shows** is the statement through `toStudent` (as every poll payload), the pool's
   name, the published version a poll would freeze, and the tags. The page carries the scope's
   tags (the filters left out) for the sheet and the `tag:` completion, the way a pool's tags
   feed its own bar.

Rejected: restricting polls to the course's pools — a poll is often the question of a
colleague's pool or of last year's course, and nothing is graded; a second, client-side
fuzzy search over a prefetched list — the grammar would drift from the pool screen's, and a
teacher who reaches a few thousand questions would download them all.

## Addendum (2026-09-28): a poll left without answers for 12 hours ends on its own (#190)

Nothing ended a poll but its teacher's End, and a poll left running on a closed laptop stayed
`running` for good: its code stayed taken, it stayed "live" for every screen that lists live
sessions. The product owner accepted an automatic end after 12 hours without answers.

1. **The rule.** A poll ends when it is `running` and neither the poll nor any of its answers
   moved for `POLL_IDLE_MS` (12 h, `modules/poll/service.ts`): `evaluations.updated_at` is
   at most `now − 12 h`, and no `answers.updated_at` of its attempts is later than that.
   The poll's `updated_at` is its start (created and started in one call), every reveal
   step and every edit of the row (a rename through `PATCH` included), so a poll nobody
   answered counts from the last thing its teacher did; an answer
   counts from its server receipt time, a changed vote included. A join without an answer
   does not count: a QR scanned the next morning keeps nothing alive. Exactly 12 hours ends
   it; 11 h 59 does not.
2. **Why 12 hours.** It is the deploy guard's "left open, nobody is waiting on it"
   (`scripts/live-evaluations.sql`), for the same reason: a poll lasts minutes, a sitting in a
   room hours, so half a day of silence is a poll left open by mistake — and a teacher who
   polls the same room again next morning starts a new one anyway.
3. **The same end.** The pass calls `endPoll`, the path of the End button: the attempts are
   expired (`closed_by = server`), the state becomes `closed`, the grading pass is enqueued,
   the tally and state frames go out, and `poll.end` is audited with the system as actor and
   `{ reason: "idle" }` as payload. Nothing is released (8). The close is a compare-and-set
   (`tryCloseEvaluation`): a pass that loses the race to the teacher's End emits and audits
   nothing, and neither does an End that loses to the pass.
4. **The ticker closes (invariant 5).** A tick task, `poll.end_idle` (`modules/poll/jobs.ts`,
   part of `CORE_TASKS`), runs the pass once a minute: the condition is re-read every time, so
   a restart catches up and an ended poll no longer matches — a second pass does nothing.

Rejected: counting from the start alone — a long poll still being answered would end under
its teacher; counting joins as activity — the one phone that reloads the page keeps a
forgotten poll alive; a shorter threshold — a poll paused over lunch while the teacher
comments must not vanish.

## Addendum (2026-09-29): only End closes the vote; votes and reveal are independent switches

Incident of 2026-09-29, poll KUFE5R (classroom PythonGE2-A). The teacher pressed "Reveal
answer" at 08:30:57 on an opinion-like mcq. Eight students joined AFTER that moment: their
phones showed the results and "You did not answer this poll." with no Send button — the
participant page (`PollJoin`) replaced the question with the key once `revealed` — and they
read it as "not allowed". The server, meanwhile, still took answers: `answerPoll` checks
the deadline only. The screen had closed a vote the server had not. Decided by the product
owner the same day:

1. **Only End closes the vote.** While a poll runs, every phone keeps the question and its
   Send/Update button, whatever the wall shows. `answerPoll` is unchanged: it refuses only
   past the close (`410 attempt_closed`), as it always did.
2. **Votes: on the wall AND on the phones.** `settings.poll.votes` stays a switch, off by
   default. On, the live distribution reaches the phones too: `PollPublicView.tally` is
   non-null exactly while it is shown. This amends the "Wall only" point of the addendum of
   2026-09-27 (#157). The `poll.tally` frames stay staff-only (decision 9): a phone reads
   the tally through its 3 s refetch.
3. **Reveal: independent and reversible.** `settings.poll.revealed` shows the key and
   nothing else: it never closes the vote and no longer implies `votes`. The display has
   four states — nothing, votes only, key only, both — and a phone receives `tally` iff the
   votes are shown and `solution` iff the key is revealed. `POST …/poll/reveal` takes
   `{ revealed?, votes? }`, a switch omitted staying where it was and a body naming neither
   refused (`400 validation`). This supersedes "Three steps, one progression" of the
   addendum of 2026-09-27: `PollDisplay` and `pollDisplayOf` leave the contract, and every
   view carries the two switches as they are shown. Decision 7 stands: `feedbackPolicy.showKey`/`showExplanation` still
   move with `revealed`.
4. **No reveal without a key.** A question with no key (addendum 2026-09-23, 5) has no
   reveal switch on the projection, and the server refuses `revealed: true` for it with
   `422 poll_keyless`; `revealed: false` is always accepted. A row stored `revealed: true`
   on a keyless poll before this addendum is not migrated. It is normalised in ONE place,
   on the server at read time: `pollSettingsOf(scope)` gives `votes || (!keyed && revealed)`
   and `revealed && keyed`, every view and `setDisplay` read it, so no client knows the
   legacy shape and the first switch moved on such a poll writes the normalised pair. This amends the "Reveal" bullet of the addendum of
   2026-09-23, 5.
5. **Late answers count.** An answer given after the reveal counts like any other, in the
   tally and in "Recent polls" (`pollOutcome`). A keyed poll whose key was on the wall
   before the vote closed therefore flatters its correct rate. Accepted distortion; nothing
   is recorded to correct it.
6. **No verdict while the vote is open.** While the poll runs and the key is revealed, the
   phone shows the key UNDER the still-editable question and no personal verdict ("your
   answer — wrong"): a verdict beside a field the reader may still change is noise. The
   personal verdict, and "You did not answer this poll.", appear only after End, where the
   key replaces the question as before.
7. **The projection.** Its primary action while the poll runs is "End poll", with "N joined
   have not answered yet" beside it (`tally.joined − tally.answered`, no roster count). The
   two switches are secondary. `V` and `R` flip them independently; the arrow keys and Page
   Down / Page Up (a presentation remote) still walk hidden → votes → votes and key, and a
   keyless poll hidden → votes. The phase label has two values, Live and Poll ended: a
   reveal is no longer a phase.
8. **Load.** Each phone keeps its 3 s refetch. While the votes are shown, EVERY phone's
   refetch computes the tally (`tallyOf`), so a room of N phones costs N tally queries every
   3 s. No tally cache is added. Follow-up if a large room makes
   it a concern: cache the tally per evaluation for the refetch period, invalidated by the
   answer write.

Rejected: closing the vote on reveal (making the screen right and the server wrong) — the
product owner wants a latecomer to still answer, and the key on the wall is the teacher's
own call; keeping "reveal implies votes" — an opinion-like question then had no way to show
the key without the distribution, nor a keyed one the distribution on the phones without
the key.
