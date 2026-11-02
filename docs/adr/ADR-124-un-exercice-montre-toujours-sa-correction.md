# ADR-124 — An exercise always shows its correction; a per-question check

## Status

Accepted (2026-11-02, product owner Yves Chevallier, on issue #986: a student
read "11/20" after an exercise and nothing else). §1 and §2 are delivered with
this record; §3 is decided and delivered by the following pull requests.

Scope: what a student reads of an `exercise` — at the hand-in and, per
question, during an attempt — and the feedback policy's place on that mode.
Exams and polls are unchanged.

Relations: amends [ADR-025](ADR-025-plusieurs-tentatives-exercice.md) §4,
[ADR-041](ADR-041-entrainement-espace.md) §1 (an exercise's key),
[ADR-050](ADR-050-publier-la-correction-d-un-exercice.md) (the student side),
[ADR-067](ADR-067-correction-a-la-remise-des-exercices.md) §3 and §4,
[ADR-068](ADR-068-roles-de-l-equipe-du-cours.md) §3 (reopening),
[ADR-091](ADR-091-reprise-partielle-d-un-exercice.md) (masking between attempts),
[ADR-098](ADR-098-maitrise-des-notions-par-l-etudiant.md) §7 and
[ADR-122](ADR-122-entrainement-apres-l-echeance.md) §1 and §7. F-EVAL-11,
F-EVAL-15, F-EVAL-27, F-RES-04; open questions 5 and 50 (settled).

## Context

An exercise is practice. Yet a student who handed in an exercise with retakes
read only their score: ADR-025 §4 masked everything but the points while the
retakes were open, whatever the feedback policy, so that the correction of
attempt 1 would not be the key of attempt 2. Under `on_release` or `none` the
correction never came before the close, sometimes never. The student of #986
got "11/20" and no way to learn which answers were wrong. The French hint of
`immediate` ("as soon as a question is validated") was wrong too: `immediate`
is per hand-in (ADR-067 §3).

The protection made sense for a graded exercise. The product owner's answer
is that an exercise series is not graded.

## Decision

1. **An exercise is never graded; it always shows its correction.** Its mark
   is indicative only. Once an attempt is handed in (or expires, or is closed
   by the teacher), its student reads the whole correction: each question's
   verdict and points, their answer, the expected answer (the key) and the
   explanation — retakes open or not, published or not, the waiting room
   included, a practice attempt after the due date included. The teacher's
   comment and the names of hidden test cases keep their stored setting.
   One pure function says it, `effectiveFeedbackPolicy(mode, stored)`
   (`@quiz/domain`, `correction.ts`): for an exercise, `immediate` with
   `showAnswer`, `showKey` and `showExplanation`; for an exam or a poll, the
   stored policy. Every reader of the policy on a student's behalf goes
   through it (`results` and `live` read `feedbackOf`, which applies it); the
   editor, templates and copies read the stored policy (`storedFeedbackOf`).
   The `retakes_open` refusal and its score-only page are removed. What the
   key may carry is unchanged: an essay's model answer, never its criteria
   (ADR-037), through the student view (invariant 4).

2. **No feedback choice on an exercise.** The editor hides the feedback
   policy (when, key, explanation) for an exercise and says the correction
   comes at each hand-in. The stored `feedbackPolicy` is kept and ignored, not
   migrated: a draft switched back to an exam finds the teacher's choice, and
   the contract still accepts the field on an exercise (templates, MCP
   clients, older screens), the in-class rule of #78 no longer judging it.
   Retake options (keep-best and the like) are left to issue #992.

3. **A per-question check (planned).** During an exercise's attempt the
   student may **check** a question:
   - a checked question is **locked** for that attempt; a retake gives
     another go. An empty question cannot be checked;
   - `code` and `circuit`: the check locks the question and shows the key and
     the explanation at once; the verdict arrives asynchronously when the
     runner answers;
   - an essay (`rich`) and a short answer judged by the AI: the key (the model
     answer only, never the criteria — ADR-037) and the explanation at the
     check; the verdict at the hand-in or the close; no model call during the
     attempt (ADR-067 §1);
   - every exercise offers it, the waiting room included — this reverses, for
     exercises, the in-class refusal of #78 (open question 5); whether an
     exercise keeps a waiting room at all is issue #992;
   - assistants keep Reopen on an exercise; a checked question stays locked
     after a reopen;
   - the check's verdict is persisted as the item's automatic grading,
     written under the attempt's row lock, and `gradableNow`
     (`@quiz/domain`, `retake.ts`) is extended to "a checked item of an
     exercise" (amends ADR-067 §3 and §4's guard).

4. **What follows from §1.**
   - The drill serves an exercise's card once the student's latest attempt is
     handed in (`keyShownTo`, ADR-041 §1); the concept mastery counts it from
     then (ADR-098 §7).
   - Practice after the due date is open by default on every exercise
     (`afterDueOpen`): the oracle ADR-122 §1 guarded against, a hidden key read
     out by unlimited tries, no longer exists.
   - Reopening an exercise's attempt stays every member's (`reopenRole`): the
     owner-only derogation of ADR-068 §3 (audit L9) stays for the other modes
     (a revealed running poll); the audit still marks a reopening after the
     key was read (`derogation: "key_shown"`).
   - Publishing the correction (ADR-050, F-EVAL-27) keeps one role: it opens
     the class debrief and its projection. It changes nothing on a student's
     results page.

## Consequences

- The student of #986 reads, at the hand-in, which answers were wrong and
  why. A teacher who wanted an exercise's key hidden until the close can no
  longer do it: the series is practice, and an exam is the tool for a
  sitting whose key must wait.
- The correction of attempt n may help attempt n+1. Accepted: the exercise is
  not graded, and the retake rules move to #992.
- One function decides what a student reads; no reader special-cases the
  mode. One deliberate mode branch remains, in `reopenRole`:
  `if (evaluation.mode === "exercise") return "assistant"` — an exercise's
  key is always shown at the hand-in, so the key alone cannot make its
  reopening an owner's act. Dead code goes with the masking: the reason
  `retakes_open`, the score-only payload of a pending page (`score`,
  `retake`, `review` on `FeedbackPending`), its screen and its strings, the
  default-or-set source of the practice switch (`afterDueSource`) and its
  explanation, and the in-class refusal of `immediate` on an exercise
  (`allowedFeedbackWhen` refuses it on an exam only).
- The owner-only reopening of ADR-068 §3 still applies to a running poll
  whose reveal turned its key on (its stored policy is `immediate`, and the
  reveal sets `showKey`); an exam shows nothing while it runs, and only a
  running evaluation is reopened. The reopen's audit keeps the marker
  `derogation: "key_shown"` whenever the student had read the key
  (`keyShownTo`), an exercise's included, whoever reopens.
- No migration; reverting §1 restores every stored policy as it was.

## Alternatives considered

- **Keep the policy, change its default for exercises.** Every existing
  exercise under `on_release` or `none` would still mask, and the editor
  would keep a choice whose only effect is to hide the correction of
  practice.
- **Lift only the retake masking.** It fixes #986 under `immediate` alone;
  the stored `on_release` of most exercises would keep the correction until
  the close.
- **Rewrite the stored policies by migration.** Irreversible, and a draft
  switched back to an exam would lose the teacher's choice.
