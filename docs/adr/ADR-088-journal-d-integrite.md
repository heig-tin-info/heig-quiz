# ADR-088 — The exam integrity journal: leaving the page and pasting from outside, recorded lightly, never proof

## Status

Accepted (2026-10-09, decided by the product owner). Migration
`0094_integrity_journal_off_purge`.

Scope: the attempt journal's student-behaviour kinds (`INTEGRITY_EVENT_KINDS`,
`packages/contracts/src/live.ts`), the `logVisibility` setting and its default
(`logVisibilityDefault`, `integrityJournalOn`, `@quiz/domain`), what
`POST /app/api/attempts/:id/events` stores (`storesIntegrityEvent`,
`apps/api/src/modules/live/integrity.ts`), the journal's retention (the
release, the `integrity.purge` scheduled task), the player's signals and toast
(`apps/web/src/attempt/signals.ts`), and the teacher's list.

Relations: amends F-EVAL-13, F-EVAL-33 (the platform's line), N-SEC-10,
N-DATA-02, N-DATA-03 and N-DATA-07; refines [ADR-079](ADR-079-conditions-de-l-evaluation.md)
§2 (a poll never shows the derived line `visibility_logged`, which names
pasting once the paste step ships); relies on
[ADR-034](ADR-034-agir-en-tant-qu-etudiant.md) (delegated sessions) and
[ADR-051](ADR-051-postes-kiosque-attestes.md) (confined sessions).

## Context

F-EVAL-13 and N-SEC-10 already journal tab visibility and window focus during
an attempt: the player posts `visibility` and `focus` to
`POST /attempts/:id/events`, the server writes them to `attempt_events`, and
the teacher reads them in the attempt inspector. Three gaps:

- the server stored those events whatever `logVisibility` said; the switch
  only drove the condition line the student reads;
- the most common shortcut in a written exam — pasting a text prepared
  elsewhere — is not seen at all;
- the journal was kept as long as the evaluation, although it only serves the
  correction, and N-DATA-03 said nothing about it.

The product owner asked (2026-10-09) for a light detection of focus loss and
of pasting from outside the page, a toast telling the student it is recorded,
and a discreet list for the teacher (name, time, kind), never blocking and
never presented as proof.

## Decision

1. **Not proof, by construction.** The journal is a hint for the teacher's
   attention, never evidence. Its limits are stated wherever a teacher reads
   it: the listeners run in the student's browser and can be disabled, so the
   absence of an event proves nothing; a paste inside an embedded frame (a
   question type's own iframe) is not seen; copying from another Quiz tab looks
   external, since the copy fingerprint is per tab. Nothing is ever blocked,
   and no grade rule reads the journal.

2. **One setting, a default by mode.** `logVisibility` (the field keeps its
   name) covers leaving the page AND pasting from outside it. At creation it
   is on for an `exam` and off for an `exercise`, where the teacher may switch
   it on (`logVisibilityDefault`, applied once in `createEvaluation`, whatever
   the preset); a copy (duplicate, template, instance) keeps the source's
   value, and an evaluation already stored keeps its own. A `poll` never
   journals, whatever its row says (`integrityJournalOn`).

3. **The server honours it.** An event of an integrity kind is stored only
   while the evaluation keeps the journal and the session is the student's
   own. Otherwise it is answered `204` like a stored one, and dropped: never
   from a delegated session (impersonation, ADR-034, which is read-only in
   production anyway). The teacher's preview is stateless and has no attempt
   to write to. Under a confined session (`seb`, `kiosk`, ADR-051) the player
   journals and the server stores exactly as in the portal — the conditions
   line announces the journal there too, so it must stay true; only the
   student's toast is suppressed there (§6), since leaving the page is barely
   possible and a toast would be noise. `reconnect` is not an integrity kind and keeps its
   behaviour (stored, and a sign of presence). The one-off migration deletes
   the `visibility` and `focus` rows already stored for an evaluation whose
   switch is off, and for a poll.

4. **Pasting: a length and a flag, never the content.** A paste event
   (`paste`, PR 3) carries `{ length, afterFocusLoss }`: the number of
   characters, and whether the page had lost focus just before.
   `afterFocusLoss` is computed by the SERVER from the previous event of the
   attempt, never sent by the client. A paste whose text was copied from the
   same tab (its fingerprint known to the player) is not reported. The pasted
   text is never sent nor stored.

5. **The client filters its own noise.** An absence shorter than one second
   is dropped, and a blur into an in-page iframe (a question's own editor) is
   not a focus loss. The durations the teacher reads are derived by the server
   from consecutive events, indicative only, and capped at the attempt's end.

6. **The toast.** When the student comes back to the page, or pastes from
   outside, a toast says: "This event is recorded and visible to your
   teacher." At most one per kind every five minutes, shown on focus return,
   never during the absence, and never under a `seb` or `kiosk` session.
   The conditions line `visibility_logged` reads "Leaving the page is
   recorded" until the paste step (§9, PR 3) ships; that step changes it to
   "Leaving the page and pasting from outside are recorded". No text a
   student or an administrator reads announces pasting before then.

7. **The teacher's view.** A discreet list in the attempt inspector and the
   dashboard: student, time, kind, the paste's length and flag. The live badge
   travels on staff topics only. There is **no student view of the journal**:
   the student knows the rule (the condition line, the toast), not the record.

8. **Retention.** The integrity rows (`INTEGRITY_EVENT_KINDS`: `visibility`,
   `focus`, and `paste` from PR 3) are deleted at the release of the grades,
   in the release's transaction (`releaseResults`), their count recorded in
   the release's audit entry (`journalPurged`); a re-release finds nothing
   left. An evaluation never released loses them six months after it closed
   (the daily `integrity.purge` scheduled task). No other kind is touched:
   `run` carries the Run rate limit, and `reconnect`, `ip_change`,
   `time_added`, `paused` and `resumed` are the sitting's own history.

9. **Delivery in four pull requests.** (1) the server: the setting honoured,
   the default by mode, the migration, the retention, this record and the
   spec; (2) the player: the signals' filtering and the toast; (3) the `paste`
   kind, its server-side flag and the client's fingerprint; (4) the teacher's
   list and live badge.

## Consequences

- An exercise created from now on records nothing unless its teacher asks;
  the exams' behaviour is unchanged.
- A teacher who reads the journal after the release finds it empty: the
  release is the end of the correction. A grade dispute after the release
  cannot rest on it — which it never could, since it is not proof.
- The admin's task list gains `integrity.purge`.
- Adding `paste` is a one-line change to `INTEGRITY_EVENT_KINDS`: the storage
  rule, the release purge, the backstop and the inspector follow it.

## Alternatives considered

- **Blocking or warning before leaving.** Refused: an exam must never stop a
  student, and a browser cannot forbid another window anyway; only a trusted
  client can (ADR-051).
- **Storing the pasted text, or a hash of it.** Refused: it is the student's
  data with no use the length does not serve, and a hash of a short text
  reveals it.
- **A separate switch for pasting.** Refused: two switches for one idea —
  "your behaviour on the page is recorded" — would need two condition lines
  and two defaults for no teacher need.
- **Keeping the journal as long as the evaluation.** Refused: it serves the
  correction only, and a hint kept for years starts to read like a record.
- **Refusing the events with a 4xx when the switch is off.** Refused: the
  client would have to know the setting to stay quiet, and a refusal storm is
  what the route was designed never to cause.
