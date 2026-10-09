# ADR-082 — The AI card of the question editor

## Status

Accepted (2026-10-08, decisions of the product owner on issue #556).

Scope: where the LLM actions of one question live in the question editor,
and what the editor shows of a review.

Relations: amends [ADR-059](ADR-059-generer-la-reponse.md) §6 (the place of
"Generate answers") and [ADR-060](ADR-060-revue-llm-des-questions.md) §1
(the place of "Review now"). What the two actions do is unchanged.

## Context

"Generate answers" (ADR-059) was a secondary button above the type's form:
it broke the alignment of the form and was offered before the statement was
written, though the server refuses it then (`statement_empty`). "Review now"
(ADR-060) was an entry of the header's `…` menu, where a teacher did not
find it. Both are the same family — the AI acts on this question at the
teacher's call — and had no common place.

## Decision

1. **One card.** The LLM actions of a question are grouped in one "AI" card
   (`apps/web/src/question/AiCard.tsx`), first in the editor's aside, above
   "Properties". On a narrow screen the aside follows the explanation, and
   the card with it. "Review now" leaves the `…` menu: one place per
   action. The per-element wand of a type's editor (`onGenerateItem`) stays
   in the form, beside the element it fills.
2. **Absent, not disabled.** The card is not drawn for a reader, without a
   model, or when the type has no generator and no review applies (not
   published, or a type in `UNREVIEWED_TYPES`). Publish stays the screen's
   one primary action: every button of the card is `secondary`.
3. **The statement first.** "Generate answers" is offered once the statement
   is written; until then the card says why, in one line, instead of a
   disabled button. The client reads the statement as `config.prompt`,
   trimmed, a missing or non-string value counting as empty (drafts are
   unvalidated, D16) — the rule the server applies through each generator's
   `statement`. `packages/registry/src/server.test.ts` checks, for every
   registration with a generator, that `statement` reads `config.prompt`,
   so a type that keeps its statement elsewhere fails there. The
   per-element wand follows the same rule. Undo and the `incomplete` notice
   of a proposal are in the card.
4. **The review, read-only.** The card shows the review of the latest
   published version as the pool's pill reads it (`reviewPill`): one line
   for `clean` or `ignored`, one line for `failed` ("Review now" is the
   retry), the findings listed for `findings` — severity, field, message,
   the proposed fix as text — with the version, the time, and a link to the
   pool's "LLM review" tab. Fix and Ignore stay in that tab: their routes
   write the server's draft, which would race the editor's autosave. After
   "Review now" the card shows the call's result at once, with no toast.
5. **Later actions** of the same family (a concept suggestion, ADR-081 §7, #557) land in the same
   card.

## Consequences

- One place to discover what the AI can do for a question; the form keeps
  its alignment.
- The teacher fixes a finding from the pool's tab, or edits the field in
  the editor by hand; fixing from the editor needs its own design (the
  draft held by the editor versus the draft the fix route writes).
- The registry test makes the client's emptiness rule a checked convention
  rather than a copy.

## Alternatives considered

- **Keep "Review now" in the menu as well.** Two places for one action; the
  menu entry was the one nobody found.
- **A disabled "Generate answers" with a tooltip.** A mute disabled button
  explains nothing on a touch screen; one line does.
- **Fix and Ignore in the card.** See §4: the fix route writes the server's
  draft while the editor holds its own.
- **An endpoint that tells the client whether the statement is empty.** A
  round trip per keystroke for a rule the registry test pins.
