# Architecture decision records

Start here to find a decision without loading the whole archive. This is a
reading index, not another specification. Each record owns its rationale,
status and amendment history.

## Reading protocol

1. Read the relevant [specification chapter](../spec/README.md)
   and check [open questions](../spec/06-questions-ouvertes.md). Repository
   invariants are in `CLAUDE.md`; an unresolved conflict is not permission to
   change a product rule.
2. Pick a topic below. Read the record's **Status** before its **Decision**,
   then follow its named amendments. A later record overrides only the scope
   it explicitly changes; a higher number alone establishes no precedence.
3. Consolidated records put the current rule first and link to historical
   snapshots only for rationale or old section references. Do not load `history/`
   by default. In other records, follow the Reading map when present. Cite the
   full file and section when handing work to another agent.
4. **Accepted is a decision state, not a deployment state.** Check the code,
   tests and [merge progress](../merge/PROGRESS.md) for implementation. Imported
   records describe heig-classroom until their Quiz status/addendum adapts them;
   its `GR-`, `GH-`, `AU-` and `NFR-` IDs are not Quiz requirement IDs.

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
- [ADR-008 — React + Vite SPA front end, own accessible primitives, no SSR](ADR-008-frontend-spa-react.md)
- [ADR-009 — Deployment on a single VM, Docker Compose, Caddy, SWITCH backups](ADR-009-deploiement-vm-compose.md)
- [ADR-010 — Secrets outside the repository and outside the database, in an encrypted institutional vault](ADR-010-stockage-secrets.md)
- [ADR-011 — Reconciliation reuses the idempotent webhook handlers](ADR-011-reconciliation-par-les-handlers.md)
- [ADR-016 — The code runner on the codespace VM, behind Caddy, with a shared token](ADR-016-runner-sur-vm-separee.md)
- [ADR-028 — A staging environment on the production VM, and promotion by sha](ADR-028-recette-sur-la-meme-vm.md)
- [ADR-030 — Notification channels: the bell, e-mail and Microsoft Teams](ADR-030-canaux-de-notification.md)
- [ADR-087 — What's new: one entry file per pull request, shown once after an update](ADR-087-nouveautes-de-la-plateforme.md)
- [ADR-055 — The system status: one registry of health checks, a narrow `/healthz`, a backup report](ADR-055-etat-du-systeme.md)
- [ADR-065 — Connection recovery without reloading student work](ADR-065-reconnection-overlay.md)

### Identity, access and exam confinement

- [ADR-013 — Pool sharing: three roles, one resolution order, succession by seniority](ADR-013-partage-des-pools.md)
- [ADR-018 — The real student view, and the teacher's own test attempt](ADR-018-vue-etudiant-reelle.md)
- [ADR-022 — Personal API tokens, and an MCP server that is one more client of the API](ADR-022-jetons-api-et-serveur-mcp.md)
- [ADR-023 — The portal is its own OAuth 2.1 server, so claude.ai and ChatGPT can sign in](ADR-023-serveur-oauth-pour-mcp.md)
- [ADR-027 — Launch tickets and typed sessions (Safe Exam Browser first)](ADR-027-tickets-de-lancement-et-sessions-typees.md)
- [ADR-034 — Acting as a student: a one-time link, an `impersonation` session, read-only in production](ADR-034-agir-en-tant-qu-etudiant.md)
- [ADR-051 — Attested kiosk stations, paired from the student's phone, beside Safe Exam Browser](ADR-051-postes-kiosque-attestes.md)
- [ADR-089 — Kiosk stations for the online workspace: the station stays on Quiz and frames the portal](ADR-089-kiosque-pour-l-espace-de-travail.md)
- [ADR-053 — Removing the entry codes: the classroom join code and the evaluation access code](ADR-053-retrait-des-codes-d-entree.md)
- [ADR-054 — Super Powers: an admin reaches everyone's content for one hour, on request](ADR-054-super-powers-admin.md)
- [ADR-068 — Course staff roles: owner and assistant](ADR-068-roles-de-l-equipe-du-cours.md)
- [ADR-061 — Login adoption of the accounts imported from heig-classroom](ADR-061-adoption-des-comptes-importes.md)

### Question authoring and types

- [ADR-015 — The browser executes, the server grades: a `runtime` per code question, a command line per case](ADR-015-execution-navigateur-correction-serveur.md)
- [ADR-017 — Moving a question to another pool](ADR-017-deplacement-de-question.md)
- [ADR-019 — Grading a schematic by simulation, not by topology](ADR-019-simulation-de-circuit.md)
- [ADR-075 — The workspace question: an advanced exam question worked in the online workspace, collected by the server](ADR-075-question-espace-de-travail.md)
- [ADR-021 — Code image: a variant of `code`, a target in the config, stdout graded whatever the exit](ADR-021-codeimage-variante-de-code.md)
- [ADR-024 — One locked editor, three student tools, a visible cooldown](ADR-024-editeur-verrouille-et-outils-etudiant.md)
- [ADR-036 — Categorize: a new question type, sorting cards into columns](ADR-036-type-classement.md)
- [ADR-040 — Favourite stars on questions: a second per-user preference table](ADR-040-favoris-de-question.md)
- [ADR-046 — Diagram: one editor engine, one question type, eight notations](ADR-046-type-diagramme.md)
- [ADR-056 — Parameterized questions: variables drawn per attempt](ADR-056-questions-parametrees.md)
- [ADR-081 — Concepts replace tags: one instance-wide, bilingual vocabulary, curated by the admin](ADR-081-vocabulaire-de-notions.md)
- [ADR-083 — Frequency-domain stimuli for circuit](ADR-083-stimulus-frequentiel-de-circuit.md)

### Evaluations, grading and practice

- [ADR-012 — Grade freezing: receipt time written synchronously, two-step freeze](ADR-012-gel-note-deux-temps.md)
- [ADR-014 — Live polls: an evaluation of one question, a code, and participants without a roster](ADR-014-sondages-en-direct.md)
- [ADR-071 — The brainstorm poll: short ideas, a bubble cloud, moderated by the teacher](ADR-071-sondage-brainstorm.md)
- [ADR-072 — AI assistance for a brainstorm: a model moderates, corrects and groups ideas live](ADR-072-ia-du-brainstorm.md)
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
- [ADR-066 — A wide question beside a pinned rail](ADR-066-question-large-et-rail-fixe.md)
- [ADR-067 — Grading an exercise at hand-in](ADR-067-correction-a-la-remise-des-exercices.md)
- [ADR-069 — A calculator provided on the student's screen](ADR-069-calculatrice-fournie.md)
- [ADR-076 — An attempt starts by an explicit Start, not by opening the link](ADR-076-demarrage-explicite-d-une-tentative.md)
- [ADR-079 — The conditions of an evaluation: announced by the teacher, imposed by the platform](ADR-079-conditions-de-l-evaluation.md)
- [ADR-084 — A text before an item: the intro of an evaluation item](ADR-084-texte-avant-un-item.md)
- [ADR-085 — Confidence in the drill: stated beside the review, never part of a score](ADR-085-confiance-dans-l-entrainement.md)
- [ADR-086 — Scheduled or Live: who drives the clock, a safety deadline, and a limit cut at the window's end](ADR-086-planifiee-ou-en-direct.md)
- [ADR-088 — The exam integrity journal: leaving the page and pasting from outside, recorded lightly, never proof](ADR-088-journal-d-integrite.md)

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
- [ADR-080 — The teacher assistant: ask the documentation and your own data from any screen](ADR-080-assistant-enseignant.md)
- [ADR-082 — The AI card of the question editor](ADR-082-carte-ia-de-l-editeur.md)

### Classroom merge, projects and journal

- [ADR-007 — Ephemeral self-hosted runners for grading, sized by the freeze](ADR-007-runner-self-hosted.md)
- [ADR-029 — A UI library shared by Quiz and Classroom (superseded)](ADR-029-bibliotheque-ui-commune.md)
- [ADR-035 — Merging heig-classroom into Quiz: one platform, one roster, activities of several kinds](ADR-035-fusion-de-classroom.md)
- [ADR-047 — Online workspace: no student credential, therefore no write access](ADR-047-espace-de-travail-en-ligne.md)
- [ADR-078 — The workspace's git relay: Quiz issues a token scoped to one repository, the App key stays on the app VM](ADR-078-codespace-git-relay-tokens.md)
- [ADR-048 — Group assignments: groups per assignment, formed by the staff, delivered in three lots](ADR-048-projets-de-groupe.md)
- [ADR-070 — Group sets: a classroom's reusable groups, which a project follows until its deadline](ADR-070-repartitions-de-groupes.md)
- [ADR-077 — A staff seat accepts a project: the teacher's test repository](ADR-077-depots-de-test-du-personnel.md)
- [ADR-049 — The classroom journal: GitHub holds the content, Postgres holds a read model](ADR-049-journal-source-github.md)
- [ADR-057 — The journal in two modes: in Quiz, or in a GitHub repository](ADR-057-journal-two-modes.md)
- [ADR-062 — Building a project's distribution repository, and never deleting on GitHub](ADR-062-depot-de-distribution.md)
- [ADR-064 — A project's deadline: claims, leases and per-repository markers](ADR-064-echeance-des-projets-baux.md)
- [ADR-073 — Syncing a project's source: a lease, one pull request per branch, the handed-out sha](ADR-073-synchronisation-de-la-source.md)
- [ADR-074 — Gradebook: stored marks beside derived absence](ADR-074-carnet-de-notes-marques-stockees.md)

## Maintaining a record

Use the [template](TEMPLATE.md) for new decisions. Keep one decision per record;
put requirements in the spec, operational commands in the runbook and delivery
progress in the merge task cards. Link to those sources instead of copying them.

Keep existing IDs, paths and heading anchors stable, except to resolve a
duplicate number, noted in the record's Status. Select an unused ID after
checking both the repository and concurrent branches/PRs; rebase before
merging, and renumber yours if that ID landed meanwhile. For a changed decision,
name the affected section in the new record and add a reciprocal link in the old
record's Status. Use **superseded** only for a whole decision that no longer
applies; otherwise say **amended**, with its scope. Keep the old rationale, and
mark obsolete instructions where they occur if a reader could retrieve them alone.
Do not append another implementation diary to an already long record.

Add a link under one topic here. The site's Decisions entry points to this index;
there is no separate per-ADR navigation list to update. Build the documentation
and check links before opening the PR. The [2026-10-02 audit](AUDIT-2026-10-02.md)
records the reasons for this organization and the remaining documentation debt.
