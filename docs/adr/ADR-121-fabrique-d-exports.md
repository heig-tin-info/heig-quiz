# ADR-121 — The export factory: a typed record per source, one document tree, a renderer per format

## Status

Accepted (2026-10-29, the product owner's decisions on the design of issue
#972 and of the hand-outs of #551). Delivery progress lives in `changes/`.

Scope: every file the platform builds from its data for a person to read or
process outside it — Markdown, JSON, PDF — except the results and gradebook
CSV, the personal data export's JSON (ADR-112) and the canonical pool
package (spec 04 §4.2), which keep their own writers.

Relations: requirements F-EXP-01..04
([02](../spec/02-exigences-fonctionnelles.md#f-exp-exports)); depends on
invariant 4 and [05 §5.7](../spec/05-architecture.md#57-content-security)
(the student exits it composes), invariant 6 (the loaders), invariant 14
(`assembleCodeSource`), [ADR-025](ADR-025-plusieurs-tentatives-exercice.md)
(the attempt that counts), [ADR-018](ADR-018-vue-etudiant-reelle.md) (a
teacher's test walk), [ADR-037](ADR-037-materiel-reserve-a-l-enseignant.md)
(the student's key), [ADR-056](ADR-056-questions-parametrees.md) (instances),
[ADR-112](ADR-112-export-des-donnees-personnelles.md#decision) (§1, §4, §7;
to be amended at step 5).

## Context

Teachers ask for files the screens already hold: every answer to one code
question in one Markdown file, to read in one go or hand to a model (#972);
an evaluation's statement and key, or a printed hand-out for a paper exam
(#551); the results and the projects as data. Each request, built on its own,
would add a writer that reads tables, decides what its reader may see, and
formats — three jobs, written again each time, and each a possible second
exit for answer keys beside the ones invariant 4 guards. The three writers
that exist (the results CSV, F-RES-02; the gradebook CSV, F-GBOOK-04; the
personal export, ADR-112) are not reusable for a document.

Question content is per type: only `packages/qt-code` knows how a program
answer becomes a source file, and only a type knows which of its parts are
text. `packages/core` never imports a type (D1), so the rendering of a
question must come from the type through its contract.

## Decision

1. **One pipeline: Source → Record → Document → Renderer.** No central
   `export` module.
   - **Source**: a function of the `service.ts` of the module that owns the
     data (`grading`, `results`, `privacy`, `evaluation`, …), on an entity
     its route loaded through the existing loaders (invariant 6). A Source
     reads what its screen reads and applies no visibility rule of its own.
   - **Record**: a typed, versioned zod schema in `packages/contracts`, with
     `kind` and `version` (a change of shape bumps `version`). **The JSON
     export IS the record**: `.json` serves it parsed through its schema, so
     a field beyond the contract never travels.
   - **Document**: a small typed block tree in a new pure package,
     `packages/docexport` (no database, no network, no clock): `heading`,
     `markdown` (a statement's text passed through as written), `code`
     (`lang`, `text`), `list`, `table`, `tests` (`name`, `visible`, `ok`,
     `points`), `points`, `separator`, and later `answerZone` (reserved for
     #551's answer space), with a front matter (point 5). The tree is
     internal: no route serves it.
   - **Renderer**: `md`, pure, in `packages/docexport` — a code block's fence
     is one backtick longer than the longest run of backticks in its text,
     at least three, so no answer can close it early; `json`, the record
     itself; `pdf` later (point 7).

2. **A question renders itself through optional hooks of
   `QuestionTypeServer`** (`packages/core/src/contract.ts`), each fed only
   what its audience may already read:
   - `statementDoc(student)`: from the student view the API built with
     `toStudent`, never from the config, so a statement carries no more than
     a student is served;
   - `solutionDoc(solution, student)`: the staff pass `toSolution`; a
     student's document passes `studentSolution`'s output, and only where
     the feedback policy's `showKey` holds (ADR-037); `student` is the same
     student view, for what a key alone does not say (a program's language);
   - `answerDoc(config, answer, details)`: **staff only**. `code` rebuilds the
     source server-side with `assembleCodeSource` (invariant 14), never from
     a client's text, and lists every test, hidden ones by name.
   A student's answer, when step 5 needs it, gets a hook of its own typed on
   the student shapes only — the student view, the answer as handed back,
   and `studentDetails(details, policy)` — so no hook decides visibility
   from a raw config. A type without `statementDoc` and `answerDoc` offers
   no Markdown or PDF button; its data stays in the JSON record.

3. **Audience rule** (product owner): F-EXP-02. A student-facing document is
   a composition of the named student exits under ADR-112's rules (§1, §4:
   never the player's attempt view; §7: the caller's own portal session),
   and its rendered text joins the leak tests of 05 §5.7.

4. **Staff documents name the students, in English.** The owner overrode
   three points of #972: a staff document is not anonymised (only the
   grading screen is, F-GRADE-03), it carries no personal-data warning line,
   and it is not audited (like F-RES-02 and F-GBOOK-04); the stable "Copy N"
   numbering the issue proposed is therefore out of scope. Sending the file
   to a model is the teacher's own act, outside the platform's LLM path that
   N-DATA-05 governs. A staff document's fixed words are English, like the
   CSV; the language of a student document is decided with step 5.

5. **The front matter is provenance**, YAML that docrender's
   `splitFrontMatter` reads: `export` (`kind`, `format`, `version`), `source`
   (`evaluationId`, `itemId`, `questionId`, `questionVersionId`, as the kind
   has them), `attempts` (the ids the document holds), `generatedAt` (the
   server's clock), `app` (the build's commit, when known) and `sha256` (of
   the body after the front matter). Ids only, never a name. No `?asOf=`
   endpoint replays an old document (owner).

6. **The canonical format is not the document tree**: it stays the
   authoring interchange of pools and questions (spec 04 §4.2).

7. **PDF**: Typst is the preferred engine (reproducible, real pagination,
   cross-references). A first version may try the web app's print view
   (`@media print`, `break-inside: avoid` per question) only if its result
   is clean; it moves to Typst as soon as a question splits across pages,
   a cross-reference is needed, or #551's answer zones need a measured
   layout. Both render the same document tree.

8. **Sequence** (each step its own PR, on this decision):
   0. this record;
   1. #972 on the minimal core: the package, the hooks on `code`, the
      item's answers as Markdown and JSON, Export and Copy on the grading
      panel; a parameterized item is not offered (each attempt has its own
      statement and key, ADR-056);
   2. the hooks of the text types: `rich`, `short`, `math`, `cloze`, `mcq`,
      a parameterized item still refused (rendering each attempt from its
      stored instance is that step's open question);
   3. the evaluation document, **staff only** through the evaluation's
      loader: statement and key, and a hand-out to print from the student
      views in the base order (seed 0, no shuffle); a parameterized question
      is refused in its first version;
   4. JSON records of the results, then of the projects;
   5. the student's Markdown export: the ADR-112 record and an exercise
      series, by an amendment of ADR-112 (same rate limit, session rule and
      `privacy.export` audit);
   6. PDF (point 7), then #551's lots on the same tree.

## Consequences

- One place decides what a file may hold — the Source, by reusing a view —
  and one place formats it; a new type joins every document by its hooks.
- The record is a public contract: a reader (a teacher's script, a model)
  relies on its `version`.
- Staff documents carry names, keys and hidden tests: they are as sensitive
  as the screens they come from, and leave the platform's control once
  downloaded.

## Alternatives considered

- **A central `export` module reading the tables.** Rejected: a second exit
  for keys and unreleased grades beside every student view, as ADR-112
  rejected a table dump.
- **Serve the document tree as the JSON.** Rejected (owner): the tree is a
  layout; the record is the data a script wants.
- **Canonical YAML as the document tree.** Rejected: it is the authoring
  format of a question, not a document of answers, grades or hand-outs.
- **A per-feature writer, as for the CSV.** Rejected: each would re-decide
  visibility and re-implement Markdown escaping.
- **One `answerDoc` with an audience flag.** Rejected: the type would apply
  the feedback policy to a raw config, a visibility rule outside the exits.
