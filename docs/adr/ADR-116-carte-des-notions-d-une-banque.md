# ADR-116 — The concept map of a pool: a concept counts what its click opens, one level of the hierarchy per view

## Status

Accepted (2026-10-15) by the product owner ([#897](https://github.com/heig-tin-info/heig-quiz/issues/897),
answers 9–13 to the step C challenge). Assumed, for the product owner to change: "itself"
opens the widened filter, nothing of it nor auto-zoom at the root (§2); the path in `?at=`
(§3); the search rule and `ViewName` `heat` → `map` (§6); the map cached under the pool's
query key (§7); the side effects on the AI description and MCP `get_pool` (§8).

Scope: the pool's **Concepts** tab — what a concept's number counts, in the table and in
the map, and how the map draws the hierarchy of the vocabulary.

Relations: amends [ADR-081](ADR-081-vocabulaire-de-notions.md), third addendum §6 (a
concept's count) and sixth addendum §9 ("coverage in one place") and §10 ("no other screen
changes"); supersedes step C of #897 as first written (a nested treemap, a concept placed
under its first broader concept by name, a pluggable metric). Adds F-POOL-14
(docs/spec/02).

## Context

The Concepts tab (ADR-081 third addendum §6) lists the concepts a pool's live questions
use, each with a count, and a click opens the Questions tab filtered on that concept.
Since step 7d (sixth addendum §10) the filter covers the narrower concepts too, while the
count stayed the number of questions linked directly: "Pointer 3" could open seven
questions. Its second reading, the "heat", is a flat treemap of those direct counts, which
says nothing of the hierarchy the vocabulary now has (ADR-114).

Two facts shape a drawing of that hierarchy. A concept may have several broader concepts
(ADR-081 §4), so a tree drawn once would have to choose a parent. And a question may be
linked to two sibling concepts, so the parts of a concept may add up to more than the
whole: a nested treemap, whose children's areas must sum to the parent's, cannot draw
covered counts without lying.

## Decision

1. **The metric.** For a pool, a *live question* is one with `deleted_at IS NULL`, drafts
   included. L, the *linked concepts*, are those linked to at least one live question;
   Q(c) the live questions linked to c. The pool's *reach* R is L plus every broader
   concept above a member of L, near or far, through `broader` edges only (`related`
   never); R is closed upwards and never holds a merged concept. cover(r) is r and its
   narrower concepts, near or far (ADR-081 §4). **covered(r)** = |∪ Q(c), c ∈ cover(r)|:
   the number a click on r opens, the same set as `GET /pools/:id/questions?concept=r`.
   **own(r)** = |Q(r) minus ∪ Q(c), c ∈ cover(r) \ {r}|: the questions of r that none of
   its narrower concepts has; own > 0 implies r ∈ L, and a concept reached only from below
   has own = 0. The covered questions of r are its own ones and the covered questions of
   its direct narrower concepts; the SUM of those parts may exceed covered(r). The
   *top concepts* are the members of R with no broader concept. The rule is the pure
   `conceptMap` of `@quiz/domain` (invariant 8), over `coverageOf`, the same rule as the
   filter's `coverage`.

2. **One level per view.** The map draws the children of one concept at a time, each cell's
   area its covered count, plus an **"itself"** cell of area own(r) when own(r) > 0,
   labelled as the concept's own questions. Because a question on two siblings is in
   both, the areas of a level are never nested inside the parent's. The **root** view
   draws the top concepts, with no "itself" cell and no link of its own, and never zooms
   by itself into a single top concept. The "itself" cell opens the concept's filter,
   which is widened (ADR-081 §4): its click shows the covered questions while its label
   says own — the filter has no "this concept alone" mode, and adding one is not this
   decision.

3. **The hierarchy unfolded.** A concept with several broader concepts is drawn under each
   of them, so it appears in several views but never twice in one. The trail above the
   map is the path the teacher navigated, not a canonical path; it is kept in the
   address (`?at=` holds the ids of the path), so a reload or a shared link lands on the
   same level. "First broader concept by name" stays the rule of the picker and the
   concept sheet, not of the map.

4. **Clicks and keys.** A cell whose concept has narrower concepts in R zooms into it; a
   leaf cell and the "itself" cell open the Questions tab filtered on the concept. At any
   level below the root, **"Show its n questions"** opens the current concept's filter (n
   its covered count). The cells are buttons: Enter or Space acts, Tab walks them in
   reading order; after a zoom the focus goes to the first cell of the new level, after a
   step back up the trail to the cell just left.

5. **No colour.** Every cell is a neutral surface, as the heat's (DESIGN.md); the area is
   the message. A `proposed` concept is said by text (its badge in the cell's name), never
   by a hue. A cell too small for its name shows its count alone, its accessible name and
   `title` carrying both.

6. **The view switch.** The map replaces the heat in the tab's `ViewSwitch` (the
   `ViewName` `heat` becomes `map`): the table and the map are two pictures of one list,
   as the switch's rule of DESIGN.md requires, the table listing L, the map R level by
   level. A search keeps the matching concepts, their ancestors (so the path to them
   stays drawable) and their subtrees.

7. **The route.** `GET /app/api/pools/:id/concept-map` answers `PoolConceptMap`
   (`packages/contracts/src/pool.ts`): the nodes of R, each `{ concept, covered, own }`,
   by label then id in the reader's language, and the `broader` edges among R. It is read
   by whoever reads the pool, through the loader of `GET /pools/:id` (owner, members, the
   staff of a linked course, any teacher on a public pool, the admin with Super Powers;
   anyone else the 404 of a missing pool, a student a 403; invariant 6). Nothing is
   audited and nothing reaches a student (invariant 4). The client loads it only when the
   map opens, cached under the pool's query key so a change of the pool refreshes it.

8. **The table counts the same.** `PoolDetail.concepts` keeps its shape and lists L, but
   its `count` is covered(c), from the same computation as the map (one read of the links,
   one of the edges, one of the labels). Side effects: the AI's pool description
   (ADR-013) now ranks the concept labels it is given by covered count, so a broader
   concept may come first; the MCP `get_pool`, which returns the pool's detail, reports
   covered counts. A caption under the table says a concept counts its narrower concepts'
   questions; the map is the tab's picture of the hierarchy.

9. **Left out, and why.**
   - *A mastery map* (an area by cards): it would hide the concepts without evidence that
     ADR-081 sixth addendum §9 requires as lines, the teacher has no bands to colour by,
     and a course's declared concepts form no hierarchy of their own. The list stays; a
     later amendment of ADR-041 §15 if the need holds.
   - *An admin map*: an area by questions would hide the unused `proposed` concepts that
     curation exists for; the curation queue's tree reading (#903) serves the admin.
   - *A student map*: a student's concepts reach them only through the drill's student
     view (ADR-098); nothing here is for a student.
   - *An MCP tool* for the map: `get_pool` and `list_questions` already answer what a
     client needs.

## Consequences

- One number per concept everywhere in the tab, and it is what the click opens; the
  filter, the course coverage, the mastery and the map apply one rule (`coverageOf`).
- The table's counts change for every concept that has narrower concepts in the pool,
  without a migration; the AI description and `get_pool` see the new counts (§8).
- The map's areas of one level do not sum to the parent's; the "itself" cell and the
  one-level drawing make that visible rather than hide it.
- The route costs one read of the vocabulary's edges per open, as the filter does; the
  vocabulary is small and loaded whole elsewhere.

## Alternatives considered

- **A nested treemap**: its children must sum to the parent, which covered counts do
  not; drawing direct counts instead makes the number disagree with the click.
- **Placing a concept under its first broader concept by name**: deterministic, but it
  hides a poly-hierarchy's other parents and the counts under them.
- **Direct counts** (the table as it was): the number would keep disagreeing with what its
  click opens.
- **The map inside `PoolDetail`**: every pool open would pay for the ancestors and the
  edges that only the map reads.
- **Computing the map in the client from `GET /concepts`**: it would load the whole
  vocabulary and every link of the pool to count, and duplicate the rule outside the API.
- **A sunburst or an icicle**: both nest children inside the parent, so the same
  sum problem as the treemap, and a sunburst's angles read worse than areas.
- **Colour by count or by status**: the area already says the count, and a status said by
  colour alone is not accessible; text says it.
