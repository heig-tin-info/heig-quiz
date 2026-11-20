# ADR-138 — Cloze labels: the dropdown blanks shown as labels dragged into the text

## Status

Proposed (2026-11-20). The presentation, the reusable labels, the tray
pinned above the text and the paper unchanged are the product owner's
(issue #1173, 2026-11-20, after trying `mockups/cloze-labels.html`); the
field, the derived groups and their cap, and the publication rules are the
implementer's, within them.

Scope: how a `cloze` question shows its dropdown blanks to a student.

Relations: extends [docs/04 §4.6](../spec/04-types-de-questions.md#46-fill-in-the-blanks-cloze);
keeps the answer of D4 and [ADR-097](ADR-097-reponse-transmise-et-reponse-stockee.md),
the acceptance of [ADR-128](ADR-128-accepter-une-reponse-a-la-correction.md)
and the parameter rules of [ADR-056](ADR-056-questions-parametrees.md) §10.

## Context

Moodle's "drag and drop into text" has the student drag words from a bank
into the gaps of a text. Teachers asked for it. A cloze dropdown already
holds everything such a gap needs: its options and, on the server, the
right ones. A new question type would duplicate the grammar, the grading,
the statistics, the acceptance at grading time and the paper export of
`cloze` for a difference that is only how the choices are shown.

## Decision

1. **A presentation, nothing more.** `ClozeConfigSchema` gains
   `presentation: "dropdown" | "labels"`, optional. In `labels`, each
   dropdown blank is a gap and its options are labels in a tray above the
   text; text, number and regex blanks stay fields. The `{{…}}` grammar,
   the answer, the grading, the statistics, the review, the key, the
   grading table and the paper export do not change: a dropped label
   stores exactly what picking it in the dropdown stores.
2. **Optional, never defaulted, no version bump.** An absent field means
   dropdowns, and the schema writes no default: a question saved again
   keeps its stored JSON byte for byte (the drill keys a parameterized
   question on a hash of its raw template, and the raw reads apply no
   default). The editor writes `"labels"` or removes the key. The config
   stays at version 2, so a rollback still reads every stored config
   (`versionedMigrate` throws on a version it does not know); the old code
   strips the unknown key and shows dropdowns. The canonical YAML writes the
   field only when it is `labels`.
3. **Groups are derived, never declared.** Dropdown blanks offering the same
   SET of labels, order ignored, form a group (`clozeLabelGroups`,
   `@quiz/domain/cloze`), in order of first appearance; a gap takes only a
   label of its group. One group is neutral; several get one hue and one
   shape each, colour never the only cue. At most
   `CLOZE_MAX_LABEL_GROUPS` = 6, the hues and shapes the design system
   defines.
4. **Nothing new leaves the server** (invariant 4). `toStudent` adds
   `presentation: "labels"` and nothing else. The browser builds the tray
   from the options already served: a group's labels in the served order of
   its FIRST blank, and a drop looks its label up by text in the gap's own
   options and sends that option's `id`. So the tray shows one blank's
   shuffled order while every gap still sends a position in its own, unseen
   order: ADR-097 holds in substance, no canonical index reaches the
   student. With shuffling off, the tray is the teacher's order — the same
   bias a dropdown has.
5. **Publication** refuses, in labels mode only: a text with no dropdown
   (`cloze.labels_no_dropdown`); two options of one blank with the same
   text (`cloze.labels_duplicate_option`), which a tray cannot tell apart;
   more than six groups (`cloze.labels_too_many_groups`); and, in a
   parameterized question, a `[[…]]` reference inside a dropdown option
   (`cloze.computed_label`): two options could render alike on some draws,
   and a label is looked up by its text. A number blank stays
   parameterizable.
6. **Labels are reusable.** A placed label stays in the tray. A "each label
   once" switch, a "same choices as blank N" helper in the editor, a word
   bank on paper and a student switch back to dropdowns are not part of
   this decision.
7. **Gestures.** Click a label, then a gap of its group — Enter or Space
   likewise, the one keyboard path; Escape lets go; a filled gap activated
   with nothing selected empties. On top, a drag with dnd-kit's pointer
   sensor, never a native HTML5 drag, so the integrity journal of ADR-088
   records none. With several groups a gap's name says its group, and while
   a label is selected the gaps of the other groups are `aria-disabled`.
   Every gap of a group is as wide as its widest label, so a width never
   hints at the answer.

## Consequences

- One field, one function in the domain, one player branch; no migration.
- Switching a PARAMETERIZED cloze to labels changes its raw template, so its
  hash, so its drill card starts again. Accepted: it is a change the
  teacher makes on purpose, and the hash is what tells a changed question.
- A teacher who wants two blanks in one group writes the same options in
  both; a typo splits the group, which the editor's Group column shows.
- The tray is pinned under the host's sticky bars through the generic
  `--sticky-top` of `apps/web/src/style.css`, capped at a third of the
  window and not pinned on a low one (N-A11Y-04).
- **Known limit.** A text variable used outside any blank can expand into a
  whole dropdown (`w = choice(["{{=a|a|b}}", …])`): `cloze.computed_label`
  reads the template's blanks and does not see it, so only the draws of the
  publication gate catch a repeated option. The hole predates this decision
  (dropdowns and regex keys have it too). `distinctTexts` is not the fix: one
  flat list would refuse two blanks sharing their labels, which is what a
  group is.

## Alternatives considered

- **A new question type.** Rejected: everything but the presentation would
  be a copy of `cloze`.
- **Choice sets declared once and referenced by the blanks.** Rejected: a
  grammar change, and the predefined choice sets were removed before they
  shipped (`schema.ts`).
- **`presentation` with a `.default("dropdown")`.** Rejected: every save
  would write the key into configs that never had it.
- **The tray in its own random order.** Rejected: a new RNG stream for no
  gain; the first blank's served order is already per student.
