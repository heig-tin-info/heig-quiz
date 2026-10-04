# ADR-072 — AI assistance for a brainstorm: a model moderates, corrects and groups ideas live

## Status

Accepted (2026-10-04) by the product owner, issue #458 (its "optional LLM
clustering", extended to spelling and rephrasing).

Scope: a `brainstorm` poll's ideas while the poll runs, and only there.

Relations:
- Amends F-LLM-03, F-LLM-04, N-DATA-05 and N-DATA-07 (docs/spec), and
  [ADR-058](ADR-058-passerelle-llm.md) §1 (adds the `poll` purpose).
- Amends [ADR-071](ADR-071-sondage-brainstorm.md) §§2, 3 and 5.
- Records a decision under open question 43.
- [ADR-045](ADR-045-service-llm-de-correction.md) and
  [ADR-063](ADR-063-correction-llm.md) are
  unchanged: no grading pass calls a model while an evaluation runs.

## Context

ADR-071 shipped the brainstorm without a model. Its teacher has three jobs
while the room is typing:
- keeping slurs off the wall, alone in front of a class of anonymous guests;
- merging "il respire" and "respiration" by hand;
- reading spellings that a projector makes look careless.

F-LLM-03 forbade any model call during a running evaluation. Its reason is
grading fairness: a grade must not depend on a model consulted mid-exam. A
poll grades and releases nothing (ADR-014), so that reason does not apply to
it.

## Decision

1. **A per-poll switch, off by default.**
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
2. **The model decides, and the teacher can undo.** For every idea nobody has
   marked yet, the model:
   - **hides** it when it insults, mocks, harasses, is sexual or hateful, or
     names a person, and **approves** it otherwise;
   - gives it a **correction**: spelling fixed, rephrased in a few words;
   - may attach it to an idea that **says the same**.

   These are marks of source `ai` (`poll_idea_marks.source`). They are written
   only where no mark exists, so a teacher who acted first keeps the last
   word. Every action the teacher takes afterwards makes the mark the
   teacher's.
3. **The typed text is never changed.**
   - The correction is a separate field (`correction`). The wall and the
     phones' shared list read it in place of the typed text.
   - The teacher's board shows both.
   - A participant's own list keeps what they typed.
   - The room reads a correction only for a visible idea, and a cluster's
     label is still built from its visible ideas (ADR-071 §5). The teacher's
     own label is a separate field that the model never writes.
4. **Batches, one at a time per poll.**
   - An answer claims the poll's lease in `poll_ai_runs` and sends one
     `poll.ai` job 3 s later, so the ideas typed meanwhile share a call.
   - The job judges up to 50 new ideas per call, giving the ideas already on
     the wall as context, until none is left. It then releases the lease.
   - Calls use the gateway with purpose `poll`. The model is Haiku unless the
     settings name one for that purpose (`PURPOSE_MODELS`). Each call is billed
     to the teacher who runs the poll.
   - One poll makes at most 200 calls (`run_cap`). The gateway asks once
     more after an unreadable reply, so that is at most 400 provider requests.
5. **Fail closed.** A failed call writes nothing, and its code shows on the
   board. Under moderation the new ideas wait for the teacher, as without the
   model. Another try is made at the next answer, 30 s later at the earliest.
6. **What leaves.** Each call sends only:
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

- With moderation on and the AI on, an idea reaches the wall a few seconds
  after it is typed, and nobody looks at it first. The model's correction,
  being the model's own text, is not reviewed either. The teacher can hide
  either one in a click.
- The cost is bounded per poll (200 calls) and per day (the gateway's cap).
  Haiku keeps a lecture to a few cents.
- `poll_ai_runs` holds the lease, the call count and the last error.
  `poll_idea_marks` gains `correction` and `source`.

## Alternatives considered

- **The model proposes, the teacher approves.** Rejected by the product owner:
  the whole point is to free the teacher during the lecture.
- **Rewriting the stored answer.** Rejected: the participant would see their
  own idea changed, and the original would be lost.
- **A call per idea.** Rejected: thirty phones would make thirty calls in a
  few seconds. A short batching window costs 3 s of delay.
- **Offering the AI on classroom polls only**, where a roster masks the
  names. Rejected by the product owner: the anonymous poll is the main use.
