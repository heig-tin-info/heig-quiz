# ADR-045 — One code field for the student: the length tells the codes apart

## Status

Accepted (2026-09-30, decided by the teacher who owns the product: one
field, dispatched on the client by the length of the code, no resolver
route, exam access codes out of it). With `POLL_CODE_LENGTH` and
`JOIN_CODE_LENGTH` in `@quiz/contracts` (`codes.ts`), `codeTarget` in
`apps/web/src/student/enterCode.ts` and the field in
`apps/web/src/student/EnterCode.tsx`. No migration, no new route. Extends
F-ORG-06 and F-AUTH-05 (docs/spec/02) and ADR-014 §2.

## Context

A student meets two codes typed by hand:

- a **classroom's join code** (F-ORG-06): eight characters of a 31-letter
  alphabet, minted by `newJoinCode` in the `org` module, printed on a
  handout and kept for a semester. `POST /app/api/join/:code` puts the
  student on the roster, writes the `roster.join` audit entry and tells the
  staff;
- a **poll's session code** (ADR-014 §2, F-LIVE-13): six characters of a
  32-letter alphabet, drawn by `drawCode` in the `poll` module, read off a
  projector and alive for a lecture (plus two hours). It opens the poll's own
  page, `/p/:code`, which answers an unknown code and hops through the login
  when the poll wants a name (F-AUTH-05).

The home offered only the first, as a "Classroom code" card, while the
student's coach mark already said "Joining a poll? Type the code shown on the
screen" and pointed at it. A student with a poll code had nowhere to type it
but the address bar.

A third code exists: an **exam's access code** (`access_code` of an
evaluation), set by the teacher, of any length, typed on the exam's own page
after the student opened it from their home.

## Decision

1. **One field, "Enter a code", takes a classroom code or a poll code.** The
   input is normalised — spaces and hyphens removed, upper-cased — and
   nothing else: no correction of look-alike characters, since neither
   alphabet has any.

2. **The length separates the two namespaces.** Six characters is a poll,
   eight a classroom, any other length is refused on the spot with a message
   that says what the field takes. The two lengths are constants of
   `@quiz/contracts`, both server generators draw exactly them, and a test
   asserts they differ: **a poll code will never be eight characters long,
   and a join code never six.** Changing either length is a change to this
   ADR, not a tweak of a generator.

3. **The dispatch is on the client; there is no resolver route.** A six goes
   to `/p/:code` without a request; an eight goes to the existing
   `POST /app/api/join/:code`, unchanged. A route answering "which kind of
   code is this?" would be a silent enumeration oracle for classroom codes:
   `POST /join` is the only door that says whether one exists, and it writes
   and audits every success. The poll side needs no oracle either — its page
   already says "no poll with this code".

4. **An exam's access code is out of this field.** It unlocks one evaluation
   the student already sees on their home, it has no fixed length, and it is
   typed on that exam's page. The field's help and its refusals say so.

5. **Where the field lives.** On a home without any classroom it is the
   screen's one primary action, under the note that most classrooms enrol
   the student automatically by their e-mail address (check the edu-ID
   address). Once a classroom exists it leaves the page: the open
   evaluations' buttons are that screen's actions, and a code is
   administration. It is then reachable from the frame — a muted sidebar row
   (the phone's top bar on a phone, whose bottom bar leaves no drawer) and a
   palette command — which open the same component in a small dialog.

6. **For a real student only.** Not in a teacher's student view: a gesture of
   the frame must never write a roster (ADR-018, first addendum, rejected
   alternative 6), and `POST /join` would give the teacher an ordinary
   student seat. Never in the exam's own palette, which is a fixed list
   (W15). The public `/p/:code` page and its "no poll" screen are unchanged
   (anonymous participants, F-AUTH-05).

## Consequences

- One sentence to teach a student: "got a code? type it here". The coach
  mark points at the frame's entry, which is where the field stays once the
  home fills up.
- A mistyped length never reaches the server. A mistyped classroom code is
  a 404 like before, now shown under the field instead of in a toast.
- Two namespaces tied by one invariant: a future code (a drill session, a
  seat) that a student would type in this field must take a third length, or
  this ADR must be replaced by a resolver that does not leak.

## Rejected alternatives

1. **A resolver route (`GET /app/api/codes/:code`).** It would tell anyone
   with a session whether an eight-character string is a live classroom,
   without the audit entry `POST /join` writes. Rejected for that reason
   alone.
2. **Trying `POST /join` first, then the poll.** A poll code sent to `/join`
   is a wasted write attempt, and the order would decide the meaning of a
   code that happened to exist in both.
3. **Keeping two fields.** Two boxes for two strings the student cannot tell
   apart by looking at them.
4. **Folding exam access codes in.** They are per evaluation, of any length,
   and meaningful only on the page of the exam they unlock.
