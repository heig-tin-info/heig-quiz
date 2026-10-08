# ADR-059 — "Generate": the wand of the question editor

## Status

Accepted (2026-10-01, decisions of the product owner; proposed the same day
as a sketch). Second phase of LLM assistance, on the gateway of
[ADR-058](ADR-058-passerelle-llm.md). Delivers the "Generate the answer"
button of docs/spec/08 and, of F-LLM-02, "propose the answer key, write the
explanation, propose distractors" (the per-choice wand); "generate a
variant" stays out. Writing whole questions from an LLM stays the job of the
MCP server (F-LLM-06, ADR-022): this ADR is about completing the question a
teacher is writing.

Delivered with `AnswerGenerator` (`@quiz/core/server`, `generate.ts`), the
generators of `qt-mcq`, `qt-short`, `qt-rich`, `qt-categorize` and
`qt-code` (`src/generate.ts` each, `src/image/generate.ts` for `codeimage`), `apps/api/src/modules/pool/generate.ts`, the routes
`POST /app/api/questions/:id/generate` and `GET /app/api/generate/availability`
(`GenerateRequest`, `GenerateResult`, `LlmAvailability` of `@quiz/contracts`),
`EditorProps.onGenerateItem`, and `apps/web/src/question/generate.tsx`.
Amends docs/spec/08 §8.2 ("the proposals appear highlighted, with accept or
reject"): see §3.

§6 amended by [ADR-082](ADR-082-carte-ia-de-l-editeur.md): "Generate
answers" is in the editor's AI card, offered once the statement is written.

§1–2 amended, for the teacher assistant only, by
[ADR-080's P3 amendment](ADR-080-assistant-enseignant.md#p3-amendment-2026-10-08)
(decision 1): in the question editor the assistant may REWRITE the
teacher's own texts (statement, choices' texts, explanation, the type's
declared free texts) — never an id, a setting, the key, the scoring, the
variables, a `[[…]]` expression nor an `asset:` reference — as a diff the
teacher applies; its "add N choices" fills and appends as §2 does, the new
choices unticked. The wand keeps the rules below.

## Context

A teacher writes a statement and has to produce what makes it a question:
the choices and which are right, the expected answer, the model answer and
its rubric, the reference solution and the test cases, the explanation.
That is the "thankless work" of docs/spec/08 §principle 3, which an LLM can
propose and the teacher decides.

## Decision

### 1. The type owns what may be proposed, and the merge

A question type may declare a `generator` beside its schemas
(`QuestionTypeServer.generator`, an `AnswerGenerator`):

- `statement(config)`: the wand is refused while it is empty
  (`statement_empty`) — the model completes a question, it never invents one;
- `instructions`: what to propose, in English, for the system prompt;
- `proposalSchema`: a NARROW zod schema of the proposal — the choices, the
  accepted values, the model answer and rubric, the columns and cards —
  never the whole config. The model never writes the statement, the
  settings (`mode`, `policy`, `kind`, shuffles, limits) nor ids;
- `merge(config, proposal)`: pure, tested without a model;
- `item` (optional): ONE element of the type's list at an index that must be
  empty (`item_not_empty` otherwise): the wand of one MCQ choice;
- `settle` (optional): what only RUNNING produces, after the merge — a code
  question's expected outputs, a picture's target — computed from the
  reference on the runner (`app.runner`), never taken from the model.
  It runs only a merged draft that validates with the type's `configSchema`,
  as Try runs only a valid one. Otherwise — an invalid draft, no runner
  (`RunnerUnavailable`, `RunnerBusy`), a reference that does not compile, a
  case that timed out or a picture with a missing pixel — the merged draft
  comes back all the same with `incomplete` (`draft_invalid`,
  `runner_unavailable`, `compile_failed`, `partial`), and the editor says
  what is left to do. No type with a `settle` takes variables (ADR-056:
  only `mcq`, `short` and `cloze` do); one that would must settle on a drawn
  instance, as Try does.

A draft may be invalid (D16): generators read it defensively. The API builds
the prompt (the draft's config and explanation as JSON, the type's
instructions, the rules common to all) and calls `LlmGateway.complete` with
purpose `generate`, the teacher as user, `effort: low`.

### 2. The merge fills the empty and completes the lists

Decided by the product owner: nothing the teacher wrote is changed.

- **mcq**: the teacher's choices stay, text and tick; the proposal fills the
  empty rows in place, then is appended (12 at most); a choice already
  written is never repeated; in `single` mode the teacher's tick wins and a
  proposed second key becomes a distractor.
- **short**: the teacher's matchers stay; the empty placeholder of a fresh
  draft goes; each proposed value becomes a matcher of the question's
  `kind`, which the model does not choose; a value that does not read as
  that kind (a date that is not `YYYY-MM-DD`) is dropped.
- **rich**: `reference` (model answer) and `rubric` are written only where
  empty. Both are the grader's; `toStudent` never sends them (invariant 4).
- **categorize**: a proposed column joins the teacher's column of the same
  label, else takes an unlabelled one, else is added (6 at most); a card the
  draft holds is never added again nor moved; distractors belong to no
  column; ids are the merge's.
- **code**: the reference is written only when empty, and only when it fits
  the template's editable regions (`referenceRegions`, the `@@next` cut);
  the empty placeholder case goes; proposed cases (name, stdin, args,
  visible) are appended, none repeating a name; `settle` runs the reference
  on every case whose expected output is empty and writes what it printed,
  and its exit code when not 0. A case that timed out or was cut keeps its
  empty output.
- **codeimage**: the reference is written as for `code`; `settle` runs it
  and makes the picture it draws the target, when the draft has none and the
  picture has no invalid or missing pixel.
- **The explanation** is written in the same call, only when empty.

A teacher who wants a field regenerated empties it first.

### 3. A proposal is an edit, with one Undo

The merged draft comes back to the editor and is set like a teacher's edit:
the autosave stores it (D16). One Undo restores the draft as it was before
the call, offered until the teacher's next edit. A reply that arrives after
the teacher changed the draft is dropped, with a message. Nothing is ever
published by the model (docs/spec/08 principle 3). This replaces the
"highlighted, accept or reject" of docs/spec/08 §8.2, which would have
needed a preview mode in every type's editor.

### 4. Language and content

The model writes in the language of the statement, French when unclear. The
`[[…]]` expressions of a parameterized question (ADR-056) and the `asset:`
links are kept as written; the images themselves are not sent, so a
statement built around a figure gets a proposal made blind. Only the
draft's config and explanation are sent — no name, no student, no answer
(open question 43).

### 5. Routes and access

`POST /app/api/questions/:id/generate` takes the editor's draft as it stands
(`GenerateRequest`: `config`, `explanation`, optional `item`) and answers the
merged draft (`GenerateResult`); nothing is stored by the route. Access is
`onQuestion("contributor")`, the draft's own: a teacher outside the pool
gets the 404 of a missing question (invariant 6). The type is the
question's, never the client's. Ten per minute per teacher (`Budget`)
against a held-down button; the gateway's daily cap is the ceiling. The
gateway's failures answer by code: `409 llm_not_configured`,
`429 llm_budget_exhausted`, `429 rate_limited`, `502 llm_failed`.
`GET /app/api/generate/availability` tells the editor whether to show the
wand: a stored key, and the types that have a generator.

### 6. The screen

"Generate answers" (the magic wand) is a secondary button above the type's
form (amended: it is in the AI card of the aside, ADR-082): Publish stays
the one primary action (invariant 2). The per-choice
wand appears on an EMPTY choice row of an MCQ only.

### 7. The types, in waves

Wave 1, delivered: `mcq`, `short`, `rich`, `categorize`. Wave 2, delivered
the same day: `code` and `codeimage` (§2), the outputs and the target
computed by `settle` — on staging, which has no runner, they come back empty
with the notice. A standalone "Compute the expected outputs" action, without
the model, is deferred; it would call the same `settle`. Then:

- `cloze`: its key is inline in the text (`{{…}}`), which is the statement.
  A wand there could only propose alternatives and distractors inside the
  blanks the teacher placed; to be designed.
- `circuit`, `diagram`: last, or never, if the proposals are not reliable.

## Consequences

- A teacher writes a statement, presses the wand, reads and corrects what
  came, and publishes. A wrong key that is not read is a wrong key in the
  draft; the Try tab and the review before Publish are the guard.
- A new type gets a wand by declaring a generator; the route, the screen and
  the gateway do not change.
- Every call is logged and capped by ADR-058, attributed to the teacher.

## Alternatives considered

- **Through the MCP server.** The MCP server serves an LLM client that drives
  the platform; here the platform calls the model itself, from the editor,
  and the MCP path would need the teacher's client in the loop.
- **The model writes the whole config.** It would rewrite the statement and
  the settings, and its ids would have to satisfy schemas it cannot see the
  refinements of; a narrow proposal merged by code keeps what the teacher
  wrote by construction.
- **The MCP guides as the prompt.** They are written for a tool caller
  ("call `get_question`", "a tool argument beside `config`"); each type's
  generator states what the wand needs, beside the merge it describes.
- **Accept/reject highlighted proposals.** Safer to read, but a preview mode
  in every type's editor; the draft is not published, and Undo restores it.
