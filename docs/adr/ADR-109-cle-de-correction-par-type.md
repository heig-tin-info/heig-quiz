# ADR-109 — Each question type draws its own answer key for the debrief

## Status

Accepted (2026-10-13, issue #828; its shape decided by the product owner).

Scope: the optional `Key` surface of the question-type client contract
(`packages/core/src/client.ts`) and its host, the correction projection and
the Results "Questions" tab (`apps/web/src/results/CorrectionQuestion.tsx`).

Relations: amends [ADR-033](ADR-033-projection-de-la-correction.md) (who
draws the key on the wall and on the page); depends on
[ADR-056](ADR-056-questions-parametrees.md) §9 (the example caption stays
the host's).

## Context

The debrief draws each question's key: an mcq's choices, a cloze's blanks in
its text, a short or math answer's expected answers, a categorize board, a
program. The web host did it with a table keyed by type id, importing the
solution types of six `qt-*` packages and copying pieces the types already
own (the categorize board, the math answers). diagram, circuit and blocks
still have no key on the wall, because their renderer is in their package
and out of the host's reach. A type's look should live with the type.
The host's copies of the categorize board and the math answers move into
their packages as they are, not merged with the types' own pieces, which
render differently: that duplication is deferred, not solved.

## Decision

1. **An optional `Key` surface.** `QuestionTypeClient.Key` is a
   `React.lazy` component, wired through `@quiz/registry/client` like
   `Review`. `drawsKey(type)` is "the type's client has a `Key`"; the host's
   table by type id is gone. A type without one gets the host's prompt and
   answer groups, as before.
2. **Staff only.** It reads the solution the per-question view serves the
   course's staff (`GET /evaluations/:id/results/by-question`), which never
   goes through `toStudent`. It must never be mounted on a student surface;
   `apps/web/src/results/keyGuard.test.ts` holds one reader of `.Key` in the
   app, two staff screens importing it, and no student directory importing
   anything of `results/`.
3. **Structural props.** `KeyProps` names the student view, the solution,
   `revealed`, the `density` (`wall` or `page`) and `stats`: the outcomes,
   the answer groups and the parameterized flag — the part of `ByQuestion`
   the keys read, written structurally because `@quiz/contracts` depends on
   `@quiz/core`. The host passes its `ByQuestion` as `stats`, so a contract
   change a key would not survive fails to compile there.
4. **Slots from the host.** The host draws the generic pieces and lends
   them: `prompt` (the statement, inside the host's frame) and `rows` (the
   answer groups), and `statement(body)`, the frame itself — the example
   caption of a parameterized question (ADR-056 §9) above it and, on the
   wall, the explanation after it. A key places, replaces or omits them: an
   mcq and a categorize board keep the prompt and draw instead of the rows;
   a cloze draws its text through `statement` and no rows; a short and a
   math answer put "Expected answer" above the rows.
5. **Renderers lent by the host**, as `renderMarkdown` already is: the thin
   segmented bar (`Bar`, `SegmentedBar` of `apps/web/src/ui/bar.tsx`), the
   inline markdown, and a cloze's `renderText`. A package never imports
   `apps/web`. The Suspense fallback is the statement itself, so nothing
   above the key moves when its chunk arrives.
6. **Density split.** The sizes the host and several keys share live in
   `CORRECTION_SCALE` of `@quiz/ui` with the `Density` type; those only the
   host draws stay in its `SCALE`; those only one type draws live in its
   `Key.tsx`. The words move with them, under `qt.<type>.k.*`; a cloze's
   "correct" and "wrong" stay the head's `correction.outcome.*`, mapped.
7. **`code` and `rich` wait.** The program (template, reference, test cases)
   and an essay's model answer stay in the host for now: they have their own
   treatment on the Results tab beside the type's review, and moving them is
   a separate change. diagram, circuit and blocks gain a `Key` next.

## Consequences

- The host no longer imports a type's solution shape for mcq, cloze, short,
  math or categorize; a type's key is tested in its package.
- The first projection of a type fetches one more chunk; the statement
  stands meanwhile.
- A short or math key wraps the host's answer groups in one more flex
  column of the same gap: the same pixels, one more element.

## Alternatives considered

- **Keep the host's table and import more `qt-*` internals** for diagram,
  circuit and blocks: the duplication the issue names, growing by type.
- **Two surfaces, a statement and an answers piece**: the host would still
  decide which type replaces what. One component with slots lets the type
  decide and keeps the host type-blind.
- **Move `SegmentedBar` into `@quiz/ui`**: it reads the app's i18n and
  tooltip layer; lending it keeps one bar and no new package dependency.
