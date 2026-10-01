# ADR-059 — "Generate": the wand of the question editor

## Status

Proposed (2026-10-01, sketch agreed with the product owner; to be completed
before it is implemented). Second phase of LLM assistance, on the gateway of
[ADR-058](ADR-058-passerelle-llm.md). Delivers the "Generate the answer"
button of docs/spec/08 and part of F-LLM-02. Writing whole questions from an
LLM stays the job of the MCP server (F-LLM-06, ADR-022): this ADR is about
completing the question a teacher is writing.

## Context

A teacher writes a statement and has to produce what makes it a question:
the choices and which are right, the expected answer, the model answer and
its rubric, the reference solution and the test cases, the explanation.
That is the "thankless work" of docs/spec/08 §principle 3, which an LLM can
propose and the teacher decides.

## Decision (sketch)

1. **A wand, two scopes.** The editor's "Generate answers" button (the
   magic-wand icon) proposes everything the type needs beyond the statement.
   A field-level wand proposes ONE element: one more choice of an MCQ when
   the teacher added an empty one, one more test case, one more blank of a
   cloze. It appears on hover and focus, so that the screen keeps one
   primary action (invariant 2).
2. **A proposal, in the form, never saved by itself.** The API returns a
   proposed config (or one element of it); the client merges it into the
   editor's form, where the teacher reads, edits or undoes it, and saves it
   like any edit into the draft. Nothing is published by the model
   (docs/spec/08 §principle 3). What the teacher already wrote is never
   overwritten silently: the merge fills empty fields, and a replacement
   shows what it replaces with an Undo.
3. **One mechanism for every type.** The prompt is built from what the type
   already declares: its config schema (zod, in `qt-*/server`) and the
   authoring rules the MCP server gives an LLM client
   (`describe_question_types`). The reply is validated by the type's own
   config schema; a type may add a `generate` hook to its server half when
   it needs more (a `circuit` checked by simulation). A target path
   (`choices[5]`) selects the field-level scope.
4. **Types in waves.** First `mcq`, `short`, `cloze`, `rich` (model answer
   and rubric) and `categorize`. Then `code`: the model writes the reference
   solution and the test INPUTS, and the expected outputs are COMPUTED by
   running the reference solution on the runner (docs/spec/00 phase 2),
   never taken from the model. `circuit`, `codeimage` and `diagram` last, or
   never, if the proposals are not reliable.
5. **Parameterized questions (ADR-056).** The `[[…]]` expressions of the
   statement are given to the model as written, and the reply must keep
   them; the validation of ADR-056 rejects a reply that drops one.
6. **Language.** The model writes in the language of the statement. A pool
   setting for the default language (when the statement is empty) is not
   built; French is the fallback.
7. **Cost and abuse.** Purpose `generate`, attributed to the teacher, logged
   and capped by ADR-058. A per-minute `Budget` per teacher stops a held-down
   button; no quota.
8. **No key.** Without a configured gateway the wand is hidden; F-LLM-05's
   "Copy the prompt" may come later on the same prompt builder.

## To settle before implementing

- The exact merge rule per type (which fields count as "empty").
- Whether the explanation is generated with the answer or by its own wand.
- The staging runner is stubbed: the `code` wave cannot be tested end to end
  there until it has a runner.

## Alternatives considered

- **Through the MCP server.** The MCP server serves an LLM client that drives
  the platform; here the platform calls the model itself, from the editor,
  and the MCP path would need the teacher's client in the loop.
- **A prompt per type, hand-written.** Nine prompts to keep in step with nine
  schemas; the schema and the MCP rules already say what a valid config is.
