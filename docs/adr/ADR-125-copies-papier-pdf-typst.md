# ADR-125 — Paper copies: the hand-out and its answer zones, PDF through Typst, the paper attempt entered by the teacher

## Status

Accepted (2026-11-03, the product owner's decisions on issue #551, palier A;
points 2, 5, 8, 14 and 16 arbitrated by the orchestrator after review).
Delivery progress lives in `changes/`.

Amended 2026-11-04 by [ADR-126](ADR-126-types-a-canevas-sur-papier.md),
scope: §5 and §20 (`diagram`, `circuit`, `logic` and `blocks` become
printable; ADR-126 §8) and §6 (a `free` zone may be a ruled frame with a
starter, `pattern` and `underlay`, and stays `free`; ADR-126 §3–§4).

Amended 2026-11-04 (product owner, 2026-11-04, after the first look at the
PDF), scope: §6 (a choice question's choices are its paper zone; the page)
and §7 (every document in the requester's language); see the amendment at
the end.

Scope: the printed hand-out of an exam and the PDF of every export; the
paper attempt a staff member enters, its scan, and every reader of
`attempts` that counts; the student's documents of ADR-112's amendment.

Relations: amends [ADR-121](ADR-121-fabrique-d-exports.md) §1, §2, §4, §7
and §8 steps 2, 3, 6; [ADR-112](ADR-112-export-des-donnees-personnelles.md)
(open question 62 settled); [ADR-122](ADR-122-entrainement-apres-l-echeance.md)
§4; N-I18N-01 (a scoped exception). Depends on invariants 1, 4–7, 9,
[ADR-056](ADR-056-questions-parametrees.md),
[ADR-097](ADR-097-reponse-transmise-et-reponse-stockee.md),
[ADR-044](ADR-044-grille-de-correction.md). F-EXP-04..06, F-PAPER-01..05,
F-GRADE-01, F-GRADE-03 ([02](../spec/02-exigences-fonctionnelles.md));
N-DATA-02/03/07, N-I18N-01 ([03](../spec/03-exigences-non-fonctionnelles.md));
05 §5.7–§5.9.

## Context

An evaluation can only be taken on a screen. Issue #551 names two real
situations with no answer: a student's computer dies during an exam, and
the teacher cannot bring a paper copy back into the platform; and Safe Exam
Browser can be recompiled (ADR-027) while kiosk stations (ADR-051) are a
limited fallback — a paper exam is the one confinement that cannot be
defeated technically.

The issue proposes a full pipeline: print one identical copy, scan the
stack, read the zones by machine, import each copy as an attempt. Its
riskiest part is image robustness. The owner cut it in three paliers:
**A** (this record) prints the hand-out and lets a staff member type a
paper copy by hand, scan attached; **B** adds fiducials, a page QR code, the
zone manifest and bubbles read without a model; **C** adds vision OCR of the
written zones through the LLM gateway. Palier A is also ADR-121 steps 2, 3
and 6; it reserves zone ids, the manifest and the margins, and builds
nothing of B or C.

## Decision

1. **Engine: Typst on the server.** Every PDF is rendered from the ADR-121
   document tree by a pinned static `typst` binary in the Docker image; no
   Chromium, no browser print view. Markdown becomes Typst source in
   `packages/docexport` (pure, unit tested) on `marked`'s lexer, the
   grammar of the web app and docrender; LaTeX becomes Typst math through
   `tex2typst`, with the LaTeX source in a visible raw box when a formula
   does not convert. The API runs the binary from an adapter directory,
   `apps/api/src/typst/`.

2. **The compile sandbox.** An `execFile` with an argv array, never a
   shell: `typst compile --root <mkdtemp> --ignore-system-fonts …`.
   - **A closed environment** built from scratch, never inherited from
     `process.env` (no database URL, OIDC, LLM or GitHub secret): `PATH`;
     `HOME`, `XDG_*`, `TYPST_PACKAGE_PATH`, `TYPST_PACKAGE_CACHE_PATH`
     inside the temporary directory; `HTTPS_PROXY`, `https_proxy`,
     `HTTP_PROXY`, `http_proxy` = `http://127.0.0.1:9`. Moving the package
     paths alone does not stop a download (verified on Typst 0.15.1); the
     dead proxy does. A test asserts the list, like the runner's.
   - **Bounds**: `SIGKILL` after `PDF_TIMEOUT_MS` (20 s); an address-space
     cap through `prlimit --as` where available (util-linux in the image);
     `maxBuffer` 1 MB; output ≤ 25 MB; one compile at a time behind a
     bounded queue (`503 pdf_busy`, `Retry-After`); the directory removed
     in `finally`.
   - **Input**: user text escaped (`typstText`); a code fence is
     `#raw(block: true, lang: …, "<string literal>")`; images only from
     `asset:<id>`, copied into `assets/<id>` of the root. A test compiles a
     statement holding `#import "@preview/x:0.1.0"` and proves nothing was
     fetched.

   The child shares the API container, with no namespace isolation; the
   escape, the closed environment and `--root` are the defence.

3. **Availability.** A probe (one real compile in the sandbox of point 2,
   memoized) feeds `pdf: boolean` in the public configuration the web app
   already fetches at boot (`/app/api/config`, every session kind); the
   web app hides every PDF button when it is false, a PDF route answers
   `503 pdf_unavailable` (`503 pdf_busy` with `Retry-After` behind a full
   queue), and the system
   status gains a `pdf` entry (ADR-055). CI installs `typst` and
   `poppler-utils`; the PDF tests fail under `CI=1` without the binary and
   skip on a workstation without it.

4. **Formats.** PDF and JSON (the ADR-121 record) wherever an export is
   offered; Markdown where ADR-121 already gives it (staff documents).

5. **Printability is a declaration of the type.** A type prints on the
   hand-out if and only if it implements the optional hook
   `answerZone?(student)`, on the student view; `core` and the API hold no
   list of type names. One pure `printRefusal(items)` refuses with
   `reason: "parameterized"` (ADR-056: a copy has no draw) or
   `reason: "type"` (a type without the hook, listed); it feeds
   `EvaluationDetail.exports`, the hand-out routes and `POST /paper`, all
   answering `409 not_printable` with `PrintRefusal = { reason, types }`.
   The staff "statement with key" accepts every type with `statementDoc`.
   In palier A, `mcq`, `short`, `cloze`, `rich` and `math` implement it.
   `diagram` and `circuit` do not (see Alternatives). A student's answer
   renders through a second hook, `studentAnswerDoc?(student, answer,
   details)` (amends ADR-121 §2), fed only the student view, the answer as
   handed back and `studentDetails` under the policy; the staff copy and
   the student copy use it. *(Amended by ADR-126 §8: `diagram`,
   `circuit`, `logic` and `blocks` print; and `code`, a `lines` frame, by
   its amendment of 2026-11-04.)*

6. **The `answerZone` block** (amends ADR-121 §1):
   `{ kind: "answerZone"; id: string; part?: string; zone: "bubbles" |
   "lines" | "free" | "name"; labels?: readonly string[]; multiple?:
   boolean; lines?: number; heightMm?: number }`. A type's hook sees no
   item id: it writes only `part` (`b<n>` for a cloze blank); the document
   builder scopes every zone with `scopeZones(itemId, blocks)`, so `id` is
   `<itemId>` or `<itemId>:<part>`, and `name` for the name frame of page
   1. `lines` counts the ruled lines of a written answer; `heightMm` sizes
   a `free` zone, the generic shape (an essay's). The Markdown renderer
   draws a zone as a plain preview (bubbles, underscores, blank lines), for
   the `handout.md` a teacher downloads. In Typst a zone is
   `#zone(id, kind)[…]`, which emits
   `#metadata((id, kind, page, x, y, w, h)) <answer-zone>` for palier B's
   `typst query`. No fiducial, no QR code; a margin of at least 10 mm stays
   free for them. *(Amended by ADR-126 §3: a ruled `free` frame; amended
   2026-11-04, see the end: a `choices` block is a zone too.)*

7. **Fixed words of a student-facing document** (a scoped exception to
   invariant 1 / N-I18N-01 and to ADR-121 §4). Three documents only — the
   hand-out, the student's copy, the blank print of a series — take their
   fixed words in the requester's language (`readerLang(req)`) from a typed
   dictionary in `packages/docexport`: `EN_LABELS`, and
   `FR_LABELS: Record<keyof typeof EN_LABELS, string>`. The copy-lint rules
   run over both; the precedent is `notifications/templates.ts`. Staff
   documents stay English; question content is printed as written.
   *(Amended 2026-11-04: every document, staff ones included.)*

8. **One secret order per evaluation, never the base order.** A printed
   paper follows a random seed stored on the evaluation, the nullable
   column `evaluations.paper_seed` (the type of an attempt's seed), drawn
   like a digital attempt's seed (`drawSeed`) on the first print or paper
   entry by one function, `paperSeedOf(db, evaluation)`, of the evaluation
   module's service. It is never sent to a client, never in a record,
   never in the zone manifest; a reprint is identical. The migration lands
   with ADR-121 step 3, its first consumer. The order honours
   `shuffleItems` and `shuffleChoices` as a digital attempt's seed does.
   The hand-out, the blank print and the paper attempt use it, so copies
   are identical and the paper attempt takes the ordinary ADR-097 path,
   with no special case in `itemView.ts`. The staff "statement with key"
   keeps the base order.

9. **The paper attempt: one staff submission.** It does not exist before
   the teacher hands in the whole copy: `POST /app/api/evaluations/:id/paper`
   with `PaperAttemptBody = { userId, examDate, answers: Record<itemId,
   unknown> }`.
   - **Target** (invariant 6): `userId` is loaded as a claimed, non-staff
     enrollment of the evaluation's classroom, else `422 paper_no_seat`.
   - **Validation** (invariants 4, 7): each answer goes through the
     student save's path — `answerFromStudent`, `answerSchema`,
     `fromStudentAnswer` — on the view of the paper seed; one malformed answer
     refuses the copy (422). No grade, verdict or key comes from the client.
   - **One transaction**: end the replaced unfinished attempt (point 12),
     then insert the attempt — `origin: "paper"`, `state: "submitted"`,
     `closedBy: "teacher"`, `submittedAt` = now, `startedAt` and
     `deadlineAt` null, `afterDue: false`, `displayTracked: false`, the
     paper seed, `attemptNumber` = the student's highest + 1 (unique index
     `attempts_evaluation_user_number_uq`) and its answers, then the
     `paper_sheets` row.
   - **Grading**: evaluation `running` or `paused` → nothing now, graded at
     the close like any handed-in attempt; `closed` or `grading` →
     `enqueueEvaluationGrading({ evaluationId, attemptIds: [id] })`.
   - **Boundary**: the transaction runs in `paper/service.ts`. It calls
     the attempt insert of `live/paperAttempt.ts`, exported through
     `live/service.ts`, which writes only `attempts` (`origin` included)
     and its answers; then it inserts its own `paper_sheets` row.
   - No `in_progress` state, ticker or autosave. The entry page keeps its
     draft in `sessionStorage` and renders `PlayerView` with a local
     session, as the preview does.

10. **`state: submitted` with `closedBy: teacher`.** A new pair: until now a
    teacher's close meant `expired`. It is the truth — the student
    answered, a teacher handed the copy in. The paper attempt emits no
    `attempt.closed`: it reaches the dashboard through the existing
    `dashboard.attempt` event, which carries `state`. No reader changes;
    the student of a replaced attempt sees "evaluation_closed"
    (`useAttempt.ts`), as for any attempt a teacher ends.

11. **When, for whom, by whom.** Exams only (`409 paper_mode`); from the
    evaluation's first run (`startedAt` set) until its release — `running`,
    `paused`, `closed`, `grading`; `draft`, `scheduled`, `lobby` →
    `409 paper_not_started`; `released` → `409 paper_released`. Any staff
    member of the course (`staffAccess`); a stranger gets a 404.

12. **Superseding.** A paper attempt may replace the student's attempts,
    digital or paper; nothing is merged. `attempts.superseded_by` (uuid,
    null, references `attempts`, `on delete no action`, checked at the end
    of the statement so a cascade deleting both attempts of a pair
    succeeds) marks each replaced
    one, and `officialAttempt` gains `superseded_by is null` (amends
    ADR-122 §4); `isLatestAttempt` and `attemptOf` keep working, the paper
    attempt being the latest. A replaced attempt still `not_started` or
    `in_progress` is ended first, `expired` with `closedBy: teacher`,
    freeing the open-attempt index; the student's player learns it through
    the existing attempt-closed event. The replaced attempt stays readable
    by the staff, marked; it is never served to the student (404 on the
    attempt view, the feedback and the copy; the student's lists read
    `officialAttempt`). Neither a paper attempt nor a replaced one is ever
    reopened (`409 not_reopenable`): a reopening would hand a student a
    screen for a copy that was never theirs to type, or for one that no
    longer counts. The entry dialog says an attempt will be replaced.

13. **The exam date and the clock** (invariant 5). A paper sitting is
    supervised by a person; the platform enforces no deadline on it.
    `submittedAt` is the server's time of entry; `paper_sheets.exam_date`
    records the day written (default: the evaluation's opening date,
    editable). Nothing but the scan is written after creation. `startedAt`
    is null, and the duration statistics already skip such attempts.

14. **Untyped free zones.** On a paper attempt, an item whose zones are all
    `free` and that has no answer row — in palier A an essay the teacher
    did not transcribe — gets a `proposed` grading at 0 points with reason
    `paper_free_zone`, as `runner_unavailable` and `llm_not_configured` do
    (`grading/jobs.ts`): no `grade()` call, no model job. Validating it
    needs no override comment; until then it holds the attempt back like
    any proposal. An exception to F-GRADE-01's validated 0.

15. **Scan.** Optional, attached right after the submission or later; a
    second upload rewrites the `paper_sheets` row through
    `paper/service.ts` (the old file swept). PDF,
    PNG or JPEG by magic bytes, at most `PAPER_SCAN_MAX_BYTES` (25 MB),
    else `415` or `413`. Stored under
    `ASSETS_DIR/paper/<attemptId>/<sha256>.<ext>` through `writeAsset` and
    `safeJoin`, with no `assets` row, never reachable through
    `/app/api/assets/:id`. Served to the course's staff only (`staffAccess`,
    404 otherwise), as an attachment with `nosniff`, each read audited.
    Deleted with its attempt (cascade, then a file sweep); retention is the
    attempt's (N-DATA-03). A student never sees it in palier A.

16. **Data, contracts, audit.** A new module `paper` (`routes.ts`,
    `service.ts`) owns `paper_sheets`
    (`apps/api/src/db/paper.ts`) and is its only writer: `attempt_id` (primary
    key, cascade), `exam_date`, `entered_by`, and the scan's hash, type,
    size, upload time and uploader; the scan's path is rebuilt from the
    attempt id, hash and type. `attempts.origin` (`not null default
    'digital'`, or `paper`) stays on the row, so readers get it cheaply.
    A `*.db.test.ts` deletes an evaluation holding a replaced attempt and
    its replacement (N-DATA-03). Contracts in
    `packages/contracts`: `PaperAttemptBody`, `PaperSheet`, `PrintRefusal`,
    `Capabilities`, the scan upload's reply. The audit union gains
    `paper.enter` (with `supersededAttemptId?`), `paper.scan_upload` and
    `paper.scan_read`.

17. **Where the teacher finds it.** Each entry point is a secondary action
    of a screen with its own purpose (invariant 2). **Never on the grading
    table**: it is anonymised (F-GRADE-03, ADR-044), and a "Paper" badge
    there would name the one student whose computer died. The badge lives
    on the dashboard row, the results row, the staff copy and the inspect
    view.

18. **The student's documents** — their own copy and the blank print of a
    past series — follow the
    [ADR-112 amendment](ADR-112-export-des-donnees-personnelles.md#amendment-of-2026-11-03),
    which settles open question 62. No solution document for a student
    (invariant 4, ADR-124 §3).

19. **Leak test.** Every student-facing document is searched in three
    forms — tree, rendered source, PDF text — as 05 §5.7 states.

20. **Not in palier A.** Fiducials, QR codes, machine reading, a model call
    on a scan; merging a partial digital attempt; per-student copies;
    detecting pages out of order (palier B flags them); printing `diagram`
    and `circuit`. *(Amended by ADR-126 §8: they print.)*

## Consequences

- A student whose computer dies, or a class sat without computers, gets a
  normal attempt — graded, in the results, the release and the gradebook —
  at the cost of teacher time per copy.
- One renderer more to keep in step with the web's Markdown and KaTeX; the
  conversion is pure and tested, and an unconverted formula prints as
  LaTeX.
- The image grows by one static binary; one compile at a time bounds
  memory and may answer `pdf_busy`; the compile is not namespace-isolated.
- A new type is printable by implementing `answerZone`; nothing else moves.
- Every reader of `attempts` that counts keeps using `officialAttempt`,
  which now also hides a replaced attempt.
- Handwriting scans are personal data of a new kind (N-DATA-02/03/07); their
  retention horizon is open question 64.

## Alternatives considered

- **Headless Chromium printing the web app's pages** (the issue's
  recommendation, ADR-121 §7's first version): a browser in the image for a
  print layout; Typst paginates, measures zones and is one static binary.
- **`cmarker` and `mitex` vendored inside Typst**: the conversion would
  escape the Node unit and leak tests, with WASM pinned in the repository.
  `mitex` stays the fallback if `tex2typst` proves short.
- **The base order (seed 0) on paper**: the editor creates an `mcq` with
  its first choice ticked, so the base order puts the key at A in most
  single-answer questions — a leak through the print.
- **A seed derived from the evaluation's id**: the id is in every student
  route and the hash is public code (`packages/core/src/rng.ts`), so a
  student could recompute the base order and the key.
- **A keyed hash of the id** (an HMAC under a server secret): a rotation
  of the secret would change the order of a reprint and of every paper
  attempt already entered; a stored random seed survives it.
- **A paper attempt `in_progress`, typed through the student's routes in a
  staff mode**: it widens the student loader to a staff caller, needs
  refusals on check, events and submit, exposes an open attempt to the
  close pass and adds a dashboard state. One validated submission gives the
  same guarantee.
- **Refuse a paper copy when the student has an attempt** (the issue's
  scope): rejected by the owner; the computer that died is that case.
- **A free zone for `diagram` and `circuit` now** (the owner's first
  decision): deferred. Their figure, the canvas a student completes, has
  no server-side renderer (`packages/diagram` and `packages/qt-circuit`
  render through React only), so a hand-out would print a question
  without its statement. A later record may add them once a server-side
  SVG exists. *(Done by ADR-126.)*
- **A list of printable type names**: `core` names no type; the hook is the
  declaration.
- **Merge a partial digital attempt with the paper copy**: two sources for
  one answer, and no rule for which wins.

## Amendment 2026-11-04: the printed look and the language of every document

Decided by the product owner, 2026-11-04, after the first look at the PDF.
The rest of the record stands.

1. **A choice question's choices are its paper zone** (amends §6 and
   ADR-121 §1). A `choices` block of the document tree lists every choice
   beside its box: a square when several may be ticked, a round one for
   one answer, drawn empty or ticked (by position, like a stored answer).
   `mcq` draws it on the statement (none ticked), on the key (the right
   ones) and on an answer (the ticked ones), every choice listed each time.
   Its `answerZone` hook returns no block: `scopeZones` keys the
   statement's `choices` block to the item like an answer zone, and the
   Typst renderer wraps a keyed block in `zone(id, "choices", …)`, so the
   `<answer-zone>` manifest lists it with its position. The type stays
   printable: the hook is present. `bubbles` stays a zone kind, for a cloze
   dropdown's options (round, one to pick). Markdown writes the block as a
   task list, `- [ ] **A.** text` or `- [x]`. The leak tests assert that no
   box is ticked on a statement or a hand-out, nor on a copy whose key is
   hidden.
2. **Every document follows the requester's language** (amends §7 and,
   through it, [ADR-121](ADR-121-fabrique-d-exports.md) §4). The hand-out,
   the student's copy, the blank print of a series and the staff documents
   — the statement with key, an item's answers, the staff copy — all take
   their fixed words from `LABELS[readerLang(req)]`; every hook of a type,
   `answerDoc` included, receives the labels. "Staff documents stay
   English" no longer holds. A value the platform stores as a code (a
   policy's name, a matcher's kind, a math problem's code) is printed as
   stored.
3. **The page** (§6). The body font is New Computer Modern, the Latin
   Modern look of a LaTeX paper, embedded in the Typst binary like the
   others (`--ignore-system-fonts` stays); formulas keep New Computer
   Modern Math, code and a drawing's text (ADR-126) DejaVu Sans Mono. A
   question's points sit at the right end of its heading line, lighter
   (`1 pt`, never plural), outside the heading itself so a PDF bookmark
   holds the heading alone (a `heading` block's `aside`, ADR-121 §1). No
   rule separates two questions: a level-2 heading opens each with space
   above; a light rule remains between two students of an item's answers.
4. **The JSON record is indented** (two spaces), so a person can read it;
   it parses as before.
