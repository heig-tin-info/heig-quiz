# ADR-060 — The LLM review of the published questions

## Status

Proposed (2026-10-01, sketch agreed with the product owner; to be completed
before it is implemented). Third phase of LLM assistance, on the gateway of
[ADR-058](ADR-058-passerelle-llm.md) and the proposals of
[ADR-059](ADR-059-generer-la-reponse.md).

## Context

A pool collects questions written over years, by several people, often in
a hurry: a typo in a statement, a choice marked right that is wrong, an
explanation that contradicts the key, a test case whose expected output does
not match its statement. Students find these during an exam. A model can
read every question once, quietly, and point at what looks wrong.

## Decision (sketch)

1. **A review is of a published version.** Published versions are immutable
   (`question_versions`), so a review keyed on the version stays true. A
   draft is never reviewed. A new version is reviewed again.
2. **Silent when there is nothing to say.** The reply is structured:
   `findings: []` when the question is fine. A finding has a severity
   (`notice`, `warn`, `error`), the field it is about, a brief message, and
   an optional suggested fix. The prompt asks for what is wrong (spelling,
   statement, answer key, explanation, consistency between them), not for
   style. The rate of false findings decides whether teachers read the tab;
   it is measured on real pools before the review is turned on everywhere.
3. **States and the pill.** `question_reviews` (one row per reviewed
   version): `pending`, `clean`, `findings`, `dismissed`. A `clean` version
   carries the "LLM reviewed" pill. **Ignore** marks the version `dismissed`:
   it is not reviewed again and carries no pill. **Fix** turns the suggested
   fix into a proposal in the question's draft, through ADR-059's merge; the
   teacher publishes it, and the new version is reviewed in its turn.
   **Edit** opens the editor.
4. **A pool tab, "LLM review".** The findings of the pool's latest
   versions, with their severity icon, a link to the question and the
   report, and the three actions. Staff of the pool only; the reviews live in
   their own table and never reach a student (invariant 4: nothing of it is
   in the config that `toStudent` reads).
5. **At night, in a batch, within the day's leftover budget.** A scheduled
   task (`scheduled_tasks`, D10) collects the versions to review — new
   versions first, then those of an evaluation scheduled soon, then the most
   used — and sends them through the provider's batch API (half the price,
   answered within hours). It spends at most a share of what is left of the
   day's cap (ADR-058 §5), so that the authors' own calls are never starved.
   Purpose `review`, no user.
6. **What can be checked is checked, not judged.** For `code`, the runner
   verifies that the reference solution passes its own cases; for `circuit`,
   that the reference simulates. A model's opinion is for what no tool can
   check.

## To settle before implementing

- Whether a pool may opt out, and whether the review is on by default.
- The share of the leftover budget the night may spend.
- Whether a teacher can ask for a review now, on one question, or only wait
  for the night.
- Open question 35 (docs/spec/06): every question of the platform is sent to
  the provider; settle it, or accept it explicitly, before turning the
  review on for every pool.

## Alternatives considered

- **Reviewing at every save.** The draft changes constantly; reviewing it
  costs the most for the least, and a finding on a draft is stale a minute
  later.
- **A score per question instead of findings.** A number says nothing a
  teacher can act on; a finding names the field and what is wrong.
