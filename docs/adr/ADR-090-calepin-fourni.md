# ADR-090 — A notepad provided on the student's screen

## Status

Accepted (2026-10-09; asked by the product owner, who settled in
conversation every rule below: the three modes, the device-only storage and
its purges, the flush at a checkpoint, the blocked clipboard and the paste
exemption). Implemented by `notepadOn` (`packages/domain/src/evaluationConfig.ts`),
`furthestCheckpoint` (`packages/domain/src/questionProgress.ts`),
`settings.notepad` (`packages/contracts/src/evaluation.ts`) and
`apps/web/src/notepad/`. Requirement F-EVAL-35.

Scope: a scratch notepad in the player of an exam or an exercise.

Relations: the sibling of [ADR-069](ADR-069-calculatrice-fournie.md) (the
calculator provided), whose setting, refusal and dock it mirrors; adds two
imposed lines to [ADR-079](ADR-079-conditions-de-l-evaluation.md)'s
conditions; §6 is the notepad's half of the paste step of
[ADR-088](ADR-088-journal-d-integrite.md).

## Context

A student working an exam on screen needs somewhere to write down an
intermediate result, a plan or a reminder. Paper is not always on the desk,
and on a kiosk station or in Safe Exam Browser no other application is
reachable. The product owner asked for a notepad in the player, next to the
calculator, under the French name "Calepin".

Three facts constrain it:

- Quiz grades answers, not scratch work: the notes are the student's, and
  the teacher has no use for them. Sending them would create personal data
  with no purpose (N-DATA).
- Under `milestones` navigation a checkpoint closes every question before it
  (F-EVAL-07). Notes carried past it would hold the work of a closed section.
- The integrity journal (ADR-088) will record a paste from outside the page;
  a copy from the notepad into an answer is not from outside.

## Decision

1. **A setting of the evaluation**, `settings.notepad`: `none`, `provided`
   or `provided_no_clipboard`. Absent is `none`; read through
   `notepadOn(mode, setting)`, never raw. It sits in the settings JSON, so it
   needs no migration; it is frozen with the settings, carried by a duplicate
   and a template, and kept by a pull — exactly as the calculator. A poll has
   nothing to work out: the server refuses the setting there
   (`422 notepad_not_allowed`) and reads it as `none`. The teacher chooses it
   under the advanced options, beside "Calculator provided".
2. **The conditions** (ADR-079): after the calculator's line, "Notepad
   provided (kept on this device until you hand in)" and, for
   `provided_no_clipboard` only, "Copy and paste are disabled in the
   notepad", both of kind *provided*. The second line states only what is
   enforced: inside the notepad. The answer fields keep their clipboard.
3. **On screen**: plain text, no markdown, no toolbar, nothing rendered; a
   monospace page ruled like a pad. Up to 20 pages of 10 000 characters, a
   new page, previous and next, "Page x of y", delete with an Undo toast
   instead of a confirmation, and always at least one page. With the
   calculator, the two buttons stack at the bottom right and one panel
   shows at a time, each keeping its state (`ToolDock`'s `slot` and
   controlled `open`). Hidden under the pause overlay, like the calculator.
4. **Stored on the device only.** `localStorage`, one key per attempt
   (`quiz.notepad.<attemptId>`): the pages, the page on screen, the
   checkpoint they were written under and the time. No request, no attempt
   event, no audit entry: nothing of it reaches the server, and a student who
   changes device loses it. A write the browser refuses is said in the panel,
   never lost in silence. The notes are deleted at every end of the attempt
   the client sees (submitted, deadline, evaluation closed), at sign-out, when
   a kiosk station (`/kiosk`) or the pairing page (`/pair`) loads (every
   notepad), and, when a player loads, those untouched for 24 hours — never
   another recent attempt's, which may be open in another tab. The teacher's
   preview and an impersonation session (ADR-034) keep the notepad in memory
   only. Whether Safe Exam Browser and a kiosk station keep `localStorage`
   across a reload was not verified on real clients; the client purges
   itself, so the rule holds either way.
5. **Emptied at a checkpoint** (`milestones` only; not `forward_only`, not
   `free`). `furthestCheckpoint` gives the rank of the furthest validated
   milestone in the student's order; the notes record it, and notes written
   under an earlier one are dropped — on load, before every write and as soon
   as the attempt moves on. A second tab follows through the `storage` event.
   The checkpoint's confirmation says "The notepad is emptied too." This is
   pedagogical, not a security control: a student can copy the notes
   elsewhere before crossing.
6. **The clipboard.** In `provided_no_clipboard`, the notepad's field refuses
   copy, cut, paste, drag and drop, and the `beforeinput` of a paste, a drop or
   a cut. Otherwise, the last text copied or cut out of the notepad is kept in
   memory (`apps/web/src/notepad/clipboard.ts`, `isFromNotepad`), never
   persisted nor sent. It is the exemption ADR-088's paste step will read: a
   paste into an answer is exempt only when its text equals that last copy;
   a paste INTO the notepad from outside is journaled like any outside paste.
   This record does not detect pastes; that step ships separately.

## Consequences

- One more key in the settings, two imposed lines, a domain rule
  (`furthestCheckpoint`, which `lockedItems` now shares) and a small web
  module (`notepad/`: the store, the hook, the dock, the clipboard record).
- `ToolDock` gains a `slot` and a controlled `open`; `--tool-dock-h` grows
  to 7.5 rem while two docks stand, so the toasts and the panels clear both.
- The teacher sees nothing of the notes, by design.
- A device switch, a cleared browser or a refused write loses the notes; the
  conditions say "kept on this device".

## Alternatives considered

- **Saving the notes on the server.** Survives a device switch, but creates
  data with no grading purpose, a new route and a retention rule. Refused.
- **A markdown or rich-text notepad.** A toolbar and a renderer for scratch
  work; plain text is what a pad is.
- **A confirmation before deleting a page.** An Undo toast costs the student
  nothing when they meant it.
- **Blocking the clipboard everywhere in the player.** It would break the
  answer fields and state a restriction the portal cannot enforce against
  other applications. Only the notepad's own field is blocked.
- **Flushing in `forward_only` too.** Every question is a step there; the
  notes would be gone after each one, which makes them useless.
