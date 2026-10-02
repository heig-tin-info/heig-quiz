# Architecture decision records

Start here to find a decision without loading the whole archive. This is a
reading index, not another specification. Each record owns its rationale,
status and amendment history.

## Reading protocol

1. Read the relevant [specification chapter](../spec/05-architecture.md)
   and check [open questions](../spec/06-questions-ouvertes.md). Repository
   invariants are in `CLAUDE.md`; an unresolved conflict is not permission to
   change a product rule.
2. Pick a topic below. Read the record's **Status** before its **Decision**,
   then follow its named amendments. A later record overrides only the scope
   it explicitly changes; a higher number alone establishes no precedence.
3. For records with dated addenda, read the **Reading map** first when present. Historical
   alternatives and superseded paragraphs explain past choices, not current
   instructions. Cite the full file and section when handing work to another agent.
4. **Accepted is a decision state, not a deployment state.** Check the code,
   tests and [merge progress](../merge/PROGRESS.md) for implementation. Imported
   records describe heig-classroom until their Quiz status/addendum adapts them;
   its `GR-`, `GH-`, `AU-` and `NFR-` IDs are not Quiz requirement IDs.

Two historical records share **ADR-040**. Always cite their full filename
or linked title (favourites versus frequency-domain circuit stimuli). Their
paths are retained for existing links; do not assign 040 to another record.

## Topics

Each record appears once below. Cross-topic dependencies live in the records,
so this index does not duplicate their status or maintain a second dependency graph.

### Platform and operations

- [ADR-001 — Modular monolith, single process, optional `WORKER_MODE` split](ADR-001-monolithe-modulaire.md)
- [ADR-002 — Node.js + TypeScript + Fastify backend](ADR-002-stack-backend-fastify.md)
- [ADR-003 — PostgreSQL as the only stateful component, access through an isolated Drizzle ORM](ADR-003-postgresql-drizzle.md)
- [ADR-004 — pg-boss job queue on Postgres](ADR-004-jobs-pg-boss.md)
- [ADR-005 — SSE rather than WebSocket, without `Last-Event-ID` replay](ADR-005-sse-sans-websocket.md)
- [ADR-006 — Deadlines through a single ticker-sweeper, no scheduled one-shot job](ADR-006-deadline-ticker.md)
- [ADR-008 — React + Vite SPA front end, accessible headless components, no SSR](ADR-008-frontend-spa-react.md)
- [ADR-009 — Deployment on a single VM, Docker Compose, Caddy, SWITCH backups](ADR-009-deploiement-vm-compose.md)
- [ADR-010 — Secrets outside the repository and outside the database, in an encrypted institutional vault](ADR-010-stockage-secrets.md)
- [ADR-011 — Reconciliation reuses the idempotent webhook handlers](ADR-011-reconciliation-par-les-handlers.md)
- [ADR-016 — The code runner on the codespace VM, behind Caddy, with a shared token](ADR-016-runner-sur-vm-separee.md)
- [ADR-028 — A staging environment on the production VM, and promotion by sha](ADR-028-recette-sur-la-meme-vm.md)
- [ADR-030 — Notification channels: the bell, e-mail and Microsoft Teams](ADR-030-canaux-de-notification.md)
- [ADR-055 — The system status: one registry of health checks, a narrow `/healthz`, a backup report](ADR-055-etat-du-systeme.md)

### Identity, access and exam confinement

- [ADR-013 — Pool sharing: three roles, one resolution order, succession by seniority](ADR-013-partage-des-pools.md)
- [ADR-018 — The real student view, and the teacher's own test attempt](ADR-018-vue-etudiant-reelle.md)
- [ADR-022 — Personal API tokens, and an MCP server that is one more client of the API](ADR-022-jetons-api-et-serveur-mcp.md)
- [ADR-023 — The portal is its own OAuth 2.1 server, so claude.ai and ChatGPT can sign in](ADR-023-serveur-oauth-pour-mcp.md)
- [ADR-027 — Launch tickets and typed sessions (Safe Exam Browser first)](ADR-027-tickets-de-lancement-et-sessions-typees.md)
- [ADR-034 — Acting as a student: a one-time link, an `impersonation` session, read-only in production](ADR-034-agir-en-tant-qu-etudiant.md)
- [ADR-051 — Attested kiosk stations, paired from the student's phone, beside Safe Exam Browser](ADR-051-postes-kiosque-attestes.md)
- [ADR-053 — Removing the entry codes: the classroom join code and the evaluation access code](ADR-053-retrait-des-codes-d-entree.md)
- [ADR-054 — Super Powers: an admin reaches everyone's content for one hour, on request](ADR-054-super-powers-admin.md)
- [ADR-061 — Login adoption of the accounts imported from heig-classroom](ADR-061-adoption-des-comptes-importes.md)

### Question authoring and types

- [ADR-015 — The browser executes, the server grades: a `runtime` per code question, a command line per case](ADR-015-execution-navigateur-correction-serveur.md)
- [ADR-017 — Moving a question to another pool](ADR-017-deplacement-de-question.md)
- [ADR-019 — Grading a schematic by simulation, not by topology](ADR-019-simulation-de-circuit.md)
- [ADR-021 — Code image: a variant of `code`, a target in the config, stdout graded whatever the exit](ADR-021-codeimage-variante-de-code.md)
- [ADR-024 — One locked editor, three student tools, a visible cooldown](ADR-024-editeur-verrouille-et-outils-etudiant.md)
- [ADR-036 — Categorize: a new question type, sorting cards into columns](ADR-036-type-classement.md)
- [ADR-040 — Favourite stars on questions: a second per-user preference table](ADR-040-favoris-de-question.md)
- [ADR-040 — Frequency-domain stimuli for circuit](ADR-040-stimulus-frequentiel-de-circuit.md)
- [ADR-046 — Diagram: one editor engine, one question type, eight notations](ADR-046-type-diagramme.md)
- [ADR-056 — Parameterized questions: variables drawn per attempt](ADR-056-questions-parametrees.md)

### Evaluations, grading and practice

- [ADR-012 — Grade freezing: receipt time written synchronously, two-step freeze](ADR-012-gel-note-deux-temps.md)
- [ADR-014 — Live polls: an evaluation of one question, a code, and participants without a roster](ADR-014-sondages-en-direct.md)
- [ADR-020 — Presence is a body in the room, and the Results switch colours it now](ADR-020-presence-et-verdicts-en-direct.md)
- [ADR-025 — Several attempts on an exercise](ADR-025-plusieurs-tentatives-exercice.md)
- [ADR-026 — Negative marking, per evaluation, with the total floored at 0](ADR-026-points-negatifs-par-evaluation.md)
- [ADR-031 — Evaluation templates at course level](ADR-031-modeles-d-evaluation.md)
- [ADR-032 — Per-user display state lives in `user_course_prefs`](ADR-032-preferences-de-cours-par-utilisateur.md)
- [ADR-033 — The correction projection reads the validated gradings, per attempt](ADR-033-projection-de-la-correction.md)
- [ADR-037 — Teacher-only material in a solution](ADR-037-materiel-reserve-a-l-enseignant.md)
- [ADR-041 — The drill: spaced practice, scheduled by FSRS, rated by correctness and time](ADR-041-entrainement-espace.md)
- [ADR-044 — The grading table: one question at a time, anonymous by default](ADR-044-grille-de-correction.md)
- [ADR-050 — Publishing the correction of an exercise that is still running](ADR-050-publier-la-correction-d-un-exercice.md)
- [ADR-052 — Bonus questions replace the threshold grade scale](ADR-052-questions-bonus.md)

### Question analytics

- [ADR-038 — Question statistics in the pool: success rate, and a reset](ADR-038-statistiques-de-question.md)
- [ADR-039 — Time spent per question: a dwell measured by the server](ADR-039-temps-passe-par-question.md)
- [ADR-042 — The discrimination index of a question](ADR-042-indice-de-discrimination.md)
- [ADR-043 — The distractors of a multiple-choice question](ADR-043-analyse-des-distracteurs.md)

### LLM services

- [ADR-045 — The LLM grading service, and its development stub](ADR-045-service-llm-de-correction.md)
- [ADR-058 — The LLM gateway: one institutional key, a daily cap, a call log](ADR-058-passerelle-llm.md)
- [ADR-059 — "Generate": the wand of the question editor](ADR-059-generer-la-reponse.md)
- [ADR-060 — The LLM review of the published questions](ADR-060-revue-llm-des-questions.md)
- [ADR-063 — LLM grading of essays and diagrams](ADR-063-correction-llm.md)

### Classroom merge, projects and journal

- [ADR-007 — Ephemeral self-hosted runners for grading, sized by the freeze](ADR-007-runner-self-hosted.md)
- [ADR-029 — A UI library shared by Quiz and Classroom (superseded)](ADR-029-bibliotheque-ui-commune.md)
- [ADR-035 — Merging heig-classroom into Quiz: one platform, one roster, activities of several kinds](ADR-035-fusion-de-classroom.md)
- [ADR-047 — Online workspace: no student credential, therefore no write access](ADR-047-espace-de-travail-en-ligne.md)
- [ADR-048 — Group assignments: groups per assignment, formed by the staff, delivered in three lots](ADR-048-projets-de-groupe.md)
- [ADR-049 — The classroom journal: GitHub holds the content, Postgres holds a read model](ADR-049-journal-source-github.md)
- [ADR-057 — The journal in two modes: in Quiz, or in a GitHub repository](ADR-057-journal-two-modes.md)
- [ADR-062 — Building a project's distribution repository, and never deleting on GitHub](ADR-062-depot-de-distribution.md)
- [ADR-064 — A project's deadline: claims, leases and per-repository markers](ADR-064-echeance-des-projets-baux.md)

## Maintaining a record

Use the [template](TEMPLATE.md) for new decisions. Keep one decision per record;
put requirements in the spec, operational commands in the runbook and delivery
progress in the merge task cards. Link to those sources instead of copying them.

Keep existing IDs, paths and heading anchors stable. Select an unused ID after
checking both the repository and concurrent branches/PRs. For a changed decision,
name the affected section in the new record and add a reciprocal link in the old
record's Status. Use **superseded** only for a whole decision that no longer
applies; otherwise say **amended**, with its scope. Keep the old rationale, and
mark obsolete instructions where they occur if a reader could retrieve them alone.
Do not append another implementation diary to an already long record.

Add a link under one topic here. The site's Decisions entry points to this index;
there is no separate per-ADR navigation list to update. Build the documentation
and check links before opening the PR. The [2026-10-02 audit](AUDIT-2026-10-02.md)
records the reasons for this organization and the remaining documentation debt.
