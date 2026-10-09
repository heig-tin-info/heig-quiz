# ADR-092 — Changing the mode of an evaluation: only the mode moves, until students are let in

## Status

Accepted (2026-10-09, product owner). No migration: `mode` is a text column.

Scope: the `mode` of an evaluation and of a template (`exam` or `exercise`),
the cutoff after which it freezes, what a change writes besides the mode, and
the controls that offer it.

Relations: amends F-EVAL-01, F-EVAL-24 and F-EVAL-25 (the mode was set at
creation only); respects [ADR-086](ADR-086-planifiee-ou-en-direct.md) (presets
stay off step 2), [ADR-088](ADR-088-journal-d-integrite.md) §2 (`logVisibility`
stays as stored), [ADR-041](ADR-041-entrainement-espace.md) §2 (`allowDrill`
stays as stored), [ADR-031](ADR-031-modeles-d-evaluation.md) (the revision),
[ADR-030](ADR-030-canaux-de-notification.md) (the announcement of a scheduled
exercise) and [ADR-074](ADR-074-carnet-de-notes-marques-stockees.md).

## Context

The mode was chosen once, in the creation dialog, and then immutable
(`mode` absent from `EvaluationPatch` and from the strict `TemplatePatch`). A
teacher who decides at the last minute that a graded quiz is a practice
exercise, or the reverse, had to rebuild the evaluation. The mode is not a
mere label: it names the preset a creation applies, and it gates settings
(retakes are an exercise's, `immediate` feedback is refused in class) and
what a student sees.

## Decision

1. **Only the mode changes.** `PATCH /evaluations/:id` and
   `PATCH /templates/:id` accept `mode` (`exam` or `exercise`; `poll` is
   never a target and a poll is never changed). No preset is reapplied.
   The consequences written with it are the forced ones, and nothing else:
   - Going where `immediate` feedback is refused (an exam, or an exercise given a waiting room;
     `feedbackWhenFor`), `feedbackPolicy.when` becomes `on_release`, unless
     the same patch chose a policy itself (which is then validated against the
     new mode). `immediate`, `showKey` and `showExplanation` are never turned
     on by a change of mode: an exercise sat in class would otherwise hand the
     key to the first student who hands in. The screen says so when the
     fallback happens.
   - Every mode-gated setting is validated against the NEW mode in the same
     write (`MODE_SETTINGS`): an exercise with retakes on cannot become an
     exam (`422 retakes_not_allowed`); the teacher turns them off first.
   - `logVisibility` stays as stored (ADR-088 §2). SEB and kiosk stay stored,
     inert outside an exam (`trustedClientsOf`).
   - `allowDrill` is FROZEN at the value the old mode gave it when nothing
     was stored (`drillAllowedOn` falls back to the mode's default), so that a
     change of mode does not silently flip the drill.
2. **Cutoff.** The mode changes while the evaluation is `draft` or
   `scheduled` and nobody has an attempt, the teacher's own included
   (`modeChangeable`, `@quiz/domain`). Otherwise `409 mode_frozen`. Sending
   the mode the row already has is no change. A template (never run) may
   always change; the change moves its revision like any content edit
   (F-EVAL-25); its instances keep their own mode, and a pull (F-EVAL-26)
   copies the questions only, so it never carries the mode.
3. **Scheduled.** Students already see the card with its mode. A scheduled
   exam turned exercise tells the class as the move to `scheduled` would
   have, once (the `scheduled_announced_at` marker claims it); an exercise
   turned exam sends nothing. The clock fields are never touched, and
   `assertStaysScheduled` still holds: an exam must end by itself, so a
   scheduled evaluation whose timing an exam would leave incomplete is
   refused. The screen asks for a confirmation in this state.
4. **Gradebook** ([ADR-074](ADR-074-carnet-de-notes-marques-stockees.md)). A stored column keeps its
   `counts`; an unstored one takes the default of its new kind.
5. **Audit.** `evaluation.update` and `template.update` carry
   `{ mode: { from, to } }` beside `fields` when the mode changes. No new
   union member.
6. **Screens.** The creation dialogs keep the mode choice for a blank
   evaluation or template. Started from a template, the dialog shows the
   template's mode, read-only, and says it can be changed afterwards. In the
   configuration the header badge becomes a segmented control while the mode
   can change (always for a template), with the Exam option disabled while
   retakes are on. The MCP `update_evaluation` tool takes `mode` under the
   same server rules.

## Consequences

- A last-minute change costs one click instead of a rebuilt evaluation, and
  cannot open a correction nobody chose to open.
- The settings left behind can look odd in the new mode (an exercise that
  keeps an exam's duration and silent feedback): this is deliberate, they are
  the teacher's stored choices and stay editable.
- Freezing `allowDrill` writes a setting that was absent; it appears in the
  template's content comparison, which the mode change moves anyway.
- One more refusal code (`mode_frozen`) for clients to word.

## Alternatives considered

- **Reapply the target mode's preset field by field.** Rejected: it
  contradicts ADR-086, cannot know which fields the teacher left untouched,
  and could turn on the key or immediate feedback of a class sitting together.
- **Remove the mode from the creation dialogs** and make it a configuration
  setting only. Rejected: the mode names the preset a blank creation applies;
  a teacher chooses it first.
- **Allow the change after attempts exist or from the lobby on.** Rejected:
  students would be sitting under rules other than the ones they were
  announced, and attempts already stored under the old mode would be
  reinterpreted.
