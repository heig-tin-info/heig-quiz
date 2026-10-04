# Specification reading index

Read the section that governs the task, not every chapter. These documents
state requirements and decisions; code/tests show implementation, and merge
task cards show delivery progress. A code/spec discrepancy is evidence to
investigate, not authorization to discard a requirement.

| Task | Read |
| --- | --- |
| Scope, explicit exclusions | [00 — Scope](00-cadre-et-perimetre.md) |
| Vocabulary, lifecycle, permissions | [01 — Domain](01-glossaire-et-domaine.md) |
| Product behavior | [02 — Functional requirements](02-exigences-fonctionnelles.md): locate the relevant `F-*` family |
| Security, privacy, reliability, operations | [03 — Non-functional requirements](03-exigences-non-fonctionnelles.md): locate the relevant `N-*` family |
| Question type contract and behavior | [04 — Question types](04-types-de-questions.md): shared contract, then the one type |
| Module boundaries, persistence, real time, execution | [05 — Architecture](05-architecture.md): read the relevant section |
| Database fields and schema intent | [Data model reference](reference/data-model.md), then the owning `apps/api/src/db/` schema |
| A choice not yet settled | [06 — Open questions](06-questions-ouvertes.md): never decide an unresolved row silently |
| Novice/expert interaction | [08 — Experience](08-experience-deux-niveaux.md), plus `apps/web/DESIGN.md` |

For the reason behind a choice, use the [ADR topic index](../adr/README.md).
For implementation locations, use the [repository map](../development/repository.md).
The [merge plan](../merge/README.md) and its progress/task cards own pending
migration work, including accepted features not implemented yet.

## History, only when needed

[07 — Original reuse of heig-classroom](07-reutilisation-heig-classroom.md)
is frozen history, not an implementation plan. The [MVP plan](../PLAN-MVP.md)
also records historical decisions (D1–D20), not a current backlog. Follow the
history links from a current chapter or ADR when you need an old rationale,
compatibility detail or decision provenance. Do not load archives routinely.

Keep requirement IDs, question numbers and links stable. Put an implementation
fact in its owning code/schema, a product rule in its spec and a rationale in
its ADR; link across them instead of copying declarations or delivery diaries.
