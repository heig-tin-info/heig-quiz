# ADR-081 — Concepts replace tags: one instance-wide, bilingual vocabulary, curated by the admin

## Status

Accepted (2026-10-08) by the product owner; consolidated on 2026-11-08 from
six addenda and the amendment of 2026-10-13, changing no decision. The
[historical record](history/ADR-081-vocabulaire-de-notions.md) keeps the
original text, the four-step transition and the delivery notes (#599); the
[correspondence table](#correspondence-of-old-references) maps each old
section. [Open question 54](../spec/06-questions-ouvertes.md) stays open. The
tag sorting is retired and the tag tables dropped
([The tag sorting, withdrawn](#the-tag-sorting-withdrawn)).
[ADR-114](ADR-114-relations-proposees-entre-notions.md) proposes relations to
the admin and defers §7's suggested broader concept;
[ADR-115](ADR-115-revision-ciblee-par-notion.md) amends [Mastery](#mastery)
(targeted revision by concept);
[ADR-116](ADR-116-carte-des-notions-d-une-banque.md) amends the pool's Notions
tab and [Coverage](#coverage-of-narrower-concepts) (covered counts, the
hierarchy map); [ADR-098](ADR-098-maitrise-des-notions-par-l-etudiant.md) is
the student's own mastery.

Scope: what a question is classified by, who may create and change that
classification, how it is stored, and what a course declares. It does not
decide how mastery is computed nor what a student sees of it (#578, F-DRILL-05),
nor prerequisites (#457).

Relations: replaces the "Tag" entry of the [glossary](../spec/01-glossaire-et-domaine.md)
and the tags of F-QST-01, F-POOL-03 and F-STAT-04; the per-tag readings of
[ADR-041 §10](ADR-041-entrainement-espace.md) and F-DRILL-05 read concepts
instead. Uses the [LLM gateway](ADR-058-passerelle-llm.md) for the suggestions.
The cut-over amends [ADR-017 §5](ADR-017-deplacement-de-question.md)
(a moved question's concepts travel, nothing is taught to the target pool),
the tag wording of [ADR-013 §1](ADR-013-partage-des-pools.md), the
interleaving and mastery of [ADR-041](ADR-041-entrainement-espace.md) §6,
§10, §12 and §15, and the pool search of [ADR-080](ADR-080-assistant-enseignant.md)'s
P2b amendment.

## Context

A tag was a free string on a question (`question_tags`), lowercased, with
an optional description per pool (`pool_tags`). Each teacher wrote their own:
another language (`pointer` / `pointeur`), another spelling, a plural, an
abbreviation, a typo. A pool shared by several teachers, or two pools linked
to one course, ended up with the same idea under several tags, and a filter
on one missed the others. The same field also carried organisational labels
(`week3`, `exam2024`, `difficile`, `à-revoir`), which are not about what the
question teaches.

The platform needs tags to be what they are on Stack Overflow: **concepts** a
question exercises. A course states the concepts its syllabus covers (#578);
the drill and the student read their mastery per concept (ADR-041 §10,
F-DRILL-05); a question pool filters by them. That requires one shared
identity per concept across pools, teachers and languages.

## Decision

### Principles

Cited by number; the sections below make them precise.

1. **Concepts replace tags.** A question is classified by concepts only. Free
   organisational labels are **not kept**: what they expressed already has a
   home: the difficulty (F-QST-01), the usage history of a question in
   evaluations (ADR-038), the pool's categories, the course's templates
   (ADR-031). A need that none of these covers is a missing feature to
   discuss, not a reason to keep a second free vocabulary. The same goes
   for the **kind of task** (`lecture-de-code`, `écriture-de-code`,
   `vocabulaire`, `trace`, `débogage`…), which a fifth of the tag links
   carried (measured 2026-10-08, #599): it is not a concept, and the product
   owner chose to drop it rather than keep it as a separate facet. The MCP
   tools' descriptions say that concepts are what a question exercises — not
   organisational labels nor kinds of task — so that an LLM client does not
   recreate what this point drops.

2. **A concept is a node, not a string**, after the SKOS model. It has a
   stable id; a preferred label in French and in English; aliases; a one-line
   description in each language; a status (`proposed`, `validated`, or
   `merged` into another concept). The label shown is the one of the
   reader's interface language, falling back to the other. UI names
   (open question 54 (a)): "Notions" in French, "Concepts" in English; the
   word "tag" is gone from the interface, the `#` filter syntax stays.

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
   concepts**: a course that lists `pointers` covers `pointer arithmetic`
   ([Coverage](#coverage-of-narrower-concepts)).

5. **Homonyms are told apart by a qualifier.** Identity is the id, never the
   label. A label must be unique per language **together with its
   qualifier**: `adresse (mémoire)` and `adresse (postale)`. The qualifier is
   shown only when the bare label is ambiguous, except in the picker, which
   shows a concept's qualifier wherever it has one (only homonyms carry
   one). The concept picker shows each candidate with its broader path and
   description, and ranks first the concepts already used in the current
   pool or course.

6. **Aliases are curated; typos never become one.** A teacher's input is
   resolved to a concept ([Resolving a typed label](#resolving-a-typed-label)).
   What is stored is the concept's id; the typed string is discarded. An
   alias is a **legitimate** variant only (translation, synonym, accepted
   abbreviation, plural), worth showing in the picker; only the admin adds
   one. When the admin merges a proposed concept into another, its label is
   **dropped by default** and kept as an alias only on request. The
   normalization and the close-match function are pure rules in
   `packages/domain` (invariant 8), shared by the manual input, the
   suggestions and the curation screen.

7. **The model proposes, the teacher decides, the admin consolidates.**
   - A teacher picks existing concepts. When nothing matches, they create a
     concept in the `proposed` status and use it at once: they are never
     blocked. The model, through the gateway (ADR-058), may fill the other
     language's label and the descriptions; the person sees and may edit
     them. Built so far on the admin's sheet only
     ([Fill with AI](#fill-with-ai-on-the-admins-sheet)), not in the
     teacher's picker; a suggested broader concept is deferred
     ([ADR-114 §3](ADR-114-relations-proposees-entre-notions.md#decision)).
   - From a question, a **Suggest concepts** action (#557) proposes existing
     concepts first, a new one only when none fits; nothing is written
     without the teacher's confirmation ([Suggest concepts](#suggest-concepts)).
   - **The admin curates**: validates, renames, qualifies a homonym, merges,
     edits relations ([Curation](#curation-by-the-admin)). A merge redirects
     every question and course from the merged concept to the surviving one,
     in one transaction, audited (invariant 9). The model may list probable
     duplicates and homonyms for the admin; it never changes the vocabulary
     on its own, so the classification does not drift when the model changes.

8. **A course declares its concepts**: a plain list, built from its
   syllabus, edited by its owners
   (ADR-068), with no chapter, target level nor weight
   ([The concepts of a course](#the-concepts-of-a-course)). The pool screen
   can filter on "the concepts of course X".

9. **A question's concepts are on the question, unweighted.** Like the tags
   they replaced, they belong to the question, not to its versions: a mastery
   reads **today's** classification of past evidence, a deliberate choice
   (#578, point 2). No weight per (question, concept) in this version.

10. **Nothing changes for students here.** Concepts stay stripped by
    `toStudent` (invariant 4). Showing a course's concept labels to its
    students is decided by its own ADR
    ([ADR-098](ADR-098-maitrise-des-notions-par-l-etudiant.md)).

11. **The existing tags were migrated once, then dropped.** Every distinct
    tag was sorted, per (pool, tag), into a concept or a drop (organisational
    label, kind of task, noise), proposed by the model and reviewed by the
    admin; the question links were filled from that sorting and the two tag
    tables dropped. Only the drops survive, as a stop list
    ([The tag sorting, withdrawn](#the-tag-sorting-withdrawn)).

### Resolving a typed label

The rule serves the web picker, the question writes and the MCP tools alike.
Normalization first (`conceptKey`). An id, or a label written with its
qualifier (`adresse (mémoire)`), resolves directly. Typed input is matched by
key against the bare labels **and** the aliases of the live (not merged)
concepts as one set (`resolveConceptLabel`): one exact match resolves.
**Several exact matches** — homonyms, or an alias shared by two concepts —
are refused with the candidates (`422 concept_ambiguous`). A **close match
only** (string distance within `keyDistance`) is refused with the "did you
mean" candidates (`422 concept_unknown`).

**Creation is explicit.** A label that matches no concept is refused
(`422 concept_unknown`) unless the caller asks to create; the MCP tools take
an explicit flag, false by default. No match, with creation asked: a
`proposed` concept. **Dropped labels stay dropped:** a label whose key is on
the stop list is refused even when creation is asked (`422 concept_dropped`),
so neither a teacher nor an LLM client recreates `c01`, `lecture-de-code` or
`prog-c`; renaming a concept's label onto such a key is refused too. Because
the stop list is instance-wide while the sorting was decided by pool, it holds
real concept names dropped in one pool only (`c`, `logique`, `physique`,
`calcul`, `trace`), hence two exemptions: a label with a qualifier is never
refused ("Trace (matrice)"); and the admin, curator of the vocabulary, is not
bound when creating or editing a concept (`POST` and `PATCH /concepts`, and
the picker's preview). A question write — the editor, the bulk bar, an MCP
tool — stays bound for everyone. An edit is refused only when it changes a
side's key and leaves it on the list; a side already there whose key stays (a
concept older than the drop) may still be edited. The stop list is not
consulted for an alias: an alias is a curated decision, and
`concept_dropped` only answers an input that designates nothing, so an alias
on a dropped tag's key resolves.

Creating a question with a `tags` field (a client from before the cut-over)
is a `400 validation`, through the MCP tool as through the route, rather than
a question silently without its tags.

### Storage, ownership and rights

- **Storage.** A concept has a label, a qualifier and a description per
  language; a `proposed` concept may have one language only (the creator's
  interface language; the model fills the other later, never inside a
  question write). A **validated** concept has both labels (validating one
  without is a 422 `concept_label_missing` naming the language). Uniqueness is
  on the key of label and qualifier, per language, among concepts that are
  not merged, enforced by a database index, so two teachers creating
  `pointeur` and `Pointeurs` at the same time cannot both succeed. A stored
  key is recomputed by a migration when the key rule changes. Aliases are not
  unique across concepts; a collision falls under the ambiguity rule. A merged
  concept is kept with `merged_into`, always pointing at the final concept; an
  old id follows it.
- **Ownership.** The `concept` module owns the concepts, their aliases and
  relations, and the links to questions (`question_concepts`) and courses
  (`course_concepts`), since a merge rewrites them in one transaction. The
  pool module sets a question's concepts by calling the concept service
  inside its transaction, and reads by join; the `org` module does the same
  for a course's list. No other module writes these tables.
- **Rights (open question 54 (c)).** Any teacher (and an MCP token acting as
  one) creates a `proposed` concept; its creator and the admin edit it while
  it is proposed; once validated, only the admin edits it. Validate, alias,
  merge, delete and relations are the admin's, on the admin role (they read
  nobody's content). Every teacher reads the whole vocabulary, proposed
  concepts included, so as not to recreate one; a usage count shown to a
  teacher is computed over the pools the reader can reach (ADR-013), never
  instance-wide. Proposing, editing, validating and deleting a concept are
  audited (`concept.propose`, `concept.edit`, `concept.validate`,
  `concept.delete`).
- **Deletion.** A concept used by a question or listed by a course is never
  deleted, only merged; an unused one may be deleted by the admin
  (`DELETE /admin/concepts/:id`, 409 `concept_in_use` otherwise), and its
  aliases and relations cascade. No migration deletes data of concepts: a
  stray concept (one born of a kind-of-task tag) is deleted through that route
  once unused, after the product owner's reviewed one-off SQL has unlinked it.

### Filtering, the pool's Notions tab and the drill

- **Filter and links.** A typed `#word` resolves to every concept it may
  designate (both languages, aliases, the qualified form) and filters on any
  of them, widened to their narrower concepts
  ([Coverage](#coverage-of-narrower-concepts)); the URL carries concept ids,
  and an old `?tag=` is resolved once like a typed word.
- **The pool's Notions tab** is read-only: the concepts used in the pool,
  each opening the filter. A pool editor no longer documents a tag: the
  description of a validated concept is the admin's, and the per-pool tag
  description (`PATCH /pools/:id/tags/:tag`) is gone. The bulk bar adds a
  concept. *Amended 2026-10-15 by
  [ADR-116](ADR-116-carte-des-notions-d-une-banque.md): a concept's count is
  its covered count, the questions its click opens (its own and its narrower
  concepts'), and the tab's second reading is a map of the hierarchy, one
  level per view.*
- **Move and copy** carry a question's concepts; nothing is taught to the
  target pool ([ADR-017 §5](ADR-017-deplacement-de-question.md) is obsolete
  on that point).
- **The question editor's picker** creates a `proposed` concept: a label in
  the interface language and an optional qualifier; the concepts already used
  in the pool, and those of the courses the pool offers as filters, rank
  first (§5).
- **The drill** interleaves by the question's first concept id (no
  alphabetical meaning left) and reads mastery per concept, labelled in the
  reader's language; past reviews are regrouped under today's classification
  (§9).

### Curation by the admin

The curation screen (`/admin/concepts`) is the administration's "Notions" /
"Concepts" tab.

- **The queue.** `GET /admin/concepts` lists the concepts that are not
  merged, `proposed` first, with the instance-wide number of **live**
  questions using each (a deleted question is not counted, though its link
  still refuses a deletion; the route also says whether the concept is
  deletable, `conceptReferenced`). An admin without Super Powers reads this
  number; pool names and statements are not in the payload and need Super
  Powers ([ADR-054](ADR-054-super-powers-admin.md), amended). There is no
  split of a polysemous concept and no "reject" action in v1: an unwanted
  proposal is deleted when unused, or merged.
- **Merge** (`POST /admin/concepts/:id/merge`, `concept/merge.ts`) only into a
  validated target (422 `concept_merge_target_not_validated`), which keeps its
  labels. The links are rewritten in one audited transaction: duplicate links
  collapse, earlier `merged_into` chains are re-pointed, soft-deleted
  questions are included; `setQuestionConcepts` and `copyQuestionConcepts`
  share-lock in id order against the merge's `FOR UPDATE`. The course links
  are rewritten in the same transaction (insert-select on conflict do nothing,
  then delete): a course listing both concepts keeps one. The audit
  `concept.merge` records the loser's former status, the question ids moved
  or already linked, `coursesMoved` and `coursesAlreadyListed`, and the
  alias and relation changes below. There is no undo button.
- **Aliases** have no language. Only the admin adds or removes one
  (`POST /admin/concepts/:id/aliases` `{ alias, force? }`,
  `DELETE …/aliases/:alias`, the text; the server computes the key), audited
  `concept.alias_add` (with the forced flag and the colliding ids) and
  `concept.alias_remove`. Table `concept_aliases`, primary key (concept, key
  of the text), the text kept as written; `Concept` carries
  `aliases: string[]` so the picker resolves like the server. An alias equal
  to another live concept's label or alias is a 409 `alias_collision` naming
  those concepts until resent with `force` (`checkAlias`, `@quiz/domain`);
  equal to the concept's own label it is a 422 `alias_redundant`, to its own
  alias a 409 `alias_exists`. Mirror rule: a label given to a concept
  (creation or rename) that another live concept answers to as an alias is
  refused like a taken label (409 `concept_exists`, the holder named). An
  alias never becomes a label and questions store only the id. Rename creates
  no alias. On a merge (`mergedAliases`, `@quiz/domain`) the loser's aliases
  move to the winner always (one the winner answers to is dropped), and with
  `keepAsAlias` its labels, qualified when they are, become aliases too;
  `keepAsAlias` is required in the body and the dialog's checkbox starts off
  (§6). The audit records `aliasesMoved`, `aliasesAdded` and
  `aliasesDropped`. The catalogue search (ADR-095 §6) does not read aliases
  in v1.
- **Probable duplicates** are proposed from labels and qualifiers only, when
  the admin asks, as an ephemeral result never written automatically.
  A deterministic pass, `probableDuplicates` (`@quiz/domain`), runs in the
  browser on the queue's list and pairs the live concepts, one reason per
  pair, the first that holds: `alias` (a label's key is the other's alias
  key), `translation` (the qualified key of the French label of one is that of
  the English label of the other), `homonym` (one bare label in one language
  under different qualifiers: "check the qualifiers", never offered for a
  merge) and `close` (two labels within `keyDistance`, not equal). It compares
  every pair, so it is for hundreds of concepts, not more.
  The model on demand, `POST /admin/concepts/duplicates/ai` (admin, no body,
  `LLM_CALLS_PER_MINUTE` a minute per admin, then the gateway's daily cap), is
  the secondary action "Ask the AI" under the deterministic pairs, purpose
  `concepts` (the default model, `effort: medium`, 3000 output tokens at
  most). **What leaves** (open question 43): one line per live concept,
  `c<n> | fr: label (qualifier) | en: label (qualifier)`, each field cut to
  one line without `|`: no description, alias, id, creator, question or pool;
  at most 1000 concepts, the proposed ones first then the newest; past that
  the response says `truncated` and the hint says the oldest validated
  concepts were left out. The model files each pair under `close`,
  `translation`, `homonym` or `related` (distinct but connected, offered as
  "Add as related"); `homonym` and `related` are never offered for a merge,
  and the reason is written in the admin's language. The reply is validated
  by zod, then strictly: an index not sent, an unknown kind, a pair of one
  concept, a repeated pair or an empty reason is dropped; at most 50 pairs and
  200 characters of reason are kept; the browser drops a pair the
  deterministic pass lists. Nothing is stored and no concept is written; the
  `llm_calls` row is the only trace, and the failures are the gateway's
  (`llm_not_configured`, `llm_budget_exhausted`, `rate_limited`,
  `llm_failed`).

#### Fill with AI on the admin's sheet

Settled on 2026-10-13 (#817): the model's fill of §7, on the admin's concept
sheet only (the teacher's picker is a later step; the suggested broader
concept is not part of it).

1. **Surface.** A secondary **Fill with AI** button on the concept sheet;
   Save stays the primary action. Shown only when the platform has a model
   (`GET /generate/availability`), enabled when the form holds a label and has
   an empty label or description.
2. **What leaves (open question 43).** The sheet's form as it stands, saved
   or not: this concept's labels, qualifiers and descriptions in both
   languages, nothing else — no id, alias, relation, question, pool,
   journal, course or person.
3. **The route.** `POST /app/api/admin/concepts/:id/fill`, the admin's,
   under the purpose `concepts` (the gateway's cap, the `llm_calls` ledger,
   the same per-minute budget as the probable duplicates). Nothing is stored
   and nothing is audited: the proposal goes back to the sheet. A form with no
   empty field makes no call; one without any label is a 422
   `concept_label_missing`; a merged concept a 409 `concept_merged`.
4. **Only empty fields, never an overwrite.** The model proposes a label
   (with the translation of the qualifier when the other language has one)
   only for an empty label, a description only for an empty one, clamped to
   `CONCEPT_LABEL_MAX`, `CONCEPT_QUALIFIER_MAX` and
   `CONCEPT_DESCRIPTION_MAX`. The sheet puts them in the fields still empty
   when the answer arrives; what the admin typed meanwhile wins.
5. **A proposed label goes through the resolver** (`resolveConceptLabel`,
   against the vocabulary less this concept): one that already names another
   concept comes back as `taken` and is NOT put in the form — the sheet says
   "did you mean" that concept, this one being perhaps its duplicate, instead
   of a 409 `concept_exists` on Save; one only close to some is filled, and
   the sheet names them.
6. **The sheet's Save (`PATCH /concepts/:id`, audited `concept.edit`) is the
   only write**, unchanged.

### Relations

Broader and related edges between concepts (§4), written by the admin only.

- **Table** `concept_relations` (migration 0105): `concept_id`, `target_id`,
  `kind` (`broader` or `related`), `created_by`, `created_at`; primary key
  (concept, target, kind), index on `target_id`; both ids cascade (relations
  are not references: they never block a deletion, `conceptReferenced` is
  unchanged). A `broader` row reads "`concept_id` has `target_id` as a broader
  concept"; a `related` row is stored once with `concept_id < target_id` (a
  check), so a pair has one row whichever side was asked.
- **Rules**, pure, in `packages/domain/src/conceptRelations.ts`. Broader: no
  self edge, no duplicate, and no edge whose target is at or below the concept
  (it would close a cycle; the refusal names the shortest closed path
  `A › B › … › A`). Several broader concepts are allowed. Related: no self, no
  duplicate in either order, and **refused when one concept is in the other's
  broader chain**, near or far (the two relations are disjoint, as in SKOS);
  symmetrically a broader edge is refused between two concepts already
  `related`. Only the direct pair is checked: a related pair that a later
  broader edge puts in one chain stays, harmlessly. Codes: 422
  `relation_self`, 409 `relation_exists`, 409 `relation_redundant`, 409
  `concept_cycle` (with `path`, labelled concepts), 422 `concept_not_found`
  (the target is missing or merged), 409 `concept_merged` (the concept
  itself), 404.
- **Routes**, the admin's: `POST /admin/concepts/:id/relations`
  `{ kind, target }` and `DELETE /admin/concepts/:id/relations/:kind/:target`
  (a related pair from either side), both answering the concept, audited
  `concept.relation_add` / `concept.relation_remove`. `Concept` carries
  `broader` and `related` (ids of live concepts, sorted; a related pair
  appears on both sides) in `GET /concepts` and `GET /admin/concepts`:
  teachers read them; no student route carries a `Concept` (students get
  `ConceptRef` through the student views).
- **Lock.** Every relation write, every merge and every deletion of a concept
  first takes one transaction-scoped advisory lock
  (`pg_advisory_xact_lock` on a fixed key), since a cycle check reads the
  whole graph: two opposite edges sent together serialize and the second sees
  the first, and a deletion never meets a merge's insert (no foreign key violation, no
  deadlock). The two concepts
  are then share-locked in id order. The advisory lock always precedes any
  row lock and no writer of question or course links takes it, so there is no
  lock cycle with `lockLinkSet` or the merge's `FOR UPDATE`.
- **Merge.** In the merge's transaction, `mergedRelations` rewrites the
  loser's edges onto the winner: an edge between the two is dropped (it would
  be a self-loop), an edge the winner has is not written twice, a rewritten
  `related` edge keeps the canonical order, and a `related` edge whose pair
  becomes a broader pair (the loser was related to `x`, the winner is below
  `x`) is dropped, so the two relations stay disjoint. A rewrite that closes a
  longer cycle through the winner (the loser is below `x` and `x` below the
  winner) is refused 409
  `concept_merge_cycle` with the path BEFORE anything is written — never a
  silent deletion. The audit records `relationsOfLoser`, `relationsMoved` and
  `relationsDropped` (`broader` and `related` between the two, and
  `hierarchical` for the related edges dropped as above; `{ concept, target }`
  edge lists), enough for a reviewed SQL undo. The rewritten edges take the
  merging admin as author.
- **Web**, client-side on the loaded vocabulary with `@quiz/domain`
  functions. The concept sheet's Relations section offers, in its broader and
  related searches, only the concepts the rule would accept, each with its
  path (a broader candidate also lists the direct narrower concepts it
  "Currently holds", five then "(+n more)", which describes its button for a
  screen reader), then a read-only **Narrower concepts** list
  (`directNarrowerOf`; no name is a link: the edge belongs to the child); a
  cycle refusal names the path. The picker, the queue and the sheet's top show
  a concept's path from the root down (`Memory › Heap`), following the first
  broader concept by name (the sheet adds "+n" for the others). The queue has
  an **Unplaced** filter (no broader and no narrower concept, `unplaced`) and
  a tree reading (`conceptTree`): each concept once, indented under the
  broader concept its path follows, its other broader concepts named.

### The concepts of a course

- **A plain list.** A course declares a set of concepts: no chapter, level,
  weight or order (they would be columns of the table, not another model). It
  may list a `proposed` concept, and its Settings create one with the question
  editor's own picker, through the ordinary creation path (`POST /concepts`).
  The list is shown sorted by label, in the reader's language. Relations and
  Suggest concepts add to it without changing it.
- **Who, and where.** Staff only, never in a student payload (invariants 4
  and 6): the course is loaded under `staffAccess` (404 otherwise); every
  member reads it as `concepts` in `GET /courses/:id` (hence the MCP
  `get_course` and the teacher assistant's reads; no route of its own), and
  only an owner replaces the set (`PUT /courses/:id/concepts`
  `{ conceptIds }`, which answers the new list; 403 `owner_required` before
  the body is read; [ADR-068](ADR-068-roles-de-l-equipe-du-cours.md) §3). The
  web app shows it as a "Concepts" ("Notions") section of the course's
  Settings, editable by an owner, plain text for an assistant. Showing
  students their own mastery of it is
  [ADR-098](ADR-098-maitrise-des-notions-par-l-etudiant.md), with its own
  student exit and leak test (05 §5.7).
- **Table** `course_concepts` (migration 0104, `concept/courseConcepts.ts`):
  `course_id` (cascade with the course), `concept_id` (RESTRICT), `added_by`
  (set null), `added_at`, primary key (course, concept), index on
  `concept_id`. A write replaces the whole set in one transaction. It
  share-locks every concept it names or links (`lockLinkSet`, in id order,
  shared with `setQuestionConcepts`) and then reads the links again, so a
  merge in flight finishes first, a merge that committed meanwhile is seen,
  and a merged or unknown id is a 422 `concept_not_found`, as for a question.
  Two saves racing on a course serialize on its rows (the insert ignores a
  link the other wrote) and the last to commit wins. A link already there
  keeps its author and date. Audited as `course.concepts_update` (`added`,
  `removed`), and not at all when nothing changed. A concept a course lists
  cannot be deleted: the foreign key refuses, and `conceptReferenced` mirrors
  it.
- **The pool's course filter.** `GET /pools/:id/questions` takes
  `course=<courseId>` (`QuestionSearch.course`): the questions that exercise
  any concept the course covers, through the one function
  `conceptsCoveredByCourse`, so the course covers more than its list
  ([Coverage](#coverage-of-narrower-concepts)). A course that lists nothing
  matches nothing. **Access:** the course must be one the caller staffs
  (`staffAccess`, or any course under Super Powers) **and** that the pool is
  linked to (`course_pools`, either mode); otherwise the answer is the 404 of
  a missing entity, the same body for an unknown id, so a course the caller
  does not staff is never revealed. The pool's linked courses stay the
  owner's to see (`PoolMembers.courses`): the screen offers its own list,
  `PoolDetail.filterCourses` (`id`, `name`, `code`: the linked courses the
  caller staffs, `filterCoursesOf`), and `PoolDetail.courseConceptIds`, the
  concepts those courses cover together (one query), which the picker and the
  bulk bar rank first beside the pool's own. The poll launcher's search
  across pools has no such filter (`PollPoolSearch` omits it). **Web:** a
  "Course" ("Cours") block in the filters sheet (one course at a time, shown
  only when the pool has one on offer), a removable chip, and the search token
  `course:<code or name>` (the last one wins; a word naming no course on offer
  is a dashed chip that filters nothing, as for a concept). The MCP
  `list_questions` takes `courseId` under the same rule.

### Coverage of narrower concepts

The rule of §4 is in force: a concept selected anywhere covers its narrower
ones, near or far, through any number of parents. One rule, `coverageOf` of
`@quiz/domain`, gives per concept `[id, ...narrowerDescendants]`; one loader,
`coverage(db, conceptIds)` (`concept/courseConcepts.ts`), reads the `broader`
edges once and applies it; `coveredConcepts` is the union. Only `broader`
edges widen it: a `related` concept is never covered, and a merged concept's
edges were rewritten onto its winner. Every reader goes through it:

- the pool's concept filter (`QuestionSearch.concept`, a typed `#word`) and
  the poll launcher's search across pools, which share `filterWhere`, widen
  the selected ids at their entry points (`withCoveredConcepts`,
  `pool/questionList.ts`); the MCP `list_questions` `concepts` filter calls
  the same route, and its description says so;
- the course filter, `PoolDetail.courseConceptIds` and the teacher's mastery
  use `conceptsCoveredByCourse` or `coverage`: a card of a narrower concept
  counts toward the listed broader one; the pool's concept map applies the
  rule to the edges it reads (ADR-116 §1);
- **not widened, by design:** the pool catalogue's text search (a word
  matched against concept labels, not a concept selected), the concept
  suggestions and the drill's per-card concept (a question's own concepts),
  and the question editor's picker (it chooses a link, which stays exact);
- the web mock applies the same domain function; the course filter hint says
  narrower concepts are included.

### Suggest concepts

It lives in the editor's AI card ([ADR-082](ADR-082-carte-ia-de-l-editeur.md)
§5 and its amendment of 2026-10-10), not beside the picker, and is hidden when
no model is configured. At most five existing concepts and two new labels come
back; a new label goes through the explicit create form.

- **Route and access.** `POST /app/api/questions/:id/suggest-concepts`
  `{ config }` (contracts `SuggestConceptsRequest`, strict), a pool
  contributor's like the "Generate answers" wand (a reader 403, an outsider
  404); the question's type is the server's. Ten calls a minute per teacher
  (`LLM_CALLS_PER_MINUTE`), then the gateway's daily cap; errors are
  `llmArms`'. A draft that does not parse, or whose statement is empty, is a
  400 `statement_empty` before any model is asked.
- **Purpose and model.** Purpose `suggest` of `LLM_PURPOSES`, on the default
  model of the settings: choosing among hundreds of bilingual labels is a
  judgement the fast model would make worse, and the call is rare and asked
  for by a person.
- **What leaves (open question 43).** The draft's excerpt, cut at 6 000
  characters (`questionExcerpt`), read from the type's student view, never
  from the key: the top-level `prompt` (or a cloze's `template`, blanks shown
  as `___`) and the `text` or `label` of the items of the view's top-level
  lists (a multiple-choice question's choices without which are correct, a
  categorize question's columns and cards, a program's template segments).
  Never the internal name, the explanation, the answer key, a short answer's
  accepted answers or a hidden case. Then one line
  `cN | fr: label (qualifier) | en: label` per live concept not already on the
  question (validated first, then oldest, at most 1 000), with no id,
  description, alias, count or creator.
- **Reply, validated against the vocabulary read again after the call.**
  Indexes the call did not send are dropped; a concept merged meanwhile is
  followed to its winner; one already on the question, a repeat, or an empty
  reason is dropped; at most five existing. Each "new" label goes through the
  resolver: one exact match (label or alias) becomes that existing
  suggestion, a close match only becomes a "did you mean" existing suggestion
  (`asked` carries what the model typed), an ambiguous one is dropped, a key on
  the stop list is discarded, and what is left is a new label (at most two,
  one per key). A new label travels as `{ label, qualifier }`, each within its
  maximum, and so does the `asked` of a "did you mean".
- **Nothing is stored** and no concept is created: the `llm_calls` row is the
  only trace. The editor ticks the existing concepts (the question's own
  concept write, like the picker) and a new label opens the picker's create
  form filled in.

### Mastery

- **The teacher's mastery on the course's concepts.**
  `GET /classrooms/:id/drill/mastery` answers `DrillClassroomMastery`
  (`packages/contracts/src/drill.ts` owns the shape): the course's concepts
  with coverage, "no evidence" rows and an "outside the course" bucket, with
  no student by concept matrix in v1 and nothing for a student. Counting is
  the pure `drillMastery` of `@quiz/domain`, callable for one student: a card
  counts toward **every** listed concept that covers one of its question's
  concepts; a listed concept nothing counts toward is a line without evidence
  (null, never 0 %); cards no listed concept covers, or without concept, go to
  the outside bucket, line by concept. A course listing no concept gets the
  flat per-concept view, and the screen says to declare them in its Settings.
  **Suspended cards are excluded**, through `keyOpen` of `drill/review.ts`,
  the one loader of "may this card's key reach its student" that also serves
  the drill, so the teacher and the student (ADR-098 §7) agree, **pending the
  product owner's confirmation**.
- **The student's mastery** (F-DRILL-05) is
  [ADR-098](ADR-098-maitrise-des-notions-par-l-etudiant.md), which this record
  constrained beforehand: course concepts only, rolled up, validated concepts
  only; a level only from five reviewed cards, otherwise "no data yet"; no
  class comparison or ranking and no "Practise this concept" button (ADR-041
  §6 and §11 stand); FSRS fading is accepted. *Amended by ADR-115
  (2026-10-15): practice by concept exists as targeted revision — the
  course's validated concepts, the student's own cards covering them through
  `coverage`, outside FSRS and the level.*

### The tag sorting, withdrawn

Folds the second addendum (2026-10-08) and the fourth (2026-10-10); their text
is in the [historical record](history/ADR-081-vocabulaire-de-notions.md#second-addendum-2026-10-08-sorting-the-existing-tags).
The existing tags were sorted once, per (pool, tag) in `concept_tag_sortings`,
by a model pass the admin started and then reviewed, under a scoped exception
to ADR-054 §2 (the admin role without Super Powers saw tag names, pool names
and statement excerpts). The cut-over filled the question links from that
sorting by a SQL data migration, and step (d) retired it: `question_tags` and
`pool_tags` are dropped (migration 0098), the sorting screen, its routes
(`/admin/concept-sorting`), its job, the LLM purpose `sort` and the audit kinds
`concept.sort` and `concept.sort_propose` are removed (past audit rows keep
their action strings), and with them the ADR-054 exception. A tag nobody
sorted before the drop is gone. **Only the stop list remains:** the `drop`
rows of `concept_tag_sortings`, frozen (migration 0102 dropped the columns
only the other rows used), feed `concept_dropped`
([Resolving a typed label](#resolving-a-typed-label)).

## Consequences

- One identity per concept across pools, teachers and languages: filtering,
  the drill's mastery and #578's heatmap read the same thing.
- A new entity to maintain, and a curation load on the admin: the curation
  screen is part of the feature, not a later improvement. If proposals pile
  up, the curation role may be widened (open question 54).
- Contracts changed (invariant 7): a question carries concept ids instead of
  strings; the API and the MCP tools (ADR-022) accept labels and resolve them
  with the rule of [Resolving a typed label](#resolving-a-typed-label),
  creating a concept only when explicitly asked.

## Alternatives considered

- **Fully automatic classification** (the platform tags, the teacher cannot
  change it). Rejected: not deterministic, it drifts when the model changes,
  while a syllabus needs a classification stable over years; a teacher loses
  trust at the first wrong tag they cannot fix; and granularity (`C`,
  `pointers`, `pointer arithmetic`) is a teaching choice the model cannot
  infer.
- **Free tags, as before.** Rejected: it is the cause of the problem.
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
- **A dual write of tags and concepts during the transition.** Rejected: a
  typed tag would either have created a concept before the cut-over or been
  lost; one cut-over switched every reader and writer together.

## Correspondence of old references

Code and other records cite the addenda by number. Their full text is the
[historical record](history/ADR-081-vocabulaire-de-notions.md); a citation
now lives here:

<a id="addendum-2026-10-08-transition-resolution-and-storage"></a><a id="second-addendum-2026-10-08-sorting-the-existing-tags"></a><a id="third-addendum-2026-10-08-the-cut-over"></a><a id="fourth-addendum-2026-10-10-the-tag-sorting-is-retired"></a><a id="fifth-addendum-2026-10-10-the-curation-of-the-vocabulary"></a><a id="sixth-addendum-2026-10-10-the-concepts-of-a-course-steps-7-9"></a><a id="amendment-2026-10-13-fill-with-ai-on-the-admins-sheet"></a>

| Old reference | Current section |
| --- | --- |
| Decision §1–§10 | [Principles](#principles), same numbers |
| Decision §11 (migration of the tags) | [Principles](#principles) §11, [The tag sorting, withdrawn](#the-tag-sorting-withdrawn) |
| Addendum §1 (transition in four merges) | Historical; outcome in §11 and [The tag sorting, withdrawn](#the-tag-sorting-withdrawn) |
| Addendum §2 (resolving a typed label) | [Resolving a typed label](#resolving-a-typed-label) |
| Addendum §3–§5 (storage, ownership, rights) | [Storage, ownership and rights](#storage-ownership-and-rights) |
| Addendum §6 (no per-pool tag description) | [Filtering, the pool's Notions tab and the drill](#filtering-the-pools-notions-tab-and-the-drill) |
| Addendum §7 (MCP tools' descriptions) | [Principles](#principles) §1 |
| Second addendum §1–§5 (tag sorting, its exception to ADR-054, its audit) | [The tag sorting, withdrawn](#the-tag-sorting-withdrawn); "a validated concept has both labels" in [Storage](#storage-ownership-and-rights) |
| Second addendum §6 (UI names) | [Principles](#principles) §2 |
| Third addendum §1–§3 (cut-over, fill, late tags) | Historical; [The tag sorting, withdrawn](#the-tag-sorting-withdrawn) |
| Third addendum §4 (explicit creation, `concept_dropped`) | [Resolving a typed label](#resolving-a-typed-label) |
| Third addendum §5–§8 (picker, Notions tab, filter, drill) | [Filtering, the pool's Notions tab and the drill](#filtering-the-pools-notions-tab-and-the-drill); qualifier in the picker: §5 |
| Fourth addendum §1–§3 | [The tag sorting, withdrawn](#the-tag-sorting-withdrawn) |
| Fourth addendum §4 (stray concepts) | [Storage, ownership and rights](#storage-ownership-and-rights), Deletion |
| Fifth addendum §1–§5 (queue, merge, aliases, duplicates) | [Curation by the admin](#curation-by-the-admin) |
| Sixth addendum §1–§4 (a course's list) | [The concepts of a course](#the-concepts-of-a-course) |
| Sixth addendum §5 (relations, 7c) | [Relations](#relations) |
| Sixth addendum §6 (Suggest concepts, 8a) | [Suggest concepts](#suggest-concepts) |
| Sixth addendum §7 and §9 (mastery, 9a) | [Mastery](#mastery) |
| Sixth addendum §8 (pool course filter, 7b) | [The concepts of a course](#the-concepts-of-a-course) |
| Sixth addendum §10 (coverage, 7d) | [Coverage of narrower concepts](#coverage-of-narrower-concepts) |
| Amendment 2026-10-13 (Fill with AI) | [Fill with AI on the admin's sheet](#fill-with-ai-on-the-admins-sheet) |
