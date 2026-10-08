# ADR-081 — Concepts replace tags: one instance-wide, bilingual vocabulary, curated by the admin

## Status

Accepted (2026-10-08) by the product owner, in a design discussion; the
points listed in [open question 54](../spec/06-questions-ouvertes.md) remain
open. Not implemented: the work is tracked by a parent issue that groups #557
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
   discuss, not a reason to keep a second free vocabulary.

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
    tag into: a concept (an existing one, or a new `proposed` one), metadata
    already held elsewhere (difficulty, category), or noise. The model
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
