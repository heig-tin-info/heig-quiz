# ADR-045 — The LLM grading service, and its development stub

## Status

Accepted (2026-09-30, on the owner's request that the demo world show AI
proposals). Implements the first half of F-GRADE-02 (docs/spec/02): the call
path, with one provider, a development stub. Amends docs/spec/04 §4.8
("Scoring, later") and docs/spec/05 §5.6 (the `grading.llm` job, the
`llm_calls` table), which a real provider will still owe. Leaves the LLM-reasoning
part of question 27 (docs/spec/06) open.

*Note (2026-10-01, ADR-058):* the real provider arrived as a separate
gateway (`complete()`, an institutional key, `llm_calls`, a daily cap). It is
not wired into the grading pass: `app.llm` stays chosen by `LLM_PROVIDER` as
below, and the consequences listed here are still owed before it is.

## Context

The **Validate N** button of the grading table (ADR-044 §4) validates the
proposals `isBatchable` accepts: a grader's opinion, never a 0-point
placeholder. The contract already had a `pending: "llm"` result and an
optional `GradeContext.llm`, but no service existed and the pass turned
every such result into `llm_not_configured`. No demo world, no test and no
screenshot could show an opinion with a confidence, and the batch screenshot
of the guide showed a disabled button.

## Decision

### 1. One service per process, chosen by `LLM_PROVIDER`

`LlmService` (`@quiz/core`) has one method, `grade(request)`, which returns
points, a confidence (`low` / `medium` / `high`) and a justification.
`LLM_PROVIDER` selects the service once, at boot (`apps/api/src/modules/llm/`),
as `RUNNER_MODE` selects the runner: `none`, the default, leaves `app.llm`
null; `stub` is the only provider.

### 2. The stub is refused in production, like the development login

The stub is deterministic: the share of the rubric's terms (else of the
model answer's) found in the answer gives the points, that share and the
answer's length give the confidence, and the justification says "Development
stub, not a model" without naming or counting the terms. `config.ts` refuses
to start with `LLM_PROVIDER=stub` under `NODE_ENV=production`, by the same
mechanism and with the same kind of test as `AUTH_DEV_LOGIN` (invariant 3):
a grade no model produced must never reach a real student. `.env.example`
turns it on for development; the seed takes the process's provider, never
one of its own.

### 3. The request: what the type builds, and nothing that identifies

A type asks by returning `pending: "llm"` with `{ rubric, reference?,
answer, maxPoints }`, built from its config and the answer alone. The pass
hands it to the service as it is and adds nothing: no name, address, user,
attempt, item or evaluation id (F-LLM-04, asserted by
`grading/llm.db.test.ts`). The essay asks only when `GradeContext.llm` is
present and it has a rubric or a model answer; otherwise it keeps v1's
manual placeholder, so production is unchanged. The circuit's `llm` mode
asks too, with the details every circuit review reads.

### 4. An inline call, not a queue

The pass calls the service inline, cell by cell, where docs/05 §5.6 plans a
`grading.llm` job per answer. The stub answers in microseconds and cannot
fail for a network reason, so a queue would carry no load and no retry. A
failed call becomes a proposal with `grader_error`, which the next pass
retries.

### 5. No call while the evaluation runs (F-LLM-03)

The pass offers the service only when the evaluation is neither `running`
nor `paused` (`isLiveState`, `@quiz/domain`). A retake's own pass during an
exercise therefore leaves the essay as a placeholder, and the pass at the
close asks the model.

### 6. The justification is the teacher's

The pass writes a PROPOSAL (`source: llm`, the confidence) and stores the
justification in the grading's `details` under `justification`
(`JUSTIFICATION_KEY`, `@quiz/core/reasons`), NEVER in `comment`: a
validation, one by one or in a batch, keeps the comment, and the comment is
what a student reads with the result. `filterDetails` strips the key from
every student payload, under a published key (`showKey`) too. The grading
panel shows it to the teacher as "The AI's justification, never shown to the
student". Whether a student will ever read an LLM's reasoning is open
question 27, which this decision does not settle.

## Consequences

- The grading table shows AI proposals, their confidence filter and a
  working **Validate N** in development and in the guide's screenshots.
- No call is logged: the stub costs nothing and calls no one.
- A real provider (F-LLM-01) plugs into `createLlm` and `LlmService`, and
  must bring what the stub does not need:
  - the `llm_calls` table and a record per call, with the model, the tokens,
    the estimated cost and the teacher (F-LLM-04, docs/05 §5.3), never the
    prompt;
  - what N-DATA-05 asks of a provider: the text sent scrubbed of any name
    a student typed into it, no-retention mode where the provider offers it;
  - the provider and model shown to the teacher beside each proposal;
  - the statement in the request, and a reply per criterion (F-GRADE-02,
    docs/04 §4.8);
  - the `grading.llm` queue of docs/05 §5.6, with retries and rate limits,
    instead of the inline call.

## Alternatives considered

- **A fake grading written by the seed.** Rows no pass would write, and
  nothing to show that the path works; the seed builds through the services.
- **The justification as the grading's comment.** It is the field the panel
  already shows, but a validation hands it to the student, which is exactly
  what open question 27 has not decided.
- **A `grading.llm` queue now.** A second job type, its retries and its
  progress, for a provider that answers instantly.
