# ADR-045 — The LLM grading service, and its development stub

## Status

Superseded by / folded into [ADR-063](ADR-063-correction-llm.md) on 2026-10-09.
Accepted 2026-09-30; its inline call (§4) was already superseded by ADR-063 §2,
and its §1 no longer described the code. Its living rules now live in ADR-063:
the one grading service of the process (`createLlm`: the stub, else the
gateway's grader, else none) in [§5](ADR-063-correction-llm.md#5-essays-and-diagrams-through-their-text-form);
the stub refused in production in [§9](ADR-063-correction-llm.md#9-the-development-stub-folded-from-adr-045);
a request built from the config and the answer alone, with nothing that
identifies, in [§4](ADR-063-correction-llm.md#4-what-is-sent-and-what-comes-back);
no call while the evaluation runs in [§1](ADR-063-correction-llm.md#1-automatic-at-the-close-as-proposals);
the justification kept in `details`, never in the comment, in §4 and
[§7](ADR-063-correction-llm.md#7-the-justification-may-become-the-comment-by-the-teachers-hand).
Each former section is mapped in ADR-063's
[correspondence table](ADR-063-correction-llm.md#correspondence-with-adr-045).
The full former text is in the git history of this file.
