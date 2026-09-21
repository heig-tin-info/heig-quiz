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
