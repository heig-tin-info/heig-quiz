# ADR-014 — Live polls: an evaluation of one question, a code, and participants without a roster

## Status

Accepted (2026-09-21, phase 2). Settles F-LIVE-13, F-LIVE-14 and F-AUTH-05, and lifts
decision D7 of `docs/PLAN-MVP.md` along one path only (below).

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
     only through `toStudent` (invariant 4).
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
  phones the results, so a wall-only step would say nothing more.
- *Server state.* `settings.poll.votes` (default `false`) sits beside `revealed` and moves
  through the same route, `POST …/poll/reveal { revealed, votes? }`; `votes` omitted leaves
  it where it was. A reload, or a second screen on the same poll, shows the same step.
- *Wall only.* `votes` never reaches a phone: `PollPublicView.tally` stays null until the
  reveal, and the `poll.tally` frames stay staff-only. Hidden, an mcq keeps its choices on
  the wall without bar or figure; a short-answer poll lists no answer.
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
