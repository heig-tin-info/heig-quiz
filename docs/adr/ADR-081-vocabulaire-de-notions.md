# ADR-081 — Concepts replace tags: one instance-wide, bilingual vocabulary, curated by the admin

## Status

Accepted (2026-10-08) by the product owner, in a design discussion; the
points listed in [open question 54](../spec/06-questions-ouvertes.md) remain
open. Amended the same day by the [addendum](#addendum-2026-10-08-transition-resolution-and-storage)
(transition, resolution of a typed label, storage, rights), settled with the
product owner before step 3 of #599. Not implemented: the work is tracked by a parent issue that groups #557
and #578.

Scope: what a question is classified by, who may create and change that
classification, how it is stored, and what a course declares. It does not
decide how mastery is computed nor what a student sees of it (#578, F-DRILL-05),
nor prerequisites (#457).

Relations: replaces the "Tag" entry of the [glossary](../spec/01-glossaire-et-domaine.md)
and the tags of F-QST-01, F-POOL-03 and F-STAT-04; the per-tag readings of
[ADR-041 §10](ADR-041-entrainement-espace.md) and F-DRILL-05 read concepts
instead. Uses the [LLM gateway](ADR-058-passerelle-llm.md) for the suggestions.

## Context

A tag today is a free string on a question (`question_tags`), lowercased, with
an optional description per pool (`pool_tags`, `apps/api/src/modules/pool/tags.ts`).
Each teacher writes their own: another language (`pointer` / `pointeur`),
another spelling, a plural, an abbreviation, a typo. A pool shared by several
teachers, or two pools linked to one course, end up with the same idea under
several tags, and a filter on one misses the others.

The same field also carries organisational labels (`week3`, `exam2024`,
`difficile`, `à-revoir`), which are not about what the question teaches.

The platform needs tags to be what they are on Stack Overflow: **concepts** a
question exercises. A course states the concepts its syllabus covers (#578);
the drill and, later, the student read their mastery per concept (ADR-041 §10,
F-DRILL-05); a question pool filters by them. That requires one shared
identity per concept across pools, teachers and languages.

Two extremes were rejected (see Alternatives): classification fully managed by
a model, which teachers cannot change, and the free text of today.

## Decision

1. **Concepts replace tags.** A question is classified by concepts only. Free
   organisational labels are **not kept**: what they expressed already has a
   home: the difficulty (F-QST-01), the usage history of a question in
   evaluations (ADR-038), the pool's categories, the course's templates
   (ADR-031). A need that none of these covers is a missing feature to
   discuss, not a reason to keep a second free vocabulary. The same goes
   for the **kind of task** (`lecture-de-code`, `écriture-de-code`,
   `vocabulaire`, `trace`, `débogage`…), which a fifth of today's tag links
   carry (measured 2026-10-08, #599): it is not a concept, and the product
   owner chose to drop it rather than keep it as a separate facet.

2. **A concept is a node, not a string**, after the SKOS model. It has a
   stable id; a preferred label in French and in English; aliases; a one-line
   description in each language; a status (`proposed`, `validated`, or
   `merged` into another concept). The label shown is the one of the
   reader's interface language, falling back to the other.

3. **One vocabulary for the whole instance.** Not per pool and not per
   department: Python, C/C++ and logic pools share much of their vocabulary,
   and the platform has no department entity. The top concepts of the
   hierarchy (Programming, Electronics, Management, Mathematics…) play that
   role without one.

4. **Two relations: broader and related.** *Broader* builds the hierarchy; a
   concept may have **several** broader concepts (SKOS allows a
   poly-hierarchy). *Related* is symmetric and non-hierarchical (`pointer` —
   `reference`). No cycle through *broader*. Prerequisites are not part of
   this decision (#457). A concept selected anywhere **covers its narrower
   concepts**: a course that lists `pointers` covers `pointer arithmetic`.

5. **Homonyms are told apart by a qualifier.** Identity is the id, never the
   label. A label must be unique per language **together with its
   qualifier**: `adresse (mémoire)` and `adresse (postale)`. The qualifier is
   shown only when the bare label is ambiguous. The concept picker shows each
   candidate with its broader path and description, and ranks first the
   concepts already used in the current pool or course.

6. **Aliases are curated; typos never become one.** A teacher's input is
   resolved to a concept: normalization, then exact match on labels and
   aliases, then a close match by string distance. What is stored is the
   concept's id; the typed string is discarded. An alias is a **legitimate**
   variant only (translation, synonym, accepted abbreviation, plural), worth
   showing in the picker; only the admin adds one. When the admin merges a
   proposed concept into another, its label is **dropped by default** and
   kept as an alias only on request. The normalization and the close-match
   function are pure rules in `packages/domain` (invariant 8), shared by the
   manual input, the suggestions and the curation screen.

7. **The model proposes, the teacher decides, the admin consolidates.**
   - A teacher picks existing concepts. When nothing matches, they create a
     concept in the `proposed` status and use it at once: they are never
     blocked. The model, through the gateway (ADR-058), fills the other
     language's label, the descriptions and a suggested broader concept; the
     teacher sees and may edit them.
   - From a question, a **Suggest concepts** action (#557) proposes existing
     concepts first, a new one only when none fits; nothing is written
     without the teacher's confirmation.
   - **The admin curates**: validates, renames, qualifies a homonym, merges,
     edits relations. A merge redirects every question and course from the
     merged concept to the surviving one, in one transaction, audited
     (invariant 9). The model may list probable duplicates and homonyms for
     the admin; it never changes the vocabulary on its own, so the
     classification does not drift when the model changes.

8. **A course declares its concepts.** A course's settings hold a plain list
   of concepts, built from its syllabus, edited by its owners (ADR-068). No
   chapter, target level nor weight in this first version; they would be
   columns of that list, not another model. The pool screen can filter on
   "the concepts of course X".

9. **A question's concepts are on the question, unweighted.** As tags are
   today, they belong to the question, not to its versions: a mastery
   computed later reads **today's** classification of past evidence, a
   deliberate choice (#578, point 2). No weight per (question, concept) in
   this version.

10. **Nothing changes for students here.** Concepts stay stripped by
    `toStudent` (invariant 4). Showing a course's concept labels to its
    students is decided with #578, by its own ADR.

11. **Migration of the existing tags.** A one-off pass sorts every distinct
    tag into: a concept (an existing one, or a new `proposed` one), or a tag
    that is dropped (organisational label, kind of task, noise). The model
    proposes the sorting; the admin reviews it on the curation screen before
    anything is written. `question_tags` and `pool_tags` are then dropped,
    and a pool tag's description becomes the concept's description when it
    has none. The size of this pass is to be measured on production first.

## Consequences

- One identity per concept across pools, teachers and languages: filtering,
  the drill's mastery and #578's heatmap read the same thing.
- A new entity to maintain, and a curation load on the admin: the screen of
  proposed concepts and probable duplicates is part of the feature, not a
  later improvement. If proposals pile up, the curation role may be widened
  (open question 54).
- Contracts change (invariant 7): a question carries concept ids instead of
  strings; the API and the MCP tools (ADR-022), which take tag strings today,
  accept labels and resolve them with the rule of §6, creating a `proposed`
  concept for an unknown one, so an MCP client keeps working.
- Code touched: the pool module (`tags.ts`, `questionWrite.ts`,
  `questionList.ts`, `move.ts`, `memberRoutes.ts`), the drill
  (`review.ts`, `teacher.ts`), the web tag input (`TagInput.tsx`) and the
  pool's Tags tab, the seed. The concept tables belong to a module of their
  own; the pool module reads them by join.
- The UI word "tag" goes away (names in open question 54); the `#` filter
  syntax stays.

## Alternatives considered

- **Fully automatic classification** (the platform tags, the teacher cannot
  change it). Rejected: not deterministic, it drifts when the model changes,
  while a syllabus needs a classification stable over years; a teacher loses
  trust at the first wrong tag they cannot fix; and granularity (`C`,
  `pointers`, `pointer arithmetic`) is a teaching choice the model cannot
  infer.
- **Free tags, as today.** Rejected: it is the cause of the problem.
- **A vocabulary per pool or per department.** Rejected: shared vocabulary
  between domains is the norm, and a department entity adds a level the
  platform does not otherwise need; the top concepts of the hierarchy do
  that job.
- **A concept as an embedding vector, relations inferred by similarity.**
  Rejected as the source of truth: opaque, not editable by a person, changes
  with the model, and propagating mastery along a cosine similarity yields
  results nobody can explain. Embeddings remain a possible tool to *propose*
  duplicates or relations, if a prompt holding the whole vocabulary no
  longer suffices; no pgvector until then.
- **Keeping organisational labels beside concepts.** Rejected for now (§1):
  each known use has a better home.
- **A closed "kind of task" facet** (read, write, trace, debug code…), the
  third axis found in the production tags. Rejected by the product owner
  (2026-10-08): only real concepts are kept.

## Addendum 2026-10-08: transition, resolution and storage

Settled with the product owner after the challenge of step 3 of #599. It
amends §6, §7 and §11 where named; the rest stands.

1. **Transition in four merges, production coherent after each.**
   (a) The registry alone, connected to nothing: tags stay the source of
   truth. (b) The sorting of the existing tags, proposed by the model and
   reviewed by the admin in production, stored keyed by **(pool, tag)**, not
   as a global map, so a homonym (`pile`) can go to two concepts. (c) One
   **cut-over**: the question links are filled from the reviewed sorting
   (tags added since are listed, never silently dropped); questions, the MCP
   tools, the pool filter and Tags tab, move and copy, polls and the drill
   switch to concepts together; `question_tags` and `pool_tags` are frozen.
   (d) The two tables are dropped one release later. Until (c) no question
   write creates a concept, so the dropped labels (§1) never reach the
   vocabulary. This orders §11.
2. **Resolving a typed label (amends §6).** An id, or a label written with
   its qualifier (`adresse (mémoire)`), resolves directly. One exact match
   (same key, through a label or an alias of a concept that is not merged)
   resolves. **Several exact matches** — homonyms, or an alias shared by two
   concepts — are refused with the candidates (`422 concept_ambiguous`). A
   **close match only** is refused with the "did you mean" candidates
   (`422 concept_unknown`), unless the caller explicitly asks to create a
   new concept. No match, with creation asked: a `proposed` concept. The
   same rule serves the web picker and the MCP tools.
3. **Storage.** A concept has a label, a qualifier and a description per
   language; a `proposed` concept may have one language only (the creator's
   interface language; the model fills the other later, never inside a
   question write). Uniqueness is on the **key** (`conceptKey`) of label and
   qualifier, per language, among concepts that are not merged, enforced by
   a database index, so two teachers creating `pointeur` and `Pointeurs` at
   the same time cannot both succeed. A stored key is recomputed by a
   migration when the key rule changes. Aliases are not unique across
   concepts; a collision falls under the ambiguity rule. A merged concept is
   kept with `merged_into`, always pointing at the final concept; an old id
   follows it.
4. **Ownership.** The `concept` module owns the concepts, their aliases and
   relations, and the links to questions and courses, since a merge rewrites
   them in one transaction. The pool module sets a question's concepts by
   calling the concept service inside its transaction, and reads by join.
5. **Rights (settles open question 54 (c)).** Any teacher (and an MCP token
   acting as one) creates a `proposed` concept; its creator and the admin
   edit it while it is proposed; once validated, only the admin edits it.
   Validate, alias, merge and relations are the admin's. Every teacher reads
   the whole vocabulary, proposed concepts included, so as not to recreate
   one; a usage count is computed over the pools the reader can reach
   (ADR-013), never instance-wide. Creating and editing a concept are
   audited.
6. **A pool editor no longer documents a tag.** The description of a
   validated concept is the admin's; the product owner accepts losing the
   per-pool tag description (`PATCH /pools/:id/tags/:tag`) at the cut-over.
   [ADR-017 §5](ADR-017-deplacement-de-question.md) ("the vocabulary is
   taught" to the target pool) becomes obsolete at the same moment.
7. **The MCP tools' descriptions** say that concepts are what a question
   exercises — not organisational labels nor kinds of task — so that an LLM
   client does not recreate what §1 dropped.
