# ADR-114 — Proposed relations between concepts: a deterministic pre-pass, then the model, accepted by selection

## Status

Accepted (2026-10-15) by the product owner (decisions of 2026-10-15 on
[#897](https://github.com/yves-chevallier/heig-quiz/issues/897), step A,
and the spec challenge of the same day). Part A1 (§1, §4–§7) is
implemented; A2, the model's pass (§2), and A3, the sheet's suggestion (§3),
are to come.

Scope: how relations between concepts (`broader`, `related`) are proposed to
the administrator on the curation screen, and how they are accepted.

Relations: amends [ADR-081 §7](ADR-081-vocabulaire-de-notions.md#decision)
(the "suggested broader concept" of a teacher's new concept is deferred, §3)
and its [amendment of 2026-10-13](ADR-081-vocabulaire-de-notions.md#amendment-2026-10-13-fill-with-ai-on-the-admins-sheet)
(Fill with AI is unchanged, §3); uses the relation rules and routes of
[ADR-081, sixth addendum §5](ADR-081-vocabulaire-de-notions.md#sixth-addendum-2026-10-10-the-concepts-of-a-course-steps-7-9)
and the counting exception of [ADR-054](ADR-054-super-powers-admin.md) (amended).

## Context

The vocabulary of ADR-081 is a graph: a concept has broader concepts (a
poly-hierarchy without cycles) and related ones, and a concept selected in a
filter, a course or the mastery covers its narrower ones. Step 7c gave the
administrator a sheet to add each edge by hand, and step B of #897 made the
hierarchy visible, with an **Unplaced** filter. Placing hundreds of concepts
one sheet at a time is the bottleneck: most concepts sit unplaced, so the
coverage rule rarely applies.

Much of the hierarchy can be read off the vocabulary itself (`Arithmétique
des pointeurs` is under `Pointeur`) and off how teachers classify questions
(two concepts on many of the same questions are connected). A model can see
what spelling cannot (`Récursivité` under `Programmation`). Neither may write
the vocabulary on its own (ADR-081 §7: the model proposes, the administrator
consolidates).

## Decision

1. **A deterministic pre-pass, no model, nothing stored.** A **Relations**
   reading of the curation queue lists candidates computed on request
   (`GET /app/api/admin/concepts/relations/candidates`, the administrator's,
   no budget), in two groups shown apart from any model's proposal:
   - **Label inside another** (broader): B is proposed above A when, in one
     language, the words of B's label key (`conceptKey`, split on `-`) form a
     contiguous run of A's label words and A has strictly more words. A
     qualified B (`Adresse (mémoire)`) matches only when its qualifier's words
     are among A's label or qualifier words, so a homonym never catches
     `Adresse IP`. Only the most specific match is kept (`arithmetique-pointeur`
     rather than `pointeur` inside it). Merged concepts are ignored; nothing
     is proposed across languages. At most 100.
   - **Used together** (related): two concepts on at least 3 live questions
     together, which is at least half of the less-used one's live questions.
     At most 50, the most shared first; the SQL scan reads the 500 most
     shared pairs.
   - A candidate the graph already holds (near or far) or that the relation
     rules refuse (exists, cycle, related already, one in the other's chain)
     is dropped; a pair proposed as broader is not proposed as related; and
     the whole list is filtered so that every candidate can be accepted with
     every other (`admissible`, broader first, the first kept of two that
     clash). The rules are `@quiz/domain`'s (`containedBroader`,
     `coOccurringRelated`, `admissible`, `relationCandidatesOf`).
   - **Counts only.** The answer names concepts by id and pairs by a number of
     questions: no question id, statement, pool or person. An administrator
     reads it without Super Powers, the exception ADR-054 (amended) grants
     the queue's `questionCount`, because placing a concept is a decision
     about all of its questions.
2. **The model's pass (A2), on demand, nothing stored.** A secondary action
   of the same view asks the model, through the gateway (ADR-058, purpose
   `concepts`, the daily cap and the per-minute budget of the probable
   duplicates), for broader candidates, related pairs and missing top
   concepts. It sends the labels and qualifiers of the live concepts, a
   marker on the lines to place, and nothing else: no description, alias,
   relation, question, pool, course or person (open question 43 records the
   sentence when A2 ships). It asks a place for the **Unplaced** concepts,
   at most 40 per call, and says how many remain. Caps: about 80 broader, 30
   related and 10 top concepts per answer. A top concept is written in the
   administrator's language, resolved against the vocabulary first (an
   existing concept is proposed instead), and created `proposed` only when
   the administrator accepts a row that carries it, never validated by the
   model. Rows the graph makes redundant, and rows of the reply that conflict
   with each other, are dropped by `admissible`. The model's rows are shown
   apart from the pre-pass's.
3. **A broader concept suggested on the sheet (A3).** The concept sheet gains
   a secondary **Suggest a broader concept** action that calls the A2 route
   for that one concept. Fill with AI (amendment of 2026-10-13) is unchanged.
   ADR-081 §7's suggested broader concept for a teacher's new concept is
   deferred: relations are the administrator's.
4. **Acceptance by selection only.** Each candidate is a checkbox, nothing
   checked; the view's one primary action is **Accept the n selected**; there
   is no "accept all". The browser writes the ticked edges one at a time
   through the existing `POST /app/api/admin/concepts/:id/relations`, broader
   edges first (one may make a related pair redundant), so each edge meets
   the existing rules, lock and audit (`concept.relation_add`); a refusal is
   shown on its row (a cycle names its path) and never stops the others. No
   batch route, hence no new audit action and no migration. While ticking, a
   row that would clash with a ticked one is disabled with the reason.
5. **Rejections are not remembered.** "Dismiss" hides a row until the page is
   reloaded; nothing is stored. A remembered rejection would need a table and
   its own decision, later.
6. **Coverage follows.** An accepted broader edge widens what a concept
   covers in the filters and the mastery (ADR-081 §4, sixth addendum §10);
   that is the administrator's decision, and the view's hint says so.
7. The Duplicates view's **Add as related** on a model's `related` pair is
   unchanged and is not deduplicated against this view.

## Consequences

- The hierarchy can be built in batches from what the vocabulary and the
  questions already say, without a model, then completed by the model.
- Every edge still goes through one route and one rule set; the browser's
  pre-checks only disable rows, the server decides.
- Accepting n edges is n requests and n audit entries; acceptable for the
  tens an administrator ticks at a time.
- A dismissed candidate comes back on the next visit until a rejection list
  exists.
- Co-occurrence reveals, as counts only, how concepts are used together
  across pools the administrator may not reach, like the queue's counts.

## Alternatives considered

- **A batch route** accepting a list of edges in one transaction: one more
  write path and audit action beside the relation route, and an
  all-or-nothing failure where per-row refusals are clearer.
- **A stored proposal table**, with accepted and rejected rows: needed only
  to remember rejections, deferred (§5).
- **Sending the edges to the model**: more tokens for little gain; the graph
  filters the model's rows afterwards instead (`admissible`).
- **Embeddings** of the labels for similarity: an extra model and storage for
  what containment, co-occurrence and one model call already cover.
