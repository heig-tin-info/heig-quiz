# ADR-081 — Concepts replace tags: one instance-wide, bilingual vocabulary, curated by the admin

## Status

Accepted (2026-10-08) by the product owner, in a design discussion; the
points listed in [open question 54](../spec/06-questions-ouvertes.md) remain
open. Amended the same day by the [addendum](#addendum-2026-10-08-transition-resolution-and-storage)
(transition, resolution of a typed label, storage, rights), settled with the
product owner before step 3 of #599, and by the
[second addendum](#second-addendum-2026-10-08-sorting-the-existing-tags)
(sorting the existing tags) and the
[third addendum](#third-addendum-2026-10-08-the-cut-over) (the cut-over) and
the [fourth addendum](#fourth-addendum-2026-10-10-the-tag-sorting-is-retired)
(the tag sorting retired, step (d)) and the
[fifth addendum](#fifth-addendum-2026-10-10-the-curation-of-the-vocabulary)
(curation, step 5: its queue, the merge and the aliases are implemented; the probable duplicates are not). The work is tracked by #599, under a parent issue that groups #557
and #578. Steps (a) and (b) of the transition (addendum §1) are implemented;
the **cut-over, step (c), is implemented** by the cut-over PR of #599 (#648):
questions, the pool's filter and Notions tab, the bulk bar, move and copy,
polls, the drill, the MCP tools, the teacher assistant and the seed read and
write concepts. Step (d), dropping `question_tags` and `pool_tags`, is
implemented by the [fourth addendum](#fourth-addendum-2026-10-10-the-tag-sorting-is-retired). The links to
courses (§8), relations and the model's help in the picker (#557) are not
implemented; the curation screen and the aliases are (fifth addendum).

Scope: what a question is classified by, who may create and change that
classification, how it is stored, and what a course declares. It does not
decide how mastery is computed nor what a student sees of it (#578, F-DRILL-05),
nor prerequisites (#457).

Relations: replaces the "Tag" entry of the [glossary](../spec/01-glossaire-et-domaine.md)
and the tags of F-QST-01, F-POOL-03 and F-STAT-04; the per-tag readings of
[ADR-041 §10](ADR-041-entrainement-espace.md) and F-DRILL-05 read concepts
instead. Uses the [LLM gateway](ADR-058-passerelle-llm.md) for the suggestions.
The third addendum (the cut-over) amends [ADR-017 §5](ADR-017-deplacement-de-question.md)
(a moved question's concepts travel, nothing is taught to the target pool),
the tag wording of [ADR-013 §1](ADR-013-partage-des-pools.md), the
interleaving and mastery of [ADR-041](ADR-041-entrainement-espace.md) §6,
§10, §12 and §15, and the pool search of [ADR-080](ADR-080-assistant-enseignant.md)'s
P2b amendment.

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

## Second addendum 2026-10-08: sorting the existing tags

Settled with the product owner before step (b) of the transition
(addendum §1). It amends §11 and addendum §5 where named.

1. **The sorting is stored per (pool, tag)** in `concept_tag_sortings`,
   owned by the `concept` module: a decision (`concept`, with the concept
   it maps to, or `drop`, with a reason among `organisational`,
   `task_kind`, `noise`), the model's raw proposal, a state (`proposed`,
   `accepted`), who decided and when. It reads `question_tags` and
   `pool_tags` by join and never writes them. A pool's rows go with the
   pool. Re-running the proposal adds the pairs with no row and replaces
   `proposed` rows only, never an `accepted` one. One row maps to one
   concept at most; a homonym inside one pool is fixed by hand after the
   cut-over.
2. **Accepting a "new concept" creates it validated (amends §11).** The
   admin has just reviewed it, so a second validation pass would be the same
   work twice. A validated concept has both labels, French and English; the
   model proposes the missing one and the admin corrects it. A pool tag's
   description seeds the concept's description. Before the cut-over the
   admin may delete a concept nothing refers to; afterwards, a concept is
   merged, never deleted. A suggested broader concept stays a hint in the
   proposal; relations and aliases come with the curation screen.
3. **The model pass** is a background job started by the admin, under its
   own LLM purpose (`sort`), billed to that admin within the daily cap
   (ADR-058). A deterministic pre-pass first groups the tags of every pool
   by `conceptKey`; the model then sees the groups in sequential batches,
   each with the concepts already in the registry or proposed so far, so
   later batches map onto earlier ones. It receives, per tag: the tag, its
   count, the pool's name and the tag's description, and at most two
   question statements cut to about 300 characters, taken from the version's
   content (never the internal name). No author, course or classroom name.
   The product owner accepted this on 2026-10-08 (open question 43). The
   screen works without a model: a row then has no proposal and the admin
   decides by hand.
4. **The admin role is enough (exception to ADR-054 §2).** The sorting
   screen shows the tag names, pool names and statement excerpts of every
   pool, private ones included, to an admin without Super Powers. The
   product owner chose this exception on 2026-10-08: the sorting is a
   one-off curation of the instance's vocabulary, not the reading of a
   colleague's work, and it shows excerpts, never a whole question. It
   covers the sorting routes only.
5. **Audit.** Accepting or changing a decision (`concept.sort`, with the
   pairs and decisions), validating a concept (`concept.validate`) and
   deleting an unused one (`concept.delete`) are audited.
6. **UI names (settles open question 54 (a)):** "Notions" in French,
   "Concepts" in English. The admin screen is a "Notions" / "Concepts" tab
   of the administration; its one primary action is accepting the selected
   decisions.

## Third addendum 2026-10-08: the cut-over

Settled with the product owner after the sorting was completed in
production (686 pairs, 219 validated concepts) and before step (c). It
amends addendum §2, §1(c) and (d), second addendum §2 and the Consequences
where named.

1. **One cut-over PR, prepared by inert ones.** A dual write of tags and
   concepts is not coherent: a typed tag would either create a concept
   (which §1 forbids before the cut-over) or be lost. So the link table, the
   write resolution and the picker land first, connected to nothing; then
   one PR switches every reader and writer together — pool list, filter,
   question editor, bulk bar, move and copy, polls, the drill, the MCP tools,
   the teacher assistant (ADR-080), the seed, the user guide.
2. **The fill is a SQL data migration** of the cut-over: every live
   question gets the concepts its (pool, tag) pairs were accepted into
   (following `merged_into`). Pairs worn only by deleted questions are not
   carried over.
3. **Late tags are listed, never lost (amends §1(c), (d)).** The Notions
   tab keeps listing the pairs worn by a question with no accepted decision;
   accepting one after the cut-over adds its links to the questions still
   wearing that tag. Rows already accepted become read-only at the cut-over,
   so re-applying a decision never overwrites a teacher's later edits.
   `question_tags` and `pool_tags` are dropped only once no pair is pending.
4. **Creation is explicit, and dropped labels stay dropped (amends
   addendum §2 and the Consequences).** A label that matches no concept is
   refused (`422 concept_unknown`) unless the caller asks to create; the
   MCP tools take an explicit flag, false by default. A label whose key is
   the key of a tag the admin dropped in the sorting is refused even when
   creation is asked (`422 concept_dropped`), so neither a teacher nor an
   LLM client recreates `c01`, `lecture-de-code` or `prog-c`. Renaming a
   concept's label onto such a key is refused too. The
   Consequences' "creating a proposed concept for an unknown one" no longer
   holds. *Amended the same day by the product owner, on the challenge of
   the cut-over PR:* the list of dropped keys is instance-wide while the
   sorting was decided by pool, so it held real concept names (`c`,
   `logique`, `physique`, `calcul`, `trace`) dropped in one pool only. Two
   exemptions follow. A label with a qualifier is never refused: the
   qualifier tells the concept apart from the dropped tag ("Trace
   (matrice)"). The admin, curator of the vocabulary (§7), is not bound when
   creating or editing a concept (`POST` and `PATCH /concepts`, and the
   picker's preview); a question write — the editor, the bulk bar, an MCP
   tool — stays bound for everyone. An edit is refused only when it changes
   a side's key and leaves it on the list; a side already there whose key
   stays (a concept older than the drop) may still be edited.
   Creating a question with a `tags` field (a client of before the
   cut-over) is a `400 validation`, through the MCP tool as through the
   route, rather than a question silently without its tags.
5. **The question editor's picker creates** a `proposed` concept from the
   cut-over on: a label in the interface language and an optional
   qualifier; the concepts already used in the pool first (§5). The model's
   fill of the other language and "Suggest concepts" come later (#557).
   The picker shows a concept's qualifier wherever it has one (only
   homonyms carry one), amending §5's "only when ambiguous" for the picker.
6. **The pool's Tags tab becomes a read-only "Notions" tab**: the concepts
   used in the pool, with their question counts, each opening the filter.
   No description editing (addendum §6). The bulk bar adds a concept.
7. **Filter and links.** A typed `#word` resolves to every concept it may
   designate (both languages, aliases, the qualified form) and filters on
   any of them; the URL carries concept ids, and an old `?tag=` is resolved
   once like a typed word. A concept used by a question is never deleted,
   only merged; an unused one may still be deleted by the admin (amends
   second addendum §2, which forbade any deletion after the cut-over).
8. **The drill** interleaves by the question's first concept id (no
   alphabetical meaning left) and reads mastery per concept, labelled in the
   reader's language; past reviews are regrouped under today's
   classification (§9).

## Fourth addendum 2026-10-10: the tag sorting is retired

Settled with the product owner (option A of #599, step (d)). It amends
addendum §1(d), second addendum §1 to §5 and third addendum §3 where named.

1. **Step (d) is done.** `question_tags` and `pool_tags` are dropped
   (migration 0098). Their only readers were the sorting workflow and the
   late-pair links of third addendum §3.
2. **The sorting workflow is retired** (amends second addendum and third
   addendum §3): the admin's Concepts tab, the routes `/admin/concept-sorting`
   (list, accept, propose, run), the model pass `concept.sort` and its job,
   and the audit kinds `concept.sort` and `concept.sort_propose` are removed.
   Past audit rows keep their action strings. The late pairs of third addendum
   §3 are no longer listed nor accepted: a tag nobody sorted before the drop
   is simply gone.
3. **Only the stop list remains.** Migration 0098 deletes every
   `concept_tag_sortings` row that is not a `drop`: the `concept` and pending
   rows have no reader left, and their foreign key would make every concept
   born of a tag undeletable. The `drop` rows stay, frozen (migration 0102 later drops the columns only the other rows used: `decision`, `concept_id`, `proposal`, `decided_by`, `updated_at`): they are the
   stop list of `concept_dropped` (third addendum §4). `concept_sort_runs` is
   dropped, and so is the LLM purpose `sort` (no database check nor contract
   parsed it).
4. **A stray concept is deleted, not migrated.** A concept that came out of a
   kind-of-task tag the 2026-10-08 decision drops (§1, §11 as amended in
   #600) is deleted through `DELETE /admin/concepts/:id` once unused; a
   concept still linked to questions is first unlinked by the PO's reviewed
   one-off SQL. Merging waits for the curation screen (step 5 of the
   transition), and no migration deletes data of concepts.

## Fifth addendum 2026-10-10: the curation of the vocabulary

Settled with the product owner (comment of 2026-10-10 on #599, step 5) after
a review of the spec. It adds to §7 and §11, third addendum §7 and fourth
addendum §4 where named. Delivery: the queue (list, validate, edit, delete)
is the first pull request; merge, aliases and probable duplicates follow.

1. **The admin's queue.** `GET /admin/concepts` lists the concepts that are
   not merged, `proposed` first, with the instance-wide number of **live**
   questions using each (a deleted question is not counted, though its link
   still refuses a deletion: the route also says whether the concept is
   deletable). An admin without Super Powers reads this number; pool names and
   statements are not in the payload and need Super Powers
   ([ADR-054](ADR-054-super-powers-admin.md), amended).
2. **Merge only into a validated target**, which keeps its labels. The links
   are rewritten in one audited transaction: duplicate links collapse,
   earlier `merged_into` chains are re-pointed, soft-deleted questions are
   included, and `copyQuestionConcepts` is locked against the merge. The audit
   keeps the moved question ids. There is no undo button.
   As built: `POST /admin/concepts/:id/merge` (`concept/merge.ts` owns the
   detail), 422 `concept_merge_target_not_validated`; earlier chains are
   re-pointed, `setQuestionConcepts` and `copyQuestionConcepts` share-lock in
   id order against the merge's `FOR UPDATE`, and the audit `concept.merge`
   records the loser's former status and the question ids moved or already
   linked. Step 7's course-concept links will join this transaction.
3. **Aliases** have no language. An alias whose key equals another live
   concept's label is refused unless the admin confirms explicitly.
   As built (PR3): only the admin adds or removes one
   (`POST /admin/concepts/:id/aliases` `{ alias, force? }`, `DELETE
   .../aliases/:alias` (the text; the server computes the key); audits `concept.alias_add` with the forced flag and the
   colliding ids, `concept.alias_remove`). Table `concept_aliases`, primary
   key (concept, `conceptKey` of the text), the text kept as written; `Concept`
   carries `aliases: string[]` so the picker resolves like the server. Typed
   input is matched by key against the bare labels AND the aliases of the live
   concepts as one set (`resolveConceptLabel`): one hit resolves, several are
   `concept_ambiguous`. Hence the guard: an alias equal to another live
   concept's label or alias is a 409 `alias_collision` naming those concepts
   until resent with `force` (`checkAlias`, `@quiz/domain`); equal to the
   concept's own label it is a 422 `alias_redundant`, to its own alias a 409
   `alias_exists`. An alias never becomes a label and questions store only the
   id. The stop list is not consulted: an alias is a curated decision, and
   `concept_dropped` only answers an input that designates nothing, so an
   alias on a dropped tag's key resolves. Rename creates no alias. Merge:
   the loser's aliases move to the winner always (one the winner answers to
   is dropped), and with `keepAsAlias` its labels, qualified when they are,
   become aliases too. As §6 says, the loser's label is dropped unless asked:
   `keepAsAlias` is required in the body and the dialog's checkbox starts off.
   The rule is `mergedAliases` (`@quiz/domain`); `concept.merge` records
   `aliasesMoved`, `aliasesAdded` and `aliasesDropped`. A label given to a
   concept (creation or rename) that another live concept answers to as an
   alias is refused like a taken label (409 `concept_exists`, the holder named),
   the mirror of the alias guard. Deleting an
   unused concept cascades to its aliases (`conceptReferenced` is unchanged).
   The catalogue search (ADR-095 §6) does not read aliases in v1.
4. **Probable duplicates** are proposed from labels and qualifiers only, when
   the admin asks, on the daily cap of the LLM gateway, as an ephemeral result
   never written automatically, after a deterministic pre-pass; a new row of
   [open question 43](../spec/06-questions-ouvertes.md) records the data sent.
   As built (PR4a, the pre-pass alone): `probableDuplicates` (`@quiz/domain`)
   pairs the live concepts, one reason per pair, first that holds: `alias`
   (a label's key is the other's alias key), `translation` (the qualified key
   of the French label of one is that of the English label of the other),
   `homonym` (one bare label in one language under different qualifiers:
   "check the qualifiers", never offered for a merge) and `close` (two labels
   within `keyDistance`, the resolver's tolerance, not equal). It runs in the
   browser on the `GET /admin/concepts` list, which already carries labels,
   qualifiers and aliases: no route, no table; it compares every pair, so it
   is for hundreds of concepts, not more.
   As built (PR4b, the model on demand): `POST /admin/concepts/duplicates/ai`
   (admin, no body, `LLM_CALLS_PER_MINUTE` a minute per admin) is the
   secondary action "Ask the AI" under the deterministic pairs, purpose
   `concepts` of the ADR-058 gateway (the default model, `effort: medium`,
   3000 output tokens at most). It sends one line per live concept, `c<n> |
   fr: label (qualifier) | en: label (qualifier)`, each field cut to one line
   without `|`: no description, no alias, no id, no creator, no question or
   pool. At most 1000 concepts (about 25 tokens each), the proposed ones
   first then the newest; past that the response says `truncated` and the
   hint says the oldest validated concepts were left out. The model files
   each pair under a kind: `close`, `translation`, `homonym` or `related`
   (distinct but connected concepts, meant for the relations of step 7);
   `homonym` and `related` are never offered for a merge, like the
   pre-pass's homonyms, and the reason is written in the admin's language.
   The reply is validated by zod, then strictly: an index not sent, an unknown
   kind, a pair of one concept, a repeated pair or an empty reason is dropped;
   at most 50 pairs and 200 characters of reason are kept. The browser also
   drops a pair the deterministic pass lists. Nothing is stored and no concept
   is written; the `llm_calls` row is the only trace, and the failures are the
   gateway's (`llm_not_configured`, `llm_budget_exhausted`, `rate_limited`,
   `llm_failed`). Merge (when a kind allows it) and Edit are the same as on
   the other pairs.
5. **Out of step 5.** Relations (broader, related, cycle check) move to
   step 7, the course concepts. There is no split of a polysemous concept and
   no "reject" action in v1: an unwanted proposal is deleted when unused, or
   merged.
