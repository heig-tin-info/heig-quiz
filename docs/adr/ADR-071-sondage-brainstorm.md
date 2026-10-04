# ADR-071 — The brainstorm poll: short ideas, a bubble cloud, moderated by the teacher

## Status

Proposed (2026-10-04), issue #458. The product owner chose the v1 scope
(no LLM), the model (a new keyless type) and where moderation happens (a
separate teacher view) on 2026-10-04.

Scope: a third question type for live polls, and what of its answers reaches
the room.

Relations: amends [ADR-014](ADR-014-sondages-en-direct.md) (the poll types,
the display switches and the tally); depends on F-LIVE-13, F-LIVE-14 and
F-AUTH-05. The LLM clustering of the issue is out of scope: it contradicts
F-LLM-03 (no model call while an evaluation runs) and needs its own record.

## Context

A poll asks closed questions (`mcq`) or one short answer (`short`). Issue #458
asks for Mentimeter-style open polls: each participant types several short
ideas, and the wall shows a bubble per idea that grows with the number of
participants who proposed it. Anonymous guests and a projector also mean that
one day a slur reaches the wall, so the teacher must be able to keep an idea
off it before anyone sees it.

## Decision

1. **A new type, `brainstorm`** (`packages/qt-brainstorm`). Its config is a
   prompt and `maxIdeas` (1–10, default 5). Its answer is `{ ideas: string[] }`,
   each idea 1–60 characters. It has no key: `hasKey` is always false, so an
   exam, an exercise or a template refuses it through the existing
   `422 question_keyless`, and it is a poll's alone. Its `toStudent` is the
   prompt and `maxIdeas`. The registry's leak test covers it with one narrow
   exception: a type with no key has no secret value to plant in its fixture,
   so the test proves instead that `toSolution` is null and that serving the
   whole config would be caught by a forbidden key.
2. **One idea is one normalised text** (`ideaKey`, `@quiz/domain`): case,
   accents, punctuation and spacing are folded, and a leading French or
   English article is dropped. There is no edit distance: a false merge on the
   wall is worse than two bubbles the teacher merges by hand. A participant
   counts once per idea and once per cluster.
3. **The teacher's word is a mark per idea**, in `poll_idea_marks` (owned by
   the `poll` module), keyed by evaluation and idea key, never by attempt. A
   mark is a status (approved, hidden, or none), the idea it was merged into,
   and a label for the cluster it heads. The marks follow the text, so editing
   an answer keeps the decision on the ideas that remain. "Run again" starts
   with no marks.
4. **Moderation** is a third display switch (`settings.poll.moderation`,
   `PollRevealBody.moderation`), for a brainstorm only. It defaults to ON for
   an anonymous poll and OFF for a classroom's. With it on, only approved ideas
   are visible; with it off, every idea that is not hidden is. A hidden idea is
   never visible.
5. **What the room reads is the cloud, never the board.** `PollTally.ideas`
   holds one bubble per cluster with at least one visible idea. Its label is
   the teacher's name, or the most frequent VISIBLE spelling. Its key is the
   smallest key among the cluster's visible ideas, never the head's, which
   may be hidden or unmoderated. No hidden or unmoderated text reaches the
   room, not even normalised. `PollTally.pending` counts the ideas awaiting
   moderation and is zeroed in the public view. The board
   (`GET /app/api/evaluations/:id/poll/ideas`), with every raw text, is
   staff-only, loaded through the poll's staff predicate like the projection.
6. **Moderation is not on the wall.** The projection shows the cloud, the
   switches and a "Moderate" button. The button opens the board in another tab
   (`/evaluations/:id/moderate`). The teacher approves, hides, merges, splits
   and renames there (`POST …/poll/ideas`, audited as `poll.ideas`), and the
   wall redraws through the ordinary `poll.tally` frame.
7. **"Show votes" shows the cloud.** Votes hidden, the wall keeps the question
   alone. The phones get the visible ideas as a list, as they get a short
   answer's.
8. **A phone sends on every Add and Remove.** Each one is already one
   deliberate tap, so the brainstorm has no "Send" button. This is the one
   exception to the participant page's rule of no autosave.

## Consequences

- Nothing is graded and nothing is released (ADR-014): the type's `grade`
  returns 0 and the poll's End skips a keyless item.
- The wall depends on `d3-force` (about 15 kB) for the packing. The bubbles
  are HTML so that a label wraps inside its circle.
- The tally of a brainstorm reads every answer of the poll on every change, as
  the `short` tally does. That is acceptable at lecture-hall size (hundreds of
  ideas). A larger audience would need the board cached per poll.
- Phase 2 of the issue (a mind map) and the LLM clustering reuse the marks.
  A model's proposal would be marks the teacher can undo, and its data
  protection review (answer text only, never an identity) belongs to its own
  ADR.

## Alternatives considered

- **Extending `short` with "several answers".** Rejected: `short` runs in
  exams, and the multi-answer shape would ripple through its grading, its
  review and its matchers.
- **A bubble view of the existing `short` tally.** This was the smallest
  version, but it gives one idea per participant, and several ideas each is
  what makes a room participate.
- **Moderating on the projection.** Rejected: a queue of raw text on the
  screen the room is looking at is exactly the leak moderation exists to
  prevent.
- **Fuzzy matching.** Rejected for v1: "vit" and "vie" are not one idea, and
  the teacher's merge is the safer default.
