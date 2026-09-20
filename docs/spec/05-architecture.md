# 5. Architecture

Objectif : une seule VM, une seule base, un dépôt, exploitable par une personne. Chaque choix privilégie la simplicité sur la généralité.

**Point de départ : le dépôt `~/heig-classroom`**, même auteur, même pile, en production. Ses ADR 001 à 010 s'appliquent ici. Ce qui est repris, adapté ou écarté est détaillé dans [07-reutilisation-heig-classroom.md](07-reutilisation-heig-classroom.md).

## 5.1 Pile technique

| Couche | Choix | Raison |
|---|---|---|
| Langage | TypeScript strict partout, pnpm workspaces | Un seul langage, schémas partagés client / serveur |
| Frontend | React 19, Vite, TanStack Query, Tailwind 4 avec les jetons et primitives de heig-classroom | SPA, design system déjà écrit et éprouvé |
| Éditeur markdown | Tiptap avec extension markdown, KaTeX, collage d'images, bascule source | WYSIWYG pour le profane, markdown pour l'expert, une seule source de vérité : le markdown |
| Éditeur de code | Monaco, chargé à la demande | Raccourcis VS Code attendus |
| Backend | Node 22, Fastify 5, zod 4, schémas partagés avec le client via `packages/contracts` | Léger, rapide, typé |
| Base | PostgreSQL 17, Drizzle ORM, migrations SQL versionnées, PGlite pour les tests | JSONB pour les configurations et réponses, transactions, LISTEN / NOTIFY |
| Tâches de fond | pg-boss | Files durables en Postgres, retries, singletons, pas de Redis |
| Temps réel | SSE serveur vers client, REST client vers serveur, voir 5.4 | |
| Auth | openid-client contre edu-ID, sessions opaques hachées, Keycloak en dev, repris de heig-classroom | Déjà en production avec edu-ID |
| Runner | Service Node séparé, Podman rootful en `--remote`, un conteneur par exécution, durcissement repris de `apps/codespace`, gVisor si disponible | Options de sécurité déjà éprouvées |
| Fichiers | Disque local de la VM sous un volume, servis par le proxy | Pas de S3 pour une VM unique, sauvegardé avec la base |
| Proxy | Caddy, HTTP/2 obligatoire | TLS automatique, multiplexage nécessaire au SSE, voir 5.4 |
| Déploiement | Docker Compose, GitHub Actions construit les images, script de mise à jour sur la VM | |
| i18n | Dictionnaire plat par locale repris de heig-classroom, `fr` et `en` | |
| Tests | Vitest, Testing Library, Playwright | |

## 5.2 Modularité du code

### Principe

Monolithe modulaire, ADR-001 de heig-classroom : un seul processus API, un seul déploiement, mais un découpage strict en modules qui ne se connaissent que par leurs services exportés. Les types de questions sont des packages hors du noyau, avec un contrat unique.

### Dépôt

```
quiz/
  apps/
    api/                 Fastify : modules métier, SSE, jobs, ticker
    web/                 SPA React
    runner/              exécution de code en conteneurs
  packages/
    core/                contrat QuestionType, registre des types, utilitaires purs
    contracts/           schémas zod des routes HTTP et des événements SSE, partagés api / web
    domain/              règles métier pures : barème, politiques MCQ, cloze, roster, FSRS
    canonical/           format YAML, import / export, convertisseurs GIFT et Moodle XML
    ui/                  design system : jetons, primitives, composants quiz
    qt-mcq/ qt-short/ qt-cloze/ qt-code/ qt-rich/ ...   un package par type
    cli/                 `quiz` en ligne de commande : pull / push d'un pool, phase 2
  docs/
  deploy/
```

### Modules de l'API

Chaque module vit dans `apps/api/src/modules/<nom>/` avec au plus quatre fichiers : `routes.ts` les handlers HTTP, `service.ts` la logique et les accès base, `events.ts` les événements qu'il publie, `jobs.ts` ses handlers pg-boss. Un module n'importe jamais les `routes.ts` d'un autre. Il appelle les `service.ts` des autres.

| Module | Responsabilité | Dépend de |
|---|---|---|
| `auth` | OIDC, sessions, claims, identité multi-adresses, rôles globaux | |
| `org` | Cours, classrooms, staff, rosters, aménagements | `auth` |
| `pool` | Pools, catégories, tags, questions, versions, brouillons, assets, recherche | `auth`, `core` |
| `evaluation` | Configuration d'une évaluation, items, cycle de vie, paramètres | `org`, `pool` |
| `live` | Tentatives, réponses, autosave, présence, horloge, pilotage en direct, ticker de deadline | `evaluation` |
| `grading` | Corrections auto, runner, LLM, panneau de validation, re-correction, publication | `live`, `runner`, `llm` |
| `results` | Notes, barème, exports CSV, vues statistiques d'une évaluation, feedback étudiant | `grading` |
| `stats` | Item analysis par version, agrégats pour le pool, phase 2 | `results` |
| `llm` | Fournisseurs, clés, gabarits de prompts, journal des appels, génération | `auth` |
| `runner` | Client HTTP du service runner, file et priorités | |
| `drill` | Cartes, FSRS, sessions, phase 2 | `pool`, `results` |
| `canonical` | Import / export, API et CLI | `pool` |
| `admin` | Utilisateurs, santé, paramètres, audit | tous, lecture seule |
| `realtime` | Bus d'événements, flux SSE, présence, topics | |

Règles :

1. Le schéma Drizzle est découpé par module dans `apps/api/src/db/<module>.ts` et réexporté par `db/schema.ts`. Une table appartient à un module. Un autre module la lit par jointure si nécessaire, mais ne l'écrit jamais.
2. Toute entrée HTTP est validée par un schéma de `packages/contracts`. Le client utilise le même schéma pour typer ses appels. Un changement de route casse la compilation des deux côtés.
3. Les règles pures, barème, politiques de notation, parsing cloze, FSRS, vivent dans `packages/domain`, sans accès base, testées unitairement à 100 %.
4. Un module publie ses événements via `realtime`, jamais directement.

### Packages de types de questions

Un package `qt-<type>` expose deux points d'entrée pour que l'API ne charge jamais React :

```
qt-mcq/
  package.json      "exports": { "./server": ..., "./client": ... }
  src/schema.ts     configSchema, answerSchema, configVersion, migrate()
  src/grade.ts      grade(), defaultPoints(), toStudent(), randomize()
  src/server.ts     export const mcqServer: QuestionTypeServer
  src/Editor.tsx  src/Player.tsx  src/Review.tsx  src/Stats.tsx
  src/client.tsx    export const mcqClient: QuestionTypeClient
  src/canonical.ts  toCanonical(), fromCanonical()
  src/*.test.ts
```

`packages/core` définit les deux interfaces et deux registres, `serverRegistry` et `clientRegistry`, alimentés par des imports statiques. Ajouter un type revient à créer le package et à l'inscrire dans les deux registres. Le registre client charge les composants à la demande par `React.lazy`, pour que le player de code ne pèse pas sur un quiz de choix multiples.

**Évolution du schéma d'un type sans migration SQL.** Chaque configuration JSONB porte `configVersion`. Le package expose `migrate(config, fromVersion)` qui monte une configuration ancienne à la version courante. L'API applique `migrate` à la lecture, le brouillon est réécrit à la version courante à la prochaine sauvegarde, les versions publiées restent stockées telles quelles et migrées à la volée. Aucune table ne bouge quand un type évolue.

### Interfaces d'extension pour l'expert

- **API REST publique** sous `/api/v1`, authentifiée par jeton personnel créé dans les réglages, portée limitée aux pools du prof : lister, lire, créer un brouillon, publier, exporter, importer. Documentée par OpenAPI généré depuis les schémas zod.
- **CLI** `quiz` dans `packages/cli` : `quiz pull <pool> ./dir` écrit le pool en YAML, `quiz push ./dir` crée des brouillons ou publie avec `--publish`, `quiz diff` compare le dossier et le serveur. Permet de versionner ses questions dans git et de les éditer dans son éditeur.
- **Serveur MCP** en phase 3, exposant les mêmes opérations que l'API à un client LLM.

## 5.3 Base de données

### Principes

- UUID v7 générés par l'application, triables, générables côté client.
- Les données propres à un type de question sont en JSONB, validées par le schéma zod du type avant chaque écriture. Le noyau ne connaît que `type`, `config`, `payload`, `details`.
- Une table par concept du domaine, pas par type de question. Ajouter un type n'ajoute pas de table.
- Les contenus publiés sont immuables : `question_versions` et `evaluation_items` ne sont jamais mis à jour après publication, sauf les colonnes de statut.
- Les notes ne sont pas stockées comme source de vérité, elles sont recalculées depuis `gradings` et figées à la publication dans `released_grades`.
- Suppression en cascade depuis `classrooms`. Suppression logique des questions par `deleted_at`.

### Tables

Colonnes communes omises : `id uuid pk`, `created_at`, `updated_at`.

**Identité et organisation**, repris de heig-classroom

| Table | Colonnes clés | Notes |
|---|---|---|
| `users` | `role` enum student / teacher / admin, `display_name`, `locale`, `theme`, `date_format` | Rôle global |
| `user_emails` | `user_id`, `email` unique, `source` login / idp / roster | Identité = ensemble d'adresses |
| `user_idp_claims` | `user_id`, `claims` jsonb, `seen_at` | Jamais exposé |
| `sessions` | `sid_hash` pk, `user_id`, `expires_at` | |
| `api_tokens` | `user_id`, `token_hash`, `label`, `scopes` text[], `last_used_at`, `expires_at` | Expert, API et CLI |
| `courses` | `name`, `code` | |
| `course_staff` | `course_id`, `user_id` | pk composite |
| `course_pools` | `course_id`, `pool_id` | pk composite |
| `classrooms` | `course_id`, `name`, `period`, `join_code` unique nullable, `archived_at` | |
| `enrollments` | `classroom_id`, `user_id`, `time_bonus_percent` int default 0, `note` | unique (classroom, user) |
| `audit_log` | `actor_id`, `action`, `target_type`, `target_id`, `details` jsonb | Catalogue fermé d'actions |

**Pool**

| Table | Colonnes clés | Notes |
|---|---|---|
| `pools` | `name`, `visibility` private / shared / public, `owner_id` | |
| `pool_members` | `pool_id`, `user_id`, `role` reader / contributor / owner | Phase 2 |
| `categories` | `pool_id`, `parent_id` nullable, `name`, `position` | Arbre par parent |
| `questions` | `pool_id`, `category_id` nullable, `type` text, `internal_name`, `difficulty` smallint 1 à 5, `shuffleable` bool, `randomizable` bool, `origin_question_id` nullable, `deleted_at` | Métadonnées stables |
| `question_tags` | `question_id`, `tag` text | pk composite, index sur `tag`. Pas de table `tags` : les tags sont des chaînes normalisées, la liste distincte vient d'une requête |
| `question_versions` | `question_id`, `number` int nullable, `config` jsonb, `config_version` int, `explanation` text, `search` tsvector généré, `published_at`, `published_by`, `change_note`, `deprecated_at`, `deprecation_note` | unique (question_id, number). `number` null = brouillon, un seul par question grâce à un index unique partiel `WHERE number IS NULL` |
| `assets` | `owner_id`, `pool_id`, `sha256`, `mime`, `bytes`, `width`, `height`, `path` | Dédoublonné par hash. Référencé dans le markdown par `asset:<id>` |
| `question_version_assets` | `version_id`, `asset_id` | Pour l'export et le nettoyage |

**Évaluation**

| Table | Colonnes clés | Notes |
|---|---|---|
| `evaluations` | `classroom_id`, `title`, `mode` exam / exercise / poll, `state`, `settings` jsonb, `grading_scale` jsonb, `feedback_policy` jsonb, `opens_at`, `closes_at`, `duration_s`, `access_code`, `ip_allowlist` text[], `released_at`, `released_grades` jsonb, `modified_after_release` bool | `settings` validé par un schéma de `contracts` : navigation, présentation, mélange, salle d'attente |
| `evaluation_items` | `evaluation_id`, `position`, `question_version_id`, `points` numeric, `milestone` bool | unique (evaluation, position). Copie de `question_version_id` figée |
| `attempts` | `evaluation_id`, `user_id`, `state`, `seed` int, `started_at`, `deadline_at`, `bonus_s` int, `submitted_at`, `closed_at`, `closed_by` server / student / teacher, `last_position` int | unique (evaluation, user). Index partiel `(deadline_at) WHERE state = 'in_progress'` pour le ticker |
| `answers` | `attempt_id`, `item_id`, `payload` jsonb, `revision` int, `marked_done` bool, `first_seen_at`, `updated_at` | unique (attempt, item). Le payload est validé par le `answerSchema` du type |
| `attempt_events` | `attempt_id`, `kind` visibility / focus / ip_change / reconnect / time_added / paused, `at`, `details` jsonb | Journal léger anti-triche et support |
| `guest_participants` | `evaluation_id`, `pseudonym`, `token_hash` | Mode `poll` sans compte, phase 2. Un guest a une ligne `attempts` avec `user_id` null et `guest_id` |

**Correction et résultats**

| Table | Colonnes clés | Notes |
|---|---|---|
| `gradings` | `answer_id`, `points` numeric, `max_points` numeric, `source` auto / llm / manual, `state` proposed / validated / superseded, `details` jsonb, `confidence` low / medium / high nullable, `comment` text, `graded_by` nullable, `graded_at`, `supersedes_id` nullable, `regrade_note` text | Index unique partiel `(answer_id) WHERE state = 'validated'`. `details` : verdict par cas de test, points par critère, correspondance de matcher |
| `answer_flags` | `answer_id`, `user_id`, `reason`, `resolved_at` | Signalement étudiant, phase 2 |
| `llm_calls` | `user_id`, `purpose` grade / generate / explain / variant, `provider`, `model`, `input_tokens`, `output_tokens`, `cost_estimate`, `duration_ms`, `ok`, `error` | Jamais le contenu des prompts |

**Drill**, phase 2

| Table | Colonnes clés | Notes |
|---|---|---|
| `drill_cards` | `user_id`, `question_id`, `stability`, `difficulty`, `due_at`, `reps`, `lapses`, `last_review_at`, `enabled` | unique (user, question) |
| `drill_reviews` | `card_id`, `rating` 1 à 4, `elapsed_ms`, `reviewed_at`, `answer_payload` jsonb | Historique pour recalcul des paramètres |

**Infrastructure** : le schéma `pgboss` géré par pg-boss, une table `settings` clé / valeur jsonb pour les paramètres globaux, `providers` pour les fournisseurs LLM avec clé chiffrée.

### Requêtes critiques et index

| Besoin | Requête | Index |
|---|---|---|
| Autosave | `UPDATE answers SET payload, revision WHERE attempt_id = ? AND item_id = ? AND revision < ?` | pk composite unique |
| Ticker de deadline | `UPDATE attempts SET state = 'expired' WHERE state = 'in_progress' AND deadline_at + interval '3 s' <= now() RETURNING id` | partiel sur `deadline_at` |
| Grille du tableau de bord | jointure `attempts` × `evaluation_items` gauche `answers` gauche `gradings` validées, une évaluation | `answers(attempt_id)`, `gradings(answer_id) WHERE validated` |
| Recherche dans le pool | `tsvector` sur `internal_name`, énoncé extrait du config par le type, tags | GIN sur `search`, index sur `question_tags(tag)` |
| Dernière version publiée | `SELECT ... WHERE question_id = ? AND number IS NOT NULL ORDER BY number DESC LIMIT 1` | `(question_id, number desc)` |
| Statistiques d'item | agrégat sur `gradings` validées joint `evaluation_items` par `question_version_id` | `evaluation_items(question_version_id)` |

### Transactions

- Publication d'une version : dans une transaction, vérifier le brouillon, calculer `number = max + 1`, insérer, réinitialiser le brouillon. L'index unique protège contre la double publication.
- Démarrage d'une tentative : `INSERT ... ON CONFLICT DO NOTHING` puis lecture, ce qui rend le double clic idempotent. `deadline_at` est calculée à l'insertion à partir de `duration_s`, du bonus et du mode.
- Publication des résultats : une transaction calcule toutes les notes, écrit `released_grades` et `released_at`, journalise.

## 5.4 Temps réel

### Ce que le système doit transporter

| Flux | Sens | Fréquence | Exigence |
|---|---|---|---|
| Autosave des réponses | client → serveur | jusqu'à 3 par seconde par étudiant, 30 étudiants | Acquittement durable, ordre, idempotence |
| État de l'évaluation : démarrage, pause, temps ajouté, clôture | serveur → tous | rare | Moins d'une seconde, jamais perdu |
| Horloge | serveur → client | toutes les 10 s | Décalage estimé, pas de dérive |
| Grille du tableau de bord | serveur → prof | jusqu'à 100 mises à jour par seconde en pic | Coalescence acceptable, cohérence finale |
| Présence : connecté, déconnecté | serveur → prof et salle d'attente | rare | Détection en moins de 30 s |
| Résultats du runner, corrections, notifications | serveur → un client | rare | |
| Sondage en direct | serveur → prof et projection | modérée | Moins d'une seconde |

### Options

**A. SSE plus REST.** Flux unidirectionnel HTTP, `EventSource` natif avec reconnexion automatique, écritures en REST. Le modèle de heig-classroom.

- Pour : aucune bibliothèque, cookies et CSRF réutilisés tels quels, testable avec `curl`, reconnexion sans code, chaque écriture est une requête HTTP avec réponse, retry et idempotence naturels, exactement ce qu'il faut pour le chemin critique de l'autosave. Le proxy n'a rien à savoir de plus qu'un `flush_interval -1`.
- Contre : sur HTTP/1.1 le navigateur limite à six connexions par domaine, un onglet SSE par page en consomme une. Sur HTTP/2 la limite disparaît. Le serveur ne reçoit rien par le flux, les écritures passent par des requêtes séparées, ce qui coûte un en-tête HTTP par autosave, négligeable en HTTP/2.

**B. WebSocket.** Un canal bidirectionnel par client.

- Pour : latence minimale, un seul canal, présence immédiate à la fermeture du socket, transport naturel pour une future co-édition.
- Contre : une bibliothèque serveur et un protocole maison de messages, d'acquittements, de reprise après coupure, de rejeu des écritures non acquittées. Tout ce que HTTP fait déjà pour les écritures doit être réinventé. Authentification à l'upgrade, tests plus lourds, débogage moins direct. À 100 clients, aucun gain mesurable.

**C. Hybride, SSE aujourd'hui, WebSocket sur une route dédiée si un besoin bidirectionnel à haute fréquence apparaît.** Rien dans le périmètre ne le demande : ni co-édition, ni curseur partagé, ni audio.

### Décision : SSE plus REST, avec trois compléments

L'option A est retenue. Le chemin critique d'un examen est l'écriture des réponses. Sur ce chemin, HTTP offre gratuitement ce que WebSocket obligerait à réécrire : une réponse par requête, une reprise par simple renvoi, un code d'erreur explicite quand le temps est écoulé. Les flux serveur vers client sont peu fréquents ou tolèrent la coalescence. HTTP/2 est imposé par Caddy en TLS, ce qui lève la limite de connexions. Les compléments par rapport à heig-classroom :

1. **Événements porteurs de données pour le domaine `live`.** heig-classroom n'envoie que des indices de rafraîchissement. Pour le tableau de bord, un refetch de la grille à chaque frappe de 30 étudiants serait absurde. Les événements du domaine `live` portent un payload typé dans `contracts`, appliqué directement à l'état client. Les autres domaines gardent les indices et le refetch.
2. **Coalescence côté serveur.** Les mises à jour de cellule sont regroupées par `(attempt, item)` sur 250 ms avant émission, une seule émission par cellule et par fenêtre. Le pire cas tombe à quelques événements par seconde par prof.
3. **Instantané à la connexion.** À l'ouverture du flux, le serveur envoie `snapshot` avec l'état complet de ce que le client regarde : l'évaluation et la tentative pour un étudiant, la grille pour un prof. Pas de `Last-Event-ID`, pas de tampon de rejeu, pas d'état de reprise. Un événement perdu est réparé par la prochaine reconnexion ou par un refetch de sécurité toutes les 60 s.

### Grammaire des événements

Un flux par onglet, `GET /events?watch=evaluation:<id>` ou `watch=attempt:<id>`. Le serveur vérifie l'autorisation sur le sujet demandé et abonne le client aux sujets implicites : `user:<id>`, et `teacher:<id>` pour un prof.

| Événement | Sujet | Payload | Récepteur |
|---|---|---|---|
| `snapshot` | tout | état complet du sujet observé, `serverNow` | tous, à la connexion |
| `clock` | tout | `serverNow` | tous, toutes les 10 s, sert aussi de battement |
| `evaluation.state` | `evaluation:<id>` | `state`, `pausedAt`, `closesAt` | étudiants et prof |
| `attempt.deadline` | `attempt:<id>` | `deadlineAt`, `bonusS`, `reason` | un étudiant, quand le prof ajoute du temps |
| `attempt.closed` | `attempt:<id>` | `closedBy` | un étudiant |
| `dashboard.cell` | `evaluation:<id>` | `attemptId`, `itemId`, `status`, `revision`, `points` nullable | prof, coalescé |
| `dashboard.presence` | `evaluation:<id>` | `userId`, `online`, `lastSeenAt` | prof et salle d'attente |
| `lobby.count` | `evaluation:<id>` | `present`, `enrolled` | salle d'attente |
| `poll.tally` | `evaluation:<id>` | répartition agrégée | prof et projection, coalescé 500 ms |
| `runner.result` | `user:<id>` | `requestId`, résultat | un étudiant |
| `grading.progress` | `teacher:<id>` | `evaluationId`, `done`, `total` | prof |
| `hint` | divers | `type`, `topics` | refetch TanStack Query, comme heig-classroom |

### Horloge

Chaque `clock` et chaque réponse HTTP d'autosave portent `serverNow`. Le client garde la médiane des cinq derniers décalages `serverNow − clientNow`, corrigés de la moitié du temps aller-retour mesuré sur les requêtes. Le compte à rebours affiche `deadlineAt − (Date.now() + offset)`. Le serveur seul ferme la tentative : le ticker s'exécute toutes les secondes et expire les tentatives dépassées de plus de 3 secondes. Une écriture arrivée après `deadline + 3 s` est refusée avec `410 attempt_closed`, le client affiche que le temps est écoulé et cesse d'envoyer.

### Autosave

`PUT /attempts/:id/answers/:itemId` avec `{ payload, revision, clientTs }`. Le client incrémente `revision` localement à chaque modification, regroupe sur 300 ms, et n'a jamais plus d'une requête en vol par item : la suivante attend, avec le dernier payload. Le serveur écrit si `revision` dépasse la révision en base, sinon renvoie la révision courante et le payload en base, ce que le client adopte. Réponse : `{ revision, serverNow }`. En cas d'échec réseau, réessai avec repli exponentiel plafonné à 5 s, indicateur "hors ligne" après 3 s sans acquittement.

### Présence

Le module `realtime` tient en mémoire `sujet → connexions`. L'ouverture et la fermeture d'un flux SSE émettent `dashboard.presence`. Une connexion sans réception du `clock` pendant 30 s côté client provoque une reconnexion. Le serveur ferme les flux inactifs après 60 s sans écriture possible. Si l'API devait un jour tourner en plusieurs processus, le bus passerait par `LISTEN / NOTIFY`, ADR-005.

## 5.5 Runner

Service HTTP interne, non exposé, appelé par l'API.

```
POST /run
{ language, files: [{ name, content }], compileArgs, cases: [{ stdin, timeMs }], limits, action }
→ { compile: { ok, stdout, stderr, ms }, cases: [{ exitCode, stdout, stderr, ms, timedOut, oom }] }
```

- Une image par langage, construite depuis `apps/runner/images/`, dérivée de `c-dev` du codespace sans code-server. Reconstruite chaque semaine.
- Chaque requête crée un conteneur avec les options de `run-hardened.sh` du codespace : `--network none`, `--read-only`, `--tmpfs /work:size=32m`, `--memory`, `--cpus 1`, `--pids-limit 64`, `--userns=auto`, `--cap-drop ALL`, `--security-opt no-new-privileges`, profil seccomp `codespace.json`, et `--runtime runsc` si gVisor est installé. Le temps mur est imposé par le service, qui tue le conteneur au dépassement.
- Compilation puis exécution des cas dans le même conteneur, séquentiellement, chacun avec sa limite.
- Deux files : `interactive` pour les runs d'étudiants pendant une évaluation, `grading` pour la correction finale, priorité inférieure. Concurrence configurable, 4 par défaut. Au-delà d'une profondeur limite, 429 et le client réessaie.
- Le code source est reconstruit côté API à partir du template et des régions éditables, jamais pris tel quel.
- Une image de référence par question `codeimage` est produite en exécutant la solution du prof dans le runner au moment de la publication.

Alternative évaluée : Piston, runner libre multi-langages, isolation par utilisateurs Unix et cgroups. Retenu comme secours si Podman pose problème sur la VM.

## 5.6 Correction

Après clôture, le module `grading` enfile un job `grading.evaluation` singleton par évaluation. Le job parcourt les tentatives et, pour chaque réponse, appelle `grade` du type. Résultat immédiat : correction `auto` validée. `pending: 'runner'` : job `grading.runner` par réponse, file de priorité basse. `pending: 'llm'` : job `grading.llm` par réponse, correction `llm` proposée. Les jobs sont idempotents : ils vérifient l'absence de correction validée non supersédée avant d'écrire. `grading.progress` informe le prof.

Le module `llm` construit le prompt à partir d'un gabarit par usage, exige une sortie JSON validée par zod, réessaie une fois en cas de JSON invalide, journalise dans `llm_calls` sans le contenu. Fournisseurs : SDK Anthropic et client compatible OpenAI derrière une interface commune. Modèle par défaut pour la correction : Claude Opus, pour la génération : Claude Sonnet, configurables.

## 5.7 Sécurité du contenu

Un seul point de sortie du contenu vers un étudiant : `toStudent` du type, appelé dans un service `studentView` du module `live` qui retire aussi le nom interne, les tags, la difficulté, l'explication, puis applique la politique de feedback. Tests : pour chaque type, une configuration complète passée par `toStudent` ne contient aucun champ interdit, testé par liste noire de clés et par recherche des valeurs de la clé de réponse dans la sortie sérialisée.

## 5.8 Export, import, sauvegarde

- Export d'un pool : archive zip générée à la volée, `pool.yaml`, dossiers de catégories, `<internal_name>.yaml`, `assets/`. La même fonction alimente l'API, la CLI et le bouton de l'interface.
- Import : validation de chaque fichier par le schéma du type, `migrate` si `configVersion` est ancien, rapport d'erreurs par fichier, transaction unique, création de brouillons par défaut, publication avec `--publish`.
- Sauvegarde : service `backup` de heig-classroom, `pg_dump` compressé plus le volume d'assets, envoyé chaque heure vers un stockage objet Hetzner par `rclone`, rétention 30 jours. Restauration documentée et testée sur une VM vierge.

## 5.9 Déploiement

`compose.prod.yml` repris de heig-classroom : `caddy`, `app`, `postgres`, `backup`, plus `runner` avec accès au socket Podman de l'hôte. Keycloak est retiré de la production. `deploy.sh` refuse une mise à jour si une évaluation est `running` ou `lobby`, sauf `--force`. Les migrations sont additives pour permettre un retour à l'image précédente.

## 5.10 Décisions d'architecture

| Sujet | Décision | Alternative écartée |
|---|---|---|
| Temps réel | SSE plus REST, événements porteurs de données pour `live`, coalescence, instantané à la connexion | WebSocket : réinvente les acquittements que HTTP donne, sans gain à 100 clients |
| Données des types de questions | JSONB validé par zod, `configVersion` et `migrate` dans le package | Une table par type : rigide, migrations SQL à chaque évolution d'un type |
| Identifiants | UUID v7 | ULID : même propriétés, moins standard en Postgres |
| Tâches de fond | pg-boss | BullMQ et Redis : un composant de plus |
| Sandbox | Podman durci du codespace, gVisor si possible | nsjail, isolate : à réévaluer si le démarrage de conteneur gêne |
| Frontend | SPA | Rendu serveur : inutile derrière une authentification |
| Éditeur markdown | Tiptap, markdown comme source de vérité, bascule WYSIWYG / source | Deux éditeurs séparés : deux sources de vérité |
| Drawing | Excalidraw embarqué | Canevas maison |
| Extension expert | API REST à jeton, CLI, MCP plus tard | Webhooks sortants : pas de consommateur identifié |
