# ADR-071 — The brainstorm poll: short ideas, a bubble cloud, moderated by the teacher

## Status

Proposed (2026-10-04, issue #458); acceptance by the product owner pending.
§9–§14, the AI assistance, were accepted by the product owner on 2026-10-04
as ADR-072, folded here on 2026-10-09
([correspondence table](#correspondence-with-adr-072)).

Scope: a third question type for live polls, what of its answers reaches
the room, and the model that may moderate it while the poll runs.

Relations: amends [ADR-014](ADR-014-sondages-en-direct.md) (the poll types,
the display switches and the tally); amends F-LLM-03, F-LLM-04, N-DATA-05
and N-DATA-07 (docs/spec) and [ADR-058](ADR-058-passerelle-llm.md) §1 (the
`poll` purpose); records a decision under open question 43; depends on
F-LIVE-13, F-LIVE-14 and F-AUTH-05. [ADR-063](ADR-063-correction-llm.md)
is unchanged: no grading pass calls a model while an evaluation runs.

## Context

A poll asks closed questions (`mcq`) or one short answer (`short`). Issue #458
asks for Mentimeter-style open polls: each participant types several short
ideas, and the wall shows a bubble per idea that grows with the number of
participants who proposed it. Anonymous guests and a projector also mean that
one day a slur reaches the wall, so the teacher must be able to keep an idea
off it before anyone sees it.

While the room is typing, the teacher has three jobs: keeping slurs off the
wall, alone in front of a class of anonymous guests; merging "il respire"
and "respiration" by hand; reading spellings that a projector makes look
careless. The issue's optional LLM clustering, extended to spelling and
rephrasing, takes them over. F-LLM-03 forbade any model call during a
running evaluation; its reason is grading fairness: a grade must not depend
on a model consulted mid-exam. A poll grades and releases nothing
(ADR-014), so that reason does not apply to it.

The product owner chose on 2026-10-04 the v1 scope, the model (a new keyless
type) and where moderation happens (a separate teacher view).

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
   wall is worse than two bubbles the teacher merges by hand, or the model
   attaches (§10). A participant counts once per idea and once per cluster.
3. **The teacher's word is a mark per idea**, in `poll_idea_marks` (owned by
   the `poll` module), keyed by evaluation and idea key, never by attempt. A
   mark is a status (approved, hidden, or none), the idea it was merged into,
   a label for the cluster it heads, a `correction` (§11) and its `source`
   (`teacher` or `ai`, §10). The teacher's label is a field the model never
   writes. The marks follow the text, so editing an answer keeps the
   decision on the ideas that remain. "Run again" starts with no marks.
4. **Moderation** is a third display switch (`settings.poll.moderation`,
   `PollRevealBody.moderation`), for a brainstorm only. It defaults to ON for
   an anonymous poll and OFF for a classroom's. With it on, only approved ideas
   are visible; with it off, every idea that is not hidden is. A hidden idea is
   never visible.
5. **What the room reads is the cloud, never the board.** `PollTally.ideas`
   holds one bubble per cluster with at least one visible idea. Its label is
   the teacher's name, or the most frequent VISIBLE spelling, read through
   its correction when it has one (§11). Its key is the smallest key among
   the cluster's visible ideas, never the head's, which may be hidden or
   unmoderated. No hidden or unmoderated text reaches the room, not even
   normalised, and a correction reaches it only for a visible idea.
   `PollTally.pending` counts the ideas awaiting moderation and is zeroed in
   the public view. The board (`GET /app/api/evaluations/:id/poll/ideas`),
   with every raw text, is staff-only, loaded through the poll's staff
   predicate like the projection.
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

### AI assistance (formerly ADR-072)

9. **A per-poll switch, off by default.**
   - "AI assistance" (`settings.poll.ai`, `PollRevealBody.ai`) belongs to a
     brainstorm and is set on the teacher's moderation board.
   - Turning it on is refused (`422 llm_unavailable`) when the gateway cannot
     call a model.
   - While it is on, the participants' page says that an AI model (Anthropic)
     reads the ideas, without their names.
   - It is never retroactive. The ideas already typed when it is turned on
     were typed without that notice, so they stay with the teacher: each one
     gets an empty mark of the teacher's, which the model never overwrites.
     Only ideas typed after the switch leave.
10. **The model decides, and the teacher can undo.** For every idea nobody has
    marked yet, the model:
    - **hides** it when it insults, mocks, harasses, is sexual or hateful, or
      names a person, and **approves** it otherwise;
    - gives it a **correction**: spelling fixed, rephrased in a few words;
    - may attach it to an idea that **says the same**.

    These are marks of source `ai` (`poll_idea_marks.source`). They are
    written only where no mark exists, so a teacher who acted first keeps the
    last word. Every action the teacher takes afterwards makes the mark the
    teacher's.
11. **The typed text is never changed.**
    - The correction is a separate field (`correction`). The wall and the
      phones' shared list read it in place of the typed text.
    - The teacher's board shows both.
    - A participant's own list keeps what they typed.
    - The room reads a correction only for a visible idea, and a cluster's
      label is still built from its visible ideas (§5).
12. **Batches, one at a time per poll.**
    - An answer claims the poll's lease in `poll_ai_runs` and sends one
      `poll.ai` job 3 s later, so the ideas typed meanwhile share a call.
    - The job judges up to 50 new ideas per call, giving the ideas already on
      the wall as context, until none is left. It then releases the lease.
    - Calls use the gateway with purpose `poll`. The model is Haiku unless the
      settings name one for that purpose (`PURPOSE_MODELS`, ADR-058 §2). Each
      call is billed to the teacher who runs the poll.
    - One poll makes at most 200 calls (`run_cap`). The gateway asks once
      more after an unreadable reply, so that is at most 400 provider requests.
13. **Fail closed.** A failed call writes nothing, and its code shows on the
    board. Under moderation the new ideas wait for the teacher, as without the
    model. Another try is made at the next answer, 30 s later at the earliest.
14. **What leaves.** Each call sends only:
    - the question's statement;
    - the ideas' texts, under throwaway ids (`n1`, `e1`). An idea key is the
      typed text, so it is never sent as one.

    Before sending, the names and e-mails of the classroom's roster and of the
    accounts that joined are masked. A guest of an anonymous poll is nobody the
    platform knows, so a name typed there leaves as typed. The product owner
    accepted this on 2026-10-04 (open question 43), together with the room's
    notice. The prompt tells the model to treat the ideas as data and never as
    instructions. The reply is read only for the ids it was sent.

## Consequences

- Nothing is graded and nothing is released (ADR-014): the type's `grade`
  returns 0 and the poll's End skips a keyless item.
- The wall depends on `d3-force` (about 15 kB) for the packing. The bubbles
  are HTML so that a label wraps inside its circle.
- The tally of a brainstorm reads every answer of the poll on every change, as
  the `short` tally does. That is acceptable at lecture-hall size (hundreds of
  ideas). A larger audience would need the board cached per poll.
- With moderation on and the AI on, an idea reaches the wall a few seconds
  after it is typed, and nobody looks at it first. The model's correction,
  being the model's own text, is not reviewed either. The teacher can hide
  either one in a click.
- The cost is bounded per poll (200 calls) and per day (the gateway's cap).
  Haiku keeps a lecture to a few cents.
- `poll_ai_runs` holds the lease, the call count and the last error.
- Phase 2 of the issue (a mind map) would reuse the marks.

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
- **The model proposes, the teacher approves.** Rejected by the product owner:
  the whole point is to free the teacher during the lecture.
- **Rewriting the stored answer.** Rejected: the participant would see their
  own idea changed, and the original would be lost.
- **A call per idea.** Rejected: thirty phones would make thirty calls in a
  few seconds. A short batching window costs 3 s of delay.
- **Offering the AI on classroom polls only**, where a roster masks the
  names. Rejected by the product owner: the anonymous poll is the main use.

## Correspondence with ADR-072

[ADR-072](ADR-072-ia-du-brainstorm.md) (AI assistance for a brainstorm,
accepted 2026-10-04) was folded here on 2026-10-09. Code and documents that
cite it resolve as follows.

| ADR-072 | This record |
| --- | --- |
| Status, Relations | Status and Relations |
| Context | Context, second paragraph |
| §1 A per-poll switch, off by default (never retroactive) | §9 |
| §2 The model decides, and the teacher can undo | §10 |
| §3 The typed text is never changed | §11; §3 and §5 |
| §4 Batches, one at a time per poll | §12 |
| §5 Fail closed | §13 |
| §6 What leaves | §14 |
| Its amendments of ADR-071 §2, §3 and §5 | §2, §3 and §5, in place |
| Consequences | Consequences |
| Alternatives considered | Alternatives considered (the last four) |
