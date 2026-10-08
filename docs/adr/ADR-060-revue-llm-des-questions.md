# ADR-060 — The LLM review of the published questions

## Status

Accepted (2026-10-02, decisions of the product owner; proposed on
2026-10-01 as a sketch). Third phase of LLM assistance, on the gateway of
[ADR-058](ADR-058-passerelle-llm.md). Amends ADR-058 §5 ("the cap is not a
quota"): the night's review spends at most a share of the cap (§5). Its
"Fix" is not the merge of [ADR-059](ADR-059-generer-la-reponse.md) §2, which
never changes what the teacher wrote: a review's fix does exactly that, on
purpose, one field at a time (§4).

§1 amended by [ADR-082](ADR-082-carte-ia-de-l-editeur.md): "Review now"
leaves the editor's `…` menu for its AI card, which shows the review of the
latest published version, read-only.

Delivered with the table `question_reviews` and `review_pools` (migration
`question_reviews`, owned by the `pool` module), `apps/api/src/modules/pool/review.ts`
and `reviewRoutes.ts`, the scheduled task `llm.review`, the contracts
`QuestionReview`, `ReviewFinding`, `ReviewList`, the pool's "LLM review" tab
and the "LLM reviewed" pill.

## Context

A pool collects questions written over years, by several people, often in
a hurry: a typo in a statement, a choice marked right that is wrong, an
explanation that contradicts the key. Students find these during an exam.
A model can read every question once, quietly, and point at what looks
wrong.

## Decision

### 1. A review is of a published version, in a pool that asked for it

- A review is keyed on a published version (`question_versions`, immutable):
  it stays true for that version; a new version is reviewed in its turn. A
  draft is never reviewed.
- A pool's owner turns the review on (`review_pools`, one row per pool that
  asked); it is OFF by default until the rate of false findings has been
  measured on real pools (§2). The night reviews only the LATEST published
  version of each live question of those pools.
- `circuit` and `diagram` are not reviewed: their configs are drawings, not
  text a model can read.
- A contributor may ask for a review of one question now ("Review now"),
  in any pool: the call is the teacher's, purpose `review`, attributed to
  them, limited per minute like the wand.

### 2. Silent when there is nothing to say

The reply is structured: `findings: []` when the question is fine. A
finding has a `severity` — `error` (the key is wrong, the question cannot be
answered), `warn` (ambiguous, the explanation contradicts the key),
`notice` (spelling, grammar) —, the `path` of the field it is about
(`prompt`, `choices.2.text`, `explanation`), a brief `message` in the
language of the statement, and an optional `fix`. The prompt asks for what
is wrong, not for style; it says that `[[…]]` expressions are parameters
(ADR-056), not typos, and that images are not sent, so a figure is never
reported missing.

### 3. States and the pill

`question_reviews` holds one row per reviewed version: `clean` (no finding),
`findings`, `ignored`, or `failed` (the call failed; retried the next
night). The latest published version carries the pill:

- `clean` and `ignored`: "LLM reviewed" — a teacher who was right against a
  false finding is not left worse off than one never reviewed;
- `findings`: the count and the worst severity;
- no row: no pill.

**Ignore** acts on the whole review of that version: it is not reviewed
again, and its findings leave the tab.

### 4. Fix: one exact replacement, with Undo

A finding may carry `fix: { from, to }`, the exact text of the field to
replace and its replacement (`"false"` → `"true"` for a tick). **Fix**
applies it to the question's DRAFT, never to a published version: the value
at `path` must still contain `from` exactly once — otherwise the draft moved
on since the review and the fix is refused (`fix_stale`) —, the draft is
stored as an edit (D16), and **Undo** applies the inverse replacement. The
teacher publishes as always; the new version is reviewed in its turn.
**Edit** opens the editor.

### 5. At night, in a share of the day's cap

- The scheduled task `llm.review` runs every hour and works only between
  01:00 and 06:00, Europe/Zurich. It reviews the latest versions without a
  review row, newest first, one call at a time through the gateway
  (purpose `review`, no user, `effort: low`).
- The night spends at most **25 % of the day's cap**
  (`LLM_REVIEW_NIGHT_SHARE`): it sums today's `review` calls made by no
  person and stops before its next call would cross the share. It never
  relies on the gateway's refusal, so the `llm.budget` check stays green.
  The rest of the cap is the authors'.
- The Batch API of the provider (half the price, answered within hours) is
  deferred: it would need the gateway to hold a reservation across hours and
  a day boundary, an amendment to ADR-058 of its own.

### 6. Who sees, who acts

The tab and the pill are the pool's: whoever reaches the pool reads them
(the `pool` guards, a 404 otherwise, invariant 6). Fix, Ignore and Review
now need the `contributor` role; turning the review on or off needs the
`owner` role. Reviews are teacher-only data in their own table: nothing of
them is in a config, so `toStudent` never sees them (invariant 4). A review
row is deleted with its version.

### 7. What is sent

The version's config and explanation, and the question's type — nothing
else: no name, no author, no student (open question 43).

## Consequences

- A pool owner turns the review on; within a few nights every question of
  the pool carries a pill or a finding.
- The rate of false findings is measured on those pools before the review
  is offered as on by default.
- A finding with a fix is one click, and the teacher still publishes.
- The night's cost is bounded by construction (25 % of the cap); with
  Sonnet a review costs about one or two cents, so a 20 USD cap reviews a few
  hundred versions a night.

## Alternatives considered

- **Reviewing at every save.** The draft changes constantly; reviewing it
  costs the most for the least, and a finding on a draft is stale a minute
  later.
- **A score per question instead of findings.** A number says nothing a
  teacher can act on; a finding names the field and what is wrong.
- **Fix through ADR-059's merge.** The merge only fills what is empty; a
  fix must change what the teacher wrote.
- **The "leftover" of the day's cap.** At 02:00 almost all of it is left
  over: the night would spend the authors' day.
- **On everywhere by default.** Before the false findings are measured, a
  tab full of noise would teach teachers to ignore it.
