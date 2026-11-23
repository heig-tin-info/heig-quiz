# ADR-143 — Sections: a text that applies to the following questions

## Status

Accepted (2026-11-23, product owner, who settled the six points below before
the build). Amends [ADR-084](ADR-084-texte-avant-un-item.md) §6 (where a
text shows) and §7 (shuffled items carry their intro), and F-EVAL-34,
F-EVAL-26 and the settled question no. 55.

Scope: the column `evaluation_items.intro_scope` (migration
`0158_item_intro_scope`), `ItemPatch.introScope`, the student's item order
(`orderItems`), `AttemptItem.section` and `AttemptItem.sectionIntro`, the removal of
an item, the template's revision and pull summary, the builder's band and
editor, the player's passage and question list.

Relations: extends ADR-084 (the intro of an item); reads F-EVAL-09 (the
student's order from the attempt seed) and ADR-125 §8 (a paper's order from
its seed), and changes neither when no section exists.

## Context

ADR-084 gave an item a text shown before it. A teacher writing "Part 2: the
next questions are about the listing below" wants the text to belong to the
questions that follow, not to one question: under `shuffleItems`, a text
travelling with its item lands in the middle of what it introduces, or
before a question of part 1. And a student who jumps to the third question
of the part never reads it.

## Decision

1. **A scope on the text.** `intro_scope` is `item` (the text precedes its
   own item, as ADR-084 has it; the default, and every existing row) or
   `following`. It is NOT NULL, and a check holds `intro_scope = 'item' or
   intro is not null`: only a text has a scope. Written through the item
   routes (`introScope`), refused on an item without a text (`422
   intro_scope_without_text`); writing `intro: null` resets it to `item`.
   It is frozen with the item list, part of the template's content, carried
   by every copy, and a change of it alone makes a pull's item `changed`.
2. **One definition of a section.** A `following` text opens a section from
   its item up to, and excluding, the next item whose text is `following`,
   or to the end. An `item` text inside a section is a passage within it and
   does not end it. The items before the first `following` text form a
   leading run, which is no section. One pure module,
   `packages/domain/src/sections.ts`, holds it for the API and the web app.
3. **The order.** Without `shuffleItems`, the canonical order. With it, the
   sections keep their authored order and the items are shuffled inside
   each segment (the leading run included). An `item` text and a milestone
   travel with their item; `lockedItems` is unchanged. One random stream,
   `streamSeed(seed, evaluationId, "items")`, is consumed segment after
   segment. With no `following` text the list is one segment and the order
   is exactly the one drawn before sections, which live attempts, the
   autosave, a regrade's ranks and a reprinted paper recompute: a golden
   test pins it.
4. **Where a section's text shows.** The server computes it, with the same
   module, in the student's order. `AttemptItem.intro` stays the item's own
   text, exactly as ADR-084 has it; the section's text travels apart, as
   `AttemptItem.sectionIntro`, on the FIRST item of its section in that
   order, so it is never read mid-section. The two never merge: an item
   drawn first with a text of its own carries both, each read on its own.
   `AttemptItem.section` names the section of each item (the id of the item
   opening it), or null. The attempt, its restore, the teacher's preview and
   the paper hand-out (which prints the section's text once, at its head,
   then the item's own) all come through `attemptItems`. Results, feedback
   and the drill carry none of the three.
5. **The player.** A section's text shows on the first arrival at ANY
   question of the section — a student jumping straight to its third
   question reads it first — and counts as passed after Continue, or once
   any question of the section is started (on load too). The player holds
   it by its section's id, apart from every item's own text, which still
   shows on arriving at its item until passed. Under `free`
   navigation its entry rereads it from any question of the section, and
   Continue leads back to that question; under `forward_only` and
   `milestones` it is one way, as ADR-084 §6 has it. In a partial retake
   (ADR-091) a question carried over does not count as started for this
   rule: the text shows when one question of the section is retaken. The
   standing question list sets a section's entries slightly in under its
   text's entry; the numbering and the phone's strip are unchanged.
6. **The builder.** The text's editor has a switch, "Also applies to the
   following questions, until the next shared text", off for a new text. A
   shared text's band names its span ("Shared text, questions 5 to 7") and
   a discreet rule runs beside the rows it covers. A drag moves a text with
   its item, as a milestone: nothing is re-anchored. Removing the item that
   opens a section moves its text to the next item when that item is in the
   section and has no text; otherwise the text goes with the item, and when
   other questions lose it a confirmation names them and where they go
   (under the shared text above, or under none). A one-question section is
   removed like an item with its own text. The move, the removal and the
   renumbering are one transaction under the evaluation's (or the
   template's) row lock, which also re-reads the gate. Removing a shared
   text, or turning the switch off, asks nothing more than removing any
   text does: the switch is reversible and the band shows its effect.

## Consequences

- One column, one optional field of the patch, one field of the attempt's
  item; no change to grading, results, statistics or the drill.
- The order of every existing attempt and paper is unchanged: no section
  exists until a teacher turns the switch on.
- A section's text can be met mid-attempt on any of its questions; the
  "passed" fact stays the player's, never stored (ADR-084's limit).
- The MCP item tools describe `introScope`, which they take from
  `ItemPatch`.

## Alternatives considered

- **Re-anchoring a section's text on reorder** (the text stays at a
  position): rejected by the product owner. A drag moving the text it does
  not touch surprises the teacher; the item is the anchor, as for a
  milestone.
- **Sections as a separate list on the evaluation**: rejected for the same
  reason ADR-084 rejected it, an anchor that must survive reorders,
  removals, copies and pulls, which the item already is.
- **Pinning the section's text to the item that opens it under shuffle**:
  the text would show mid-section for most students.
- **Merging the section's text with the own text of the item drawn first**
  (one `intro`): a student jumping to another question of the section
  would read that item's own text out of place, and never again before
  its question.
